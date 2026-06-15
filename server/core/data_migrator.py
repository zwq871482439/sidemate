# -*- coding: utf-8 -*-
"""data_migrator.py — P4 首次启动时迁移 data/ 目录结构"""
import os
import shutil
import logging

log = logging.getLogger(__name__)


def migrate_data_layout(data_dir: str):
    """P4 首次启动时迁移 data/ 目录结构

    迁移映射：
    - data/docs/ → data/cache/docs/
    - data/tmp_upload/ → data/cache/uploads/
    - data/files/ → data/cache/files/
    """
    cache_dir = os.path.join(data_dir, "cache")
    os.makedirs(cache_dir, exist_ok=True)

    moves = [
        ("docs", "cache/docs"),
        ("tmp_upload", "cache/uploads"),
        ("files", "cache/files"),
    ]
    for old_name, new_rel in moves:
        old_path = os.path.join(data_dir, old_name)
        new_path = os.path.join(data_dir, new_rel)
        if os.path.isdir(old_path) and not os.path.isdir(new_path):
            os.makedirs(os.path.dirname(new_path), exist_ok=True)
            shutil.move(old_path, new_path)
            log.info("[DATA-MIGRATE] %s → %s", old_name, new_rel)
        elif os.path.isdir(old_path) and os.path.isdir(new_path):
            # 两者都存在：把旧目录内容合并到新目录，然后删除旧目录
            for f in os.listdir(old_path):
                src = os.path.join(old_path, f)
                dst = os.path.join(new_path, f)
                if not os.path.exists(dst):
                    shutil.move(src, dst)
            shutil.rmtree(old_path, ignore_errors=True)
            log.info("[DATA-MIGRATE] 合并 %s → %s（新目录已存在）", old_name, new_rel)
