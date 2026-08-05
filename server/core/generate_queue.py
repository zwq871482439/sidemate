# -*- coding: utf-8 -*-
"""LLM 生成请求队列 — 优先级调度 + 抢占

提供 GenerateQueue（优先级队列）和 GenerateTicket（设备使用权票据）。

调度策略：
  - HIGH 优先级（用户对话）到达时，取消排队中的 LOW 请求
  - LOW 优先级（后台任务：摘要/纠错/压缩）可被 HIGH 抢占
  - 相同优先级先来先服务（FIFO）
  - Watchdog：持有超过 120 秒视为僵尸，强制释放
"""
import time
import threading
import logging

log = logging.getLogger(__name__)


class GenerateQueue:
    """LLM 生成请求队列 — 优先级调度 + 抢占"""

    HIGH = "high"   # 用户对话
    LOW = "low"     # 后台任务（摘要/纠错/压缩）

    # active ticket 强制释放阈值：必须高于最坏情况的合法长任务
    # （启动预热 / CPU 上的长文档生成 / agent 单轮大上下文），
    # 否则会把正在正常工作的任务误判为僵尸（实测：预热超 120s 即被误杀，
    # 队列以为设备空闲实际还占着 → 新请求与运行中任务并发抢设备）
    FORCE_RELEASE_AFTER = 600  # 秒

    def __init__(self, on_force_release=None):
        self._lock = threading.Lock()
        # 内部队列项: [(priority_weight, seq_num, threading.Event, result_dict)]
        self._queue = []
        self._seq = 0             # FIFO 序号（相同优先级先来后到）
        self._active_event = None  # 当前持有"设备"的请求的 event
        self._active_priority = None
        self._cancel_next_low = False  # HIGH 到达时标记
        self._active_since = None     # active ticket 获取时间
        # 强制释放时的回调（由 model_manager 注入：置 stop_requested，
        # 让被误判/真卡死的任务在下一个 token 检查点退出，真正释放设备）
        self._on_force_release = on_force_release

    def submit(self, priority="low", timeout=60):
        """
        提交生成请求，阻塞等待获得"设备"使用权。
        返回 GenerateTicket 或 None（超时/被取消）。

        Args:
            priority: "high" 或 "low"
            timeout: 最大等待秒数（默认60s）

        Returns:
            GenerateTicket 实例（成功）或 None（超时/被取消）
        """
        ticket_event = threading.Event()
        result = {"cancelled": False, "ticket_id": self._seq}
        _fire_force_release = False

        with self._lock:
            # HIGH 到达时，取消排队中的 LOW
            if priority == self.HIGH:
                self._cancel_all_low_locked()

            # 优先级权重：HIGH=0（最高），LOW=1
            weight = 0 if priority == self.HIGH else 1
            self._queue.append((weight, self._seq, ticket_event, result))
            self._queue.sort(key=lambda x: (x[0], x[1]))  # 按优先级+序号排序
            self._seq += 1

            # Watchdog：active ticket 持有超过 FORCE_RELEASE_AFTER 秒，视为僵尸，强制释放
            # 必须在设备空闲判断之前执行，否则僵尸占用 active_event 导致空闲判断失败
            if self._active_since is not None and (time.time() - self._active_since) > self.FORCE_RELEASE_AFTER:
                log.warning("[GenerateQueue] Active ticket held >%ds, force releasing（已请求停止当前生成）",
                            self.FORCE_RELEASE_AFTER)
                self._active_event = None
                self._active_priority = None
                self._active_since = None
                _fire_force_release = True

            # 设备空闲时立即授权（无需排队）
            if self._active_event is None and self._queue:
                self._queue.sort(key=lambda x: (x[0], x[1]))
                _, _, next_event, _ = self._queue[0]
                self._queue = self._queue[1:]
                next_event.set()

        # 锁外触发回调（避免持队列锁调外部代码引入锁序问题）
        if _fire_force_release and self._on_force_release:
            try:
                self._on_force_release()
            except Exception as e:
                log.warning("[GenerateQueue] force-release 回调异常: %s", str(e)[:80])

        # 等待获得设备使用权
        acquired = ticket_event.wait(timeout=timeout)

        if not acquired or result["cancelled"]:
            # 超时或被取消，从队列移除
            with self._lock:
                self._queue = [item for item in self._queue if item[2] is not ticket_event]
            return None

        with self._lock:
            self._active_event = ticket_event
            self._active_priority = priority
            self._active_since = time.time()

        return GenerateTicket(self, result["ticket_id"], priority)

    def release(self, ticket):
        """生成完成，释放"设备"给下一个请求。

        Args:
            ticket: 已完成的 GenerateTicket 实例
        """
        with self._lock:
            self._active_event = None
            self._active_priority = None
            self._active_since = None
            # 唤醒队列中第一个等待者
            if self._queue:
                # 重新排序（可能有新 HIGH 请求插入）
                self._queue.sort(key=lambda x: (x[0], x[1]))
                _, _, next_event, _ = self._queue[0]
                self._queue = self._queue[1:]
                next_event.set()  # 唤醒

    def cancel_all_low(self):
        """取消所有排队的 LOW 请求（公开方法）"""
        with self._lock:
            self._cancel_all_low_locked()

    def _cancel_all_low_locked(self):
        """内部：取消所有 LOW 请求（已持有锁）"""
        remaining = []
        for weight, seq, event, result in self._queue:
            if weight == 1:  # LOW
                result["cancelled"] = True
                event.set()  # 唤醒让它知道被取消了
            else:
                remaining.append((weight, seq, event, result))
        self._queue = remaining


class GenerateTicket:
    """生成请求票据 — 持有者拥有设备使用权"""

    def __init__(self, queue: GenerateQueue, ticket_id: int, priority: str):
        self._queue = queue
        self.ticket_id = ticket_id
        self.priority = priority
        self._released = False

    def release(self):
        """释放设备"""
        if not self._released:
            self._released = True
            self._queue.release(self)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.release()
