# -*- coding: utf-8 -*-
"""
routers/workdir.py — 工作目录 API（0.10.1 M1 只读版，项目 ↔ 目录 1:1）

端点前缀 /api：
  GET  /api/system/browse?path=          内联文件浏览器数据源（目录选择器，只列子目录）
  GET  /api/chats/{chat_name}/workdir    解析会话生效目录（= 所属项目的目录）
  POST /api/projects/{group}/workdir     设置/解除项目外部换绑（body: {"path": str|null}）
  GET  /api/projects/workdirs?groups=a,b 各项目生效目录（外部换绑/默认目录）
  GET  /api/chats/{chat_name}/workdir/files  只读列出项目目录内容（名称/大小/时间）
  POST /api/chats/{chat_name}/workdir/import 把目录内文件引用进会话（复制进 workspace）
  POST /api/chats/{chat_name}/workdir/upload 上传材料到项目目录（用户显式动作）
  POST /api/chats/{chat_name}/workdir/open   在资源管理器中打开项目目录

M1 只读边界：目录本身只读；「引用」是把文件复制进会话 workspace 走既有附件
管道，不改动项目目录内任何文件。写权限归 M2（计划/执行双模式）。
"""
import os
import logging
import subprocess

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from common.security import check_local_origin, local_origin_error
from session.chat_store import safe_chat_name
from session import projects

router = APIRouter()
log = logging.getLogger("routers.workdir")


def _guard(request):
    if not check_local_origin(request):
        return JSONResponse(local_origin_error(), status_code=403)
    return None


def _safe_name_or_400(chat_name):
    safe = safe_chat_name(chat_name)
    if not safe:
        return None, JSONResponse({"error": "非法对话名称"}, status_code=400)
    return safe, None


@router.get("/api/system/browse")
def api_browse(request: Request, path: str = ""):
    """内联文件浏览器（目录选择器数据源）：只列子目录。

    path 为空 → 根视图（快捷入口 + 盘符）；否则列出该目录的子目录。
    取代原生对话框方案——ctypes COM 三连坑（被前台窗压住/取消码带符号/
    shell 对 FILESYSPATH 返回显示名），不可测试不可靠，2026-09-02 弃用。
    """
    denied = _guard(request)
    if denied:
        return denied
    r = projects.browse_dirs(path or None)
    if r is None:
        return JSONResponse({"error": "目录不存在或不可读"}, status_code=400)
    return r


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


@router.post("/api/chats/{chat_name}/workdir/upload")
async def api_upload_to_project(chat_name: str, request: Request):
    """上传材料到项目目录（用户显式动作，multipart 单文件）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    form = await request.form()
    f = form.get("file")
    if f is None or not getattr(f, "filename", ""):
        return JSONResponse({"error": "未选择文件"}, status_code=400)
    content = await f.read()
    result = projects.upload_to_project(safe, f.filename, content)
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
