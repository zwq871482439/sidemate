# -*- coding: utf-8 -*-
"""
cloud_usage.py — 云端 AI 用量统计（SQLite 持久化）
==================================================

记录每次云端 API 调用的真实 token 用量，供设置页用量统计面板展示。

设计原则：
  - 诚实第一：只在拿到 API 真实 usage 时记录 token；拿不到只记请求次数，
    标记 token_accurate=0，绝不编造估算值。
  - 原始记录 + 查询聚合：每次调用一条原始记录，查询时按小时/天/模型 GROUP BY。
  - 7 天自动清理：写入时顺便删除 7 天前的记录（覆写式，控制体积）。

表结构：cloud_usage(id, ts, model, input/output/reasoning_tokens, elapsed_ms, token_accurate)

用法：
    from core.cloud_usage import record_usage, query_usage
    record_usage(model="deepseek-v4-flash", input_tokens=2904, output_tokens=25,
                 reasoning_tokens=11, elapsed_ms=2500, token_accurate=True)
    data = query_usage(range_days=7, granularity="hour")
"""
import os
import time
import sqlite3
import logging
import threading
from typing import Optional, Dict, Any, List

log = logging.getLogger(__name__)

# 数据保留：7 天（秒）
RETENTION_SECONDS = 7 * 24 * 3600

_local = threading.local()
_init_lock = threading.Lock()
_db_path: Optional[str] = None


def _resolve_db_path() -> str:
    """解析数据库路径（C:\\Sidemate\\data\\cloud_usage.db）"""
    global _db_path
    if _db_path:
        return _db_path
    try:
        from config import DATA_DIR
        data_dir = DATA_DIR
    except Exception:
        data_dir = os.path.join(os.path.dirname(__file__), "..", "..", "data")
        data_dir = os.path.abspath(data_dir)
    os.makedirs(data_dir, exist_ok=True)
    _db_path = os.path.join(data_dir, "cloud_usage.db")
    return _db_path


def _get_conn() -> sqlite3.Connection:
    """获取当前线程的 SQLite 连接（线程局部，WAL 模式）"""
    conn = getattr(_local, "conn", None)
    if conn is None:
        conn = sqlite3.connect(_resolve_db_path(), timeout=30, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")
        _local.conn = conn
    return conn


def _init_db() -> None:
    """初始化表结构（首次调用时）"""
    with _init_lock:
        conn = _get_conn()
        try:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS cloud_usage (
                    id               INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts               INTEGER NOT NULL,
                    model            TEXT NOT NULL,
                    input_tokens     INTEGER,
                    output_tokens    INTEGER,
                    reasoning_tokens INTEGER,
                    elapsed_ms       INTEGER,
                    token_accurate   INTEGER NOT NULL DEFAULT 1
                );
                CREATE INDEX IF NOT EXISTS idx_cu_ts ON cloud_usage(ts);
                CREATE INDEX IF NOT EXISTS idx_cu_model ON cloud_usage(model);
            """)
            conn.commit()
        except Exception as e:
            log.error("[CLOUD_USAGE] 初始化失败: %s", e)


def record_usage(model: str,
                 input_tokens: Optional[int] = None,
                 output_tokens: Optional[int] = None,
                 reasoning_tokens: Optional[int] = None,
                 elapsed_ms: Optional[int] = None,
                 token_accurate: bool = True) -> None:
    """记录一次云端 API 调用的用量。

    Args:
        model: 模型名（如 deepseek-v4-flash）
        input_tokens: 输入 token 数（None=API 未返回 usage）
        output_tokens: 输出 token 数
        reasoning_tokens: 推理 token 数（推理模型才有）
        elapsed_ms: 调用耗时（毫秒）
        token_accurate: token 数据是否真实（False=估算/不可用）

    诚实原则：token_accurate=False 时，token 字段允许为 None，
    只记请求次数（行数），不编造 token 数。
    """
    if not model:
        return
    _init_db()
    conn = _get_conn()
    try:
        conn.execute(
            """INSERT INTO cloud_usage
               (ts, model, input_tokens, output_tokens, reasoning_tokens, elapsed_ms, token_accurate)
               VALUES (?, ?, ?, ?, ?, ?, ?)""",
            (int(time.time()), model,
             input_tokens, output_tokens, reasoning_tokens, elapsed_ms,
             1 if token_accurate else 0)
        )
        conn.commit()
    except Exception as e:
        log.warning("[CLOUD_USAGE] 记录失败: %s", e)
        return

    # 覆写式清理：每次写入顺便删 7 天前的记录
    _cleanup()


def _cleanup() -> None:
    """删除超过保留期的记录"""
    cutoff = int(time.time()) - RETENTION_SECONDS
    conn = _get_conn()
    try:
        conn.execute("DELETE FROM cloud_usage WHERE ts < ?", (cutoff,))
        conn.commit()
    except Exception as e:
        log.debug("[CLOUD_USAGE] 清理失败: %s", e)


def query_usage(range_days: int = 7, granularity: str = "hour") -> Dict[str, Any]:
    """查询用量统计。

    Args:
        range_days: 查询最近 N 天（1=今日, 7=本周）
        granularity: 聚合粒度 "hour" 或 "day"

    Returns:
        {
            total_tokens, total_calls, all_accurate,
            by_model: [{model, tokens, calls}],
            by_bucket: [{bucket, tokens, calls}],
            records: [{ts, model, input, output, reasoning, elapsed_ms, accurate}]
        }
    """
    _init_db()
    conn = _get_conn()
    cutoff = int(time.time()) - range_days * 24 * 3600

    try:
        # 按模型聚合
        model_rows = conn.execute(
            """SELECT model,
                      SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(reasoning_tokens,0)) as tokens,
                      COUNT(*) as calls
               FROM cloud_usage WHERE ts >= ?
               GROUP BY model ORDER BY tokens DESC""",
            (cutoff,)
        ).fetchall()

        # 按时间桶聚合
        if granularity == "day":
            fmt = "%Y-%m-%d"
        else:
            fmt = "%Y-%m-%d %H:00"
        bucket_rows = conn.execute(
            """SELECT strftime(?, ts, 'unixepoch', 'localtime') as bucket,
                      SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(reasoning_tokens,0)) as tokens,
                      COUNT(*) as calls
               FROM cloud_usage WHERE ts >= ?
               GROUP BY bucket ORDER BY bucket""",
            (fmt, cutoff)
        ).fetchall()

        # 总计
        total_row = conn.execute(
            """SELECT
                 SUM(COALESCE(input_tokens,0) + COALESCE(output_tokens,0) + COALESCE(reasoning_tokens,0)) as tokens,
                 COUNT(*) as calls,
                 MIN(token_accurate) as min_accurate
               FROM cloud_usage WHERE ts >= ?""",
            (cutoff,)
        ).fetchone()

        # 最近记录（最多 50 条）
        record_rows = conn.execute(
            """SELECT ts, model, input_tokens, output_tokens, reasoning_tokens, elapsed_ms, token_accurate
               FROM cloud_usage WHERE ts >= ?
               ORDER BY ts DESC LIMIT 50""",
            (cutoff,)
        ).fetchall()

        total_tokens = total_row["tokens"] or 0
        total_calls = total_row["calls"] or 0
        # all_accurate: 是否所有记录都是真实 token（min_accurate=0 表示有不可用记录）
        all_accurate = (total_row["min_accurate"] is None) or (total_row["min_accurate"] == 1)

        return {
            "total_tokens": total_tokens,
            "total_calls": total_calls,
            "all_accurate": all_accurate,
            "range_days": range_days,
            "granularity": granularity,
            "by_model": [
                {"model": r["model"], "tokens": r["tokens"] or 0, "calls": r["calls"]}
                for r in model_rows
            ],
            "by_bucket": [
                {"bucket": r["bucket"], "tokens": r["tokens"] or 0, "calls": r["calls"]}
                for r in bucket_rows
            ],
            "records": [
                {
                    "ts": r["ts"],
                    "model": r["model"],
                    "input": r["input_tokens"],
                    "output": r["output_tokens"],
                    "reasoning": r["reasoning_tokens"],
                    "elapsed_ms": r["elapsed_ms"],
                    "accurate": r["token_accurate"] == 1,
                }
                for r in record_rows
            ],
        }
    except Exception as e:
        log.error("[CLOUD_USAGE] 查询失败: %s", e)
        return {
            "total_tokens": 0, "total_calls": 0, "all_accurate": True,
            "range_days": range_days, "granularity": granularity,
            "by_model": [], "by_bucket": [], "records": [],
        }


def close() -> None:
    """关闭当前线程的连接"""
    conn = getattr(_local, "conn", None)
    if conn:
        try:
            conn.close()
        except Exception:
            pass
        _local.conn = None
