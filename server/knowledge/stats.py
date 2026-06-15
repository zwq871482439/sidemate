# -*- coding: utf-8 -*-
"""
knowledge/stats.py — 文库统计 Mixin
====================================
包含 get_stats() 和 get_all_tags() 方法。
从 knowledge_base.py 拆分而来。
"""
import logging
from typing import Dict

from knowledge.tags import normalize_tag

log = logging.getLogger(__name__)


class _KBStatsMixin:
    """文库统计：统计信息、标签聚合"""

    def get_stats(self) -> Dict:
        """文库统计信息"""
        ready = sum(1 for d in self.documents.values() if d.status == "ready")
        processing = sum(1 for d in self.documents.values() if d.status in ("processing", "indexing"))
        search_mode = "hybrid+reranker" if (self._bm25 and self.reranker.available) else \
                      "hybrid" if self._bm25 else "vector"
        return {
            "total_documents": len(self.documents),
            "ready_documents": ready,
            "processing_documents": processing,
            "total_chunks": len(self.chunks),
            "max_documents": self.max_documents,
            "max_chunks": self.max_total_chunks,
            "embedder_mode": self.embedder.mode,
            "vector_dim": self.embedder.vector_dim if self._embedder_loaded else 0,
            "search_mode": search_mode,
            "bm25_available": self._bm25 is not None,
            "reranker_available": self.reranker.available,
            "models_loaded": self._embedder_loaded,  # 模型是否已加载（供前端显示载入/卸载按钮）
            "memory_report": self.memory_manager.get_report(),  # 内存预算报告（Patch 8）
        }

    def get_all_tags(self) -> dict:
        """聚合所有文档的 tags，按频次降序排序

        Returns:
            dict: {tag: count}，按频次降序，上限 KB_DOC_LIMIT * 5
        """
        from collections import Counter
        tag_counter = Counter()
        for doc in self.documents.values():
            if doc.tags:
                for t in doc.tags:
                    normalized = normalize_tag(t)
                    if normalized:
                        tag_counter[normalized] += 1
        # 按频次降序排序
        max_tags = self.max_documents * 5
        sorted_tags = tag_counter.most_common(max_tags)
        return dict(sorted_tags)
