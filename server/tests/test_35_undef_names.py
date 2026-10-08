# -*- coding: utf-8 -*-
"""#35（P0）：F7 遗留未定义变量 + 全仓同类清零——行为级红绿。

三处可行为复现（其余 7 处为导入缺失/工具脚本，ruff F821 扫描即红绿证据，
见 PR 正文 before/after 输出）：
1. /api/env/diagnose 在「模型已加载、依赖齐全」时 500（NameError:
   _llama_exists——前两个条件短路时不可见，普通用户最常见状态必踩）
2. set_todos（注册给模型的工具）一调就 NameError——任务步骤清单功能实际是坏的
3. /api/extensions/upload 的 request: Request 注解未导入——Py3.14 惰性注解
   下不炸 import，但 FastAPI 把 request 退化成 query 参数：真实上传 422
   「query request Field required」
"""
import io
import json
import sys
import types

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def fake_server(monkeypatch):
    mod = types.ModuleType("server")
    mod.mgr = types.SimpleNamespace(_cloud_engine=None)
    # 真实 server.py 顶部有 `ollama_manager = OllamaManager()`——
    # 诊断路由 `from server import ollama_manager`，fake 模块同步挂上
    from core.ollama_manager import OllamaManager
    mod.ollama_manager = OllamaManager()
    monkeypatch.setitem(sys.modules, "server", mod)


class TestEnvDiagnoseLoadedModel:
    def test_diagnose_200_when_model_loaded_and_deps_ok(self, monkeypatch, fake_server):
        """验收核心：模型已加载 + 依赖齐全 + llama-server 就绪 → 200 且 all_ok=True。

        修复前：走到 `not _llama_exists` → NameError → 500。
        """
        import routers.settings_system as ss
        # 模型已加载
        from server import ollama_manager
        monkeypatch.setattr(ollama_manager, "list_available_models",
                            lambda: [{"current": True, "model_id": "qwen3.5-0.8b-q4"}])
        # llama-server 命中
        monkeypatch.setattr(ss, "_diagnose_llama_server",
                            lambda: {"ok": True, "path": r"C:\lib\ollama\llama-server.exe"})
        # 依赖齐全：_import_check 恒 True
        from core import deps_check
        monkeypatch.setattr(deps_check, "_import_check", lambda name: True)

        app = types.SimpleNamespace()
        from fastapi import FastAPI
        real = FastAPI()
        real.include_router(ss.router)
        c = TestClient(real)
        r = c.get("/api/env/diagnose")
        assert r.status_code == 200, r.text[:300]
        d = r.json()
        assert d["all_ok"] is True, d
        assert d["models"]["llm_loaded"] is True
        assert d["llama_server"]["ok"] is True and d["llama_server"]["path"]

    def test_diagnose_flags_when_llama_missing(self, monkeypatch, fake_server):
        """llama-server 找不到 → all_ok=False（不 500）。"""
        import routers.settings_system as ss
        from server import ollama_manager
        monkeypatch.setattr(ollama_manager, "list_available_models",
                            lambda: [{"current": True, "model_id": "m"}])
        monkeypatch.setattr(ss, "_diagnose_llama_server",
                            lambda: {"ok": False, "path": "x", "note": "未找到"})
        from core import deps_check
        monkeypatch.setattr(deps_check, "_import_check", lambda name: True)
        from fastapi import FastAPI
        real = FastAPI()
        real.include_router(ss.router)
        c = TestClient(real)
        r = c.get("/api/env/diagnose")
        assert r.status_code == 200
        assert r.json()["all_ok"] is False


class TestSetTodosTool:
    def test_set_todos_roundtrip(self, tmp_path, monkeypatch):
        """真调一次 set_todos（issue 要求）：修复前 NameError。"""
        from session import chat_store
        monkeypatch.setattr(chat_store, "CHAT_DIR", str(tmp_path))
        (tmp_path / "c1").mkdir()
        (tmp_path / "c1" / "meta.json").write_text("{}", encoding="utf-8")
        from core import project_write as pw
        r = pw.set_todos("c1", [
            {"text": "步骤一", "done": True},
            {"text": "步骤二", "done": False},
            {"text": "", "done": True},   # 空文本应被过滤
        ])
        assert r.get("ok") is True and r["count"] == 2 and r["done_count"] == 1
        m = json.loads((tmp_path / "c1" / "meta.json").read_text(encoding="utf-8"))
        assert [t["text"] for t in m["todos"]] == ["步骤一", "步骤二"]
        # get_todos 读回（返回 todos 列表本尊）
        assert len(pw.get_todos("c1")) == 2

    def test_set_todos_missing_chat(self, tmp_path, monkeypatch):
        from session import chat_store
        monkeypatch.setattr(chat_store, "CHAT_DIR", str(tmp_path))
        from core import project_write as pw
        assert "error" in pw.set_todos("nope", [{"text": "x"}])


class TestExtensionsUploadRequest:
    def test_upload_request_is_real_request_not_query(self, fake_server):
        """修复前：422 且 detail 里有 loc=["query","request"]（注解退化）。"""
        import routers.settings_extensions as se
        from fastapi import FastAPI
        real = FastAPI()
        real.include_router(se.router)
        c = TestClient(real)
        r = c.post("/api/extensions/upload",
                   files={"file": ("x.sidemate", io.BytesIO(b"not-a-zip"), "application/octet-stream")})
        assert r.status_code != 422 or "query" not in json.dumps(r.json().get("detail", []), ensure_ascii=False), \
            "request 仍被当作 query 参数（Request 未导入）"
