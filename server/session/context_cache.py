# -*- coding: utf-8 -*-
"""
session/context_cache.py — 上下文缓存与历史清理

从 routers/chat.py 提取的缓存管理函数：
  - clean_history_for_model  — 清理历史记录给模型用
  - clean_think_content      — 清理思考内容中的重复段落
  - update_session_cache     — Session 缓存压缩
"""
import re
import os
import json
import logging

from common.utils import atomic_write_json
from routers.deps import get_mgr
from session.chat_store import load_chat_cache

log = logging.getLogger(__name__)


def clean_history_for_model(messages, max_rounds=None, ai_mode=None):
    """清理历史记录给模型用

    ai_mode: "cloud" 时会把 agent_timeline/agent_summary 等工具链信息
             以自然文本注入 assistant 消息，让云端大模型感知之前的操作过程。
             "local" 或 None 时保持纯 role+content（4B 模型不需要额外上下文）。
    """
    mgr = get_mgr()
    if max_rounds is None:
        try:
            profile = mgr._get_profile(mgr._get_default_llm())
            max_rounds = profile.get("max_rounds", 6)
        except Exception:
            max_rounds = 6
    rounds = []
    current_round = []
    for h in messages:
        role = h.get("role", "user")
        current_round.append(h)
        if role == "assistant":
            rounds.append(current_round)
            current_round = []
    if current_round:
        rounds.append(current_round)
    if len(rounds) > max_rounds:
        rounds = rounds[-max_rounds:]
    trimmed = []
    for r in rounds:
        trimmed.extend(r)
    cleaned = []
    for h in trimmed:
        content = h.get("content", "")
        if not isinstance(content, str):
            content = str(content)
        if h.get("role") == "assistant" and (content.startswith("[ERROR]") or "[TIMEOUT" in content):
            continue
        content = re.sub(r'`\d+字`\s*`[\d.]+s`\s*`[\d.]+字/s`', '', content)
        content = re.sub(r'<details[^>]*>.*?</details>', '', content, flags=re.DOTALL)
        content = re.sub(r'</?(?:details|think|summary|think_details)[^>]*>', '', content)
        content = content.strip()

        # 云端模式：注入工具链上下文
        if ai_mode == "cloud" and h.get("role") == "assistant" and content:
            tool_ctx = _build_tool_context(h)
            if tool_ctx:
                content = content + "\n\n" + tool_ctx

        if content:
            cleaned.append({"role": h.get("role", "user"), "content": content})
    return cleaned


def _build_tool_context(msg):
    """从消息的 agent_timeline / agent_summary 构建工具链上下文文本

    返回格式示例：
    [系统提示：上一轮回答使用了以下工具]
    - 搜索引擎: 搜索了 2 次（关键词: "xxx", "yyy"）
    - 网页抓取: 抓取了 1 个网页（获取了 3200 字内容）
    - 知识库: 检索了 3 篇文档
    - 用时: 12 秒
    """
    parts = []

    # 优先用 agent_timeline（详细，有每个步骤的信息）
    timeline = msg.get("agent_timeline")
    if timeline and isinstance(timeline, list):
        searches = []
        fetch_count = 0
        fetch_total_len = 0
        kb_searches = []
        kb_doc_count = 0
        writing = False

        for item in timeline:
            status = item.get("status", "")
            if status == "searching":
                q = item.get("query", "")
                if q:
                    searches.append(q)
            elif status == "fetch_done":
                fetch_count += 1
                fetch_total_len += (item.get("length") or 0)
            elif status == "kb_searching":
                q = item.get("query", "")
                if q:
                    kb_searches.append(q)
            elif status == "kb_done":
                kb_doc_count += (item.get("count") or 0)
            elif status == "writing":
                writing = True

        if searches:
            keywords = ", ".join(searches[:5])  # 最多5个关键词
            parts.append("- 搜索引擎: 搜索了 %d 次（关键词: %s）" % (len(searches), keywords))
        if fetch_count:
            parts.append("- 网页抓取: 抓取了 %d 个网页（共获取 %d 字内容）" % (fetch_count, fetch_total_len))
        if kb_searches:
            keywords = ", ".join(kb_searches[:5])
            count_hint = "，找到 %d 篇相关文档" % kb_doc_count if kb_doc_count else ""
            parts.append("- 知识库: 检索了 %d 次（关键词: %s%s）" % (len(kb_searches), keywords, count_hint))
        if writing:
            parts.append("- 文档操作: 执行了文档写入")

    # fallback：用 agent_summary（统计摘要）
    if not parts:
        summary = msg.get("agent_summary")
        if summary and isinstance(summary, dict):
            if summary.get("searches"):
                parts.append("- 搜索引擎: 搜索了 %d 次" % summary["searches"])
            if summary.get("fetches"):
                parts.append("- 网页抓取: 抓取了 %d 个网页" % summary["fetches"])
            if summary.get("kb_hits"):
                parts.append("- 知识库: 检索了 %d 篇文档" % summary["kb_hits"])
            if summary.get("docs"):
                parts.append("- 文档操作: 生成了 %d 个文档操作" % summary["docs"])
            if summary.get("elapsed"):
                parts.append("- 用时: %d 秒" % summary["elapsed"])

    if not parts:
        return ""

    return "[系统提示：上一轮回答使用了以下工具]\n" + "\n".join(parts)


def clean_think_content_wrapped(text, max_len=2000):
    """清理思考内容中的重复段落（包装函数，委托给 response_filter.clean_think_content）"""
    try:
        from intelligence.response_filter import clean_think_content
        return clean_think_content(text, max_len=max_len)
    except ImportError:
        if not text:
            return ""
        return text[:max_len]


# 别名：chat.py 通过 clean_think_name 导入
clean_think_content = clean_think_content_wrapped


def update_session_cache(chat_file, messages, model_name=None):
    """Session 缓存压缩"""
    mgr = get_mgr()
    from config import get as _cfg_get
    _CACHE_KEEP_RATIO = _cfg_get("cache_keep_ratio")
    _CACHE_ENTRY_MAX_CHARS = _cfg_get("cache_entry_max_chars")
    _CACHE_MAX_TOTAL_CHARS = _cfg_get("cache_max_total_chars")
    _CACHE_THRESHOLD_RATIO = _cfg_get("cache_threshold_ratio")

    total_chars = sum(len(m.get("content", "")) for m in messages if m.get("content"))
    try:
        profile = mgr._get_profile(model_name or mgr._get_default_llm())
        max_history = profile.get("max_history_chars", 6000)
        cache_threshold = int(max_history * _CACHE_THRESHOLD_RATIO)
        keep_chars = int(max_history * _CACHE_KEEP_RATIO)
    except Exception:
        cache_threshold = 4800
        keep_chars = 2400

    if total_chars < cache_threshold:
        return load_chat_cache(chat_file), False

    log.info("[CACHE] 对话 %d字 超过阈值 %d字，开始压缩 (保留最近 %d字)" % (
        total_chars, cache_threshold, keep_chars))

    split_idx = len(messages)
    running_chars = 0
    for i in range(len(messages) - 1, -1, -1):
        msg_chars = len(messages[i].get("content", ""))
        if running_chars + msg_chars > keep_chars:
            split_idx = i + 1
            break
        running_chars += msg_chars
        split_idx = i

    if split_idx <= 0:
        return load_chat_cache(chat_file), False

    old_messages = messages[:split_idx]
    new_messages = messages[split_idx:]
    if not old_messages:
        return load_chat_cache(chat_file), False

    try:
        from common.context_compressor import _compress_text, _is_code_block, _compress_code
    except ImportError:
        return load_chat_cache(chat_file), False

    existing_cache = load_chat_cache(chat_file) or ""
    cache_parts = []
    if existing_cache:
        cache_parts.append(existing_cache)

    current_round_parts = []
    for m in old_messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if not content:
            continue
        content = re.sub(r'</?(?:details|think|summary|think_details)[^>]*>', '', content)
        content = re.sub(r'`\d+字`\s*`[\d.]+s`\s*`[\d.]+字/s`', '', content)
        content = content.strip()
        if not content:
            continue
        if role == "user":
            if current_round_parts:
                cache_parts.append(" | ".join(current_round_parts))
                current_round_parts = []
            current_round_parts.append("用户: " + content[:_CACHE_ENTRY_MAX_CHARS])
        elif role == "assistant":
            if _is_code_block(content):
                compressed = _compress_code(content)
            else:
                compressed = _compress_text(content)
            current_round_parts.append("助手: " + compressed[:_CACHE_ENTRY_MAX_CHARS])

    if current_round_parts:
        cache_parts.append(" | ".join(current_round_parts))

    new_cache = "\n".join(cache_parts)
    if len(new_cache) > _CACHE_MAX_TOTAL_CHARS:
        new_cache = new_cache[-_CACHE_MAX_TOTAL_CHARS:]
        first_newline = new_cache.find("\n")
        if first_newline > 0:
            new_cache = new_cache[first_newline + 1:]

    log.info("[CACHE] 压缩完成: %d条旧消息 -> %d字 cache" % (len(old_messages), len(new_cache)))

    # 离线模型增强压缩
    if len(new_cache) > 300:
        try:
            from common.context_compressor import offline_compress_with_model
            model_summary = offline_compress_with_model(old_messages, model_manager=mgr)
            if model_summary and len(model_summary) > 20:
                log.info("[CACHE] 离线模型摘要替换: %d字 -> %d字" % (len(new_cache), len(model_summary)))
                new_cache = "[AI摘要] " + model_summary
        except Exception as e:
            log.warning("[CACHE] 离线模型压缩失败: %s" % str(e)[:80])

    return new_cache, True


def clear_session_cache(filepath: str):
    """清除指定对话文件的 context_cache（用于删除对话时清理）

    Args:
        filepath: 对话文件路径
    """
    if not filepath or not os.path.exists(filepath):
        return
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict) and data.get("context_cache"):
            data["context_cache"] = None
            atomic_write_json(filepath, data)
            log.info("[CACHE] 已清理 %s 的 context_cache" % os.path.basename(filepath))
    except Exception as e:
        log.warning("[CACHE] 清理缓存失败: %s" % str(e)[:80])
