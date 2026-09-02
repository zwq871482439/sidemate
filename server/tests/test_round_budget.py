# -*- coding: utf-8 -*-
"""0.10.1 轮次预算用户可调（PLAN 四章）测试：get_max_rounds 读 config.agent_max_rounds，
默认 26，范围 8~100，非法/留空回落默认。"""

from core.agent_loop import get_max_rounds, MAX_ROUNDS


class TestRoundBudget:
    def test_default(self, monkeypatch):
        monkeypatch.setattr('config.get', lambda k, d=None: d, raising=True)
        assert get_max_rounds() == 26

    def test_valid_override(self, monkeypatch):
        monkeypatch.setattr('config.get', lambda k, d=None: 40, raising=True)
        assert get_max_rounds() == 40

    def test_clamp_range(self, monkeypatch):
        monkeypatch.setattr('config.get', lambda k, d=None: 5, raising=True)
        assert get_max_rounds() == MAX_ROUNDS  # 低于 8 回落
        monkeypatch.setattr('config.get', lambda k, d=None: 500, raising=True)
        assert get_max_rounds() == MAX_ROUNDS  # 高于 100 回落

    def test_invalid_type_fallback(self, monkeypatch):
        monkeypatch.setattr('config.get', lambda k, d=None: 'abc', raising=True)
        assert get_max_rounds() == MAX_ROUNDS

    def test_config_error_fallback(self, monkeypatch):
        def _boom(k, d=None):
            raise RuntimeError('config gone')
        monkeypatch.setattr('config.get', _boom, raising=True)
        assert get_max_rounds() == MAX_ROUNDS
