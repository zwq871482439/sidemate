# -*- coding: utf-8 -*-
"""
响应过滤器 — 后处理小模型输出，检测和标注常见问题

检测器：
1. 代码幻觉：代码块中中文变量名/函数名
2. 未闭合结构：代码块、括号、Markdown 列表
3. 思考外泄：正文中混入"让我想想"等自言自语
4. 重复段落：连续行重复 + N-gram 语义级重复
5. 不完整输出：空回复、半截句子、格式混乱
6. 截断检测：输出被 max_tokens 截断的痕迹
7. 综合幻觉：指令偏离、内容空洞、模板套用、事实矛盾
8. 前缀累积重复：Qwen3-8B 特有的"AB→ABC→ABCD"递增长重复模式

清理器：
- 思维链标签剥离：strip_think_tags() 统一处理 think/thinking/reason 等标签
- 思考内容重复清理：clean_think_content() 清理前缀累积和重复段落
- 废话前缀清理：去掉"好的，让我来分析"等无意义开头
- 前缀累积重复清理：从最后一次完整表达截取，去掉重复的前缀累积部分

使用方式：
    from response_filter import filter_response, clean_prefix_accumulation, strip_think_tags, clean_think_content
    result = filter_response(text)
    # result = {"text": 原文, "warnings": [...], "has_issues": bool, "cleaned": 清理后文本}
    
    # 单独调用前缀累积重复清理：
    cleaned = clean_prefix_accumulation(text)
    
    # 剥离思维链标签（models.py 统一使用）：
    cleaned = strip_think_tags(text)
    
    # 清理思考内容中的重复段落（server.py 统一使用）：
    cleaned = clean_think_content(text)
"""
__version__ = "v1.4"

import re
import logging
from typing import Tuple, List, Dict

log = logging.getLogger(__name__)

# ===== 常量 =====

# --- 思考外泄阈值 ---
_THINK_STRONG_SHORT_THRESHOLD = 1    # 短文本(<500字)强信号触发阈值
_THINK_STRONG_LONG_THRESHOLD = 2     # 长文本强信号触发阈值
_THINK_SHORT_TEXT_BOUNDARY = 500     # 短/长文本分界
_THINK_WEAK_SHORT_THRESHOLD = 3     # 短文本(<800字)弱信号触发阈值
_THINK_WEAK_LONG_THRESHOLD = 4      # 长文本弱信号触发阈值
_THINK_LONG_TEXT_BOUNDARY = 800     # 短/长文本分界

# --- 重复检测阈值 ---
_REPEAT_MIN_CONSECUTIVE = 3          # 连续行完全重复触发阈值
_NGRAM_SIMILARITY_THRESHOLD = 0.6   # N-gram 相似度触发阈值
_NGRAM_DUP_MIN_COUNT = 3            # 语义重复句子数触发阈值
_NGRAM_MIN_SENTENCE_LEN = 15        # 参与比较的最短句子长度

# --- 模板检测阈值 ---
_TEMPLATE_MIN_TEXT_LEN = 50         # 模板检测最低文本长度
_TEMPLATE_PER_CHARS = 50            # 每 N 字符预期 0-1 个模板句
_TEMPLATE_RATIO_THRESHOLD = 0.6     # 模板占比触发阈值
_TEMPLATE_MIN_HITS = 3              # 最少模板句命中数

# --- 内容空洞阈值 ---
_EMPTINESS_MIN_FORMAT_CHARS = 150   # 格式化文本最低字符数
_EMPTINESS_MAX_CONTENT_CHARS = 20   # 实质内容最高字符数（低于此为空洞）

# --- 不完整输出阈值 ---
_INCOMPLETE_MIN_LEN = 20            # "回复过短"判定的最低长度

# --- 程序报告上限 ---
_MAX_REPORT_ITEMS = 5               # 代码幻觉每个代码块最多报告条目数

# 思考外泄特征（高置信度，单独出现即触发）
_THINK_LEAK_STRONG = [
    r'让我(先|来)?(分析|看看|想想|思考|理解|梳理)',
    r'我需要(先)?(分析|检查|理解|梳理)',
    r'(好的|明白了)[，,](我|让我).{0,10}(来|先|帮)',
]

# 思考外泄特征（低置信度，需要 >=3 处才触发）
_THINK_LEAK_WEAK = [
    r'(首先|接下来|然后)[，,]?(我|让我)(需要|要|来)',
    r'(所以|因此)[，,]?(我|我需要|我应该)',
    r'(看起来|看上去|似乎).{0,20}(问题|错误|原因)',
    r'我来.{0,5}(总结|归纳|梳理|分析)',
]


def _detect_code_hallucination(text: str, user_msg: str = "") -> Tuple[List[str], List[str]]:
    """检测代码块中的中文标识符幻觉
    
    v1.2 改进：
    - 区分"中文标识符"和"真正的幻觉"：如果用户没有要求中文命名，
      代码中出现中文函数名才是问题
    - 如果用户消息中包含"中文"/"中文变量"/"中文函数"等关键词，
      说明这是有意为之，不标记
    - 中文标识符降级为"建议"而非"幻觉"
    """
    warnings = []
    suggestions = []  # 建议（非幻觉，仅为命名规范建议）
    code_blocks = re.findall(r'```[\w]*\n(.*?)```', text, re.DOTALL)

    # 检测用户是否有意要求中文命名
    user_wants_chinese = False
    if user_msg:
        chinese_intent_patterns = [
            r'中文', r'Chinese',
            r'中文变量', r'中文函数', r'中文命名',
        ]
        for pat in chinese_intent_patterns:
            if re.search(pat, user_msg, re.IGNORECASE):
                user_wants_chinese = True
                break

    for i, code in enumerate(code_blocks):
        issues = []
        # 预处理：标记注释行和字符串行，排除误报
        comment_lines = set()
        string_ranges = []  # (start, end) 字符偏移
        for lineno, line in enumerate(code.split('\n')):
            stripped = line.strip()
            if stripped.startswith('#') or stripped.startswith('//') or stripped.startswith('"""') or stripped.startswith("'''"):
                comment_lines.add(lineno)
            # 简单检测字符串（只处理单行内的引号对）
            for m in re.finditer(r'(?:"[^"]*"|\'[^\']*\')', line):
                string_ranges.append((lineno, m.start(), m.end()))

        def _in_comment_or_string(lineno, col):
            if lineno in comment_lines:
                return True
            for sl, sc, ec in string_ranges:
                if sl == lineno and sc <= col <= ec:
                    return True
            return False

        # 检测模式
        patterns = [
            (r'\[[\u4e00-\u9fff]{1,8}\]', '方括号内中文（可能幻觉变量名）'),
            (r'(?:def|class|function|var|let|const|func|fn|val)\s+[\u4e00-\u9fff]+', '中文函数/类/变量定义'),
            (r'(?:let\s+mut)\s+[\u4e00-\u9fff]+', '中文 Rust 变量定义'),
            (r'\.\s*[\u4e00-\u9fff]+\s*[=\(]', '中文属性名/方法名'),
        ]

        for pattern, desc in patterns:
            for lineno, line in enumerate(code.split('\n')):
                if lineno in comment_lines:
                    continue
                for m in re.finditer(pattern, line):
                    if not _in_comment_or_string(lineno, m.start()):
                        issues.append(f"  - {desc}: L{lineno+1} '{m.group()}'")

        if issues:
            # 最多报告 N 条，避免刷屏
            shown = issues[:_MAX_REPORT_ITEMS]
            if len(issues) > _MAX_REPORT_ITEMS:
                shown.append(f"  - ... 还有 {len(issues)-_MAX_REPORT_ITEMS} 处")
            
            if user_wants_chinese:
                # 用户有意要求中文 → 只给建议，不警告
                suggestions.append(f"代码块 #{i+1} 包含中文标识符（用户要求，符合预期）")
            else:
                # 没有明确要求中文 → 代码规范建议
                suggestions.append(f"代码块 #{i+1} 包含中文标识符 — 建议改为英文命名以提高可读性")
                # 只有非用户意图的中文标识符才算幻觉
                warnings.append(f"代码块 #{i+1} 疑似幻觉:\n" + "\n".join(shown))

    return warnings, suggestions


def _detect_unclosed_structures(text: str) -> List[str]:
    """检测未闭合的结构"""
    warnings = []

    # 未闭合代码块
    fence_count = text.count('```')
    if fence_count % 2 == 1:
        warnings.append(f"未闭合代码块（{fence_count} 个 ``` 标记）")

    # 闭合代码块内的括号平衡
    closed_blocks = re.findall(r'```[\w]*\n(.*?)```', text, re.DOTALL)
    for i, code in enumerate(closed_blocks):
        # 跳过字符串内容（简单估算）
        code_no_str = re.sub(r'(?:""[^"]*""|\'\'[^\']*\'\'|"[^"]*"|\'[^\']*\')', '', code)
        balance = 0
        for ch in code_no_str:
            if ch in '({[':
                balance += 1
            elif ch in ')}]':
                balance -= 1
        if abs(balance) >= 3:
            direction = "未闭合" if balance > 0 else "多余的"
            warnings.append(f"代码块 #{i+1} 有 {abs(balance)} 个{direction}括号")

    # 未闭合的 Markdown 粗体/斜体
    bold_count = len(re.findall(r'(?<!\*)\*\*(?!\*)', text))
    if bold_count % 2 == 1:
        warnings.append(f"未闭合的 Markdown 粗体标记")

    return warnings


def _fix_unclosed_markdown(text: str) -> str:
    """自愈未闭合的 Markdown 标记（静默修复，不告知用户）

    模型常见问题：写了 **开头 加粗但忘了写结尾 **，导致渲染错乱。
    策略：代码块外，若 ** 数量为奇数，在最后一个 ** 后的内容末尾补 ** 闭合。
    """
    if not text:
        return text
    # 保护代码块（代码里的 ** 是指针/乘法，不能动）
    code_blocks = []
    def _stash(m):
        code_blocks.append(m.group(0))
        return '\x00CB%d\x00' % (len(code_blocks) - 1)
    protected = re.sub(r'```.*?```', _stash, text, flags=re.DOTALL)
    # 统计代码块外的 ** 数量
    bold_count = len(re.findall(r'(?<!\*)\*\*(?!\*)', protected))
    if bold_count % 2 == 1:
        # 找到最后一个 ** 的位置，在其后的正文末尾补闭合
        last_bold = protected.rfind('**')
        if last_bold >= 0:
            protected = protected + '**'
    # 还原代码块
    for i, block in enumerate(code_blocks):
        protected = protected.replace('\x00CB%d\x00' % i, block)
    return protected


def _detect_thinking_leak(text: str) -> List[str]:
    """检测正文中外泄的"思考过程"
    
    策略：强信号 1 处即报，弱信号 >=3 处才报
    """
    warnings = []

    # 去掉代码块内容（代码里的注释不算外泄）
    text_no_code = re.sub(r'```.*?```', '', text, flags=re.DOTALL)

    strong_hits = []
    for pat in _THINK_LEAK_STRONG:
        strong_hits.extend(re.findall(pat, text_no_code))

    weak_hits = []
    for pat in _THINK_LEAK_WEAK:
        weak_hits.extend(re.findall(pat, text_no_code))

    # 强信号：2 处以上即警告（短文本 1 处就报）
    threshold_strong = _THINK_STRONG_SHORT_THRESHOLD if len(text_no_code) < _THINK_SHORT_TEXT_BOUNDARY else _THINK_STRONG_LONG_THRESHOLD
    if len(strong_hits) >= threshold_strong:
        warnings.append(f"检测到自我分析文本（强特征 {len(strong_hits)} 处），建议精简")

    # 弱信号：>=4 处才报（短文本 >=3）
    threshold_weak = _THINK_WEAK_SHORT_THRESHOLD if len(text_no_code) < _THINK_LONG_TEXT_BOUNDARY else _THINK_WEAK_LONG_THRESHOLD
    if len(weak_hits) >= threshold_weak:
        warnings.append(f"检测到自我分析文本（弱特征 {len(weak_hits)} 处），建议精简")

    return warnings


def _detect_repetition(text: str) -> List[str]:
    """检测重复内容：连续行重复 + N-gram 语义重复 + 关键词重叠重复"""
    warnings = []

    lines = [l.strip() for l in text.split('\n') if l.strip()]
    if len(lines) < 3:
        return warnings

    # 1) 连续行完全重复
    max_repeat = 1
    repeat_count = 1
    for i in range(1, len(lines)):
        if lines[i] == lines[i - 1] and len(lines[i]) > 8:
            repeat_count += 1
            max_repeat = max(max_repeat, repeat_count)
        else:
            repeat_count = 1
    if max_repeat >= _REPEAT_MIN_CONSECUTIVE:
        warnings.append(f"连续 {max_repeat} 行重复")

    # 2) N-gram 重复检测（句子级别）
    # 去掉代码块后检测
    text_clean = re.sub(r'```.*?```', '', text, flags=re.DOTALL)
    # 按句号/问号/感叹号分割
    sentences = re.split(r'[。！？\n]', text_clean)
    sentences = [s.strip() for s in sentences if len(s.strip()) > _NGRAM_MIN_SENTENCE_LEN]

    if len(sentences) >= 3:
        # 用 3-gram 比较句子相似度
        def _trigrams(s):
            return set(s[i:i + 3] for i in range(len(s) - 2))

        # 用 bigram 提取关键词（比 trigram 更宽松，能捕捉换词重复）
        def _bigrams(s):
            return set(s[i:i + 2] for i in range(len(s) - 1))

        # 优化：只比较相邻的 10 句，避免 O(n^2) 全量比较
        _WINDOW = 10
        dup_count = 0
        for idx in range(len(sentences)):
            s = sentences[idx]
            tg = _trigrams(s)
            bg = _bigrams(s)
            if not tg:
                continue
            start = max(0, idx - _WINDOW)
            for prev_idx in range(start, idx):
                prev_s = sentences[prev_idx]
                prev_tg = _trigrams(prev_s)
                prev_bg = _bigrams(prev_s)
                # trigram jaccard（严格匹配）
                overlap = len(tg & prev_tg)
                union = len(tg | prev_tg)
                trigram_sim = overlap / union if union > 0 else 0
                # bigram jaccard（宽松匹配，适合检测换词重复）
                bg_overlap = len(bg & prev_bg)
                bg_union = len(bg | prev_bg)
                bigram_sim = bg_overlap / bg_union if bg_union > 0 else 0
                # 综合判定：trigram 高度相似 OR bigram 中度相似+句子长度接近
                len_ratio = min(len(s), len(prev_s)) / max(len(s), len(prev_s)) if max(len(s), len(prev_s)) > 0 else 0
                is_dup = (trigram_sim > _NGRAM_SIMILARITY_THRESHOLD or
                          (bigram_sim > 0.45 and len_ratio > 0.6))
                if is_dup:
                    dup_count += 1
                    break

        if dup_count >= _NGRAM_DUP_MIN_COUNT:
            warnings.append(f"检测到 {dup_count} 个语义重复的句子")

    # 3) 回复过长检测（text 模式简单问答场景）
    # 如果总长度 > 600 字且没有代码块、列表等结构化内容，
    # 可能是模型冗长重复（8B 模型 /no_think 模式的已知问题）
    if len(text_clean) > 600:
        has_structure = bool(re.search(r'```|^\d+[.、]|^[-*•]|\*\*|##', text_clean, re.MULTILINE))
        if not has_structure:
            # 纯文本超过 600 字，检查是否真的有这么多实质性内容
            unique_chars = len(set(text_clean.replace('\n', '').replace(' ', '')))
            total_chars = len(text_clean.replace('\n', '').replace(' ', ''))
            if total_chars > 0:
                char_diversity = unique_chars / total_chars
                # 字符多样性低于 0.35 → 大量重复词汇
                if char_diversity < 0.35:
                    warnings.append(f"回复冗长且重复（{total_chars}字，字符多样性{char_diversity:.2f}），建议精简")

    return warnings


# ===== 前缀累积重复检测与清理（v1.4 新增） =====
# Qwen3-8B 典型病态输出模式：
# "我是我是办公我是办公助手我是办公助手，专注于我是办公助手，专注于提升..."
# = 每次循环输出从某段起始文本开始的递增长前缀
# 检测：全文 4-gram 频率分析
# 清理：从最后一个完整句子截取（去掉重复的前缀累积部分）

_PREFIX_ACCUM_MIN_TEXT_LEN = 50      # 最短触发长度（降低到50，91字的输出不应被跳过）
_PREFIX_ACCUM_4GRAM_THRESHOLD = 8    # top 4-gram 出现次数阈值（正常文本 ≤ 5）
_PREFIX_ACCUM_SAME_COUNT_THRESHOLD = 3  # 同句重复保护阈值

# LaTeX 命令模式：数学推理中 \frac, \sqrt, \text 等会高频出现，属于正常内容
# 模式1: LaTeX 命令片段 (\fra, \sqr, \tex 等)
# 模式2: 数学高频词片段 (frac, sqrt, over, dfrac 等)
_LATEX_4GRAM_PATTERNS = re.compile(r'^\\[a-z]{2,3}$')  # \fra, \sqr, \tex, \lef, \rig ...
_MATH_COMMON_4GRAMS = frozenset([
    'frac', 'sqr', 'sqrt', 'over',  # LaTeX math 常见片段
])

# 中文常见句首短语：这些 4-gram 在正常中文文本中高频出现，不是前缀累积
# 例如 "您好，请" 会在问候语中出现多次，"我可以" 会在自我介绍中出现多次
_CN_COMMON_PHRASE_4GRAMS = frozenset([
    '您好，请',  # 问候语前缀
    '我可以帮', '我可以为', '我可以提',  # 自我介绍
    '请问您需', '请问有什',  # 服务用语
    '很高兴为', '很高兴认',  # 礼貌用语
])

def _is_latex_or_math_4gram(ngram: str) -> bool:
    """判断 4-gram 是否为 LaTeX 命令或数学公式高频片段"""
    if _LATEX_4GRAM_PATTERNS.match(ngram):
        return True
    return ngram in _MATH_COMMON_4GRAMS

def _is_cn_common_phrase(ngram: str) -> bool:
    """判断 4-gram 是否为中文常见句首短语（非前缀累积）"""
    return ngram in _CN_COMMON_PHRASE_4GRAMS

# 数学/LaTeX 文本检测模式：如果文本中包含这些模式，说明是数学推理输出
# 前缀累积不会包含这些模式，所以可以安全跳过
_MATH_TEXT_PATTERN = re.compile(
    r'(?:\\frac|\\sqrt|\\overline|\\sum|\\int|\\frac\{|\$\$|\\\(|\\\[|\\\\frac|'
    r'frac\(|\d+[+\-*/=]\d+[+\-*/=]|≈|≠|≤|≥|∞|×|÷|→|⟹|'
    r'\\\d+/\d+|'
    r'方程|函数|积分|微分|矩阵|向量|几何|概率论|微积分|三角|'
    r'注满需要\d+小时|水管.*效率|总效率)',
    re.IGNORECASE
)

def _looks_like_math_text(text: str) -> bool:
    """判断文本是否为数学推理内容（数学推理中 4-gram 高频是正常的）"""
    if not text or len(text) < 30:
        return False
    matches = _MATH_TEXT_PATTERN.findall(text)
    return len(matches) >= 2  # 至少2个数学特征


# 代码文本检测：含代码块的文本不应被前缀累积清理误伤
# （代码的缩进/重复关键字/方法链会触发 4-gram 高频，但那是正常的代码结构）
_CODE_BLOCK_PATTERN = re.compile(r'```')
# 显著缩进（4空格/tab 开头的行 ≥ 3 行）—— 函数体/类体的标志
_INDENT_LINE_PATTERN = re.compile(r'^(?: {4,}|\t+)\S', re.MULTILINE)
# 常见编程关键字密集出现
_CODE_KEYWORD_PATTERN = re.compile(
    r'(?:def |class |function |import |from |return |if |for |while |'
    r'public |private |const |let |var |=>|;|\{\}|\[\])'
)

def _looks_like_code_text(text: str) -> bool:
    """判断文本是否含代码（代码的重复结构不应被当作前缀累积误清理）"""
    if not text or len(text) < 30:
        return False
    # 1. 含 markdown 代码块（``` 围栏）—— 最强信号
    if _CODE_BLOCK_PATTERN.search(text):
        return True
    # 2. 显著缩进行 ≥ 3（函数体/循环体的标志）
    if len(_INDENT_LINE_PATTERN.findall(text)) >= 3:
        return True
    # 3. 编程关键字密集（≥ 4 个）
    if len(_CODE_KEYWORD_PATTERN.findall(text)) >= 4:
        return True
    return False


def detect_prefix_accumulation(text: str) -> Tuple[bool, str]:
    """检测前缀累积重复模式
    
    Args:
        text: 待检测文本
        
    Returns:
        (detected, warning_msg): 是否检测到, 警告信息
    """
    if not text or len(text) < _PREFIX_ACCUM_MIN_TEXT_LEN:
        return False, ""
    
    # 数学/公式推理文本天然包含高频重复片段（如 \frac{}{}），
    # 流式 delta filter 已处理真正的累积，此处跳过数学文本
    if _looks_like_math_text(text):
        return False, ""
    
    from collections import Counter
    
    # 全文 4-gram 频率分析
    fourgrams = Counter(text[i:i+4] for i in range(len(text) - 3))
    if not fourgrams:
        return False, ""
    
    # 跳过 LaTeX 命令片段：数学推理中 \frac, \sqrt 等高频出现是正常的
    # 同时跳过中文常见句首短语（如"您好，请"在问候语中重复是正常的）
    # 按频率排序，找到第一个非 LaTeX、非常见短语的 top 4-gram
    for top_4g, top_4c in fourgrams.most_common(5):
        if _is_latex_or_math_4gram(top_4g):
            continue
        if _is_cn_common_phrase(top_4g):
            continue
        # 正常文本中 top 4-gram 出现 ≤ 5 次
        # 前缀累积中 top 4-gram 出现 ≥ 8 次
        if top_4c >= _PREFIX_ACCUM_4GRAM_THRESHOLD:
            return True, f"前缀累积重复（4-gram '{top_4g}' 出现 {top_4c} 次）"
        break  # 第一个非 LaTeX/常见短语 的 4-gram 频率不够，说明无累积
    
    return False, ""


def clean_prefix_accumulation(text: str, max_len: int = 2000) -> str:
    """清理输出中的前缀累积重复内容
    
    Qwen3-8B 典型病态输出模式：
    Pattern 1（单一递增）:
      "我是我是办公我是办公助手我是办公助手，专注于我是办公助手，专注于提升..."
      = 每次循环输出从某段起始文本开始的递增长前缀
    
    Pattern 2（多组交织）:
      "我可以我可以协助我可以协助处理...我可以协助处理文档编辑、数据整理与分析等工作。
       我可以协助处理文档编辑、数据整理与分析等工作。
       我能够我能够提供我能够提供会议...我能够提供会议纪要撰写及日程安排建议等我可以协助处理文档编辑、数据整理与分析等工作。"
      = 多组独立的递增序列，每组有自己的"基线句子"，交织出现
    
    检测方法：全文 4-gram 频率分析确认重复
    清理策略：找到文本中的"独立完整句子"——不被其他句子的前缀包含
    
    Args:
        text: 待清理文本
        max_len: 最大输出长度
        
    Returns:
        清理后的文本
    """
    if not text or len(text) < _PREFIX_ACCUM_MIN_TEXT_LEN:
        return text
    
    # 数学/公式推理文本跳过（与 detect_prefix_accumulation 保持一致）
    if _looks_like_math_text(text):
        return text[:max_len]
    
    # 代码文本跳过：代码的缩进/重复结构会触发 4-gram 误判，但那是正常代码结构，
    # 不应被前缀累积清理误伤（否则会把完整函数截断成一两行）
    if _looks_like_code_text(text):
        return text[:max_len]
    
    from collections import Counter
    
    # 全文 4-gram 频率分析
    fourgrams = Counter(text[i:i+4] for i in range(len(text) - 3))
    if not fourgrams:
        return text[:max_len]
    
    # 跳过 LaTeX 命令片段和中文常见句首短语，找到第一个真正的 top 4-gram
    top_4g = None
    top_4c = 0
    for _4g, _4c in fourgrams.most_common(5):
        if _is_latex_or_math_4gram(_4g):
            continue
        if _is_cn_common_phrase(_4g):
            continue
        top_4g, top_4c = _4g, _4c
        break
    
    if not top_4g or top_4c < _PREFIX_ACCUM_4GRAM_THRESHOLD:
        return text[:max_len]  # 无重复（或仅 LaTeX 重复）
    
    # 句子分割（供策略1使用）
    _sent_split = re.split(r'([。！？\n])', text)
    merged = []
    for _i in range(0, len(_sent_split) - 1, 2):
        _s = _sent_split[_i].strip()
        _punct = _sent_split[_i + 1] if _i + 1 < len(_sent_split) else ''
        if _s:
            merged.append(_s + _punct)
    if len(_sent_split) % 2 == 1 and _sent_split[-1].strip():
        merged.append(_sent_split[-1].strip())
    
    # === 策略1：多句子模式下找最后一个独立句子 ===
    # 只有 >= 2 个句子时才有意义做句子间对比
    if len(merged) >= 2:
        best_candidate = ""
        for i in range(len(merged) - 1, -1, -1):
            s = merged[i].strip()
            if len(s) < 15:
                continue
            # 检查这个句子是否以某个更短的句子开头（= 它是某个累积链的扩展）
            is_extension = False
            for j in range(max(0, i - 5), i):
                prev_s = merged[j].strip()
                if len(prev_s) >= 5 and s.startswith(prev_s) and len(s) > len(prev_s):
                    is_extension = True
                    break
            # 检查这个句子后面是否紧跟了另一句的开头（= 它是基线，后面在递增新组）
            # 在多组交织模式中，最后一组递增的最终完整句子就是最好的候选
            
            if not is_extension:
                best_candidate = s
                break
            else:
                # 即使是扩展，如果是最后一个有句号的完整句子，也可以用
                if not best_candidate and s.endswith(('。', '！', '？')):
                    best_candidate = s
        
        # 如果找到好的候选，用它替换
        if best_candidate and len(best_candidate) >= 15:
            # 排比句保护：如果候选在原文中出现 >= 3 次，可能是排比句
            if text.count(best_candidate) < _PREFIX_ACCUM_SAME_COUNT_THRESHOLD:
                log.info("[REPEAT] 前缀累积重复清理: %d字 → %d字 (top 4-gram '%s' 出现%d次)" % (
                    len(text), len(best_candidate), top_4g, top_4c))
                return best_candidate[:max_len]
    
    # === 策略2：回退到简单截取 ===
    last_pos = text.rfind(top_4g)
    if last_pos < 10:
        return text[:max_len]
    
    cleaned = text[last_pos:].strip()
    if cleaned and any(ch in cleaned for ch in '。！？') and len(cleaned) >= 20:
        if text.count(cleaned) >= _PREFIX_ACCUM_SAME_COUNT_THRESHOLD:
            return text[:max_len]
        log.info("[REPEAT] 前缀累积重复清理(回退): %d字 → %d字" % (len(text), len(cleaned)))
        return cleaned[:max_len]
    
    return text[:max_len]



def _detect_incomplete(text: str) -> List[str]:
    """检测不完整的输出"""
    warnings = []

    # 空回复
    if not text or not text.strip():
        warnings.append("模型输出为空")
        return warnings

    stripped = text.strip()

    # 纯代码块但没有文字说明（短回复 < 50 字可能是正常简答）
    if len(stripped) < _INCOMPLETE_MIN_LEN and not re.search(r'[\u4e00-\u9fff]', stripped):
        warnings.append("回复过短且无中文内容")

    # 截断痕迹：末尾是省略号后面什么都没有，或者末尾是未完成的代码行
    truncation_patterns = [
        r'\|[\s]*$',                           # 表格未闭合
        r'```[\w]*\n[\s]*$',                   # 代码块开头后截断
        r'[（\(]\s*$',                          # 括号开了没关
        r'[，、]\s*$',                          # 逗号结尾（中文不会以逗号结尾）
        r'第[一二三四五六七八九十\d]+[步章节][：:]\s*$',  # "第一步：" 后面没了
    ]
    for pat in truncation_patterns:
        if re.search(pat, stripped.split('\n')[-1]):
            warnings.append("输出疑似被截断（末尾不完整）")
            break

    # 末尾以未完成句子结尾（没有句号/问号/感叹号/代码块/列表）
    last_line = stripped.split('\n')[-1].strip()
    if last_line and len(last_line) > 20:
        ends_with_punct = re.search(r'[。！？.?!`：:—…]$', last_line)
        ends_with_code = last_line.endswith('```')
        ends_with_list = re.match(r'^\s*[-*•]\s', last_line)
        if not ends_with_punct and not ends_with_code and not ends_with_list:
            # 可能被截断
            if re.search(r'[\u4e00-\u9fff]{3,}', last_line):
                warnings.append("输出可能不完整（末尾无标点结束）")

    return warnings


def _detect_format_consistency(text: str) -> List[str]:
    """检测 Markdown 列表格式不一致（如有序列表某项缺少加粗）

    常见问题：模型输出有序列表时，某些项缺少 ** 加粗标记，
    导致前端渲染不一致（如 "2.敏锐的设备管理" 缺少 **）
    """
    warnings = []
    lines = text.split('\n')

    # 检测有序列表格式一致性（按序号连续性分组）
    numbered_items = []
    for line in lines:
        stripped = line.strip()
        m = re.match(r'^(\d+)[.、]\s*(.+)', stripped)
        if m:
            has_bold = bool(re.search(r'\*\*.+\*\*', m.group(2)))
            numbered_items.append({
                'num': int(m.group(1)),
                'text': stripped[:60],
                'has_bold': has_bold,
            })

    # 按连续序号分组（允许中间穿插非列表行）
    if numbered_items:
        groups = []
        current = [numbered_items[0]]
        for item in numbered_items[1:]:
            # 序号连续或从1重新开始 → 新组
            if item['num'] == 1 or item['num'] != current[-1]['num'] + 1:
                groups.append(current)
                current = [item]
            else:
                current.append(item)
        groups.append(current)

        for group in groups:
            if len(group) >= 3:
                bold_count = sum(1 for item in group if item['has_bold'])
                no_bold_count = len(group) - bold_count
                if bold_count >= 2 and no_bold_count >= 1 and no_bold_count <= len(group) // 2:
                    bad_items = [item for item in group if not item['has_bold']]
                    nums = ', '.join(str(item['num']) for item in bad_items)
                    warnings.append(f"列表格式不一致：第 {nums} 项缺少 ** 加粗标记")

    # 检测无序列表格式一致性（按连续组分组）
    bullet_groups = []
    current_bullet_group = []
    for line in lines:
        stripped = line.strip()
        m = re.match(r'^[-*•]\s+(.+)', stripped)
        if m:
            has_bold = bool(re.search(r'\*\*.+\*\*', m.group(1)))
            current_bullet_group.append({'text': stripped[:60], 'has_bold': has_bold})
        else:
            if current_bullet_group:
                bullet_groups.append(current_bullet_group)
                current_bullet_group = []
    if current_bullet_group:
        bullet_groups.append(current_bullet_group)

    for group in bullet_groups:
        if len(group) >= 3:
            bold_count = sum(1 for item in group if item['has_bold'])
            no_bold_count = len(group) - bold_count
            if bold_count >= 2 and no_bold_count >= 1 and no_bold_count <= len(group) // 2:
                warnings.append(f"无序列表格式不一致：{no_bold_count} 项缺少 ** 加粗标记")

    return warnings


# ===== 综合幻觉检测（v1.1 新增） =====

# 模板句式（小模型高频套用）
_TEMPLATE_PATTERNS = [
    r'总(的)?来说[，,]',
    r'综上所述[，,]',
    r'在当今(社会|时代|世界)',
    r'随着(科技|技术|时代)(的)?发展',
    r'(不可|很难|无法)(否认|忽视)(的)?是',
    r'(发挥|起到)(了)?(重要|关键|积极)(的)?作用',
    r'(极大|有效|显著)(地)?提升了?(工作效率|生活质量)',
    r'(推动|促进)(了)?\S+(的)?发展',
]

# 指令关键词映射（用户说了什么，回复应该包含什么）
_INSTRUCTION_KEYWORDS = {
    'python': ['python', 'def ', 'return ', 'import '],
    '函数': ['def ', 'function', 'return '],
    '列表': ['list', '[', 'for '],
    '偶数': ['% 2', '%2', 'even', 'mod 2'],
    '平方': ['** 2', '**2', '^2', '* x', 'pow('],
    '计算': ['=', '==', 'result', 'sum'],
    '英文': ['a-z'],  # 如果要求英文却给了中文，检测偏离
}

# 身份虚构模式：模型自称与系统设定不符的身份/能力
# 桌伴的身份是"本地AI办公助手"，不应自称其他身份或虚构能力参数
_IDENTITY_FABRICATION_PATTERNS = [
    (r'我是\s*(Qwen|qwen|通义千问|ChatGPT|GPT|Claude|Llama|DeepSeek)', '身份虚构：自称非桌伴的AI模型'),
    (r'由\s*(阿里|OpenAI|Anthropic|Meta|Google|百度|字节)\s*(推出|开发|研发|打造)', '身份虚构：声称由其他公司开发'),
    (r'支持\s*\d+[Kk]\s*(超长|超大的?|长)?\s*上下文', '身份虚构：虚构上下文窗口参数'),
    (r'我是.*(?:最新|先进|强大)(?:的)?(?:大|语言)?模型', '身份虚构：使用模型营销话术自我描述'),
]


def _detect_hallucination(text: str, user_msg: str = "") -> Tuple[List[str], List[str]]:
    """综合幻觉检测

    检测类型：
    1. 指令偏离 — 用户要求 vs 回复内容不匹配
    2. 内容空洞 — 格式撑面子但没有实质内容
    3. 模板套用 — 高频通用句式占比过高
    4. 代码语言混淆 — 代码中中英文标识符混用比例异常（警告级，非幻觉）
    5. 数学矛盾 — 简单数值自相矛盾
    """
    warnings = []
    corrections = []  # 纠正建议（与 warnings 分开，前端可选择性展示）
    if not text or not text.strip():
        return warnings, corrections

    stripped = text.strip()

    # --- 1. 模板套用检测 ---
    text_no_code = re.sub(r'```.*?```', '', stripped, flags=re.DOTALL)
    template_hits = 0
    for pat in _TEMPLATE_PATTERNS:
        template_hits += len(re.findall(pat, text_no_code))

    if len(text_no_code) > _TEMPLATE_MIN_TEXT_LEN:
        template_ratio = template_hits / (len(text_no_code) / _TEMPLATE_PER_CHARS)  # 每50字预期0-1个模板句
        if template_ratio > _TEMPLATE_RATIO_THRESHOLD and template_hits >= _TEMPLATE_MIN_HITS:
            warnings.append(f"疑似模板套用（{template_hits} 处通用句式，占比过高）")

    # --- 2. 内容空洞检测 ---
    # 去掉所有格式标记，看剩余实质内容（有代码块的回复不算空洞）
    has_code = bool(re.search(r'```\w*\n', stripped))
    if not has_code:
        content_only = re.sub(r'```.*?```', '', stripped, flags=re.DOTALL)
        content_only = re.sub(r'[#*>`\-\[\](){}|]', '', content_only)  # 去格式符号
        content_only = re.sub(r'\s+', '', content_only)  # 去空白

        if len(content_only) < _EMPTINESS_MAX_CONTENT_CHARS and len(stripped) > _EMPTINESS_MIN_FORMAT_CHARS:
            # 格式很多但内容很少（不含代码块的情况）
            warnings.append("内容空洞（大量格式但实质内容不足20字）")

    # --- 3. 代码语言混淆检测（增强版） ---
    code_blocks = re.findall(r'```[\w]*\n(.*?)```', stripped, re.DOTALL)
    for i, code in enumerate(code_blocks):
        code_lines = code.split('\n')
        non_comment_lines = []
        for line in code_lines:
            s = line.strip()
            if s and not s.startswith('#') and not s.startswith('//'):
                # 去掉字符串内容
                line_no_str = re.sub(r'(?:"[^"]*"|\'[^\']*\')', '', s)
                non_comment_lines.append(line_no_str)

        if not non_comment_lines:
            continue

        code_text = '\n'.join(non_comment_lines)
        # 统计中文标识符 vs 英文标识符
        cn_idents = re.findall(r'(?:def|class|function|var|let|const|func|fn|val)\s+([\u4e00-\u9fff]+)', code_text)
        en_idents = re.findall(r'(?:def|class|function|var|let|const|func|fn|val)\s+([a-zA-Z_]\w*)', code_text)

        if cn_idents and not en_idents:
            # 所有定义都是中文 — 这是小模型的常见行为（遵循了"全中文"系统提示），
            # 严格说不是幻觉，但代码中用中文命名不符合最佳实践，给出纠正建议
            corrections.append(f"代码块 #{i+1} 建议纠正：函数名 '{', '.join(cn_idents[:3])}' 建议改为英文命名（如 calculate_sum, process_data 等）")
            # 仍保留为轻量级警告（不标记为幻觉）
            warnings.append(f"代码块 #{i+1} 语言混淆：所有标识符均为中文（{', '.join(cn_idents[:3])}）— 建议改为英文命名")
        elif cn_idents and en_idents and len(cn_idents) > len(en_idents):
            # 中文多于英文
            corrections.append(f"代码块 #{i+1} 建议纠正：中文标识符({len(cn_idents)})多于英文({len(en_idents)})，建议统一使用英文命名")
            warnings.append(f"代码块 #{i+1} 语言偏离：中文标识符({len(cn_idents)})多于英文({len(en_idents)})")

    # --- 4. 指令偏离检测（需要 user_msg） ---
    if user_msg:
        # 检测是否要求英文命名但给了中文
        require_english = bool(re.search(r'英文|english|English|命名|变量名|函数名', user_msg, re.IGNORECASE))
        if require_english:
            for i, code in enumerate(code_blocks):
                if re.search(r'(?:def|class|function|func|fn)\s+[\u4e00-\u9fff]+', code):
                    corrections.append(f"代码块 #{i+1} 未遵从指令：要求英文命名但使用了中文标识符，建议修改")
                    warnings.append(f"代码块 #{i+1} 未遵从指令：要求英文命名但使用了中文标识符")
                    break  # 只报一次

        # 检测回复是否遗漏了用户要求的关键内容
        required_keywords = []
        for keyword, expected in _INSTRUCTION_KEYWORDS.items():
            if keyword in user_msg:
                required_keywords.append((keyword, expected))

        missing = []
        for kw, expected_list in required_keywords:
            # 至少有一个 expected 关键词出现在回复中
            found = any(re.search(re.escape(e) if not e.isalpha() else e, stripped, re.IGNORECASE) for e in expected_list)
            if not found:
                missing.append(kw)

        if len(missing) >= 2:
            warnings.append(f"指令偏离：回复可能缺少关键要素（{', '.join(missing)}）")

    # --- 5. 简单数学矛盾检测（增强版） ---
    # 检测回复中出现的数值是否有矛盾
    math_values = {}
    # 匹配 "X = 数字" 或 "约 数字" 或 "等于 数字" 模式
    for m in re.finditer(r'(?:结果|答案|总值|合计|约为?|等于?|总共|共|和为)\s*[：:=是]?\s*([\d.]+)', text_no_code):
        try:
            val = float(m.group(1))
            if val > 0:
                math_values[m.group(0)[:30]] = val
        except ValueError:
            pass

    # 如果出现多个不同的最终答案值，检查是否矛盾
    final_values = list(set(math_values.values()))
    if len(final_values) >= 2:
        # 排除明显的中间步骤（小值 vs 最终值）
        # 只在差值 > 10% 时报告
        max_val = max(final_values)
        divergent = [v for v in final_values if abs(v - max_val) / max_val > 0.1]
        if len(divergent) >= 2:
            warnings.append(f"数值矛盾：回复中出现多个不同的结果值（{', '.join('%.2f' % v for v in sorted(divergent)[:3])}）")
            corrections.append(f"数值自相矛盾，请验算以下值：{', '.join('%.2f' % v for v in sorted(divergent)[:3])}")

    # --- 6. 未闭合 Markdown 格式检测 ---
    # 检测未闭合的粗体标记
    bold_markers = re.findall(r'\*\*', text_no_code)
    if len(bold_markers) % 2 == 1:
        warnings.append("未闭合的 Markdown 粗体标记")
        corrections.append("检查 **...** 配对是否完整")

    # 检测表格行数不一致
    table_lines = [l for l in text_no_code.split('\n') if '|' in l and l.strip().startswith('|')]
    if len(table_lines) >= 2:
        col_counts = set()
        for tl in table_lines:
            if not re.match(r'^\|[\s\-:|]+\|$', tl.strip()):  # 跳过分隔行
                col_counts.add(tl.count('|'))
        if len(col_counts) >= 2:
            warnings.append(f"表格格式不一致（列数不统一：{col_counts}）")

    # --- 7. 身份虚构检测 ---
    # 模型自称非桌伴的身份，或虚构不属于自己的能力参数
    for pat, desc in _IDENTITY_FABRICATION_PATTERNS:
        if re.search(pat, stripped, re.IGNORECASE):
            warnings.append(f"疑似幻觉：{desc}")
            corrections.append("你是「桌伴」本地AI办公助手，不应自称其他模型或虚构技术参数")
            break  # 只报一次

    return warnings, corrections


def strip_think_tags(text: str) -> str:
    """过滤 LLM 输出中的所有标准思维链标签（统一实现）

    处理四种情况：
    1. 标准闭合标签: <think...>content</think...>
    2. 换行分隔的标签: <think\\ncontent\\n</think\\n
    3. 开始标签开头但无闭合（dangling think，仅处理文本开头，避免误删正文中的 <think 文字）
    4. 其他标签类型: <thinking>, <reason>, <reasoning>, <thought>

    合并自 models.py _strip_think() 的统一版本。

    Args:
        text: LLM 原始输出文本

    Returns:
        去除思维链标签后的文本
    """
    if not text:
        return text

    # 1. 标准闭合标签（宽松匹配：开始和结束标签都可以有/无属性和 >）
    text = re.sub(r'<think[^>]*>.*?</think[^>]*>', '', text, flags=re.DOTALL)
    # 2. 闭合标签（换行分隔，无 >）
    text = re.sub(r'<think\s*\n.*?</think\s*\n', '\n', text, flags=re.DOTALL)

    # 3. 开头的 dangling think：以 <think 开头但无闭合标签
    #    只处理文本开头的情况（避免误删正文中的合法文字）
    if text.startswith('<think'):
        # 找不到闭合标签 → 从开头删到正文开始
        end_tag = text.find('</think')      # 标准
        if end_tag >= 0:
            # 有结束标签但之前的 regex 没匹配 → 尝试手动剥离
            remaining = text[end_tag:]
            close_gt = remaining.find('>')
            if close_gt >= 0:
                after_end = end_tag + close_gt + 1
            else:
                after_end = end_tag + len('</think')
            text = text[after_end:].lstrip('\n')
        else:
            # P0-80: dangling think — 模型输出了 <think...> 但没有闭合
            # 启发式判断：如果内容很长(>100字)则视为思考过程→丢弃
            # 短内容可能是模型直接在think标签后输出了正文→保留
            tag_end = text.find(">", len("<think"))
            if tag_end < 0:
                tag_end = text.find("\n", len("<think"))
            if tag_end >= 0:
                after_tag = text[tag_end + 1:].lstrip("\n")
                if not after_tag:
                    text = ''
                elif len(after_tag) > 200:
                    # 长内容 = 思考过程（用户报告的1837字泄露就属于此类）
                    text = ''
                else:
                    # 短/中等内容 = 可能是正文，保留
                    text = after_tag
            else:
                # <think 后无 > 也无 \n，可能直接跟正文（如 <think好的）
                after_bare = text[len("<think"):]
                if after_bare and len(after_bare) < 100:
                    # 短内容 = 可能是正文，保留
                    text = after_bare
                else:
                    text = ''

    # 4. 其他标签类型（thinking, reason, reasoning, thought）— 闭合标签
    for tag in ["thinking", "reason", "reasoning", "thought"]:
        text = re.sub(r'<%s[^>]*>.*?</%s[^>]*>' % (tag, tag), '', text, flags=re.DOTALL)
    # 5. 其他标签类型 — 未闭合的 dangling（匹配 <tag 后跟任意内容直到文本末尾）
    for tag in ["thinking", "reason", "reasoning", "thought"]:
        text = re.sub(r'<%s\b.*$' % tag, '', text, flags=re.DOTALL)

    return text.strip()


def clean_think_content(text: str, max_len: int = 2000) -> str:
    """清理思考内容中的重复段落（从 server.py 统一到 response_filter.py）

    专门检测 Qwen3-8B 的前缀累积重复模式：
    正常文本: "A。B。C。"（等长句子）
    病态文本: "A" + "AB" + "ABC" + "ABCD"（递增长前缀累积）

    Args:
        text: 思考内容文本
        max_len: 最大输出长度

    Returns:
        清理后的思考内容
    """
    if not text:
        return ""

    # 4-gram 前缀累积检测（补充按行分割的盲区：无标点单行累积）
    # 例："您好您好，请您好，请告诉我您好，请告诉我您需要..."
    # 即使文本较短（50-100字）也检测，因为前缀累积可在短文本中密集出现
    if len(text) >= 40:
        from collections import Counter as _Ctr
        _4GRAM_THRESHOLD = 6
        fourgrams = _Ctr(text[i:i+4] for i in range(len(text) - 3))
        for _4g, _4c in fourgrams.most_common(3):
            if _is_latex_or_math_4gram(_4g):
                continue
            if _4c >= _4GRAM_THRESHOLD:
                clean = text[:80] + "\n...[思考内容重复，已省略]...\n"
                return clean[:max_len]
            break

    if len(text) < 100:
        return text[:max_len]

    # 检测前缀累积模式：文本末尾是否包含大量递增长的子串
    # 方法：将文本按行分割，检查连续行是否是前一行的前缀扩展
    lines = text.replace('。', '。\n').replace('\\n', '\n').split('\n')
    lines = [l.strip() for l in lines if l.strip()]
    if len(lines) >= 6:
        accum_count = 0
        for i in range(1, min(len(lines), 15)):
            prev = lines[i - 1]
            curr = lines[i]
            if len(curr) > len(prev) and curr.startswith(prev):
                accum_count += 1
        if accum_count >= 4:
            clean = text[:100] + "\n...[思考内容重复，已省略]...\n"
            return clean[:max_len]

    # 通用重复检测：长文本中同一段出现极多次
    if len(text) >= 300:
        from collections import Counter
        tail = text[-400:]
        substrings = [tail[i:i+15] for i in range(len(tail) - 14)]
        if substrings:
            top_sub, top_count = Counter(substrings).most_common(1)[0]
            if top_count >= 20:
                clean = text[:100] + "\n...[思考内容重复，已省略]...\n"
                return clean[:max_len]

    return text[:max_len]


def _clean_thinking_prefix(text: str) -> str:
    """清理开头常见的废话前缀
    
    多轮清理：先删客套词，再删"让我来"类前缀，最后清理残留标点
    """
    cleaned = text

    # 第一轮：删短客套 + 紧跟的逗号/句号
    for _ in range(2):  # 最多处理2层前缀
        m = re.match(r'^(好的|明白了|没问题|当然|是的)[，,。！？]?\s*', cleaned)
        if m:
            cleaned = cleaned[m.end():]

    # 第二轮：删"让我来分析"类前缀
    for _ in range(2):
        m = re.match(r'^让我来?(帮你|为你|为您)?\s*(分析|看看|梳理|解答|解释|说说|思考)(一下|下|一番)?\s*[，,]?\s*', cleaned)
        if not m:
            m = re.match(r'^我来?(帮你|为你|为您)?\s*(分析|看看|梳理|解答|解释|说说|思考)(一下|下|一番)?\s*[，,]?\s*', cleaned)
        if m:
            cleaned = cleaned[m.end():]

    # 第三轮：清理开头残留标点
    cleaned = re.sub(r'^[，,。！？；;]\s*', '', cleaned)

    return cleaned


def filter_response(text: str, user_msg: str = "") -> Dict:
    """对模型输出运行所有过滤器

    Args:
        text: 模型输出的文本
        user_msg: 用户的原始消息（用于指令偏离检测）

    Returns:
        {
            "text": str,        # 原文（不修改）
            "warnings": list,   # 警告列表
            "corrections": list,# 纠正建议列表
            "has_issues": bool, # 是否有问题
            "cleaned": str,     # 清理后的文本
        }
    """
    if not text:
        return {"text": text, "warnings": ["模型输出为空"], "has_issues": True, "cleaned": text}

    all_warnings = []
    all_corrections = []

    # 运行所有检测器
    code_warnings, code_suggestions = _detect_code_hallucination(text, user_msg)
    all_warnings.extend(code_warnings)
    all_corrections.extend(code_suggestions)
    all_warnings.extend(_detect_unclosed_structures(text))
    all_warnings.extend(_detect_thinking_leak(text))
    all_warnings.extend(_detect_repetition(text))
    all_warnings.extend(_detect_incomplete(text))
    all_warnings.extend(_detect_format_consistency(text))
    h_warnings, h_corrections = _detect_hallucination(text, user_msg)
    all_warnings.extend(h_warnings)
    all_corrections.extend(h_corrections)

    # 8) 前缀累积重复检测（Qwen3-8B 特有病态模式）
    accum_detected, accum_warning = detect_prefix_accumulation(text)
    if accum_detected:
        all_warnings.append(accum_warning)

    # 清理流程：
    # 1. 前缀累积重复清理（严重问题时自动截取有效部分）
    # 2. 废话前缀清理（去掉"好的，让我来分析"等）
    # 3. 未闭合 Markdown 标记自愈（补全缺失的 ** 等，不告知用户）
    cleaned = clean_prefix_accumulation(text)
    if cleaned != text:
        # 前缀累积重复已被清理，在清理后文本上再做废话前缀清理
        cleaned = _clean_thinking_prefix(cleaned)
    else:
        # 无前缀累积重复，仅做废话前缀清理
        cleaned = _clean_thinking_prefix(text)
    # 自愈：补全未闭合的 ** 标记（静默修复，不产生警告）
    cleaned = _fix_unclosed_markdown(cleaned)
    # 修复后重新过滤警告：已自愈的问题不再报
    all_warnings = [w for w in all_warnings if '未闭合的 Markdown' not in w]

    has_issues = len(all_warnings) > 0

    if has_issues:
        log.info("[FILTER] %d 个问题: %s" % (
            len(all_warnings),
            "; ".join(w[:60] for w in all_warnings[:3])
        ))

    return {
        "text": text,
        "warnings": all_warnings,
        "corrections": all_corrections,
        "has_issues": has_issues,
        "cleaned": cleaned,
    }
