# -*- coding: utf-8 -*-
"""
core/session_migrator.py — 会话存储迁移（旧 JSON → 新文件夹格式）
====================================================================

启动时由 chat_store.py 的 _ensure_migrated() 调用。
将旧的 {date}_{seq}.json 单文件迁移为 {date}_{seq}/ 文件夹格式。

迁移策略：
  - 原子操作：先创建文件夹 + 写文件，成功后才删旧文件
  - 失败跳过：单个文件迁移失败不影响其他文件
  - 幂等：已迁移的不会重复迁移
"""

import os
import json
import logging

log = logging.getLogger(__name__)


def migrate_all(chat_dir):
    """扫描 chat_dir，将旧的 .json 会话迁移为文件夹格式

    Args:
        chat_dir: 会话存储目录（data/chats/）
    """
    if not os.path.isdir(chat_dir):
        return

    migrated_count = 0
    failed_count = 0

    # 收集所有 .json 文件
    json_files = []
    for entry in os.listdir(chat_dir):
        if entry.endswith(".json") and not entry.endswith(".tmp"):
            full_path = os.path.join(chat_dir, entry)
            if os.path.isfile(full_path):
                json_files.append((entry, full_path))

    if not json_files:
        return

    log.info("[MIGRATE] 发现 %d 个旧格式会话，开始迁移...", len(json_files))

    for entry, full_path in json_files:
        # 推导文件夹名（去掉 .json 后缀）
        folder_name = entry[:-5]  # 去掉 ".json"
        folder_path = os.path.join(chat_dir, folder_name)

        # 已存在同名文件夹 = 已迁移
        if os.path.isdir(folder_path):
            log.debug("[MIGRATE] 跳过（已存在）: %s", folder_name)
            continue

        try:
            _migrate_one(full_path, folder_path)
            migrated_count += 1
            log.info("[MIGRATE] 迁移成功: %s -> %s/", entry, folder_name)
        except Exception as e:
            failed_count += 1
            log.warning("[MIGRATE] 迁移失败: %s — %s", entry, str(e)[:100])

    if migrated_count > 0 or failed_count > 0:
        log.info("[MIGRATE] 完成: 成功 %d, 失败 %d", migrated_count, failed_count)


def _migrate_one(json_path, folder_path):
    """迁移单个会话文件

    Args:
        json_path: 旧 .json 文件路径
        folder_path: 目标文件夹路径

    Raises:
        Exception: 迁移失败时抛出
    """
    # 1. 读取旧 JSON
    with open(json_path, "r", encoding="utf-8") as f:
        raw = json.load(f)

    # 兼容两种格式
    if isinstance(raw, list):
        # 超旧格式：直接是 messages 数组
        messages = raw
        context_cache = None
        updated_at = ""
    elif isinstance(raw, dict):
        # 较新格式：{version, messages, context_cache, ...}
        messages = raw.get("messages", [])
        context_cache = raw.get("context_cache")
        updated_at = raw.get("updated_at", "")
    else:
        raise ValueError("无法解析的 JSON 格式")

    # 2. 创建文件夹
    os.makedirs(folder_path, exist_ok=True)
    assets_dir = os.path.join(folder_path, "assets")
    os.makedirs(assets_dir, exist_ok=True)

    # 3. 写 meta.json
    from datetime import datetime
    folder_name = os.path.basename(folder_path)

    # 尝试从消息中提取更好的标题/时间
    title = folder_name
    created_at = updated_at or ""
    if messages:
        # 用第一条用户消息的前 30 字作为标题
        first_user = next((m for m in messages if m.get("role") == "user"), None)
        if first_user and first_user.get("content"):
            title = first_user["content"][:30]
            if len(first_user["content"]) > 30:
                title += "..."
        # 用最后消息的时间
        last_msg = messages[-1]
        if last_msg.get("ts"):
            today = folder_name.split("_")[0] if "_" in folder_name else ""
            created_at = "%s %s" % (today, last_msg.get("ts", ""))
        if not created_at:
            created_at = updated_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    meta = {
        "id": folder_name,
        "title": title,
        "created_at": created_at,
        "updated_at": updated_at or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "message_count": len(messages),
        "version": 3,
    }
    meta_path = os.path.join(folder_path, "meta.json")
    _atomic_write_json(meta_path, meta)

    # 4. 写 messages.json
    msgs_data = {
        "version": 3,
        "messages": messages,
    }
    msgs_path = os.path.join(folder_path, "messages.json")
    _atomic_write_json(msgs_path, msgs_data)

    # 5. 写 context_cache.json（如果有）
    if context_cache:
        cache_path = os.path.join(folder_path, "context_cache.json")
        _atomic_write_json(cache_path, context_cache)

    # 6. 删除旧文件（迁移成功才删）
    os.remove(json_path)


def _atomic_write_json(path, data):
    """原子写入 JSON 文件（先写 .tmp 再 rename）"""
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, path)
