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
        # Patch5: BM25 已移除，bge-m3 dense+sparse 替代
        sparse_available = getattr(self.embedder, 'sparse_available', False) if self._embedder_loaded else False
        search_mode = "hybrid+reranker" if (sparse_available and self.reranker.available) else \
                      "hybrid" if sparse_available else "vector"
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
            "sparse_available": sparse_available,
            "reranker_available": self.reranker.available,
            "models_loaded": self._embedder_loaded,
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
