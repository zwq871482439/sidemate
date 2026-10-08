# -*- coding: utf-8 -*-
"""F4（sidemate-dev#11，S9 方案 B）：知识库引用来源条——后端契约测试。

覆盖：
- /api/kb/source-text：§ 后缀剥离、精确/包含匹配、按 chunk index 拼接全文、
  404、本机来源守卫
- 来源字段持久化与回放：kb_sources 走 persist 落 messages.json，
  GET /api/chats 回放数据里保留（前端来源条刷新后仍在的数据契约）
"""
import json
import os
import sys
import types

import pytest
from fastapi.testclient import TestClient

from knowledge.models import KBDocument, KBChunk


class _FakeKB:
    def __init__(self):
        self.documents = {}
        self.chunks = {}

    def add_doc(self, doc_id, filename, chunks):
        self.documents[doc_id] = KBDocument(
            doc_id=doc_id, filename=filename, file_type="txt",
            file_size=100, imported_at="2026-10-08 00:00:00", status="ready")
        for i, text in enumerate(chunks):
            self.chunks["%s-c%d" % (doc_id, i)] = KBChunk(
                chunk_id="%s-c%d" % (doc_id, i), doc_id=doc_id, index=i,
                text=text, char_count=len(text))


@pytest.fixture()
def fake_kb():
    kb = _FakeKB()
    kb.add_doc("d1", "meeting-note.txt",
               ["会议室密码是青竹，地点在三楼东侧会议室。", "每周例会纪要：周二上午站会。"])
    kb.add_doc("d2", "u7-note.txt", ["访客陈露，4月9日来访。"])
    return kb


@pytest.fixture()
def client(monkeypatch, fake_kb):
    import routers.deps as deps
    import routers.kb as kb_router
    monkeypatch.setattr(deps, "get_kb", lambda: fake_kb)
    monkeypatch.setattr(kb_router, "get_kb", lambda: fake_kb)
    app = types.SimpleNamespace()
    # 只挂 kb 路由，避免整套 app 副作用
    from fastapi import FastAPI
    real_app = FastAPI()
    real_app.include_router(kb_router.router)
    # 测试环境的 fake server 模块（防 watchdog import）
    mod = types.ModuleType("server")
    mod.mgr = types.SimpleNamespace(_cloud_engine=None)
    monkeypatch.setitem(sys.modules, "server", mod)
    return TestClient(real_app)


class TestSourceTextEndpoint:
    def test_exact_name_returns_joined_chunks(self, client):
        r = client.get("/api/kb/source-text", params={"name": "meeting-note.txt"})
        assert r.status_code == 200
        d = r.json()
        assert d["ok"] is True and d["filename"] == "meeting-note.txt"
        assert "青竹" in d["text"] and "站会" in d["text"]
        # 按 index 顺序拼接（块 1 在块 2 前）
        assert d["text"].index("青竹") < d["text"].index("站会")

    def test_section_suffix_stripped(self, client):
        r = client.get("/api/kb/source-text", params={"name": "meeting-note.txt §3"})
        assert r.status_code == 200
        assert r.json()["filename"] == "meeting-note.txt"

    def test_missing_name_400(self, client):
        r = client.get("/api/kb/source-text", params={"name": " "})
        assert r.status_code == 400

    def test_unknown_doc_404(self, client):
        r = client.get("/api/kb/source-text", params={"name": "nope.txt"})
        assert r.status_code == 404

    def test_nonlocal_origin_403(self, client):
        r = client.get("/api/kb/source-text", params={"name": "meeting-note.txt"},
                       headers={"Origin": "http://evil.example.com"})
        assert r.status_code == 403


class TestSourcePersistenceContract:
    """回放数据契约：kb_sources 落进 messages.json 并随会话读取接口返回。"""

    def test_persist_keeps_kb_sources(self, tmp_path, monkeypatch):
        from session import chat_store
        monkeypatch.setattr(chat_store, "CHAT_DIR", str(tmp_path))
        folder = tmp_path / "c-1"
        folder.mkdir()
        (folder / "messages.json").write_text(
            json.dumps({"version": 3, "messages": [
                {"role": "user", "content": "q", "id": "m1"}]}), encoding="utf-8")
        srcs = [{"label": "meeting-note.txt", "snippet": "会议室密码是青竹…", "reranker_score": 0.68},
                {"label": "u7-note.txt", "snippet": "访客陈露，4月9日…", "reranker_score": 0.70}]
        # 后端单写 persist：白名单字段 kb_sources 必须随 assistant 消息落盘
        msgs = chat_store.load_chat(str(folder))
        msgs.append({"role": "assistant", "content": "密码青竹；访客陈露。",
                     "kb_sources": srcs})
        chat_store.save_chat(str(folder), msgs)
        d = json.loads((folder / "messages.json").read_text(encoding="utf-8"))
        saved = [m for m in d["messages"] if m["role"] == "assistant"][-1]
        assert [s["label"] for s in saved["kb_sources"]] == \
            ["meeting-note.txt", "u7-note.txt"], "刷新回放来源条的数据源必须两份都在"
        # 回放读取（load_chat）字段无损
        back = chat_store.load_chat(str(folder))
        assert back[-1]["kb_sources"][1]["label"] == "u7-note.txt"

    def test_routers_whitelist_contains_kb_sources(self):
        """chat 路由的 persist/enrich 白名单必须含 kb_sources（回放链路不静默丢字段）。"""
        import os
        chat_py = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                               "routers", "chat.py")
        src = open(chat_py, encoding="utf-8").read()
        # 两处 persist 白名单（folder 格式 + 旧 .json 格式）+ enrich 白名单都查
        count = src.count('"kb_sources"')
        assert count >= 3, "chat.py 白名单应有 ≥3 处 kb_sources（persist×2 + enrich），现 %d" % count
