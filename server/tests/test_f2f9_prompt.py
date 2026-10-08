# -*- coding: utf-8 -*-
"""F2+F9：在线能力声明对称补齐 + 输出格式纪律（sidemate-dev#5，先红后绿）

F2：在线版能力声明缺「当前是在线模式」（离线版有对称句），U6 第 1 轮
    问部署方式模型答「不确定」。落点三处：prompts._CAPABILITIES_CLOUD、
    prompt_builder 在线分支的同步拷贝、在线 agent 的 _AGENT_BASE_PROMPT
    （U6 实际命中的车道）。
F9：用户限定输出格式时模型仍多解释/加粗/自报字数/改标题。纪律条款进
    在线 agent 规则区 + ask 规则联动（限定格式时本轮不出 ask 卡）。

红线：离线车道 prompt 逐字不变——快照哈希护栏钉死。
"""
import hashlib

import pytest


def _patch_cfg(monkeypatch, mode):
    import config as _cfg
    monkeypatch.setattr(_cfg, "get", lambda k, d=None: mode if k == "ai_mode" else d)


class TestF2OnlineModeDeclaration:
    def test_capabilities_cloud_declares_mode(self):
        from prompts import _CAPABILITIES_CLOUD
        assert "当前是**在线模式**（连接云端大模型），支持联网搜索" in _CAPABILITIES_CLOUD

    def test_prompt_builder_cloud_branch(self, monkeypatch):
        _patch_cfg(monkeypatch, "cloud")
        from core.prompt_builder import PromptBuilder
        pb = PromptBuilder.__new__(PromptBuilder)
        p = pb._build_system_prompt(kb_mode=False, strategy_name=None,
                                    context_cache=None, kb_context=None)
        assert "当前是**在线模式**（连接云端大模型），支持联网搜索" in p

    def test_agent_base_prompt_declares_mode(self, monkeypatch):
        """U6 实际命中在线 agent 车道——模式声明必须在 _AGENT_BASE_PROMPT。"""
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None, history=None)
        assert "当前是**在线模式**（连接云端大模型）" in prompt
        assert "支持联网搜索" in prompt


class TestF9FormatDiscipline:
    def test_agent_prompt_has_format_discipline(self, monkeypatch):
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None, history=None)
        assert "用户限定回复格式时" in prompt
        assert "不追加解释、免责声明、备选方案" in prompt
        assert "不自报字数" in prompt

    def test_ask_rule_suppressed_under_format_constraint(self, monkeypatch):
        """F5 联动：用户已限定输出格式时本轮不出 ask 卡（ask 规则区）。"""
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None, history=None)
        assert "用户已限定输出格式时" in prompt
        assert "本轮不输出 ask 块" in prompt


class TestOfflineLaneUnchanged:
    """红线：离线车道逐字不变（哈希快照 = main 修改前实测值）。"""

    HASH = "4d0d25661b8c677c4cf764fcfd45d57bab6dde37d25fa5cdb6b34b80fee1aa46"

    def test_offline_prompt_snapshot(self, monkeypatch):
        _patch_cfg(monkeypatch, "local")
        from core.prompt_builder import PromptBuilder
        pb = PromptBuilder.__new__(PromptBuilder)
        p = pb._build_system_prompt(kb_mode=False, strategy_name=None,
                                    context_cache=None, kb_context=None)
        got = hashlib.sha256(p.encode("utf-8")).hexdigest()
        assert got == self.HASH, f"离线 prompt 被改动：{got}"
        assert "在线模式" not in p, "离线车道不得混入在线声明"
        assert "只回 X" not in p, "离线车道不得混入 F9 条款"

    def test_offline_capabilities_untouched(self):
        from prompts import _CAPABILITIES_LOCAL
        assert _CAPABILITIES_LOCAL == ("你的真实能力：对话问答、知识库检索问答、生成Word文档(.docx)。"
                                       "当前是离线模式，不支持联网搜索。")
