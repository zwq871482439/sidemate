# -*- coding: utf-8 -*-
"""#41 D4：记忆卡「同意写入」后的落盘执行与诚实性约束。

统计背景（#43 派活⑭，10 次×3 模型）：同意后真正写入 4–7/10、谎称已记住 3 次。
本文件锁定两层提示约束：
1. 同意回执注入带记忆原文的 save_memory 工具指令（_memory_accept_note）；
2. 系统 prompt 含「未成功不得声称已记住」的诚实性约束。
"""
import pytest


class TestMemoryAcceptNote:
    def test_note_contains_memory_text_verbatim(self):
        from routers.chat import _memory_accept_note
        note = _memory_accept_note("要把这条写进长期记忆吗：周报放在周一上午 09:36")
        assert "周报放在周一上午 09:36" in note

    def test_note_demands_save_memory_tool_call(self):
        from routers.chat import _memory_accept_note
        note = _memory_accept_note("要将记忆写入吗：偏好深色主题")
        assert "save_memory" in note
        assert "不要再发确认卡" in note

    def test_note_forbids_claiming_saved_before_success(self):
        from routers.chat import _memory_accept_note
        note = _memory_accept_note("要将记忆写入吗：偏好深色主题")
        assert "已记住" in note
        assert "未写入时声称已记住" in note

    def test_note_handles_empty_question(self):
        from routers.chat import _memory_accept_note
        assert isinstance(_memory_accept_note(""), str) and "save_memory" in _memory_accept_note("")


class TestAcceptDetectionUnchanged:
    def test_accept_still_requires_protocol_answer(self):
        from routers.chat import _is_memory_card_accept
        assert _is_memory_card_accept("要记住这条记忆吗：X", "同意写入") is True
        assert _is_memory_card_accept("要记住这条记忆吗：X", "同意，执行写入") is False
        assert _is_memory_card_accept("要记住这条记忆吗：X", "不用记") is False
        assert _is_memory_card_accept("普通问题？", "同意写入") is False


class TestPromptHonestyConstraint:
    def test_online_prompt_contains_followthrough_rule(self):
        from prompts import CARD_PROTOCOL_PROMPT
        assert "save_memory" in CARD_PROTOCOL_PROMPT
        assert "严禁对用户说「已记住/已记录/已写入」" in CARD_PROTOCOL_PROMPT
