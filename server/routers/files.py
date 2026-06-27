# -*- coding: utf-8 -*-
"""
routers/files.py — 缓存文件管理 API
列出/下载/删除上传的文件缓存

Patch4 修复 1（A 层）新增：
  - /api/chat/{chat_id}/doc/{doc_id}/download  下载会话内文档产物（.docx / .json）
  - /api/chat/{chat_id}/workspace              workspace 文件管理（list/read/write/delete）
"""

import os
import logging
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, FileResponse, PlainTextResponse

from routers.deps import get_log, WORKSPACE_DIR
from config import UPLOAD_DIR, DOCS_DIR, CHAT_DIR

router = APIRouter()
log = get_log()

# D1 重构：录音文件存储在 data/recorder/audio/
from config import RECORDER_DATA_DIR
RECORDING_DIR = os.path.realpath(os.path.join(RECORDER_DATA_DIR, "audio"))
RECORDING_DIR_LEGACY = os.path.join(WORKSPACE_DIR, "recordings")
FILE_DIR = os.path.join(WORKSPACE_DIR, "files")


@router.get("/api/cache/files")
def list_cache_files(category: str = "all"):
    """列出缓存文件。category: all / uploads / recordings / docs"""
    dirs = []
    if category == "all":
        dirs = [(UPLOAD_DIR, "uploads"), (RECORDING_DIR, "recordings"), (RECORDING_DIR_LEGACY, "recordings"), (DOCS_DIR, "docs")]
    elif category == "recordings":
        dirs = [(RECORDING_DIR, "recordings"), (RECORDING_DIR_LEGACY, "recordings")]
    elif category == "docs":
        dirs = [(DOCS_DIR, "docs")]
    else:
        target_dir = UPLOAD_DIR
        dirs = [(target_dir, "uploads")]
    
    files = []
    total_size = 0
    seen = set()  # 去重
    
    for target_dir, cat_label in dirs:
        if not os.path.exists(target_dir):
            continue
        for f in os.listdir(target_dir):
            if f in seen:
                continue
            fp = os.path.join(target_dir, f)
            if os.path.isfile(fp):
                seen.add(f)
                stat = os.stat(fp)
                files.append({
                    "name": f,
                    "size": stat.st_size,
                    "modified": stat.st_mtime,
                    "category": cat_label,
                })
                total_size += stat.st_size
    
    files.sort(key=lambda x: -x["modified"])
    return {"files": files, "total": len(files), "total_size": total_size}


@router.delete("/api/cache/files/{filename}")
def delete_cache_file(filename: str, category: str = "uploads"):
    """删除单个缓存文件"""
    # 防路径遍历
    safe_name = os.path.basename(filename)
    if safe_name != filename:
        return JSONResponse({"error": "非法文件名"}, status_code=400)
    
    search_dirs = []
    if category == "recordings":
        search_dirs = [RECORDING_DIR, RECORDING_DIR_LEGACY]
    elif category == "docs":
        search_dirs = [DOCS_DIR]
    else:
        search_dirs = [UPLOAD_DIR]
    
    for target_dir in search_dirs:
        fp = os.path.join(target_dir, safe_name)
        if os.path.exists(fp):
            try:
                os.remove(fp)
                log.info("[CACHE] 删除缓存文件: %s/%s" % (category, safe_name))
                return {"ok": True}
            except Exception as e:
                return JSONResponse({"error": str(e)}, status_code=500)
    
    return JSONResponse({"error": "文件不存在"}, status_code=404)


@router.delete("/api/cache/files")
def clear_cache_files(category: str = "all"):
    """清空缓存文件"""
    if category == "all":
        dirs = [UPLOAD_DIR, RECORDING_DIR, RECORDING_DIR_LEGACY, DOCS_DIR]
    elif category == "recordings":
        dirs = [RECORDING_DIR, RECORDING_DIR_LEGACY]
    elif category == "docs":
        dirs = [DOCS_DIR]
    else:
        dirs = [UPLOAD_DIR]
    
    deleted = 0
    for target_dir in dirs:
        if not os.path.exists(target_dir):
            continue
        for f in os.listdir(target_dir):
            fp = os.path.join(target_dir, f)
            if os.path.isfile(fp):
                try:
                    os.remove(fp)
                    deleted += 1
                except Exception:
                    pass
    
    log.info("[CACHE] 清空缓存: %s (删除 %d 文件)" % (category, deleted))
    return {"ok": True, "deleted": deleted}


# ============================================================
#  Patch4 修复 1：会话级文档 + workspace 文件 API
# ============================================================

def _chat_folder_path(chat_id):
    """根据 chat_id 返回会话根目录（防路径遍历）。"""
    # 只允许文件夹名（白名单：字母/数字/下划线/连字符/中文）
    import re
    if not chat_id or not re.match(r'^[a-zA-Z0-9_\-\u4e00-\u9fff]+$', chat_id):
        return None
    p = os.path.join(CHAT_DIR, chat_id)
    # 规范化后必须在 CHAT_DIR 之内
    norm = os.path.normpath(p)
    if norm != p and not norm.startswith(CHAT_DIR + os.sep):
        return None
    if not os.path.isdir(norm):
        return None
    return norm


@router.get("/api/chat/{chat_id}/doc/{doc_id}/download")
def download_chat_doc(chat_id: str, doc_id: str, fmt: str = "docx"):
    """下载会话内的文档产物。

    - fmt=docx：返回 docs/{doc_id}.docx（如果存在）
    - fmt=json：返回 docs/{doc_id}.json（文档状态）

    doc_id 同样做白名单校验，防路径遍历。
    """
    import re
    chat_path = _chat_folder_path(chat_id)
    if not chat_path:
        return JSONResponse({"error": "非法或不存在会话"}, status_code=404)

    # doc_id 白名单（Patch4 v3.1 BUG#15+21：允许中文 + 全角字符/中文标点）
    # FastAPI 会自动 URL 解码路径参数，所以 doc_id 已经是解码后的原文
    # N-2 修复：fullmatch 替代 re.match(^...$)，避免结尾换行绕过
    if not doc_id or not re.fullmatch(r'[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef\w\-]+', doc_id):
        return JSONResponse({"error": "非法 doc_id"}, status_code=400)

    # Patch4 v3.1 BUG#22：优先在 workspace/ 找（新位置），fallback 到 docs/（旧位置）
    workspace_dir = os.path.join(chat_path, "workspace")
    docs_dir = os.path.join(chat_path, "docs")

    if fmt == "json":
        target = os.path.join(docs_dir, doc_id + ".json")
        if not os.path.isfile(target):
            return JSONResponse({"error": "文档状态文件不存在"}, status_code=404)
        return FileResponse(target, media_type="application/json",
                            filename=doc_id + ".json")

    # 默认 docx — Patch4 v3.1 BUG#22：优先 workspace/，fallback docs/
    target = os.path.join(workspace_dir, doc_id + ".docx")
    if not os.path.isfile(target):
        # fallback 到旧位置 docs/
        target = os.path.join(docs_dir, doc_id + ".docx")
    if not os.path.isfile(target):
        return JSONResponse({"error": "docx 产物尚未生成"}, status_code=404)
    return FileResponse(target,
                        media_type="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
                        filename=doc_id + ".docx")


@router.get("/api/chat/{chat_id}/workspace")
def list_workspace(chat_id: str):
    """列出会话 workspace 内的文件。"""
    from core.doc_session import list_workspace_files
    chat_path = _chat_folder_path(chat_id)
    if not chat_path:
        return JSONResponse({"error": "非法或不存在会话"}, status_code=404)

    try:
        files = list_workspace_files(chat_id)
        return {"ok": True, "files": files, "count": len(files)}
    except Exception as e:
        log.warning("[WORKSPACE] list 失败 chat=%s: %s", chat_id, str(e)[:100])
        return JSONResponse({"error": str(e)[:120]}, status_code=500)


@router.get("/api/chat/{chat_id}/workspace/read")
def read_workspace(chat_id: str, path: str):
    """读取 workspace 内的某个文件（相对路径）。"""
    from core.doc_session import read_workspace_file
    if _chat_folder_path(chat_id) is None:
        return JSONResponse({"error": "非法或不存在会话"}, status_code=404)

    try:
        f = read_workspace_file(chat_id, path)
        return PlainTextResponse(f["content"])
    except ValueError as e:
        return JSONResponse({"error": str(e)[:120]}, status_code=400)
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)[:120]}, status_code=404)


@router.get("/api/chat/{chat_id}/workspace/download")
def download_workspace_file(chat_id: str, path: str):
    """下载 workspace 内的任意文件（xlsx/docx/txt/md 等，产物下载用）。

    Query: path=相对 workspace 的文件路径（如 "成绩单.xlsx"）
    """
    from core.doc_session import safe_workspace_path
    if _chat_folder_path(chat_id) is None:
        return JSONResponse({"error": "非法或不存在会话"}, status_code=404)
    try:
        abs_path = safe_workspace_path(chat_id, path)
    except ValueError as e:
        return JSONResponse({"error": str(e)[:120]}, status_code=400)
    if not os.path.isfile(abs_path):
        return JSONResponse({"error": "文件不存在"}, status_code=404)

    # MIME 类型按扩展名映射
    import mimetypes
    _ext_mime = {
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".pdf": "application/pdf",
    }
    ext = os.path.splitext(path)[1].lower()
    media_type = _ext_mime.get(ext, mimetypes.guess_type(path)[0] or "application/octet-stream")
    filename = os.path.basename(path)
    return FileResponse(abs_path, media_type=media_type, filename=filename)


@router.post("/api/chat/{chat_id}/workspace/write")
async def write_workspace(chat_id: str, path: str, request: Request):
    """写入 workspace 文件。content 从请求 body（纯文本）读取。"""
    from core.doc_session import write_workspace_file
    if _chat_folder_path(chat_id) is None:
        return JSONResponse({"error": "非法或不存在会话"}, status_code=404)

    body = await request.body()
    content = body.decode("utf-8", errors="replace")

    try:
        f = write_workspace_file(chat_id, path, content)
        return {"ok": True, "name": f["name"], "size": f["size"]}
    except ValueError as e:
        return JSONResponse({"error": str(e)[:120]}, status_code=400)
    except Exception as e:
        log.warning("[WORKSPACE] write 失败 chat=%s path=%s: %s", chat_id, path, str(e)[:100])
        return JSONResponse({"error": str(e)[:120]}, status_code=500)


@router.delete("/api/chat/{chat_id}/workspace/delete")
def delete_workspace(chat_id: str, path: str):
    """删除 workspace 内的某个文件。"""
    from core.doc_session import delete_workspace_file
    if _chat_folder_path(chat_id) is None:
        return JSONResponse({"error": "非法或不存在会话"}, status_code=404)

    try:
        f = delete_workspace_file(chat_id, path)
        return {"ok": True, "name": f["name"], "deleted": True}
    except ValueError as e:
        return JSONResponse({"error": str(e)[:120]}, status_code=400)
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)[:120]}, status_code=404)
    except Exception as e:
        log.warning("[WORKSPACE] delete 失败 chat=%s path=%s: %s", chat_id, path, str(e)[:100])
        return JSONResponse({"error": str(e)[:120]}, status_code=500)
