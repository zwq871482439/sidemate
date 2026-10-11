# -*- coding: utf-8 -*-
"""G6 D10（0.11.1）：记忆系统整体下线——先红后绿。

0.11.1 G6 #13/#7 决议：记忆功能（会话记忆/长期记忆/记忆确认卡）暂时下线，
0.12 重新设计。下线面（config.memory_enabled=False 默认）：
1. 卡片协议 prompt 不含记忆确认卡段（MEMORY_CARD_PROMPT 不拼接）
2. save_memory / recall_memory 不进工具注册表（LLM 看不到）
3. save_memory 直调被拒（memory_disabled 兜底）
4. 旧会话遗留 memory.md 不再注入 system prompt（inject_hint 关门）
5. 开关打开（0.12 重新启用）时上述能力完整恢复
"""
import json
import os

import pytest


@pytest.fixture()
def env(tmp_path, monkeypatch):
    chats = tmp_path / "chats"
    (chats / "c1").mkdir(parents=True)
    (chats / "c1" / "meta.json").write_text("{}", encoding="utf-8")
    data = tmp_path / "data"
    data.mkdir()
    import config
    monkeypatch.setattr(config, "DATA_DIR", str(data))
    from session import chat_store
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(chats))
    import session.projects as projects
    monkeypatch.setattr(projects, "resolve_chat_project", lambda chat_id: None)
    return {"chats": chats, "data": data, "mem": data / "memory" / "c1.md"}


def _set_memory_enabled(monkeypatch, enabled):
    import config
    cache = dict(config._config_cache)
    cache["memory_enabled"] = enabled
    monkeypatch.setattr(config, "_config_cache", cache)


class TestTakedownDefaults:
    def test_default_off(self):
        import config
        assert config.DEFAULTS.get("memory_enabled") is False

    def test_card_prompt_has_no_memory_section_when_off(self):
        from prompts import card_protocol_prompt, CARD_PROTOCOL_PROMPT
        p = card_protocol_prompt()
        assert "可视化卡片" in p          # 卡片协议本体仍在
        assert "记忆确认卡" not in p      # 记忆段不拼接
        assert "memory_save" not in p
        assert "同意写入" not in p
        # 本体常量也不含（防止其它消费方直接 import 常量时带出）
        assert "记忆确认卡" not in CARD_PROTOCOL_PROMPT

    def test_card_prompt_restores_memory_section_when_on(self, monkeypatch):
        _set_memory_enabled(monkeypatch, True)
        from prompts import card_protocol_prompt
        p = card_protocol_prompt()
        assert "记忆确认卡" in p
        assert '["同意写入", "不用记"]' in p


class TestTakedownTools:
    def test_memory_tools_not_registered_when_off(self, env):
        import core.agent_tools as at
        tools, _prompt = at.get_tools_and_prompt(mode="chat", chat_id="c1")
        names = [t["function"]["name"] for t in tools]
        assert "save_memory" not in names
        assert "recall_memory" not in names

    def test_memory_tools_registered_when_on(self, env, monkeypatch):
        _set_memory_enabled(monkeypatch, True)
        import core.agent_tools as at
        tools, _prompt = at.get_tools_and_prompt(mode="chat", chat_id="c1")
        names = [t["function"]["name"] for t in tools]
        assert "save_memory" in names
        assert "recall_memory" in names

    def test_save_memory_direct_call_refused(self, env):
        from core.agent_loop import AgentLoop
        r = AgentLoop(None, None, chat_id="c1")._execute_tool(
            "save_memory", {"section": "偏好", "text": "x"}, {})
        assert r["success"] is False
        assert r.get("error") == "memory_disabled"
        assert "已下线" in r.get("message", "")

    def test_recall_memory_direct_call_refused(self, env):
        from core.agent_loop import AgentLoop
        r = AgentLoop(None, None, chat_id="c1")._execute_tool(
            "recall_memory", {"query": "偏好"}, {})
        assert r["success"] is False
        assert r.get("error") == "memory_disabled"


class TestTakedownInjection:
    def test_existing_memory_file_not_injected_when_off(self, env):
        # 旧会话遗留 memory.md（含偏好条目）——下线后不得注入
        env["mem"].parent.mkdir(parents=True, exist_ok=True)
        env["mem"].write_text(
            "# 记忆\n\n## 偏好\n\n- 周报放在周一上午\n", encoding="utf-8")
        from core.curated_memory import inject_hint
        assert inject_hint("c1") == ""

    def test_existing_memory_file_injected_when_on(self, env, monkeypatch):
        env["mem"].parent.mkdir(parents=True, exist_ok=True)
        env["mem"].write_text(
            "# 记忆\n\n## 偏好\n\n- 周报放在周一上午\n", encoding="utf-8")
        _set_memory_enabled(monkeypatch, True)
        from core.curated_memory import inject_hint
        out = inject_hint("c1")
        assert "长期记忆" in out
        assert "周报放在周一上午" in out
