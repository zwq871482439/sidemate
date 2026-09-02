# -*- coding: utf-8 -*-
"""
test_workdir.py — 「项目即文件夹」模型测试（PLAN 1.5 四次定稿）

覆盖：
- session/projects.py：注册表 v1→v2 迁移/空白项目/现有文件夹/改名/删除（级联清单）
- 会话解析：project_dir / legacy / 失效态 / 路径白名单
- 引用直读（不复制）/ 上传 / 内联浏览

纪律（HANDOFF）：不 import server、不调 list_chats；直读 meta.json / 文件系统验证。
"""
import os
import sys
import json
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import config
from session import projects
from session import chat_store


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """隔离全部目录常量；返回 (chats_dir, ext_dir, proj_root)"""
    chats = tmp_path / "chats"
    chats.mkdir()
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(chats))
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    monkeypatch.setattr(projects, "CHAT_DIR", str(chats))
    monkeypatch.setattr(projects, "PROJECTS_FILE", str(tmp_path / "projects.json"))
    proot = tmp_path / "projects"
    monkeypatch.setattr(projects, "PROJECTS_ROOT", str(proot))
    ddir = proot / "默认项目"
    monkeypatch.setattr(projects, "DEFAULT_PROJECT_DIR", str(ddir))
    monkeypatch.setattr(config, "DEFAULT_PROJECT_DIR", str(ddir))
    monkeypatch.setattr(config, "PROJECTS_ROOT", str(proot))
    ext = tmp_path / "素材库"
    ext.mkdir()
    return str(chats), str(ext), str(proot)


def _mk_chat(chats_dir, name, project_dir="SENTINEL", msg_count=0):
    """project_dir: SENTINEL=默认项目, None=旧版（无 project_dir）, 或指定目录"""
    if project_dir == "SENTINEL":
        project_dir = projects.DEFAULT_PROJECT_DIR
    d = os.path.join(chats_dir, name)
    os.makedirs(os.path.join(d, "workspace"))
    meta = {"id": name, "title": name, "message_count": msg_count}
    if project_dir is not None:
        meta["project_dir"] = project_dir
    else:
        meta["group"] = "日常"  # 旧版模型痕迹
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return d


class TestRegistry:
    def test_v1_migration(self, isolated, tmp_path):
        _, ext, proot = isolated
        with open(projects.PROJECTS_FILE, "w", encoding="utf-8") as f:
            json.dump({"论文": {"workdir": ext}}, f)  # v1 格式
        lst = projects.list_projects()
        assert lst[0]["is_default"] and lst[0]["display"] == "默认项目"
        assert lst[1]["dir"] == os.path.normpath(ext) and lst[1]["display"] == "论文"
        # 已落盘为 v2
        with open(projects.PROJECTS_FILE, encoding="utf-8") as f:
            assert json.load(f)["version"] == 2

    def test_create_blank_and_external(self, isolated):
        _, ext, proot = isolated
        r = projects.create_project_blank("论文")
        assert r["ok"] and r["project"]["dir"] == os.path.join(proot, "论文")
        assert os.path.isdir(os.path.join(proot, "论文", ".sidemate"))
        assert "error" in projects.create_project_blank("论文")  # 同名
        assert "error" in projects.create_project_blank("默认项目")
        r2 = projects.create_project_external(ext)
        assert r2["ok"] and r2["project"]["display"] == "素材库"
        assert "error" in projects.create_project_external(ext)  # 重复注册
        assert "error" in projects.create_project_external("Z:\\不存在")

    def test_rename_and_default_guard(self, isolated):
        _, ext, _ = isolated
        projects.create_project_external(ext)
        assert projects.rename_project(ext, "我的素材")["ok"]
        lst = [p for p in projects.list_projects() if p["dir"] == os.path.normpath(ext)]
        assert lst[0]["display"] == "我的素材"
        assert "error" in projects.rename_project(ext, "")
        assert "error" in projects.rename_project(projects.DEFAULT_PROJECT_DIR, "x")

    def test_missing_status(self, isolated, tmp_path):
        import shutil as _shutil
        _, ext, _ = isolated
        projects.create_project_external(ext)
        _shutil.rmtree(ext)  # 含 .sidemate 产物区一起删
        lst = [p for p in projects.list_projects() if not p["is_default"]]
        assert lst[0]["status"] == "missing"

    def test_delete_project(self, isolated):
        chats, ext, _ = isolated
        projects.create_project_external(ext)
        _mk_chat(chats, "2026-09-02_001", project_dir=ext, msg_count=3)
        _mk_chat(chats, "2026-09-02_002")  # 默认项目，不应被级联
        r = projects.delete_project(ext)
        assert r["ok"] and r["sessions"] == ["2026-09-02_001"]
        assert "error" in projects.delete_project(projects.DEFAULT_PROJECT_DIR)
        assert all(p["dir"] != os.path.normpath(ext) for p in projects.list_projects())
        # 目录文件不动
        assert os.path.isdir(ext)


class TestResolve:
    def test_legacy_and_default_and_external(self, isolated):
        chats, ext, _ = isolated
        _mk_chat(chats, "old", project_dir=None)
        assert projects.is_legacy_chat("old")
        assert projects.resolve_chat_project("old")["legacy"] is True
        _mk_chat(chats, "new1")
        r = projects.resolve_chat_project("new1")
        assert r["legacy"] is False and r["is_default"] and r["status"] == "ok"
        projects.create_project_external(ext)
        _mk_chat(chats, "new2", project_dir=ext)
        r2 = projects.resolve_chat_project("new2")
        assert r2["display"] == "素材库" and not r2["is_default"]

    def test_path_whitelist(self, isolated):
        _, ext, _ = isolated
        projects.create_project_external(ext)
        assert projects.is_in_any_project_dir(os.path.join(ext, "a.txt"))
        assert projects.is_in_any_project_dir(
            os.path.join(projects.DEFAULT_PROJECT_DIR, "b.txt"))
        assert not projects.is_in_any_project_dir("C:\\Windows\\x.dll")


class TestReference:
    def test_direct_read_no_copy(self, isolated):
        chats, ext, _ = isolated
        projects.create_project_external(ext)
        _mk_chat(chats, "2026-09-02_001", project_dir=ext)
        src = os.path.join(ext, "笔记.md")
        with open(src, "w", encoding="utf-8") as f:
            f.write("# 你好\n内容")
        r = projects.reference_file("2026-09-02_001", "笔记.md")
        assert "error" not in r, r
        assert r["path"] == os.path.normpath(src)  # 原路径直出，不复制
        assert not os.path.exists(os.path.join(
            chats, "2026-09-02_001", "workspace", "笔记.md"))  # workspace 无副本

    def test_artifact_prefix_and_traversal(self, isolated):
        chats, ext, _ = isolated
        projects.create_project_external(ext)
        _mk_chat(chats, "2026-09-02_001", project_dir=ext)
        art = os.path.join(ext, ".sidemate")
        with open(os.path.join(art, "产物.md"), "w") as f:
            f.write("x")
        assert "error" not in projects.reference_file("2026-09-02_001", ".sidemate/产物.md")
        assert "error" in projects.reference_file("2026-09-02_001", "../secret.txt")
        assert "error" in projects.reference_file("2026-09-02_001", "sub/deep.txt")

    def test_legacy_rejected(self, isolated):
        chats, ext, _ = isolated
        projects.create_project_external(ext)
        _mk_chat(chats, "old", project_dir=None)
        assert "error" in projects.reference_file("old", "a.txt")


class TestUpload:
    def test_upload_to_project_root(self, isolated):
        chats, ext, _ = isolated
        projects.create_project_external(ext)
        _mk_chat(chats, "2026-09-02_001", project_dir=ext)
        r = projects.upload_to_project("2026-09-02_001", "材料.txt", "内容".encode())
        assert r["ok"]
        assert os.path.isfile(os.path.join(ext, "材料.txt"))

    def test_legacy_rejected(self, isolated):
        chats, _, _ = isolated
        _mk_chat(chats, "old", project_dir=None)
        assert "error" in projects.upload_to_project("old", "a.txt", b"x")


class TestNewChat:
    def test_meta_has_project_dir(self, isolated):
        chats, ext, _ = isolated
        projects.create_project_external(ext)
        p = chat_store.new_chat_file(ext)
        name = os.path.basename(p)
        with open(os.path.join(chats, name, "meta.json"), encoding="utf-8") as f:
            meta = json.load(f)
        assert meta["project_dir"] == os.path.normpath(ext)
        assert "group" not in meta  # 新模型不再写 group

    def test_default_project_fallback(self, isolated):
        isolated  # 目录已由 fixture 隔离
        p = chat_store.new_chat_file()
        name = os.path.basename(p)
        meta = chat_store.read_meta(name)
        assert meta["project_dir"] == projects.DEFAULT_PROJECT_DIR
        assert not projects.is_legacy_chat(name)


class TestBrowse:
    def test_root_and_subdir(self, isolated):
        _, ext, _ = isolated
        r = projects.browse_dirs(None)
        assert r["path"] is None and any(e["name"] == "C:" for e in r["entries"])
        os.makedirs(os.path.join(ext, "子目录A"))
        with open(os.path.join(ext, "文件.txt"), "w") as f:
            f.write("x")
        r2 = projects.browse_dirs(ext)
        assert [e["name"] for e in r2["entries"]] == ["子目录A"]
        assert isinstance(r2["quick"], list)
        assert projects.browse_dirs("Z:\\不存在") is None
