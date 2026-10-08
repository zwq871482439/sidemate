# -*- coding: utf-8 -*-
"""#26（sidemate-dev）：agentRouting 提示改读在线模型服务 v2。

旧实现读 v1 cloud_profiles——v2 上线后用户配置的快/强模型进不了提示
（0.11.0 功能被静默关掉）。验收：两服务商一快一强 → 提示含两个模型名
与对应建议、激活模型正确、入口是顶栏模型选择器；可用模型 <2 → 空串。
"""
import pytest


class _Store:
    def __init__(self, initial=None):
        self.d = dict(initial or {})

    def get(self, k, d=None):
        return self.d.get(k, d)

    def save(self, upd):
        self.d.update(upd)


@pytest.fixture()
def store(monkeypatch):
    import config as _cfg
    from core import cloud_providers as _cp
    s = _Store()
    monkeypatch.setattr(_cfg, "get", s.get)
    monkeypatch.setattr(_cfg, "save_config", s.save)
    monkeypatch.setattr(_cp, "_reset_engine_client", lambda: None)
    return s


def _pv(pid, name, key, models):
    from core.cloud_engine import CloudEngine
    return {"id": pid, "name": name, "base_url": "https://%s.example.com" % pid,
            "api_format": "openai", "proxy_mode": "system",
            "api_key": CloudEngine._encode_api_key(key) if key else "",
            "models": models}


def _m(mid, model, tag=""):
    return {"id": mid, "model": model, "label": "", "tag": tag, "thinking": "", "ctx": 0}


class TestRoutingHintV2:
    def test_two_providers_fast_and_strong(self, store):
        """验收：两服务商、各一模型（一快一强）——提示含两个模型名与建议。"""
        from core import cloud_providers as cp
        from core.cloud_profiles import routing_hint
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "服务商A", "sk-a", [_m("m-a1", "model-fast-a", "fast")]),
            _pv("pv-b", "服务商B", "sk-b", [_m("m-b1", "model-strong-b", "strong")]),
        ]
        store.d[cp.ACTIVE_KEY] = {"provider": "pv-a", "model": "m-a1"}
        cp.select("pv-a", "m-a1")
        hint = routing_hint()
        assert "model-fast-a" in hint and "model-strong-b" in hint, hint
        assert "日常问答" in hint and "复杂产物" in hint
        assert "服务商A（model-fast-a）" in hint, "激活模型应取自 v2 cloud_active_v2"
        assert "顶栏模型选择器" in hint, "切换入口应指向顶栏模型选择器"

    def test_single_model_returns_empty(self, store):
        """验收：只有一个可用模型 → 空字符串。"""
        from core import cloud_providers as cp
        from core.cloud_profiles import routing_hint
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "服务商A", "sk-a", [_m("m-a1", "only-one")]),
        ]
        assert routing_hint() == ""

    def test_keyless_provider_models_excluded(self, store):
        """无 Key 服务商的模型不进提示（可用口径与 v1 一致）。"""
        from core import cloud_providers as cp
        from core.cloud_profiles import routing_hint
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "服务商A", "sk-a", [_m("m-a1", "model-a", "fast")]),
            _pv("pv-n", "无钥服务商", "", [_m("m-n1", "model-n", "strong")]),
        ]
        assert routing_hint() == ""

    def test_multi_models_across_providers(self, store):
        """跨服务商多模型：全列（上限 6），含各自建议。"""
        from core import cloud_providers as cp
        from core.cloud_profiles import routing_hint
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "A", "sk-a", [_m("m-a1", "a-fast", "fast"), _m("m-a2", "a-strong", "strong")]),
            _pv("pv-b", "B", "sk-b", [_m("m-b1", "b-strong", "strong")]),
        ]
        store.d[cp.ACTIVE_KEY] = {"provider": "pv-b", "model": "m-b1"}
        cp.select("pv-b", "m-b1")
        hint = routing_hint()
        for name in ("a-fast", "a-strong", "b-strong"):
            assert name in hint
        assert "B（b-strong）" in hint

    def test_v1_profiles_not_read(self, store, monkeypatch):
        """只读 v2：v1 档案里有数据也不影响（防静默回退）。"""
        from core import cloud_providers as cp
        from core.cloud_profiles import routing_hint
        store.d[cp.PROVIDERS_KEY] = [
            _pv("pv-a", "A", "sk-a", [_m("m-a1", "v2-model", "fast")]),
        ]
        store.d["cloud_profiles"] = [
            {"id": "pf-x", "name": "v1档案", "model": "v1-model", "api_key": "xx",
             "api_key_set": True, "tag": "strong"},
        ]
        # v2 只有 1 个可用模型 → 即便 v1 有档案也返回空
        assert routing_hint() == ""
