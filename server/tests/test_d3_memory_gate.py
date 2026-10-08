# -*- coding: utf-8 -*-
"""#41 D3：save_memory 没有用户确认记录时不得落盘。"""
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
    mem = data / "memory" / "c1.md"
    return {"chats": chats, "mem": mem, "chat_file": str(chats / "c1")}


def _loop():
    from core.agent_loop import AgentLoop
    return AgentLoop(None, None, chat_id="c1")


def _save(text="周报放在周一上午"):
    return _loop()._execute_tool(
        "save_memory", {"section": "偏好", "text": text}, {})


class TestSaveMemoryGate:
    def test_unconfirmed_refuses_and_does_not_write(self, env):
        result = _save()
        assert result["success"] is False
        assert "需要先经用户在确认卡上同意" in result["message"]
        assert not os.path.exists(env["mem"])

    def test_confirmed_text_is_written(self, env):
        from session.chat_store import append_memory_confirmation
        question = "记住：周报放在周一上午"
        assert append_memory_confirmation(env["chat_file"], question) is True
        result = _save()
        assert result["success"] is True, result
        body = env["mem"].read_text(encoding="utf-8")
        assert "周报放在周一上午" in body

    def test_unrelated_confirmation_still_refuses(self, env):
        from session.chat_store import append_memory_confirmation
        append_memory_confirmation(env["chat_file"], "记住：喜欢周五下午开会")
        result = _save()
        assert result["success"] is False
        assert not os.path.exists(env["mem"])


class TestAcceptRecordsConfirmation:
    def test_agree_option_is_accept_decline_is_not(self):
        from routers.chat import _is_memory_card_accept, _is_memory_card_decline
        q = "要把「周报放在周一上午」写入长期记忆吗？"
        assert _is_memory_card_accept(q, "同意写入")
        assert not _is_memory_card_accept(q, "不用记")
        assert _is_memory_card_decline(q, "不用记")
        assert not _is_memory_card_accept("要执行这个计划吗？", "同意写入")

    def test_prompt_pins_option_text(self):
        from prompts import CARD_PROTOCOL_PROMPT
        assert '["同意写入", "不用记"]' in CARD_PROTOCOL_PROMPT
