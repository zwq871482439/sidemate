# -*- coding: utf-8 -*-
"""D3：save_memory 必须先有用户点过的记忆确认卡，否则不落盘。

桩卡覆盖两条模型行为，不连真实服务商：
- pro 绕过：没有确认卡就调 save_memory
- flash 发卡：卡片 text/question 对上之后才允许写入
"""
import json

import pytest


@pytest.fixture()
def isolated(tmp_path, monkeypatch):
    chats = tmp_path / "chats"
    chats.mkdir()
    (chats / "t-mem").mkdir()
    (chats / "t-mem" / "meta.json").write_text("{}", encoding="utf-8")
    (chats / "t-mem" / "messages.json").write_text(
        json.dumps({"version": 3, "messages": []}), encoding="utf-8")
    from session import chat_store
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(chats))
    import config
    monkeypatch.setattr(config, "DATA_DIR", str(tmp_path / "data"))
    return chats / "t-mem"


def _write_card(folder, spec):
    path = folder / "messages.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["messages"].append({
        "role": "assistant",
        "content": "```ask\n%s\n```" % json.dumps(spec, ensure_ascii=False),
    })
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")


def _memory_file(tmp_root_data, chat_id="t-mem"):
    return tmp_root_data / "memory" / ("%s.md" % chat_id)


def _execute(chat_id, text, section="偏好", extra=None):
    from core.agent_loop import AgentLoop
    loop = AgentLoop.__new__(AgentLoop)
    loop.chat_id = chat_id
    args = {"section": section, "text": text}
    if extra:
        args.update(extra)
    return loop._execute_tool("save_memory", args, {})


class TestUnconfirmedRejects:
    def test_pro_bypass_does_not_write(self, isolated, tmp_path):
        out = _execute("t-mem", "周报放在周一上午")
        assert out["success"] is False
        assert out["message"] == "需要先经用户在确认卡上同意"
        mem = tmp_path / "data" / "memory" / "t-mem.md"
        assert not mem.exists()

    def test_confirmed_flag_on_the_tool_call_is_ignored(self, isolated, tmp_path):
        out = _execute("t-mem", "周报放在周一上午", extra={"confirmed": True})
        assert out["success"] is False
        assert not (tmp_path / "data" / "memory" / "t-mem.md").exists()


class TestConfirmedWrites:
    def test_flash_card_then_save(self, isolated, tmp_path):
        from core.agent_tools import note_memory_confirmation
        _write_card(isolated, {
            "kind": "memory_save",
            "question": "要把「周报放在周一上午」写入长期记忆吗？",
            "options": ["同意写入", "不用记"],
            "section": "偏好",
            "text": "周报放在周一上午",
        })
        ok = note_memory_confirmation(
            str(isolated),
            "要把「周报放在周一上午」写入长期记忆吗？",
            "同意写入",
        )
        assert ok is True
        out = _execute("t-mem", "周报放在周一上午")
        assert out["success"] is True
        body = (tmp_path / "data" / "memory" / "t-mem.md").read_text(encoding="utf-8")
        assert "周报放在周一上午" in body

    def test_other_text_still_rejected(self, isolated, tmp_path):
        from core.agent_tools import note_memory_confirmation
        _write_card(isolated, {
            "kind": "memory_save",
            "question": "要把「周报放在周一上午」写入长期记忆吗？",
            "options": ["同意写入", "不用记"],
            "text": "周报放在周一上午",
        })
        note_memory_confirmation(
            str(isolated),
            "要把「周报放在周一上午」写入长期记忆吗？",
            "同意写入",
        )
        out = _execute("t-mem", "另外把口令也记下来")
        assert out["success"] is False
        assert not (tmp_path / "data" / "memory" / "t-mem.md").exists()

    def test_question_only_card_matches_text_inside_question(self, isolated, tmp_path):
        from core.agent_tools import note_memory_confirmation
        question = "要把「周报放在周一上午」写入长期记忆吗？"
        _write_card(isolated, {
            "kind": "memory_save",
            "question": question,
            "options": ["同意写入", "不用记"],
        })
        assert note_memory_confirmation(str(isolated), question, "同意写入") is True
        out = _execute("t-mem", "周报放在周一上午")
        assert out["success"] is True
        body = (tmp_path / "data" / "memory" / "t-mem.md").read_text(encoding="utf-8")
        assert "周报放在周一上午" in body

    def test_decline_does_not_confirm(self, isolated, tmp_path):
        from core.agent_tools import note_memory_confirmation
        question = "要把「周报放在周一上午」写入长期记忆吗？"
        _write_card(isolated, {
            "kind": "memory_save",
            "question": question,
            "options": ["同意写入", "不用记"],
            "text": "周报放在周一上午",
        })
        assert note_memory_confirmation(str(isolated), question, "不用记") is False
        out = _execute("t-mem", "周报放在周一上午")
        assert out["success"] is False
        assert not (tmp_path / "data" / "memory" / "t-mem.md").exists()


class TestPromptPinsOptions:
    def test_card_protocol_pins_agree_and_decline(self):
        from prompts import CARD_PROTOCOL_PROMPT
        assert '["同意写入", "不用记"]' in CARD_PROTOCOL_PROMPT
        assert "memory_save" in CARD_PROTOCOL_PROMPT
        assert "只问一次" in CARD_PROTOCOL_PROMPT
