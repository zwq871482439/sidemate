# -*- coding: utf-8 -*-
"""cache_cleanup.py — 启动时清理 data/cache/ 中的过期文件"""
import logging

from common.utils import cleanup_old_files

log = logging.getLogger(__name__)


def cleanup_cache(cache_dir: str, max_age_days: int = 7) -> int:
    """清理 cache_dir 中超过 max_age_days 天的文件

    Args:
        cache_dir: 缓存目录路径（通常是 data/cache/）
        max_age_days: 文件最大保留天数，默认 7 天

    Returns:
        int — 清理的文件数量
    """
    return cleanup_old_files(cache_dir, max_age_days, recursive=True, label="CACHE-CLEANUP")
