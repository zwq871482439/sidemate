# -*- coding: utf-8 -*-
"""
routers/download.py — 模型下载端点

端点：
  GET  /api/models/catalog          — 可下载目录（LLM 3 档 + KB 组合，含已装状态）
  POST /api/models/download         — 启动下载（返回 task_id）
  GET  /api/models/download/progress/{task_id} — SSE 下载进度
  POST /api/models/download/cancel  — 取消下载
"""
import os
import json
import logging
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from routers.deps import get_mgr, get_kb
from core import download_engine

router = APIRouter()
log = logging.getLogger("download")


def _models_dir() -> str:
    """模型目录（与 ollama_manager / registry 一致：server/models → 项目根 models）"""
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models")


# --------------------------------------------------------------------
# 目录：列出可下载的模型 + 安装状态
# --------------------------------------------------------------------

@router.get("/api/models/catalog")
def api_models_catalog():
    """可下载模型目录。

    返回 LLM 3 档（读 meta.json，含未下载的）+ KB 组合（检测 models/embedding + reranker 是否就绪）。
    """
    from core.llamacpp_backend.registry import ModelRegistry

    models_dir = _models_dir()
    registry = ModelRegistry(models_dir)

    # ---- LLM：list_all 含未下载的 meta.json ----
    llm_models = []
    try:
        for m in registry.list_all():
            d = m.to_dict()
            llm_models.append({
                "model_id": m.model_id,
                "display_name": m.display_name,
                "size_b": m.size_b,
                "quant": m.quant,
                "gguf_size_bytes": m.gguf_size_bytes,
                "installed": m.gguf_exists,
                "min_ram_gb": m.min_ram_gb,
                "recommended_vram_gb": m.recommended_vram_gb,
                "download": m.download_info,
            })
    except Exception as e:
        log.warning("[DL] 扫描 LLM 目录失败: %s", e)

    # ---- KB：检测 embedding + reranker 关键文件是否存在 ----
    def _kb_ready(subdir: str) -> bool:
        d = os.path.join(models_dir, subdir)
        has_weight = (os.path.exists(os.path.join(d, "model.safetensors"))
                      or os.path.exists(os.path.join(d, "pytorch_model.bin")))
        has_config = os.path.exists(os.path.join(d, "config.json"))
        return has_weight and has_config

    kb_installed = _kb_ready("embedding") and _kb_ready("reranker")

    return {
        "llm": llm_models,
        "kb": {
            "installed": kb_installed,
            "embedding_ready": _kb_ready("embedding"),
            "reranker_ready": _kb_ready("reranker"),
            "components": [
                {"name": "bge-m3", "role": "向量化（embedding）", "repo": "BAAI/bge-m3", "size_gb": 2.3},
                {"name": "bge-reranker-v2-m3", "role": "重排序（reranker）", "repo": "BAAI/bge-reranker-v2-m3", "size_gb": 2.2},
            ],
        },
    }


# --------------------------------------------------------------------
# 当前下载任务状态（页面刷新后恢复进度条）
# --------------------------------------------------------------------

@router.get("/api/models/download/status")
def api_download_status():
    """返回当前正在进行的下载任务（用于页面刷新后恢复进度条）"""
    task = download_engine.has_running_task()
    if task:
        return {
            "running": True,
            "task_id": task.task_id,
            "type": task.type,
            "label": task.label,
            "downloaded_bytes": task.downloaded_bytes,
            "total_bytes": task.total_bytes,
        }
    return {"running": False}

@router.post("/api/models/download")
async def api_models_download(request: Request):
    """启动模型下载。

    body: {type: "llm"|"kb", model_id?: str, source?: "modelscope"|"huggingface"}
    LLM 必须传 model_id；KB 不需要。
    """
    body = await request.json()
    task_type = body.get("type", "").strip()
    source = body.get("source", "modelscope")

    # 同时只允许一个下载任务
    running = download_engine.has_running_task()
    if running:
        return JSONResponse({
            "error": "已有下载任务进行中（%s），请等待完成或取消后再试" % running.label,
            "busy": True,
            "task_id": running.task_id,
        }, status_code=409)

    models_dir = _models_dir()

    if task_type == "llm":
        model_id = body.get("model_id", "").strip()
        if not model_id:
            return JSONResponse({"error": "LLM 下载需要 model_id"}, status_code=400)

        # 从 registry 取 meta（含 download 字段）
        from core.llamacpp_backend.registry import ModelRegistry
        registry = ModelRegistry(models_dir)
        meta = None
        for m in registry.list_all():
            if m.model_id == model_id:
                meta = m.to_dict()
                break
        if not meta:
            return JSONResponse({"error": "未找到模型 %s 的元数据" % model_id}, status_code=404)
        if not meta.get("download", {}).get("repo_id"):
            return JSONResponse({"error": "模型 %s 缺少下载源信息" % model_id}, status_code=400)

        label = meta.get("display_name", model_id)
        task = download_engine.create_task("llm", label)
        download_engine.run_llm_download(task, meta, models_dir, source, on_complete=_finalize_install)
        log.info("[DL] LLM 下载任务启动: %s (%s) source=%s", task.task_id, label, source)
        return {"task_id": task.task_id, "label": label}

    elif task_type == "kb":
        task = download_engine.create_task("kb", "知识库模型（bge-m3 + reranker）")
        download_engine.run_kb_download(task, models_dir, source, on_complete=_finalize_install)
        log.info("[DL] KB 下载任务启动: %s source=%s", task.task_id, source)
        return {"task_id": task.task_id, "label": task.label}

    return JSONResponse({"error": "type 必须是 llm 或 kb"}, status_code=400)


# --------------------------------------------------------------------
# SSE 进度
# --------------------------------------------------------------------

@router.get("/api/models/download/progress/{task_id}")
def api_download_progress(task_id: str):
    """SSE 下载进度推送。"""
    task = download_engine.get_task(task_id)
    if not task:
        return JSONResponse({"error": "未知下载任务"}, status_code=404)

    q = task.queue

    def event_stream():
        while True:
            try:
                item = q.get(timeout=300)
            except Exception:
                yield b": heartbeat\n\n"
                continue
            if item is None:
                break
            # 下载完成时推一个安装完成事件（安装收尾已由 worker 线程的 on_complete 回调执行）
            if item.get("done"):
                yield _sse_pack(item)
                if task.status == "done":
                    yield _sse_pack({"pct": 100, "msg": "安装完成", "done": True, "installed": True})
                break
            yield _sse_pack(item)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


def _sse_pack(item: dict) -> bytes:
    return ("data: " + json.dumps(item, ensure_ascii=False) + "\n\n").encode("utf-8")


def _finalize_install(task):
    """下载完成后的安装收尾。

    LLM: 调 rescan 刷新注册表（GGUF 就位后自动识别）。
    KB:  注册 ExtensionRegistry + kb.load_models()。
    """
    # on_complete 在 worker 置 status="done" 之前调用（保证 done 事件发出时收尾已完成），
    # 因此这里接受 running/done，只排除 error/cancelled。
    if task.status in ("error", "cancelled"):
        return
    try:
        if task.type == "llm":
            mgr = get_mgr()
            mgr._scan_models()
            log.info("[DL] LLM 安装完成，已刷新模型列表")
            # 自动加载：当前没有已加载模型时，直接启动刚下载的模型（下载即可用——
            # 否则用户会困惑"下好了为什么还提示去设置页加载"）
            try:
                from server import ollama_manager
                if not ollama_manager.get_status().get("current_model"):
                    _mid = (getattr(task, "meta", None) or {}).get("model_id", "")
                    _path = None
                    for m in ollama_manager.list_available_models():
                        if m["model_id"] == _mid:
                            _path = m["gguf_path"]
                            break
                    if _path:
                        log.info("[DL] 自动加载新下载的模型: %s", _mid)
                        ollama_manager.switch_model(_path)
            except Exception as e:
                log.warning("[DL] 自动加载模型失败（可在设置页手动加载）: %s", str(e)[:120])
        elif task.type == "kb":
            from config import EXTENSIONS_DIR
            from core.extension_manager import ExtensionRegistry
            reg = ExtensionRegistry(EXTENSIONS_DIR)
            reg.register("knowledge", {
                "id": "knowledge",
                "version": "auto-detected",
                "models": {"embedding": "models/embedding", "reranker": "models/reranker"},
            })
            kb = get_kb()
            if kb:
                kb.load_models()
            log.info("[DL] KB 安装完成，已注册扩展并加载模型")
    except Exception as e:
        log.error("[DL] 安装收尾失败: %s", e, exc_info=True)
        task.error = "下载完成但安装失败: %s" % e


# --------------------------------------------------------------------
# 取消
# --------------------------------------------------------------------

@router.post("/api/models/download/cancel")
async def api_download_cancel(request: Request):
    body = await request.json()
    task_id = body.get("task_id", "").strip()
    task = download_engine.get_task(task_id)
    if not task:
        return JSONResponse({"error": "未知下载任务"}, status_code=404)
    task.cancel()
    task.queue.put({"pct": 0, "msg": "已取消", "done": True, "cancelled": True})
    log.info("[DL] 下载任务已取消: %s", task_id)
    return {"ok": True}
