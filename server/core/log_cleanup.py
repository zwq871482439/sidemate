# -*- coding: utf-8 -*-
"""
core/log_cleanup.py — 日志文件自动清理

提供 cleanup_old_logs() 函数，删除超过指定天数的日志文件。
"""
import logging

from common.utils import cleanup_old_files

log = logging.getLogger(__name__)


def cleanup_old_logs(log_dir: str, max_age_days: int = 30) -> int:
    """清理超过 max_age_days 天的日志文件。

    Args:
        log_dir: 日志目录路径
        max_age_days: 文件最大保留天数，默认 30 天

    Returns:
        已删除的文件数量
    """
    return cleanup_old_files(log_dir, max_age_days, recursive=False, label="LOG-CLEANUP")
