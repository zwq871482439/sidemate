# -*- coding: utf-8 -*-
"""
core/log_cleanup.py — 日志文件自动清理

提供 cleanup_old_logs() 函数，删除超过指定天数的日志文件。
"""
import os
import time
import logging
from typing import List

log = logging.getLogger(__name__)


def cleanup_old_logs(log_dir: str, max_age_days: int = 30) -> int:
    """清理超过 max_age_days 天的日志文件。

    Args:
        log_dir: 日志目录路径
        max_age_days: 文件最大保留天数，默认 30 天

    Returns:
        已删除的文件数量
    """
    if not os.path.isdir(log_dir):
        return 0

    cutoff = time.time() - max_age_days * 86400
    deleted = 0

    for filename in os.listdir(log_dir):
        filepath = os.path.join(log_dir, filename)
        try:
            if os.path.isfile(filepath) and os.path.getmtime(filepath) < cutoff:
                os.remove(filepath)
                deleted += 1
                log.info("[LOG-CLEANUP] 已删除过期日志: %s (%d天)" % (filename, max_age_days))
        except OSError as e:
            log.warning("[LOG-CLEANUP] 删除失败: %s — %s" % (filename, str(e)[:80]))

    if deleted > 0:
        log.info("[LOG-CLEANUP] 共删除 %d 个过期日志文件（>=%d天）" % (deleted, max_age_days))

    return deleted
