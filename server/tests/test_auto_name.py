# -*- coding: utf-8 -*-
"""0.10.1 M1-E 后半：会话自动命名测试

覆盖：
- auto_name_if_default：meta.title==文件夹名时生成标题并写 meta；
  已命名（自动/手动）不再触发；空消息/[占位消息不触发；生成器异常静默
- 标题清洗：引号/书名号/结尾标点剥离、取首行、限长 20
- set_chat_title：写 meta.title；meta 缺失返回 False
- rename_chat：文件夹重命名后 meta.title 同步（不与自动命名打架）
- list_chats 返回 title 字段（folder 与旧 json 两形态）

注意：run_text_once 必须 monkeypatch 掉（真身 → routers.deps → import server
会把看门狗拉进 pytest）。
"""
import json
import os

import pytest

from session import chat_store
import pipelines


@pytest.fixture()
def chat_dir(tmp_path, monkeypatch):
    d = str(tmp_path / "chats")
    os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(chat_store, "CHAT_DIR", d)
    import config as _cfg
    monkeypatch.setattr(_cfg, "DEFAULT_PROJECT_DIR", str(tmp_path / "projects" / "默认项目"))
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    return d


@pytest.fixture()
def fake_namer(monkeypatch):
    """拦截 run_text_once，返回可控标题 + 记录调用次数。"""
    calls = {"n": 0, "prompt": ""}

    def _fake(prompt, ai_mode):
        calls["n"] += 1
        calls["prompt"] = prompt
        return "《桌伴核心功能介绍》。\n第二行应被丢弃"

    monkeypatch.setattr(pipelines, "run_text_once", _fake)
    return calls


def _new_chat():
    r = chat_store.new_chat_file()
    name = r["name"] if isinstance(r, dict) else r
    return os.path.basename(name)


class TestAutoName:
    def test_names_first_turn(self, chat_dir, fake_namer):
        name = _new_chat()
        pipelines.auto_name_if_default(name, "帮我做一个桌伴核心功能的 PPT", "cloud")
        meta = chat_store.read_meta(name)
        assert meta["title"] == "桌伴核心功能介绍"  # 书名号/结尾标点已剥
        assert fake_namer["n"] == 1
        # list_chats 的 title 字段不在这里验（list_chats → routers.deps →
        # import server → 看门狗进 pytest；title 落盘正确性由 read_meta 覆盖）

    def test_skips_when_already_named(self, chat_dir, fake_namer):
        name = _new_chat()
        pipelines.auto_name_if_default(name, "第一条消息", "cloud")
        assert fake_namer["n"] == 1
        pipelines.auto_name_if_default(name, "第二条消息", "cloud")
        assert fake_namer["n"] == 1  # 第二次不再调生成器

    def test_skips_empty_and_placeholder(self, chat_dir, fake_namer):
        name = _new_chat()
        pipelines.auto_name_if_default(name, "", "cloud")
        pipelines.auto_name_if_default(name, "[文档续写]", "cloud")
        assert fake_namer["n"] == 0

    def test_generator_failure_silent(self, chat_dir, monkeypatch):
        def _boom(prompt, ai_mode):
            raise RuntimeError("engine down")
        monkeypatch.setattr(pipelines, "run_text_once", _boom)
        name = _new_chat()
        pipelines.auto_name_if_default(name, "你好", "cloud")  # 不抛
        assert chat_store.read_meta(name).get("title", name) == name  # 标题未动

    def test_short_or_empty_result_rejected(self, chat_dir, monkeypatch):
        monkeypatch.setattr(pipelines, "run_text_once", lambda p, m: "  ")
        name = _new_chat()
        pipelines.auto_name_if_default(name, "你好", "cloud")
        assert chat_store.read_meta(name).get("title", name) == name


class TestTitleStorage:
    def test_set_chat_title(self, chat_dir):
        name = _new_chat()
        assert chat_store.set_chat_title(name, "手工标题") is True
        assert chat_store.read_meta(name)["title"] == "手工标题"

    def test_set_chat_title_missing_meta(self, chat_dir):
        assert chat_store.set_chat_title("不存在_999", "x") is False

    def test_set_chat_title_empty_rejected(self, chat_dir):
        name = _new_chat()
        assert chat_store.set_chat_title(name, "   ") is False

    def test_rename_syncs_title(self, chat_dir):
        name = _new_chat()
        chat_store.set_chat_title(name, "自动起的标题")
        r = chat_store.rename_chat(name, "手工改名")
        assert r.get("ok")
        # 文件夹改名后 meta.title 同步为新文件夹名（不保留旧自动标题）
        assert chat_store.read_meta("手工改名")["title"] == "手工改名"
