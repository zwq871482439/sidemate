# -*- coding: utf-8 -*-
"""0.10 M1-1 思考档位单测：三接口传参分发 + high 不传参 + 400 判定。

不 import server（看门狗）；monkeypatch cloud_engine._cfg 控制档位与格式。
"""
import pytest

import core.cloud_engine as ce
from core.cloud_engine import CloudEngine


@pytest.fixture()
def env(monkeypatch):
    """返回 setter：env(level, api_format, model, base_url) → 覆盖 _cfg 视图"""
    state = {"cloud_thinking_level": "high", "cloud_api_format": "openai",
             "cloud_base_url": "https://api.openai.com/v1"}
    orig = ce._cfg

    def fake_get(key, default=None):
        return state.get(key, default if default is not None else (orig(key, default) if default else None))

    monkeypatch.setattr(ce, "_cfg", fake_get)
    return state


class TestThinkingKwargs:
    def test_high_no_params(self, env):
        env.update(cloud_thinking_level="high")
        assert CloudEngine._thinking_kwargs("any-model") == {}

    def test_deepseek_off(self, env):
        env.update(cloud_thinking_level="off")
        assert CloudEngine._thinking_kwargs("deepseek-v4-flash") == {"thinking": {"type": "disabled"}}

    def test_deepseek_by_base_url(self, env):
        env.update(cloud_thinking_level="off", cloud_base_url="https://api.deepseek.com")
        kw = CloudEngine._thinking_kwargs("whatever")
        assert kw == {"thinking": {"type": "disabled"}}

    def test_deepseek_low_maps_enabled(self, env):
        env.update(cloud_thinking_level="low")
        assert CloudEngine._thinking_kwargs("deepseek-v4-flash") == {"thinking": {"type": "enabled"}}

    def test_openai_low(self, env):
        env.update(cloud_thinking_level="low")
        assert CloudEngine._thinking_kwargs("gpt-5.1") == \
            {"reasoning": {"effort": "low"}, "reasoning_effort": "low"}

    def test_openai_off_minimal(self, env):
        env.update(cloud_thinking_level="off")
        kw = CloudEngine._thinking_kwargs("o7")
        assert kw["reasoning"]["effort"] == "minimal"
        assert kw["reasoning_effort"] == "minimal"

    def test_anthropic_low_budget1024(self, env):
        env.update(cloud_thinking_level="low", cloud_api_format="anthropic")
        kw = CloudEngine._thinking_kwargs("claude-sonnet-5")
        assert kw == {"thinking": {"type": "enabled", "budget_tokens": 1024}}

    def test_anthropic_high_empty(self, env):
        env.update(cloud_thinking_level="high", cloud_api_format="anthropic")
        assert CloudEngine._thinking_kwargs("claude-sonnet-5") == {}

    def test_is_param_reject(self):
        class E400(Exception):
            status_code = 400
        assert CloudEngine._is_param_reject(E400()) is True
        assert CloudEngine._is_param_reject(Exception("400 invalid_request_error")) is True
        assert CloudEngine._is_param_reject(Exception("unknown field: thinking")) is True
        assert CloudEngine._is_param_reject(Exception("connection reset by peer")) is False
