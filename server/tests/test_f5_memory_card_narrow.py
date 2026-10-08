# -*- coding: utf-8 -*-
"""F5：记忆确认卡触发收窄（sidemate-dev#12，先红后绿）

方案 A（PM 已拍板）三层落地：
1. prompt 收窄：只对跨会话有价值的长期事实问；同会话同类只问一次
   （save_memory 工具描述 + 卡片协议 ask 规则）
2. 确定性兜底：用户点过「不用记」→ 会话 meta 记 memory_declined，
   之后每轮在线 prompt 注入「本会话不再询问记忆写入」强约束
3. 判定入口：chat 路由识别记忆卡否定回答并落 meta 标记

离线车道 prompt 零改动（哈希护栏沿用 test_f8 的钉死值）。
"""
import hashlib
import json
import os

import pytest


def _patch_cfg(monkeypatch, mode):
    import config as _cfg
    monkeypatch.setattr(_cfg, "get", lambda k, d=None: mode if k == "ai_mode" else d)


@pytest.fixture()
def chatdir(tmp_path, monkeypatch):
    """临时 CHAT_DIR，含一个已拒绝记忆写入的会话 t-declined。"""
    d = tmp_path / "chats"
    d.mkdir()
    (d / "t-declined").mkdir()
    (d / "t-declined" / "meta.json").write_text(
        json.dumps({"memory_declined": True}), encoding="utf-8")
    (d / "t-fresh").mkdir()
    (d / "t-fresh" / "meta.json").write_text(json.dumps({}), encoding="utf-8")
    from session import chat_store
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(d))
    return d


class TestDeclinedSessionConstraint:
    def test_declined_meta_injects_no_ask_constraint(self, monkeypatch, chatdir):
        """验收标准①：meta 记录「已拒绝」后，下一轮拼出的 prompt 含
        「本会话不再询问记忆写入」类约束。旧实现无此注入 → 红。"""
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None,
                                            chat_id="t-declined", history=None)
        # meta 注入块（与卡片协议里的普适措辞区分开，断言专属标记）
        assert "用户已在本会话明确拒绝过长期记忆写入" in prompt, \
            "已拒绝会话的 prompt 缺少 meta 注入的强约束块"
        assert "本会话不再询问记忆写入" in prompt
        assert "save_memory" in prompt or "长期记忆" in prompt

    def test_fresh_session_no_constraint(self, monkeypatch, chatdir):
        """未拒绝的会话不注入该约束（正常记忆卡流程不受影响）。"""
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None,
                                            chat_id="t-fresh", history=None)
        assert "用户已在本会话明确拒绝过长期记忆写入" not in prompt

    def test_no_chat_id_no_crash(self, monkeypatch):
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None,
                                            chat_id=None, history=None)
        assert "用户已在本会话明确拒绝过长期记忆写入" not in prompt


class TestPromptNarrowing:
    def test_save_memory_tool_description_narrowed(self, monkeypatch):
        """验收：记忆工具描述含收窄条件（长期事实 + 同类一次 + 拒绝后不问）。"""
        import core.agent_tools as at
        desc = at.TOOL_REGISTRY["save_memory"]["schema"]["function"]["description"]
        assert "长期事实" in desc, "save_memory 描述缺「长期事实」限定"
        assert "只问一次" in desc, "save_memory 描述缺「同类只问一次」"
        assert "不再询问" in desc or "不再问" in desc, "save_memory 描述缺「拒绝后不再问」"

    def test_card_protocol_ask_rule_narrowed(self):
        """卡片协议 ask 规则含记忆卡专项约束。"""
        from prompts import CARD_PROTOCOL_PROMPT
        assert "memory_save" in CARD_PROTOCOL_PROMPT, "ask 规则缺记忆卡专项条款"
        assert "只问一次" in CARD_PROTOCOL_PROMPT


class TestDeclineDetection:
    """chat 路由的记忆卡否定回答判定（_is_memory_card_decline）。"""

    def test_matrix(self):
        from routers.chat import _is_memory_card_decline as f
        # 记忆卡问题 + 否定回答 → True
        assert f("要把这条偏好写入长期记忆吗？", "不用记")
        assert f("要把这条偏好写入长期记忆吗？", "取消")
        assert f("是否记入长期记忆？", "暂不")
        assert f("是否记入长期记忆？", "不要")
        assert f("是否记入长期记忆？", "不")
        # 记忆卡问题 + 肯定回答 → False
        assert not f("要把这条偏好写入长期记忆吗？", "记住")
        assert not f("要把这条偏好写入长期记忆吗？", "确认")
        # 非记忆卡问题 + 否定回答 → False（不能误伤其它 ask 卡）
        assert not f("要执行这个计划吗？", "取消")
        assert not f("选择哪个方案？", "先不用方案B")


class TestMetaFlagWrite:
    def test_set_chat_meta_flag_merges(self, chatdir):
        from session.chat_store import set_chat_meta_flag, read_meta
        # 传会话文件夹路径
        ok = set_chat_meta_flag(str(chatdir / "t-fresh"), "memory_declined", True)
        assert ok is True
        m = read_meta("t-fresh")
        assert m.get("memory_declined") is True
        # 已有字段不被覆盖
        (chatdir / "t-fresh" / "meta.json").write_text(
            json.dumps({"title": "xx"}), encoding="utf-8")
        set_chat_meta_flag(str(chatdir / "t-fresh"), "memory_declined", True)
        m = read_meta("t-fresh")
        assert m.get("title") == "xx" and m.get("memory_declined") is True

    def test_set_flag_on_messages_json_path(self, chatdir):
        """chat.py 手里常是 messages.json 的路径——要能落到同目录 meta。"""
        from session.chat_store import set_chat_meta_flag, read_meta
        ok = set_chat_meta_flag(str(chatdir / "t-declined" / "messages.json"),
                                "memory_declined", True)
        assert ok is True
        assert read_meta("t-declined").get("memory_declined") is True


class TestOfflineLaneUnchanged:
    def test_offline_prompt_hash(self, monkeypatch):
        """离线车道零改动（沿用 F8 的钉死哈希）。"""
        _patch_cfg(monkeypatch, "local")
        from core.prompt_builder import PromptBuilder
        pb = PromptBuilder.__new__(PromptBuilder)
        p = pb._build_system_prompt(kb_mode=False, strategy_name=None,
                                    context_cache=None, kb_context=None)
        got = hashlib.sha256(p.encode("utf-8")).hexdigest()
        assert got == "4d0d25661b8c677c4cf764fcfd45d57bab6dde37d25fa5cdb6b34b80fee1aa46", \
            f"离线 prompt 被改动：{got}"
