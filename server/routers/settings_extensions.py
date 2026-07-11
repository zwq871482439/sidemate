# -*- coding: utf-8 -*-
"""
routers/settings_extensions.py — 扩展包管理端点

端点前缀 /api：
  扩展上传：/api/extensions/upload
  安装进度：/api/extensions/install-progress/{task_id}
  扩展列表：/api/extensions/list
  扩展卸载：/api/extensions/uninstall/{ext_type}/{ext_name}
  旧版兼容：/api/extensions/{ext_type}/{ext_name}
"""
import os
import sys
import re
import json
import time
import logging
import shutil
import subprocess
import zipfile
import uuid as _uuid
import threading as _threading
import queue as _queue
from datetime import datetime

from fastapi import APIRouter, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from routers.deps import (
    get_mgr, get_kb,
    WORKSPACE_DIR,
)

router = APIRouter()
log = logging.getLogger("settings.extensions")


# ============================================================
#  扩展依赖检查
# ============================================================

def _check_requires(manifest: dict) -> list:
    """检查扩展的前置依赖（KB/LLM 互相独立，暂不强制检查）"""
    return []


# ============================================================
#  权限系统 / 审计日志 — 已在 Patch11 拆除
# ============================================================


# ============================================================
#  扩展包管理
# ============================================================

# --- 安装任务管理器 ---
_install_tasks = {}  # task_id -> {queue, status, result, created_at}
_install_cleanup_done = False


def _cleanup_old_tasks():
    """清理超过 5 分钟的已完成安装任务"""
    global _install_cleanup_done
    if _install_cleanup_done:
        return
    _install_cleanup_done = True
    import time as _t
    now = _t.time()
    expired = [tid for tid, info in _install_tasks.items()
               if info.get("status") in ("done", "error") and now - info.get("created_at", now) > 300]
    for tid in expired:
        del _install_tasks[tid]
    _install_cleanup_done = False


def _install_worker(task_id, sidemate_path, tmp_dir, _project_dir):
    """后台线程：校验 → 解压 → 安装 → 加载"""
    from config import EXTENSIONS_DIR
    info = _install_tasks[task_id]
    q = info["queue"]

    def progress(percent, stage):
        q.put(('data: {"type":"progress","percent":%d,"stage":"%s"}\n\n' % (percent, stage)).encode("utf-8"))

    try:
        # === 阶段 1: 校验 (0-10%) ===
        progress(2, "校验扩展包完整性...")
        from common.sidemate_validator import SidemateValidator
        validator = SidemateValidator()  # v2: HMAC 已移除，改为 SHA256 完整性校验
        is_valid, msg, manifest = validator.validate_sidemate(sidemate_path)

        if not is_valid:
            raise ValueError(".sidemate 校验失败: %s" % msg)
        if not manifest:
            raise ValueError(".sidemate 包中无有效 manifest")

        ext_type = manifest.get("type", "unknown")
        ext_name = manifest.get("name", "unknown")

        # 兼容旧包名映射
        if ext_type in ("extension-knowledge", "knowledge"):
            ext_type = "knowledge"
        # llm 保持不变

        progress(10, "校验完成")

        # === 前置依赖检查 ===
        missing_deps = _check_requires(manifest)
        if missing_deps:
            raise ValueError("缺少前置依赖: %s，请先安装后再试" % "、".join(missing_deps))

        # === 阶段 2: 解压 (10-40%) ===
        extracted_dir = os.path.join(tmp_dir, "extracted")
        progress(12, "正在解压文件...")

        with zipfile.ZipFile(sidemate_path, "r") as zf:
            members = zf.namelist()
            total = len(members)
            # 安全检查
            for member in members:
                member_path = os.path.join(extracted_dir, member)
                if not os.path.realpath(member_path).startswith(os.path.realpath(extracted_dir)):
                    raise ValueError("包包含不安全路径")
            # 逐文件解压 + 进度
            for i, member in enumerate(members):
                zf.extract(member, extracted_dir)
                if i % max(1, total // 15) == 0:
                    pct = 10 + int(30 * (i + 1) / total)
                    progress(min(pct, 39), "解压文件 (%d/%d)..." % (i + 1, total))

        manifest_path = os.path.join(extracted_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            raise ValueError("解压后未找到 manifest.json")

        progress(40, "解压完成，开始安装...")

        # === 阶段 3: 安装 (40-90%) ===
        if ext_type == "knowledge":
            # 文库扩展包：bge-base-zh-v1.5 + bge-reranker-base + sentence-transformers wheels
            progress(42, "安装文库扩展模型...")
            models_src = os.path.join(extracted_dir, "models")
            models_dst = os.path.join(_project_dir, "models")
            os.makedirs(models_dst, exist_ok=True)

            # 复制 models/embedding/ → _project_dir/models/embedding/
            # 复制 models/reranker/  → _project_dir/models/reranker/
            if os.path.isdir(models_src):
                for sub in ("embedding", "reranker"):
                    src_sub = os.path.join(models_src, sub)
                    dst_sub = os.path.join(models_dst, sub)
                    if os.path.isdir(src_sub):
                        if os.path.exists(dst_sub):
                            shutil.rmtree(dst_sub)
                        shutil.copytree(src_sub, dst_sub)
                        progress(50 if sub == "embedding" else 60,
                                 "安装文库模型 %s..." % sub)

            progress(65, "检查文库依赖...")
            # 依赖健康检查：KB 依赖（sentence_transformers/torch/transformers）已由
            # 基础安装包预装进嵌入式 python，knowledge 包不带 wheels（确认：包内 0 个 .whl）
            # 此处仅做健康检查，若依赖缺失则提示重装基础包（不再尝试从包内 wheels 安装）
            missing_deps = []
            for _mod in ("sentence_transformers", "torch", "transformers"):
                try:
                    __import__(_mod)
                except ImportError:
                    missing_deps.append(_mod)

            if missing_deps:
                # 依赖缺失：基础安装包损坏，提示用户重装（而非尝试从包内 wheels 安装）
                log.warning("[EXT] 文库依赖缺失: %s（基础包应预装，请重装 Sidemate）", missing_deps)
                progress(70, "⚠️ 文库依赖缺失，文档检索可能不可用")
            else:
                progress(70, "文库依赖已就绪")

            progress(80, "注册文库扩展...")
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.register("knowledge", {
                "id": "knowledge",
                "version": manifest.get("version", "1.0.0"),
                "models": {
                    "embedding": "models/embedding",
                    "reranker": "models/reranker",
                },
                "installed_at": datetime.now().isoformat(),
            })

            progress(90, "加载文库模型...")
            kb = get_kb()
            kb.load_models()

            # 动态启动 TaggingScheduler（安装扩展后无需重启服务）
            try:
                import server as _srv
                _srv._kb_installed = True
                if not _srv._tagging_scheduler:
                    from core.tagging_scheduler import TaggingScheduler
                    _ts = TaggingScheduler(kb, _srv.mgr)
                    _ts.start()
                    _srv._tagging_scheduler = _ts
                    kb._tagging_scheduler = _ts
                    # 入队所有已有的 pending 文档
                    _cnt = 0
                    for _doc in kb.documents.values():
                        if _doc.status == 'ready' and getattr(_doc, 'tag_status', 'pending') in ('pending', 'generating'):
                            _doc.tag_status = 'pending'
                            _ts.enqueue(_doc.doc_id)
                            _cnt += 1
                    if _cnt > 0:
                        log.info("[EXT] TaggingScheduler 已启动，入队 %d 篇待打标文档", _cnt)
            except Exception as _e:
                log.warning("[EXT] TaggingScheduler 启动失败（重启后自动恢复）: %s", str(_e)[:120])

            result = {"ok": True, "type": "knowledge", "name": ext_name,
                      "version": manifest.get("version", "1.0"),
                      "auto_loaded": True}

        elif ext_type == "llm":
            # P7-4: LLM 模型包安装（llama.cpp 格式）
            # 从 .sidemate 包中找 GGUF 文件 → 放到 models/<model_id>/ → 写 meta.json
            # 支持两种包格式：
            #   (A) 裸 GGUF：包内直接是 .gguf 文件
            #   (B) Ollama 原生：包内有 models/blobs/ + manifests/（自动迁移）
            progress(42, "安装 LLM 模型文件...")

            models_dst = os.path.join(_project_dir, "models")
            os.makedirs(models_dst, exist_ok=True)

            # 找包内所有 GGUF 文件
            gguf_files = []
            for dirpath, dirnames, filenames in os.walk(extracted_dir):
                for fname in filenames:
                    if fname.lower().endswith(".gguf"):
                        gguf_files.append(os.path.join(dirpath, fname))

            # 如果没找到 GGUF，检查是否是 Ollama blob 格式
            if not gguf_files:
                native_blobs_src = os.path.join(extracted_dir, "models", "blobs")
                native_manifests_src = os.path.join(extracted_dir, "models", "manifests")
                if os.path.isdir(native_blobs_src) and os.path.isdir(native_manifests_src):
                    # Ollama 格式：直接把 blobs + manifests 合并到 models/，
                    # ModelRegistry.scan() 的 _migrate_ollama_blobs() 会自动迁移
                    progress(50, "检测到 Ollama 格式，合并 blob + manifest...")
                    blobs_dst = os.path.join(models_dst, "blobs")
                    manifests_dst = os.path.join(models_dst, "manifests")
                    os.makedirs(blobs_dst, exist_ok=True)
                    os.makedirs(manifests_dst, exist_ok=True)
                    # 合并 blobs
                    for item in os.listdir(native_blobs_src):
                        src = os.path.join(native_blobs_src, item)
                        dst = os.path.join(blobs_dst, item)
                        if os.path.isfile(src) and not os.path.exists(dst):
                            try:
                                os.link(src, dst)
                            except OSError:
                                shutil.copy2(src, dst)
                    # 合并 manifests
                    for dirpath, dirnames, filenames in os.walk(native_manifests_src):
                        for fname in filenames:
                            src = os.path.join(dirpath, fname)
                            rel = os.path.relpath(dirpath, native_manifests_src)
                            dst_dir = os.path.join(manifests_dst, rel) if rel != "." else manifests_dst
                            os.makedirs(dst_dir, exist_ok=True)
                            shutil.copy2(src, os.path.join(dst_dir, fname))
                    # 删迁移标记，让下次 scan 重新迁移
                    _marker = os.path.join(models_dst, ".ollama_migrated")
                    if os.path.exists(_marker):
                        os.remove(_marker)
                    progress(80, "Ollama 格式合并完成，等待自动迁移...")
                else:
                    raise ValueError("LLM 包中未找到 .gguf 文件或 Ollama blob 格式")
            else:
                # 裸 GGUF 格式：每个 GGUF 文件 → models/<model_id>/<name>.gguf + meta.json
                from core.llamacpp_backend import ModelRegistry
                _registry = ModelRegistry(models_dst)

                for i, gguf_path in enumerate(gguf_files):
                    gguf_name = os.path.basename(gguf_path)
                    gguf_size = os.path.getsize(gguf_path)

                    # 从文件名推断 model_id 和信息
                    model_id = ext_name or os.path.splitext(gguf_name)[0]
                    model_id = model_id.replace(" ", "-").lower()
                    size_b, quant, display_name = ModelRegistry._infer_model_info(model_id, gguf_size)

                    target_dir = os.path.join(models_dst, model_id)
                    os.makedirs(target_dir, exist_ok=True)
                    dst_gguf = os.path.join(target_dir, gguf_name)

                    # 复制或硬链接 GGUF
                    if not os.path.exists(dst_gguf):
                        try:
                            os.link(gguf_path, dst_gguf)
                        except OSError:
                            shutil.copy2(gguf_path, dst_gguf)

                    # 写 meta.json
                    meta = {
                        "model_id": model_id,
                        "display_name": display_name,
                        "size_b": size_b,
                        "quant": quant,
                        "gguf_filename": gguf_name,
                        "gguf_size_bytes": gguf_size,
                        "download": {"source": "sidemate_extension", "repo_id": "", "filename": gguf_name},
                        "requirements": {"min_ram_gb": 8, "min_vram_gb": 0, "recommended_vram_gb": 6},
                        "default_num_ctx": 8192,
                        "supports_think": size_b >= 2,
                        "multimodal": False,
                    }
                    meta_path = os.path.join(target_dir, "meta.json")
                    with open(meta_path, "w", encoding="utf-8") as f:
                        json.dump(meta, f, ensure_ascii=False, indent=2)

                    progress(min(42 + int((i + 1) * 40 / max(1, len(gguf_files))), 82),
                             "安装 %s (%.1fGB)..." % (gguf_name, gguf_size / 1024**3))
                    log.info("[EXT] GGUF 安装完成: %s → %s/", gguf_name, model_id)

            progress(90, "扫描模型...")
            mgr = get_mgr()
            mgr._scan_models()

            # 注册 LLM 到 ExtensionRegistry（修复重启后 is_installed("llm") 返回 False）
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.register("llm", {
                "id": "llm",
                "version": manifest.get("version", "1.0.0"),
                "name": ext_name,
                "models": {"llm": "models/llm"},
                "installed_at": datetime.now().isoformat(),
            })

            result = {"ok": True, "type": "llm", "name": ext_name,
                      "version": manifest.get("version", "1.0")}

        else:
            raise ValueError("不支持的扩展类型: %s" % ext_type)

        # === 完成 ===
        progress(95, "即将完成...")
        info["status"] = "done"
        info["result"] = result
        result_json = json.dumps(result, ensure_ascii=False)
        q.put(('data: {"type":"done","result":%s}\n\n' % result_json).encode("utf-8"))
        q.put(None)

    except Exception as e:
        log.error("[EXT] 扩展安装失败: %s" % str(e))
        info["status"] = "error"
        info["error"] = str(e)
        err_msg = str(e)[:200].replace('"', '\\"')
        q.put(('data: {"type":"error","message":"%s"}\n\n' % err_msg).encode("utf-8"))
        q.put(None)
    finally:
        # 清理临时目录
        for _attempt in range(3):
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                break
            except Exception:
                import time as _time
                _time.sleep(0.5)


@router.post("/api/extensions/upload")
async def api_extensions_upload(file: UploadFile = File(...)):
    """上传 .sidemate 扩展包 — 异步模式：返回 task_id，通过 SSE 获取进度"""
    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)

    if not file.filename.lower().endswith('.sidemate'):
        return JSONResponse({"error": "请上传 .sidemate 格式的扩展包"}, status_code=400)

    # 接收文件到临时目录
    content = await file.read()
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    from config import EXTENSIONS_DIR
    os.makedirs(EXTENSIONS_DIR, exist_ok=True)

    import tempfile
    tmp_dir = tempfile.mkdtemp(prefix="ext_install_")
    sidemate_path = os.path.join(tmp_dir, "upload.sidemate")

    with open(sidemate_path, "wb") as f:
        f.write(content)

    # 生成 task_id，启动后台安装线程
    task_id = _uuid.uuid4().hex[:12]
    import time as _t
    _install_tasks[task_id] = {
        "queue": _queue.Queue(),
        "status": "running",
        "result": None,
        "error": None,
        "created_at": _t.time(),
    }

    t = _threading.Thread(target=_install_worker, args=(task_id, sidemate_path, tmp_dir, _project_dir))
    t.daemon = True
    t.start()

    # 清理旧任务
    _cleanup_old_tasks()

    log.info("[EXT] 扩展安装任务已启动: %s (file: %s)" % (task_id, file.filename))
    return {"task_id": task_id, "filename": file.filename}


@router.get("/api/extensions/install-progress/{task_id}")
def api_extensions_install_progress(task_id: str):
    """SSE 扩展安装进度推送"""
    info = _install_tasks.get(task_id)
    if not info:
        return JSONResponse({"error": "未知安装任务"}, status_code=404)

    q = info["queue"]

    def event_stream():
        while True:
            try:
                item = q.get(timeout=300)  # 最长等待 5 分钟
            except Exception:
                # 超时，发一个心跳
                yield b': heartbeat\n\n'
                continue
            if item is None:
                break
            yield item

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/api/extensions/list")
def api_extensions_list():
    """已安装扩展列表（含 type 字段，同时兼容新旧注册方式）"""
    from config import EXTENSIONS_DIR
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    extensions = []

    # 新方式：ExtensionRegistry 注册信息
    try:
        from core.extension_manager import ExtensionRegistry
        registry = ExtensionRegistry(EXTENSIONS_DIR)
        for ext_info in registry.list_installed():
            ext_id = ext_info.get("id", "unknown")
            extensions.append({
                "name": ext_id,
                "version": ext_info.get("version", "?"),
                "type": ext_id,  # knowledge / recorder
                "models": ext_info.get("models", {}),
                "installed_at": ext_info.get("installed_at", ""),
            })
    except Exception as e:
        log.warning("[EXT] 读取 ExtensionRegistry 失败: %s", str(e)[:100])

    return {"extensions": extensions}


@router.delete("/api/extensions/uninstall/{ext_type}/{ext_name}")
async def api_extensions_uninstall(ext_type: str, ext_name: str):
    """通用卸载扩展"""
    from config import EXTENSIONS_DIR
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    if ext_type == "knowledge":
        kb = get_kb()
        if kb._embedder_loaded or kb.reranker._loaded:
            kb.unload_models()
        # 删除模型目录
        for sub in ("embedding", "reranker"):
            model_dir = os.path.join(_project_dir, "models", sub)
            if os.path.exists(model_dir):
                shutil.rmtree(model_dir)
        # 通过 ExtensionRegistry 注销
        try:
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.unregister("knowledge")
        except Exception as reg_err:
            log.warning("[EXT] 文库注册注销失败: %s", str(reg_err)[:100])
        log.info("[EXT] 文库扩展已卸载")
        return {"ok": True, "msg": "文库扩展已卸载"}

    elif ext_type == "llm":
        # P7-4: 删除 GGUF + meta.json（替代删 Ollama manifest 目录）
        mgr = get_mgr()
        models_dir = os.path.join(_project_dir, "models")
        model_id = ext_name.replace(".", "-").replace(" ", "-").lower()
        try:
            from core.llamacpp_backend import ModelRegistry
            _reg = ModelRegistry(models_dir)
            _reg.scan()
            _reg.remove(model_id)
            log.info("[EXT] 已删除 LLM 模型: %s", model_id)
        except Exception as rm_err:
            log.warning("[EXT] 删除模型文件失败: %s", str(rm_err)[:100])
        # 通过 ExtensionRegistry 注销
        try:
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.unregister("llm")
        except Exception as reg_err:
            log.warning("[EXT] LLM 注册注销失败: %s", str(reg_err)[:100])
        mgr._scan_models()
        log.info("[EXT] LLM 模型已卸载: %s", ext_name)
        return {"ok": True, "msg": "LLM 模型已卸载"}

    return JSONResponse({"error": "未知扩展类型: %s" % ext_type}, status_code=404)


@router.delete("/api/extensions/{ext_type}/{ext_name}")
async def api_extensions_delete_legacy(ext_type: str, ext_name: str):
    """卸载扩展（旧版路径，保留兼容）"""
    return await api_extensions_uninstall(ext_type, ext_name)


# ============================================================
#  搜索 API（Patch 2 — 联网研究配置）
# ============================================================

# ===== 搜索配置 API 已移除（本机直搜，零配置） =====
