# -*- coding: utf-8 -*-
"""
core/doc_session.py — 文档状态化 + Session Workspace
=====================================================

Patch4 修复 1（A 层基础设施）。

职责：
  1. DocSession：管理单个文档的状态（章节、状态、时间戳），持久化到
     `data/chats/{chat_id}/docs/{doc_id}.json`
  2. workspace 路径安全：`safe_workspace_path()` 防止模型用 `../` 或绝对路径
     跳出 workspace 子目录
  3. workspace 文件操作：list / read / write / delete

⚠️ workspace 安全边界（铁律）：
  - 模型只能在 `data/chats/{chat_id}/workspace/` 子目录内操作
  - 禁止 `../` 跳出
  - 禁止绝对路径
  - 禁止碰 `messages.json`、`meta.json`、`assets/`、`docs/`
  这些约束由 safe_workspace_path 在路径解析阶段强制保证。
"""

import os
import json
import time
import logging
import threading

from config import CHAT_DIR

log = logging.getLogger(__name__)


# ============================================================
#  路径安全
# ============================================================

def _chat_root(chat_id):
    """会话根目录：data/chats/{chat_id}"""
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
#  DocSession — 单个文档的状态管理
# ============================================================

class DocSession:
    """管理单个文档的状态：章节列表 + 状态 + 时间戳。

    持久化到 `data/chats/{chat_id}/docs/{doc_id}.json`。

    线程安全：每个实例有自己的锁。
    """

    def __init__(self, chat_id, doc_id, topic=""):
        self.chat_id = chat_id
        self.doc_id = doc_id
        self.topic = topic
        self._lock = threading.Lock()
        self._data = {
            "doc_id": doc_id,
            "topic": topic,
            "status": "ongoing",
            "sections": [],
            "created_at": time.strftime("%Y-%m-%d %H:%M:%S"),
            "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        self._loaded = False

    # ---------- 路径 ----------
    def _json_path(self):
        return os.path.join(_docs_root(self.chat_id), "%s.json" % self.doc_id)

    def _ensure_docs_dir(self):
        docs_dir = _docs_root(self.chat_id)
        if not os.path.isdir(docs_dir):
            os.makedirs(docs_dir, exist_ok=True)

    # ---------- 持久化 ----------
    def load(self):
        """从磁盘加载状态（如果存在）。不存在则保留初始状态。"""
        with self._lock:
            path = self._json_path()
            if os.path.isfile(path):
                try:
                    with open(path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    if isinstance(data, dict):
                        # 合并已知字段
                        self._data["topic"] = data.get("topic", self.topic)
                        self._data["status"] = data.get("status", "ongoing")
                        self._data["sections"] = list(data.get("sections", []))
                        self._data["created_at"] = data.get(
                            "created_at", self._data["created_at"])
                        self._data["updated_at"] = data.get(
                            "updated_at", self._data["updated_at"])
                        if self.topic:
                            # 实例显式指定的 topic 优先
                            self._data["topic"] = self.topic
                except Exception as e:
                    log.warning("[DOC_SESSION] 加载失败 %s: %s", self.doc_id, str(e)[:100])
            self._loaded = True
        return self

    def save(self):
        """落盘（原子写入）。"""
        with self._lock:
            self._ensure_docs_dir()
            self._data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            path = self._json_path()
            tmp = path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(self._data, f, ensure_ascii=False, indent=2)
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            os.replace(tmp, path)

    # ---------- 章节操作 ----------
    def add_section(self, heading, content):
        """追加一个章节并立即落盘。

        Returns:
            dict: 当前章节信息 + 总章节数
        """
        section = {
            "heading": heading,
            "content": content,
            "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        }
        with self._lock:
            self._data["sections"].append(section)
        self.save()
        return {
            "heading": heading,
            "index": len(self._data["sections"]),
            "total_sections": len(self._data["sections"]),
        }

    def list_sections(self):
        """返回章节列表（仅 heading + 长度，不含正文，避免注入泄漏）。"""
        with self._lock:
            return [
                {
                    "heading": s.get("heading", ""),
                    "length": len(s.get("content", "")),
                }
                for s in self._data["sections"]
            ]

    # ---------- 状态 ----------
    def set_status(self, status):
        """更新文档状态。status 必须是 ongoing / completed。"""
        if status not in ("ongoing", "completed"):
            raise ValueError("非法状态: %s" % status)
        with self._lock:
            self._data["status"] = status
        self.save()
        return {"doc_id": self.doc_id, "status": status}

    def get_status(self):
        with self._lock:
            return self._data["status"]

    def get_topic(self):
        with self._lock:
            return self._data.get("topic", "")

    def to_dict(self):
        with self._lock:
            # 返回浅拷贝，避免外部修改内部状态
            return {
                "doc_id": self._data["doc_id"],
                "topic": self._data["topic"],
                "status": self._data["status"],
                "sections": list(self._data["sections"]),
                "created_at": self._data["created_at"],
                "updated_at": self._data["updated_at"],
            }


# ============================================================
#  会话级工具：列出所有文档（用于上下文注入）
# ============================================================

def list_docs_in_chat(chat_id):
    """列出某个会话下的所有文档状态（用于上下文注入）。

    只返回概览信息（标题 + 章节数 + 状态），不返回正文。

    Returns:
        list[dict]: [{"doc_id", "topic", "sections", "status"}, ...]
    """
    docs_dir = _docs_root(chat_id)
    if not os.path.isdir(docs_dir):
        return []

    result = []
    for fname in os.listdir(docs_dir):
        if not fname.endswith(".json"):
            continue
        path = os.path.join(docs_dir, fname)
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                continue
            result.append({
                "doc_id": data.get("doc_id", fname[:-5]),
                "topic": data.get("topic", ""),
                "sections": len(data.get("sections", [])),
                "status": data.get("status", "ongoing"),
            })
        except Exception:
            continue

    return result


def gen_doc_id():
    """生成文档 ID：doc_YYYYMMDD_HHMMSS"""
    return "doc_" + time.strftime("%Y%m%d_%H%M%S")


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
