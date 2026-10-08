# -*- coding: utf-8 -*-
"""F8：会话事实保底条款测试（sidemate-dev#13）

- 在线 agent prompt 含「用户亲述信息永远可信可复述；不编造只约束没出现过的信息」
- 离线车道零改动（复用 test_f2f9 的快照哈希逻辑钉死）
"""
import hashlib

import pytest


def _patch_cfg(monkeypatch, mode):
    import config as _cfg
    monkeypatch.setattr(_cfg, "get", lambda k, d=None: mode if k == "ai_mode" else d)


class TestF8SessionFactsClause:
    def test_agent_prompt_contains_clause(self, monkeypatch):
        import core.agent_tools as at
        _patch_cfg(monkeypatch, "cloud")
        _, prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None, history=None)
        assert "永远可信、可复述" in prompt, "缺 F8 保底条款（亲述信息可信）"
        assert "只约束本会话中没出现过的信息" in prompt, "缺「不编造」边界条款"
        assert "工位、口令、编号" in prompt

    def test_offline_lane_unchanged(self, monkeypatch):
        """离线车道不加此条款（F8 证据全在线；离线 prompt 改动需单独确认）。"""
        _patch_cfg(monkeypatch, "local")
        from core.prompt_builder import PromptBuilder
        pb = PromptBuilder.__new__(PromptBuilder)
        p = pb._build_system_prompt(kb_mode=False, strategy_name=None,
                                    context_cache=None, kb_context=None)
        got = hashlib.sha256(p.encode("utf-8")).hexdigest()
        assert got == "4d0d25661b8c677c4cf764fcfd45d57bab6dde37d25fa5cdb6b34b80fee1aa46", \
            f"离线 prompt 被改动：{got}"
        assert "永远可信、可复述" not in p
