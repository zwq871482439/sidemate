# -*- coding: utf-8 -*-
"""
knowledge/tags.py — 标签归一化 & 文档摘要提取
===============================================
从 knowledge_base.py 提取的类外工具函数。
"""

# 全角→半角映射（标点）
_FULLWIDTH_MAP = str.maketrans({
    '，': ',', '：': ':', '（': '(', '）': ')',
    '；': ';', '！': '!', '？': '?', '：': ':',
})


def normalize_tag(tag: str) -> str:
    """标签归一化：去空格 + 全角转半角 + 剥离 markdown 装饰

    P8-8：LLM 输出常带 **加粗**、`代码`、# 号等 markdown 装饰，
    不剥掉会导致同一分类出现「健康养生」和「**健康养生**」两个变体，
    聚类/归并匹配不上（实测：侧栏出现成对的带星号分类）。
    """
    import re as _re
    tag = tag.strip()
    tag = _re.sub(r"[*_`#~]+", "", tag)              # markdown 装饰符
    tag = tag.strip().strip('"\'“”‘’「」').strip()   # 成对引号/书名号
    tag = tag.translate(_FULLWIDTH_MAP)
    return tag


def extract_title_and_first_paragraphs(text: str, max_chars: int = 3000) -> str:
    """提取 Markdown 标题 + 每个标题下第一段的前200字

    纯文本处理，不调用 LLM。用于长文档打标时的输入截断。

    Args:
        text: 文档全文
        max_chars: 输出最大字符数

    Returns:
        截取后的文本
    """
    lines = text.split('\n')
    result_parts = []
    current_title = ""
    total_chars = 0

    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue

        # 检测 Markdown 标题行（# 开头）
        if stripped.startswith('#'):
            current_title = stripped
            if total_chars + len(stripped) + 1 <= max_chars:
                result_parts.append(stripped)
                total_chars += len(stripped) + 1
            else:
                break
        else:
            # 普通段落：每个标题下只取第一段的前200字
            if current_title or not result_parts:
                para = stripped[:200]
                if total_chars + len(para) + 1 <= max_chars:
                    result_parts.append(para)
                    total_chars += len(para) + 1
                else:
                    # 截断
                    remaining = max_chars - total_chars
                    if remaining > 50:
                        result_parts.append(para[:remaining])
                    break
                current_title = ""  # 标题下已取一段，重置

    return '\n'.join(result_parts)
