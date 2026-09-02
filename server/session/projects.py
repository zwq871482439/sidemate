# -*- coding: utf-8 -*-
"""
session/projects.py — 项目（分组）级配置存储（0.10.1 工作目录 M1 只读版）

模型（PLAN 1.5 二次定稿 2026-09-02）：**项目 ↔ 目录 1:1**。
- 目录是纯项目属性，会话级绑定不存在；项目下所有会话共用项目目录。
- 每个项目必有目录：外部换绑（data/projects.json）优先，否则默认
  data/projects/<项目名>/（首次解析时自动创建）。「未绑定」态不存在。
- 目录内容不向量化（与 KB 边界）；消费方式=在线 agent 工具锚定（M2）/
  离线引用注入（import_file 复制进会话 workspace 后走既有附件管道）。

data/projects.json 只存外部换绑：
  { "项目名": {"workdir": "C:\\abs\\path", "updated_at": "..."} }
"""
import os
import json
import shutil
import time
import logging
import threading

from config import DATA_DIR, CHAT_DIR
from common.utils import atomic_write_json

log = logging.getLogger(__name__)

PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
DEFAULT_ROOT = os.path.join(DATA_DIR, "projects")
_lock = threading.Lock()

# 与 /api/file_upload 同一份白名单（能被 LLM 消费的类型）
ALLOWED_IMPORT_EXTS = {
    ".txt", ".md", ".csv", ".docx", ".xlsx", ".pdf",
    ".epub", ".html", ".htm", ".srt",
}


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


def _default_dir(group):
    """项目默认目录（data/projects/<项目名>/），不存在则创建。"""
    from session.chat_store import safe_chat_name
    safe = safe_chat_name(group) or "日常"
    p = os.path.join(DEFAULT_ROOT, safe)
    try:
        os.makedirs(p, exist_ok=True)
    except OSError:
        return None
    return p


def resolve_project_workdir(group):
    """项目生效目录：外部换绑 > 默认目录（自动创建）。

    返回 {"workdir": path, "source": "external"|"default", "group": 组名}
    group 为空按「日常」处理。
    """
    group = (group or "").strip() or "日常"
    entry = _load().get(group)
    if isinstance(entry, dict):
        ext = _norm_dir(entry.get("workdir"))
        if ext:
            return {"workdir": ext, "source": "external", "group": group}
    return {"workdir": _default_dir(group), "source": "default", "group": group}


def get_project_workdir(group):
    """兼容旧调用：返回外部换绑路径或 None（不触发默认目录创建）。"""
    if not group:
        return None
    entry = _load().get(group)
    if not isinstance(entry, dict):
        return None
    return _norm_dir(entry.get("workdir"))


def set_project_workdir(group, path):
    """设置/解除项目外部目录。path 为 None/空串 = 解除（回落默认目录）。"""
    group = (group or "").strip()
    if not group:
        return {"error": "项目名不能为空"}
    with _lock:
        data = _load()
        if not path:
            data.pop(group, None)
            _save(data)
            log.info("[PROJECT] 解除项目目录换绑（回落默认）: %s", group)
            return {"ok": True, "workdir": None}
        p = _norm_dir(path)
        if not p:
            return {"error": "目录不存在或不是绝对路径"}
        data[group] = {
            "workdir": p,
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        _save(data)
        log.info("[PROJECT] 项目 %s 换绑目录: %s", group, p)
        return {"ok": True, "workdir": p}


def all_workdirs(groups=None):
    """各项目的生效目录映射。groups 为 None 时只返回外部换绑（旧行为）。"""
    if groups is None:
        out = {}
        for group, entry in _load().items():
            if isinstance(entry, dict):
                p = _norm_dir(entry.get("workdir"))
                if p:
                    out[group] = {"workdir": p, "source": "external"}
        return out
    return {g: resolve_project_workdir(g) for g in groups}


def resolve_workdir(chat_name):
    """解析某会话的生效工作目录 = 其所属项目的目录（项目 ↔ 目录 1:1）。

    返回 {"workdir": path, "source": "external"|"default", "group": 组名}
    """
    from session import chat_store  # 延迟 import，避免模块级环
    group = "日常"
    meta = chat_store.read_meta(chat_name) if hasattr(chat_store, "read_meta") else None
    if meta:
        group = meta.get("group") or "日常"
    return resolve_project_workdir(group)


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


def import_file(chat_name, name):
    """把项目目录内的文件「引用」进会话：复制到会话 workspace，走既有附件管道。

    返回与 /api/file_upload 同构的 {path, filename, size, tokens}，或 {error}。
    安全：name 只能是纯文件名（防穿越）；扩展名白名单与上传一致。
    """
    from session import chat_store
    resolved = resolve_workdir(chat_name)
    root = resolved["workdir"]
    if not root:
        return {"error": "项目目录不可用"}
    base = os.path.basename(name or "")
    if not base or base != name:
        return {"error": "非法文件名"}
    src = os.path.normpath(os.path.join(root, base))
    # 双重防穿越：basename 之后仍确认落在根内
    if os.path.dirname(src) != os.path.normpath(root) or not os.path.isfile(src):
        return {"error": "文件不存在"}
    ext = os.path.splitext(base)[1].lower()
    if ext not in ALLOWED_IMPORT_EXTS:
        return {"error": "不支持的文件类型: %s" % (ext or "(无扩展名)")}
    chat_path = os.path.join(CHAT_DIR, chat_name)
    if not os.path.isdir(chat_path):
        return {"error": "会话不存在"}
    chat_store.ensure_chat_subdirs(chat_name)
    ws_dir = os.path.join(chat_path, "workspace")
    dst = os.path.join(ws_dir, base)
    try:
        shutil.copy2(src, dst)
    except OSError as e:
        log.warning("[PROJECT] 引用复制失败: %s", e)
        return {"error": "复制失败"}
    size = os.path.getsize(dst)
    tokens = 0
    try:
        from knowledge.file_extractor import process_uploaded_file
        info = process_uploaded_file(dst, "", max_chars=10**9)
        if info.get("status") in ("ok", "truncated"):
            text = info.get("text", "")
            cn = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
            tokens = int(cn / 1.5 + (len(text) - cn) / 4.0)
    except Exception as e:
        log.warning("[PROJECT] 引用 token 估算失败: %s", str(e)[:80])
    log.info("[PROJECT] 引用目录文件: %s → 会话 %s", base, chat_name)
    return {"path": dst, "filename": base, "size": size, "tokens": tokens}
