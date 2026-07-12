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

router = APIRouter()
log = get_log()


# ============================================================
#  扩展可用性检查
# ============================================================

def _get_extensions_dir() -> str:
    """获取扩展注册目录"""
    from config import EXTENSIONS_DIR
    return EXTENSIONS_DIR


def _check_knowledge_extension() -> Optional[JSONResponse]:
    """检查文库扩展是否已安装，未安装时返回错误响应

    Returns:
        None 如果已安装，否则返回 JSONResponse 错误
    """
    try:
        from core.extension_manager import ExtensionRegistry
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


def _extract_upload_text(tmp_path: str, ext: str):
    """从上传的临时文件提取文本（同步阻塞操作）

    Patch5 T05：从 api_kb_upload 中抽取，便于在线程池中执行，
    避免文件解析（pdfplumber/docx/openpyxl）阻塞 FastAPI 事件循环。

    Args:
        tmp_path: 临时文件路径
        ext: 文件扩展名（小写，不含点）

    Returns:
        tuple: (text, image_count)  — 提取的文本和图片计数
    """
    text = ""
    image_count = 0

    if ext in ("txt", "md", "csv"):
        with open(tmp_path, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()
    elif ext == "docx":
        from knowledge.doc_reader import DocReader
        reader = DocReader()
        text = reader.extract_text(tmp_path)
        image_count = reader.count_images(tmp_path)
    elif ext == "doc":
        # 旧格式由调用方处理（返回特殊标记）
        raise ValueError("不支持 .doc 旧格式，请用 Word 另存为 .docx 后重新上传")
    elif ext == "xlsx":
        import io
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
    elif ext == "xls":
        raise ValueError("不支持 .xls 旧格式，请用 Excel 另存为 .xlsx 后重新上传")
    elif ext == "pdf":
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
    elif ext == "epub":
        # B2: EPUB 电子书解析（委托给 file_extractor 统一逻辑）
        from knowledge.file_extractor import extract_text as _ext_text
        text = _ext_text(tmp_path)
    elif ext in ("html", "htm"):
        # B2: HTML 网页文件解析（委托给 file_extractor 统一逻辑）
        from knowledge.file_extractor import extract_text as _ext_text
        text = _ext_text(tmp_path)
    elif ext == "srt":
        # B2: SRT 字幕文件解析（委托给 file_extractor 统一逻辑）
        from knowledge.file_extractor import extract_text as _ext_text
        text = _ext_text(tmp_path)
    elif ext == "rtf":
        # B2: RTF 富文本解析（委托给 file_extractor 统一逻辑）
        from knowledge.file_extractor import extract_text as _ext_text
        text = _ext_text(tmp_path)
    else:
        raise ValueError("不支持的文件格式: ." + ext)

    return text, image_count


def _is_module_installed():
    """检查 KB 模块是否已安装（优先使用 ExtensionRegistry）"""
    try:
        from core.extension_manager import ExtensionRegistry
        from config import EXTENSIONS_DIR
        registry = ExtensionRegistry(EXTENSIONS_DIR)
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
    """检查 KB 模块依赖，结果在进程生命周期内缓存

    Patch5: rank_bm25/jieba 已移除（bge-m3 sparse 替代），不再检查。
    """
    global _dep_check_cache
    if _dep_check_cache is not None:
        return _dep_check_cache
    _dep_check_cache = {}
    for dep in ["numpy"]:
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


@router.get("/api/kb/diagnosis")
def api_kb_diagnosis():
    """检索健康度诊断（精简版：只保留用户可操作的 issue）"""
    kb = get_kb()
    result = {
        "doc_count": 0,
        "chunk_count": 0,
        "ready_docs": 0,
        "tagged_docs": 0,
        "vector_dim": 0,
        "health_score": 0,
        "issues": [],
    }
    try:
        docs = list(kb.documents.values())
        chunks = list(kb.chunks.values()) if hasattr(kb, 'chunks') else []
        result["doc_count"] = len(docs)
        result["chunk_count"] = len(chunks)
        result["ready_docs"] = sum(1 for d in docs if getattr(d, 'status', '') == 'ready')
        result["tagged_docs"] = sum(1 for d in docs if getattr(d, 'tags', None))

        # 向量维度（仅用于展示）
        if hasattr(kb, 'vectors') and kb.vectors is not None:
            try:
                result["vector_dim"] = int(kb.vectors.shape[1])
            except Exception:
                pass

        # 健康度评分（0-100）+ 问题检测（只保留可操作的 issue）
        score = 100
        issues = []
        if result["ready_docs"] < result["doc_count"]:
            score -= 20
            pending_ids = [d.doc_id for d in docs if getattr(d, 'status', '') != 'ready']
            issues.append({
                "level": "error",
                "msg": "%d 篇文档未就绪，无法参与检索" % (result["doc_count"] - result["ready_docs"]),
                "action": "resume_all",
                "doc_ids": pending_ids,
            })
        if result["doc_count"] > 0 and result["tagged_docs"] == 0:
            score -= 10
            untagged_ids = [d.doc_id for d in docs if not getattr(d, 'tags', None)]
            issues.append({
                "level": "info",
                "msg": "没有文档打标签，添加标签可提升分类检索",
                "action": "batch_retag",
                "doc_ids": untagged_ids,
            })
        if not issues:
            issues.append({"level": "ok", "msg": "知识库状态良好，无异常"})

        result["health_score"] = max(0, score)
        result["issues"] = issues
    except Exception as e:
        result["issues"] = [{"level": "error", "msg": "诊断失败: %s" % str(e)[:80]}]
    return result


@router.get("/api/kb/module-status")
def api_kb_module_status():
    """KB 模块安装状态（简化二态：installed + ready）"""
    kb = get_kb()
    installed = _is_module_installed()
    ready = installed and kb._embedder_loaded and kb.embedder.mode in ("bge", "flag_model")

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
    # Patch5 修复：兼容新格式（模型直接放在 models/embedding/ 而非 models/embedding/bge-m3/）
    embedder_path_flat = os.path.join(_project_dir, "models", "embedding")
    reranker_path_flat = os.path.join(_project_dir, "models", "reranker")

    def _has_model_weight(dir_path):
        """检查目录是否有任意一种模型权重文件"""
        return any(os.path.exists(os.path.join(dir_path, f)) for f in
                   ("model.safetensors", "pytorch_model.bin", "model.bin"))

    result["models"]["embedder"]["present"] = (
        (os.path.isdir(embedder_path) and
         os.path.exists(os.path.join(embedder_path, "config.json")))
        or
        (os.path.isdir(embedder_path_legacy) and
         os.path.exists(os.path.join(embedder_path_legacy, "config.json")))
        or
        # 扁平格式：config.json + 任意权重文件
        (os.path.isdir(embedder_path_flat) and
         os.path.exists(os.path.join(embedder_path_flat, "config.json")) and
         _has_model_weight(embedder_path_flat))
    )
    result["models"]["reranker"]["present"] = (
        (os.path.isdir(reranker_path) and
         os.path.exists(os.path.join(reranker_path, "config.json")))
        or
        (os.path.isdir(reranker_path_legacy) and
         os.path.exists(os.path.join(reranker_path_legacy, "config.json")))
        or
        # 扁平格式
        (os.path.isdir(reranker_path_flat) and
         os.path.exists(os.path.join(reranker_path_flat, "config.json")) and
         _has_model_weight(reranker_path_flat))
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

    # Patch5 T05: 文件解析是 CPU/IO 密集操作（pdfplumber/docx/openpyxl），
    # 放到线程池执行避免阻塞事件循环。
    import asyncio
    from core.thread_pool import get_thread_pool
    text = ""
    image_count = 0  # 文档中检测到的图片数

    try:
        text, image_count = await asyncio.get_event_loop().run_in_executor(
            get_thread_pool().executor,
            _extract_upload_text, tmp_path, ext
        )
    except ValueError as e:
        return JSONResponse({"error": str(e)[:200]}, status_code=400)
    except ImportError as e:
        return JSONResponse({"error": "依赖库缺失: %s" % str(e)[:120]}, status_code=400)
    except Exception as e:
        return JSONResponse({"error": "文件解析出错: " + str(e)[:200]}, status_code=500)

    if not text.strip():
        return JSONResponse({"error": "文件内容为空或无法提取文字"}, status_code=400)

    # B4: 去重检测（不阻塞导入，仅标记 metadata）
    duplicate_detected = False
    duplicate_info = None
    try:
        from core.dedup_detector import DedupDetector
        detector = DedupDetector(kb)
        dedup_result = detector.check_duplicate(tmp_path, text)
        if dedup_result.is_duplicate:
            duplicate_detected = True
            duplicate_info = {
                "existing_doc_id": dedup_result.existing_doc_id,
                "existing_filename": dedup_result.existing_filename,
                "level": dedup_result.level,
                "similarity": dedup_result.similarity,
            }
            log.info("[KB] 检测到重复文件: %s ↔ %s (level=%s, sim=%.2f)",
                     file.filename, dedup_result.existing_filename,
                     dedup_result.level, dedup_result.similarity)
    except Exception as e:
        log.warning("[KB] 去重检测异常（不影响导入）: %s", str(e)[:100])

    # 构建 metadata（含去重标记）
    import_meta = {"has_images": image_count > 0, "image_count": image_count}
    if duplicate_detected and duplicate_info:
        import_meta["duplicate_of"] = duplicate_info["existing_doc_id"]
        import_meta["duplicate_level"] = duplicate_info["level"]
        import_meta["duplicate_similarity"] = duplicate_info["similarity"]

    result = kb.import_document(file.filename, text, file_type=ext,
                                metadata=import_meta)
    if "error" in result:
        return JSONResponse(result, status_code=400)

    doc_id = result["doc_id"]
    doc_text = text

    # Patch5 G：注册 progress callback，前端通过 /api/kb/progress/{doc_id} 订阅
    try:
        kb.register_progress_callback(doc_id)
    except Exception:
        pass

    def _process():
        try:
            kb.process_document(doc_id, doc_text)
            # Patch5 G：取消"立即入队打标"——避免向量化 + LLM 打标同时抢 GPU
            # 改为由 TaggingScheduler 自己 gating（看 batch_queue 空闲才入队）
            scheduler = getattr(kb, '_tagging_scheduler', None)
            if scheduler:
                # 只注册到"待打标"清单，不立即入队
                try:
                    doc = kb.get_document(doc_id)
                    if doc:
                        doc.tag_status = "pending"
                        kb._save_meta()
                        # P6 审计修复 C5：等到所有其他文档都完成向量化（>=1 而非 >1）
                        # 注：当前文档自己 process_document 已完成，状态为 ready，不计入 active_count
                        # 使用 >= 1 等待所有其他活跃文档
                        import time as _time
                        _wait_count = 0
                        while kb.active_vectorization_count >= 1 and _wait_count < 600:
                            _time.sleep(1)
                            _wait_count += 1
                        if hasattr(scheduler, 'notify_doc_ready'):
                            scheduler.notify_doc_ready(doc_id)
                            log.info("[KB] doc_id=%s vectorization batch done (waited %ds), notified scheduler",
                                     doc_id, _wait_count)
                except Exception as _e:
                    log.warning("[KB] 标记 tag_status=pending 失败: %s", str(_e)[:80])
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

    # P6 打磨：重复文档不启动处理，暂停在队列中等待用户确认
    if duplicate_detected:
        doc = kb.get_document(doc_id)
        if doc:
            doc.status = "conflict"
            kb._save_meta()
        return {"ok": True, "doc_id": doc_id, "filename": file.filename,
                "size": _upload_size, "chars": len(text), "status": "conflict",
                "has_images": image_count > 0, "image_count": image_count,
                "duplicate_detected": True,
                "duplicate_info": duplicate_info}

    t = threading.Thread(target=_process, daemon=True)
    t.start()

    return {"ok": True, "doc_id": doc_id, "filename": file.filename,
            "size": _upload_size, "chars": len(text), "status": "processing",
            "has_images": image_count > 0, "image_count": image_count,
            "duplicate_detected": duplicate_detected,
            "duplicate_info": duplicate_info}


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


@router.post("/api/kb/documents/{doc_id}/reprocess")
def api_kb_doc_reprocess(doc_id: str):
    """重新处理文档（用于解决重复冲突后：向量化 + 打标）。
    conflict 状态的文档在上传时未启动 _process 线程，用户在冲突对话框
    选择「替换」后调用此端点，把文档从 conflict → processing 并真正处理。"""
    kb = get_kb()
    doc = kb.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "文档不存在"}, status_code=404)
    if doc.status not in ("conflict", "error"):
        return JSONResponse({"error": "仅冲突/失败文档可重新处理（当前状态: %s）" % doc.status}, status_code=400)

    # 文本：优先用已提取的 doc.text（上传时已提取存到 kb_texts/），无则报错
    text = getattr(doc, "text", "") or ""
    if not text:
        # 兜底：尝试从存储重新加载
        try:
            text = kb._load_text(doc_id) if hasattr(kb, "_load_text") else ""
        except Exception:
            text = ""
    if not text:
        return JSONResponse({"error": "无法重新处理：文档原文已丢失"}, status_code=400)

    import threading
    def _reprocess():
        try:
            doc.status = "processing"
            doc.error_msg = ""
            kb._save_meta()
            kb.process_document(doc_id, text)
            # 向量化完成后，注册到待打标（与上传流程一致）
            scheduler = getattr(kb, '_tagging_scheduler', None)
            if scheduler:
                d2 = kb.get_document(doc_id)
                if d2:
                    d2.tag_status = "pending"
                    kb._save_meta()
                    if hasattr(scheduler, 'notify_doc_ready'):
                        scheduler.notify_doc_ready(doc_id)
            else:
                log.warning("[KB] reprocess: 打标调度器未就绪，doc_id=%s", doc_id)
        except Exception as e:
            log.error("[KB] reprocess 异常: doc_id=%s error=%s", doc_id, str(e)[:200])
            try:
                d3 = kb.get_document(doc_id)
                if d3 and d3.status == "processing":
                    d3.status = "error"
                    d3.error_msg = str(e)[:200]
                    kb._save_meta()
            except Exception:
                pass

    threading.Thread(target=_reprocess, daemon=True).start()
    return {"ok": True, "message": "已开始重新处理"}


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

        yield 'data: {"type":"status","content":" 正在检索文库..."}\n\n'

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

        # P7: KB 问答使用独立的 kb_ai_mode（不受全局 ai_mode 影响）
        try:
            from config import get as _cfg
            kb_ai_mode = _cfg("kb_ai_mode", "local")
        except Exception:
            kb_ai_mode = "local"

        # P7: 本地 KB 模式前置检查——llama-server 未就绪时给友好提示
        if kb_ai_mode == "local":
            from server import ollama_manager
            if not ollama_manager.is_healthy():
                yield 'data: {"type":"token","content":"模型服务正在启动中，请稍候几秒后再试。"}\n\n'
                yield 'data: [DONE]\n\n'
                return

        max_prompt_tokens = mgr._get_device_token_limit()
        budget = mgr.calc_kb_context_budget()
        safe_chars = budget["safe_chars"]
        log.info("[KB-SSE] context 预算: kb_ai_mode=%s, device_tokens=%d, overhead=%d, safe_tokens=%d, safe_chars=%d",
                 kb_ai_mode, budget["max_prompt_tokens"], budget["overhead_tokens"], budget["safe_tokens"], safe_chars)

        context, sources = await loop.run_in_executor(
            None, lambda: kb.get_context(search_query, max_chars=safe_chars,
                                         ai_mode=kb_ai_mode,
                                         actor="local", access_type="kb_search"))
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

        yield 'data: {"type":"status","content":"️ 正在生成回答..."}\n\n'

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
    """文库检索（仅返回结果不调用LLM）

    Patch5 T03: 支持 token 参数进行私密文档过滤
    Body: {"query": "...", "top_k": 5, "token": "optional_access_token"}
    """
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check
    kb = get_kb()
    body = await request.json()
    query = body.get("query", "").strip()
    top_k = body.get("top_k", 5)
    token = body.get("token", "")  # Patch5 T03: 令牌参数
    if not query:
        return JSONResponse({"error": "请输入查询"}, status_code=400)
    # Patch4 v3.1：捕获异常返回结构化错误（之前 FastAPI 默默吞掉 500）
    try:
        # Patch5 T03: 私密文档过滤
        from core.access_token import get_access_token_manager
        token_mgr = get_access_token_manager()
        # 构建 is_private 映射
        is_private_map = {d.doc_id: getattr(d, 'is_private', False) for d in kb.documents.values()}
        # 获取可访问的文档 ID
        all_doc_ids = list(kb.documents.keys())
        accessible_doc_ids = set(token_mgr.filter_private_docs(all_doc_ids, token, is_private_map))

        results = kb.search(query, top_k=top_k, actor="user", access_type="kb_search")
        # 过滤掉不可访问的私密文档的 chunk
        results = [r for r in results if r.get("doc_id", "") in accessible_doc_ids]
        return {"results": results}
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        log.error("[KB] search 异常: %s\n%s", str(e), tb)
        return JSONResponse({"error": "检索失败: %s" % str(e)[:120], "traceback": tb[-500:]}, status_code=500)


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
#  Patch5 T02: 批量上传 + 任务队列
# ============================================================

def _get_batch_queue():
    """获取全局 BatchQueue 实例（从 server.py 模块变量）"""
    try:
        import server as _srv
        return getattr(_srv, '_batch_queue', None)
    except Exception:
        return None


@router.post("/api/kb/upload_batch")
async def api_kb_upload_batch(files: List[UploadFile] = File(...)):
    """批量上传文件到文库（Patch5 T02）

    多文件上传 → 流式写入临时文件 → 入队 SQLite → 异步处理
    前端通过轮询 GET /api/kb/batch/{batch_id}/progress 获取进度。

    Request: multipart/form-data
        files: 多个文件

    Response: 200
        {
            "batch_id": "b_xxx",
            "total_files": 50,
            "tasks": [{"task_id": "t_xxx", "filename": "...", "status": "pending"}, ...]
        }
    """
    ext_check = _check_knowledge_extension()
    if ext_check is not None:
        return ext_check

    bq = _get_batch_queue()
    if bq is None:
        return JSONResponse({"error": "批量上传服务未初始化（请重启应用）"}, status_code=503)

    kb = get_kb()
    mgr = get_mgr()
    from config import get as _cfg_get
    _UPLOAD_MAX_SIZE = _cfg_get("upload_max_size")

    # 检查 LLM 已加载（打标需要）
    loaded = mgr.get_loaded_llms()
    if not loaded:
        return JSONResponse({"error": "请先在「设置」页面加载模型，文档处理需要模型支持"}, status_code=400)

    if not files:
        return JSONResponse({"error": "未选择文件"}, status_code=400)

    # 检查文档数上限
    stats = kb.get_stats()
    available_slots = stats["max_documents"] - stats["ready_documents"] - stats["processing_documents"]
    if available_slots <= 0:
        return JSONResponse({"error": "文库已满（最多%d个文档）" % stats["max_documents"]}, status_code=400)

    if len(files) > available_slots:
        return JSONResponse({
            "error": "文件数 %d 超过文库剩余容量 %d" % (len(files), available_slots)
        }, status_code=400)

    # 创建批次
    batch_id = bq.create_batch(total_files=len(files))

    # 逐个文件流式写入临时目录 + 入队
    import tempfile
    _batch_tmp_dir = tempfile.mkdtemp(prefix="kb_batch_")
    tasks_info = []
    enqueued_count = 0

    for upload_file in files:
        if not upload_file.filename:
            continue

        filename = _safe_filename(upload_file.filename)
        ext = (upload_file.filename or "").rsplit(".", 1)[-1].lower()

        # 支持格式检查（B2: 新增 epub/html/srt/rtf）
        if ext not in ("txt", "md", "csv", "docx", "xlsx", "pdf",
                        "epub", "html", "htm", "srt", "rtf"):
            tasks_info.append({
                "task_id": "",
                "filename": upload_file.filename,
                "status": "error",
                "error_msg": "不支持的文件格式: .%s" % ext,
            })
            continue

        # 每个文件单独的临时子目录（便于后续清理）
        file_tmp_dir = tempfile.mkdtemp(prefix="kb_upload_", dir=_batch_tmp_dir)
        tmp_path = os.path.join(file_tmp_dir, filename)

        # 流式写入
        _upload_size = 0
        _size_exceeded = False
        try:
            try:
                import aiofiles
                async with aiofiles.open(tmp_path, "wb") as f:
                    while True:
                        chunk = await upload_file.read(1024 * 1024)
                        if not chunk:
                            break
                        _upload_size += len(chunk)
                        if _upload_size > _UPLOAD_MAX_SIZE:
                            _size_exceeded = True
                            break
                        await f.write(chunk)
            except ImportError:
                content_bytes = await upload_file.read()
                if len(content_bytes) > _UPLOAD_MAX_SIZE:
                    _size_exceeded = True
                else:
                    _upload_size = len(content_bytes)
                    with open(tmp_path, "wb") as f:
                        f.write(content_bytes)

            if _size_exceeded:
                shutil.rmtree(file_tmp_dir, ignore_errors=True)
                tasks_info.append({
                    "task_id": "",
                    "filename": upload_file.filename,
                    "status": "error",
                    "error_msg": "文件过大（最大%dMB）" % (_UPLOAD_MAX_SIZE // 1024 // 1024),
                })
                continue

            # 入队
            task_id = bq.enqueue(
                batch_id=batch_id,
                file_path=tmp_path,
                filename=upload_file.filename,
                file_type=ext,
                file_size=_upload_size,
            )
            tasks_info.append({
                "task_id": task_id,
                "filename": upload_file.filename,
                "status": "pending",
            })
            enqueued_count += 1

        except Exception as e:
            shutil.rmtree(file_tmp_dir, ignore_errors=True)
            tasks_info.append({
                "task_id": "",
                "filename": upload_file.filename,
                "status": "error",
                "error_msg": "文件写入失败: %s" % str(e)[:100],
            })

    log.info("[KB] 批量上传: batch=%s, 入队 %d/%d 文件", batch_id, enqueued_count, len(files))

    return {
        "batch_id": batch_id,
        "total_files": enqueued_count,
        "tasks": tasks_info,
    }


@router.get("/api/kb/batch/{batch_id}/progress")
async def api_kb_batch_progress(batch_id: str):
    """查询批次导入进度（Patch5 T02）

    前端轮询此端点（建议 2 秒间隔）获取批量上传的处理进度。
    """
    bq = _get_batch_queue()
    if bq is None:
        return JSONResponse({"error": "批量上传服务未初始化"}, status_code=503)
    progress = bq.get_batch_progress(batch_id)
    if "error" in progress:
        return JSONResponse(progress, status_code=404)
    return progress


@router.post("/api/kb/batch/{batch_id}/cancel")
async def api_kb_batch_cancel(batch_id: str):
    """取消批次中未处理的任务（Patch5 T02）

    将所有 pending 状态的任务标记为 cancelled。
    正在 processing 的任务不受影响（会继续完成）。
    """
    bq = _get_batch_queue()
    if bq is None:
        return JSONResponse({"error": "批量上传服务未初始化"}, status_code=503)
    cancelled = bq.cancel_batch(batch_id)
    return {"cancelled": cancelled}


@router.get("/api/kb/batch/active")
async def api_kb_batch_active():
    """获取所有活跃批次列表（Patch5 T02）"""
    bq = _get_batch_queue()
    if bq is None:
        return JSONResponse({"error": "批量上传服务未初始化"}, status_code=503)
    batches = bq.get_active_batches()
    return {"batches": batches}


# ============================================================
#  Patch5 T03: 令牌管理 + 私密文档设置
# ============================================================

@router.post("/api/kb/documents/{doc_id}/token")
async def api_kb_generate_token(doc_id: str, request: Request):
    """为文档生成访问令牌（Patch5 T03）

    Body: {"level": "full" | "search", "session_id": "optional_session_id"}
    Response: {"token": "a1b2c3...", "doc_id": "...", "level": "...", "session_id": "..."}
    """
    kb = get_kb()
    doc = kb.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "文档不存在"}, status_code=404)

    body = await request.json()
    level = body.get("level", "search")
    if level not in ("full", "search"):
        return JSONResponse({"error": "level 必须为 full 或 search"}, status_code=400)

    session_id = body.get("session_id", "") or ""

    from core.access_token import get_access_token_manager
    mgr = get_access_token_manager()
    if level == "full":
        token = mgr.generate_full_token(doc_id, session_id=session_id)
    else:
        token = mgr.generate_search_token(doc_id, session_id=session_id)

    return {"token": token, "doc_id": doc_id, "level": level, "session_id": session_id}


@router.delete("/api/kb/documents/{doc_id}/token")
async def api_kb_revoke_token(doc_id: str):
    """撤销文档的所有访问令牌（Patch5 T03）

    Response: {"revoked": true, "count": N}
    """
    kb = get_kb()
    doc = kb.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "文档不存在"}, status_code=404)

    from core.access_token import get_access_token_manager
    mgr = get_access_token_manager()
    count = mgr.revoke_doc_tokens(doc_id)
    return {"revoked": True, "count": count}


@router.get("/api/kb/tokens")
async def api_kb_list_tokens():
    """列出所有活跃令牌（P6 令牌管理）

    Response: {"tokens": [{"doc_id": "...", "level": "...", "session_id": "...", "created_at": N}, ...]}
    """
    from core.access_token import get_access_token_manager
    mgr = get_access_token_manager()
    tokens = mgr.list_tokens()
    return {"tokens": tokens}


@router.post("/api/kb/tokens/revoke_by_session")
async def api_kb_revoke_tokens_by_session(request: Request):
    """撤销某会话的所有令牌（P6 令牌管理）

    Body: {"session_id": "session_abc"}
    Response: {"revoked": N}
    """
    body = await request.json()
    session_id = body.get("session_id", "")
    if not session_id:
        return JSONResponse({"error": "session_id 不能为空"}, status_code=400)

    from core.access_token import get_access_token_manager
    mgr = get_access_token_manager()
    count = mgr.revoke_all_for_session(session_id)
    return {"revoked": count}


@router.post("/api/kb/documents/{doc_id}/privacy")
async def api_kb_set_privacy(doc_id: str, request: Request):
    """设置文档私密标记（Patch5 T03）

    Body: {"is_private": true}
    Response: {"doc_id": "...", "is_private": true}
    """
    kb = get_kb()
    doc = kb.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "文档不存在"}, status_code=404)

    body = await request.json()
    # P5 审计修复 P1-8: batch_privacy bool 陷阱 — JSON 字符串 "false"/"0" 会被 bool() 误判为 True
    _is_private_raw = body.get("is_private", False)
    is_private = _is_private_raw if isinstance(_is_private_raw, bool) else (str(_is_private_raw).lower() == "true")

    # 设置 is_private 并持久化
    doc.is_private = is_private
    kb._save_meta()

    # 撤销私密文档的现有令牌（取消私密时清空令牌）
    if not is_private:
        from core.access_token import get_access_token_manager
        get_access_token_manager().revoke_doc_tokens(doc_id)

    log.info("[KB] 文档私密标记设置: doc=%s, is_private=%s", doc_id, is_private)
    return {"doc_id": doc_id, "is_private": is_private}


# ============================================================
#  Patch5 B1: 批量操作 API（批量删除/重标/设私密）
# ============================================================

# 批量操作上限
_BATCH_MAX_ITEMS = 50


@router.post("/api/kb/documents/batch_delete")
async def api_kb_batch_delete(request: Request):
    """批量删除文档（B1）

    Body: {"doc_ids": ["doc_xxx", ...]}
    Response: {"success": true, "deleted": N, "failed": [{"doc_id": "...", "error": "..."}]}
    """
    kb = get_kb()
    body = await request.json()
    doc_ids = body.get("doc_ids", [])
    if not doc_ids:
        return JSONResponse({"error": "doc_ids 不能为空"}, status_code=400)
    if len(doc_ids) > _BATCH_MAX_ITEMS:
        return JSONResponse({"error": "批量操作上限 %d 个文档" % _BATCH_MAX_ITEMS}, status_code=400)

    deleted = 0
    failed = []
    for doc_id in doc_ids:
        try:
            result = kb.delete_document(doc_id)
            if "error" in result:
                failed.append({"doc_id": doc_id, "error": result["error"]})
            else:
                deleted += 1
        except Exception as e:
            failed.append({"doc_id": doc_id, "error": str(e)[:100]})

    log.info("[KB] 批量删除: 成功 %d, 失败 %d", deleted, len(failed))
    return {"success": True, "deleted": deleted, "failed": failed}


@router.post("/api/kb/documents/batch_retag")
async def api_kb_batch_retag(request: Request):
    """批量重新打标（B1）

    Body: {"doc_ids": ["doc_xxx", ...]}
    Response: {"success": true, "affected": N, "failed": [...]}
    """
    kb = get_kb()
    body = await request.json()
    doc_ids = body.get("doc_ids", [])
    if not doc_ids:
        return JSONResponse({"error": "doc_ids 不能为空"}, status_code=400)
    if len(doc_ids) > _BATCH_MAX_ITEMS:
        return JSONResponse({"error": "批量操作上限 %d 个文档" % _BATCH_MAX_ITEMS}, status_code=400)

    # 获取打标调度器
    import server as _srv
    scheduler = getattr(_srv, '_tagging_scheduler', None) or getattr(kb, '_tagging_scheduler', None)
    if not scheduler:
        return JSONResponse({"error": "打标服务未启动（请重启应用）"}, status_code=503)

    affected = 0
    failed = []
    for doc_id in doc_ids:
        try:
            doc = kb.get_document(doc_id)
            if not doc:
                failed.append({"doc_id": doc_id, "error": "文档不存在"})
                continue
            if doc.status != "ready":
                failed.append({"doc_id": doc_id, "error": "文档尚未处理完成"})
                continue
            doc.tag_status = "pending"
            scheduler.enqueue(doc_id)
            affected += 1
        except Exception as e:
            failed.append({"doc_id": doc_id, "error": str(e)[:100]})

    # 批量设置后统一保存一次 meta（减少 IO）
    if affected > 0:
        kb._save_meta()

    log.info("[KB] 批量重标: 成功 %d, 失败 %d", affected, len(failed))
    return {"success": True, "affected": affected, "failed": failed}


@router.post("/api/kb/documents/batch_privacy")
async def api_kb_batch_privacy(request: Request):
    """批量设置文档私密标记（B1/B3）

    Body: {"doc_ids": ["doc_xxx", ...], "is_private": true}
    Response: {"success": true, "affected": N, "failed": [...]}
    """
    kb = get_kb()
    body = await request.json()
    doc_ids = body.get("doc_ids", [])
    # P5 审计修复 P1-8: batch_privacy bool 陷阱
    _is_private_raw = body.get("is_private", False)
    is_private = _is_private_raw if isinstance(_is_private_raw, bool) else (str(_is_private_raw).lower() == "true")
    if not doc_ids:
        return JSONResponse({"error": "doc_ids 不能为空"}, status_code=400)
    if len(doc_ids) > _BATCH_MAX_ITEMS:
        return JSONResponse({"error": "批量操作上限 %d 个文档" % _BATCH_MAX_ITEMS}, status_code=400)

    affected = 0
    failed = []
    for doc_id in doc_ids:
        try:
            doc = kb.get_document(doc_id)
            if not doc:
                failed.append({"doc_id": doc_id, "error": "文档不存在"})
                continue
            doc.is_private = is_private
            affected += 1
            # 取消私密时清空令牌
            if not is_private:
                try:
                    from core.access_token import get_access_token_manager
                    get_access_token_manager().revoke_doc_tokens(doc_id)
                except Exception:
                    pass
        except Exception as e:
            failed.append({"doc_id": doc_id, "error": str(e)[:100]})

    # 批量设置后统一保存一次 meta（减少 IO）
    if affected > 0:
        kb._save_meta()

    log.info("[KB] 批量设私密: is_private=%s, 成功 %d, 失败 %d", is_private, affected, len(failed))
    return {"success": True, "affected": affected, "failed": failed}


# ============================================================
#  Patch5 B1: 检索热力图 API
# ============================================================

@router.get("/api/kb/search_heatmap")
def api_kb_search_heatmap():
    """获取检索热力图数据（B1）

    返回所有文档的 hit_count，按降序排列。

    Response: {"heatmap": [{"doc_id": "...", "filename": "...", "hit_count": N}, ...]}
    """
    kb = get_kb()
    heatmap = []
    for doc in kb.documents.values():
        heatmap.append({
            "doc_id": doc.doc_id,
            "filename": doc.filename,
            "hit_count": getattr(doc, "hit_count", 0),
        })
    # 按 hit_count 降序
    heatmap.sort(key=lambda x: x["hit_count"], reverse=True)
    return {"heatmap": heatmap}


@router.post("/api/kb/search_heatmap/reset")
def api_kb_search_heatmap_reset():
    """重置检索热力图（B1）

    遍历所有文档，将 hit_count 设为 0。

    Response: {"ok": true, "reset_count": N}
    """
    kb = get_kb()
    reset_count = 0
    for doc in kb.documents.values():
        if getattr(doc, "hit_count", 0) > 0:
            doc.hit_count = 0
            reset_count += 1
    kb._save_meta()
    log.info("[KB] 热力图重置: 重置 %d 个文档", reset_count)
    return {"ok": True, "reset_count": reset_count}


# ===== P7-4b: 文档审计日志 =====

@router.get("/api/kb/documents/{doc_id}/audit_log")
def api_kb_audit_log(doc_id: str):
    """获取指定文档的审计日志（P7-4b）

    Response: {"doc_id": "...", "logs": [{timestamp, access_type, actor, query, matched_text, reranker_score}, ...]}
    日志倒序（最新在前），最多 200 条。
    """
    kb = get_kb()
    doc = kb.documents.get(doc_id)
    if not doc:
        return {"error": "文档不存在", "doc_id": doc_id}
    logs = kb.get_audit_log(doc_id)
    return {"doc_id": doc_id, "filename": doc.filename, "logs": logs}


@router.post("/api/kb/audit_log/clear_all")
def api_kb_audit_log_clear_all():
    """清除所有文档的审计日志（P7-4b）

    Response: {"ok": true}
    """
    kb = get_kb()
    kb.clear_audit_log()
    log.info("[KB] 审计日志已全部清除")
    return {"ok": True}


@router.get("/api/kb/audit_log/stats")
def api_kb_audit_log_stats():
    """审计日志统计（P7-4b）— 供设置页显示占用情况

    Response: {"total_entries": N, "total_files": N, "total_size_kb": N}
    """
    import os as _os
    kb = get_kb()
    _audit_dir = _os.path.join(kb.data_dir, "audit_logs")
    if not _os.path.isdir(_audit_dir):
        return {"total_entries": 0, "total_files": 0, "total_size_kb": 0}
    _total_size = 0
    _total_entries = 0
    _files = 0
    try:
        for _fn in _os.listdir(_audit_dir):
            if not _fn.endswith(".json"):
                continue
            _files += 1
            _fp = _os.path.join(_audit_dir, _fn)
            _total_size += _os.path.getsize(_fp)
            try:
                with open(_fp, "r", encoding="utf-8") as _f:
                    _data = json.load(_f)
                    if isinstance(_data, list):
                        _total_entries += len(_data)
            except Exception:
                pass
    except Exception as e:
        log.warning("[KB] 审计日志统计失败: %s", e)
    return {
        "total_entries": _total_entries,
        "total_files": _files,
        "total_size_kb": round(_total_size / 1024, 1),
    }


@router.post("/api/kb/reset")
async def api_kb_reset(request: Request):
    """重置知识库（清空所有导入数据，不删功能）

    Body: {"confirm": true}   ← 必须显式确认，防误触
    Response: {"ok": true, "deleted_docs": N, "deleted_chunks": N}
    """
    kb = get_kb()
    body = await request.json()
    if not body.get("confirm"):
        return JSONResponse({"error": "请确认操作（confirm: true）"}, status_code=400)
    result = kb.reset_all()
    if not result.get("ok"):
        return JSONResponse({"error": result.get("error", "重置失败")}, status_code=500)
    log.info("[KB] 知识库重置完成: 删除 %d 篇文档, %d 个片段",
             result.get("deleted_docs", 0), result.get("deleted_chunks", 0))
    return result


# ============================================================
#  Patch5 B4: 去重检测 API
# ============================================================

@router.get("/api/kb/duplicates")
def api_kb_duplicates():
    """获取待处理的重复文档列表（B4）

    返回 metadata.duplicate_of 非空的文档。

    Response: {"duplicates": [{"doc_id", "filename", "duplicate_of", "duplicate_level", "duplicate_similarity", "existing_filename"}, ...]}
    """
    kb = get_kb()
    duplicates = []
    for doc in kb.documents.values():
        meta = getattr(doc, "metadata", {}) or {}
        dup_of = meta.get("duplicate_of", "")
        if dup_of:
            existing_doc = kb.get_document(dup_of)
            existing_filename = existing_doc.filename if existing_doc else "（已删除）"
            duplicates.append({
                "doc_id": doc.doc_id,
                "filename": doc.filename,
                "duplicate_of": dup_of,
                "existing_filename": existing_filename,
                "duplicate_level": meta.get("duplicate_level", "unknown"),
                "duplicate_similarity": meta.get("duplicate_similarity", 0.0),
            })
    return {"duplicates": duplicates}


@router.post("/api/kb/duplicates/resolve")
async def api_kb_duplicates_resolve(request: Request):
    """解决重复冲突（B4）

    Body: {"doc_id": "doc_xxx", "action": "keep_both" | "replace" | "cancel"}
    - keep_both: 保留两版，清除重复标记
    - replace: 删除旧文档，保留新文档，清除标记
    - cancel: 删除新文档，保留旧文档

    Response: {"ok": true, "action": "...", "detail": "..."}
    """
    kb = get_kb()
    body = await request.json()
    doc_id = body.get("doc_id", "").strip()
    action = body.get("action", "").strip()

    if not doc_id:
        return JSONResponse({"error": "doc_id 不能为空"}, status_code=400)
    if action not in ("keep_both", "replace", "cancel"):
        return JSONResponse({"error": "action 必须为 keep_both / replace / cancel"}, status_code=400)

    doc = kb.get_document(doc_id)
    if not doc:
        return JSONResponse({"error": "文档不存在"}, status_code=404)

    meta = getattr(doc, "metadata", {}) or {}
    existing_doc_id = meta.get("duplicate_of", "")
    if not existing_doc_id:
        return JSONResponse({"error": "该文档无重复标记"}, status_code=400)

    if action == "keep_both":
        # 保留两版，清除重复标记
        doc.metadata.pop("duplicate_of", None)
        doc.metadata.pop("duplicate_level", None)
        doc.metadata.pop("duplicate_similarity", None)
        kb._save_meta()
        log.info("[KB] 去重处理(保留两版): doc=%s", doc_id)
        return {"ok": True, "action": "keep_both", "detail": "已保留两版，清除重复标记"}

    elif action == "replace":
        # 删除旧文档，保留新文档
        try:
            kb.delete_document(existing_doc_id)
        except Exception as e:
            return JSONResponse({"error": "删除旧文档失败: %s" % str(e)[:100]}, status_code=500)
        # 清除新文档的重复标记
        doc.metadata.pop("duplicate_of", None)
        doc.metadata.pop("duplicate_level", None)
        doc.metadata.pop("duplicate_similarity", None)
        kb._save_meta()
        log.info("[KB] 去重处理(替换旧版): 新文档=%s, 旧文档=%s 已删除", doc_id, existing_doc_id)
        return {"ok": True, "action": "replace", "detail": "旧文档已删除，新文档已保留"}

    else:  # cancel
        # 删除新文档，保留旧文档
        try:
            kb.delete_document(doc_id)
        except Exception as e:
            return JSONResponse({"error": "删除新文档失败: %s" % str(e)[:100]}, status_code=500)
        log.info("[KB] 去重处理(取消新版): 新文档=%s 已删除, 旧文档=%s 保留", doc_id, existing_doc_id)
        return {"ok": True, "action": "cancel", "detail": "新文档已删除，旧文档已保留"}


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


# ============================================================
#  Patch5 G：KB 文档处理进度 SSE
# ============================================================

@router.get("/api/kb/progress/{doc_id}")
async def api_kb_progress_sse(doc_id: str):
    """文档处理进度实时推送（SSE）

    客户端用 EventSource 订阅，事件格式：
      data: {"phase": "chunking_done|embedding|done|error", "progress": 0.5,
             "chunk_total": 12, "chunk_done": 6, "batch_idx": 1, "batch_total": 3}
    """
    import json as _json
    kb = get_kb()
    queue = kb.get_progress_queue(doc_id)
    if queue is None:
        # 没注册过，立即返回当前状态
        doc = kb.get_document(doc_id)
        if not doc:
            return JSONResponse({"error": "文档不存在"}, status_code=404)
        return JSONResponse({"phase": "unknown", "progress": doc.progress,
                            "status": doc.status})

    async def sse_gen():
        try:
            # 先推一个起始事件
            doc = kb.get_document(doc_id)
            start_ev = {
                "phase": "subscribed",
                "progress": doc.progress if doc else 0,
                "status": doc.status if doc else "unknown",
            }
            yield "data: %s\n\n" % _json.dumps(start_ev, ensure_ascii=False)

            import asyncio
            timeout_counter = 0
            while True:
                try:
                    ev = queue.get_nowait()
                    yield "data: %s\n\n" % _json.dumps(ev, ensure_ascii=False)
                    if ev.get("phase") in ("done", "error"):
                        break
                except Exception:
                    # 队列空，sleep 一会
                    await asyncio.sleep(0.5)
                    timeout_counter += 1
                    # 兜底：60s 无事件自动断开
                    if timeout_counter > 120:
                        yield "data: %s\n\n" % _json.dumps({"phase": "timeout"})
                        break
                    # 检查文档是否已 ready（兜底退出条件）
                    if timeout_counter % 4 == 0:
                        cur_doc = kb.get_document(doc_id)
                        if cur_doc and cur_doc.status in ("ready", "error", "cancelled"):
                            yield "data: %s\n\n" % _json.dumps({
                                "phase": "done" if cur_doc.status == "ready" else "error",
                                "progress": cur_doc.progress,
                                "status": cur_doc.status,
                            })
                            break
        finally:
            kb.cleanup_progress_callback(doc_id)

    return StreamingResponse(sse_gen(), media_type="text/event-stream")


# ============================================================
#  标签分组（LLM 语义归并）
# ============================================================

def _collect_all_tags(kb) -> list:
    """收集所有文档的唯一标签"""
    tags = set()
    for doc in kb.documents.values():
        if getattr(doc, "tags", None):
            for t in doc.tags:
                t = t.strip()
                if t:
                    tags.add(t)
    return sorted(tags)


def _parse_llm_groups(raw_text: str, all_tags: list) -> list:
    """解析 LLM 输出的分组 JSON，失败回退到「其他」分组

    Args:
        raw_text: LLM 原始输出文本
        all_tags: 需要分组的标签列表

    Returns:
        [{"group": "组名", "members": ["标签1", "标签2"]}, ...]
    """
    import re as _re

    text = raw_text.strip()

    # 1. 尝试提取 ```json ... ``` 代码块
    m = _re.search(r'```(?:json)?\s*([\s\S]*?)```', text)
    if m:
        text = m.group(1).strip()

    # 2. 提取所有 {"group": ..., "members": [...]} 对象（非贪婪，防止跨数组污染）
    objs = _re.findall(
        r'\{[^{}]*"group"\s*:\s*"[^"]*"[^{}]*"members"\s*:\s*\[[^\]]*\][^{}]*\}',
        text
    )
    if objs:
        text = '[' + ','.join(objs) + ']'

    # 3. 解析 JSON 并验证每个条目结构
    try:
        groups = json.loads(text)
        if isinstance(groups, list):
            valid = []
            for item in groups:
                if not isinstance(item, dict):
                    continue
                if "group" not in item or "members" not in item:
                    continue
                if not isinstance(item["members"], list):
                    continue
                valid.append(item)
            if valid:
                return valid
    except json.JSONDecodeError:
        pass

    # 4. 部分提取：尝试逐行匹配 {"group":... 格式
    partial_groups = []
    for match in _re.finditer(r'\{[^}]*"group"\s*:\s*"([^"]+)"[^}]*"members"\s*:\s*\[([^\]]*)\][^}]*\}', text):
        group_name = match.group(1)
        members_str = match.group(2)
        members = [t.strip().strip('"').strip("'") for t in members_str.split(",") if t.strip()]
        if group_name and members:
            partial_groups.append({"group": group_name, "members": members})

    if partial_groups:
        log.warning("[KB-TAGS] JSON 完整解析失败，部分提取 %d 组", len(partial_groups))
        return partial_groups

    # 5. 完全失败 → 全部放入「其他」
    log.warning("[KB-TAGS] 无法解析 LLM 输出，回退到「其他」分组")
    return [{"group": "其他", "members": list(all_tags)}]


@router.post("/api/kb/tags/group")
async def api_kb_tags_group(request: Request):
    """触发 LLM 语义分组（不覆盖 source:"manual" 标签）

    流程:
    1. 收集所有文档的唯一标签
    2. 过滤掉 source:"manual" 的标签
    3. 调用本地 LLM 分组
    4. 保存分组到 kb_meta.json (source:"ai")
    5. 返回分组结果
    """
    kb = get_kb()
    mgr = get_mgr()

    # 检查 LLM 已加载
    loaded = mgr.get_loaded_llms()
    if not loaded:
        return JSONResponse(
            {"error": "请先在「设置」页面加载模型，标签分组需要模型支持"},
            status_code=503
        )

    # 收集所有标签
    all_tags = _collect_all_tags(kb)
    if not all_tags:
        return {"groups": [], "ungrouped": []}

    # 过滤掉 source:"manual" 的标签（不覆盖手动锁定的）
    manual_tags = set()
    for g in kb.tag_groups:
        if g.get("source") == "manual":
            for m in g.get("members", []):
                manual_tags.add(m)

    tags_to_group = [t for t in all_tags if t not in manual_tags]
    if not tags_to_group:
        # 所有标签都是 manual，直接返回现有分组
        return _build_groups_response(kb, all_tags)

    # 构建 prompt
    tags_str = json.dumps(tags_to_group, ensure_ascii=False)
    prompt = (
        "将以下标签按语义归并为5-10组。每个标签必须属于一个组。"
        "输出JSON数组: [{\"group\":\"组名\",\"members\":[\"标签1\",\"标签2\"]}]。"
        "只输出JSON，不要任何解释。\n\n标签: " + tags_str
    )

    log.info("[KB-TAGS] 开始 LLM 分组: %d 标签（已排除 %d 个 manual）",
             len(tags_to_group), len(manual_tags))

    try:
        from core.thread_pool import get_thread_pool
        import asyncio

        def _call_llm():
            return mgr.chat(prompt, max_tokens=1024, _priority="LOW")

        result = await asyncio.get_event_loop().run_in_executor(
            get_thread_pool().executor, _call_llm
        )

        if "error" in result:
            log.error("[KB-TAGS] LLM 调用失败: %s", result["error"])
            return JSONResponse(
                {"error": "LLM 调用失败: %s" % result["error"][:120]},
                status_code=503
            )

        llm_output = result.get("response", "")
        log.info("[KB-TAGS] LLM 输出: %s", llm_output[:200])

    except Exception as e:
        log.error("[KB-TAGS] LLM 调用异常: %s", str(e)[:200])
        return JSONResponse(
            {"error": "LLM 调用异常: %s" % str(e)[:120]},
            status_code=503
        )

    # 解析 LLM 输出
    groups = _parse_llm_groups(llm_output, tags_to_group)

    # 合并到现有 tag_groups（保留 manual 分组）
    # 先移除所有 source:"ai" 的分组
    kb.tag_groups = [g for g in kb.tag_groups if g.get("source") != "ai"]

    # 添加新的 ai 分组
    for g in groups:
        group_name = g.get("group", "未命名").strip()
        members = g.get("members", [])
        if not group_name or not members:
            continue
        # 只保留在 tags_to_group 中的标签（过滤 LLM 幻觉）
        members = [m.strip() for m in members if m.strip() in tags_to_group]
        if not members:
            continue
        kb.tag_groups.append({
            "group": group_name,
            "members": members,
            "source": "ai",
        })

    # 检查未分组的标签（LLM 输出未覆盖的），放入「其他」
    grouped_tags = set()
    for g in kb.tag_groups:
        for m in g.get("members", []):
            grouped_tags.add(m)

    ungrouped = [t for t in tags_to_group if t not in grouped_tags]
    if ungrouped:
        # 检查是否已有「其他」分组
        other_found = False
        for g in kb.tag_groups:
            if g.get("group") == "其他":
                for t in ungrouped:
                    if t not in g["members"]:
                        g["members"].append(t)
                other_found = True
                break
        if not other_found:
            kb.tag_groups.append({
                "group": "其他",
                "members": ungrouped,
                "source": "ai",
            })

    kb._save_meta()
    log.info("[KB-TAGS] 分组完成: %d 组, %d 标签",
             len(kb.tag_groups), len(grouped_tags) + len(ungrouped))

    return _build_groups_response(kb, all_tags)


@router.get("/api/kb/tags/groups")
def api_kb_tags_groups():
    """返回当前标签分组及未分组标签"""
    kb = get_kb()
    all_tags = _collect_all_tags(kb)
    return _build_groups_response(kb, all_tags)


def _build_groups_response(kb, all_tags: list) -> dict:
    """构建 groups API 响应"""
    groups = []
    grouped_tags = set()

    for g in kb.tag_groups:
        groups.append({
            "group": g.get("group", ""),
            "members": list(g.get("members", [])),
            "source": g.get("source", "ai"),
        })
        for m in g.get("members", []):
            grouped_tags.add(m)

    ungrouped = [t for t in all_tags if t not in grouped_tags]
    return {"groups": groups, "ungrouped": ungrouped}


@router.post("/api/kb/tags/regroup")
async def api_kb_tags_regroup(request: Request):
    """强制重新分组（包含 source:"manual" 标签，诊断用）

    与 /group 相同流程，但不排除 manual 标签。
    结果仍标记为 source:"ai"。
    """
    kb = get_kb()
    mgr = get_mgr()

    loaded = mgr.get_loaded_llms()
    if not loaded:
        return JSONResponse(
            {"error": "请先在「设置」页面加载模型"},
            status_code=503
        )

    all_tags = _collect_all_tags(kb)
    if not all_tags:
        return {"groups": [], "ungrouped": []}

    tags_str = json.dumps(all_tags, ensure_ascii=False)
    prompt = (
        "将以下标签按语义归并为5-10组。每个标签必须属于一个组。"
        "输出JSON数组: [{\"group\":\"组名\",\"members\":[\"标签1\",\"标签2\"]}]。"
        "只输出JSON，不要任何解释。\n\n标签: " + tags_str
    )

    log.info("[KB-TAGS] 开始强制重新分组: %d 标签", len(all_tags))

    try:
        from core.thread_pool import get_thread_pool
        import asyncio

        def _call_llm():
            return mgr.chat(prompt, max_tokens=1024, _priority="LOW")

        result = await asyncio.get_event_loop().run_in_executor(
            get_thread_pool().executor, _call_llm
        )

        if "error" in result:
            log.error("[KB-TAGS] LLM 调用失败: %s", result["error"])
            return JSONResponse(
                {"error": "LLM 调用失败: %s" % result["error"][:120]},
                status_code=503
            )

        llm_output = result.get("response", "")
        log.info("[KB-TAGS] LLM 输出: %s", llm_output[:200])

    except Exception as e:
        log.error("[KB-TAGS] LLM 调用异常: %s", str(e)[:200])
        return JSONResponse(
            {"error": "LLM 调用异常: %s" % str(e)[:120]},
            status_code=503
        )

    groups = _parse_llm_groups(llm_output, all_tags)

    # 清除所有旧分组，写入新的
    kb.tag_groups = []
    for g in groups:
        group_name = g.get("group", "未命名").strip()
        members = g.get("members", [])
        if not group_name or not members:
            continue
        members = [m.strip() for m in members if m.strip() in all_tags]
        if not members:
            continue
        kb.tag_groups.append({
            "group": group_name,
            "members": members,
            "source": "ai",
        })

    # 未分组标签 → 「其他」
    grouped_tags = set()
    for g in kb.tag_groups:
        for m in g.get("members", []):
            grouped_tags.add(m)
    ungrouped = [t for t in all_tags if t not in grouped_tags]
    if ungrouped:
        kb.tag_groups.append({
            "group": "其他",
            "members": ungrouped,
            "source": "ai",
        })

    kb._save_meta()
    log.info("[KB-TAGS] 强制重新分组完成: %d 组", len(kb.tag_groups))

    return _build_groups_response(kb, all_tags)


@router.post("/api/kb/tags/move")
async def api_kb_tags_move(request: Request):
    """手动将标签移动到指定分组

    Body: {"tag": "中医基础", "group": "中医总论"}
    设置 source:"manual"，后续 AI 刷新不会覆盖。
    """
    kb = get_kb()
    body = await request.json()
    tag = (body.get("tag", "") or "").strip()
    group = (body.get("group", "") or "").strip()

    if not tag:
        return JSONResponse({"error": "tag 不能为空"}, status_code=400)
    if not group:
        return JSONResponse({"error": "group 不能为空"}, status_code=400)

    # 验证 tag 存在于文档中
    all_tags = _collect_all_tags(kb)
    if tag not in all_tags:
        return JSONResponse({"error": "标签 '%s' 不存在于文库中" % tag}, status_code=400)

    kb.set_tag_group(tag, group, source="manual")
    return _build_groups_response(kb, all_tags)


# P6 打磨 #10：AI 知识库概览刷新

@router.get("/api/kb/overview/refresh")
def api_kb_overview_get():
    """返回上次 AI 洞察缓存（页面刷新不丢失）"""
    kb = get_kb()
    try:
        import os as _os_g
        if _os_g.path.exists(kb.insight_path):
            with open(kb.insight_path, "r", encoding="utf-8") as _f:
                cached = json.load(_f)
            cached["ok"] = True
            return cached
    except Exception:
        pass
    return {"ok": True, "insight": "", "doc_count": 0}

@router.post("/api/kb/overview/refresh")
async def api_kb_overview_refresh(request: Request):
    """AI 知识库洞察 · 自动整理

    两轮 LLM：
      第一轮 — B3 叙事型洞察（分析文档内容结构，发现隐藏主题）
      第二轮 — 标签归并（碎片标签收敛为宽泛大类）

    返回 insight 文本 + 归并后的 tags + 文档计数。
    """
    kb = get_kb()
    mgr = get_mgr()

    try:
        all_docs = kb.list_documents()
    except Exception:
        return {"ok": False, "insight": "无法获取文档列表", "doc_count": 0}

    if not isinstance(all_docs, list):
        return {"ok": False, "insight": "文档数据异常", "doc_count": 0}
    doc_count = len(all_docs)

    if doc_count == 0:
        return {"ok": True, "insight": "知识库为空，请先上传文档。", "doc_count": 0}

    # 收集文档列表（标题 + 分类 + 标签）
    doc_list = []
    cat_counts = {}
    for d in all_docs:
        fname = d.get("filename", "未知")
        cat = (d.get("category") or "").strip()
        tags = d.get("tags") or []
        doc_list.append({
            "title": fname,
            "category": cat,
            "tags": [t for t in tags if t],
            "summary": (d.get("summary") or "").strip(),  # 真实内容摘要（供洞察/提问 prompt）
        })
        if cat:
            cat_counts[cat] = cat_counts.get(cat, 0) + 1

    # ==== 辅助：用 StreamEngine 跑一轮 LLM ====
    from core.thread_pool import get_thread_pool
    import asyncio, json

    def _run_llm(prompt: str, max_tokens: int = 500) -> str:
        se = mgr._stream_engine
        parts = []
        for ctype, ctext in se.run(
            message=prompt, model=None, max_tokens=max_tokens,
            history=[], context_cache=None, override_task_type="text",
            kb_mode=False,
        ):
            if ctype in ("text", "raw"):
                parts.append(ctext)
        return mgr.strip_think("".join(parts)).strip()

    async def _run_async(prompt: str, max_tokens: int = 500) -> str:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            get_thread_pool().executor,
            _run_llm, prompt, max_tokens
        )

    # ==== 第一轮：标签归并（先聚类，后洞察）====
    insight = ""
    merges_applied = []
    try:
        # Fix: category 为空时，改用 doc.tags 收集碎片标签作为归并输入
        if not cat_counts:
            tag_counts = {}
            for d in doc_list:
                for t in d.get("tags", []):
                    if t:
                        tag_counts[t] = tag_counts.get(t, 0) + 1
            cats_text = "\n".join(
                "  %s（%d 篇）" % (k, v)
                for k, v in sorted(tag_counts.items(), key=lambda x: -x[1])[:30]
            ) if tag_counts else ""
        else:
            cats_text = "\n".join(
                "  %s（%d 篇）" % (k, v)
                for k, v in sorted(cat_counts.items(), key=lambda x: -x[1])
            )

        if not cats_text:
            cats_text = "\n".join(
                "  %s" % d["title"]
                for d in doc_list[:15]
            )

        merge_prompt = (
            "你是一位知识库分类专家。以下文档的标签过于碎片化，需要归并为 3-5 个宽泛的大类。\n\n"
            "当前标签：\n%s\n\n"
            "要求：\n"
            "1. 含义相近的标签必须合并（如「中医养生」「中医流派」「中医病机」→ 「中医药与养生」）\n"
            "2. 归并到 3-5 个大类，最多不超过 10 个，宁少勿多\n"
            "3. 输出纯 JSON 数组，每项格式：{\"new\": \"新标签\", \"from\": [\"旧标签1\", \"旧标签2\"]}\n"
            "4. 不准输出 Markdown，不准加解释文字，只剩 JSON\n\n"
            "归并方案 JSON：" % cats_text
        )
        raw = await _run_async(merge_prompt, max_tokens=400)

        # 解析 JSON（容错：提取第一个 [ 到最后一个 ] 之间的内容）
        try:
            start = raw.index("[")
            end = raw.rindex("]") + 1
            merge_plan = json.loads(raw[start:end])
        except (ValueError, json.JSONDecodeError):
            merge_plan = []

        # 执行归并：更新文档 category + save
        if merge_plan:
            for plan in merge_plan:
                new_cat = plan.get("new", "").strip()
                old_tags = plan.get("from", [])
                if not new_cat or not old_tags:
                    continue
                old_set = {t.strip() for t in old_tags}
                changed = 0
                for doc in kb.documents.values():
                    old_cat = (doc.category or "").strip()
                    if old_cat in old_set:
                        doc.category = new_cat
                        changed += 1
                if changed > 0:
                    merges_applied.append({
                        "from": list(old_set),
                        "to": new_cat,
                        "count": changed,
                    })

            # 持久化
            try:
                kb._save_meta()
            except Exception:
                pass

    except Exception:
        pass

    # 重新读一次分类统计（归并后）
    try:
        refreshed = kb.list_documents()
        cat_counts = {}
        doc_list = []
        for d in refreshed:
            cat = (d.get("category") or "").strip()
            if cat:
                cat_counts[cat] = cat_counts.get(cat, 0) + 1
            doc_list.append({
                "title": d.get("filename", "未知"),
                "category": cat,
                "tags": [t for t in (d.get("tags") or []) if t],
                "summary": (d.get("summary") or "").strip(),
            })
    except Exception:
        pass

    # ==== 第二轮：基于聚类分布生成洞察 ====
    try:
        # 聚类摘要
        cluster_summary = "、".join(
            "%s（%d篇）" % (k, v)
            for k, v in sorted(cat_counts.items(), key=lambda x: -x[1])[:6]
        ) if cat_counts else "暂无聚类"

        # Bug2 修复：构造 docs_digest —— 文档真实内容摘要块（标题 | 摘要 | 标签）
        # 此前洞察/提问 prompt 只喂分类名+文件名，2B 小模型凭空联想出库外主题。
        # 改为喂每篇文档的 summary（上传时基于真实内容生成）+ tags，让模型"看着内容说话"。
        _digest_lines = []
        for d in doc_list:
            _sum = (d.get("summary") or "").strip()[:80]
            _tags = "、".join(d.get("tags", [])[:4])
            _line = d["title"]
            if _sum:
                _line += " | " + _sum
            if _tags:
                _line += " | " + _tags
            _digest_lines.append("  " + _line)
        docs_digest = "\n".join(_digest_lines[:25])

        insight_prompt = (
            "你是一位知识库分析助手。根据以下文档及其真实摘要，帮用户理解这个文库的实用价值（100-150字）。\n\n"
            "聚类分布：%s\n\n"
            "文档清单（标题 | 摘要 | 标签）：\n%s\n\n"
            "请直接描述（不要编号，不要套话）：\n"
            "- 这个文库能回答什么问题，适合做哪类讨论\n"
            "- 不同主题之间能怎样交叉产生新想法\n"
            "- 如果要让这个文库更好用，最值得补什么方向\n\n"
            "铁律：\n"
            "- 只描述上述文档实际涵盖的内容，不要推断或联想文档中没有的主题\n"
            "- 只输出正文，不要任何标记\n"
            "- 像同事给你介绍资料夹能干嘛，不是写分析报告\n"
            "- 禁止说「您的」「以上」「本文」「综上所述」「缺乏」「不足」「碎片」\n\n"
            "洞察：" % (cluster_summary, docs_digest)
        )
        insight = await _run_async(insight_prompt, max_tokens=600)

        # ==== 独立生成建议追问（基于文档真实内容，而非上一轮洞察的二手描述）====
        suggested_questions = []
        try:
            questions_prompt = (
                "你是一位知识库分析助手。基于以下文档清单及其真实摘要，生成 3 条用户最可能追问的问题。\n\n"
                "文档清单（标题 | 摘要 | 标签）：\n%s\n\n"
                "要求：\n"
                "1. 输出纯 JSON 数组：[\"问题1\", \"问题2\", \"问题3\"]\n"
                "2. 不准输出 Markdown，不准加解释文字\n"
                "3. 铁律：每个问题的答案必须能从上述文档摘要中找到依据，禁止生成需要库外知识才能回答的问题\n\n"
                "正例（答案能在文档中找到）：「中医十二大流派各自的传承特点是什么？」\n"
                "反例（需要库外数据，禁止）：「中医养生与职场理财的量化指标对比分析」\n\n"
                "追问问题 JSON：" % docs_digest
            )
            q_raw = await _run_async(questions_prompt, max_tokens=200)
            try:
                _start = q_raw.index("[")
                _end = q_raw.rindex("]") + 1
                _parsed = json.loads(q_raw[_start:_end])
                if isinstance(_parsed, list) and all(isinstance(q, str) for q in _parsed):
                    suggested_questions = _parsed[:3]
            except (ValueError, json.JSONDecodeError):
                pass

            # Bug2 后置过滤：小模型的 prompt 约束不可靠，仍可能生成库外联想问题。
            # 用文档 tags + 标题关键片段作为"合法主题词表"，对每个问题做子串匹配，
            # 与所有主题词都无重叠的问题判定为"库外联想"，丢弃。宁缺毋滥。
            _topic_words = set()
            for d in doc_list:
                for t in d.get("tags", []):
                    if t and len(t) >= 2:
                        _topic_words.add(t.strip())
                # 标题去掉扩展名后也作为主题词（如"中医病机十九条"）
                _tname = d["title"].rsplit(".", 1)[0]
                for _seg in (2, 3, 4):
                    if len(_tname) >= _seg:
                        for _i in range(0, len(_tname) - _seg + 1):
                            _topic_words.add(_tname[_i:_i + _seg])
            if _topic_words and suggested_questions:
                _filtered = []
                for _q in suggested_questions:
                    if any(_w in _q for _w in _topic_words):
                        _filtered.append(_q)
                    else:
                        log.info("[KB] 洞察提问后置过滤丢弃库外问题: %s", _q)
                suggested_questions = _filtered
        except Exception:
            pass

    except Exception:
        # LLM 不可用：用分类统计回退
        parts = ["%s（%d篇）" % (k, v) for k, v in sorted(cat_counts.items(), key=lambda x: -x[1])[:3]]
        if parts:
            insight = "你的知识库主要覆盖" + "、".join(parts) + "等领域。"
        else:
            insight = "知识库共 %d 篇文档，AI 正在学习标签中。" % doc_count

    # ==== 持久化洞察到文件（刷新页面不丢失）====
    try:
        import os as _os_ov
        _os_ov.makedirs(_os_ov.path.dirname(kb.insight_path), exist_ok=True)
        with open(kb.insight_path, "w", encoding="utf-8") as _f:
            json.dump({
                "insight": insight,
                "doc_count": doc_count,
                "categories": dict(sorted(cat_counts.items(), key=lambda x: -x[1])),
                "suggested_questions": suggested_questions,
                "updated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            }, _f, ensure_ascii=False)
    except Exception:
        pass

    return {
        "ok": True,
        "insight": insight,
        "doc_count": doc_count,
        "categories": dict(sorted(cat_counts.items(), key=lambda x: -x[1])),
        "merges_applied": merges_applied,
        "suggested_questions": suggested_questions,
    }
