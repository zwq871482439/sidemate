# -*- coding: utf-8 -*-
"""
轻量上下文压缩器 — 纯规则，不调用 LLM

在截断前压缩老旧对话：保留关键信息，去掉冗余内容。

设计原则：
  - 只处理即将被截断的消息（溢出部分）
  - 不修改最新的 N 轮对话
  - 压缩后的摘要替代原始消息注入历史
  - 保持 user/assistant 配对不拆散
  - 压缩触发阈值根据模型大小动态调整
"""
__version__ = "v1.0"

import re
import logging
from typing import List, Dict, Optional, Tuple

log = logging.getLogger(__name__)


# ===== 常量 =====

# 代码压缩阈值 → 从 config.py 读取
try:
    from config import get as _cfg
    _MAX_CODE_COMPRESSED_CHARS = _cfg("compress_max_code_chars")
except Exception:
    _MAX_CODE_COMPRESSED_CHARS = 600  # config 加载失败，使用默认值
_CODE_HEAD_RATIO = 0.6              # 截断时保留前 60%
_CODE_TAIL_LINES = 10               # 截断时保留最后 10 行

# 消息压缩阈值
_PROTECT_COUNT = 4                  # 保护最近 4 条消息（2 轮）
_MIN_COMPRESS_BUDGET = 200          # 可压缩部分最低字符预算

# 文本压缩关键词（中文）—— 含这些词的句子优先保留
_KEY_PATTERNS = [
    r'结论[是为]', r'答案[是为]', r'结果[是为]', r'总[之结]', r'最终',
    r'所以', r'因此', r'建议', r'注意', r'提醒',
    r'错误[是为]', r'原因', r'方法', r'解决', r'修复',
    r'关键', r'重要', r'核心', r'必须', r'一定',
    r'步骤', r'流程', r'配置', r'参数', r'设置',
]

# 文本压缩关键词（英文）—— 适配代码注释中的英文结论
_KEY_PATTERNS_EN = [
    r'conclusion', r'result', r'therefore', r'important',
    r'error', r'fix', r'solution', r'step',
]


# ===== 内部函数 =====

def _is_code_block(text: str) -> bool:
    """判断文本是否主要是代码块"""
    code_markers = text.count("```")
    if code_markers >= 2:
        code_content = re.findall(r'```[\w]*\n(.*?)```', text, re.DOTALL)
        if code_content:
            code_chars = sum(len(c) for c in code_content)
            if code_chars > len(text) * 0.4:
                return True
    return False


def _compress_code(text: str) -> str:
    """压缩代码块：保留函数签名和关键结构，安全地去除注释和空行
    
    v1.0 改进：
    - 区分注释行和字符串内的 #
    - 保留 docstring
    - 保留装饰器
    - 保留所有 def/class/return/raise/yield 行
    """
    lines = text.split("\n")
    result = []
    in_docstring = False
    docstring_char = None

    for line in lines:
        stripped = line.strip()

        # 空行压缩：最多保留 1 个连续空行
        if not stripped:
            if result and not result[-1].strip():
                continue
            result.append(line)
            continue

        # docstring 追踪（""" 或 ''' 多行）
        if not in_docstring:
            for ds in ('"""', "'''"):
                if stripped.startswith(ds):
                    docstring_char = ds
                    if stripped.count(ds) == 1:
                        in_docstring = True
                    result.append(line)
                    break
            else:
                # 不在 docstring 里
                # 保留装饰器
                if stripped.startswith('@'):
                    result.append(line)
                    continue
                # 保留 def/class/return/raise/yield/import/from/print
                keep_prefixes = ('def ', 'class ', 'return ', 'raise ', 'yield ',
                                 'import ', 'from ', 'print(')
                if any(stripped.startswith(p) for p in keep_prefixes):
                    result.append(line)
                    continue
                # 纯注释行 -> 跳过（但保留 TODO/FIXME/HACK）
                if stripped.startswith('#') or stripped.startswith('//'):
                    if re.search(r'TODO|FIXME|HACK|XXX|NOTE', stripped, re.IGNORECASE):
                        result.append(line)
                    continue
                # 普通代码行：去掉尾部注释（排除字符串内的 #）
                result.append(_strip_trailing_comment(line))
            continue
        else:
            # 在 docstring 内部
            result.append(line)
            if docstring_char in stripped and stripped != docstring_char:
                # 单行结束 docstring 如 """hello"""
                in_docstring = False
            elif stripped.endswith(docstring_char):
                in_docstring = False

    compressed = "\n".join(result)

    # 如果压缩后还很长，保留前 60% + 最后 10 行
    if len(compressed) > _MAX_CODE_COMPRESSED_CHARS:
        cutoff = int(len(compressed) * _CODE_HEAD_RATIO)
        tail_lines = "\n".join(result[-_CODE_TAIL_LINES:])
        compressed = compressed[:cutoff] + "\n# ... (已压缩)\n" + tail_lines

    return compressed


def _strip_trailing_comment(line: str) -> str:
    """安全地移除行尾注释（不破坏字符串内的 # 和 //）
    
    策略：统计引号平衡，只删除最后一个引号对之外的 #
    """
    # 统计未转义的引号数量，判断是否有未闭合的字符串
    single_count = line.count("'") - line.count("\\'")
    double_count = line.count('"') - line.count('\\"')

    if single_count % 2 == 0 and double_count % 2 == 0:
        # 没有未闭合引号，可以安全找 #
        for i, ch in enumerate(line):
            if ch == '#':
                # 确认不是在 f-string 表达式里
                return line[:i].rstrip()
    return line


def _compress_text(text: str) -> str:
    """压缩自然语言文本：保留关键结论，去掉冗余解释
    
    v1.0 改进：
    - 更精确的中文句子分割
    - 保留首尾句 + 含关键词的句子
    - 去掉纯客套/废话句
    - 保留列表/步骤结构
    """
    # 按句子分割（中英文标点）
    sentences = re.split(r'[。！？；\n]', text)
    sentences = [s.strip() for s in sentences if s.strip()]

    if len(sentences) <= 2:
        return text  # 短文本不压缩

    # 废话句模式（直接跳过）
    filler_patterns = [
        r'^(好的|明白|没问题|当然|是的|嗯)',
        r'^(希望|如果|还有).*帮到你',
        r'^(如有|如果).*问题.*联系',
        r'^以上(就是|便是|是)',
    ]

    kept = []
    for i, s in enumerate(sentences):
        # 首尾句总是保留
        if i == 0 or i == len(sentences) - 1:
            kept.append(s)
            continue

        # 跳过废话句
        is_filler = False
        for pat in filler_patterns:
            if re.match(pat, s):
                is_filler = True
                break
        if is_filler:
            continue

        # 含关键词的句子保留
        for pat in _KEY_PATTERNS:
            if re.search(pat, s):
                kept.append(s)
                break
        else:
            # 检查英文关键词
            for pat in _KEY_PATTERNS_EN:
                if re.search(pat, s, re.IGNORECASE):
                    kept.append(s)
                    break

    if not kept:
        kept = [sentences[0], sentences[-1]]

    result = "。".join(kept)
    if not result.endswith(("。", "！", "？", "；")):
        result += "。"
    return result


def _make_one_line_summary(text: str) -> str:
    """生成一行摘要（用于极端压缩场景）"""
    # 去掉代码块
    clean = re.sub(r'```.*?```', '[代码]', text, flags=re.DOTALL)
    # 取第一句有意义的话
    sentences = re.split(r'[。！？\n]', clean)
    for s in sentences:
        s = s.strip()
        if len(s) > 10 and not re.match(r'^(好的|明白|没问题)', s):
            return "[历史] " + s[:80] + ("..." if len(s) > 80 else "")
    return "[历史] " + clean[:60] + "..."


# ===== 主入口 =====

def compress_messages(messages: List[Dict], max_chars: int, model_size: int = 8) -> Tuple[List[Dict], bool]:
    """压缩消息列表，使其总字符数不超过 max_chars

    策略（按优先级）：
    1. 保护最新的 2 轮对话（user+assistant 配对不动）
    2. 较早的对话先尝试内容压缩
    3. 压缩后仍超限的消息合并为单行摘要
    4. 最老的摘要如果仍超限则丢弃

    Args:
        messages: [{"role": str, "content": str}, ...]
        max_chars: 目标最大字符数
        model_size: 模型参数量(B)，用于调整压缩激进程度
                    小模型(<=4B): 更激进压缩（保留更少）
                    大模型(>=8B): 保守压缩（保留更多）

    Returns:
        压缩后的消息列表（保持时间顺序）
    """
    if not messages:
        return messages

    total = sum(len(m.get("content", "")) for m in messages)
    if total <= max_chars:
        return messages  # 没超，不需要压缩

    # 保护最新 2 轮 = 4 条消息（2 user + 2 assistant）
    # 同时确保最后一条 user 消息被保护
    protect_count = _PROTECT_COUNT
    last_user_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("role") == "user":
            last_user_idx = i
            break
    protected_start = max(0, len(messages) - protect_count)
    if last_user_idx >= 0:
        protected_start = min(protected_start, last_user_idx)

    compressible = messages[:protected_start]
    protected = messages[protected_start:]

    if not compressible:
        # 全部是受保护的，无法压缩
        protected_total = sum(len(m.get("content", "")) for m in protected)
        if protected_total <= max_chars:
            return protected
        return protected[-2:] if len(protected) > 2 else protected

    # 计算可压缩部分的预算
    protected_chars = sum(len(m.get("content", "")) for m in protected)
    target_chars = max(max_chars - protected_chars, _MIN_COMPRESS_BUDGET)

    # 第一轮：内容压缩（从新到老处理，优先保留较新的）
    compressed = []
    current_chars = 0

    for msg in reversed(compressible):
        content = msg.get("content", "")
        role = msg.get("role", "user")

        if current_chars + len(content) <= target_chars:
            # 直接放入（不压缩）
            compressed.append(msg)
            current_chars += len(content)
        else:
            # 需要压缩
            if _is_code_block(content):
                new_content = _compress_code(content)
            else:
                new_content = _compress_text(content)

            if current_chars + len(new_content) <= target_chars:
                compressed.append({"role": role, "content": new_content})
                current_chars += len(new_content)
            else:
                # 极端压缩：一行摘要
                summary = _make_one_line_summary(content)
                if current_chars + len(summary) <= target_chars:
                    compressed.append({"role": role, "content": summary})
                    current_chars += len(summary)
                # else: 彻底丢弃

    # 反转回时间顺序
    compressed.reverse()
    result = compressed + protected

    # 日志
    if len(result) < len(messages):
        orig_chars = sum(len(m.get("content", "")) for m in messages)
        new_chars = sum(len(m.get("content", "")) for m in result)
        ratio = (1 - new_chars / orig_chars) * 100 if orig_chars > 0 else 0
        log.info("[COMPRESS] %d条 -> %d条, %d字 -> %d字 (压缩率%.0f%%, 预算%d)" % (
            len(messages), len(result), orig_chars, new_chars, ratio, max_chars))

    return result


# ===== 离线模型压缩 =====

# 离线压缩 prompt 模板
_OFFLINE_COMPRESS_PROMPT = (
    "请将以下对话历史压缩为一段简明的中文摘要。"
    "只保留关键信息：用户的核心问题、重要结论、决定、数据。"
    "去掉客套话和重复内容。摘要不超过200字。\n\n"
    "---对话开始---\n%s\n---对话结束---\n\n摘要："
)

# 离线压缩参数 → 从 config.py 读取
try:
    from config import get as _cfg
    _OFFLINE_COMPRESS_MAX_INPUT = _cfg("offline_compress_max_input")
    _OFFLINE_COMPRESS_TIMEOUT = _cfg("offline_compress_timeout")
    _OFFLINE_COMPRESS_MAX_TOKENS = _cfg("offline_compress_max_tokens")
except Exception:
    _OFFLINE_COMPRESS_MAX_INPUT = 2000  # config 加载失败，使用默认值
    _OFFLINE_COMPRESS_TIMEOUT = 30
    _OFFLINE_COMPRESS_MAX_TOKENS = 512


def offline_compress_with_model(messages: list, model_manager=None) -> str:
    """用本地模型压缩旧对话为摘要

    Args:
        messages: 要压缩的消息列表 [{"role": "user/assistant", "content": "..."}]
        model_manager: ModelManager 实例

    Returns:
        压缩后的摘要文本。如果模型不可用则回退到规则压缩。
    """
    if not messages:
        return ""

    # 拼接对话文本
    parts = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if not content:
            continue
        # 简化：去掉 HTML 标签
        content = re.sub(r'<[^>]+>', '', content)
        content = re.sub(r'`\d+字`\s*`[\d.]+s`\s*`[\d.]+字/s`', '', content)
        content = content.strip()
        if not content:
            continue
        if role == "user":
            parts.append("用户: " + content[:200])
        else:
            parts.append("助手: " + content[:300])

    dialog_text = "\n".join(parts)
    if not dialog_text.strip():
        return ""

    # 截断输入
    if len(dialog_text) > _OFFLINE_COMPRESS_MAX_INPUT:
        dialog_text = dialog_text[:_OFFLINE_COMPRESS_MAX_INPUT]

    # 尝试调用本地模型
    if model_manager is None:
        return _rule_based_compress(messages)

    try:
        loaded = model_manager.get_loaded_llms()
        if not loaded:
            log.info("[OFFLINE-COMPRESS] 无已加载模型，回退到规则压缩")
            return _rule_based_compress(messages)

        model_name = loaded[0]
        prompt = _OFFLINE_COMPRESS_PROMPT % dialog_text

        # 调用 chat_stream 做摘要（非流式收集）
        summary_parts = []
        for phase, content in model_manager.chat_stream(
            prompt, model_name, _OFFLINE_COMPRESS_MAX_TOKENS,
            history=None, context_cache=None,
            _priority="low",  # Patch 8 P8-17: 后台压缩用 LOW 优先级
        ):
            if phase in ("raw", "text"):
                summary_parts.append(content)

        summary = "".join(summary_parts).strip()
        # 去掉可能的 think 标签残留
        summary = re.sub(r'</?think[^>]*>', '', summary)
        summary = summary.strip()

        if summary and len(summary) > 10:
            log.info("[OFFLINE-COMPRESS] 模型摘要: %d字对话 -> %d字摘要" % (len(dialog_text), len(summary)))
            return summary
        else:
            log.warning("[OFFLINE-COMPRESS] 模型输出太短，回退到规则压缩")
            return _rule_based_compress(messages)

    except Exception as e:
        log.warning("[OFFLINE-COMPRESS] 模型压缩失败 (%s)，回退到规则压缩" % str(e)[:80])
        return _rule_based_compress(messages)


def _rule_based_compress(messages: list) -> str:
    """纯规则压缩（无 LLM），作为离线压缩的回退"""
    parts = []
    for m in messages:
        role = m.get("role", "user")
        content = m.get("content", "")
        if not content:
            continue
        content = re.sub(r'<[^>]+>', '', content)
        content = content.strip()[:80]
        if not content:
            continue
        if role == "user":
            parts.append("Q: " + content)
        else:
            # 助手回复压缩：取第一句
            compressed = _compress_text(content) if len(content) > 80 else content
            parts.append("A: " + compressed[:60])

    result = " | ".join(parts)
    if len(result) > 500:
        result = result[:500]
    return result
