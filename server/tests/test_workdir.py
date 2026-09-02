# -*- coding: utf-8 -*-
"""
test_workdir.py — 工作目录 M1 只读版纯函数测试

覆盖：
- session/projects.py：项目绑定存取/失效过滤/解析优先级/目录列举
- session/chat_store.py：read_meta / set_chat_workdir

纪律（HANDOFF）：不 import server、不调 list_chats（会拉看门狗进 pytest）；
直读 meta.json 验证落盘。
"""
import os
import sys
import json
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from session import projects
from session import chat_store


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """隔离 CHAT_DIR + PROJECTS_FILE；返回 (chats_dir, workdir_real)"""
    chats = tmp_path / "chats"
    chats.mkdir()
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(chats))
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    pf = tmp_path / "projects.json"
    monkeypatch.setattr(projects, "PROJECTS_FILE", str(pf))
    real_dir = tmp_path / "素材库"
    real_dir.mkdir()
    return str(chats), str(real_dir)


def _mk_chat(chats_dir, name, group="日常"):
    d = os.path.join(chats_dir, name)
    os.makedirs(os.path.join(d, "workspace"))
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"id": name, "title": name, "group": group, "message_count": 0}, f)
    return d


class TestProjectWorkdir:
    def test_set_and_get(self, isolated):
        _, real = isolated
        r = projects.set_project_workdir("论文", real)
        assert r == {"ok": True, "workdir": os.path.normpath(real)}
        assert projects.get_project_workdir("论文") == os.path.normpath(real)

    def test_unbind(self, isolated):
        _, real = isolated
        projects.set_project_workdir("论文", real)
        r = projects.set_project_workdir("论文", None)
        assert r["ok"] and r["workdir"] is None
        assert projects.get_project_workdir("论文") is None

    def test_reject_invalid(self, isolated):
        assert "error" in projects.set_project_workdir("", "C:\\")
        assert "error" in projects.set_project_workdir("论文", "Z:\\不存在\\xyz")
        assert "error" in projects.set_project_workdir("论文", "relative\\path")

    def test_all_workdirs_filters_stale(self, isolated, tmp_path):
        _, real = isolated
        projects.set_project_workdir("论文", real)
        # 手写一个失效目录进存储
        pf = projects.PROJECTS_FILE
        with open(pf, encoding="utf-8") as f:
            data = json.load(f)
        data["旧项目"] = {"workdir": str(tmp_path / "已删除")}
        with open(pf, "w", encoding="utf-8") as f:
            json.dump(data, f)
        allwd = projects.all_workdirs()
        assert allwd == {"论文": os.path.normpath(real)}


class TestChatWorkdir:
    def test_set_read_unbind(self, isolated):
        chats, real = isolated
        _mk_chat(chats, "2026-09-02_001")
        r = chat_store.set_chat_workdir("2026-09-02_001", real)
        assert r["ok"] and r["workdir"] == os.path.normpath(real)
        # 直读 meta.json 验证落盘（不调 list_chats）
        with open(os.path.join(chats, "2026-09-02_001", "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        assert meta["workdir"] == os.path.normpath(real)
        assert chat_store.read_meta("2026-09-02_001")["workdir"] == os.path.normpath(real)
        r2 = chat_store.set_chat_workdir("2026-09-02_001", None)
        assert r2["ok"] and r2["workdir"] is None
        assert "workdir" not in chat_store.read_meta("2026-09-02_001")

    def test_reject_invalid_and_missing_chat(self, isolated):
        chats, real = isolated
        _mk_chat(chats, "2026-09-02_001")
        assert "error" in chat_store.set_chat_workdir("2026-09-02_001", "Z:\\不存在")
        assert "error" in chat_store.set_chat_workdir("不存在会话", real)

    def test_read_meta_missing_returns_empty(self, isolated):
        assert chat_store.read_meta("没有这个名字") == {}


class TestResolve:
    def test_session_overrides_group(self, isolated, tmp_path):
        chats, real = isolated
        other = tmp_path / "会话专属"
        other.mkdir()
        _mk_chat(chats, "2026-09-02_001", group="论文")
        projects.set_project_workdir("论文", real)
        chat_store.set_chat_workdir("2026-09-02_001", str(other))
        r = projects.resolve_workdir("2026-09-02_001")
        assert r["source"] == "session"
        assert r["workdir"] == os.path.normpath(str(other))
        assert r["group"] == "论文"

    def test_group_fallback(self, isolated):
        chats, real = isolated
        _mk_chat(chats, "2026-09-02_001", group="论文")
        projects.set_project_workdir("论文", real)
        r = projects.resolve_workdir("2026-09-02_001")
        assert r["source"] == "group"
        assert r["workdir"] == os.path.normpath(real)

    def test_none_when_unbound(self, isolated):
        chats, _ = isolated
        _mk_chat(chats, "2026-09-02_001")
        r = projects.resolve_workdir("2026-09-02_001")
        assert r["workdir"] is None and r["source"] is None and r["group"] == "日常"


class TestListDir:
    def test_dirs_first_and_fields(self, isolated, tmp_path):
        _, real = isolated
        os.makedirs(os.path.join(real, "子目录"))
        with open(os.path.join(real, "报告.docx"), "w") as f:
            f.write("x" * 100)
        entries = projects.list_dir_entries(real)
        assert entries[0]["name"] == "子目录" and entries[0]["is_dir"]
        doc = [e for e in entries if e["name"] == "报告.docx"][0]
        assert doc["size"] == 100 and not doc["is_dir"] and doc["mtime"]

    def test_invalid_returns_none(self, isolated):
        assert projects.list_dir_entries("Z:\\不存在\\xyz") is None
