# -*- coding: utf-8 -*-
"""LLM 统一调度器 — P0/P2 两级优先级调度

P0 = Chat/KB对话/纪要（最高优先级）
P2 = KB打标（低优先级）

调度策略：
  - P0 到达时，取消所有排队中的 P2 请求
  - 相同优先级先来先服务（FIFO）
  - P2 任务正在执行时，等它自然完成（Ollama 不支持 cancel API）
  - Watchdog：持有超过 120 秒视为僵尸，强制释放
"""
import time
import threading
import logging

log = logging.getLogger(__name__)


class LLMScheduler:
    """LLM 统一调度器 — P0/P2 两级优先级调度"""

    P0 = 0  # 最高优先级（Chat/KB对话/纪要）
    P2 = 2  # 低优先级（KB打标）

    def __init__(self):
        self._lock = threading.Lock()
        # 内部队列项: [(priority, seq_num, threading.Event, result_dict)]
        self._queue = []
        self._seq = 0
        self._active_event = None
        self._active_priority = None
        self._active_since = None
        self._active_seq = None

    def submit(self, priority: int = 0, timeout: int = 60):
        """提交请求，阻塞等待获得使用权。

        Args:
            priority: P0=0（最高）或 P2=2（低）
            timeout: 最大等待秒数（默认60s）

        Returns:
            SchedulerTicket 实例（成功）或 None（超时/被取消）
        """
        ticket_event = threading.Event()
        seq = self._seq
        result = {"cancelled": False, "ticket_id": seq}

        with self._lock:
            # P0 到达时，取消排队中的 P2
            if priority == self.P0:
                self._cancel_p2_locked()

            self._queue.append((priority, seq, ticket_event, result))
            self._queue.sort(key=lambda x: (x[0], x[1]))
            self._seq += 1

            # Watchdog：active ticket 持有超过 120s 视为僵尸
            if self._active_since is not None and (time.time() - self._active_since) > 120:
                log.warning("[LLMScheduler] Active ticket held >120s, force releasing (seq=%s)", self._active_seq)
                self._active_event = None
                self._active_priority = None
                self._active_since = None
                self._active_seq = None

            # 设备空闲时立即授权
            if self._active_event is None and self._queue:
                self._queue.sort(key=lambda x: (x[0], x[1]))
                _, _, next_event, _ = self._queue[0]
                self._queue = self._queue[1:]
                next_event.set()

        acquired = ticket_event.wait(timeout=timeout)

        if not acquired or result["cancelled"]:
            with self._lock:
                self._queue = [item for item in self._queue if item[2] is not ticket_event]
            return None

        with self._lock:
            self._active_event = ticket_event
            self._active_priority = priority
            self._active_since = time.time()
            self._active_seq = seq

        return SchedulerTicket(self, seq, priority)

    def release(self, ticket):
        """释放使用权。

        Args:
            ticket: 已完成的 SchedulerTicket 实例
        """
        with self._lock:
            self._active_event = None
            self._active_priority = None
            self._active_since = None
            self._active_seq = None
            if self._queue:
                self._queue.sort(key=lambda x: (x[0], x[1]))
                _, _, next_event, _ = self._queue[0]
                self._queue = self._queue[1:]
                next_event.set()

    def cancel(self, ticket_id) -> bool:
        """取消排队中的任务。

        Args:
            ticket_id: 票据 ID（即 seq_num）

        Returns:
            bool: 是否成功取消
        """
        with self._lock:
            for i, (prio, seq, event, result) in enumerate(self._queue):
                if seq == ticket_id:
                    result["cancelled"] = True
                    event.set()
                    self._queue.pop(i)
                    log.info("[LLMScheduler] Cancelled ticket seq=%d", seq)
                    return True
            return False

    def get_queue_status(self) -> dict:
        """队列状态快照"""
        with self._lock:
            p0_count = sum(1 for p, _, _, _ in self._queue if p == self.P0)
            p2_count = sum(1 for p, _, _, _ in self._queue if p == self.P2)
            return {
                "active_priority": self._active_priority,
                "active_since": self._active_since,
                "queue_length": len(self._queue),
                "p0_waiting": p0_count,
                "p2_waiting": p2_count,
            }

    def _cancel_p2_locked(self):
        """内部：取消排队中的 P2 请求（已持有锁）"""
        remaining = []
        for prio, seq, event, result in self._queue:
            if prio == self.P2:
                result["cancelled"] = True
                event.set()
            else:
                remaining.append((prio, seq, event, result))
        cancelled_count = len(self._queue) - len(remaining)
        if cancelled_count > 0:
            log.info("[LLMScheduler] P0 arrived, cancelled %d P2 queued requests", cancelled_count)
        self._queue = remaining


class SchedulerTicket:
    """调度票据 — 持有者拥有 LLM 使用权"""

    def __init__(self, scheduler: LLMScheduler, ticket_id: int, priority: int):
        self._scheduler = scheduler
        self.ticket_id = ticket_id
        self.priority = priority
        self._released = False

    def release(self):
        """释放使用权"""
        if not self._released:
            self._released = True
            self._scheduler.release(self)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.release()
