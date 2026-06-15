# -*- coding: utf-8 -*-
"""
knowledge/models.py — 文库数据结构
==================================
从 knowledge_base.py 提取的 dataclass 定义。
"""
from dataclasses import dataclass, field
from typing import Dict, Any, List


@dataclass
class KBDocument:
    """文库文档"""
    doc_id: str
    filename: str
    file_type: str
    file_size: int
    imported_at: str
    status: str              # pending/processing/indexing/ready/paused/cancelled/error
    chunk_count: int = 0
    total_chars: int = 0
    progress: float = 0.0
    source: str = "upload"   # upload | transcript
    metadata: Dict[str, Any] = field(default_factory=dict)
    error_msg: str = ""
    summary: str = ""          # 文档前200字预览（不再使用 LLM 生成摘要）
    tags: list = field(default_factory=list)    # 3-5 个关键词标签
    tag_status: str = "pending"                 # "pending" / "done"


@dataclass
class KBChunk:
    """文库文本块"""
    chunk_id: str
    doc_id: str
    index: int
    text: str = ""      # 默认空，_load_meta 从 kb_texts/ 文件单独加载
    char_count: int = 0
    heading: str = ""
    source_label: str = ""   # 来源标注，如 "报告.pdf §第一章"
