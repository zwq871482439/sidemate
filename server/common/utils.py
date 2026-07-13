# -*- coding: utf-8 -*-
"""通用工具集

合并自：
  - common/cancellation.py — 通用取消信号
  - common/text_utils.py   — 共用文本处理工具函数
"""
import os
import re
import json
import time
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


# =====================================================================
# 文件 I/O 工具函数
# =====================================================================

def atomic_write_json(path: str, data) -> None:
    """原子写入 JSON 文件（写 .tmp → flush → fsync → os.replace）

    统一替代散落在 6+ 个文件里的内联原子写代码。
    保证崩溃安全：写入过程中断不会损坏原文件。

    Args:
        path: 目标文件路径
        data: 可被 json.dump 序列化的对象
    """
    tmp_path = path + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass  # Windows 某些文件系统不支持 fsync
    os.replace(tmp_path, path)


def cleanup_old_files(
    directory: str,
    max_age_days: int,
    recursive: bool = False,
    label: str = None,
) -> int:
    """删除目录下超过 max_age_days 天的文件。

    统一替代 cache_cleanup.py 和 log_cleanup.py 的内联清理逻辑。

    Args:
        directory: 目标目录
        max_age_days: 文件保留天数，超过则删除
        recursive: True 则递归子目录（os.walk），False 仅扫描顶层（os.listdir）
        label: 日志标签（如 "LOG-CLEANUP"），不为 None 时逐文件打日志；
               为 None 时静默（仅汇总）

    Returns:
        删除的文件数
    """
    if not os.path.isdir(directory):
        return 0
    cutoff = time.time() - max_age_days * 86400
    cleaned = 0

    if recursive:
        walker = (
            os.path.join(root, f)
            for root, _dirs, files in os.walk(directory)
            for f in files
        )
    else:
        walker = (
            os.path.join(directory, f)
            for f in os.listdir(directory)
            if os.path.isfile(os.path.join(directory, f))
        )

    for fpath in walker:
        try:
            if os.path.getmtime(fpath) < cutoff:
                os.remove(fpath)
                cleaned += 1
                if label:
                    log.info("[%s] deleted: %s (%d days)" % (label, os.path.basename(fpath), max_age_days))
        except OSError as e:
            if label:
                log.warning("[%s] delete failed: %s — %s" % (label, os.path.basename(fpath), str(e)[:80]))

    if cleaned and label:
        log.info("[%s] %d file(s) cleaned" % (label, cleaned))
    return cleaned
