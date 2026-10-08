# -*- coding: utf-8 -*-
"""v2 切换必须重置引擎 client（sidemate-dev#30，先红后绿）

背景：CloudEngine._get_client() 首次请求时把 base_url/api_key 固化进
openai.OpenAI 并缓存（core/cloud_engine.py:295）。v2 select() 物化新配置后
必须调 mgr._cloud_engine._reset_client()，否则跨服务商切换后请求仍发往
上一家服务商、带着上一家的 Key（隐私影响，P0）。

旧实现的 _reset_engine_client() 在 sys.modules["server"] 上找
cloud_engine/cloud/engine 属性且要求 _client_cache——引擎实际挂在
server.mgr._cloud_engine 且 CloudEngine 没有 _client_cache，重置永远是
空操作。本文件钉死正确行为。

config 读写 monkeypatch 到内存 store；假 server 模块注入 sys.modules
（monkeypatch 自动还原），不碰真实 settings.json / 不触发 import server。
"""
import sys
import types

import pytest

from core import cloud_providers as cp
from core.cloud_engine import CloudEngine


class _Store:
    def __init__(self, initial=None):
        self.d = dict(initial or {})

    def get(self, k, d=None):
        return self.d.get(k, d)

    def save(self, upd):
        self.d.update(upd)


@pytest.fixture()
def store(monkeypatch):
    s = _Store()
    import config as _cfg
    monkeypatch.setattr(_cfg, "get", s.get)
    monkeypatch.setattr(_cfg, "save_config", s.save)
    return s


class _FakeEngine:
    """带重置计数器的假引擎（真实 CloudEngine 的 _reset_client 见
    cloud_engine.py:324——持锁清 self._client）。"""

    def __init__(self):
        self.reset_calls = 0
        self.client = object()  # 模拟已缓存的 client

    def _reset_client(self):
        self.reset_calls += 1
        self.client = None


class _FakeMgr:
    def __init__(self, engine):
        self._cloud_engine = engine


@pytest.fixture()
def fake_engine(monkeypatch):
    """把假 server 模块（mgr._cloud_engine）注入 sys.modules。"""
    eng = _FakeEngine()
    mod = types.ModuleType("server")
    mod.mgr = _FakeMgr(eng)
    monkeypatch.setitem(sys.modules, "server", mod)
    return eng


def _two_providers():
    def _pv(pid, name, base, key, model):
        return {"id": pid, "name": name, "base_url": base, "api_format": "openai",
                "proxy_mode": "system",
                "api_key": CloudEngine._encode_api_key(key) if key else "",
                "models": [{"id": "m-x", "model": model, "label": "", "tag": "",
                            "thinking": "", "ctx": 0}]}
    return [
        _pv("pv-a", "ProviderA", "https://a.example.com", "sk-aaa", "model-a"),
        _pv("pv-b", "ProviderB", "https://b.example.com", "sk-bbb", "model-b"),
    ]


class TestSelectResetsEngineClient:
    def test_cross_provider_select_calls_reset(self, store, fake_engine):
        """红点：切到另一家服务商必须触发 mgr._cloud_engine._reset_client()。

        旧实现在 server 模块上找 cloud_engine/cloud/engine 属性——
        假 server 只有 mgr，重置不会发生 → reset_calls == 0，红。
        """
        store.d[cp.PROVIDERS_KEY] = _two_providers()
        assert cp.select("pv-a", "m-x")["ok"] is True
        assert fake_engine.reset_calls == 1, "select() 后引擎 client 缓存必须被重置"

        assert cp.select("pv-b", "m-x")["ok"] is True
        assert fake_engine.reset_calls == 2, "跨服务商切换必须再次重置引擎 client"

    def test_same_provider_model_switch_also_resets(self, store, fake_engine):
        """同一服务商内切模型也走 materialize → 同样重置（配置重读无害）。"""
        store.d[cp.PROVIDERS_KEY] = _two_providers()
        cp.select("pv-a", "m-x")
        cp.select("pv-a", "m-x")
        assert fake_engine.reset_calls == 2


class TestResetRobustness:
    def test_no_server_module_no_crash(self, store, monkeypatch):
        """测试/脚本环境（sys.modules 无 server）→ 跳过重置，select 正常。"""
        monkeypatch.delitem(sys.modules, "server", raising=False)
        store.d[cp.PROVIDERS_KEY] = _two_providers()
        r = cp.select("pv-a", "m-x")
        assert r["ok"] is True, r

    def test_engine_none_no_crash(self, store, monkeypatch):
        """mgr._cloud_engine 尚未创建（None）→ 跳过，不抛。"""
        mod = types.ModuleType("server")
        mod.mgr = _FakeMgr(None)
        monkeypatch.setitem(sys.modules, "server", mod)
        store.d[cp.PROVIDERS_KEY] = _two_providers()
        r = cp.select("pv-a", "m-x")
        assert r["ok"] is True, r

    def test_reset_client_failure_swallowed(self, store, monkeypatch):
        """引擎 _reset_client 抛异常 → 吞掉（与 v1 cloud_profiles 同款容错）。"""

        class _Boom:
            def _reset_client(self):
                raise RuntimeError("boom")

        mod = types.ModuleType("server")
        mod.mgr = _FakeMgr(_Boom())
        monkeypatch.setitem(sys.modules, "server", mod)
        store.d[cp.PROVIDERS_KEY] = _two_providers()
        r = cp.select("pv-a", "m-x")
        assert r["ok"] is True, r


class TestRealCloudEngineResetPath:
    def test_real_engine_reset_clears_client(self, store, monkeypatch):
        """真 CloudEngine 挂到假 server.mgr 上：_reset_client 后 _get_client
        重建时会读新配置（这里直接断言 _client 被清空，锁语义在引擎内）。"""
        eng = CloudEngine(None)  # model_manager 仅存引用，不触碰
        eng._client = object()  # 模拟已缓存
        mod = types.ModuleType("server")
        mod.mgr = _FakeMgr(eng)
        monkeypatch.setitem(sys.modules, "server", mod)
        store.d[cp.PROVIDERS_KEY] = _two_providers()
        cp.select("pv-b", "m-x")
        assert eng._client is None, "重置后缓存的旧 client 必须被清掉"
