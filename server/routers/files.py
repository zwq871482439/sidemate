# -*- coding: utf-8 -*-
"""
routers/files.py — 缓存文件管理 API
列出/下载/删除上传的文件缓存
"""

import os
import logging
from fastapi import APIRouter
from fastapi.responses import JSONResponse

from routers.deps import get_log, WORKSPACE_DIR
from config import UPLOAD_DIR, DOCS_DIR

router = APIRouter()
log = get_log()

# 录音文件实际存储在 recorder_pkg/data/recordings/audio/
_recorder_base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "recorder_pkg", "data", "recordings")
RECORDING_DIR = os.path.realpath(os.path.join(_recorder_base, "audio"))
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
