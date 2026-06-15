# -*- coding: utf-8 -*-
"""
routers/kb.py — 文库管理 Router

端点前缀 /api/kb：
  GET    /api/kb/stats                           — 文库统计
  GET    /api/kb/module-status                   — 模块安装状态
  GET    /api/kb/memory-info                     — 内存信息
  POST   /api/kb/install-module                  — 安装模块
  POST   /api/kb/uninstall-module                — 卸载模块
  POST   /api/kb/load-models                     — 加载模型
  POST   /api/kb/unload-models                   — 卸载模型
  GET    /api/kb/documents                       — 文档列表
  POST   /api/kb/upload                          — 上传文档
  GET    /api/kb/documents/{doc_id}/status       — 文档状态
  DELETE /api/kb/documents/{doc_id}              — 删除文档
  POST   /api/kb/documents/{doc_id}/pause        — 暂停处理
  POST   /api/kb/documents/{doc_id}/resume       — 恢复处理
  POST   /api/kb/documents/{doc_id}/cancel       — 取消处理
  POST   /api/kb/ask                             — KB 问答（SSE）
  POST   /api/kb/new_session                     — 新建KB会话
  POST   /api/kb/search                          — KB 检索
  POST   /api/kb/import_text                     — 导入文本
"""
import os
import sys
import json
import time
import uuid
import logging
import shutil
import zipfile
import threading
from datetime import datetime
from typing import Optional, Dict, List, Any

from fastapi import APIRouter, UploadFile, File, Request
from fastapi.responses import JSONResponse, StreamingResponse

from routers.deps import get_mgr, get_kb, get_log, WORKSPACE_DIR, UPLOAD_DIR
from routers.settings_system import _check_memory_budget

router = APIRouter()
log = get_log()


# ============================================================
#  扩展可用性检查
# ============================================================

def _get_extensions_dir() -> str:
    """获取扩展注册目录"""
    from config import ROOT_DIR
    return os.path.join(ROOT_DIR, "extensions")


def _check_knowledge_extension() -> Optional[JSONResponse]:
    """检查文库扩展是否已安装，未安装时返回错误响应

    Returns:
        None 如果已安装，否则返回 JSONResponse 错误
    """
    try:
        from extensions import ExtensionRegistry
        registry = ExtensionRegistry(_get_extensions_dir())
        if not registry.is_installed("knowledge"):
            return JSONResponse(
                {"error": "文库扩展未安装，请导入 sidemate-extension-knowledge-*.sidemate 包"},
                status_code=503
            )
    except Exception as e:
        log.warning("[KB] 扩展检查失败: %s", str(e)[:80])
    return None


# ============================================================
#  辅助函数
# ============================================================

def _safe_filename(filename: str) -> str:
    """防止路径遍历"""
    import re
    if not filename:
        return "unnamed"
    filename = os.path.basename(filename)
    filename = re.sub(r'[^\w\-.\u4e00-\u9fff]', '_', filename)
    if filename in (".", "..", ""):
        filename = "unnamed"
    return filename


def _get_module_dir():
    """获取 KB 模块安装目录"""
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        "data", "kb", "module")


def _is_module_installed():
    """检查 KB 模块是否已安装（优先使用 ExtensionRegistry）"""
    try:
        from extensions.registry import ExtensionRegistry
        _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        registry = ExtensionRegistry(os.path.join(_project_dir, "extensions"))
        return registry.is_installed("knowledge")
    except Exception:
        pass
    # 兼容旧路径
    return os.path.exists(os.path.join(_get_module_dir(), "install_info.json"))


def _get_memory_info():
    """获取系统内存信息"""
    kb = get_kb()
    mgr = get_mgr()
    try:
        import psutil
        mem = psutil.virtual_memory()
        process = psutil.Process(os.getpid())
        process_mb = process.memory_info().rss / 1024 / 1024

        kb_active = kb._embedder_loaded
        kb_reranker_loaded = kb.reranker.available
        kb_models_mb = kb._embedder_mem_mb + kb._reranker_mem_mb if kb_active else 0

        llm_loaded_list = mgr.get_loaded_llms()
        llm_mb = 0
        llm_name = None
        if llm_loaded_list:
            llm_name = llm_loaded_list[0]
            llm_mb = mgr.get_llm_mem_mb(llm_name)

        available_mb = round(mem.available / 1024 / 1024)
        return {
            "total_mb": round(mem.total / 1024 / 1024),
            "used_mb": round(mem.used / 1024 / 1024),
            "available_mb": available_mb,
            "process_mb": round(process_mb),
            "kb_models_mb": kb_models_mb,
            "kb_active": kb_active,
            "kb_reranker_loaded": kb_reranker_loaded,
            "llm_mb": llm_mb,
            "llm_name": llm_name,
            "after_load_mb": available_mb - kb_models_mb,
            "sufficient": mem.available > (kb_models_mb + 500) * 1024 * 1024,
        }
    except ImportError:
        return {
            "total_mb": 0, "used_mb": 0, "available_mb": 0,
            "process_mb": 0, "kb_models_mb": 0,
            "kb_active": False, "kb_reranker_loaded": False,
            "llm_mb": 0, "llm_name": None,
            "after_load_mb": 0, "sufficient": True,
            "psutil_missing": True,
        }


_dep_check_cache = None

def _check_kb_dependencies():
    """检查 KB 模块依赖，结果在进程生命周期内缓存"""
    global _dep_check_cache
    if _dep_check_cache is not None:
        return _dep_check_cache
    _dep_check_cache = {}
    for dep in ["rank_bm25", "jieba", "numpy"]:
        try:
            __import__(dep)
            _dep_check_cache[dep] = True
        except ImportError:
            _dep_check_cache[dep] = False
    return _dep_check_cache


# KB 会话历史（内存，按 session_id 隔离）
_kb_sessions: Dict[str, List[Dict]] = {}
_KB_SESSION_MAX_TURNS = 20  # 提高到20轮（之前4轮太少了）
_KB_SESSION_MAX_COUNT = 50  # P1-19: 最大会话数，防止内存泄漏
_kb_sessions_lock = threading.Lock()


def _kb_session_dir(session_id: str) -> str:
    """获取 KB 会话的磁盘目录路径（相对 data/kbsession/）"""
    from config import DATA_DIR
    return os.path.join(DATA_DIR, "kbsession", session_id)


def _kb_round_path(session_id: str, round_num: int) -> str:
    """获取指定轮次的 round 文件路径"""
    return os.path.join(_kb_session_dir(session_id), "round_%03d.json" % round_num)


def _kb_save_round(session_id: str, round_num: int, question: str, answer: str,
                   merge_result: str = None, token_stats: dict = None):
    """保存一轮对话到磁盘（round_NNN.json）"""
    try:
        session_dir = _kb_session_dir(session_id)
        os.makedirs(session_dir, exist_ok=True)
        data = {
            "round": round_num,
            "question": question,
            "answer": answer,
        }
        if merge_result:
            data["merge_result"] = merge_result
        if token_stats:
            data["token_stats"] = token_stats
        path = _kb_round_path(session_id, round_num)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    except Exception as e:
        log.warning("[KB-ROUND] 保存 round 文件失败: %s", str(e)[:80])


def _kb_load_rounds(session_id: str) -> list:
    """从磁盘加载所有轮次（服务重启恢复用）"""
    session_dir = _kb_session_dir(session_id)
    if not os.path.isdir(session_dir):
        return []
    rounds = []
    for fname in sorted(os.listdir(session_dir)):
        if fname.startswith("round_") and fname.endswith(".json"):
            try:
                with open(os.path.join(session_dir, fname), "r", encoding="utf-8") as f:
                    rounds.append(json.load(f))
            except Exception:
                pass
    return rounds


def _kb_rounds_to_history(rounds: list) -> list:
    """将 round 列表转换为 LLM history 格式 [{role, content}, ...]
    
    对比模式：assistant content = 【本地回答】answer\\n【综合分析】merge_result
    普通模式：assistant content = answer
    """
    history = []
    for r in rounds:
        q = r.get("question", "")
        a = r.get("answer", "")
        merge = r.get("merge_result")
        if not q:
            continue
        history.append({"role": "user", "content": q})
        if merge:
            content = "【本地回答】" + a + "\n【综合分析】" + merge
        else:
            content = a
        history.append({"role": "assistant", "content": content})
    return history


def _kb_delete_session(session_id: str):
    """删除 KB 会话的磁盘数据"""
    import shutil
    session_dir = _kb_session_dir(session_id)
    if os.path.isdir(session_dir):
        try:
            shutil.rmtree(session_dir)
        except Exception as e:
            log.warning("[KB-SESSION] 删除会话目录失败: %s", str(e)[:60])


def _kb_get_next_round(session_id: str) -> int:
    """获取下一个轮次编号"""
    session_dir = _kb_session_dir(session_id)
    if not os.path.isdir(session_dir):
        return 1
    existing = [f for f in os.listdir(session_dir) if f.startswith("round_") and f.endswith(".json")]
    return len(existing) + 1


# ============================================================
#  KB 统计与状态
# ============================================================

@router.get("/api/kb/stats")
def api_kb_stats():
    """文库统计"""
    # 扩展检查（允许未安装时返回降级统计）
    kb = get_kb()
    stats = kb.get_stats()
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        stats["extension_installed"] = False
    else:
        stats["extension_installed"] = True
    return stats


@router.get("/api/kb/module-status")
def api_kb_module_status():
    """KB 模块安装状态（简化二态：installed + ready）"""
    kb = get_kb()
    installed = _is_module_installed()
    ready = installed and kb._embedder_loaded and kb.embedder.mode == "bge"

    result = {
        "installed": installed,
        "ready": ready,
        "module_version": None,
        "error": kb._last_load_error or None,  # 加载失败时的错误信息
        "models": {
            "embedder": {
                "name": kb.embedder.model_name,
                "present": False,
                "loaded": kb._embedder_loaded,
                "mem_mb": kb._embedder_mem_mb,
            },
            "reranker": {
                "name": kb.reranker.model_name,
                "present": False,
                "loaded": kb.reranker.available,
                "mem_mb": kb._reranker_mem_mb,
            },
        },
        "memory": _get_memory_info(),
        "dependencies": {},
    }

    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    embedder_basename = kb.embedder.model_name.split("/")[-1]
    reranker_basename = kb.reranker.model_name.split("/")[-1]
    embedder_path = os.path.join(_project_dir, "models", "embedding", embedder_basename)
    reranker_path = os.path.join(_project_dir, "models", "reranker", reranker_basename)
    # 兼容旧路径（models/ 直接下放模型）
    embedder_path_legacy = os.path.join(_project_dir, "models", embedder_basename)
    reranker_path_legacy = os.path.join(_project_dir, "models", reranker_basename)

    result["models"]["embedder"]["present"] = (
        (os.path.isdir(embedder_path) and
         os.path.exists(os.path.join(embedder_path, "config.json")))
        or
        (os.path.isdir(embedder_path_legacy) and
         os.path.exists(os.path.join(embedder_path_legacy, "config.json")))
    )
    result["models"]["reranker"]["present"] = (
        (os.path.isdir(reranker_path) and
         os.path.exists(os.path.join(reranker_path, "config.json")))
        or
        (os.path.isdir(reranker_path_legacy) and
         os.path.exists(os.path.join(reranker_path_legacy, "config.json")))
    )

    if installed:
        try:
            info_path = os.path.join(_get_module_dir(), "install_info.json")
            with open(info_path, "r", encoding="utf-8") as f:
                info = json.load(f)
            result["module_version"] = info.get("version", "unknown")
        except Exception:
            pass

    result["dependencies"] = _check_kb_dependencies()
    return result


@router.get("/api/kb/memory-info")
def api_kb_memory_info():
    """内存余量详情"""
    return _get_memory_info()


# ============================================================
#  KB 模块管理
# ============================================================

@router.post("/api/kb/install-module")
async def api_kb_install_module(file: UploadFile = File(...)):
    """接收离线安装包 ZIP，执行安装"""
    kb = get_kb()
    mgr = get_mgr()
    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)
    if not file.filename.lower().endswith(".zip"):
        return JSONResponse({"error": "仅支持 .zip 格式的安装包"}, status_code=400)

    # P2-08: 先检查 Content-Length 做预检，避免全量读入内存
    content_length = 0
    if hasattr(file, 'headers'):
        try:
            content_length = int(file.headers.get('content-length', 0))
        except (ValueError, TypeError):
            pass
    if content_length > 2 * 1024 * 1024 * 1024:
        return JSONResponse({"error": "安装包过大（最大2GB）"}, status_code=400)

    # 流式写入临时文件，避免一次性全量加载到内存
    import tempfile
    tmp_dir = tempfile.mkdtemp(prefix="kb_install_")
    zip_path = os.path.join(tmp_dir, "upload.zip")
    _size_exceeded = False
    try:
        with open(zip_path, "wb") as f:
            while True:
                chunk = await file.read(1024 * 1024)  # 1MB chunks
                if not chunk:
                    break
                if f.tell() + len(chunk) > 2 * 1024 * 1024 * 1024:
                    _size_exceeded = True
                    break
                f.write(chunk)
    except Exception as e:
        # 清理临时目录
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return JSONResponse({"error": "文件读取失败: %s" % str(e)[:200]}, status_code=400)

    if _size_exceeded:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return JSONResponse({"error": "安装包过大（最大2GB）"}, status_code=400)

    module_dir = _get_module_dir()
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    try:
        with zipfile.ZipFile(zip_path, "r") as zf:
            for member in zf.namelist():
                member_path = os.path.normpath(os.path.join(tmp_dir, "extract", member))
                if not member_path.startswith(os.path.normpath(os.path.join(tmp_dir, "extract"))):
                    return JSONResponse({"error": "安装包包含非法路径"}, status_code=400)
            zf.extractall(os.path.join(tmp_dir, "extract"))

        extract_dir = os.path.join(tmp_dir, "extract")
        manifest_path = os.path.join(extract_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            return JSONResponse({"error": "无效的安装包：缺少 manifest.json"}, status_code=400)

        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

        log.info("[KB] 安装包信息: %s v%s", manifest.get("name", "?"), manifest.get("version", "?"))

        models_src = os.path.join(extract_dir, "models")
        models_dst = os.path.join(_project_dir, "models")
        installed_models = []
        if os.path.isdir(models_src):
            for model_name in os.listdir(models_src):
                src = os.path.join(models_src, model_name)
                dst = os.path.join(models_dst, model_name)
                if os.path.isdir(src):
                    if os.path.exists(dst):
                        shutil.rmtree(dst)
                    shutil.copytree(src, dst)
                    installed_models.append(model_name)
                    log.info("[KB] 安装模型: %s", model_name)

        wheels_dir = os.path.join(extract_dir, "wheels")
        installed_deps = []
        if os.path.isdir(wheels_dir):
            import subprocess
            wheel_files = [f for f in os.listdir(wheels_dir) if f.endswith((".whl", ".tar.gz"))]
            if wheel_files:
                pip_args = [
                    sys.executable, "-m", "pip", "install",
                    "--no-index", "--find-links", wheels_dir,
                    "--no-deps"
                ] + [os.path.join(wheels_dir, f) for f in wheel_files]
                try:
                    result = subprocess.run(pip_args, capture_output=True, text=True, timeout=120)
                    if result.returncode == 0:
                        installed_deps = [f.split("-")[0] for f in wheel_files]
                        log.info("[KB] 依赖安装成功: %s", installed_deps)
                    else:
                        log.warning("[KB] 部分依赖安装失败: %s", result.stderr[:200])
                except Exception as e:
                    log.warning("[KB] 依赖安装异常: %s", str(e)[:200])

        os.makedirs(module_dir, exist_ok=True)
        install_info = {
            "version": manifest.get("version", "1.0"),
            "name": manifest.get("name", "knowledge-base-module"),
            "installed_at": datetime.now().isoformat(),
            "installed_models": installed_models,
            "installed_deps": installed_deps,
            "manifest": manifest,
        }
        with open(os.path.join(module_dir, "install_info.json"), "w", encoding="utf-8") as f:
            json.dump(install_info, f, ensure_ascii=False, indent=2)

        log.info("[KB] 模块安装完成: models=%s, deps=%s", installed_models, installed_deps)

        # Patch10: 安装成功后自动加载模型
        kb.load_models()

        return {
            "success": True,
            "installed_models": installed_models,
            "installed_deps": installed_deps,
            "module_version": manifest.get("version", "1.0"),
            "auto_loaded": True,
        }

    except Exception as e:
        log.error("[KB] 安装失败: %s", str(e))
        return JSONResponse({"error": "安装失败: %s" % str(e)[:200]}, status_code=500)
    finally:
        # P2-09: Windows 下 tempdir 清理可能失败，重试
        for _attempt in range(3):
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                break
            except Exception:
                import time as _time
                _time.sleep(0.5)


@router.post("/api/kb/uninstall-module")
def api_kb_uninstall_module():
    """卸载 KB 模块"""
    kb = get_kb()

    # 先取消所有进行中的处理
    kb._cancel_all_processing()

    if kb._embedder_loaded or kb.reranker._loaded:
        kb.unload_models()

    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    embedder_basename = kb.embedder.model_name.split("/")[-1]
    reranker_basename = kb.reranker.model_name.split("/")[-1]
    freed = 0

    for model_name in [embedder_basename, reranker_basename]:
        # 新目录结构: models/embedding/ 和 models/reranker/
        for subdir in ["embedding", "reranker", ""]:
            model_path = os.path.join(_project_dir, "models", subdir, model_name) if subdir else os.path.join(_project_dir, "models", model_name)
            if os.path.exists(model_path):
                shutil.rmtree(model_path)
                freed += 1
                log.info("[KB] 删除模型文件: %s", model_path)

    module_dir = _get_module_dir()
    install_info = os.path.join(module_dir, "install_info.json")
    if os.path.exists(install_info):
        os.remove(install_info)

    log.info("[KB] 模块已卸载，删除 %d 个模型", freed)
    freed_mb = freed * 1050
    wheels_dir = os.path.join(module_dir, "wheels")
    if os.path.exists(wheels_dir):
        shutil.rmtree(wheels_dir)
        log.info("[KB] 删除依赖库: %s", wheels_dir)
        freed_mb += 50
    return {"success": True, "removed_models": freed, "freed_mb": freed_mb}


@router.post("/api/kb/unload-models")
def api_kb_unload_models():
    """卸载文库嵌入模型和 Reranker"""
    kb = get_kb()
    stats = kb.get_stats()
    if stats.get("processing_documents", 0) > 0:
        return JSONResponse({"error": "文档正在处理中，无法卸载模型"}, status_code=409)
    return kb.unload_models()


@router.post("/api/kb/load-models")
def api_kb_load_models():
    """重新加载文库嵌入模型和 Reranker（后台异步）"""
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check
    kb = get_kb()
    _budget = _check_memory_budget(estimated_mb=1400)
    if _budget:
        return JSONResponse(_budget, status_code=503)

    mem = _get_memory_info()
    ram_warning = None
    if not mem.get("psutil_missing") and mem["available_mb"] < 800:
        ram_warning = "可用内存仅 %dMB，加载文库模型可能导致系统卡顿" % mem["available_mb"]

    # 已加载 / 正在加载 → 立即返回
    if kb._embedder_loaded or kb.reranker._loaded:
        return kb.load_models()  # load_models 内部有重复检查，直接返回
    if getattr(kb, "_models_loading", False):
        result = {"ok": True, "loading": True}
        if ram_warning:
            result["ram_warning"] = ram_warning
        return result

    kb._models_loading = True

    def _do_load():
        try:
            result = kb.load_models()
            if not result.get("success"):
                log.error("[KB] 模型加载失败: embedder=%s reranker=%s",
                          result.get("embedder"), result.get("reranker"))
        except Exception as e:
            log.error("[KB] 模型加载异常: %s", str(e)[:200])
        finally:
            kb._models_loading = False

    import threading
    threading.Thread(target=_do_load, daemon=True).start()
    log.info("[KB] 模型加载已启动（后台线程）")
    result = {"ok": True, "loading": True}
    if ram_warning:
        result["ram_warning"] = ram_warning
    return result


# ============================================================
#  KB 文档管理
# ============================================================

@router.get("/api/kb/documents")
def api_kb_documents():
    """列出所有文库文档"""
    kb = get_kb()
    return kb.list_documents()


@router.post("/api/kb/upload")
async def api_kb_upload(file: UploadFile = File(...)):
    """上传文件到文库（异步处理+进度）"""
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check
    kb = get_kb()
    mgr = get_mgr()
    from config import get as _cfg_get
    _UPLOAD_MAX_SIZE = _cfg_get("upload_max_size")

    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)

    loaded = mgr.get_loaded_llms()
    if not loaded:
        return JSONResponse({"error": "请先在「设置」页面加载模型，文档处理需要模型支持"}, status_code=400)

    # 流式写入临时文件，避免全量读入内存
    import tempfile
    tmp_dir = tempfile.mkdtemp(prefix="kb_upload_")
    tmp_path = os.path.join(tmp_dir, _safe_filename(file.filename))
    _upload_size = 0
    try:
        try:
            import aiofiles
            async with aiofiles.open(tmp_path, "wb") as f:
                while True:
                    chunk = await file.read(1024 * 1024)  # 1MB chunks
                    if not chunk:
                        break
                    _upload_size += len(chunk)
                    if _upload_size > _UPLOAD_MAX_SIZE:
                        # 清理临时文件
                        shutil.rmtree(tmp_dir, ignore_errors=True)
                        return JSONResponse({"error": "文件过大（最大50MB）"}, status_code=400)
                    await f.write(chunk)
        except ImportError:
            # aiofiles 不可用，回退到全量读入
            # TODO: 安装 aiofiles 以支持流式写入
            content_bytes = await file.read()
            if len(content_bytes) > _UPLOAD_MAX_SIZE:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                return JSONResponse({"error": "文件过大（最大50MB）"}, status_code=400)
            _upload_size = len(content_bytes)
            with open(tmp_path, "wb") as f:
                f.write(content_bytes)
    except Exception as e:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        return JSONResponse({"error": "文件写入失败: %s" % str(e)[:200]}, status_code=400)

    content_bytes = None  # 释放内存
    # 后续处理从 tmp_path 读取文件
    _upload_text_path = tmp_path

    stats = kb.get_stats()
    if stats["ready_documents"] + stats["processing_documents"] >= stats["max_documents"]:
        return JSONResponse({"error": "文库已满（最多%d个文档）" % stats["max_documents"]}, status_code=400)

    ext = (file.filename or "").rsplit(".", 1)[-1].lower()
    text = ""
    image_count = 0  # 文档中检测到的图片数

    try:
        if ext in ("txt", "md", "csv"):
            with open(tmp_path, "r", encoding="utf-8", errors="replace") as f:
                text = f.read()
        elif ext == "docx":
            from files.doc_reader import DocReader
            reader = DocReader()
            text = reader.extract_text(tmp_path)
            image_count = reader.count_images(tmp_path)
        elif ext == "doc":
            return JSONResponse({"error": "不支持 .doc 旧格式，请用 Word 另存为 .docx 后重新上传"}, status_code=400)
        elif ext == "xlsx":
            import io
            try:
                import openpyxl
                with open(tmp_path, "rb") as f:
                    content_bytes = f.read()
                wb = openpyxl.load_workbook(io.BytesIO(content_bytes), read_only=True, data_only=True)
                for ws in wb.worksheets:
                    text += "## Sheet: " + (ws.title or "Sheet") + "\n"
                    for row in ws.iter_rows(max_row=200, values_only=True):
                        cells = [str(c) if c is not None else "" for c in row]
                        if any(cells):
                            text += " | ".join(cells) + "\n"
                    text += "\n"
                wb.close()
                content_bytes = None  # 释放内存
            except ImportError:
                return JSONResponse({"error": "Excel 解析失败：缺少 openpyxl"}, status_code=400)
        elif ext == "xls":
            return JSONResponse({"error": "不支持 .xls 旧格式，请用 Excel 另存为 .xlsx 后重新上传"}, status_code=400)
        elif ext == "pdf":
            try:
                try:
                    import pdfplumber
                    with pdfplumber.open(tmp_path) as pdf:
                        for i, page in enumerate(pdf.pages[:100]):
                            page_text = page.extract_text() or ""
                            if page_text:
                                text += page_text + "\n"
                            tables = page.extract_tables()
                            for table in tables:
                                for row in table:
                                    cells = [str(c) if c else "" for c in row]
                                    if any(cells):
                                        text += " | ".join(cells) + "\n"
                                text += "\n"
                            if page_text or tables:
                                text += "\n"
                except ImportError:
                    from pypdf import PdfReader
                    pdf = PdfReader(tmp_path)
                    for page in pdf.pages[:100]:
                        page_text = page.extract_text()
                        if page_text:
                            text += page_text + "\n\n"
            except ImportError:
                return JSONResponse({"error": "PDF 解析失败：缺少 pdfplumber 或 pypdf"}, status_code=400)
        else:
            return JSONResponse({"error": "不支持的文件格式: ." + ext}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": "文件解析出错: " + str(e)[:200]}, status_code=500)

    if not text.strip():
        return JSONResponse({"error": "文件内容为空或无法提取文字"}, status_code=400)

    result = kb.import_document(file.filename, text, file_type=ext,
                                metadata={"has_images": image_count > 0, "image_count": image_count})
    if "error" in result:
        return JSONResponse(result, status_code=400)

    doc_id = result["doc_id"]
    doc_text = text

    def _process():
        try:
            kb.process_document(doc_id, doc_text)
            # Patch3: 文档处理完成后 enqueue 打标（直接拿 kb 上挂的引用，不走 import server）
            scheduler = getattr(kb, '_tagging_scheduler', None)
            if scheduler:
                scheduler.enqueue(doc_id)
            else:
                log.warning("[KB] 打标调度器未就绪，文档将在重启后自动入队: doc_id=%s", doc_id)
        except Exception as e:
            log.error("[KB] 文档处理异常: doc_id=%s error=%s", doc_id, str(e)[:200])
            # 将文档标记为 error 状态，避免永久卡在 processing
            try:
                doc = kb.get_document(doc_id)
                if doc and doc.status == "processing":
                    doc.status = "error"
                    doc.error_msg = str(e)[:200]
                    kb._save_meta()
            except Exception:
                pass

    t = threading.Thread(target=_process, daemon=True)
    t.start()

    return {"ok": True, "doc_id": doc_id, "filename": file.filename,
            "size": _upload_size, "chars": len(text), "status": "processing",
            "has_images": image_count > 0, "image_count": image_count}


@router.get("/api/kb/tagging-status")
async def get_tagging_status(doc_id: str):
    """查询文档打标状态"""
    # 延迟导入，避免循环依赖
    import server as _srv
    scheduler = getattr(_srv, '_tagging_scheduler', None)
    if not scheduler:
        return {"status": "not_available"}
    return {"status": scheduler.get_status(doc_id)}


@router.post("/api/kb/retry-tagging/{doc_id}")
def retry_tagging(doc_id: str):
    """手动重试文档打标（tag_status=pending/failed 时可用）"""
    kb = get_kb()
    doc = kb.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "文档不存在"}, status_code=404)
    if doc.status != "ready":
        return JSONResponse({"error": "文档尚未处理完成"}, status_code=400)
    import server as _srv
    scheduler = getattr(_srv, '_tagging_scheduler', None) or getattr(kb, '_tagging_scheduler', None)
    if not scheduler:
        return JSONResponse({"error": "打标服务未启动（请重启应用）"}, status_code=503)
    doc.tag_status = "pending"
    doc._tag_retry_count = 0
    kb._save_meta()
    scheduler.enqueue(doc_id)
    return {"ok": True, "message": "已重新入队"}


@router.get("/api/kb/documents/{doc_id}/status")
def api_kb_doc_status(doc_id: str):
    """查询文档处理进度"""
    kb = get_kb()
    status = kb.get_document_status(doc_id)
    if not status:
        return JSONResponse({"error": "文档不存在"}, status_code=404)
    return status


@router.delete("/api/kb/documents/{doc_id}")
def api_kb_doc_delete(doc_id: str):
    """删除文库文档"""
    kb = get_kb()
    result = kb.delete_document(doc_id)
    if "error" in result:
        return JSONResponse(result, status_code=404)
    return result


@router.post("/api/kb/documents/{doc_id}/pause")
def api_kb_doc_pause(doc_id: str):
    """暂停文档处理"""
    kb = get_kb()
    kb.pause_processing(doc_id)
    return {"ok": True}


@router.post("/api/kb/documents/{doc_id}/resume")
def api_kb_doc_resume(doc_id: str):
    """恢复文档处理"""
    kb = get_kb()
    kb.resume_processing(doc_id)
    return {"ok": True}


@router.post("/api/kb/documents/{doc_id}/cancel")
def api_kb_doc_cancel(doc_id: str):
    """取消文档处理"""
    kb = get_kb()
    kb.cancel_processing(doc_id)
    return {"ok": True}


# (retry_summary 端点已移除 — LLM 摘要功能砍掉)


# ============================================================
#  KB 问答（SSE）
# ============================================================

@router.post("/api/kb/ask")
async def api_kb_ask(request: Request):
    """基于文库问答 — SSE 流式返回"""
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check
    kb = get_kb()
    mgr = get_mgr()
    body = await request.json()
    question = body.get("question", "").strip()
    session_id = body.get("session_id", "default").strip()
    if not question:
        async def _err():
            yield 'data: {"type":"error","content":"请输入问题"}\n\n'
            yield 'data: [DONE]\n\n'
        return StreamingResponse(_err(), media_type="text/event-stream")

    kb_history = _kb_sessions.get(session_id, [])
    # Patch3: 如果内存没找到，尝试从磁盘恢复
    if not kb_history:
        rounds = _kb_load_rounds(session_id)
        if rounds:
            kb_history = _kb_rounds_to_history(rounds)
            with _kb_sessions_lock:
                _kb_sessions[session_id] = kb_history

    async def sse_gen():
        import asyncio
        loop = asyncio.get_event_loop()

        yield 'data: {"type":"status","content":"🔍 正在检索文库..."}\n\n'

        # Patch3: 有历史时做 Reformulation，把追问补全为完整查询
        search_query = question
        if kb_history:
            try:
                from core.reformulate import reformulate_query
                search_query = await loop.run_in_executor(
                    None, lambda: reformulate_query(question, kb_history, mgr))
                if search_query != question:
                    log.info("[KB-SSE] Reformulated: '%s' → '%s'", question[:50], search_query[:50])
            except Exception as e:
                log.warning("[KB-SSE] Reformulate failed: %s, use original", str(e)[:60])

        max_prompt_tokens = mgr._get_device_token_limit()
        budget = mgr.calc_kb_context_budget()
        safe_chars = budget["safe_chars"]
        log.info("[KB-SSE] context 预算: device_tokens=%d, overhead=%d, safe_tokens=%d, safe_chars=%d",
                 budget["max_prompt_tokens"], budget["overhead_tokens"], budget["safe_tokens"], safe_chars)

        context, sources = await loop.run_in_executor(
            None, lambda: kb.get_context(search_query, max_chars=safe_chars))
        if not context:
            yield 'data: {"type":"token","content":"文库中未找到与问题相关的内容。"}\n\n'
            yield 'data: [DONE]\n\n'
            return

        kb_prompt = None  # will be set below
        try:
            from prompts import KB_USER_PROMPT_TEMPLATE
            kb_prompt = KB_USER_PROMPT_TEMPLATE.format(context=context, question=question)
        except (ImportError, KeyError):
            kb_prompt = (
                "根据【参考资料】回答问题。要求：\n"
                "1. 先给结论，再引用资料说明依据，在具体事实后标注来源编号，如「该技术的准确率为95.2% [1]」\n"
                "2. 完整复述原文的数字、时间和专有名词，不要省略\n"
                "3. 【最重要】参考资料中未提及的内容，必须明确说「参考资料中未提及」，绝对不要编造、猜测或引入外部知识\n"
                "4. 如果用户追问，结合之前的回答上下文作答；不要重复已回答过的内容\n"
                "5. 每个事实声明都必须有参考资料中的原文对应，没有原文支撑的内容不要输出\n\n"
                "【参考资料】\n%s\n\n"
                "问：%s\n答：" % (context, question)
            )
        chat_history = kb_history if kb_history else []

        yield 'data: {"type":"status","content":"✍️ 正在生成回答..."}\n\n'

        answer_parts = []
        _last_token_stats = None  # Patch3: 捕获 Ollama 真实 token 统计
        import queue
        chunk_queue = queue.Queue()

        def _run_stream():
            try:
                for chunk_type, chunk_text in mgr.chat_stream(
                    message=kb_prompt,
                    history=chat_history,
                    context_cache=None,
                    override_task_type="text",
                    kb_mode=True,
                ):
                    chunk_queue.put((chunk_type, chunk_text))
            except Exception as e:
                chunk_queue.put(("__error__", str(e)))
            finally:
                chunk_queue.put(None)

        stream_thread = threading.Thread(target=_run_stream, daemon=True)
        stream_thread.start()

        think_content = ""    # 思考内容（折叠展示）
        think_folded = False  # 是否已折叠思考
        raw_accumulator = ""  # 原始输出累积（用于 fallback）
        last_think_yield_len = 0  # 上次 yield think 事件时的 raw 长度
        _has_think_tag = False  # BUG-03: 跟踪是否出现过 <think 标签

        while True:
            item = await loop.run_in_executor(None, chunk_queue.get)
            if item is None:
                break
            chunk_type, chunk_text = item
            if chunk_type == "__error__":
                yield 'data: {"type":"error","content":"生成失败: %s"}\n\n' % json.dumps(chunk_text, ensure_ascii=False)[1:-1]
                break
            if chunk_type == "text":
                # 正文 token — 计入回答
                answer_parts.append(chunk_text)
                yield 'data: {"type":"token","content":%s}\n\n' % json.dumps(chunk_text, ensure_ascii=False)
            elif chunk_type == "raw":
                if not think_folded:
                    # 还没折叠思考 — raw 是思考阶段的输出，累积
                    raw_accumulator += chunk_text
                    # BUG-03: 检测 <think 标签是否存在
                    if not _has_think_tag and '<think' in raw_accumulator:
                        _has_think_tag = True
                    # BUG-03: 如果累积超过 300 字仍未检测到 <think 标签，视为正常回答
                    if not _has_think_tag and len(raw_accumulator) > 300:
                        think_folded = True
                        answer_parts.append(raw_accumulator)
                        yield 'data: {"type":"token","content":%s}\n\n' % json.dumps(raw_accumulator, ensure_ascii=False)
                    elif _has_think_tag:
                        # 有 think 标签 — 实时把思考内容发给前端（每 20 字发一次）
                        curr_len = len(raw_accumulator)
                        if curr_len - last_think_yield_len >= 20:
                            new_think = raw_accumulator[last_think_yield_len:curr_len]
                            last_think_yield_len = curr_len
                            yield 'data: {"type":"think","content":%s}\n\n' % json.dumps(new_think, ensure_ascii=False)
                    # else: 无 think 标签且 < 300 字 — 静默缓冲
                else:
                    # 思考已折叠后的 raw — 当正文处理
                    answer_parts.append(chunk_text)
                    yield 'data: {"type":"token","content":%s}\n\n' % json.dumps(chunk_text, ensure_ascii=False)
            elif chunk_type == "fold":
                # BUG-01: fold 前 flush 剩余思考内容，避免短思考丢失
                remaining = raw_accumulator[last_think_yield_len:]
                if remaining.strip():
                    yield 'data: {"type":"think","content":%s}\n\n' % json.dumps(remaining, ensure_ascii=False)
                    last_think_yield_len = len(raw_accumulator)
                # 思考折叠事件 — 通知前端显示折叠的思考过程
                think_content = chunk_text
                think_folded = True
                yield 'data: {"type":"fold","think_len":%d}\n\n' % len(think_content)
            elif chunk_type == "think_open":
                # think 标签未关闭 — 模型只输出了思考没有正文
                # BUG-01: flush 剩余思考内容
                remaining = raw_accumulator[last_think_yield_len:]
                if remaining.strip():
                    yield 'data: {"type":"think","content":%s}\n\n' % json.dumps(remaining, ensure_ascii=False)
                    last_think_yield_len = len(raw_accumulator)
                log.warning("[KB-SSE] think 未关闭，raw len=%d，告诉前端", chunk_text)
                think_folded = True  # 标记已处理，避免 fallback 重复提取
                yield 'data: {"type":"fold","think_len":%d}\n\n' % chunk_text
            elif chunk_type == "task_type":
                pass
            elif chunk_type == "token_stats":
                # Patch3: 捕获 Ollama 真实 token 统计，保存到 round 文件
                _last_token_stats = chunk_text

        # BUG-07: 流结束后，如果思考内容已发送但未折叠，强制发 fold 事件
        if not think_folded and last_think_yield_len > 0 and raw_accumulator:
            remaining = raw_accumulator[last_think_yield_len:]
            if remaining.strip():
                yield 'data: {"type":"think","content":%s}\n\n' % json.dumps(remaining, ensure_ascii=False)
                last_think_yield_len = len(raw_accumulator)
            think_content = raw_accumulator
            think_folded = True
            yield 'data: {"type":"fold","think_len":%d}\n\n' % len(raw_accumulator)

        answer = "".join(answer_parts).strip()

        # Fallback: 正文为空时统一委托 ThinkProcessor 提取
        if not answer and raw_accumulator:
            log.warning("[KB-SSE] 正文为空，raw 累积 %d 字，委托 ThinkProcessor 提取", len(raw_accumulator))
            log.debug("[KB-SSE] raw 前 200 字: %s", repr(raw_accumulator[:200]))
            try:
                from core.think_processor import ThinkProcessor
                _tp = ThinkProcessor()
                _body, _method = _tp.extract_body_from_raw(raw_accumulator)
                if _body:
                    answer = _body
                    log.info("[KB-SSE] ThinkProcessor 提取成功 (method=%s)，正文 %d 字", _method, len(answer))
                    yield 'data: {"type":"token","content":%s}\n\n' % json.dumps(answer, ensure_ascii=False)
                else:
                    if _method == "pure_reasoning":
                        # 高概率纯推理内容 → 标记为思考，输出提示
                        think_folded = True
                        think_content = re.sub(r'<[^>]+>', '', raw_accumulator).strip()
                        answer = "模型在思考过程中未生成最终答案，请重新提问或换个问法。"
                        yield 'data: {"type":"fold","think_len":%d}\n\n' % len(think_content)
                        yield 'data: {"type":"token","content":%s}\n\n' % json.dumps(answer, ensure_ascii=False)
                    else:
                        log.warning("[KB-SSE] ThinkProcessor 无法提取正文")
            except Exception as e:
                log.error("[KB-SSE] ThinkProcessor 提取失败: %s", str(e)[:100])

        if not answer and think_folded and think_content:
            # 思考吃掉了全部 token 预算，正文为空
            answer = "（模型思考过程过长，未生成回答正文。请尝试更简洁的问题。）"
            yield 'data: {"type":"token","content":%s}\n\n' % json.dumps(answer, ensure_ascii=False)

        if not answer:
            answer = "模型未生成回答。"

        source_list = [{
            "source_label": s["source_label"],
            "score": s["score"],
            "vector_score": s.get("vector_score", 0),
            "heading": s.get("heading", ""),
            "text_snippet": s.get("text_snippet", s.get("text", "")[:200].strip()),
            "doc_id": s.get("doc_id", ""),
        } for s in sources if s.get("index", 0) != -1]
        if source_list:
            yield 'data: {"type":"sources","content":%s}\n\n' % json.dumps(source_list, ensure_ascii=False)

        # Patch3: 构建 history（使用 answer+merge 双注入格式）
        round_num = _kb_get_next_round(session_id)
        _kb_save_round(session_id, round_num, question=question, answer=answer,
                       token_stats=_last_token_stats)
        
        # 更新内存 history（从 round 重建，确保格式一致）
        updated_rounds = _kb_load_rounds(session_id)
        kb_history_new = _kb_rounds_to_history(updated_rounds)
        with _kb_sessions_lock:
            _kb_sessions[session_id] = kb_history_new
            if len(_kb_sessions) > _KB_SESSION_MAX_COUNT:
                keys_to_remove = list(_kb_sessions.keys())[:len(_kb_sessions) // 2]
                for k in keys_to_remove:
                    del _kb_sessions[k]

        yield 'data: [DONE]\n\n'

    return StreamingResponse(sse_gen(), media_type="text/event-stream")


# ============================================================
#  KB 会话与检索
# ============================================================

@router.post("/api/kb/new_session")
async def api_kb_new_session(request: Request):
    """新建 KB 问答会话"""
    body = await request.json()
    session_id = body.get("session_id", "").strip()
    if session_id:
        if session_id in _kb_sessions:
            del _kb_sessions[session_id]
        _kb_delete_session(session_id)
    return {"ok": True}


@router.post("/api/kb/search")
async def api_kb_search(request: Request):
    """文库检索（仅返回结果不调用LLM）"""
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check
    kb = get_kb()
    body = await request.json()
    query = body.get("query", "").strip()
    top_k = body.get("top_k", 5)
    if not query:
        return JSONResponse({"error": "请输入查询"}, status_code=400)
    return {"results": kb.search(query, top_k=top_k)}


@router.post("/api/kb/import_text")
async def api_kb_import_text(request: Request):
    """直接导入文本到文库"""
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check
    kb = get_kb()
    body = await request.json()
    filename = body.get("filename", "文本导入")
    text = body.get("text", "").strip()
    source = body.get("source", "transcript")
    if not text:
        return JSONResponse({"error": "文本内容为空"}, status_code=400)

    result = kb.import_document(filename, text, file_type="txt", source=source)
    if "error" in result:
        return JSONResponse(result, status_code=400)

    doc_id = result["doc_id"]
    t = threading.Thread(target=lambda: kb.process_document(doc_id, text), daemon=True)
    t.start()

    return {"ok": True, "doc_id": doc_id, "status": "processing"}


# ============================================================
#  Patch3: KB 会话管理（导出 + 清空）
# ============================================================

@router.post("/api/kb/session/export")
async def api_kb_session_export(request: Request):
    """导出当前 KB 会话为纯文本（从 round 文件读取，更完整）"""
    body = await request.json()
    session_id = body.get("session_id", "").strip()
    if not session_id:
        return JSONResponse({"error": "会话不存在"}, status_code=404)

    # 优先从 round 文件读取（更完整，包含 merge_result）
    rounds = _kb_load_rounds(session_id)
    if not rounds:
        # 回退到内存
        history = _kb_sessions.get(session_id, [])
        if not history:
            return JSONResponse({"error": "对话为空"}, status_code=400)
        lines = []
        for msg in history:
            role = msg.get("role", "")
            content = msg.get("content", "")
            if role == "user":
                lines.append("用户: %s" % content)
            elif role == "assistant":
                lines.append("助手: %s" % content)
            lines.append("")
    else:
        lines = []
        for r in rounds:
            q = r.get("question", "")
            a = r.get("answer", "")
            merge = r.get("merge_result")
            if q:
                lines.append("用户: %s" % q)
            if merge:
                lines.append("助手（本地回答）: %s" % a)
                lines.append("助手（综合分析）: %s" % merge)
            elif a:
                lines.append("助手: %s" % a)
            lines.append("")

    text = "\n".join(lines)
    from fastapi.responses import Response
    return Response(
        content=text.encode("utf-8"),
        media_type="text/plain; charset=utf-8",
        headers={"Content-Disposition": "attachment; filename=kb_session_%s.txt" % session_id[-8:]},
    )


@router.post("/api/kb/session/clear")
async def api_kb_session_clear(request: Request):
    """清空当前 KB 会话历史"""
    body = await request.json()
    session_id = body.get("session_id", "").strip()
    if session_id:
        if session_id in _kb_sessions:
            del _kb_sessions[session_id]
        _kb_delete_session(session_id)
    return {"ok": True}


@router.get("/api/kb/session/context")
async def api_kb_session_context(session_id: str = "default"):
    """KB 会话独立上下文使用量（供文库 Tab 上下文指示器）

    优先使用 Ollama 返回的真实 token_stats（prompt_eval_count），
    回退到 chars/1.5 粗估。
    """
    # 从 round 文件读取（更准确，包含 token_stats）
    rounds = _kb_load_rounds(session_id)
    if rounds:
        # 优先使用真实 token_stats
        used_tokens = 0
        has_real_stats = False
        for r in rounds:
            ts = r.get("token_stats", {})
            if ts and ts.get("input_tokens"):
                used_tokens = max(used_tokens, ts["input_tokens"])
                has_real_stats = True
        if not has_real_stats:
            # 回退到 chars/1.5 估算
            total_chars = 0
            for r in rounds:
                total_chars += len(r.get("question", ""))
                a = r.get("answer", "")
                merge = r.get("merge_result", "")
                total_chars += len(a) + len(merge)
            used_tokens = int(total_chars / 1.5)
        turns = len(rounds)
    else:
        # 内存回退
        kb_history = _kb_sessions.get(session_id, [])
        total_chars = sum(len(msg.get("content", "")) for msg in kb_history)
        used_tokens = int(total_chars / 1.5)
        turns = len(kb_history) // 2

    # KB 模式的 token 上限（统一从 config 读取，与 Chat 一致）
    from config import MAX_INPUT_TOKENS
    budget_tokens = MAX_INPUT_TOKENS

    percentage = min(100, (used_tokens / budget_tokens * 100)) if budget_tokens > 0 else 0

    # level: normal(<60%), warning(60-80%), critical(80-95%), full(>95%)
    level = "normal"
    if percentage >= 95:
        level = "full"
    elif percentage >= 80:
        level = "critical"
    elif percentage >= 60:
        level = "warning"

    return {
        "used_tokens": used_tokens,
        "total_tokens": budget_tokens,
        "percentage": round(percentage, 1),
        "level": level,
        "turns": turns,
    }
