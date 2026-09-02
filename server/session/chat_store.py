# -*- coding: utf-8 -*-
"""
session/chat_store.py — 对话文件管理（文件夹格式 + 旧格式兼容）

从 routers/chat.py 提取的对话持久化函数：
  - safe_chat_name   — 对话名称安全校验
  - today_str        — 获取当天日期字符串
  - new_chat_file    — 创建新对话文件（线程安全）
  - append_message   — 追加单条消息（0.10.1 M1-B 后端单写入口，自动分配 id）
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
from common.utils import atomic_write_json
from routers.deps import (
    get_current_chat_file,
    get_current_chat,
    set_current_chat,
)

log = logging.getLogger(__name__)

# Patch4 修复 1：会话需要管理的子目录（文档状态 + 模型工作区）
_CHAT_SUBDIRS = ("docs", "workspace")

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

        # 防止文件夹或同名 .json 已被其他线程/旧格式创建
        while os.path.exists(folder_path) or os.path.exists(folder_path + ".json"):
            idx += 1
            folder_name = "%s_%03d" % (today, idx)
            folder_path = os.path.join(CHAT_DIR, folder_name)

        # 创建文件夹结构
        os.makedirs(folder_path, exist_ok=True)
        # Patch4 v3.1：统一 workspace（用户上传 + 模型产出都在这里）
        # 不再单独建 assets/ 子目录——上传直接进 workspace/
        for _sub in ("docs", "workspace"):
            os.makedirs(os.path.join(folder_path, _sub), exist_ok=True)

        # 写入 meta.json
        meta = {
            "id": folder_name,
            "title": folder_name,
            "group": "日常",  # 0.10.1 项目分组：默认进「日常」
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


def ensure_chat_subdirs(chat_id):
    """Patch4 v3.1：确保会话的子目录存在（docs / workspace）。

    在 doc_session 写入或 workspace 操作前调用，保证目录就位。
    支持传入 chat_id（文件夹名）或 chat_file 完整路径。
    Patch4 v3.1：assets 已并入 workspace，不再单独创建。

    Args:
        chat_id: 会话 ID（如 "2026-06-15_001"）或完整路径

    Returns:
        str: 会话根目录的绝对路径；chat_id 为空或非法时返回 ""
    """
    if not chat_id:
        return ""

    # 如果传的是完整路径（含分隔符或盘符），直接用；否则拼到 CHAT_DIR
    if os.path.isabs(chat_id) or os.sep in chat_id or "/" in chat_id or "\\" in chat_id:
        chat_path = os.path.normpath(chat_id)
        # 如果指向 messages.json / meta.json 等文件，取其所在目录
        if os.path.isfile(chat_path):
            chat_path = os.path.dirname(chat_path)
    else:
        chat_path = os.path.join(CHAT_DIR, chat_id)

    if not chat_path or not os.path.isdir(chat_path):
        # 会话根目录不存在，不强制创建（避免误创孤儿目录）
        return ""

    for sub in _CHAT_SUBDIRS:
        sub_path = os.path.join(chat_path, sub)
        if not os.path.isdir(sub_path):
            try:
                os.makedirs(sub_path, exist_ok=True)
            except OSError as e:
                log.warning("[CHAT_STORE] 创建子目录失败 %s: %s", sub_path, str(e)[:80])

    return chat_path


def _next_msg_id(messages):
    """分配会话内单调递增消息 id（m%04d）。0.10.1 M1-B 引入：
    旧消息无 id 不回填（双轨兼容），只为新消息分配。"""
    max_n = 0
    for m in messages:
        mid = m.get("id") if isinstance(m, dict) else None
        if isinstance(mid, str):
            mm = re.match(r'^m(\d+)$', mid)
            if mm:
                max_n = max(max_n, int(mm.group(1)))
    return "m%04d" % (max_n + 1)


def append_message(chat_path, msg):
    """后端单写入口（0.10.1 M1-B）：追加一条消息到会话，线程安全。

    - 自动分配 id（若 msg 无 id）
    - 文件夹与旧 .json 格式都支持
    - 返回写入后的消息 dict（含 id）；chat_path 无效时返回 None
    """
    if not chat_path:
        return None

    _ensure_migrated()

    with _chat_save_lock:
        if _is_folder_session(chat_path):
            msgs_path = os.path.join(chat_path, "messages.json")
            data = {"version": 3, "messages": []}
            if os.path.exists(msgs_path):
                try:
                    with open(msgs_path, "r", encoding="utf-8") as f:
                        raw = json.load(f)
                    if isinstance(raw, dict):
                        data = raw
                    elif isinstance(raw, list):
                        data = {"version": 3, "messages": raw}
                except Exception:
                    pass
            data.setdefault("messages", [])
            msg = dict(msg)
            if not msg.get("id"):
                msg["id"] = _next_msg_id(data["messages"])
            data["messages"].append(msg)
            atomic_write_json(msgs_path, data)
            # 更新 meta.json
            meta_path = os.path.join(chat_path, "meta.json")
            meta = {}
            if os.path.exists(meta_path):
                try:
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                except Exception:
                    pass
            meta["message_count"] = len(data["messages"])
            meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            atomic_write_json(meta_path, meta)
            return msg

        # 旧 .json 格式
        if os.path.isfile(chat_path):
            data = {"version": 2, "messages": []}
            try:
                with open(chat_path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                if isinstance(raw, dict):
                    data = raw
                elif isinstance(raw, list):
                    data = {"version": 2, "messages": raw}
            except Exception:
                pass
            data.setdefault("messages", [])
            msg = dict(msg)
            if not msg.get("id"):
                msg["id"] = _next_msg_id(data["messages"])
            data["messages"].append(msg)
            data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            atomic_write_json(chat_path, data)
            return msg

    return None


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
    old_msgs = []
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
    # 匹配 1（历史行为）：ts+content 精确匹配。
    # 匹配 2（0828 修复）：末尾兜底——后端 pipeline 保存时重建 user 消息，ts 用完成时刻，
    # 与前端 append 落盘的发送时刻不同，匹配 1 必然失败（仅 AI 秒回同秒时碰巧成功，
    # 即"刷新后引用时有时无"的根源）。若旧文件末条 user 带引用，而新 messages 的
    # 最后一条 user 同内容且无引用，则继承 _file_tag 与 ts（还原发送时刻）。
    if old_tags:
        for m in messages:
            if m.get("role") == "user" and not m.get("_file_tag"):
                key = m.get("ts", "") + "|" + m.get("content", "")[:20]
                tag = old_tags.get(key)
                if tag:
                    m["_file_tag"] = tag
    if old_msgs:
        last_old = old_msgs[-1]
        if last_old.get("role") == "user" and last_old.get("_file_tag"):
            for m in reversed(messages):
                if m.get("role") != "user":
                    continue
                _nc = m.get("content") or ""
                _oc = last_old.get("content") or ""
                # 前缀匹配：历史版本 append 的 content 可能带引用 label 尾巴
                if not m.get("_file_tag") and _nc and (_oc == _nc or _oc.startswith(_nc)):
                    m["_file_tag"] = last_old["_file_tag"]
                    if last_old.get("ts"):
                        m["ts"] = last_old["ts"]
                break

    # 写入 messages.json（原子写入）
    msgs_data = {
        "version": 3,
        "messages": messages,
    }
    atomic_write_json(msgs_path, msgs_data)

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
    atomic_write_json(meta_path, meta)

    # 保存 context_cache
    if context_cache is not None:
        cache_path = os.path.join(folder_path, "context_cache.json")
        atomic_write_json(cache_path, context_cache)


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
    # 合并 _file_tag（与 _save_folder_session 相同的两级匹配：ts+content 精确 + 末尾兜底）
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
        last_old = old_msgs[-1]
        if last_old.get("role") == "user" and last_old.get("_file_tag"):
            for m in reversed(messages):
                if m.get("role") != "user":
                    continue
                _nc = m.get("content") or ""
                _oc = last_old.get("content") or ""
                # 前缀匹配：历史版本 append 的 content 可能带引用 label 尾巴
                if not m.get("_file_tag") and _nc and (_oc == _nc or _oc.startswith(_nc)):
                    m["_file_tag"] = last_old["_file_tag"]
                    if last_old.get("ts"):
                        m["ts"] = last_old["ts"]
                break
    data = {
        "version": 2,
        "context_cache": context_cache,
        "updated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "messages": messages,
    }
    atomic_write_json(filepath, data)


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
    """列出所有对话（文件夹格式 + 旧 .json 格式，P1-A8: 只读 meta 信息）

    Patch4 修复：同名文件夹和 .json 共存时只列文件夹版本（v3 优先）。
    """
    _ensure_migrated()

    current_file = get_current_chat()
    result = []

    # 第一遍：扫描文件夹格式，记录哪些名字已被占用
    folder_names = set()
    for entry in os.listdir(CHAT_DIR):
        entry_path = os.path.join(CHAT_DIR, entry)

        if os.path.isdir(entry_path):
            folder_names.add(entry)  # 标记这个名字已被文件夹占用
            # 文件夹格式
            name = entry
            msg_count = 0
            has_cache = False
            chat_group = "日常"  # 旧会话 meta 无 group → 默认「日常」（免迁移）
            try:
                meta_path = os.path.join(entry_path, "meta.json")
                if os.path.exists(meta_path):
                    with open(meta_path, "r", encoding="utf-8") as f:
                        meta = json.load(f)
                    msg_count = meta.get("message_count", 0)
                    chat_group = meta.get("group") or "日常"
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
                "group": chat_group,
            })

    # 第二遍：扫描旧 .json 格式，跳过已被同名文件夹占用的
    for entry in os.listdir(CHAT_DIR):
        entry_path = os.path.join(CHAT_DIR, entry)

        if entry.endswith(".json") and not entry.endswith(".tmp"):
            name = entry.replace(".json", "")
            # Patch4 修复：同名文件夹已存在时跳过（v3 文件夹优先）
            if name in folder_names:
                continue
            filepath = entry_path
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


def set_chat_group(chat_name: str, group: str) -> dict:
    # 设置会话的项目分组（0.10.1；仅 folder 格式支持，旧 .json 静默忽略）
    # group 为空或非法字符时回落「日常」。项目即分组名（免大迁移，无独立实体）
    safe = safe_chat_name(group)
    if not safe:
        safe = "日常"
    folder_path = os.path.join(CHAT_DIR, chat_name)
    if not os.path.isdir(folder_path):
        return {"error": "会话不存在或旧格式（旧格式不支持分组）"}
    meta_path = os.path.join(folder_path, "meta.json")
    meta = {}
    if os.path.exists(meta_path):
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
        except Exception:
            pass
    meta["group"] = safe
    meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    atomic_write_json(meta_path, meta)
    return {"ok": True, "group": safe}


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
