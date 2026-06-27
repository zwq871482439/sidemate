# -*- coding: utf-8 -*-
"""
routers/settings_system.py — 系统信息/模型管理/设备/环境/配置/资源端点

端点前缀 /api：
  系统信息：/api/info, /api/status, /api/health, /api/token-budget, /api/models
  模型管理：/api/warmup, /api/load/{model_name}, /api/unload/{model_name},
            /api/model/unload, /api/model/delete
  设备管理：/api/devices, /api/device/switch
  环境检查：/api/env/check
  系统操作：/api/stop, /api/rescan
  模型导入：/api/models/import（已废弃）
  工作区：  /api/workspace, /api/workspace/{file_path:path}
  配置：    /api/config (GET/POST)
  资源：    /api/resource-info
  加载进度：/api/load-progress
"""
import os
import time
import logging
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, UploadFile, File, Request
from fastapi.responses import JSONResponse, FileResponse

from routers.deps import (
    get_mgr, get_kb,
    get_log, WORKSPACE_DIR, UPLOAD_DIR,
)

router = APIRouter()
log = logging.getLogger("settings.system")


# ============================================================
#  PermissionManager / AuditLogger 已在 Patch11 拆除
# ============================================================


# ============================================================
#  模型预热
# ============================================================

@router.post("/api/warmup")
def api_warmup():
    """预热模型：向 Ollama 发送一次简短请求，让模型加载到内存"""
    mgr = get_mgr()

    # 找到第一个可用 LLM
    llms = [name for name, cfg in mgr.model_configs.items() if cfg["type"] == "llm"]
    if not llms:
        return JSONResponse({"error": "未找到可用模型，请先安装模型"}, status_code=404)

    model_name = llms[0]

    # 如果已经加载（_loaded 中有记录），仍确保 DEFAULT_LLM 同步
    if model_name in mgr._loaded:
        import server as _svr
        if not getattr(_svr, "DEFAULT_LLM", None):
            _svr.DEFAULT_LLM = model_name
        return {"ok": True, "model": model_name, "already_warm": True}

    # 标记为加载中，防止重复触发
    if getattr(mgr, "_warmup_loading", False):
        return {"ok": True, "loading": True, "model": model_name}
    mgr._warmup_loading = True

    def _do_warmup():
        try:
            import httpx
            t0 = time.time()
            resp = httpx.post(
                "%s/v1/chat/completions" % mgr._ollama_base_url,
                json={
                    "model": model_name,
                    "messages": [
                        {"role": "system", "content": "你是桌伴，本地AI助手。"},
                        {"role": "user", "content": "ok"},
                    ],
                    "max_tokens": 1,
                    "stream": False,
                    "options": {"num_predict": 1},
                },
                timeout=120.0,
            )
            elapsed = time.time() - t0
            if resp.status_code == 200:
                mgr._loaded[model_name] = True
                mgr._load_times[model_name] = elapsed
                mgr._last_loaded_model = model_name
                log.info("[WARMUP] %s 预热完成 (%.1fs)", model_name, elapsed)
                # 更新 server.DEFAULT_LLM，防止启动时无模型、后续预热后仍为 None
                import server as _svr
                _svr.DEFAULT_LLM = model_name
            else:
                log.error("[WARMUP] 预热失败: %d %s", resp.status_code, resp.text[:200])
        except Exception as e:
            log.error("[WARMUP] 预热失败: %s", str(e)[:200])
        finally:
            mgr._warmup_loading = False

    import threading
    threading.Thread(target=_do_warmup, daemon=True).start()
    log.info("[WARMUP] %s 预热已启动（后台线程）", model_name)
    return {"ok": True, "loading": True, "model": model_name}


# ============================================================
#  系统信息端点
# ============================================================

@router.get("/api/info")
def api_info():
    """返回版本等信息（前端统一从此接口获取，不硬编码）"""
    from server import VERSION, VERSION_PATCH, FULL_VERSION
    modules = {}
    for mod_name in ("intelligence.task_classifier", "intelligence.response_filter",
                     "common.context_compressor", "prompts", "config"):
        try:
            parts = mod_name.split(".")
            mod = __import__(mod_name, fromlist=[parts[-1]])
            modules[mod_name] = getattr(mod, "__version__", "?")
        except ImportError:
            pass
    return {
        "version": FULL_VERSION,                           # "0.9.5"（从 config.py 单一来源）
        "version_display": "v%s" % FULL_VERSION,           # "v0.9.5"（统一格式，不再带 Patch 编号）
        "modules": modules,
    }


@router.get("/api/status")
def api_status():
    """模型状态 + 后台初始化状态"""
    from server import VERSION, VERSION_PATCH, FULL_VERSION
    mgr = get_mgr()
    s = mgr.status()
    result = {"version": FULL_VERSION}
    for name, info in s.items():
        result[name] = info

    # 【Patch5 启动重构】后台初始化状态机（Go Launcher 段2 轮询依据）
    try:
        import server as _svr
        # P6 调试：__main__ vs server 模块别名问题
        import sys as _sys
        _main_mod = _sys.modules.get('__main__')
        _srv_mod = _sys.modules.get('server')
        _main_state = getattr(_main_mod, '_bg_init_state', None) if _main_mod else None
        _srv_state = getattr(_srv_mod, '_bg_init_state', None) if _srv_mod else None
        if _main_state and _main_state.get('ready') and not _srv_state.get('ready'):
            # __main__ 已 ready 但 server 模块没同步 → 用 __main__ 的状态
            result["ready"] = _main_state["ready"]
            result["load_error"] = _main_state.get("load_error")
            result["bg_phase"] = _main_state.get("bg_phase", "done")
        else:
            with _svr._bg_init_lock:
                result["ready"] = _svr._bg_init_state["ready"]
                result["load_error"] = _svr._bg_init_state["load_error"]
                result["bg_phase"] = _svr._bg_init_state["bg_phase"]
    except Exception:
        # fallback：读取失败时默认 ready（不应发生）
        result["ready"] = True
        result["load_error"] = None
        result["bg_phase"] = "unknown"

    return result


@router.get("/api/health")
def api_health():
    """健康检查端点（适合外部监控）"""
    from server import VERSION, VERSION_PATCH, FULL_VERSION
    mgr = get_mgr()
    loaded = mgr.get_loaded_llms()
    return {
        "status": "ok",
        "model_loaded": bool(loaded),
        "loaded_models": loaded,
        "device": mgr._default_device,
        "version": FULL_VERSION,
    }


@router.get("/api/token-budget")
def api_token_budget():
    """Token 预算计算（基于当前设备和模型）"""
    mgr = get_mgr()
    loaded = mgr.get_loaded_llms()
    model_name = loaded[0] if loaded else None
    device = mgr._default_device
    if not model_name:
        return {"error": "未加载模型", "device": device}
    try:
        budget = mgr.calc_kb_context_budget()
        budget["device"] = device
        budget["model"] = mgr._short_name(model_name)
        budget["max_output_tokens"] = mgr._get_profile(model_name).get("default_max_tokens", 4096)
        return budget
    except Exception as e:
        return {"error": str(e)[:80], "device": device}


@router.get("/api/models")
def api_models():
    """返回可用 LLM 模型列表、当前状态和 profile 参数"""
    mgr = get_mgr()
    loaded = mgr.get_loaded_llms()
    current = loaded[0] if loaded else None
    profile_info = {}
    if current:
        try:
            p = mgr._get_profile(current)
            profile_info = {
                "model_size": mgr._get_model_size(current),
                "max_history_chars": p["max_history_chars"],
                "default_max_tokens": p["default_max_tokens"],
                "max_rounds": p["max_rounds"],
                "temperature": p["temperature"],
                "max_prompt_tokens": mgr._get_device_token_limit(current, mgr._default_device),
                "device": mgr._default_device,
            }
        except Exception:
            pass
    available_llms = [name for name, cfg in mgr.model_configs.items() if cfg["type"] == "llm"]
    return {
        "available": available_llms,
        "available_display": [mgr._short_name(n) for n in available_llms],
        "loaded": loaded,
        "current": current,
        "current_display": mgr._short_name(current) if current else None,
        "device": mgr._default_device,
        "profile": profile_info,
    }


# ============================================================
#  模型管理
# ============================================================

@router.post("/api/load/{model_name}")
def api_load(model_name: str):
    """加载模型（支持 progress_callback）"""
    mgr = get_mgr()
    result = mgr.load(model_name)
    log.info("[LOAD] %s -> %s" % (model_name, "OK" if "error" not in result else result.get("error", "unknown")))
    return result


@router.post("/api/unload/{model_name}")
def api_unload(model_name: str):
    """卸载模型"""
    mgr = get_mgr()
    return mgr.unload(model_name)


@router.post("/api/model/unload")
async def api_model_unload():
    """卸载当前加载的 LLM 模型（释放 Ollama 内存）"""
    mgr = get_mgr()
    loaded = mgr.get_loaded_llms()
    if not loaded:
        return {"ok": False, "error": "没有已加载的模型"}
    model_name = loaded[0]
    result = mgr.unload(model_name)
    # 清除内存缓存
    mgr._model_mem_mb.pop(model_name, None)
    log.info("[MODEL] 用户卸载模型: %s" % model_name)
    return {"ok": True, "model": model_name, "freed_mb": result.get("freed_mb", 0)}


@router.delete("/api/model/delete")
async def api_model_delete(request: Request):
    """删除已安装的 LLM 模型（从 Ollama 移除，释放磁盘空间）"""
    body = await request.json()
    model_name = body.get("model", "")
    if not model_name:
        return JSONResponse({"error": "未指定模型名称"}, status_code=400)
    mgr = get_mgr()
    result = mgr.delete_model(model_name)
    if result.get("ok"):
        log.info("[MODEL] 用户删除模型: %s" % model_name)
        return result
    return JSONResponse(result, status_code=500)


# ============================================================
#  设备管理
# ============================================================

@router.get("/api/devices")
def api_devices():
    """返回可用设备列表 + 当前选中设备"""
    mgr = get_mgr()
    return mgr.get_available_devices()


@router.post("/api/device/switch")
async def api_device_switch(request: Request):
    """切换推理设备（会卸载当前 LLM）"""
    body = await request.json()
    new_device = body.get("device", "")
    if not new_device:
        return JSONResponse({"error": "请指定设备"}, status_code=400)
    mgr = get_mgr()
    result = mgr.switch_device(new_device)
    if "error" in result:
        return JSONResponse(result, status_code=400)
    log.info("[DEVICE] 切换结果: %s" % result.get("message", ""))
    return result


# ============================================================
#  环境检查
# ============================================================

@router.get("/api/env/check")
def api_env_check():
    """返回完整环境报告"""
    mgr = get_mgr()
    return mgr.get_env_report()


# ============================================================
#  系统操作
# ============================================================

@router.post("/api/stop")
async def api_stop():
    """停止当前生成（同步等待设备释放完成）"""
    import asyncio
    mgr = get_mgr()
    with mgr._stop_lock:
        mgr._stop_generation = True
    loop = asyncio.get_running_loop()
    await loop.run_in_executor(None, mgr.stop_generation)
    return {"ok": True, "auto_reload": mgr._last_loaded_model is not None}


@router.post("/api/rescan")
def api_rescan():
    """重新扫描模型目录"""
    mgr = get_mgr()
    old_configs = {k: v for k, v in mgr.model_configs.items() if v["type"] == "llm"}
    mgr.model_configs = {k: v for k, v in mgr.model_configs.items() if v["type"] != "llm"}
    mgr._scan_models()
    new_llms = [name for name, cfg in mgr.model_configs.items() if cfg["type"] == "llm"]
    old_llms = list(old_configs.keys())
    added = [m for m in new_llms if m not in old_llms]
    removed = [m for m in old_llms if m not in new_llms]
    log.info("[RESCAN] 发现 %d 个模型 (新增: %s, 移除: %s)" % (len(new_llms), added, removed))
    return {
        "available": new_llms,
        "added": added,
        "removed": removed,
        "total": len(new_llms),
    }


# ============================================================
#  模型导入
# ============================================================

@router.post("/api/models/import")
async def api_models_import(file: UploadFile = File(...)):
    """[已废弃] 模型导入已合并到 /api/extensions/upload，请使用 .sidemate 格式上传"""
    return JSONResponse(
        {"error": "此端点已废弃，请使用 /api/extensions/upload 上传 .sidemate 包"},
        status_code=410,
    )


# ============================================================
#  工作区文件系统
# ============================================================

@router.get("/api/workspace/{file_path:path}")
def api_workspace_download(file_path: str):
    """下载沙盒中生成的文件"""
    workspace_dir = os.path.join(WORKSPACE_DIR, "workspace")
    target = os.path.realpath(os.path.join(workspace_dir, file_path))
    workspace_abs = os.path.realpath(workspace_dir)
    if not target.startswith(workspace_abs + os.sep) and target != workspace_abs:
        return JSONResponse({"error": "非法路径"}, status_code=403)

    # 拒绝隐藏文件（以 . 开头）
    basename = os.path.basename(target)
    if basename.startswith('.'):
        return JSONResponse({"error": "不允许下载隐藏文件"}, status_code=403)

    if not os.path.exists(target) or os.path.isdir(target):
        return JSONResponse({"error": "文件不存在"}, status_code=404)

    # 文件类型白名单
    _DOWNLOAD_ALLOWED_EXTENSIONS = {
        '.txt', '.md', '.csv', '.json', '.py', '.js', '.ts', '.html', '.css',
        '.xml', '.yaml', '.yml', '.toml', '.ini', '.log', '.pdf', '.docx',
        '.xlsx', '.pptx', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp',
        '.zip', '.tar', '.gz', '.rar', '.7z',
    }
    _, ext = os.path.splitext(basename).lower()
    if ext and ext not in _DOWNLOAD_ALLOWED_EXTENSIONS:
        return JSONResponse({"error": "不支持的文件类型: %s" % ext}, status_code=403)

    filename = os.path.basename(target)
    return FileResponse(target, filename=filename, media_type="application/octet-stream")


@router.get("/api/workspace")
def api_workspace_list():
    """列出沙盒中所有文件"""
    import glob as _g
    workspace_dir = os.path.join(WORKSPACE_DIR, "workspace")
    os.makedirs(workspace_dir, exist_ok=True)
    files = []
    for f in _g.glob(os.path.join(workspace_dir, "**", "*"), recursive=True):
        if os.path.isfile(f):
            rel = os.path.relpath(f, workspace_dir).replace("\\", "/")
            size = os.path.getsize(f)
            ext = os.path.splitext(f)[1].lower()
            icons = {
                ".txt": "", ".md": "", ".csv": "", ".json": "",
                ".docx": "", ".xlsx": "", ".pdf": "",
                ".py": "", ".html": "",
            }
            files.append({
                "name": os.path.basename(f),
                "path": rel,
                "size": size,
                "size_human": "%.1fKB" % (size / 1024) if size < 1024 * 1024 else "%.1fMB" % (size / (1024 * 1024)),
                "icon": icons.get(ext, ""),
                "download_url": "/api/workspace/" + rel,
                "modified": datetime.fromtimestamp(os.path.getmtime(f)).isoformat() if os.path.exists(f) else "",
            })
    return {"status": "ok", "files": files, "count": len(files)}


# ============================================================
#  配置
# ============================================================

@router.get("/api/config")
def api_config_get():
    """获取用户配置"""
    try:
        from config import load_config, CLEANUP_OPTIONS
        cfg = load_config()
        return {"status": "ok", "config": cfg, "cleanup_options": CLEANUP_OPTIONS}
    except ImportError:
        return {"status": "ok", "config": {}, "cleanup_options": {}}


@router.post("/api/config")
async def api_config_save(request: Request):
    """保存用户配置"""
    body = await request.json()
    try:
        from config import save_config
        ok = save_config(body)
        return {"status": "ok" if ok else "error"}
    except ImportError:
        return {"status": "error", "error": "配置模块不可用"}


# ============================================================
#  统一资源 API
# ============================================================

@router.get("/api/resource-info")
def api_resource_info():
    """统一的资源信息端点"""
    mgr = get_mgr()
    kb = get_kb()
    try:
        import psutil
        mem = psutil.virtual_memory()
        process = psutil.Process(os.getpid())
        process_mb = process.memory_info().rss / 1024 / 1024
    except Exception:
        mem = None
        process_mb = 0

    llm_loaded = mgr.get_loaded_llms()
    llm_name = llm_loaded[0] if llm_loaded else None
    llm_mb = mgr.get_llm_mem_mb(llm_name) if llm_name else 0

    kb_active = kb._embedder_loaded and kb.embedder.mode != "none"
    kb_models_mb = kb._embedder_mem_mb + kb._reranker_mem_mb if kb_active else 0

    kb_reranker_loaded = kb.reranker.available
    reranker_mb = kb._reranker_mem_mb if kb_reranker_loaded else 0
    embedder_mb = kb._embedder_mem_mb if kb_active else 0

    # P6 归档：recorder 已下线，内存占用归零
    recorder_mb = 0
    recorder_loaded = False

    # V5.1: Ollama 架构下 LLM 跑在独立进程（ollama serve + llama-server.exe），
    # Python 进程的 RSS 不包含 LLM 内存。base 就是 Python 进程自身。
    # 注意：Embedder + Reranker 都跑在 Python 进程内，
    # 其 RSS 已包含在 process_mb 中，需要减去以避免被算进"基础"
    _inproc_modules_mb = 0
    if embedder_mb > 0:
        _inproc_modules_mb += embedder_mb
    if reranker_mb > 0:
        _inproc_modules_mb += reranker_mb
    base_mb = max(10, round(process_mb) - _inproc_modules_mb)

    log.info("[RES] process=%.0fMB base=%.0fMB recorder=%.0fMB embedder=%.0fMB reranker=%.0fMB llm=%.0fMB inproc=%.0fMB",
             process_mb, base_mb, recorder_mb, embedder_mb, reranker_mb, llm_mb, _inproc_modules_mb)

    # 检测扩展是否已安装（不依赖是否加载到内存）
    kb_extension_installed = False
    # P6 归档：recorder_installed 永远 False（模块已下线）
    try:
        from core.extension_manager import ExtensionRegistry
        from config import EXTENSIONS_DIR
        _ext_dir = EXTENSIONS_DIR
        _registry = ExtensionRegistry(_ext_dir)
        kb_extension_installed = _registry.is_installed("knowledge")
    except Exception:
        # fallback: 文件存在性检测
        try:
            from config import EXTENSIONS_DIR
            _ext_dir = EXTENSIONS_DIR
            kb_extension_installed = os.path.exists(os.path.join(_ext_dir, "knowledge.json"))
        except Exception:
            kb_extension_installed = kb_active

    # B5: 移除内存预算报告（budget_report / recommended / MemoryManager 已废弃）
    # 预算汇总改为实时计算模块占用（不再依赖 memory_manager）
    actual_modules_used = llm_mb + embedder_mb + reranker_mb + base_mb

    result = {
        "system": {
            "total_mb": round(mem.total / 1024 / 1024) if mem else 0,
            "used_mb": round(mem.used / 1024 / 1024) if mem else 0,
            "available_mb": round(mem.available / 1024 / 1024) if mem else 0,
            "process_mb": round(process_mb),
        },
        "modules": {
            "llm": {"name": llm_name, "mb": llm_mb,
                    "loaded": llm_name is not None,
                    "installed": bool(mgr.model_configs)},
            "embedder": {"name": getattr(kb.embedder, 'model_name', 'unknown') if (kb and kb.embedder) else '未加载', "mb": embedder_mb,
                         "loaded": kb_active, "installed": kb_extension_installed},
            "reranker": {"name": "bge-reranker-base", "mb": reranker_mb,
                         "loaded": kb_reranker_loaded, "installed": kb_extension_installed},
            # P6 归档：recorder 已下线，保留字段为兼容前端
            "recorder": {"name": "whisper", "mb": 0,
                         "loaded": False, "installed": False},
            "base": {"mb": base_mb, "loaded": True, "installed": True},
        },
    }
    return result


# ============================================================
#  SSE 进度端点
# ============================================================

@router.get("/api/load-progress")
def api_load_progress(model_name: str, device: str = None):
    """SSE 模型加载进度（支持 device 参数，在加载前切换设备）"""
    mgr = get_mgr()

    # 如果传了 device 且与当前不同，先切换
    if device and device.lower() != mgr._default_device.lower():
        switch_result = mgr.switch_device(device)
        if "error" in switch_result:
            def error_stream():
                yield ('data: {"type":"error","message":"%s"}\n\n' % switch_result["error"]).encode("utf-8")
                yield b'data: [DONE]\n\n'
            from fastapi.responses import StreamingResponse
            return StreamingResponse(error_stream(), media_type="text/event-stream")

    def event_stream():
        import queue
        q = queue.Queue()

        def callback(percent, stage):
            q.put('data: {"type":"progress","percent":%d,"stage":"%s"}\n\n' % (percent, stage))

        def load_worker():
            result = mgr.load(model_name, progress_callback=callback)
            if "error" in result:
                q.put('data: {"type":"error","message":"%s"}\n\n' % result["error"])
            else:
                q.put('data: {"type":"done","percent":100,"model":"%s"}\n\n' % model_name)
            q.put(None)

        import threading
        t = threading.Thread(target=load_worker)
        t.start()

        while True:
            item = q.get()
            if item is None:
                break
            yield item

    from fastapi.responses import StreamingResponse
    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ============================================================
#  安装引导状态
# ============================================================

@router.get("/api/onboard/status")
def api_onboard_status():
    """返回当前安装状态（首次引导用）

    检查 .onboard_done 标记文件以及各组件安装状态，
    前端据此判断是否显示首次引导流程。
    """
    import os
    from core.extension_manager import ExtensionRegistry
    from config import get as cfg_get, DATA_DIR, EXTENSIONS_DIR

    registry = ExtensionRegistry(EXTENSIONS_DIR)

    # 检查 .onboard_done 标记
    onboard_marker = os.path.join(DATA_DIR, ".onboard_done")
    onboard_done = os.path.exists(onboard_marker)

    # 检查模型是否已加载
    mgr = get_mgr()
    model_loaded = False
    try:
        status = mgr.status()
        model_loaded = any(info.get("loaded", False) for info in status.values())
    except Exception:
        pass

    return {
        "completed": onboard_done,
        "llm_installed": registry.is_installed("llm"),
        "cloud_configured": bool(cfg_get("cloud_api_key", "")),
        "kb_installed": registry.is_installed("knowledge"),
        "recorder_installed": False,  # P6 归档：recorder 模块已下线
        "model_loaded": model_loaded,
    }


@router.post("/api/onboard/complete")
async def api_onboard_complete():
    """标记首次引导完成（创建 .onboard_done 文件）

    当用户完成首次设置流程（如预热模型、安装扩展等）后，
    前端调用此端点标记引导已完成。
    """
    import os
    from config import DATA_DIR

    onboard_marker = os.path.join(DATA_DIR, ".onboard_done")
    try:
        os.makedirs(DATA_DIR, exist_ok=True)
        with open(onboard_marker, "w", encoding="utf-8") as f:
            from datetime import datetime
            f.write(datetime.now().strftime("%Y-%m-%dT%H:%M:%S"))
        log.info("[ONBOARD] 首次引导标记已创建: %s", onboard_marker)
        return {"ok": True, "completed": True}
    except Exception as e:
        log.warning("[ONBOARD] 创建引导标记失败: %s", str(e))
        return JSONResponse({"ok": False, "error": str(e)[:100]}, status_code=500)


# ============================================================
#  系统运行环境信息
# ============================================================

@router.get("/api/system/info")
def api_system_info():
    """系统运行环境信息（关于对话框用）"""
    import platform
    from server import VERSION, VERSION_PATCH, FULL_VERSION
    from config import get as cfg_get

    # Ollama 状态
    ollama_status = "stopped"
    ollama_ver = "-"
    try:
        from core.ollama_manager import ollama_manager
        ollama_ver = getattr(ollama_manager, '_version', '-')
        # 检查 Ollama 进程是否在运行
        import httpx
        try:
            resp = httpx.get("http://127.0.0.1:11434/api/version", timeout=3, trust_env=False)
            if resp.status_code == 200:
                ollama_status = "running"
                ver_data = resp.json()
                if ver_data.get("version"):
                    ollama_ver = ver_data["version"]
        except Exception:
            pass
    except Exception:
        pass

    # 当前模式（local / cloud）
    ai_mode = cfg_get("ai_mode", "local")

    # GPU 信息（检测显示适配器，含集成显卡）
    gpu_info = "集成显卡/CPU"
    try:
        import subprocess
        _gpu_result = subprocess.run(
            ['wmic', 'path', 'win32_VideoController', 'get', 'name'],
            capture_output=True, text=True, timeout=5
        )
        _gpu_names = [line.strip() for line in _gpu_result.stdout.split('\n')
                      if line.strip() and line.strip().lower() != 'name']
        if _gpu_names:
            # P6 #26: 过滤虚拟显示设备(投屏/远程桌面等注册的虚拟显卡),只保留真实 GPU
            _VIRTUAL_KW = ('virtual', 'display device', 'mirror', 'remote', 'rdp', 'spice', 'parsec')
            _real_gpus = [n for n in _gpu_names
                          if not any(kw in n.lower() for kw in _VIRTUAL_KW)]
            # 若过滤后为空(全是虚拟设备),回退显示全部,避免空白
            gpu_info = ' · '.join((_real_gpus or _gpu_names)[:3])  # 最多显示3个
    except Exception:
        # 回退到 LLM 框架设备检测
        try:
            mgr = get_mgr()
            devices = mgr.list_devices() if hasattr(mgr, 'list_devices') else []
            if devices:
                gpu_info = ", ".join(d.get("name", "Unknown") for d in devices)
        except Exception:
            pass

    # 总内存 + 操作系统
    total_mem_gb = 0
    os_info = ""
    try:
        import psutil
        total_mem_gb = round(psutil.virtual_memory().total / (1024 ** 3), 1)
    except Exception:
        pass
    try:
        os_info = platform.platform()
    except Exception:
        pass

    # 数据目录大小（递归统计）
    data_dir = ""
    data_size_mb = 0
    try:
        from config import DATA_DIR
        data_dir = DATA_DIR
        _total_bytes = 0
        for _root, _dirs, _files in os.walk(DATA_DIR):
            for _f in _files:
                try:
                    _total_bytes += os.path.getsize(os.path.join(_root, _f))
                except Exception:
                    pass
        data_size_mb = round(_total_bytes / 1024 / 1024, 1)
    except Exception:
        pass

    return {
        "version": FULL_VERSION,                          # "0.9.5"（从 config.py 单一来源）
        "version_display": "v%s" % FULL_VERSION,          # "v0.9.5"（统一格式，不再带 Patch 编号）
        "python": platform.python_version(),
        "ollama_status": ollama_status,
        "ollama_version": ollama_ver,
        "mode": ai_mode,
        "gpu_info": gpu_info,
        "build_date": "2026-06-11",
        "data_dir": data_dir,
        "data_size_mb": data_size_mb,
        "total_mem_gb": total_mem_gb,
        "os_info": os_info,
    }


# ============================================================
#  许可证文件查看
# ============================================================

@router.get("/api/license")
def api_license(file: str = "LICENSE"):
    """读取 LICENSE 或 THIRD-PARTY-NOTICES 文件内容"""
    allowed = {"LICENSE", "THIRD-PARTY-NOTICES"}
    if file not in allowed:
        return JSONResponse({"error": "文件不允许访问"}, status_code=403)
    
    project_root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    license_path = os.path.join(os.path.dirname(project_root), file)
    if not os.path.isfile(license_path):
        return JSONResponse({"error": "文件不存在"}, status_code=404)
    
    try:
        with open(license_path, "r", encoding="utf-8") as f:
            return JSONResponse({"content": f.read(), "filename": file})
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)


# ============================================================
#  P6: 并行模式配置
# ============================================================

@router.get("/api/parallel/config")
def api_parallel_config_get():
    """获取并行模式配置

    Response: {"keyword_gen": false, "allow_cloud_keywords": false}
    """
    from config import get as _cfg_get
    allow_cloud_keywords = _cfg_get("parallel_keyword_gen", False)
    return {
        "keyword_gen": allow_cloud_keywords,
        "allow_cloud_keywords": allow_cloud_keywords,
    }


@router.post("/api/parallel/config")
async def api_parallel_config_save(request: Request):
    """设置并行模式配置

    Body: {"keyword_gen": true} 或 {"allow_cloud_keywords": true}
    Response: {"ok": true, "keyword_gen": true}
    """
    from config import set_value
    body = await request.json()
    # 支持两种字段名
    value = body.get("keyword_gen", body.get("allow_cloud_keywords", False))
    set_value("parallel_keyword_gen", bool(value))
    log.info("[PARALLEL] 配置已更新: parallel_keyword_gen=%s", bool(value))
    return {"ok": True, "keyword_gen": bool(value), "allow_cloud_keywords": bool(value)}


# ============================================================
#  Patch5 B3: 权限系统 API（预设 + 工具级权限）
# ============================================================

# 权限预设定义
_PERMISSION_PRESETS = [
    {
        "preset_id": "trusted",
        "name": "完全信任",
        "description": "所有工具可用，联网/文件操作不需确认",
        "config_overrides": {
            "confirm_external_read": False,
            "sandbox_cleanup": "never",
        },
    },
    {
        "preset_id": "cautious",
        "name": "谨慎模式",
        "description": "联网需确认，文件操作需确认，私密文档默认隔离",
        "config_overrides": {
            "confirm_external_read": True,
            "sandbox_cleanup": "24h",
        },
    },
    {
        "preset_id": "offline",
        "name": "纯离线",
        "description": "禁止联网，仅本地操作，强制本地 AI 模式",
        "config_overrides": {
            "ai_mode": "local",
            "confirm_external_read": True,
            # 联网工具 toggle off（通过 tool_enabled_web_search=False 实现）
            "tool_enabled_web_search": False,
        },
    },
]

# 工具级权限列表定义（映射到 config.py 配置项）
# 按大类分组（category），前端渲染成分类卡片。用户只关心职能大类，不暴露细粒度工具。
_PERMISSION_TOOLS = [
    # ===== 信息检索类 =====
    {
        "tool_id": "kb_search",
        "category": "信息检索",
        "name": "知识库检索",
        "description": "允许 Agent 检索知识库中的文档（search_kb）",
        "config_key": "tool_enabled_kb_search",
        "default_enabled": True,
    },
    {
        "tool_id": "web_search",
        "category": "信息检索",
        "name": "联网搜索",
        "description": "允许 Agent 使用搜索引擎查找信息、抓取网页（search_web + fetch_url）",
        "config_key": "tool_enabled_web_search",
        "default_enabled": True,
    },
    # ===== 工作区文件类 =====
    {
        "tool_id": "file_read_write",
        "category": "工作区文件",
        "name": "文件读写",
        "description": "允许 Agent 读取、创建、修改、删除工作区文件（含文档生成、深度阅读）",
        "config_key": "tool_enabled_file_rw",
        "default_enabled": True,
    },
]


@router.get("/api/permissions/presets")
def api_permissions_presets():
    """获取权限预设列表（B3）

    Response: {"presets": [{preset_id, name, description, config_overrides}, ...]}
    """
    return {"presets": _PERMISSION_PRESETS}


@router.post("/api/permissions/preset/apply")
async def api_permissions_preset_apply(request: Request):
    """应用权限预设（B3）

    Body: {"preset_id": "trusted" | "cautious" | "offline"}
    Response: {"ok": true, "applied_preset": "...", "config_changes": {...}}
    """
    body = await request.json()
    preset_id = body.get("preset_id", "").strip()
    if not preset_id:
        return JSONResponse({"error": "preset_id 不能为空"}, status_code=400)

    # 查找预设
    preset = None
    for p in _PERMISSION_PRESETS:
        if p["preset_id"] == preset_id:
            preset = p
            break
    if not preset:
        return JSONResponse({"error": "未知预设: %s" % preset_id}, status_code=400)

    # 写入 config
    from config import set_value
    config_changes = {}
    for key, value in preset["config_overrides"].items():
        set_value(key, value)
        config_changes[key] = value

    log.info("[PERMISSION] 应用权限预设: %s (%s), 变更: %s",
             preset_id, preset["name"], list(config_changes.keys()))
    return {"ok": True, "applied_preset": preset_id, "config_changes": config_changes}


@router.get("/api/permissions/tools")
def api_permissions_tools():
    """获取工具级权限列表（B3）

    Response: {"tools": [{tool_id, category, name, description, enabled}, ...]}
    """
    from config import get as _cfg
    tools = []
    for tool in _PERMISSION_TOOLS:
        enabled = _cfg(tool["config_key"], tool["default_enabled"])
        tools.append({
            "tool_id": tool["tool_id"],
            "category": tool.get("category", ""),
            "name": tool["name"],
            "description": tool["description"],
            "enabled": enabled,
        })
    return {"tools": tools}


@router.post("/api/permissions/tool/{tool_id}")
async def api_permissions_tool_set(tool_id: str, request: Request):
    """设置单个工具权限（B3）

    Body: {"enabled": true|false}
    Response: {"ok": true, "tool_id": "...", "enabled": ...}
    """
    body = await request.json()
    enabled = bool(body.get("enabled", True))

    # 查找工具
    tool = None
    for t in _PERMISSION_TOOLS:
        if t["tool_id"] == tool_id:
            tool = t
            break
    if not tool:
        return JSONResponse({"error": "未知工具: %s" % tool_id}, status_code=404)

    # 写入 config
    from config import set_value
    set_value(tool["config_key"], enabled)
    log.info("[PERMISSION] 工具权限设置: %s → enabled=%s", tool_id, enabled)
    return {"ok": True, "tool_id": tool_id, "enabled": enabled}


# ============================================================
#  云端 AI 用量统计
# ============================================================

@router.get("/api/cloud/usage")
def api_cloud_usage(range_days: int = 7, granularity: str = "hour"):
    """查询云端 AI 用量统计。

    Query Params:
        range_days: 查询范围（1=今日, 7=本周），默认 7
        granularity: 聚合粒度 "hour" 或 "day"，默认 hour

    Response: 见 core/cloud_usage.py query_usage() 返回结构
    """
    # 参数校验
    range_days = max(1, min(7, int(range_days)))
    if granularity not in ("hour", "day"):
        granularity = "hour"
    try:
        from core.cloud_usage import query_usage
        return query_usage(range_days=range_days, granularity=granularity)
    except Exception as e:
        log.error("[CLOUD_USAGE] 接口异常: %s", e)
        return JSONResponse(
            {"error": "用量统计查询失败: %s" % str(e)[:100],
             "total_tokens": 0, "total_calls": 0, "all_accurate": True,
             "by_model": [], "by_bucket": [], "records": []},
            status_code=500,
        )
