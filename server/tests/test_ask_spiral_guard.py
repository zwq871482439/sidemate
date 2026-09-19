# -*- coding: utf-8 -*-
"""防澄清螺旋守卫（0.10.1 验收 B-8）单测。

背景：MiniMax 验收 B-8——长会话里模型连环弹 ask 确认卡、任务无推进。
守卫：_build_messages 检测近 6 条历史里 ≥2 条含 ```ask 的 assistant 消息时，
在用户消息前注入一条禁止再 ask 的 system 强提示。
"""
import pytest

from core.agent_loop import AgentLoop


def _loop():
    return AgentLoop(None, None)


def _build(history, message="继续"):
    return _loop()._build_messages(message, "SYS", history, None)


ASK1 = "需要确认\n```ask\n{\"question\": \"内容来源?\", \"options\": []}\n```"
PLAIN = "好的，这是结果。"


def test_guard_fires_on_two_recent_ask_cards():
    history = [
        {"role": "user", "content": "做个PPT"},
        {"role": "assistant", "content": ASK1},
        {"role": "user", "content": "自己定"},
        {"role": "assistant", "content": ASK1},
        {"role": "user", "content": "继续"},
    ]
    msgs = _build(history)
    # system(0) + 5 history + guard + user
    assert msgs[-1]["role"] == "user"
    assert any(m["role"] == "system" and "禁止再输出 ask" in m["content"]
               for m in msgs[1:-1])


def test_guard_silent_when_single_ask():
    history = [
        {"role": "user", "content": "做个PPT"},
        {"role": "assistant", "content": ASK1},
        {"role": "user", "content": "自己定"},
    ]
    msgs = _build(history)
    assert not any(m["role"] == "system" for m in msgs[1:-1])


def test_guard_silent_without_ask():
    history = [
        {"role": "user", "content": "你好"},
        {"role": "assistant", "content": PLAIN},
    ]
    msgs = _build(history)
    assert msgs[-1]["role"] == "user"
    assert not any(m["role"] == "system" for m in msgs[1:-1])


def test_guard_only_counts_recent_window():
    # 两张 ask 卡但在 6 条窗口之外 → 不触发
    history = [
        {"role": "user", "content": "做个PPT"},
        {"role": "assistant", "content": ASK1},
        {"role": "user", "content": "自己定"},
        {"role": "assistant", "content": ASK1},
        {"role": "user", "content": "继续"},
        {"role": "assistant", "content": PLAIN},
        {"role": "user", "content": "再看看"},
        {"role": "assistant", "content": PLAIN},
    ]
    msgs = _build(history, "再来")
    assert not any(m["role"] == "system" for m in msgs[1:-1])
