# -*- coding: utf-8 -*-
"""
routers/workdir.py — 工作目录 API（0.10.1 M1 只读版）

端点前缀 /api：
  POST /api/system/pick-directory        系统原生目录选择对话框（ctypes COM，本地特权）
  GET  /api/chats/{chat_name}/workdir    解析会话生效工作目录（会话级 > 项目绑定）
  POST /api/chats/{chat_name}/workdir    设置/解除会话级绑定（body: {"path": str|null}）
  POST /api/projects/{group}/workdir     设置/解除项目绑定（body: {"path": str|null}）
  GET  /api/projects/workdirs            全部项目 → 目录映射（侧栏展示）
  GET  /api/chats/{chat_name}/workdir/files  只读列出生效目录内容（名称/大小/时间）
  POST /api/chats/{chat_name}/workdir/open   在资源管理器中打开生效目录

M1 只读边界：只绑定/展示/打开，任何文件写操作不在此暴露（M2 写权限再说）。
"""
import os
import logging
import subprocess
import threading

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from common.security import check_local_origin, local_origin_error
from session.chat_store import safe_chat_name, set_chat_workdir
from session import projects

router = APIRouter()
log = logging.getLogger("routers.workdir")

# 目录对话框全局只许一个在开（模态框叠模态框会把用户搞晕）
_pick_lock = threading.Lock()


def _guard(request):
    if not check_local_origin(request):
        return JSONResponse(local_origin_error(), status_code=403)
    return None


def _safe_name_or_400(chat_name):
    safe = safe_chat_name(chat_name)
    if not safe:
        return None, JSONResponse({"error": "非法对话名称"}, status_code=400)
    return safe, None


@router.post("/api/system/pick-directory")
def api_pick_directory(request: Request):
    """弹系统目录选择对话框（同步阻塞，用户选完才返回）。

    嵌入式 Python 无 tkinter，走 core.dir_dialog 的 ctypes COM 实现。
    sync def：FastAPI 线程池执行，避免阻塞事件循环。
    """
    denied = _guard(request)
    if denied:
        return denied
    if not _pick_lock.acquire(blocking=False):
        return JSONResponse({"error": "目录选择对话框已打开，请先完成或关闭它"}, status_code=409)
    try:
        from core.dir_dialog import pick_directory
        path = pick_directory("选择工作目录")
    finally:
        _pick_lock.release()
    if not path:
        log.info("[WORKDIR] 目录选择取消/失败")
        return {"ok": False, "cancelled": True}
    p = os.path.normpath(path)
    if not os.path.isabs(p) or not os.path.isdir(p):
        # 选了「库」/快速访问等非文件系统位置：IFileOpenDialog 返回的不是本地路径
        log.info("[WORKDIR] 选定位置无效（非本地目录）: %s", path)
        return {"ok": False, "error": "所选位置不是本地文件夹（「库」和快速访问不可用），请选具体磁盘上的目录"}
    log.info("[WORKDIR] 用户选定目录: %s", p)
    return {"ok": True, "path": p}


@router.get("/api/chats/{chat_name}/workdir")
def api_get_workdir(chat_name: str, request: Request):
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    return projects.resolve_workdir(safe)


@router.post("/api/chats/{chat_name}/workdir")
async def api_set_chat_workdir(chat_name: str, request: Request):
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    body = await request.json()
    result = set_chat_workdir(safe, body.get("path"))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.post("/api/projects/{group}/workdir")
async def api_set_project_workdir(group: str, request: Request):
    denied = _guard(request)
    if denied:
        return denied
    body = await request.json()
    result = projects.set_project_workdir(group, body.get("path"))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.get("/api/projects/workdirs")
def api_all_workdirs(request: Request):
    denied = _guard(request)
    if denied:
        return denied
    return {"workdirs": projects.all_workdirs()}


@router.get("/api/chats/{chat_name}/workdir/files")
def api_workdir_files(chat_name: str, request: Request):
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    resolved = projects.resolve_workdir(safe)
    if not resolved["workdir"]:
        return {"files": [], "workdir": None, "source": None, "group": resolved["group"]}
    entries = projects.list_dir_entries(resolved["workdir"])
    if entries is None:
        return JSONResponse({"error": "目录不可读"}, status_code=400)
    return {"files": entries, **resolved}


@router.post("/api/chats/{chat_name}/workdir/open")
def api_open_workdir(chat_name: str, request: Request):
    """在资源管理器中打开生效目录（本地应用特权；失败附路径让前端复制兜底）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    resolved = projects.resolve_workdir(safe)
    path = resolved["workdir"]
    if not path:
        return JSONResponse({"error": "未绑定工作目录"}, status_code=400)
    try:
        subprocess.Popen(["explorer.exe", path])
        return {"ok": True, "path": path}
    except Exception as e:
        log.warning("[WORKDIR] 打开目录失败: %s", e)
        return JSONResponse({"error": "打开失败", "path": path}, status_code=500)
