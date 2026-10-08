# -*- coding: utf-8 -*-
"""F1：预算快照注入通道测试（sidemate-dev#4，先红后绿）

背景（FIXLIST-0111 F1，实锤 U6 第 4 轮）：agent_loop 每轮往 messages 末尾
追加 role=user 的「[剩余预算] …」，模型把它当用户发言复述（会话
2026-10-01_020 消息 m0007/m0008 整段复述预算清单）。

方案 A：预算改为 system prompt 尾部每轮刷新「## 剩余预算」块，
messages 里不再出现任何预算字样；并加一句防复述纪律。
两种 api_format 都要成立：openai 直接用 messages[0]；anthropic 由
anthropic_adapter.convert_messages 把 role=system 提为顶层 system 字段。

桩：cloud_engine.run_with_tools 按脚本回放；_execute_tool 桩掉真实工具；
get_tools_and_prompt 桩成最小工具表。跑 2 轮（第 1 轮调一次 fetch_url，
第 2 轮纯文本收尾）。
"""
import json

import pytest

from core.agent_loop import AgentLoop


class _StubEngine:
    """按脚本回放的 CloudEngine 桩：记录每次收到的 messages。"""

    def __init__(self, script):
        self.script = script  # 每次调用 yield 的 (phase, content) 列表
        self.calls = []
        self._mm = type("MM", (), {"_stop_generation": False, "stop_requested": False})()

    def run_with_tools(self, messages, tools=None, _skip_queue=False, model=None):
        self.calls.append([dict(m) for m in messages])
        for phase, content in self.script[len(self.calls) - 1]:
            yield (phase, content)


def _tc(name, args):
    return {"id": "c1", "type": "function",
            "function": {"name": name, "arguments": json.dumps(args, ensure_ascii=False)}}


@pytest.fixture()
def stub_env(monkeypatch):
    """最小工具表 + 桩掉 get_tools_and_prompt（不读真实配置）。

    另注入假的 ``server`` 模块：agent_loop 轮次边界会 ``from server import mgr``
    查停止标记，真身会把看门狗拉进 pytest（test_auto_name 同款坑）。
    """
    import types
    import core.agent_tools as at
    monkeypatch.setattr(at, "get_tools_and_prompt",
                        lambda **kw: ([{"type": "function",
                                        "function": {"name": "fetch_url",
                                                     "description": "d",
                                                     "parameters": {}}}],
                                      "BASE-SYSTEM."))
    import sys as _sys
    fake_server = types.ModuleType("server")
    fake_server.mgr = types.SimpleNamespace(stop_requested=False)
    monkeypatch.setitem(_sys.modules, "server", fake_server)


def _run_loop(script):
    eng = _StubEngine(script)
    loop = AgentLoop(cloud_engine=eng, search_engine=None, kb=None, chat_id="t")
    loop._execute_tool = lambda name, args, stats: (
        stats.__setitem__("fetches", stats.get("fetches", 0) + 1),
        {"success": True, "tool": name, "summary": "stub"})[1]
    out = list(loop.run("测试消息", mode="chat"))
    return eng, out


def _budget_num(system_text, label):
    import re
    m = re.search(label + r"\s*(\d+)\s*次", system_text)
    return int(m.group(1)) if m else None


class TestBudgetInSystemNotUser:
    def test_no_budget_in_user_messages(self, stub_env):
        """发给模型的 messages 里不得有任何 role=user 且含预算字样的条目。"""
        eng, _ = _run_loop([
            [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/1"})])],
            [("text", "最终答案")],
        ])
        assert len(eng.calls) >= 2, "应发生至少两次引擎调用（1 次工具 + 1 次收尾）"
        for i, msgs in enumerate(eng.calls):
            for m in msgs:
                if m.get("role") == "user":
                    assert "剩余预算" not in (m.get("content") or ""), \
                        f"第 {i+1} 次调用仍有 role=user 的预算消息（F1 未修）"

    def test_system_has_budget_block_and_discipline(self, stub_env):
        """system 尾部必须有「## 剩余预算」块与防复述纪律句。"""
        eng, _ = _run_loop([
            [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/1"})])],
            [("text", "最终答案")],
        ])
        sys0 = eng.calls[0][0]
        assert sys0["role"] == "system"
        assert "## 剩余预算" in sys0["content"], "system 缺少「## 剩余预算」块"
        assert "复述" in sys0["content"], "缺少「不得复述预算」纪律句"

    def test_budget_numbers_decrease_across_rounds(self, stub_env):
        """预算数字随轮次递减（fetch_url 用掉 1 次：15 → 14）。"""
        eng, _ = _run_loop([
            [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/1"})])],
            [("text", "最终答案")],
        ])
        first = _budget_num(eng.calls[0][0]["content"], "网页阅读")
        second = _budget_num(eng.calls[1][0]["content"], "网页阅读")
        assert first is not None and second is not None, "两轮 system 都应带网页阅读预算"
        assert second == first - 1, f"预算应递减：{first} → {second}"

    def test_budget_block_refreshed_not_accumulated(self, stub_env):
        """「## 剩余预算」块每轮刷新，不累积多个。"""
        eng, _ = _run_loop([
            [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/1"})])],
            [("text", "最终答案")],
        ])
        for i, msgs in enumerate(eng.calls):
            n = msgs[0]["content"].count("## 剩余预算")
            assert n == 1, f"第 {i+1} 次调用 system 里出现 {n} 个预算块（应刷新不累积）"

    def test_anthropic_conversion_keeps_budget_in_system(self, stub_env):
        """anthropic 格式：convert_messages 后预算在顶层 system、不在用户消息。"""
        from core.anthropic_adapter import convert_messages
        eng, _ = _run_loop([
            [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/1"})])],
            [("text", "最终答案")],
        ])
        system_part, anthro_msgs = convert_messages(eng.calls[0])
        assert "## 剩余预算" in system_part, "anthropic 顶层 system 应含预算块"
        for m in anthro_msgs:
            assert m.get("role") != "user" or "剩余预算" not in (m.get("content") or "")
