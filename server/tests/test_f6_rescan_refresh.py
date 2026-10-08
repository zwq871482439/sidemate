# -*- coding: utf-8 -*-
"""F6：rescan 后刷新 our_model_names 测试（sidemate-dev#7，先红后绿）

覆盖：
- OllamaManager.refresh_our_models()：重扫 registry 回写 _impl.our_model_names，
  刷新后 serves_our_models() 对新模型为真
- /api/rescan 末尾调用 refresh_our_models()（桩 mgr + 桩全局 ollama_manager）
"""
import types

import pytest

from core.ollama_manager import OllamaManager


class _StubModel:
    def __init__(self, name):
        self.gguf_filename = name


class _StubRegistry:
    def __init__(self):
        self.names = []

    def scan(self):
        return [_StubModel(n) for n in self.names]


class _StubImpl:
    def __init__(self):
        self.our_model_names = []
        self.loaded = set()

    def is_healthy(self):
        return True

    def serves_any(self, names):
        return any(n in self.loaded for n in names)


def _mgr_stub():
    m = OllamaManager.__new__(OllamaManager)
    m._registry = _StubRegistry()
    m._impl = _StubImpl()
    return m


class TestRefreshOurModels:
    def test_refresh_picks_up_new_model(self):
        """红点：修复前没有 refresh_our_models 方法，rescan 后门禁列表不更新。"""
        m = _mgr_stub()
        m._registry.names = ["a.gguf"]
        m.refresh_our_models()
        assert m._impl.our_model_names == ["a.gguf"]
        # 新下载的 b 就位（registry 第二次 scan 返回 a+b）
        m._registry.names = ["a.gguf", "b.gguf"]
        m.refresh_our_models()
        assert "b.gguf" in m._impl.our_model_names, "rescan 后 our_model_names 应含新模型"

    def test_serves_gate_passes_for_new_model(self):
        m = _mgr_stub()
        m._registry.names = ["a.gguf", "b.gguf"]
        m._impl.loaded = {"b.gguf"}
        m.refresh_our_models()
        assert m.serves_our_models() is True, "刷新后 serves_our_models 应对 b 为真"

    def test_scan_failure_keeps_empty(self):
        m = _mgr_stub()
        m._registry.scan = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        assert m.refresh_our_models() == []
        assert m._impl.our_model_names == []


class TestApiRescanCallsRefresh:
    def test_rescan_endpoint_refreshes_gate(self, monkeypatch):
        """红点：api_rescan 此前不调 refresh_our_models（新模型过不了懒加载门禁）。"""
        import routers.settings_system as ss
        calls = {"refresh": 0}

        fake_mgr = types.SimpleNamespace(
            model_configs={"embed": {"type": "embedding"}},
            _scan_models=lambda: None,
        )
        fake_om = types.SimpleNamespace(refresh_our_models=lambda: calls.__setitem__("refresh", calls["refresh"] + 1))
        fake_server = types.ModuleType("server")
        fake_server.ollama_manager = fake_om
        fake_server.mgr = fake_mgr
        import sys
        monkeypatch.setitem(sys.modules, "server", fake_server)
        monkeypatch.setattr(ss, "get_mgr", lambda: fake_mgr)

        r = ss.api_rescan()
        assert calls["refresh"] == 1, "api_rescan 必须刷新 our_model_names"
        assert r["ok"] if "ok" in r else True
