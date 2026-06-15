# -*- coding: utf-8 -*-
"""
reformulate.py — 追问查询补全模块（Patch 3）

有历史时 reformulate，无历史原样返回。
同步函数，直接调用 mgr 的同步接口。
"""
import logging
import re

log = logging.getLogger(__name__)


def reformulate_query(query: str, history: list, mgr) -> str:
    """有历史时 reformulate，无历史原样返回

    Args:
        query: 用户当前消息
        history: 历史消息列表 [{"role": "user/assistant", "content": "..."}]
        mgr: ModelManager 实例

    Returns:
        reformulated query string（失败时返回原 query）
    """
    if not history:
        return query

    # 拼接 history_summary（最近2轮的Q+A摘要，限制500字）
    history_summary = _build_history_summary(history, max_chars=500)
    if not history_summary:
        return query

    # 拼接 prompt
    from prompts import REFORMULATE_PROMPT
    prompt = REFORMULATE_PROMPT.format(
        history_summary=history_summary,
        query=query,
    )

    # 强制调用本地 StreamEngine（不走 CloudEngine，避免阻塞）
    try:
        response_parts = []
        se = mgr._stream_engine
        for chunk_type, chunk_text in se.run(
            message=prompt,
            model=None,  # 使用默认本地 LLM
            max_tokens=200,
            history=[],
            context_cache=None,
            override_task_type="text",
            kb_mode=False,
        ):
            if chunk_type in ("text", "raw"):
                response_parts.append(chunk_text)

        response = "".join(response_parts).strip()
        if not response:
            return query

        # 取第一行作为 reformulated query
        result = response.split('\n')[0].strip()
        # 去掉可能的引号包裹
        result = result.strip('"').strip("'").strip("\u201c").strip("\u201d")
        if not result or len(result) < 2:
            return query

        # 关键词保留校验：改写后的 query 必须保留原 query 的核心关键词
        # 如果改写偏离太大（丢失超过50%的原关键词），回退到原 query
        if not _check_keyword_preservation(query, result, history):
            log.info("[REFORMULATE] 关键词丢失过多，回退原 query: '%s' → 丢弃 '%s'",
                     query[:50], result[:50])
            return query

        log.info("[REFORMULATE] '%s' → '%s'", query[:50], result[:50])
        return result

    except Exception as e:
        log.warning("[REFORMULATE] 失败，使用原 query: %s", str(e)[:100])
        return query


def _check_keyword_preservation(original: str, reformulated: str, history: list) -> bool:
    """检查改写后的 query 是否保留了原始对话的核心关键词

    规则：
    - 提取原始 query 中的中文实词（≥2字的词）
    - 如果原始 query 已是完整问题（≥4个实词），改写后的 query 必须保留≥50%的实词
    - 如果原始 query 是追问（"为什么"、"有什么好处"等），从历史中提取主题词，
      改写后的 query 必须包含主题词
    - 额外保护：改写后的 query 不能引入历史中完全没有出现过的全新主题
    """
    # 提取中文实词（2字及以上的连续中文字符）
    def _extract_keywords(text):
        return set(re.findall(r'[\u4e00-\u9fff]{2,}', text))

    orig_kws = _extract_keywords(original)
    ref_kws = _extract_keywords(reformulated)

    # 如果原始 query 有足够的实词，检查保留率
    if len(orig_kws) >= 2:
        preserved = orig_kws & ref_kws
        ratio = len(preserved) / len(orig_kws) if orig_kws else 0
        if ratio >= 0.5:
            return True
        # 如果原始 query 本身就是完整问题（≥4个实词），保留率低于50%就拒绝
        if len(orig_kws) >= 4:
            return False

    # 追问型 query（"为什么"、"好处"、"这些都是谁" 等）— 从历史中提取主题词
    # 取最近一个 user 消息中的关键词作为主题
    theme_kws = set()
    for msg in reversed(history):
        if msg.get("role") == "user":
            theme_kws = _extract_keywords(msg.get("content", ""))
            break

    if theme_kws:
        # 改写后的 query 必须包含至少一个主题词
        overlap = theme_kws & ref_kws
        if overlap:
            # 额外检查：改写后的 query 不能引入历史中完全没有的全新大主题
            # 收集整个历史的所有关键词
            all_history_kws = set()
            for msg in history:
                all_history_kws |= _extract_keywords(msg.get("content", ""))
            # 改写新增的关键词（不在原 query 和历史中的）
            new_kws = ref_kws - orig_kws - all_history_kws
            if len(new_kws) > 3:
                log.info("[REFORMULATE] 改写引入过多新关键词(%d)，可能偏离主题: %s",
                         len(new_kws), new_kws)
                return False
            return True
        log.info("[REFORMULATE] 追问改写丢失主题词: theme=%s, reformulated_kws=%s",
                 theme_kws, ref_kws)
        return False

    # 无法判断时，信任 LLM 的改写
    return True


def _build_history_summary(history: list, max_chars: int = 500) -> str:
    """构建历史摘要，最近2轮（4条消息），限制总字符数"""
    if not history:
        return ""

    # 取最近2轮（4条消息）
    recent = history[-4:]
    parts = []
    total_chars = 0

    for msg in recent:
        role = msg.get("role", "")
        content = msg.get("content", "")
        if not content:
            continue

        prefix = "用户" if role == "user" else "助手"
        line = "%s: %s" % (prefix, content[:200])

        if total_chars + len(line) > max_chars:
            # 截断
            remaining = max_chars - total_chars
            if remaining > 20:
                parts.append(line[:remaining])
            break
        parts.append(line)
        total_chars += len(line)

    return "\n".join(parts)
