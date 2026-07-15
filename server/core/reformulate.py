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
    """提取搜索关键词：让本地 LLM 从用户消息中提取检索关键词

    有历史时 LLM 会补全追问上下文（如"那是谁发明的"→"刮五指是谁发明的"）。
    无历史时 LLM 提取核心搜索词（如"什么是刮五指"→"刮五指"）。

    Args:
        query: 用户当前消息
        history: 历史消息列表 [{"role": "user/assistant", "content": "..."}]
        mgr: ModelManager 实例

    Returns:
        reformulated query string（失败时返回原 query）
    """
    # 太短的直接用原文（不需要提取）
    _query_stripped = query.strip()
    if len(_query_stripped) <= 3:
        return query

    from prompts import REFORMULATE_PROMPT, REFORMULATE_NO_HISTORY_PROMPT

    # 有 history 才拼摘要（最近2轮的Q+A摘要，限制500字）；summary 为空时退化为无历史分支
    history_summary = _build_history_summary(history, max_chars=500) if history else ""
    prompt = (
        REFORMULATE_PROMPT.format(history_summary=history_summary, query=query)
        if history_summary
        else REFORMULATE_NO_HISTORY_PROMPT.format(query=query)
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

        # P6 精简：清洗 LLM 输出，去除元分析/编号列表等啰嗦内容
        result = _clean_reformulate_output(response, query)
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


# 追问/指代词（需要 LLM 补全上下文的信号）
# 注意：只列真正需要历史上下文的指代词，不含 "哪些/怎么/如何"（这些在完整问题里也常见）
_ANAPHORA_PATTERNS = re.compile(
    r'那个|这个|那是|这是|它|他|她|它们|还有|另外|上面|前面|刚才|继续说|详细说说|具体说说|那谁|这谁'
)

# 停用词（提取关键词时过滤）
_STOP_WORDS = {
    # 中文停用词
    '的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好',
    '自己', '这', '那', '些', '什么', '怎么', '为什么', '如何', '可以', '能', '请',
    '帮', '帮我', '一下', '吗', '呢', '吧', '啊', '哦', '嗯',
    # 英文停用词
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'to', 'of',
    'in', 'on', 'at', 'by', 'for', 'with', 'about', 'as', 'into', 'like',
    'through', 'after', 'over', 'between', 'out', 'against', 'during',
    'without', 'before', 'under', 'around', 'among',
    'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all',
    'each', 'every', 'both', 'few', 'more', 'most', 'other', 'some',
    'such', 'no', 'nor', 'not', 'only', 'own', 'same', 'so', 'than',
    'too', 'very', 'just', 'should', 'now',
}


def _has_anaphora(query: str) -> bool:
    """检测查询是否包含追问/指代词（需要 LLM 补全上下文的信号）"""
    return bool(_ANAPHORA_PATTERNS.search(query))


def _rule_extract_keywords(query: str) -> str:
    """规则提取搜索关键词（不调 LLM）

    策略：
    1. 去掉常见问句前缀（"请问"、"帮我"、"我想了解"等）
    2. 提取中文 2+ 字词和英文 2+ 字母词
    3. 过滤停用词
    4. 如果剩余词 >= 2 个，用空格拼接返回；否则返回 None（规则无信心）

    Returns:
        关键词字符串（如 "中医 流派"），或 None（规则无信心，需 fallback 到 LLM）
    """
    text = query.strip()

    # 去掉常见问句前缀/后缀
    _PREFIXES = [
        '请问', '请帮我', '帮我', '请告诉我', '告诉我', '我想了解', '我想知道',
        '想知道', '了解一下', '请教', '问一下', '请问一下',
        'can you', 'could you', 'please', 'help me', 'i want to', 'tell me',
    ]
    # 疑问词前缀（这些词后面跟的才是真正要搜的内容）
    _QUESTION_PREFIXES = [
        '什么是', '什么叫', '怎么', '如何', '为什么',
        '有哪些', '哪种', '哪个', '哪些', '谁', '哪里', '何时',
        '请问说', '请说', '说下', '说说', '介绍一下', '介绍下',
        '请帮我', '帮我', '请给我', '给我',
        'what is', 'what are', 'how to', 'how do', 'how does', 'why',
        'who is', 'who are', 'where is', 'where are', 'when is',
    ]
    # 疑问词后缀（在句尾的）
    _QUESTION_SUFFIXES = ['是什么', '是什么意思', '是什么意思？', '是什么？',
                          '有哪些', '有哪些？', '是什么的呢',
                          '吗？', '呢？', '吧？', '啊？',
                          '吗', '呢', '吧', '啊', '？', '?', '。', '.', '的呢', '的说']
    _SUFFIXES = _QUESTION_SUFFIXES
    for p in _PREFIXES:
        if text.lower().startswith(p.lower()):
            text = text[len(p):].strip()
    for p in _QUESTION_PREFIXES:
        if text.lower().startswith(p.lower()):
            text = text[len(p):].strip()
            break
    for s in _SUFFIXES:
        if text.endswith(s):
            text = text[:-len(s)].strip()

    # 内部疑问词断句（去掉句子中间的 "有哪些"、"是什么" 等，保留两侧实词）
    _INTERNAL_Q = ['有哪些', '是什么', '有几种', '有几种类型', '包括哪些', '包含哪些']
    for q in _INTERNAL_Q:
        if q in text:
            text = text.replace(q, ' ')

    # 提取中文 2+ 字连续词
    cn_words = re.findall(r'[\u4e00-\u9fff]{2,}', text)
    # 提取英文 2+ 字母词
    en_words = re.findall(r'[a-zA-Z]{2,}', text)

    # 合并 + 过滤停用词
    keywords = []
    for w in cn_words + en_words:
        if w.lower() not in _STOP_WORDS and len(w) >= 2:
            keywords.append(w)

    # 去重（保持顺序）
    seen = set()
    unique = []
    for w in keywords:
        if w not in seen:
            seen.add(w)
            unique.append(w)

    # 规则有信心的条件：至少 1 个关键词（单个核心词也值得搜）
    if len(unique) >= 1:
        return ' '.join(unique[:8])  # 最多 8 个

    # 没提取到任何词 — 规则无信心
    return None


def _strip_prompt_echo(text: str, original: str) -> str:
    """去除小模型把 prompt 指令原样输出的情况。

    典型案例：模型输出"根据对话历史，将用户的消息改写为一个完整的独立搜索查询为：什么是刮五指？"
    实际只需要冒号后面的"什么是刮五指？"
    """
    # prompt 指令残留特征词（按长度降序排列，最精确的优先匹配）
    _PROMPT_ECHO_MARKERS = [
        '搜索关键词为', '独立搜索查询为', '搜索查询为',
        '独立查询', '改写后的', '改写为',
        '关键词为', '查询为', '改写后',
        '改写：', '补全为',
    ]
    result = text
    for marker in _PROMPT_ECHO_MARKERS:
        if marker in result:
            # 取 marker 后面的内容
            idx = result.index(marker) + len(marker)
            after = result[idx:].strip().strip('"').strip("'").strip("\u201c").strip("\u201d").strip('：: ')
            if after and len(after) >= 2:
                result = after
                # 继续检查是否有更多 marker（处理"改写后的查询为..."级联情况）
                continue
    return result


def _clean_reformulate_output(response: str, original: str) -> str:
    """清洗 LLM 的 reformulate 输出，去除元分析/编号列表等啰嗦内容

    LLM 有时会输出"1. 判断话题关联性：..."这种分析过程，
    而不是简洁的搜索关键词。本函数提取真正的搜索词。
    """
    lines = [l.strip() for l in response.strip().split('\n') if l.strip()]

    # 策略1：如果只有一行，直接用（去引号）
    if len(lines) == 1:
        result = lines[0].strip('"').strip("'").strip("\u201c").strip("\u201d")
        # P7: 小模型可能把 prompt 指令原样输出（如"根据对话历史，...改写为：XXX"）
        # 提取冒号后面的实际内容
        result = _strip_prompt_echo(result, original)
        return result

    # 策略2：过滤掉编号列表/元分析行，找真正的关键词行
    # 元分析特征：以数字编号开头、包含"判断/分析/策略/关联/属于/可以"等分析词
    _META_KEYWORDS = ['判断', '分析', '策略', '关联', '属于', '可以', '应该',
                      '需要', '首先', '然后', '步骤', '思路', '目标', '属于全新']
    candidates = []
    for line in lines:
        # 去掉编号前缀 "1." "1、" "(1)" "1)" "1:"
        cleaned = re.sub(r'^[\d]+[.、):]\s*', '', line)
        cleaned = re.sub(r'^\([\d]+\)\s*', '', cleaned)
        # 跳过元分析行
        if any(kw in cleaned for kw in _META_KEYWORDS):
            continue
        # 跳过过长的行（关键词应该简短，<30字）
        if len(cleaned) > 30:
            continue
        # 跳过以"用户"/"搜索"开头的标签行
        if cleaned.startswith('用户') or cleaned.startswith('搜索') or cleaned.startswith('关键词'):
            continue
        candidates.append(cleaned.strip('"').strip("'").strip("\u201c").strip("\u201d"))

    if candidates:
        # 取第一个候选（通常是最相关的关键词）
        return _strip_prompt_echo(candidates[0], original)

    # 策略3：全部被过滤了，退回取第一行去编号
    first = re.sub(r'^[\d]+[.、):]\s*', '', lines[0])
    return _strip_prompt_echo(first.strip('"').strip("'").strip("\u201c").strip("\u201d"), original)


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
