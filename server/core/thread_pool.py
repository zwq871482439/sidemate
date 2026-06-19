# -*- coding: utf-8 -*-
"""
core/thread_pool.py — 全局线程池管理器（Patch5 T01）
=====================================================

解决 FastAPI 单线程事件循环被同步阻塞操作（文件解析、embedding 计算）卡死的问题。

用法：
    from core.thread_pool import get_thread_pool
    result = get_thread_pool().run_blocking(fn, *args)
    future = get_thread_pool().submit(fn, *args)

设计原则：
  - max_workers = 2（config.thread_pool_max_workers），不要调大，避免占满 CPU
  - SSE 流式响应（StreamingResponse + async generator）不走线程池
  - 全局单例，在 server.py lifespan 中初始化
"""
import logging
from concurrent.futures import ThreadPoolExecutor, Future
from typing import Any, Callable, Optional

log = logging.getLogger(__name__)


class ThreadPoolManager:
    """全局线程池管理器单例

    封装 ThreadPoolExecutor，提供同步阻塞调用接口。
    所有同步阻塞操作（文件解析、embedding、BM25 构建）都应通过此管理器执行，
    避免直接在 FastAPI 事件循环线程中阻塞。

    Attributes:
        executor: ThreadPoolExecutor 实例
        max_workers: 线程池大小
    """

    def __init__(self, max_workers: int = 2):
        """初始化线程池管理器

        Args:
            max_workers: 线程池最大线程数，默认 2
        """
        self.max_workers = max_workers
        self.executor: Optional[ThreadPoolExecutor] = None
        self._initialized = False

    def init(self, max_workers: int = None) -> None:
        """初始化线程池（在 server.py lifespan startup 中调用）

        Args:
            max_workers: 线程池大小，None 则使用已有值或配置值
        """
        if self._initialized and self.executor is not None:
            return
        if max_workers is not None:
            self.max_workers = max_workers
        self.executor = ThreadPoolExecutor(
            max_workers=self.max_workers,
            thread_name_prefix="sidemate-pool",
        )
        self._initialized = True
        log.info("[THREAD_POOL] 线程池已初始化: max_workers=%d", self.max_workers)

    def submit(self, fn: Callable, *args, **kwargs) -> Future:
        """提交任务到线程池，返回 Future

        用于异步场景：提交后不阻塞当前线程，通过 Future.result() 获取结果。

        Args:
            fn: 要执行的函数
            *args: 位置参数
            **kwargs: 关键字参数

        Returns:
            concurrent.futures.Future 对象
        """
        if self.executor is None:
            log.warning("[THREAD_POOL] 线程池未初始化，惰性创建")
            self.init()
        return self.executor.submit(fn, *args, **kwargs)

    def run_blocking(self, fn: Callable, *args, **kwargs) -> Any:
        """在线程池中执行阻塞函数，同步等待返回结果

        用于需要同步等待结果的场景（如 FastAPI run_in_threadpool 的替代）。

        Args:
            fn: 要执行的阻塞函数
            *args: 位置参数
            **kwargs: 关键字参数

        Returns:
            函数的返回值
        """
        if self.executor is None:
            log.warning("[THREAD_POOL] 线程池未初始化，惰性创建")
            self.init()
        future = self.executor.submit(fn, *args, **kwargs)
        return future.result()

    def shutdown(self, wait: bool = True) -> None:
        """关闭线程池（在 server.py lifespan shutdown 中调用）

        Args:
            wait: 是否等待所有已提交任务完成
        """
        if self.executor is not None:
            log.info("[THREAD_POOL] 正在关闭线程池...")
            self.executor.shutdown(wait=wait)
            self.executor = None
            self._initialized = False
            log.info("[THREAD_POOL] 线程池已关闭")


# ===== 全局单例 =====

_thread_pool_instance: Optional[ThreadPoolManager] = None


def get_thread_pool() -> ThreadPoolManager:
    """获取全局 ThreadPoolManager 单例

    如果尚未初始化，惰性创建（但不推荐在 lifespan 之前调用）。

    Returns:
        ThreadPoolManager 全局实例
    """
    global _thread_pool_instance
    if _thread_pool_instance is None:
        _thread_pool_instance = ThreadPoolManager()
    return _thread_pool_instance


def init_thread_pool(max_workers: int = None) -> ThreadPoolManager:
    """初始化全局线程池（在 server.py lifespan startup 中调用）

    Args:
        max_workers: 线程池大小，None 则读取 config

    Returns:
        初始化后的 ThreadPoolManager 实例
    """
    global _thread_pool_instance
    if _thread_pool_instance is None:
        _thread_pool_instance = ThreadPoolManager()

    if max_workers is None:
        try:
            from config import get as _cfg
            max_workers = _cfg("thread_pool_max_workers", 2)
        except Exception:
            max_workers = 2

    _thread_pool_instance.init(max_workers=max_workers)
    return _thread_pool_instance


def shutdown_thread_pool(wait: bool = True) -> None:
    """关闭全局线程池（在 server.py lifespan shutdown 中调用）

    Args:
        wait: 是否等待所有已提交任务完成
    """
    global _thread_pool_instance
    if _thread_pool_instance is not None:
        _thread_pool_instance.shutdown(wait=wait)
