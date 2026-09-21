# -*- coding: utf-8 -*-
"""
core/gen_manager.py — 生成任务管理器（0.10 M2：生成与连接解耦）
================================================================

核心命题（DeepSeek 实测+OWUI/AnythingLLM 源码验证）：
    生成的权威主体从 HTTP 请求移到服务端后台任务。
    连接只是观察窗口——刷新=换窗口，生成不死。

架构：
    POST /api/chat/stream → 预处理 → gen_manager.start(chat_id, pipeline)
        → StreamingResponse(task.subscribe())  ← 订阅者 1（原始连接）
    后台线程消费 pipeline 生成器 → 事件入缓冲+增量落盘
    GET /api/chats/{id}/gen-live  → StreamingResponse(task.subscribe())
        ← 订阅者 2（刷新后重附）
    GET /api/chats/{id}/gen-state → JSON 状态（前端判断是否需要重附）

事件日志：
    内存：list[(seq, sse_str)]，seq 从 1 递增
    磁盘：<chat>/gen_events.jsonl（定频 flush，每 2s 或每 50 事件）
"""
from __future__ import annotations

import json
import logging
import os
import threading
import time
from collections import deque
from typing import Callable, Generator, Optional

log = logging.getLogger(__name__)

# 全局单例
_manager: Optional["GenManager"] = None
_manager_lock = threading.Lock()


def get_gen_manager() -> "GenManager":
    global _manager
    with _manager_lock:
        if _manager is None:
            _manager = GenManager()
        return _manager


class GenerationTask:
    """一次后台生成任务：事件缓冲+订阅分发+增量落盘。"""

    def __init__(self, chat_id: str, chat_dir: str):
        self.chat_id = chat_id
        self.chat_dir = chat_dir
        self.seq = 0
        self.events: deque = deque(maxlen=2000)  # (seq, sse_str)
        self.status = "generating"  # generating | done | error
        self.error_msg = ""
        self.started_at = time.time()
        self.done_at: Optional[float] = None
        self._lock = threading.Lock()
        self._cond = threading.Condition(self._lock)
        self._thread: Optional[threading.Thread] = None
        self._flush_thread: Optional[threading.Thread] = None
        self._disk_events: list = []  # 待落盘
        self._stop_flush = False
        self._last_flush = 0.0

    # ---- 生产者（后台线程调） ----

    def push(self, sse_str: str):
        """追加一条 SSE 事件（生产者）。"""
        with self._cond:
            self.seq += 1
            self.events.append((self.seq, sse_str))
            self._disk_events.append({"seq": self.seq, "data": sse_str})
            self._cond.notify_all()

    def finish(self, error: str = ""):
        """标记完成（生产者）。"""
        with self._cond:
            self.status = "error" if error else "done"
            self.error_msg = error[:200]
            self.done_at = time.time()
            self._cond.notify_all()
        self._flush_disk(force=True)

    # ---- 消费者（HTTP 响应生成器） ----

    def subscribe(self, since_seq: int = 0) -> Generator[str, None, None]:
        """从 since_seq 之后开始读取事件（消费者）。阻塞等新事件直到 done。"""
        cursor = since_seq
        while True:
            with self._cond:
                # 找 cursor 之后的事件
                found = None
                for seq, sse in self.events:
                    if seq > cursor:
                        found = (seq, sse)
                        break
                if found:
                    cursor, sse = found
                    yield sse
                    continue
                # 无新事件：done 且追完 → 结束
                if self.status in ("done", "error"):
                    # 确认真的追完了（再查一遍）
                    final = None
                    for seq, sse in self.events:
                        if seq > cursor:
                            final = (seq, sse)
                            break
                    if final:
                        continue  # 还有尾巴，回去 yield
                    # 追完了
                    if self.status == "error" and self.error_msg:
                        yield 'data: {"type": "error", "content": "%s"}\n\n' % \
                            self.error_msg.replace('"', '\\"')
                    yield "data: [DONE]\n\n"
                    return
                # 等新事件（超时 2s 醒来重查，防死锁）
                self._cond.wait(timeout=2.0)

    async def subscribe_async(self, since_seq: int = 0):
        """异步版订阅：事件循环里跑（不占线程池槽位，断连后服务端仍可响应新请求）。"""
        import asyncio
        cursor = since_seq
        while True:
            with self._lock:
                found = None
                for seq, sse in self.events:
                    if seq > cursor:
                        found = (seq, sse)
                        break
                if found:
                    cursor, sse = found
                    yield sse
                    continue
                if self.status in ("done", "error"):
                    final = None
                    for seq, sse in self.events:
                        if seq > cursor:
                            final = (seq, sse)
                            break
                    if final:
                        continue
                    if self.status == "error" and self.error_msg:
                        yield 'data: {"type": "error", "content": "%s"}\n\n' % \
                              self.error_msg.replace('"', '\\"')
                    yield "data: [DONE]\n\n"
                    return
            await asyncio.sleep(0.15)

    # ---- 状态查询 ----

    def state(self) -> dict:
        """当前状态（gen-state 端点用）。"""
        with self._lock:
            tail = list(self.events)[-50:] if self.events else []
            return {
                "chat_id": self.chat_id,
                "status": self.status,
                "seq": self.seq,
                "elapsed": round((self.done_at or time.time()) - self.started_at, 1),
                "events_tail": [sse for _, sse in tail],
            }

    # ---- 磁盘落盘 ----

    def _flush_disk(self, force: bool = False):
        """把待写事件追加到 <chat>/gen_events.jsonl（定频/强制）。"""
        if not self._disk_events and not force:
            return
        now = time.time()
        if not force and now - self._last_flush < 2.0:
            return
        path = os.path.join(self.chat_dir, "gen_events.jsonl")
        try:
            with open(path, "a", encoding="utf-8") as f:
                for ev in self._disk_events:
                    f.write(json.dumps(ev, ensure_ascii=False) + "\n")
                if force:
                    f.write(json.dumps({"seq": self.seq, "eof": True,
                                        "status": self.status,
                                        "ts": time.strftime("%H:%M:%S")},
                                       ensure_ascii=False) + "\n")
            self._disk_events.clear()
            self._last_flush = now
        except Exception as e:
            log.warning("[GEN-MGR] 落盘失败 %s: %s", self.chat_id, str(e)[:80])

    def _flush_loop(self):
        """后台定期落盘线程。"""
        while not self._stop_flush:
            time.sleep(2.0)
            self._flush_disk()
            if self.status in ("done", "error"):
                self._stop_flush = True
                break


class GenManager:
    """管理所有进行中的生成任务（per-chat 单任务）。"""

    def __init__(self):
        self._tasks: dict[str, GenerationTask] = {}
        self._lock = threading.Lock()

    def get(self, chat_id: str) -> Optional[GenerationTask]:
        with self._lock:
            return self._tasks.get(chat_id)

    def is_generating(self, chat_id: str) -> bool:
        t = self.get(chat_id)
        return t is not None and t.status == "generating"

    def start(self, chat_id: str, chat_dir: str,
              pipeline_gen: Generator, on_complete: Optional[Callable] = None) -> GenerationTask:
        """创建后台任务：消费 pipeline_gen → 事件入缓冲。"""
        # 已有进行中的任务：拒绝（per-chat 单任务）
        with self._lock:
            existing = self._tasks.get(chat_id)
            if existing and existing.status == "generating":
                raise RuntimeError("该会话已有进行中的生成")

        task = GenerationTask(chat_id, chat_dir)

        def _run():
            try:
                for sse_str in pipeline_gen:
                    if not isinstance(sse_str, str):
                        continue
                    task.push(sse_str)
                task.finish()
            except Exception as e:
                log.warning("[GEN-MGR] 生成异常 %s: %s", chat_id, str(e)[:150])
                task.finish(error=str(e)[:200])
            finally:
                if on_complete:
                    try:
                        on_complete()
                    except Exception:
                        pass
                # 完成后保留任务 5 分钟（供刷新恢复查看），然后清理
                def _cleanup():
                    time.sleep(300)
                    with self._lock:
                        if self._tasks.get(chat_id) is task:
                            del self._tasks[chat_id]
                threading.Thread(target=_cleanup, daemon=True).start()

        with self._lock:
            self._tasks[chat_id] = task

        task._thread = threading.Thread(target=_run, daemon=True, name=f"gen-{chat_id}")
        task._thread.start()
        task._flush_thread = threading.Thread(target=task._flush_loop, daemon=True)
        task._flush_thread.start()
        log.info("[GEN-MGR] 任务启动: %s", chat_id)
        return task

    def state(self, chat_id: str) -> Optional[dict]:
        t = self.get(chat_id)
        return t.state() if t else None
