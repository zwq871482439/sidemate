# -*- coding: utf-8 -*-
"""在线模型服务 v2 物化测试（sidemate-dev#9，先红后绿）

覆盖：
- 切到未填 Key 的服务商 → cloud_api_key 必须清空（不残留上一家的 Key，
  否则旧 Key 会随请求头发到新服务商的 base_url——跨主机密钥外泄面）
- 模型 ctx=0（按模型自动）→ cloud_context_window 复位为 0，
  不残留上一个模型的手动窗口
- thinking 空 = 不改当前档（文档化设计，回归护栏）

config 读写全部 monkeypatch 到内存 store，不碰真实 settings.json。
"""
import pytest

from core import cloud_providers as cp
from core.cloud_engine import CloudEngine


class _Store:
    """config.get / save_config 的内存替身，记录每次写入。"""

    def __init__(self, initial=None):
        self.d = dict(initial or {})
        self.writes = []

    def get(self, k, d=None):
        return self.d.get(k, d)

    def save(self, upd):
        self.writes.append(dict(upd))
        self.d.update(upd)


@pytest.fixture()
def store(monkeypatch):
    s = _Store()
    import config as _cfg
    monkeypatch.setattr(_cfg, "get", s.get)
    monkeypatch.setattr(_cfg, "save_config", s.save)
    return s


def _pv(pid, name, base, key="", models=None):
    return {"id": pid, "name": name, "base_url": base, "api_format": "openai",
            "proxy_mode": "system", "api_key": CloudEngine._encode_api_key(key) if key else "",
            "models": models or []}


def _m(mid, model, ctx=0, thinking=""):
    return {"id": mid, "model": model, "label": "", "tag": "", "thinking": thinking, "ctx": ctx}


class TestMaterializeKeyIsolation:
    def test_switch_to_keyless_provider_clears_key(self, store, monkeypatch):
        """A 有 Key → 物化出 A 的 Key；切到无 Key 的 B → cloud_api_key 必须是空串。"""
        monkeypatch.setattr(cp, "_reset_engine_client", lambda: None)
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "ProviderA", "https://a.example.com", key="sk-aaa", models=[_m("m-a", "model-a")]),
            _pv("pv-b", "ProviderB", "https://b.example.com", key="", models=[_m("m-b", "model-b")]),
        ]
        assert cp.select("pv-a", "m-a")["ok"] is True
        assert store.d["cloud_api_key"] == CloudEngine._encode_api_key("sk-aaa")

        r = cp.select("pv-b", "m-b")
        assert r["ok"] is True, r
        # 红点：现实现只在目标服务商有 Key 时才写 cloud_api_key，
        # 切到无 Key 的 B 后残留 A 的 Key → 随请求头发到 b.example.com
        assert store.d["cloud_api_key"] == "", "切到未填 Key 的服务商后必须清空 cloud_api_key"
        assert store.d["cloud_base_url"] == "https://b.example.com"

    def test_switch_between_keyed_providers_overwrites(self, store, monkeypatch):
        """两家都有 Key → 物化值必须是目标服务商的，不是叠加或保留旧值。"""
        monkeypatch.setattr(cp, "_reset_engine_client", lambda: None)
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "ProviderA", "https://a.example.com", key="sk-aaa", models=[_m("m-a", "model-a")]),
            _pv("pv-b", "ProviderB", "https://b.example.com", key="sk-bbb", models=[_m("m-b", "model-b")]),
        ]
        cp.select("pv-a", "m-a")
        cp.select("pv-b", "m-b")
        assert store.d["cloud_api_key"] == CloudEngine._encode_api_key("sk-bbb")


class TestMaterializeContextWindow:
    def test_ctx0_resets_window_to_auto(self, store, monkeypatch):
        """X ctx=131072 → Y ctx=0（自动）：窗口必须复位 0，不能残留 131072。"""
        monkeypatch.setattr(cp, "_reset_engine_client", lambda: None)
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "ProviderA", "https://a.example.com", key="sk-a",
                models=[_m("m-x", "model-x", ctx=131072), _m("m-y", "model-y", ctx=0)]),
        ]
        cp.select("pv-a", "m-x")
        assert store.d["cloud_context_window"] == 131072

        r = cp.select("pv-a", "m-y")
        assert r["ok"] is True, r
        # 红点：现实现 ctx=0 时不写 cloud_context_window → 残留 131072
        assert store.d["cloud_context_window"] == 0, "ctx=0（按模型自动）必须复位 cloud_context_window"

    def test_ctx_explicit_overwrites(self, store, monkeypatch):
        monkeypatch.setattr(cp, "_reset_engine_client", lambda: None)
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "ProviderA", "https://a.example.com", key="sk-a",
                models=[_m("m-x", "model-x", ctx=8192), _m("m-y", "model-y", ctx=65536)]),
        ]
        cp.select("pv-a", "m-x")
        cp.select("pv-a", "m-y")
        assert store.d["cloud_context_window"] == 65536


class TestMaterializeThinkingSemantics:
    def test_empty_thinking_keeps_current_level(self, store, monkeypatch):
        """thinking 空 = 不改当前档（docstring 文档化行为，回归护栏）。"""
        monkeypatch.setattr(cp, "_reset_engine_client", lambda: None)
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "ProviderA", "https://a.example.com", key="sk-a",
                models=[_m("m-x", "model-x", thinking="off"), _m("m-y", "model-y", thinking="")]),
        ]
        store.d["cloud_thinking_level"] = "high"  # 全局当前档
        cp.select("pv-a", "m-x")
        assert store.d["cloud_thinking_level"] == "off"
        cp.select("pv-a", "m-y")
        assert store.d["cloud_thinking_level"] == "off", "thinking 空不改当前档（沿用切换前的值）"
