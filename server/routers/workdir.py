# -*- coding: utf-8 -*-
"""
routers/workdir.py — 工作目录 API（0.10.1 M1 只读版，项目 ↔ 目录 1:1）

端点前缀 /api：
  POST /api/system/pick-directory        系统原生目录选择对话框（ctypes COM，本地特权）
  GET  /api/chats/{chat_name}/workdir    解析会话生效目录（= 所属项目的目录）
  POST /api/projects/{group}/workdir     设置/解除项目外部换绑（body: {"path": str|null}）
  GET  /api/projects/workdirs?groups=a,b 各项目生效目录（外部换绑/默认目录）
  GET  /api/chats/{chat_name}/workdir/files  只读列出项目目录内容（名称/大小/时间）
  POST /api/chats/{chat_name}/workdir/import 把目录内文件引用进会话（复制进 workspace）
  POST /api/chats/{chat_name}/workdir/open   在资源管理器中打开项目目录

M1 只读边界：目录本身只读；「引用」是把文件复制进会话 workspace 走既有附件
管道，不改动项目目录内任何文件。写权限归 M2（计划/执行双模式）。
"""
import os
import logging
import subprocess
import threading

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from common.security import check_local_origin, local_origin_error
from session.chat_store import safe_chat_name
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
    """解析会话生效目录（= 所属项目的目录；项目 ↔ 目录 1:1）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    return projects.resolve_workdir(safe)


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
def api_all_workdirs(request: Request, groups: str = ""):
    """各项目生效目录。传 groups=a,b 时逐项解析（含默认目录）；
    不传时只返回外部换绑（侧栏图标态用）。"""
    denied = _guard(request)
    if denied:
        return denied
    if groups:
        lst = [g for g in (x.strip() for x in groups.split(",")) if g][:50]
        return {"workdirs": projects.all_workdirs(lst)}
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
        return JSONResponse({"error": "目录不可读"}, status_code=400)
    entries = projects.list_dir_entries(resolved["workdir"])
    if entries is None:
        return JSONResponse({"error": "目录不可读"}, status_code=400)
    return {"files": entries, **resolved}


@router.post("/api/chats/{chat_name}/workdir/import")
async def api_import_workdir_file(chat_name: str, request: Request):
    """把项目目录内的文件引用进会话（复制到会话 workspace）。

    返回与 /api/file_upload 同构的 {path, filename, size, tokens}，
    前端按普通上传附件处理即可。
    """
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    body = await request.json()
    result = projects.import_file(safe, body.get("name", ""))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.post("/api/chats/{chat_name}/workdir/open")
def api_open_workdir(chat_name: str, request: Request):
    """在资源管理器中打开项目目录（本地应用特权；失败附路径让前端复制兜底）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    resolved = projects.resolve_workdir(safe)
    path = resolved["workdir"]
    if not path:
        return JSONResponse({"error": "目录不可用"}, status_code=400)
    try:
        subprocess.Popen(["explorer.exe", path])
        return {"ok": True, "path": path}
    except Exception as e:
        log.warning("[WORKDIR] 打开目录失败: %s", e)
        return JSONResponse({"error": "打开失败", "path": path}, status_code=500)
