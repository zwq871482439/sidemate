# -*- coding: utf-8 -*-
"""
core/dedup_detector.py — 去重检测引擎（B4）
============================================

两层检测策略：
  L1 快速检测：filename + file_size 完全相同（字节级）
  L2 内容检测：前 2000 字相似度 ≥ 95%（difflib.SequenceMatcher）

检测到重复后**不阻塞导入**，仅返回冲突信息，由调用方标记 metadata.duplicate_of。

用法：
    from core.dedup_detector import DedupDetector
    detector = DedupDetector(kb)
    result = detector.check_duplicate(file_path, text_content)
    if result.is_duplicate:
        # 正常导入，但标记 metadata
        doc.metadata["duplicate_of"] = result.existing_doc_id
"""
import os
import logging
from dataclasses import dataclass
from difflib import SequenceMatcher
from typing import Optional, Dict, Any

log = logging.getLogger(__name__)


@dataclass
class DedupResult:
    """去重检测结果

    Attributes:
        is_duplicate: 是否检测到重复
        level: 检测级别 "none" | "l1_filename_size" | "l2_content"
        existing_doc_id: 冲突的现有文档 ID（无重复时为空字符串）
        existing_filename: 冲突的现有文档文件名（无重复时为空字符串）
        similarity: 相似度（0.0-1.0，L1 检测时为 1.0）
    """
    is_duplicate: bool = False
    level: str = "none"
    existing_doc_id: str = ""
    existing_filename: str = ""
    similarity: float = 0.0


class DedupDetector:
    """去重检测引擎

    依赖 KnowledgeBase 实例提供文档列表（kb.documents）。
    """

    def __init__(self, kb):
        """初始化去重检测器

        Args:
            kb: KnowledgeBase 实例（需有 documents 字典）
        """
        self.kb = kb

    def check_l1(self, filename: str, file_size: int) -> Optional[Dict[str, Any]]:
        """L1 快速检测：filename + file_size 完全相同

        遍历 kb.documents，查找 filename 和 file_size 都匹配的文档。

        Args:
            filename: 新文件名
            file_size: 新文件大小（字节）

        Returns:
            匹配到的文档信息 dict（含 doc_id, filename），或 None
        """
        if not filename or file_size <= 0:
            return None
        for doc_id, doc in self.kb.documents.items():
            if doc.filename == filename and doc.file_size == file_size:
                return {
                    "doc_id": doc_id,
                    "filename": doc.filename,
                }
        return None

    def check_l2(self, text_content: str, threshold: float = 0.95) -> Optional[Dict[str, Any]]:
        """L2 内容检测：前 2000 字相似度 ≥ threshold

        使用 difflib.SequenceMatcher（Python 标准库）计算相似度。
        将新文档前 2000 字与每个现有文档的前 2000 字比较。

        Args:
            text_content: 新文档的文本内容
            threshold: 相似度阈值（默认 0.95）

        Returns:
            匹配到的文档信息 dict（含 doc_id, filename, similarity），或 None
        """
        if not text_content or not text_content.strip():
            return None

        # 取前 2000 字做比较（包含文档标题在内的正文开头）
        new_text = text_content[:2000]

        best_match = None
        best_similarity = 0.0

        for doc_id, doc in self.kb.documents.items():
            # 从 chunk 文件中读取现有文档的开头文本
            existing_text = self._get_doc_preview_text(doc_id, max_chars=2000)
            if not existing_text:
                # 回退到 doc.summary（前 200 字）
                existing_text = getattr(doc, "summary", "") or ""
            if not existing_text:
                continue

            existing_preview = existing_text[:2000]
            # 快速预过滤：首字符不同且都不为空时，跳过（优化 200 文档遍历性能）
            if new_text[0] != existing_preview[0]:
                continue

            # 计算相似度
            matcher = SequenceMatcher(None, new_text, existing_preview, autojunk=False)
            ratio = matcher.quick_ratio()  # 先用快速估算
            if ratio < threshold * 0.8:
                # 快速估算远低于阈值，跳过精确计算
                continue
            # 精确计算
            ratio = matcher.ratio()
            if ratio >= threshold and ratio > best_similarity:
                best_similarity = ratio
                best_match = {
                    "doc_id": doc_id,
                    "filename": doc.filename,
                    "similarity": round(ratio, 4),
                }

        return best_match

    def _get_doc_preview_text(self, doc_id: str, max_chars: int = 2000) -> str:
        """从文档的 chunks 中提取开头文本

        Args:
            doc_id: 文档 ID
            max_chars: 最大字符数

        Returns:
            文档开头文本（最多 max_chars 字符）
        """
        try:
            # 找到属于该文档的 chunks，按 index 排序
            doc_chunks = [
                (c.index, c.text)
                for c in self.kb.chunks.values()
                if c.doc_id == doc_id and c.text
            ]
            doc_chunks.sort(key=lambda x: x[0])
            # 拼接前 max_chars 字符
            result = ""
            for _, text in doc_chunks:
                result += text + "\n"
                if len(result) >= max_chars:
                    break
            return result[:max_chars]
        except Exception as e:
            log.debug("[DEDUP] 获取文档预览文本失败 (doc=%s): %s", doc_id, str(e)[:80])
            return ""

    def check_duplicate(self, file_path: str, text_content: str,
                        threshold: float = 0.95) -> DedupResult:
        """组合 L1+L2 检测，返回完整的去重结果

        检测顺序：先 L1（快速），L1 未命中再 L2（内容）。
        检测到重复后返回冲突信息，**不阻塞导入**。

        Args:
            file_path: 文件路径（用于提取 filename 和 file_size）
            text_content: 提取的文本内容（用于 L2 内容检测）
            threshold: L2 相似度阈值（默认 0.95）

        Returns:
            DedupResult 去重检测结果
        """
        # 提取 filename 和 file_size
        filename = os.path.basename(file_path) if file_path else ""
        try:
            file_size = os.path.getsize(file_path) if file_path and os.path.exists(file_path) else 0
        except OSError:
            file_size = 0

        # L1 快速检测：filename + file_size
        l1_result = self.check_l1(filename, file_size)
        if l1_result:
            return DedupResult(
                is_duplicate=True,
                level="l1_filename_size",
                existing_doc_id=l1_result["doc_id"],
                existing_filename=l1_result["filename"],
                similarity=1.0,
            )

        # L2 内容检测：前 2000 字相似度
        l2_result = self.check_l2(text_content, threshold=threshold)
        if l2_result:
            return DedupResult(
                is_duplicate=True,
                level="l2_content",
                existing_doc_id=l2_result["doc_id"],
                existing_filename=l2_result["filename"],
                similarity=l2_result["similarity"],
            )

        # 无重复
        return DedupResult(
            is_duplicate=False,
            level="none",
            existing_doc_id="",
            existing_filename="",
            similarity=0.0,
        )
