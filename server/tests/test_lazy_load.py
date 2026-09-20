# -*- coding: utf-8 -*-
"""0.10.1 启动不预载五条单测。

注意：不 import server（看门狗在模块级）；懒加载助手用桩替 ollama_manager。
"""
import asyncio

import pytest

import config as cfg


class TestLazyLoadDefaults:
    def test_defaults(self):
        assert cfg.DEFAULTS.get("preload_model_at_start") is False
        assert cfg.DEFAULTS.get("idle_unload_minutes") == 30


class _FakeMgr:
    """桩：ollama_manager 最小面（is_healthy/start/registry.scan）"""

    def __init__(self, ready_after_calls=1):
        self.start_calls = 0
        self.polls = 0
        self.ready_after = ready_after_calls  # start 调用几次后变健康

    def is_healthy(self):
        self.polls += 1
        return self.start_calls >= self.ready_after

    def start(self):
        self.start_calls += 1
        return {"status": "started", "model": ""}

    class registry:
        @staticmethod
        def scan():
            return []


class TestLazyLoadEngine:
    def test_kicks_start_and_waits(self):
        from routers import chat as _chat
        mgr = _FakeMgr(ready_after_calls=1)
        ok = asyncio.run(_chat._lazy_load_engine(mgr, timeout_s=5))
        assert ok is True
        assert mgr.start_calls == 1  # 单飞：只触发一次 start

    def test_concurrent_single_flight(self):
        from routers import chat as _chat
        mgr = _FakeMgr(ready_after_calls=1)
        async def _two():
            return await asyncio.gather(
                _chat._lazy_load_engine(mgr, timeout_s=6),
                _chat._lazy_load_engine(mgr, timeout_s=6))
        ok = asyncio.run(_two())
        assert ok == [True, True]
        assert mgr.start_calls == 1  # 两个并发请求也只 start 一次

    def test_timeout_returns_false(self):
        from routers import chat as _chat

        class _NeverReady:
            start_calls = 0
            polls = 0

            def is_healthy(self):
                return False

            def start(self):
                _NeverReady.start_calls += 1
                return {"status": "started", "model": ""}

            class registry:
                @staticmethod
                def scan():
                    return []

        ok = asyncio.run(_chat._lazy_load_engine(_NeverReady(), timeout_s=0.5))
        assert ok is False


class TestIdleMark:
    def test_mark_updates_timestamp(self):
        from core.llamacpp_backend import client as _c
        before = _c.last_llm_use()
        _c.mark_llm_use()
        assert _c.last_llm_use() >= before
