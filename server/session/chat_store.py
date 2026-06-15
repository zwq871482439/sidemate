# -*- coding: utf-8 -*-
"""
session/chat_store.py — 对话文件管理（文件夹格式 + 旧格式兼容）

从 routers/chat.py 提取的对话持久化函数：
  - safe_chat_name   — 对话名称安全校验
  - today_str        — 获取当天日期字符串
  - new_chat_file    — 创建新对话文件（线程安全）
  - save_chat        — 保存对话（线程安全）
  - load_chat        — 加载对话消息
  - load_chat_cache  — 加载 context_cache
  - list_chats       — 列出所有对话
  - migrate_chats    — 启动时触发迁移
"""
import os
import re
import json
import time
import logging
import threading
import glob as _glob
import shutil
from datetime import datetime

from config import CHAT_DIR
from routers.deps import (
    get_current_chat_file,
    get_current_chat,
    set_current_chat,
)

log = logging.getLogger(__name__)

# ===== 对话保存并发保护 =====
_chat_save_lock = threading.Lock()
# P1-02: 新建对话文件的并发保护
_new_chat_lock = threading.Lock()

# 迁移标记（只迁移一次）
_migration_done = False
_migration_lock = threading.Lock()


def _ensure_migrated():
    """确保迁移已完成（只执行一次）"""
    global _migration_done
    if _migration_done:
        return
    with _migration_lock:
        if _migration_done:
            return
        try:
            from core.session_migrator import migrate_all
            migrate_all(CHAT_DIR)
        except Exception as e:
            log.warning("[CHAT_STORE] 迁移失败: %s", str(e)[:100])
        _migration_done = True


def _is_folder_session(path):
    """判断路径是否为文件夹格式的会话"""
    return os.path.isdir(path)


def _resolve_session_path(name_or_path):
    """解析会话路径（支持 .json 后缀和文件夹格式）

    Args:
        name_or_path: 会话名称或完整路径

    Returns:
        str: 解析后的完整路径（可能是 .json 文件或文件夹）
    """
    if os.path.isabs(name_or_path):
        return name_or_path

    # 先尝试文件夹
    folder_path = os.path.join(CHAT_DIR, name_or_path)
    if os.path.isdir(folder_path):
        return folder_path

    # 再尝试 .json 文件
    json_path = os.path.join(CHAT_DIR, name_or_path + ".json")
    if os.path.isfile(json_path):
        return json_path

    return folder_path  # 默认返回文件夹路径


def safe_chat_name(chat_name: str):
    """防止对话 API 路径遍历（P2-A1: 白名单验证）"""
    if not chat_name:
        return None
    # P2-07: 检查 null byte
    if "\x00" in chat_name:
        return None
    # P2-A1: 白名单 — 只允许字母/数字/下划线/连字符/中文字符
    if not re.match(r'^[a-zA-Z0-9_\-\u4e00-\u9fff]+$', chat_name):
        return None
    return chat_name


def today_str():
    """获取当天日期字符串 (YYYY-MM-DD)"""
    return datetime.now().strftime("%Y-%m-%d")


def new_chat_file():
    """创建一个新的对话文件夹（线程安全）"""
    _ensure_migrated()

    with _new_chat_lock:
        today = today_str()
        # 扫描同一天的文件夹和 .json 文件
        existing_folders = _glob.glob(os.path.join(CHAT_DIR, "%s_*" % today))
        max_idx = 0
        for f in existing_folders:
            basename = os.path.basename(f)
            try:
                # 从 "2026-06-07_001" 或 "2026-06-07_001.json" 中提取编号
                idx_str = basename.replace(".json", "").split("_")[1]
                idx = int(idx_str)
                max_idx = max(max_idx, idx)
            except (ValueError, IndexError):
                pass

        idx = max_idx + 1
        folder_name = "%s_%03d" % (today, idx)
        folder_path = os.path.join(CHAT_DIR, folder_name)

        # 防止文件夹已被其他线程创建
        while os.path.exists(folder_path):
            idx += 1
            folder_name = "%s_%03d" % (today, idx)
            folder_path = os.path.join(CHAT_DIR, folder_name)

        # 创建文件夹结构
        os.makedirs(folder_path, exist_ok=True)
        assets_dir = os.path.join(folder_path, "assets")
        os.makedirs(assets_dir, exist_ok=True)

        # 写入 meta.json
        meta = {
            "id": folder_name,
            "title": folder_name,
            "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "message_count": 0,
            "version": 3,
        }
        meta_path = os.path.join(folder_path, "meta.json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)

        # 写入空的 messages.json
        msgs_path = os.path.join(folder_path, "messages.json")
        with open(msgs_path, "w", encoding="utf-8") as f:
            json.dump({"version": 3, "messages": []}, f, ensure_ascii=False, indent=2)

        set_current_chat(folder_path)
        log.info("[CHAT] new session: %s (format=v3 folder)", folder_name)
        return folder_path


def save_chat(filepath, messages, context_cache=None):
    """保存对话到文件（线程安全，兼容文件夹和 .json 格式）"""
    if not filepath:
        return

    _ensure_migrated()

    with _chat_save_lock:
        # 文件夹格式
        if _is_folder_session(filepath):
            _save_folder_session(filepath, messages, context_cache)
            return

        # 旧 .json 格式（向后兼容）
        _save_json_session(filepath, messages, context_cache)


def _save_folder_session(folder_path, messages, context_cache=None):
    """保存文件夹格式会话"""
    # 读取旧的 _file_tag（前端附加属性）
    msgs_path = os.path.join(folder_path, "messages.json")
    old_tags = {}
    if os.path.exists(msgs_path):
        try:
            with open(msgs_path, "r", encoding="utf-8") as f:
                old_data = json.load(f)
            old_msgs = old_data.get("messages", []) if isinstance(old_data, dict) else []
            for om in old_msgs:
                if om.get("role") == "user" and om.get("_file_tag"):
                    key = om.get("ts", "") + "|" + om.get("content", "")[:20]
                    old_tags[key] = om["_file_tag"]
        except Exception:
            pass

    # 合并 _file_tag
    if old_tags:
        for m in messages:
            if m.get("role") == "user" and not m.get("_file_tag"):
                key = m.get("ts", "") + "|" + m.get("content", "")[:20]
                tag = old_tags.get(key)
                if tag:
                    m["_file_tag"] = tag

    # 写入 messages.json（原子写入）
    msgs_data = {
        "version": 3,
        "messages": messages,
    }
    tmp_path = msgs_path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(msgs_data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, msgs_path)

    # 更新 meta.json
    meta_path = os.path.join(folder_path, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass
    meta["message_count"] = len(messages)
    meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    tmp_meta = meta_path + ".tmp"
    with open(tmp_meta, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_meta, meta_path)

    # 保存 context_cache
    if context_cache is not None:
        cache_path = os.path.join(folder_path, "context_cache.json")
        tmp_cache = cache_path + ".tmp"
        with open(tmp_cache, "w", encoding="utf-8") as f:
            json.dump(context_cache, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_cache, cache_path)


def _save_json_session(filepath, messages, context_cache=None):
    """保存旧 .json 格式会话（向后兼容）"""
    existing = {}
    if os.path.exists(filepath):
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                existing = raw
        except Exception:
            pass
    if context_cache is None:
        context_cache = existing.get("context_cache")
    # 合并 _file_tag
    old_msgs = existing.get("messages", [])
    if old_msgs:
        old_tags = {}
        for i, om in enumerate(old_msgs):
            if om.get("role") == "user" and om.get("_file_tag"):
                key = om.get("ts", "") + "|" + om.get("content", "")[:20]
                old_tags[key] = om["_file_tag"]
        if old_tags:
            for m in messages:
                if m.get("role") == "user" and not m.get("_file_tag"):
                    key = m.get("ts", "") + "|" + m.get("content", "")[:20]
                    tag = old_tags.get(key)
                    if tag:
                        m["_file_tag"] = tag
    data = {
        "version": 2,
        "context_cache": context_cache,
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "messages": messages,
    }
    tmp_path = filepath + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, filepath)


def load_chat(filepath):
    """从文件加载对话（兼容文件夹和 .json 格式）"""
    _ensure_migrated()

    if not filepath or not os.path.exists(filepath):
        return []

    try:
        # 文件夹格式
        if _is_folder_session(filepath):
            msgs_path = os.path.join(filepath, "messages.json")
            if not os.path.exists(msgs_path):
                return []
            with open(msgs_path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            if isinstance(raw, dict):
                return raw.get("messages", [])
            if isinstance(raw, list):
                return raw
            return []

        # 旧 .json 格式
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            return raw.get("messages", [])
        if isinstance(raw, list):
            return raw
        return []
    except Exception:
        return []


def load_chat_cache(filepath):
    """从文件加载 context_cache（兼容文件夹和 .json 格式）"""
    _ensure_migrated()

    if not filepath or not os.path.exists(filepath):
        return None

    try:
        # 文件夹格式
        if _is_folder_session(filepath):
            cache_path = os.path.join(filepath, "context_cache.json")
            if not os.path.exists(cache_path):
                return None
            with open(cache_path, "r", encoding="utf-8") as f:
                return json.load(f)

        # 旧 .json 格式
        with open(filepath, "r", encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, dict):
            return raw.get("context_cache")
        return None
    except Exception:
        return None


def list_chats():
    """列出所有对话（文件夹格式 + 旧 .json 格式，P1-A8: 只读 meta 信息）"""
    _ensure_migrated()

    current_file = get_current_chat()
    result = []

    # 扫描文件夹格式
    for entry in os.listdir(CHAT_DIR):
        entry_path = os.path.join(CHAT_DIR, entry)

        if os.path.isdir(entry_path):
            # 文件夹格式
            name = entry
            msg_count = 0
            has_cache = False
            try:
                meta_path = os.path.join(entry_path, "meta.json")
                if os.path.exists(meta_path):
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    msg_count = meta.get("message_count", 0)
                else:
                    # fallback: 读 messages.json 计数
                    msgs_path = os.path.join(entry_path, "messages.json")
                    if os.path.exists(msgs_path):
                        with open(msgs_path, "r", encoding="utf-8") as f:
                            msgs = json.load(f)
                        msg_count = len(msgs.get("messages", [])) if isinstance(msgs, dict) else len(msgs)
                cache_path = os.path.join(entry_path, "context_cache.json")
                has_cache = os.path.exists(cache_path)
            except Exception:
                pass
            cache_tag = " [有缓存]" if has_cache else ""
            label = "%s (%d条)%s" % (name, msg_count, cache_tag)
            result.append({
                "path": entry_path,
                "name": name,
                "label": label,
                "current": (entry_path == current_file),
                "msg_count": msg_count,
            })
            continue

        if entry.endswith(".json") and not entry.endswith(".tmp"):
            # 旧 .json 格式
            filepath = entry_path
            name = entry.replace(".json", "")
            msg_count = 0
            has_cache = False
            try:
                with open(filepath, "r", encoding="utf-8") as fh:
                    raw = json.load(fh)
                if isinstance(raw, dict):
                    msg_count = len(raw.get("messages", []))
                    has_cache = bool(raw.get("context_cache"))
                elif isinstance(raw, list):
                    msg_count = len(raw)
            except Exception:
                pass
            cache_tag = " [有缓存]" if has_cache else ""
            label = "%s (%d条)%s" % (name, msg_count, cache_tag)
            result.append({
                "path": filepath,
                "name": name,
                "label": label,
                "current": (filepath == current_file),
                "msg_count": msg_count,
            })

    # 按修改时间倒序
    result.sort(key=lambda x: os.path.getmtime(x["path"]), reverse=True)
    return result


def rename_chat(old_name: str, new_name: str) -> dict:
    """重命名对话（兼容文件夹和 .json 格式）

    Args:
        old_name: 原对话文件名（不含后缀和目录）
        new_name: 新对话文件名（不含后缀和目录）

    Returns:
        {"ok": True, "new_file": "..."} 或 {"error": "..."}
    """
    # 安全校验新名称
    safe_new = safe_chat_name(new_name)
    if not safe_new:
        return {"error": "新名称不合法，只允许字母/数字/下划线/连字符/中文"}

    # 查找原会话路径（可能是文件夹或 .json）
    old_folder = os.path.join(CHAT_DIR, old_name)
    old_json = os.path.join(CHAT_DIR, old_name + ".json")

    if os.path.isdir(old_folder):
        old_path = old_folder
    elif os.path.isfile(old_json):
        old_path = old_json
    else:
        return {"error": "原对话文件不存在"}

    # 确定新路径
    if _is_folder_session(old_path):
        new_path = os.path.join(CHAT_DIR, safe_new)
    else:
        new_path = os.path.join(CHAT_DIR, safe_new + ".json")

    if os.path.exists(new_path):
        return {"error": "目标名称已存在，请换一个名称"}

    try:
        os.rename(old_path, new_path)
        log.info("[CHAT] renamed: %s -> %s" % (old_name, safe_new))
        return {"ok": True, "old_name": old_name, "new_name": safe_new, "new_file": new_path}
    except OSError as e:
        log.error("[CHAT] rename failed: %s -> %s — %s" % (old_name, safe_new, str(e)))
        return {"error": "重命名失败: %s" % str(e)[:100]}
