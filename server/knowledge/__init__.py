# -*- coding: utf-8 -*-
"""knowledge — 文库子包

Mixin 组合模式：
  KnowledgeBase = _KBOpsMixin + _KBSearchMixin + _KBAskMixin + _KBStatsMixin

各 Mixin 定义在 knowledge/ 子模块中，KnowledgeBase 继承所有 Mixin，
self 引用不变（因为最终被 KnowledgeBase 实例化）。
"""
import threading
from typing import Optional

from knowledge.models import KBDocument, KBChunk
from knowledge.ops import _KBOpsMixin
from knowledge.search import _KBSearchMixin
from knowledge.ask import _KBAskMixin
from knowledge.stats import _KBStatsMixin


class KnowledgeBase(_KBOpsMixin, _KBSearchMixin, _KBAskMixin, _KBStatsMixin):
    """本地文库：文档管理 + 分块索引 + 语义检索

    通过 Mixin 组合实现模块化拆分。
    __init__ 在 _KBOpsMixin 中定义。
    """
    pass


# ===== 全局单例 =====

_kb_instance: Optional[KnowledgeBase] = None
_kb_lock = threading.Lock()


def get_knowledge_base() -> KnowledgeBase:
    """获取文库单例"""
    global _kb_instance
    with _kb_lock:
        if _kb_instance is None:
            _kb_instance = KnowledgeBase()
        return _kb_instance
