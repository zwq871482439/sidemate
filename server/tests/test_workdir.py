# -*- coding: utf-8 -*-
"""
test_workdir.py — 工作目录 M1 只读版测试（项目 ↔ 目录 1:1 模型）

覆盖：
- session/projects.py：默认目录自动创建/外部换绑优先/解除回落/目录列举/引用导入
- 解析链：chat meta group → 项目目录（会话级绑定已删除，无覆盖路径）

纪律（HANDOFF）：不 import server、不调 list_chats（会拉看门狗进 pytest）；
直读 meta.json / 文件系统验证。
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
    """隔离 CHAT_DIR / PROJECTS_FILE / DEFAULT_ROOT；返回 (chats_dir, ext_dir, default_root)"""
    chats = tmp_path / "chats"
    chats.mkdir()
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(chats))
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    monkeypatch.setattr(projects, "CHAT_DIR", str(chats))
    monkeypatch.setattr(projects, "PROJECTS_FILE", str(tmp_path / "projects.json"))
    droot = tmp_path / "projects"
    monkeypatch.setattr(projects, "DEFAULT_ROOT", str(droot))
    ext = tmp_path / "素材库"
    ext.mkdir()
    return str(chats), str(ext), str(droot)


def _mk_chat(chats_dir, name, group="日常"):
    d = os.path.join(chats_dir, name)
    os.makedirs(os.path.join(d, "workspace"))
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump({"id": name, "title": name, "group": group, "message_count": 0}, f)
    return d


class TestDefaultDir:
    def test_default_created_on_resolve(self, isolated):
        _, _, droot = isolated
        r = projects.resolve_project_workdir("论文")
        assert r["source"] == "default" and r["group"] == "论文"
        assert r["workdir"] == os.path.join(droot, "论文")
        assert os.path.isdir(r["workdir"])  # 自动创建

    def test_empty_group_falls_to_daily(self, isolated):
        _, _, droot = isolated
        r = projects.resolve_project_workdir("")
        assert r["group"] == "日常"
        assert os.path.isdir(os.path.join(droot, "日常"))


class TestExternalBinding:
    def test_external_overrides_default(self, isolated):
        _, ext, _ = isolated
        projects.set_project_workdir("论文", ext)
        r = projects.resolve_project_workdir("论文")
        assert r["source"] == "external"
        assert r["workdir"] == os.path.normpath(ext)

    def test_unbind_falls_back_to_default(self, isolated):
        _, ext, _ = isolated
        projects.set_project_workdir("论文", ext)
        r = projects.set_project_workdir("论文", None)
        assert r["ok"] and r["workdir"] is None
        assert projects.resolve_project_workdir("论文")["source"] == "default"

    def test_reject_invalid(self, isolated):
        assert "error" in projects.set_project_workdir("", "C:\\")
        assert "error" in projects.set_project_workdir("论文", "Z:\\不存在\\xyz")
        assert "error" in projects.set_project_workdir("论文", "relative\\path")

    def test_lock_after_sessions(self, isolated):
        """锁定规则：项目有会话后，换绑和回落都被拒绝（PLAN 1.5 三次定稿）。"""
        chats, ext, _ = isolated
        # 空项目可自由换绑/解除
        assert projects.set_project_workdir("论文", ext)["ok"]
        assert projects.set_project_workdir("论文", None)["ok"]
        # 有会话后锁定
        _mk_chat(chats, "2026-09-02_001", group="论文")
        assert projects.count_project_sessions("论文") == 1
        r = projects.set_project_workdir("论文", ext)
        assert "error" in r and "锁定" in r["error"]
        projects.set_project_workdir("空项目", ext)
        r2 = projects.set_project_workdir("论文", None)
        assert "error" in r2 and "锁定" in r2["error"]
        # resolve 带锁定信息
        info = projects.resolve_project_workdir("论文")
        assert info["locked"] is True and info["session_count"] == 1
        info2 = projects.resolve_project_workdir("空项目")
        assert info2["locked"] is False

    def test_daily_counts_legacy_json(self, isolated):
        chats, _, _ = isolated
        _mk_chat(chats, "2026-09-02_001")
        with open(os.path.join(chats, "旧会话.json"), "w") as f:
            json.dump({"messages": []}, f)
        assert projects.count_project_sessions("日常") == 2

    def test_stale_external_falls_to_default(self, isolated, tmp_path):
        _, ext, _ = isolated
        projects.set_project_workdir("论文", ext)
        os.rmdir(ext)  # 外部目录被删 → 回落默认
        assert projects.resolve_project_workdir("论文")["source"] == "default"


class TestAllWorkdirs:
    def test_with_groups_resolves_each(self, isolated):
        _, ext, _ = isolated
        projects.set_project_workdir("论文", ext)
        out = projects.all_workdirs(["论文", "日常"])
        assert out["论文"]["source"] == "external"
        assert out["日常"]["source"] == "default"


class TestResolveViaChat:
    def test_chat_inherits_project(self, isolated):
        chats, ext, _ = isolated
        projects.set_project_workdir("论文", ext)  # 空项目时换绑（锁定规则：有会话后禁换）
        _mk_chat(chats, "2026-09-02_001", group="论文")
        r = projects.resolve_workdir("2026-09-02_001")
        assert r["source"] == "external" and r["group"] == "论文"

    def test_missing_chat_uses_daily_default(self, isolated):
        isolated_chats, _, _ = isolated
        r = projects.resolve_workdir("没有这个名字")
        assert r["group"] == "日常" and r["source"] == "default"


class TestListDir:
    def test_dirs_first_and_fields(self, isolated):
        _, ext, _ = isolated
        os.makedirs(os.path.join(ext, "子目录"))
        with open(os.path.join(ext, "报告.docx"), "w") as f:
            f.write("x" * 100)
        entries = projects.list_dir_entries(ext)
        assert entries[0]["name"] == "子目录" and entries[0]["is_dir"]
        doc = [e for e in entries if e["name"] == "报告.docx"][0]
        assert doc["size"] == 100 and not doc["is_dir"] and doc["mtime"]

    def test_invalid_returns_none(self, isolated):
        assert projects.list_dir_entries("Z:\\不存在\\xyz") is None


class TestBrowse:
    def test_root_view_has_drives(self, isolated):
        r = projects.browse_dirs(None)
        assert r["path"] is None and r["parent"] is None
        # 至少 C: 盘在；根视图 entries 全是盘符
        assert any(e["name"] == "C:" for e in r["entries"])
        # 快捷入口存在与否取决于机器，但字段必须在
        assert isinstance(r["quick"], list)

    def test_dirs_only_and_parent(self, isolated):
        _, ext, _ = isolated
        os.makedirs(os.path.join(ext, "子目录A"))
        with open(os.path.join(ext, "文件.txt"), "w") as f:
            f.write("x")
        r = projects.browse_dirs(ext)
        assert r["path"] == os.path.normpath(ext)
        assert [e["name"] for e in r["entries"]] == ["子目录A"]  # 文件不出现
        assert r["parent"] is not None
        assert isinstance(r["quick"], list)  # 子目录视图也带快捷入口（选择器常显）

    def test_invalid_returns_none(self, isolated):
        assert projects.browse_dirs("Z:\\不存在\\xyz") is None
        assert projects.browse_dirs("relative\\path") is None


class TestUploadToProject:
    def test_upload_writes_into_project_dir(self, isolated):
        chats, ext, _ = isolated
        projects.set_project_workdir("论文", ext)  # 空项目时换绑
        _mk_chat(chats, "2026-09-02_001", group="论文")  # 先换绑再建会话……先换绑需在无会话时
        r = projects.upload_to_project("2026-09-02_001", "材料.txt", "内容".encode("utf-8"))
        # 上面换绑应被锁拒绝（已有会话）→ 回落默认目录；上传仍应成功到生效目录
        info = projects.resolve_project_workdir("论文")
        dst = os.path.join(info["workdir"], "材料.txt")
        assert r["ok"] and os.path.isfile(dst)
        with open(dst, "rb") as f:
            assert f.read() == "内容".encode("utf-8")

    def test_reject_bad_name(self, isolated):
        chats, _, _ = isolated
        _mk_chat(chats, "2026-09-02_001")
        assert "error" in projects.upload_to_project("2026-09-02_001", "../x.txt", b"x")
        assert "error" in projects.upload_to_project("2026-09-02_001", "", b"x")


class TestImportFile:
    def test_import_copies_to_workspace(self, isolated):
        chats, ext, _ = isolated
        projects.set_project_workdir("论文", ext)  # 空项目时换绑
        _mk_chat(chats, "2026-09-02_001", group="论文")
        src = os.path.join(ext, "笔记.md")
        with open(src, "w", encoding="utf-8") as f:
            f.write("# 你好\n内容")
        r = projects.import_file("2026-09-02_001", "笔记.md")
        assert "error" not in r, r
        assert r["filename"] == "笔记.md" and r["size"] > 0
        dst = os.path.join(chats, "2026-09-02_001", "workspace", "笔记.md")
        assert r["path"] == dst and os.path.isfile(dst)
        with open(dst, encoding="utf-8") as f:
            assert "你好" in f.read()
        # 源文件不动
        assert os.path.isfile(src)

    def test_reject_traversal_and_dir(self, isolated):
        chats, ext, _ = isolated
        projects.set_project_workdir("论文", ext)  # 空项目时换绑
        _mk_chat(chats, "2026-09-02_001", group="论文")
        os.makedirs(os.path.join(ext, "子目录"))
        assert "error" in projects.import_file("2026-09-02_001", "../secret.txt")
        assert "error" in projects.import_file("2026-09-02_001", "子目录")
        assert "error" in projects.import_file("2026-09-02_001", "不存在.txt")

    def test_reject_bad_ext(self, isolated):
        chats, ext, _ = isolated
        projects.set_project_workdir("论文", ext)  # 空项目时换绑
        _mk_chat(chats, "2026-09-02_001", group="论文")
        with open(os.path.join(ext, "程序.exe"), "w") as f:
            f.write("MZ")
        r = projects.import_file("2026-09-02_001", "程序.exe")
        assert "error" in r and "不支持" in r["error"]
