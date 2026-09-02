# -*- coding: utf-8 -*-
"""
session/projects.py — 项目（分组）级配置存储（0.10.1 工作目录 M1 只读版）

项目当前不是独立实体（PLAN 1.5：M2 才实体化），但要承载「项目绑目录」，
所以先落一个轻量存储：data/projects.json
  { "项目名": {"workdir": "C:\\abs\\path", "updated_at": "..."} }

工作目录解析优先级（会话 chip / 视窗展示用）：
  会话 meta.json 的 workdir（会话级微调）> 项目绑定 > None
"""
import os
import json
import time
import logging
import threading

from config import DATA_DIR
from common.utils import atomic_write_json

log = logging.getLogger(__name__)

PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
_lock = threading.Lock()


def _load():
    try:
        with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _save(data):
    atomic_write_json(PROJECTS_FILE, data)


def _norm_dir(path):
    """规范化 + 校验目录路径；非法/不存在返回 None。"""
    if not path or not isinstance(path, str):
        return None
    p = os.path.normpath(path.strip().strip('"'))
    if not os.path.isabs(p):
        return None
    if not os.path.isdir(p):
        return None
    return p


def get_project_workdir(group):
    """项目绑定的工作目录；未绑/目录已失效返回 None。"""
    if not group:
        return None
    entry = _load().get(group)
    if not isinstance(entry, dict):
        return None
    return _norm_dir(entry.get("workdir"))


def set_project_workdir(group, path):
    """设置/解除项目工作目录。path 为 None/空串 = 解除。返回 {ok, workdir} 或 {error}。"""
    group = (group or "").strip()
    if not group:
        return {"error": "项目名不能为空"}
    with _lock:
        data = _load()
        if not path:
            data.pop(group, None)
            _save(data)
            log.info("[PROJECT] 解除项目目录绑定: %s", group)
            return {"ok": True, "workdir": None}
        p = _norm_dir(path)
        if not p:
            return {"error": "目录不存在或不是绝对路径"}
        data[group] = {
            "workdir": p,
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        _save(data)
        log.info("[PROJECT] 项目 %s 绑定目录: %s", group, p)
        return {"ok": True, "workdir": p}


def all_workdirs():
    """全部项目 → 工作目录映射（过滤已失效目录），供侧栏展示。"""
    out = {}
    for group, entry in _load().items():
        if isinstance(entry, dict):
            p = _norm_dir(entry.get("workdir"))
            if p:
                out[group] = p
    return out


def resolve_workdir(chat_name):
    """解析某会话的生效工作目录。

    返回 {"workdir": path|None, "source": "session"|"group"|None, "group": 组名}
    """
    from session import chat_store  # 延迟 import，避免模块级环
    group = "日常"
    session_dir = None
    meta = chat_store.read_meta(chat_name) if hasattr(chat_store, "read_meta") else None
    if meta:
        group = meta.get("group") or "日常"
        session_dir = _norm_dir(meta.get("workdir"))
    if session_dir:
        return {"workdir": session_dir, "source": "session", "group": group}
    proj_dir = get_project_workdir(group)
    if proj_dir:
        return {"workdir": proj_dir, "source": "group", "group": group}
    return {"workdir": None, "source": None, "group": group}


def list_dir_entries(path, limit=500):
    """只读列目录（顶层）：名称/大小/修改时间/是否目录。目录优先，按名称排。"""
    p = _norm_dir(path)
    if not p:
        return None
    entries = []
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    st = e.stat()
                    entries.append({
                        "name": e.name,
                        "is_dir": e.is_dir(),
                        "size": 0 if e.is_dir() else st.st_size,
                        "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime)),
                    })
                except OSError:
                    continue
    except OSError:
        return None
    entries.sort(key=lambda x: (not x["is_dir"], x["name"].lower()))
    return entries[:limit]
