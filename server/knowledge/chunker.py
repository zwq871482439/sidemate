# -*- coding: utf-8 -*-
"""
chunker.py — 文本智能分段器
============================
将长文本按语义边界切成适合 8B 模型上下文的片段。

分段策略（自动选择）：
  1. 章节策略：检测到章节标题（第X章、# 标题、一、二、）→ 按章节分段
  2. 段落策略：有段落分隔（\\n\\n）→ 按段落分段，合并短段、拆分长段
  3. 固定策略：都没有 → 固定长度分段，对齐中文句子边界

中文优化：
  - 绝不在句子中间切断
  - 支持中文章节标记检测
  - 段间重叠保持上下文连贯
"""
__version__ = "v1.0"

import re
import logging
from dataclasses import dataclass, field
from typing import List, Optional

log = logging.getLogger(__name__)

# ===== 中文句子结束标点 =====
_SENTENCE_END = re.compile(r'[。！？；\.\!\?;]')
# ===== 章节标题检测 =====
_SECTION_PATTERNS = [
    re.compile(r'^第[一二三四五六七八九十百千\d]+[章节篇部回卷]', re.MULTILINE),  # 第一章、第2节
    re.compile(r'^#{1,4}\s+\S+', re.MULTILINE),                                # # 标题 / ## 标题
    re.compile(r'^[一二三四五六七八九十]+[、．.]', re.MULTILINE),                # 一、二、
    re.compile(r'^\d+[、．.]\s*\S+', re.MULTILINE),                            # 1. xxx
    re.compile(r'^[（(]\s*[一二三四五六七八九十\d]+\s*[）)]', re.MULTILINE),     # （一）/ (1)
]


@dataclass
class Chunk:
    """单个文本片段"""
    index: int              # 0-based 序号
    text: str               # 片段内容
    char_start: int         # 原文起始位置
    char_end: int           # 原文结束位置
    section_title: str      # 章节标题（如有）
    overlap_prefix: str     # 上段末尾重叠文本
    overlap_suffix: str     # 下段开头重叠文本


@dataclass
class ChunkPlan:
    """分段计划"""
    total_chunks: int
    chunks: List[Chunk]
    strategy: str           # "section" | "paragraph" | "fixed"
    overlap_chars: int
    total_chars: int        # 原文总字符数


def _detect_sections(text: str) -> List[tuple]:
    """检测章节标题位置，返回 [(title, line_start_pos), ...]"""
    sections = []
    for pattern in _SECTION_PATTERNS:
        for m in pattern.finditer(text):
            # 取标题行（到下一个换行符）
            line_end = text.find('\n', m.start())
            if line_end == -1:
                line_end = len(text)
            title = text[m.start():line_end].strip()[:80]  # 截取标题，最长80字
            sections.append((title, m.start()))

    # 按位置排序，去重（相近的合并）
    sections.sort(key=lambda x: x[1])
    deduped = []
    last_pos = -100
    for title, pos in sections:
        if pos - last_pos > 10:  # 至少间隔10字符才算不同章节（标题本身就有长度）
            deduped.append((title, pos))
            last_pos = pos

    return deduped


def _find_sentence_boundary(text: str, target_pos: int, search_range: int = 100) -> int:
    """在 target_pos 附近找到最近的句子边界（中文句号/问号/感叹号等）"""
    best = target_pos
    best_dist = search_range + 1

    # 向后搜索
    for m in _SENTENCE_END.finditer(text, target_pos, min(target_pos + search_range, len(text))):
        dist = m.end() - target_pos
        if dist < best_dist:
            best = m.end()
            best_dist = dist
        break  # 取最近的

    # 如果向后找不到，向前搜索
    if best_dist > search_range:
        search_start = max(0, target_pos - search_range)
        last_end = None
        for m in _SENTENCE_END.finditer(text, search_start, target_pos):
            last_end = m.end()
        if last_end is not None:
            best = last_end
            best_dist = target_pos - last_end

    # 如果都找不到，直接用 target_pos（最后的兜底）
    if best_dist > search_range:
        return target_pos

    return best


def _split_by_sections(text: str, max_chars: int, overlap_chars: int) -> List[tuple]:
    """按章节分段。返回 [(title, start, end), ...]"""
    sections = _detect_sections(text)

    if len(sections) < 2:
        return []  # 不够2个章节，不使用章节策略

    chunks = []
    for i, (title, pos) in enumerate(sections):
        # 段落结束位置 = 下一章节的开始，或文本末尾
        if i + 1 < len(sections):
            end = sections[i + 1][1]
        else:
            end = len(text)

        chunk_text = text[pos:end].strip()

        # 如果单个章节超过 max_chars，按段落或固定长度再分
        if len(chunk_text) > max_chars * 1.5:
            sub_chunks = _split_long_section(title, chunk_text, max_chars, overlap_chars)
            for sub_title, sub_start, sub_end in sub_chunks:
                chunks.append((sub_title, pos + sub_start, pos + sub_end))
        else:
            chunks.append((title, pos, end))

    return chunks


def _split_long_section(title: str, text: str, max_chars: int, overlap_chars: int) -> List[tuple]:
    """将过长的章节内容再分段"""
    chunks = []
    start = 0

    while start < len(text):
        target_end = start + max_chars
        if target_end >= len(text):
            chunks.append((title, start, len(text)))
            break

        # 寻找句子边界
        end = _find_sentence_boundary(text, target_end)
        if end <= start:
            end = target_end  # 兜底

        chunks.append((title, start, end))
        start = end - overlap_chars  # 重叠
        if start < 0:
            start = 0

    return chunks


def _split_by_paragraphs(text: str, max_chars: int, overlap_chars: int) -> List[tuple]:
    """按段落分段。合并短段、拆分长段"""
    paragraphs = re.split(r'\n\s*\n', text)
    if not paragraphs:
        return [("（全文）", 0, len(text))]

    chunks = []
    current_parts = []
    current_len = 0
    current_start = 0

    # 跟踪位置
    pos = 0
    para_positions = []
    for p in paragraphs:
        # 找到段落实际位置
        idx = text.find(p.strip(), pos)
        if idx == -1:
            idx = pos
        para_positions.append((p.strip(), idx))
        pos = idx + len(p)

    for para_text, para_start in para_positions:
        if not para_text:
            continue

        para_len = len(para_text)

        # 如果单个段落就超过 max_chars，需要拆分
        if para_len > max_chars:
            # 先把之前积攒的段落作为一个 chunk
            if current_parts:
                chunk_text = '\n\n'.join(current_parts)
                chunks.append(("（段落组）", current_start, current_start + len(chunk_text)))
                current_parts = []
                current_len = 0

            # 拆分长段落
            sub_start = para_start
            while sub_start < para_start + para_len:
                target_end = sub_start + max_chars
                if target_end >= para_start + para_len:
                    chunks.append(("（长段落片段）", sub_start, para_start + para_len))
                    break
                end = _find_sentence_boundary(text, target_end)
                if end <= sub_start:
                    end = target_end
                chunks.append(("（长段落片段）", sub_start, end))
                sub_start = end - overlap_chars
        else:
            # 合并短段落
            if current_len + para_len > max_chars and current_parts:
                chunk_text = '\n\n'.join(current_parts)
                chunks.append(("（段落组）", current_start, current_start + current_len))
                current_parts = [para_text]
                current_len = para_len
                current_start = para_start
            else:
                current_parts.append(para_text)
                current_len += para_len
                if len(current_parts) == 1:
                    current_start = para_start

    # 最后剩余的
    if current_parts:
        chunk_text = '\n\n'.join(current_parts)
        chunks.append(("（段落组）", current_start, current_start + current_len))

    return chunks


def _split_fixed(text: str, max_chars: int, overlap_chars: int) -> List[tuple]:
    """固定长度分段，对齐句子边界"""
    chunks = []
    start = 0

    while start < len(text):
        target_end = start + max_chars
        if target_end >= len(text):
            chunks.append(("（片段）", start, len(text)))
            break

        end = _find_sentence_boundary(text, target_end)
        if end <= start:
            end = target_end  # 兜底

        chunks.append(("（片段）", start, end))
        start = end - overlap_chars

    return chunks


def chunk_text(text: str, max_chars: int = 2500, overlap_chars: int = 200,
               max_chunks: int = 30, strategy: str = "auto") -> ChunkPlan:
    """将长文本分段

    Args:
        text: 原始文本
        max_chars: 每段目标字数
        overlap_chars: 段间重叠字数
        max_chunks: 最大分段数（安全上限）
        strategy: "auto"（自动选择）| "section" | "paragraph" | "fixed"

    Returns:
        ChunkPlan 分段计划
    """
    text = text.strip()
    total_chars = len(text)

    if total_chars == 0:
        return ChunkPlan(total_chunks=0, chunks=[], strategy="empty",
                         overlap_chars=overlap_chars, total_chars=0)

    # 如果文本不超过 max_chars，不需要分段
    if total_chars <= max_chars:
        chunk = Chunk(
            index=0, text=text, char_start=0, char_end=total_chars,
            section_title="", overlap_prefix="", overlap_suffix="",
        )
        return ChunkPlan(total_chunks=1, chunks=[chunk], strategy="none",
                         overlap_chars=0, total_chars=total_chars)

    # 选择策略
    raw_chunks = []
    actual_strategy = strategy

    if strategy == "auto":
        # 先尝试章节
        section_chunks = _split_by_sections(text, max_chars, overlap_chars)
        if len(section_chunks) >= 2:
            raw_chunks = section_chunks
            actual_strategy = "section"
        else:
            # 尝试段落
            para_count = len(re.split(r'\n\s*\n', text))
            if para_count >= 3:
                raw_chunks = _split_by_paragraphs(text, max_chars, overlap_chars)
                actual_strategy = "paragraph"
            else:
                raw_chunks = _split_fixed(text, max_chars, overlap_chars)
                actual_strategy = "fixed"
    elif strategy == "section":
        raw_chunks = _split_by_sections(text, max_chars, overlap_chars)
        if not raw_chunks:
            raw_chunks = _split_fixed(text, max_chars, overlap_chars)
            actual_strategy = "fixed"
    elif strategy == "paragraph":
        raw_chunks = _split_by_paragraphs(text, max_chars, overlap_chars)
    else:
        raw_chunks = _split_fixed(text, max_chars, overlap_chars)

    # 安全上限裁剪
    if len(raw_chunks) > max_chunks:
        log.warning("[CHUNKER] 分段数 %d 超过上限 %d，裁剪" % (len(raw_chunks), max_chunks))
        raw_chunks = raw_chunks[:max_chunks]

    # 构建 Chunk 对象，添加重叠文本
    chunks = []
    for i, (title, start, end) in enumerate(raw_chunks):
        # 确保位置不越界
        start = max(0, min(start, total_chars))
        end = max(start, min(end, total_chars))

        chunk_text_content = text[start:end].strip()

        # 前重叠：取上一段末尾
        overlap_prefix = ""
        if i > 0 and overlap_chars > 0:
            prev_end = raw_chunks[i - 1][2]
            prefix_start = max(start, prev_end - overlap_chars) if prev_end < start else max(0, start - overlap_chars)
            overlap_prefix = text[prefix_start:start].strip()

        # 后重叠：取下一段开头
        overlap_suffix = ""
        if i < len(raw_chunks) - 1 and overlap_chars > 0:
            next_start = raw_chunks[i + 1][1]
            suffix_end = min(next_start + overlap_chars, total_chars) if next_start > end else min(end + overlap_chars, total_chars)
            overlap_suffix = text[end:suffix_end].strip()

        chunks.append(Chunk(
            index=i,
            text=chunk_text_content,
            char_start=start,
            char_end=end,
            section_title=title,
            overlap_prefix=overlap_prefix,
            overlap_suffix=overlap_suffix,
        ))

    log.info("[CHUNKER] 分段完成: %d字 → %d段, 策略=%s" % (
        total_chars, len(chunks), actual_strategy))

    return ChunkPlan(
        total_chunks=len(chunks),
        chunks=chunks,
        strategy=actual_strategy,
        overlap_chars=overlap_chars,
        total_chars=total_chars,
    )
