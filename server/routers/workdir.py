# -*- coding: utf-8 -*-
"""
routers/workdir.py — 项目（即文件夹）与目录 API（0.10.1「项目即文件夹」四次定稿）

端点前缀 /api：
  GET  /api/system/browse?path=           内联文件浏览器数据源（只列子目录）
  GET  /api/projects/list                 项目列表（默认项目恒在首位，含失效态）
  POST /api/projects/new_blank            新建空白项目（默认根下建文件夹，body: {"name"}）
  POST /api/projects/new_external         使用现有文件夹（body: {"path"}）
  POST /api/projects/rename               改显示名（body: {"dir", "display"}）
  DELETE /api/projects                    删除项目（body: {"dir"}；级联删会话记录，
                                          目录文件永不动；默认项目拒绝）
  POST /api/chats/{chat_name}/project     会话归项目（仅 0 消息会话可改，body: {"dir"}）
  GET  /api/chats/{chat_name}/workdir     解析会话所属项目（含 legacy 标记）
  GET  /api/chats/{chat_name}/workdir/files  列项目目录（顶层材料 + .sidemate 产物区）
  POST /api/chats/{chat_name}/workdir/reference 引用目录文件（直读不复制，返回原路径）
  POST /api/chats/{chat_name}/workdir/upload   上传材料到项目根（用户显式动作）
  POST /api/chats/{chat_name}/workdir/open     在资源管理器中打开项目目录

M1 只读边界：AI 不写项目目录（产物区写权限归 M2 计划/执行双模式）；
上传/引用是用户显式动作。旧版会话（meta 无 project_dir）只读。
"""
import os
import json
import logging
import shutil
import subprocess

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from common.security import check_local_origin, local_origin_error
from common.utils import atomic_write_json
from config import CHAT_DIR
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


# ============================================================
#  目录浏览（内联选择器）
# ============================================================

@router.get("/api/system/browse")
def api_browse(request: Request, path: str = ""):
    denied = _guard(request)
    if denied:
        return denied
    r = projects.browse_dirs(path or None)
    if r is None:
        return JSONResponse({"error": "目录不存在或不可读"}, status_code=400)
    return r


# ============================================================
#  项目 CRUD（项目=文件夹，无换绑无锁定）
# ============================================================

@router.get("/api/projects/list")
def api_projects_list(request: Request):
    denied = _guard(request)
    if denied:
        return denied
    return {"projects": projects.list_projects()}


@router.get("/api/projects/files")
def api_project_files(request: Request, dir: str = ""):
    """列指定项目目录（不依赖当前会话，供视窗跨项目查看；只读）。"""
    denied = _guard(request)
    if denied:
        return denied
    # 只允许默认项目或已注册项目目录
    found = None
    for p in projects.list_projects():
        if os.path.normcase(os.path.realpath(p["dir"])) == os.path.normcase(os.path.realpath(dir)):
            found = p
            break
    if not found:
        return JSONResponse({"error": "项目目录不存在或未注册"}, status_code=400)
    from config import PROJECT_ARTIFACT_DIR
    files = projects.list_dir_entries(found["dir"]) or []
    artifacts = projects.list_dir_entries(os.path.join(found["dir"], PROJECT_ARTIFACT_DIR)) or []
    files = [f for f in files if f["name"] != PROJECT_ARTIFACT_DIR]
    return {"files": files, "artifacts": artifacts, **found}


@router.post("/api/projects/new_blank")
async def api_project_new_blank(request: Request):
    denied = _guard(request)
    if denied:
        return denied
    body = await request.json()
    result = projects.create_project_blank(body.get("name", ""))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.post("/api/projects/new_external")
async def api_project_new_external(request: Request):
    denied = _guard(request)
    if denied:
        return denied
    body = await request.json()
    result = projects.create_project_external(body.get("path", ""))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.post("/api/projects/rename")
async def api_project_rename(request: Request):
    denied = _guard(request)
    if denied:
        return denied
    body = await request.json()
    result = projects.rename_project(body.get("dir", ""), body.get("display", ""))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.delete("/api/projects")
async def api_project_delete(request: Request):
    """删除项目：注册表移除 + 级联删会话记录。目录文件永不动。"""
    denied = _guard(request)
    if denied:
        return denied
    body = await request.json()
    result = projects.delete_project(body.get("dir", ""))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    # 级联删会话记录（消息/meta/缓存/工作区里的会话级中间件；产物在 .sidemate 不受影响）
    from config import CHAT_DIR
    deleted = []
    for name in result["sessions"]:
        fp = os.path.join(CHAT_DIR, name)
        try:
            if os.path.isdir(fp):
                shutil.rmtree(fp)
                deleted.append(name)
        except OSError as e:
            log.warning("[PROJECT] 级联删会话失败: %s %s", name, e)
    # 若被删的含当前会话，重置 current 指针
    try:
        from routers.deps import get_current_chat, set_current_chat
        cur = get_current_chat()
        if cur and os.path.basename(cur.rstrip("\\/")) in deleted:
            set_current_chat(None)
    except Exception:
        pass
    return {"ok": True, "deleted_sessions": deleted, "display": result.get("display", "")}


# ============================================================
#  会话 ↔ 项目
# ============================================================

@router.post("/api/chats/{chat_name}/project")
async def api_set_chat_project(chat_name: str, request: Request):
    """会话归项目：仅 0 消息会话可改（归属在创建窗口定型，之后不可改）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    body = await request.json()
    target = body.get("dir", "")
    # 目标必须是默认项目或已注册且存在的项目目录
    ok = False
    for p in projects.list_projects():
        if os.path.normcase(os.path.realpath(p["dir"])) == os.path.normcase(os.path.realpath(target)):
            ok = p["status"] == "ok"
            break
    if not ok:
        return JSONResponse({"error": "项目目录不存在或未注册"}, status_code=400)
    meta = projects.read_chat_meta(safe)
    if not meta:
        return JSONResponse({"error": "会话不存在或旧格式"}, status_code=400)
    if meta.get("message_count", 0) > 0:
        return JSONResponse({"error": "已有对话内容的会话不能更换项目"}, status_code=400)
    import time as _time
    meta["project_dir"] = os.path.normpath(target)
    meta["updated_at"] = _time.strftime("%Y-%m-%d %H:%M:%S")
    atomic_write_json(os.path.join(CHAT_DIR, safe, "meta.json"), meta)
    return {"ok": True, "project_dir": meta["project_dir"]}


@router.get("/api/chats/{chat_name}/workdir")
def api_get_workdir(chat_name: str, request: Request):
    """解析会话所属项目（旧版会话返回 legacy: true）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    return projects.resolve_chat_project(safe)


@router.get("/api/chats/{chat_name}/workdir/files")
def api_workdir_files(chat_name: str, request: Request):
    """列项目目录：顶层材料 + .sidemate 产物区。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    proj = projects.resolve_chat_project(safe)
    if proj.get("legacy"):
        return {"legacy": True}
    root = proj.get("dir")
    if not root or proj.get("status") != "ok":
        return {"files": [], "artifacts": [], **proj}
    from config import PROJECT_ARTIFACT_DIR
    files = projects.list_dir_entries(root)
    artifacts = projects.list_dir_entries(os.path.join(root, PROJECT_ARTIFACT_DIR)) or []
    # 材料区不混进产物区条目
    files = [f for f in (files or []) if f["name"] != PROJECT_ARTIFACT_DIR]
    return {"files": files, "artifacts": artifacts, **proj}


@router.post("/api/chats/{chat_name}/workdir/reference")
async def api_reference_file(chat_name: str, request: Request):
    """引用项目目录文件（直读不复制）。返回 {path（原路径）, filename, size, tokens}。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    body = await request.json()
    result = projects.reference_file(safe, body.get("name", ""))
    if "error" in result:
        return JSONResponse(result, status_code=400)
    return result


@router.post("/api/chats/{chat_name}/workdir/upload")
async def api_upload_to_project(chat_name: str, request: Request):
    """上传材料到项目根（用户显式动作，multipart 单文件）。"""
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
    """在资源管理器中打开项目目录（本地应用特权）。"""
    denied = _guard(request)
    if denied:
        return denied
    safe, err = _safe_name_or_400(chat_name)
    if err:
        return err
    proj = projects.resolve_chat_project(safe)
    path = proj.get("dir")
    if not path or proj.get("legacy"):
        return JSONResponse({"error": "目录不可用"}, status_code=400)
    try:
        subprocess.Popen(["explorer.exe", path])
        return {"ok": True, "path": path}
    except Exception as e:
        log.warning("[WORKDIR] 打开目录失败: %s", e)
        return JSONResponse({"error": "打开失败", "path": path}, status_code=500)
