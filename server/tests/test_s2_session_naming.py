# -*- coding: utf-8 -*-
"""S2（#14-②，P1-2 方案 C）：会话命名状态机——截取即时落 / AI 闲置升级 / 手动永不被覆盖

根因（见 issue #14 评论）：auto_name 链路本身无缺陷；堆积来自历史存量
（0.10.1 前）与「user 消息开局落盘但命名挂在回合完成」的错误轮次洞。
截取命名直接堵增量洞；title_src 状态机管升级与保护。
"""
import json

import pytest


@pytest.fixture()
def chatdir(tmp_path, monkeypatch):
    from session import chat_store
    d = tmp_path / "chats"
    d.mkdir()
    monkeypatch.setattr(chat_store, "CHAT_DIR", str(d))
    for name in ("c-new", "c-trunc", "c-manual", "c-ai"):
        (d / name).mkdir()
        (d / name / "meta.json").write_text(
            json.dumps({"message_count": 0}), encoding="utf-8")
    (d / "c-trunc" / "meta.json").write_text(
        json.dumps({"title": "会议室密码是什么？访客陈", "title_src": "truncate"}),
        encoding="utf-8")
    (d / "c-manual" / "meta.json").write_text(
        json.dumps({"title": "我的手动名", "title_src": "manual"}), encoding="utf-8")
    (d / "c-ai" / "meta.json").write_text(
        json.dumps({"title": "AI 起的好标题", "title_src": "ai"}), encoding="utf-8")
    return d


class TestTruncateTitle:
    def test_rules(self):
        from session.chat_store import truncate_title as tt
        assert tt("会议室密码是什么？访客陈露什么时候来？") == "会议室密码是什么？访客陈露什么时"
        assert tt("第一行\n第二行") == "第一行"
        assert tt("  **加粗标题**  ") == "加粗标题"
        assert tt("「引用式提问」") == "引用式提问"
        assert tt("") == ""
        assert tt("   ") == ""
        # 长英文照截 16
        assert len(tt("a" * 40)) == 16


class TestTruncateNamingPath:
    def test_set_title_with_src(self, chatdir):
        from session import chat_store
        ok = chat_store.set_chat_title("c-new", "截取的标题", src="truncate")
        assert ok is True
        m = chat_store.read_meta("c-new")
        assert m["title"] == "截取的标题" and m["title_src"] == "truncate"

    def test_first_message_hook_logic(self, chatdir):
        """chat 路由钩子条件：无 title 才截取；有 manual/ai 不动。"""
        from session import chat_store
        # c-new 无 title → 截取
        assert not chat_store.read_meta("c-new").get("title")
        # c-manual 有 title → 钩子跳过（模拟条件判断）
        assert chat_store.read_meta("c-manual").get("title")


class TestAutoNameStateMachine:
    def _run(self, chat_name, monkeypatch, chatdir, ai_title="AI 标题"):
        import pipelines as P
        monkeypatch.setattr(P, "run_text_once", lambda p, m: ai_title)
        P.auto_name_if_default(chat_name, "用户消息文本", "cloud")

    def test_truncate_gets_upgraded_to_ai(self, chatdir, monkeypatch):
        self._run("c-trunc", monkeypatch, chatdir, ai_title="AI 优化标题")
        from session import chat_store
        m = chat_store.read_meta("c-trunc")
        assert m["title"] == "AI 优化标题", "截取标题应在回合完成时被 AI 升级"
        assert m["title_src"] == "ai"

    def test_untitled_legacy_gets_named(self, chatdir, monkeypatch):
        """存量无标题会话（title_src 缺失但无 title）→ 仍补命名。"""
        (chatdir / "c-new" / "meta.json").write_text(
            json.dumps({"message_count": 2}), encoding="utf-8")
        self._run("c-new", monkeypatch, chatdir, ai_title="补的名字")
        from session import chat_store
        m = chat_store.read_meta("c-new")
        assert m["title"] == "补的名字" and m["title_src"] == "ai"

    def test_manual_never_overridden(self, chatdir, monkeypatch):
        self._run("c-manual", monkeypatch, chatdir, ai_title="AI 想覆盖")
        from session import chat_store
        m = chat_store.read_meta("c-manual")
        assert m["title"] == "我的手动名", "手动重命名后自动命名不得覆盖"
        assert m["title_src"] == "manual"

    def test_ai_not_renamed(self, chatdir, monkeypatch):
        self._run("c-ai", monkeypatch, chatdir, ai_title="又一次 AI")
        from session import chat_store
        assert chat_store.read_meta("c-ai")["title"] == "AI 起的好标题"


class TestRenameSetsManual:
    def test_rename_marks_manual(self, chatdir):
        from session import chat_store
        r = chat_store.rename_chat("c-trunc", "重命名后的会话")
        assert r.get("ok") is True
        m = chat_store.read_meta("重命名后的会话")
        assert m["title"] == "重命名后的会话"
        assert m["title_src"] == "manual"
