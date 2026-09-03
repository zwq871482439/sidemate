# -*- coding: utf-8 -*-
"""
session/projects.py — 项目注册表与目录服务（0.10.1「项目即文件夹」四次定稿）

核心模型：项目 = 文件夹。文件夹即项目本体——无换绑（换文件夹=另一个项目）、
无锁定（目录不变性由模型保证）。项目名=文件夹名，显示名可改（存注册表）。

存储分层：
  data/               只存会话记录（messages/meta）+ 工具链记录
  data/projects/默认项目/   默认项目目录（不可删，永远默认）
  <项目目录>/.sidemate/     产物区（AI 产物/生成物，与用户材料分离）
  用户上传的材料进项目根（用户的架子）

注册表 data/projects.json（v2）：
  {"version": 2, "projects": [{"dir": 绝对路径, "display": 显示名, "created_at": ...}]}
  旧 v1（项目名 keyed dict）加载时自动迁移：dir=外部 workdir 或 默认根/<名>。

旧版会话：meta 无 project_dir（有 group 或都没有）→ 只读桶，见 is_legacy_chat。
"""
import os
import json
import shutil
import time
import logging
import threading

from config import (
    DATA_DIR, CHAT_DIR, PROJECTS_ROOT,
    DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_DIR, PROJECT_ARTIFACT_DIR,
)
from common.utils import atomic_write_json

log = logging.getLogger(__name__)

PROJECTS_FILE = os.path.join(DATA_DIR, "projects.json")
_lock = threading.Lock()

# 与 /api/file_upload 同一份白名单（能被 LLM 消费的类型）
ALLOWED_REF_EXTS = {
    ".txt", ".md", ".csv", ".docx", ".xlsx", ".pdf",
    ".epub", ".html", ".htm", ".srt",
}


# ============================================================
#  注册表读写（含 v1 → v2 迁移）
# ============================================================

def _norm(path):
    if not path or not isinstance(path, str):
        return None
    p = os.path.normpath(path.strip().strip('"'))
    return p if os.path.isabs(p) else None


def _load():
    """读注册表；旧 v1 格式（{项目名: {workdir}}）自动迁移为 v2。"""
    try:
        with open(PROJECTS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception:
        return {"version": 2, "projects": []}
    if isinstance(data, dict) and data.get("version") == 2:
        lst = data.get("projects")
        return {"version": 2, "projects": lst if isinstance(lst, list) else []}
    if isinstance(data, dict):  # v1 迁移
        migrated = []
        for name, entry in data.items():
            if not isinstance(entry, dict):
                continue
            ext = _norm(entry.get("workdir"))
            d = ext if (ext and os.path.isdir(ext)) else os.path.join(PROJECTS_ROOT, name)
            migrated.append({
                "dir": d,
                "display": name,
                "created_at": entry.get("created_at") or entry.get("updated_at") or "",
            })
        out = {"version": 2, "projects": migrated}
        _save(out)
        log.info("[PROJECT] 注册表 v1→v2 迁移：%d 个项目", len(migrated))
        return out
    return {"version": 2, "projects": []}


def _save(data):
    atomic_write_json(PROJECTS_FILE, data)


def _find(data, dir_path):
    """按目录找注册条目（realpath 比较，容忍大小写/斜杠差异）。"""
    target = os.path.normcase(os.path.realpath(dir_path))
    for p in data["projects"]:
        d = _norm(p.get("dir"))
        if d and os.path.normcase(os.path.realpath(d)) == target:
            return p
    return None


# ============================================================
#  项目 CRUD
# ============================================================

def list_projects():
    """全部项目：默认项目永远在最前。每项 {dir, display, is_default, status}。

    status: ok | missing（目录在磁盘上被删/挪动 → 失效态）
    """
    try:
        os.makedirs(DEFAULT_PROJECT_DIR, exist_ok=True)
    except OSError:
        pass
    out = [{
        "dir": DEFAULT_PROJECT_DIR,
        "display": DEFAULT_PROJECT_NAME,
        "is_default": True,
        "status": "ok" if os.path.isdir(DEFAULT_PROJECT_DIR) else "missing",
    }]
    for p in _load()["projects"]:
        d = _norm(p.get("dir"))
        if not d:
            continue
        out.append({
            "dir": d,
            "display": p.get("display") or os.path.basename(d),
            "is_default": False,
            "status": "ok" if os.path.isdir(d) else "missing",
            "created_at": p.get("created_at", ""),
        })
    return out


def create_project_blank(name):
    """新建空白项目：默认根下建文件夹，文件夹名即项目名。返回 {ok, project} 或 {error}。"""
    from session.chat_store import safe_chat_name
    safe = safe_chat_name((name or "").strip())
    if not safe or safe == DEFAULT_PROJECT_NAME:
        return {"error": "项目名不能为空、非法或与默认项目重名"}
    d = os.path.join(PROJECTS_ROOT, safe)
    if os.path.exists(d):
        return {"error": "已存在同名文件夹「%s」" % safe}
    with _lock:
        data = _load()
        if _find(data, d):
            return {"error": "项目「%s」已存在" % safe}
        try:
            os.makedirs(d)
            os.makedirs(os.path.join(d, PROJECT_ARTIFACT_DIR), exist_ok=True)
        except OSError as e:
            return {"error": "创建目录失败: %s" % e}
        entry = {"dir": d, "display": safe,
                 "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        data["projects"].append(entry)
        _save(data)
        log.info("[PROJECT] 新建空白项目: %s", d)
        return {"ok": True, "project": {"dir": d, "display": safe}}


def create_project_external(path):
    """使用现有文件夹作为项目：文件夹名=项目名。返回 {ok, project} 或 {error}。"""
    d = _norm(path)
    if not d or not os.path.isdir(d):
        return {"error": "目录不存在或不是绝对路径"}
    if os.path.normcase(os.path.realpath(d)) == os.path.normcase(os.path.realpath(DEFAULT_PROJECT_DIR)):
        return {"error": "该目录就是默认项目"}
    with _lock:
        data = _load()
        if _find(data, d):
            return {"error": "该文件夹已经是项目「%s」" % _find(data, d).get("display", "")}
        entry = {"dir": d, "display": os.path.basename(d.rstrip("\\/")) or d,
                 "created_at": time.strftime("%Y-%m-%d %H:%M:%S")}
        data["projects"].append(entry)
        _save(data)
    try:
        os.makedirs(os.path.join(d, PROJECT_ARTIFACT_DIR), exist_ok=True)
    except OSError:
        pass
    log.info("[PROJECT] 注册现有文件夹为项目: %s", d)
    return {"ok": True, "project": {"dir": d, "display": entry["display"]}}


def rename_project(dir_path, display):
    """改项目显示名（不改目录名——目录是项目本体）。"""
    display = (display or "").strip()
    if not display:
        return {"error": "显示名不能为空"}
    d = _norm(dir_path)
    if not d:
        return {"error": "非法项目目录"}
    if os.path.normcase(os.path.realpath(d)) == os.path.normcase(os.path.realpath(DEFAULT_PROJECT_DIR)):
        return {"error": "默认项目不可改名"}
    with _lock:
        data = _load()
        entry = _find(data, d)
        if not entry:
            return {"error": "项目未注册"}
        entry["display"] = display
        _save(data)
    return {"ok": True, "display": display}


def delete_project(dir_path):
    """删除项目：注册表移除 + 返回该项目下的会话名列表（级联删记录由调用方做）。

    目录与文件一个字节不动。默认项目拒绝。
    """
    d = _norm(dir_path)
    if not d:
        return {"error": "非法项目目录"}
    if os.path.normcase(os.path.realpath(d)) == os.path.normcase(os.path.realpath(DEFAULT_PROJECT_DIR)):
        return {"error": "默认项目不可删除"}
    with _lock:
        data = _load()
        entry = _find(data, d)
        data["projects"] = [p for p in data["projects"] if p is not entry]
        _save(data)
    # 找该项目的会话（新模型按 meta.project_dir）
    sessions = []
    try:
        for e in os.listdir(CHAT_DIR):
            meta_path = os.path.join(CHAT_DIR, e, "meta.json")
            if not os.path.isfile(meta_path):
                continue
            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
            except Exception:
                continue
            pd = meta.get("project_dir")
            if pd and os.path.normcase(os.path.realpath(pd)) == os.path.normcase(os.path.realpath(d)):
                sessions.append(e)
    except OSError:
        pass
    log.info("[PROJECT] 删除项目: %s（%d 个会话记录待级联删）", d, len(sessions))
    return {"ok": True, "sessions": sessions, "display": (entry or {}).get("display", "")}


# ============================================================
#  会话 ↔ 项目解析
# ============================================================

def read_chat_meta(chat_name):
    from session import chat_store
    return chat_store.read_meta(chat_name)


def is_legacy_chat(chat_name):
    """旧版会话：meta 无 project_dir（旧模型 group 或更老格式）→ 只读桶。"""
    meta = read_chat_meta(chat_name)
    if not meta:
        return False  # 读不到 meta 的不算（新建流程中）
    return not meta.get("project_dir")


def resolve_chat_project(chat_name):
    """解析会话所属项目。

    返回 {"dir", "display", "is_default", "status", "legacy": False}
    旧版会话返回 {"legacy": True}。
    """
    meta = read_chat_meta(chat_name)
    if not meta:
        return {"legacy": False, "dir": None, "display": "", "is_default": False,
                "status": "missing"}
    pd = meta.get("project_dir")
    if not pd:
        return {"legacy": True}
    d = _norm(pd) or DEFAULT_PROJECT_DIR
    is_default = os.path.normcase(os.path.realpath(d)) == os.path.normcase(os.path.realpath(DEFAULT_PROJECT_DIR))
    if is_default:
        try:
            os.makedirs(d, exist_ok=True)  # 默认项目目录永远存在
        except OSError:
            pass
    display = DEFAULT_PROJECT_NAME if is_default else os.path.basename(d.rstrip("\\/"))
    if not is_default:
        entry = _find(_load(), d)
        if entry and entry.get("display"):
            display = entry["display"]
    return {
        "legacy": False,
        "dir": d,
        "display": display,
        "is_default": is_default,
        "status": "ok" if os.path.isdir(d) else "missing",
    }


def is_in_any_project_dir(path):
    """path（realpath）是否落在默认项目或任一注册项目目录内（chat.py file_path 白名单用）。"""
    try:
        rp = os.path.normcase(os.path.realpath(path))
    except Exception:
        return False
    for p in list_projects():
        if p["status"] != "ok":
            continue
        base = os.path.normcase(os.path.realpath(p["dir"]))
        if rp == base or rp.startswith(base + os.sep):
            return True
    return False


# ============================================================
#  目录内容（只读列举 / 引用直读 / 上传）
# ============================================================

def list_dir_entries(path, limit=500):
    """只读列目录（顶层）：名称/大小/修改时间/是否目录。目录优先，按名称排。"""
    p = _norm(path)
    if not p or not os.path.isdir(p):
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
    p = _norm(path)
    if not p or not os.path.isdir(p):
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


def reference_file(chat_name, name):
    """引用项目目录文件（直读不复制）：校验 + token 实估，返回原路径。

    name 支持顶层文件名或 ".sidemate/xxx"（产物区）。
    返回 {path（原始路径）, filename, size, tokens} 或 {error}。
    发送时 chat.py 的 file_path 白名单由 is_in_any_project_dir 放行。
    """
    proj = resolve_chat_project(chat_name)
    if proj.get("legacy") or not proj.get("dir"):
        return {"error": "旧版会话不支持引用项目目录"}
    root = proj["dir"]
    rel = (name or "").replace("/", os.sep).lstrip(os.sep)
    base_check = rel.split(os.sep)
    if any(seg in ("", ".", "..") for seg in base_check):
        return {"error": "非法文件名"}
    if len(base_check) > 2 or (len(base_check) == 2 and base_check[0] != PROJECT_ARTIFACT_DIR):
        return {"error": "只能引用项目目录顶层或产物区文件"}
    src = os.path.normpath(os.path.join(root, rel))
    if not src.startswith(os.path.normpath(root) + os.sep) or not os.path.isfile(src):
        return {"error": "文件不存在"}
    ext = os.path.splitext(src)[1].lower()
    if ext not in ALLOWED_REF_EXTS:
        return {"error": "不支持的文件类型: %s" % (ext or "(无扩展名)")}
    size = os.path.getsize(src)
    tokens = 0
    try:
        from knowledge.file_extractor import process_uploaded_file
        info = process_uploaded_file(src, "", max_chars=10**9)
        if info.get("status") in ("ok", "truncated"):
            text = info.get("text", "")
            cn = sum(1 for c in text if '\u4e00' <= c <= '\u9fff')
            tokens = int(cn / 1.5 + (len(text) - cn) / 4.0)
    except Exception as e:
        log.warning("[PROJECT] 引用 token 估算失败: %s", str(e)[:80])
    log.info("[PROJECT] 引用目录文件（直读）: %s ← 会话 %s", rel, chat_name)
    return {"path": src, "filename": os.path.basename(src), "size": size, "tokens": tokens}


# ============================================================
#  项目交接 handoff.md（PLAN ②++：平滑 session 移动主通道）
# ============================================================

HANDOFF_NAME = "handoff.md"
HANDOFF_MAX_INJECT = 2000      # 注入 prompt 的截断上限
HANDOFF_LOG_KEEP = 5           # 历史一行式日志保留条数


def _handoff_file(project_dir):
    return os.path.join(project_dir, PROJECT_ARTIFACT_DIR, HANDOFF_NAME)


def read_handoff(project_dir):
    """读项目交接。返回 {content, updated_at, source_engine, source_chat} 或 None。"""
    p = _norm(project_dir)
    if not p:
        return None
    f = _handoff_file(p)
    if not os.path.isfile(f):
        return None
    try:
        with open(f, "r", encoding="utf-8") as fh:
            raw = fh.read()
    except OSError:
        return None
    meta = {"content": raw, "updated_at": "", "source_engine": "", "source_chat": ""}
    if raw.startswith("<!--"):
        end = raw.find("-->")
        if end > 0:
            header = raw[4:end]
            # 头格式：source_engine: X | source_chat: Y | updated: Z（单行管道分隔）
            for seg in header.split("|"):
                if ":" in seg:
                    k, v = seg.split(":", 1)
                    k, v = k.strip(), v.strip()
                    if k == "source_engine":
                        meta["source_engine"] = v
                    elif k == "source_chat":
                        meta["source_chat"] = v
                    elif k == "updated":
                        meta["updated_at"] = v
            meta["content"] = raw[end + 3:].lstrip("\n")
    return meta


def write_handoff(project_dir, content, source_engine, source_chat, log_line=""):
    """写项目交接（重写制：全文覆盖 + 保留最近 5 条一行式历史）。

    返回 {ok} 或 {error}。
    """
    p = _norm(project_dir)
    if not p or not os.path.isdir(p):
        return {"error": "项目目录不可用"}
    # 旧历史区保留
    history = []
    old = read_handoff(p)
    if old and old.get("content"):
        m = old["content"].split("\n---\n## 历史", 1)
        if len(m) == 2:
            for ln in m[1].splitlines():
                ln = ln.strip()
                if ln.startswith("- "):
                    history.append(ln)
    if log_line:
        history.append("- " + log_line)
    history = history[-HANDOFF_LOG_KEEP:]
    body = (content or "").strip()
    # 防御：模型把历史区也写进来时剥掉（历史由我们维护）
    if "\n---\n## 历史" in body:
        body = body.split("\n---\n## 历史", 1)[0].rstrip()
    ts = time.strftime("%Y-%m-%d %H:%M")
    header = "<!-- source_engine: %s | source_chat: %s | updated: %s -->\n" % (
        source_engine or "unknown", source_chat or "", ts)
    out = header + body
    if history:
        out += "\n\n---\n## 历史\n" + "\n".join(history) + "\n"
    art_dir = os.path.join(p, PROJECT_ARTIFACT_DIR)
    try:
        os.makedirs(art_dir, exist_ok=True)
        with open(_handoff_file(p), "w", encoding="utf-8") as f:
            f.write(out)
    except OSError as e:
        return {"error": "写入失败: %s" % e}
    log.info("[PROJECT] 交接已写入: %s（来源会话 %s）", _handoff_file(p), source_chat)
    return {"ok": True, "updated_at": ts}


def build_handoff_prompt(chat_name, old_content):
    """交接生成 prompt（五段式，≤1500 字，重写制）。"""
    from session.chat_store import load_chat
    from config import CHAT_DIR
    msgs = []
    try:
        msgs = load_chat(os.path.join(CHAT_DIR, chat_name)) or []
    except Exception:
        pass
    # 取最近 16 条，逐条截断，总量 ~6000 字
    recent = msgs[-16:]
    parts = []
    total = 0
    for m in recent:
        role = "用户" if m.get("role") == "user" else "AI"
        c = (m.get("content") or "").strip()
        if not c:
            continue
        c = c[:800]
        parts.append("%s: %s" % (role, c))
        total += len(c)
        if total > 6000:
            break
    transcript = "\n\n".join(parts)
    return (
        "你是项目交接撰写器。根据下面的旧交接（如有）和本会话对话，重写一份项目交接文件。\n"
        "要求：\n"
        "1. 严格五段结构：【项目目标】一句话【已确认的决定】逐条【当前进度】做到哪了"
        "【待办下一步】逐条【关键文件】清单（没有就写无）\n"
        "2. 全文不超过 1500 字，只写有行动价值的信息，不要复述对话过程\n"
        "3. 旧交接里仍然成立的内容保留并整合，过时的替换，不要简单堆叠\n"
        "4. 直接输出交接正文（markdown），不要任何解释、不要写历史区\n\n"
        + ("【旧交接】\n%s\n\n" % old_content[:3000] if old_content else "")
        + "【本会话对话】\n%s" % transcript
    )


def save_artifact(chat_name, filename, content):
    """卡片「存产物」：写 <项目目录>/.sidemate/<filename>（用户显式动作，豁免只读边界）。

    文本内容（CSV/SVG/Markdown 等），5MB 上限，同名覆盖。返回 {ok, name, path} 或 {error}。
    """
    proj = resolve_chat_project(chat_name)
    if proj.get("legacy") or not proj.get("dir"):
        return {"error": "旧版会话不支持存产物"}
    base = os.path.basename(filename or "").strip()
    if not base or base != filename or base in (".", ".."):
        return {"error": "非法文件名"}
    if isinstance(content, str):
        data = content.encode("utf-8")
    else:
        data = bytes(content or b"")
    if len(data) > 5 * 1024 * 1024:
        return {"error": "内容过大（最大5MB）"}
    art_dir = os.path.join(proj["dir"], PROJECT_ARTIFACT_DIR)
    try:
        os.makedirs(art_dir, exist_ok=True)
        with open(os.path.join(art_dir, base), "wb") as f:
            f.write(data)
    except OSError as e:
        log.warning("[PROJECT] 存产物失败: %s", e)
        return {"error": "写入失败"}
    log.info("[PROJECT] 存产物: %s → %s（会话 %s）", base, art_dir, chat_name)
    return {"ok": True, "name": base}


def upload_to_project(chat_name, filename, content):
    """用户显式上传材料到项目根（用户的架子；AI 产物才进 .sidemate/）。

    不限扩展名，50MB 上限，同名覆盖。返回 {ok, name, size} 或 {error}。
    """
    proj = resolve_chat_project(chat_name)
    if proj.get("legacy") or not proj.get("dir"):
        return {"error": "旧版会话不支持上传到项目目录"}
    root = proj["dir"]
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
