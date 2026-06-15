# -*- coding: utf-8 -*-
"""通用工具集

合并自：
  - common/cancellation.py — 通用取消信号
  - common/text_utils.py   — 共用文本处理工具函数
"""
import re
import threading
import logging
from collections import Counter
from typing import Set

log = logging.getLogger(__name__)


# =====================================================================
# 取消信号（原 cancellation.py）
# =====================================================================

class TaskCancelledError(Exception):
    """任务被取消异常，用于统一取消传播"""
    pass


class CancellationToken:
    """统一取消信号，替代散落的 _cancel_flags dict

    - 基于 threading.Event，原子性有保证
    - 支持异常传播（check_or_raise）
    - 支持阻塞等待（wait_or_raise），用于等待期间检查取消
    """

    def __init__(self, doc_id: str = ""):
        self._event = threading.Event()
        self.doc_id = doc_id

    def cancel(self):
        """触发取消"""
        self._event.set()

    @property
    def is_cancelled(self) -> bool:
        return self._event.is_set()

    def check(self) -> bool:
        """非阻塞检查是否被取消"""
        return self._event.is_set()

    def check_or_raise(self):
        """检查取消，如果被取消则抛出 TaskCancelledError"""
        if self._event.is_set():
            raise TaskCancelledError(self.doc_id)

    def wait_or_raise(self, timeout: float = 1.0):
        """等待指定时间，期间如果被取消则抛出 TaskCancelledError

        用于替代 time.sleep() + if cancel 检查的组合。
        """
        if self._event.wait(timeout=timeout):
            raise TaskCancelledError(self.doc_id)

    def sleep_check(self, seconds: float, interval: float = 1.0):
        """睡眠指定秒数，每 interval 秒检查取消

        用于替代 for _ in range(n): time.sleep(1) + if cancel 的组合。
        """
        elapsed = 0.0
        while elapsed < seconds:
            wait = min(interval, seconds - elapsed)
            if self._event.wait(timeout=wait):
                raise TaskCancelledError(self.doc_id)
            elapsed += wait


# =====================================================================
# 文本工具函数（原 text_utils.py）
# =====================================================================

def extract_keywords(text: str, top_n: int = 5) -> Set[str]:
    """轻量关键词提取（无需 jieba）

    提取中英文关键词：
    - 英文：2+ 字母的词
    - 中文：2-gram 滑动窗口

    Args:
        text: 输入文本
        top_n: 返回前 N 个高频词

    Returns:
        关键词集合
    """
    if not text:
        return set()
    words = []
    # 英文词（2+字符）
    en_tokens = re.findall(r'[a-zA-Z]{2,}', text.lower())
    words.extend(en_tokens)
    # 中文 2-gram
    cn_chars = re.findall(r'[\u4e00-\u9fff]', text)
    for i in range(len(cn_chars) - 1):
        words.append(cn_chars[i] + cn_chars[i + 1])
    if not words:
        return set()
    counter = Counter(words)
    return set(w for w, _ in counter.most_common(top_n))
