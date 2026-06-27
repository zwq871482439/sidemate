# -*- coding: utf-8 -*-
"""
core/doc_session.py — Session Workspace + Completed 文档标记（Patch4 v3）
=========================================================================

Patch4 v3：Workspace 统一改造。
- workspace 是模型的舞台，文档只是 workspace 里的一种 .md 文件。
- 文档状态通过 `.md 文件存在性 + .completed.json 标记列表` 推断，不再有独立 DocSession。
- set_doc_status("xxx.md", "completed") 触发后端读 .md + 生成 .docx。

职责：
  1. workspace 路径安全：`safe_workspace_path()` 防止模型用 `../` 或绝对路径
     跳出 workspace 子目录
  2. workspace 文件操作：list / read / write / delete
  3. completed 文档标记：`mark_doc_completed` / `is_doc_completed` / `list_completed_docs`
     持久化到 `data/chats/{chat_id}/docs/.completed.json`（轻量级）

⚠️ workspace 安全边界（铁律）：
  - 模型只能在 `data/chats/{chat_id}/workspace/` 子目录内操作
  - 禁止 `../` 跳出
  - 禁止绝对路径
  - 禁止碰 `messages.json`、`meta.json`、`assets/`、`docs/`
  这些约束由 safe_workspace_path 在路径解析阶段强制保证。
"""

import os
import re
import json
import time
import logging
import threading

from config import CHAT_DIR

log = logging.getLogger(__name__)

# chat_id 合法格式：YYYY-MM-DD_NNN（与 chat.py:_is_safe_chat_id 保持一致）
# 用于 _chat_root 防路径穿越：拒绝包含 ../ 或其它非法字符的 chat_id
_CHAT_ID_RE = re.compile(r'^\d{4}-\d{2}-\d{2}_\d{3}$')


# ============================================================
#  路径安全
# ============================================================

def _chat_root(chat_id):
    """会话根目录：data/chats/{chat_id}

    校验 chat_id 格式（YYYY-MM-DD_NNN），防止通过 chat_id 注入 ../ 实现路径穿越。
    兼容 .json 后缀（部分调用点传入文件名而非目录名）。
    """
    if not chat_id:
        raise ValueError("缺少 chat_id")
    cid = chat_id.replace(".json", "")
    if not _CHAT_ID_RE.match(cid):
        raise ValueError("非法 chat_id 格式: %s" % chat_id)
    return os.path.join(CHAT_DIR, chat_id)


def _workspace_root(chat_id):
    """workspace 根目录：data/chats/{chat_id}/workspace"""
    return os.path.join(_chat_root(chat_id), "workspace")


def _docs_root(chat_id):
    """docs 根目录：data/chats/{chat_id}/docs"""
    return os.path.join(_chat_root(chat_id), "docs")


def safe_workspace_path(chat_id, rel_path):
    """解析 workspace 相对路径为绝对路径，并校验是否越界。

    安全规则：
      - rel_path 必须是相对路径（禁止绝对路径）
      - 规范化后的绝对路径必须位于 workspace_root 之内
      - 禁止 `../` 跳出

    Args:
        chat_id: 会话 ID（文件夹名）
        rel_path: 相对 workspace/ 的路径（如 "outline.md"、"drafts/v1.md"）

    Returns:
        str: 校验通过后的绝对路径

    Raises:
        ValueError: 路径越界或非法时
    """
    if not chat_id:
        raise ValueError("缺少 chat_id")

    if not rel_path:
        raise ValueError("缺少 path")

    # 禁止绝对路径（Windows 盘符 / UNC / POSIX 绝对路径）
    if os.path.isabs(rel_path):
        raise ValueError("禁止绝对路径: %s" % rel_path)

    # 禁止 null byte
    if "\x00" in rel_path:
        raise ValueError("非法路径（含 null byte）")

    workspace_root = _workspace_root(chat_id)
    # normpath 规范化，处理 ./ ../ 等
    abs_path = os.path.normpath(os.path.join(workspace_root, rel_path))

    # 必须以 workspace_root 为前缀（含恰好等于 root 的情况）
    if abs_path != workspace_root and not abs_path.startswith(workspace_root + os.sep):
        raise ValueError("路径越界: %s" % rel_path)

    return abs_path


# ============================================================
#  workspace 文件操作
# ============================================================

def list_workspace_files(chat_id):
    """列出 workspace 下所有文件（递归），返回文件名 + 大小。

    Returns:
        list[dict]: [{"name": 相对路径, "size": 字节数}, ...]
    """
    root = _workspace_root(chat_id)
    if not os.path.isdir(root):
        return []

    result = []
    for dirpath, _dirs, files in os.walk(root):
        for fname in files:
            abs_fp = os.path.join(dirpath, fname)
            try:
                size = os.path.getsize(abs_fp)
            except OSError:
                size = 0
            rel = os.path.relpath(abs_fp, root)
            # 统一用正斜杠，跨平台展示
            rel = rel.replace(os.sep, "/")
            result.append({"name": rel, "size": size})

    result.sort(key=lambda x: x["name"])
    return result


def read_workspace_file(chat_id, rel_path):
    """读取 workspace 内的文件。

    Returns:
        dict: {"name", "content", "size"}
    Raises:
        ValueError: 路径越界
        FileNotFoundError: 文件不存在
    """
    abs_path = safe_workspace_path(chat_id, rel_path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError("文件不存在: %s" % rel_path)

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()
    return {
        "name": rel_path,
        "content": content,
        "size": len(content.encode("utf-8")),
    }


def write_workspace_file(chat_id, rel_path, content):
    """写入文件到 workspace（自动创建子目录）。

    Args:
        chat_id: 会话 ID
        rel_path: 相对 workspace/ 的路径
        content: 文本内容

    Returns:
        dict: {"name", "size"}
    Raises:
        ValueError: 路径越界
    """
    abs_path = safe_workspace_path(chat_id, rel_path)

    # 自动创建子目录
    parent = os.path.dirname(abs_path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)

    # 写入（文本 utf-8）
    data = content.encode("utf-8") if isinstance(content, str) else content
    with open(abs_path, "wb") as f:
        f.write(data)

    return {
        "name": rel_path,
        "size": len(data),
    }


def append_workspace_file(chat_id, rel_path, content):
    """Patch4 v3.1：向 workspace 文件追加内容（不覆盖原文）。

    用于续写长文档场景：模型只需传新章节内容，不用 read 回原文再 write。
    文件不存在时自动创建（行为等同于 write_workspace_file）。

    Args:
        chat_id: 会话 ID
        rel_path: 相对 workspace/ 的路径
        content: 追加的文本内容

    Returns:
        dict: {"name", "size": 追加后总字节数, "appended": 本次追加字节数}
    Raises:
        ValueError: 路径越界
    """
    abs_path = safe_workspace_path(chat_id, rel_path)

    # 自动创建子目录
    parent = os.path.dirname(abs_path)
    if parent and not os.path.isdir(parent):
        os.makedirs(parent, exist_ok=True)

    data = content.encode("utf-8") if isinstance(content, str) else content
    old_size = os.path.getsize(abs_path) if os.path.exists(abs_path) else 0

    # 追加（如需换行分隔：原文件非空且不以 \n 结尾时补一个）
    with open(abs_path, "ab") as f:
        if old_size > 0:
            with open(abs_path, "rb") as _fchk:
                _fchk.seek(-1, 2)
                _last = _fchk.read(1)
            if _last not in (b"\n", b"\r"):
                f.write(b"\n\n")
        f.write(data)

    new_size = os.path.getsize(abs_path)
    return {
        "name": rel_path,
        "size": new_size,
        "appended": len(data),
    }


def edit_workspace_file(chat_id, rel_path, old_text, new_text):
    """Patch4 v3.1：对 workspace 文件做精准替换（不重写全文）。

    用于修改文档的某段内容，避免 read+write 整文件浪费 token。
    old_text 必须在文件中唯一存在，否则返回 not_found 错误。

    Args:
        chat_id: 会话 ID
        rel_path: 相对 workspace/ 的路径
        old_text: 要替换的原文（必须精确匹配，区分大小写）
        new_text: 替换后的内容

    Returns:
        dict: {"name", "size", "replaced": 替换次数}
    Raises:
        ValueError: 路径越界 / 文件不存在 / old_text 未找到
    """
    abs_path = safe_workspace_path(chat_id, rel_path)
    if not os.path.exists(abs_path):
        raise ValueError("文件不存在: %s" % rel_path)

    with open(abs_path, "r", encoding="utf-8") as f:
        content = f.read()

    count = content.count(old_text)
    if count == 0:
        raise ValueError("未找到要替换的原文（请检查 old_text 是否精确匹配）")
    if count > 1:
        # 多次匹配时也替换（全部），但告知模型有多次匹配
        pass

    new_content = content.replace(old_text, new_text)

    data = new_content.encode("utf-8")
    with open(abs_path, "wb") as f:
        f.write(data)

    return {
        "name": rel_path,
        "size": len(data),
        "replaced": count,
    }


def delete_workspace_file(chat_id, rel_path):
    """删除 workspace 内的文件（不删目录）。

    Returns:
        dict: {"name", "deleted": True}
    Raises:
        ValueError: 路径越界
        FileNotFoundError: 文件不存在
    """
    abs_path = safe_workspace_path(chat_id, rel_path)
    if not os.path.isfile(abs_path):
        raise FileNotFoundError("文件不存在: %s" % rel_path)
    os.remove(abs_path)
    return {"name": rel_path, "deleted": True}


# ============================================================
#  Completed 文档标记（轻量级持久化）
# ============================================================
# Patch4 v3：替代旧的 DocSession。文档状态由
#   - workspace 里的 .md 文件存在性
#   - .completed.json 标记列表
# 推断。.completed.json 仅记录已完结的文件名 + 时间，不存正文。

_COMPLETED_LOCK = threading.Lock()


def _completed_json_path(chat_id):
    """completed 标记文件路径：data/chats/{chat_id}/docs/.completed.json"""
    return os.path.join(_docs_root(chat_id), ".completed.json")


def _load_completed(chat_id):
    """读取 .completed.json，返回 dict（不存在则空 dict）。"""
    path = _completed_json_path(chat_id)
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except Exception as e:
        log.warning("[DOC_SESSION] 加载 .completed.json 失败: %s", str(e)[:100])
    return {}


def _save_completed(chat_id, data):
    """原子写入 .completed.json。"""
    docs_dir = _docs_root(chat_id)
    if not os.path.isdir(docs_dir):
        os.makedirs(docs_dir, exist_ok=True)
    path = _completed_json_path(chat_id)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    os.replace(tmp, path)


def mark_doc_completed(chat_id, filename):
    """把某个 .md 文档标记为 completed（同时记录 docx_generated=True）。

    Args:
        chat_id: 会话 ID
        filename: workspace 里的 .md 文件名（如 "团队协作.md"）

    Returns:
        dict: 该文档的标记信息
    """
    if not chat_id or not filename:
        return {}
    with _COMPLETED_LOCK:
        data = _load_completed(chat_id)
        entry = {
            "completed_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "docx_generated": True,
        }
        data[filename] = entry
        _save_completed(chat_id, data)
    log.info("[DOC_SESSION] mark_doc_completed: chat=%s file=%s", chat_id, filename)
    return entry


def is_doc_completed(chat_id, filename):
    """查询某个 .md 文档是否已 completed。"""
    if not chat_id or not filename:
        return False
    with _COMPLETED_LOCK:
        data = _load_completed(chat_id)
    return filename in data


def list_completed_docs(chat_id):
    """列出该会话所有已 completed 的 .md 文档（仅文件名列表）。

    Returns:
        list[str]: 已 completed 的文件名（如 ["团队协作.md", "会议纪要.md"]）
    """
    if not chat_id:
        return []
    with _COMPLETED_LOCK:
        data = _load_completed(chat_id)
    return list(data.keys())


def chat_id_from_path(chat_file):
    """从 chat_file 完整路径推导 chat_id（文件夹名）。

    Args:
        chat_file: 形如 `data/chats/2026-06-15_001/` 或
                   `data/chats/2026-06-15_001/messages.json` 或
                   `data/chats/2026-06-15_001/meta.json`

    Returns:
        str: chat_id（会话文件夹名）
    """
    if not chat_file:
        return ""
    p = os.path.normpath(chat_file)
    # 如果指向已知会话内文件（messages.json / meta.json / context_cache.json），
    # 或路径是一个已存在的文件，取其所在目录
    base = os.path.basename(p)
    if base in ("messages.json", "meta.json", "context_cache.json") or (
        base and os.path.isfile(p)
    ):
        p = os.path.dirname(p)
    # 去掉末尾分隔符后取 basename 即 chat_id
    return os.path.basename(p.rstrip(os.sep))
