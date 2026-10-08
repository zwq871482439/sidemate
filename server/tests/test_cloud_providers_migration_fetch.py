# -*- coding: utf-8 -*-
"""在线模型服务 v2 迁移健壮性 + 远端模型拉取测试（sidemate-dev#9 第 3、4 条，先红后绿）

迁移覆盖：
- 幂等按「键是否存在」判定：providers 为空列表（用户删光了服务商）不得
  重跑迁移、把旧 cloud_profiles 里的档案复活
- 迁移成功后清理旧 cloud_profiles，providers + active 单次写入
- 激活档案 → ACTIVE 指向迁移后的模型；当前 cloud_model 不在档案中 → 补条目防悬空

拉取覆盖（桩替换 httpx.Client）：
- openai 协议：/v1/models + Bearer
- anthropic 协议：/v1/models + x-api-key + anthropic-version（不携带 Bearer）
- base 已带 /v1 时不重复拼接
- proxy_mode=direct → trust_env=False（不走系统代理）
- 非 200 / 连接异常 → 结构化 error

config 读写全部 monkeypatch 到内存 store，不碰真实 settings.json。
"""
import httpx
import pytest

from core import cloud_providers as cp
from core.cloud_engine import CloudEngine


class _Store:
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


def _raw_profile(pid, name, model, base, active=False, fmt="openai", key="sk-old"):
    return {"id": pid, "name": name, "base_url": base, "api_format": fmt,
            "api_key": CloudEngine._encode_api_key(key) if key else "",
            "model": model, "tag": "fast",
            **({"active": True} if active else {})}


class TestMigrationRobustness:
    def test_empty_providers_list_does_not_resurrect(self, store):
        """providers 已是空列表（键存在）→ 迁移不得重跑、不得复活旧档案。"""
        store.d[cp.PROVIDERS_KEY] = []  # 用户删光了所有服务商
        store.d["cloud_profiles"] = [_raw_profile("p1", "Old", "old-model", "https://old.example.com")]
        cp.migrate_from_profiles()
        assert store.d[cp.PROVIDERS_KEY] == [], "空列表 = 已迁移态，不得复活旧档案"

    def test_migration_single_write_and_cleans_profiles(self, store):
        """迁移：providers + active + 清理旧档案一次写入；cloud_profiles 清空。"""
        store.d["cloud_profiles"] = [
            _raw_profile("p1", "DeepSeek", "deepseek-v4-flash", "https://api.deepseek.com", active=True),
            _raw_profile("p2", "DeepSeek2", "deepseek-chat", "https://api.deepseek.com"),
        ]
        store.d["cloud_active_profile"] = "p1"
        before = len(store.writes)
        cp.migrate_from_profiles()
        assert len(store.writes) - before == 1, "迁移必须合并为单次 save_config（防中间崩溃的半迁移态）"
        assert store.d["cloud_profiles"] == [], "迁移成功后应清理旧 cloud_profiles（消除复活源）"
        providers = store.d[cp.PROVIDERS_KEY]
        assert len(providers) == 1, "同 (base_url, api_format) 归组为一个服务商"
        assert {m["model"] for m in providers[0]["models"]} == {"deepseek-v4-flash", "deepseek-chat"}
        assert store.d[cp.ACTIVE_KEY] is not None

    def test_active_profile_maps_to_active_model(self, store):
        store.d["cloud_profiles"] = [
            _raw_profile("p1", "DeepSeek", "deepseek-v4-flash", "https://api.deepseek.com", active=True),
        ]
        store.d["cloud_active_profile"] = "p1"
        cp.migrate_from_profiles()
        providers = store.d[cp.PROVIDERS_KEY]
        active = store.d[cp.ACTIVE_KEY]
        assert active["provider"] == providers[0]["id"]
        m = next(x for x in providers[0]["models"] if x["id"] == active["model"])
        assert m["model"] == "deepseek-v4-flash"

    def test_current_model_missing_from_profiles_gets_appended(self, store):
        """cloud_model 不在任何档案里（迁移前手改过）→ 补条目，激活不悬空。"""
        store.d["cloud_profiles"] = [
            _raw_profile("p1", "DeepSeek", "deepseek-v4-flash", "https://api.deepseek.com", active=True),
        ]
        store.d["cloud_active_profile"] = "p1"
        store.d["cloud_model"] = "some-other-model"
        cp.migrate_from_profiles()
        providers = store.d[cp.PROVIDERS_KEY]
        models = {m["model"] for m in providers[0]["models"]}
        assert "some-other-model" in models, "当前 cloud_model 不在档案里时必须补条目"


class _FakeResp:
    def __init__(self, status_code=200, payload=None, text=""):
        self.status_code = status_code
        self._payload = payload or {"data": [{"id": "model-a"}, {"id": "model-b"}]}
        self.text = text

    def json(self):
        return self._payload


class _Capture:
    last = None


def _stub_httpx(monkeypatch, resp=None, exc=None):
    class _FakeClient:
        def __init__(self, *a, **kw):
            _Capture.last = {"kwargs": kw}
            _Capture.last["url"] = None
            _Capture.last["headers"] = None

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, headers=None):
            _Capture.last["url"] = url
            _Capture.last["headers"] = headers or {}
            if exc:
                raise exc
            return resp or _FakeResp()

    monkeypatch.setattr(httpx, "Client", _FakeClient)


class TestFetchRemoteModels:
    def test_openai_url_and_bearer(self, store, monkeypatch):
        _stub_httpx(monkeypatch)
        r = cp.fetch_remote_models("https://api.deepseek.com", "sk-x", "openai")
        assert r["ok"] is True and r["models"] == ["model-a", "model-b"]
        assert _Capture.last["url"] == "https://api.deepseek.com/v1/models"
        assert _Capture.last["headers"]["Authorization"] == "Bearer sk-x"

    def test_anthropic_headers_and_url(self, store, monkeypatch):
        _stub_httpx(monkeypatch)
        r = cp.fetch_remote_models("https://api.anthropic.com", "sk-ant", "anthropic")
        assert r["ok"] is True
        assert _Capture.last["url"] == "https://api.anthropic.com/v1/models", "anthropic 端点必须补 /v1"
        h = _Capture.last["headers"]
        assert h.get("x-api-key") == "sk-ant", "anthropic 鉴权必须用 x-api-key"
        assert "anthropic-version" in h, "anthropic 必须带 anthropic-version"
        assert "Authorization" not in h, "anthropic 不应携带 Bearer"

    def test_base_with_v1_not_duplicated(self, store, monkeypatch):
        _stub_httpx(monkeypatch)
        cp.fetch_remote_models("https://gw.example.com/v1", "k", "openai")
        assert _Capture.last["url"] == "https://gw.example.com/v1/models"

    def test_direct_mode_disables_env_proxy(self, store, monkeypatch):
        _stub_httpx(monkeypatch)
        cp.fetch_remote_models("https://api.deepseek.com", "sk-x", "openai", proxy_mode="direct")
        assert _Capture.last["kwargs"].get("trust_env") is False, "direct 模式必须 trust_env=False"

    def test_system_mode_keeps_env_proxy(self, store, monkeypatch):
        _stub_httpx(monkeypatch)
        cp.fetch_remote_models("https://api.deepseek.com", "sk-x", "openai", proxy_mode="system")
        assert _Capture.last["kwargs"].get("trust_env") is not False

    def test_http_error_returns_structured_error(self, store, monkeypatch):
        _stub_httpx(monkeypatch, resp=_FakeResp(status_code=401, text="unauthorized"))
        r = cp.fetch_remote_models("https://api.deepseek.com", "bad", "openai")
        assert "error" in r and "401" in r["error"]

    def test_connection_failure_returns_structured_error(self, store, monkeypatch):
        _stub_httpx(monkeypatch, exc=ConnectionError("boom"))
        r = cp.fetch_remote_models("https://api.deepseek.com", "k", "openai")
        assert "error" in r and "连接失败" in r["error"]
