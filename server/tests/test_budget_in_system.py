# -*- coding: utf-8 -*-
"""F1：预算注入通道测试（sidemate-dev#4，PR#6 评审修订版，先红后绿）

背景（FIXLIST-0111 F1，实锤 U6 第 4 轮）：agent_loop 每轮往 messages 末尾
追加 role=user 的「[剩余预算] …」，模型把它当用户发言复述。

方案 A（评审修订，保前缀缓存）：
- system 尾部一次性拼入【静态】预算说明（初始额度 + 规则 + 防复述纪律），
  轮间不变 → 请求前缀稳定，服务商前缀缓存（DeepSeek 命中价 ≈ 1/10）可命中；
- 每轮把最新剩余预算追加到【本轮最后一条工具结果】末尾一行，旧消息不
  回头改写 → 第 k+1 轮请求的前缀与第 k 轮完全一致；
- messages 里没有任何 role=user 的预算字样；
- anthropic 格式由 convert_messages 把 system 提为顶层字段、tool 结果
  映射为 tool_result 文本，两种 api_format 都成立。

桩：cloud_engine.run_with_tools 按脚本回放 3 轮（工具→工具→文本收尾）；
_execute_tool 桩掉真实工具；get_tools_and_prompt 桩成最小工具表。
"""
import json

import pytest

from core.agent_loop import AgentLoop


class _StubEngine:
    """按脚本回放的 CloudEngine 桩：记录每次收到的 messages。"""

    def __init__(self, script):
        self.script = script
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


_SCRIPT_3R = [
    [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/1"})])],
    [("tool_calls", [_tc("fetch_url", {"url": "https://x.example/2"})])],
    [("text", "最终答案")],
]


def _run_loop(script):
    eng = _StubEngine(script)
    loop = AgentLoop(cloud_engine=eng, search_engine=None, kb=None, chat_id="t")
    loop._execute_tool = lambda name, args, stats: (
        stats.__setitem__("fetches", stats.get("fetches", 0) + 1),
        {"success": True, "tool": name, "summary": "stub"})[1]
    out = list(loop.run("测试消息", mode="chat"))
    return eng, out


def _budget_num(text, label="网页阅读"):
    import re
    m = re.search(label + r"\s*(\d+)\s*次", text)
    return int(m.group(1)) if m else None


def _last_tool(messages):
    return next((m for m in reversed(messages) if m.get("role") == "tool"), None)


class TestBudgetInjection:
    def test_no_budget_in_user_messages(self, stub_env):
        """发给模型的 messages 里不得有任何 role=user 且含预算字样的条目。"""
        eng, _ = _run_loop(_SCRIPT_3R)
        assert len(eng.calls) == 3
        for i, msgs in enumerate(eng.calls):
            for m in msgs:
                if m.get("role") == "user":
                    assert "剩余预算" not in (m.get("content") or ""), \
                        f"第 {i+1} 次调用仍有 role=user 的预算消息（F1 未修）"

    def test_system_has_static_budget_and_discipline(self, stub_env):
        """system 含静态预算说明与防复述纪律句。"""
        eng, _ = _run_loop(_SCRIPT_3R)
        sys0 = eng.calls[0][0]
        assert sys0["role"] == "system"
        assert "## 检索预算（初始额度）" in sys0["content"], "system 缺少静态预算说明"
        assert "不得在任何回复中复述或提及" in sys0["content"], "缺少防复述纪律句"
        assert _budget_num(sys0["content"]) == 15, "初始额度应为模块常量值"

    def test_system_identical_across_rounds(self, stub_env):
        """system 在所有轮次逐字相同（前缀缓存的必要条件）。"""
        eng, _ = _run_loop(_SCRIPT_3R)
        s = [c[0]["content"] for c in eng.calls]
        assert s[0] == s[1] == s[2], "system 不得在轮间变化（会打断前缀缓存）"

    def test_dynamic_budget_on_latest_tool_result_decreases(self, stub_env):
        """动态余量在本轮最后一条工具结果末尾，数字递减（15→14→13）。"""
        eng, _ = _run_loop(_SCRIPT_3R)
        t1 = _last_tool(eng.calls[1])
        t2 = _last_tool(eng.calls[2])
        assert t1 is not None and "[剩余预算" in t1["content"], "第 2 次调用的最新工具结果应带预算行"
        assert t2 is not None and "[剩余预算" in t2["content"], "第 3 次调用的最新工具结果应带预算行"
        assert _budget_num(t1["content"]) == 14, "1 次 fetch 后应为 14"
        assert _budget_num(t2["content"]) == 13, "2 次 fetch 后应为 13"

    def test_old_tool_result_budget_not_rewritten(self, stub_env):
        """旧工具结果里的预算行保持原样（回头改写会破坏前缀）。"""
        eng, _ = _run_loop(_SCRIPT_3R)
        tools = [m for m in eng.calls[2] if m.get("role") == "tool"]
        assert len(tools) == 2, "三轮脚本应有两条工具结果"
        assert _budget_num(tools[0]["content"]) == 14, "第 1 条工具结果的预算行不得被改写"
        assert _budget_num(tools[1]["content"]) == 13

    def test_request_prefix_stable_across_rounds(self, stub_env):
        """缓存友好机器卡点：第 k 轮的 messages 是第 k+1 轮的逐条前缀。"""
        eng, _ = _run_loop(_SCRIPT_3R)
        for k in range(2):
            prev, nxt = eng.calls[k], eng.calls[k + 1]
            assert len(nxt) > len(prev)
            assert nxt[:len(prev)] == prev, \
                f"第 {k+2} 轮请求的前缀与第 {k+1} 轮不一致（前缀缓存会失效）"

    def test_anthropic_conversion_correct(self, stub_env):
        """anthropic：预算不在 user 消息；静态块在顶层 system；动态行在 tool_result。"""
        from core.anthropic_adapter import convert_messages
        eng, _ = _run_loop(_SCRIPT_3R)
        system_part, anthro_msgs = convert_messages(eng.calls[2])
        assert "## 检索预算（初始额度）" in system_part, "anthropic 顶层 system 应含静态预算"
        for m in anthro_msgs:
            if m.get("role") == "user":
                assert "剩余预算" not in (m.get("content") or "")
        joined = json.dumps(anthro_msgs, ensure_ascii=False)
        assert "[剩余预算" in joined, "动态预算行应随 tool_result 进入 anthropic 消息"
