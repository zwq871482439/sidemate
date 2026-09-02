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

    返回 {"workdir", "source": "external"|"default", "group",
          "locked": 是否有会话锁定, "session_count": 会话数}
    group 为空按「日常」处理。
    """
    group = (group or "").strip() or "日常"
    n = count_project_sessions(group)
    base = {"workdir": None, "source": "default", "group": group,
            "locked": n > 0, "session_count": n}
    entry = _load().get(group)
    if isinstance(entry, dict):
        ext = _norm_dir(entry.get("workdir"))
        if ext:
            base.update({"workdir": ext, "source": "external"})
            return base
    base["workdir"] = _default_dir(group)
    return base


def get_project_workdir(group):
    """兼容旧调用：返回外部换绑路径或 None（不触发默认目录创建）。"""
    if not group:
        return None
    entry = _load().get(group)
    if not isinstance(entry, dict):
        return None
    return _norm_dir(entry.get("workdir"))


def count_project_sessions(group):
    """项目下的会话数（folder 格式按 meta.group 计；「日常」兼计旧 .json 格式）。"""
    group = (group or "").strip() or "日常"
    n = 0
    try:
        entries = os.listdir(CHAT_DIR)
    except OSError:
        return 0
    for entry in entries:
        ep = os.path.join(CHAT_DIR, entry)
        if os.path.isdir(ep):
            meta_path = os.path.join(ep, "meta.json")
            g = "日常"
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    g = (json.load(f).get("group") or "日常")
            except Exception:
                pass
            if g == group:
                n += 1
        elif group == "日常" and entry.endswith(".json") and not entry.endswith(".tmp"):
            n += 1  # 旧格式无 group 概念，归「日常」
    return n


def set_project_workdir(group, path):
    """设置/解除项目外部目录。path 为 None/空串 = 解除（回落默认目录）。

    锁定规则（PLAN 1.5 三次定稿）：项目已有会话则目录冻结，换绑/回落都拒绝。
    """
    group = (group or "").strip()
    if not group:
        return {"error": "项目名不能为空"}
    n = count_project_sessions(group)
    if n > 0:
        return {"error": "项目「%s」已有 %d 个会话，目录已锁定（新项目在开始对话前可换绑）" % (group, n)}
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


def _quick_links():
    """快捷入口（桌面/文档/下载），存在的才返回。"""
    home = os.path.expanduser("~")
    quick = []
    for label, sub in (("桌面", "Desktop"), ("文档", "Documents"), ("下载", "Downloads")):
        fp = os.path.join(home, sub)
        if os.path.isdir(fp):
            quick.append({"name": label, "path": fp})
    return quick


def browse_dirs(path):
    """内联文件浏览器（目录选择器数据源）：只列子目录。

    path 为空 → 根视图：快捷入口 + 全部可用盘符。
    返回 {path, parent, quick, entries:[{name, path}]}；目录不可读返回 None。
    """
    if not path:
        drives = []
        for c in "CDEFGHIJKLMNOPQRSTUVWXYZ":
            d = "%s:\\" % c
            if os.path.isdir(d):
                drives.append({"name": c + ":", "path": d})
        return {"path": None, "parent": None, "quick": _quick_links(), "entries": drives}
    p = _norm_dir(path)
    if not p:
        return None
    entries = []
    try:
        with os.scandir(p) as it:
            for e in it:
                try:
                    if e.is_dir():
                        entries.append({"name": e.name, "path": os.path.join(p, e.name)})
                except OSError:
                    continue
    except OSError:
        return None
    entries.sort(key=lambda x: x["name"].lower())
    parent = os.path.dirname(p)
    if parent == p:
        parent = None
    return {"path": p, "parent": parent, "quick": _quick_links(), "entries": entries}


def upload_to_project(chat_name, filename, content):
    """用户显式上传材料到项目目录（不受 M1 只读边界限制——只读约束的是 AI）。

    不限扩展名（这是用户的材料架，能否被 LLM 消费是「引用」时的事），
    同名覆盖（与 /api/file_upload 一致）。返回 {ok, name, size} 或 {error}。
    """
    resolved = resolve_workdir(chat_name)
    root = resolved["workdir"]
    if not root:
        return {"error": "项目目录不可用"}
    base = os.path.basename(filename or "").strip()
    if not base or base != filename or base in (".", ".."):
        return {"error": "非法文件名"}
    from config import get as _cfg_get
    max_size = _cfg_get("upload_max_size") or 50 * 1024 * 1024
    if len(content) > max_size:
        return {"error": "文件过大（最大50MB）"}
    dst = os.path.join(root, base)
    try:
        with open(dst, "wb") as f:
            f.write(content)
    except OSError as e:
        log.warning("[PROJECT] 上传写入失败: %s", e)
        return {"error": "写入失败"}
    log.info("[PROJECT] 上传到项目目录: %s → %s（会话 %s）", base, root, chat_name)
    return {"ok": True, "name": base, "size": len(content)}


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
