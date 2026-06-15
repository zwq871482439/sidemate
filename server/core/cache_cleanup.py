# -*- coding: utf-8 -*-
"""cache_cleanup.py — 启动时清理 data/cache/ 中的过期文件"""
import os
import time
import logging

log = logging.getLogger(__name__)


def cleanup_cache(cache_dir: str, max_age_days: int = 7):
    """清理 cache_dir 中超过 max_age_days 天的文件

    Args:
        cache_dir: 缓存目录路径（通常是 data/cache/）
        max_age_days: 文件最大保留天数，默认 7 天

    Returns:
        int — 清理的文件数量
    """
    if not os.path.isdir(cache_dir):
        return 0

    now = time.time()
    cutoff = now - max_age_days * 86400
    cleaned = 0

    for root, dirs, files in os.walk(cache_dir):
        for f in files:
            fpath = os.path.join(root, f)
            try:
                if os.path.getmtime(fpath) < cutoff:
                    os.remove(fpath)
                    cleaned += 1
            except OSError:
                pass

    if cleaned:
        log.info("[CACHE-CLEANUP] 清理 %d 个过期文件 (>=%d天)", cleaned, max_age_days)
    return cleaned
