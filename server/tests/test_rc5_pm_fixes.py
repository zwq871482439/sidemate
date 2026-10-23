# -*- coding: utf-8 -*-
"""0.11.1 rc.5：PM 10-11 走查修复的正反用例。

计划模式挡住产物工具；DeepSeek 低思考档把 reasoning_effort=low 放进请求体；
上下文余量只认用户填写的长度；记忆默认关闭时工具不进模型、不注入、不落盘。
"""
import json
import os
import subprocess

import pytest

import core.project_write as pw
from session import chat_store


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    chats = str(tmp_path / "chats")
    proj = str(tmp_path / "projects" / "我的项目")
    os.makedirs(chats, exist_ok=True)
    os.makedirs(proj, exist_ok=True)
    monkeypatch.setattr(chat_store, "CHAT_DIR", chats)
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    d = os.path.join(chats, "s1")
    os.makedirs(d, exist_ok=True)
    meta = {"id": "s1", "title": "周报会话", "project_dir": proj,
            "created_at": "2026-10-11 10:00:00", "updated_at": "2026-10-11 10:00:00",
            "message_count": 0, "version": 3}
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    return {"chats": chats, "proj": proj, "sid": "s1"}


class TestArtifactPlanGate:
    def test_plan_blocks_and_registers(self, sandbox):
        r = pw.artifact_blocked_in_plan(sandbox["sid"], "create_docx", {"title": "周报"})
        assert r["ok"] is False and r["error"] == "plan_mode" and r["pending"] is True
        assert "plan_confirm" in r["message"]
        assert not os.path.exists(os.path.join(sandbox["proj"], "周报.docx"))
        st = pw.get_harness_state(sandbox["sid"])
        assert st["pending_plan"] and "create_docx" in st["pending_plan"][0]["path"]

    def test_execute_does_not_block(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        assert pw.artifact_blocked_in_plan(sandbox["sid"], "create_ppt", {"title": "汇报"}) is None

    def test_non_artifact_not_blocked(self, sandbox):
        assert pw.artifact_blocked_in_plan(sandbox["sid"], "search_web", {"query": "x"}) is None

    def test_execute_tool_plan_does_not_render(self, sandbox, monkeypatch):
        import core.poster_render as pr
        monkeypatch.setattr(pr, "render_poster", lambda **k: (_ for _ in ()).throw(AssertionError("rendered")))
        from core.agent_loop import AgentLoop
        r = AgentLoop(None, None, chat_id=sandbox["sid"])._execute_tool(
            "create_poster", {"title": "周报海报"}, {})
        assert r["success"] is False and r["error"] == "plan_mode"
        assert "周报" not in os.listdir(sandbox["proj"])

    def test_execute_tool_execute_reaches_render(self, sandbox, monkeypatch):
        import core.doc_session as ds
        import core.poster_render as pr
        monkeypatch.setattr(pr, "render_poster", lambda **k: "<html>ok</html>")
        monkeypatch.setattr(ds, "write_workspace_file", lambda *a, **k: {"path": "x.html"})
        pw.set_exec_mode(sandbox["sid"], "execute")
        from core.agent_loop import AgentLoop
        r = AgentLoop(None, None, chat_id=sandbox["sid"])._execute_tool(
            "create_poster", {"title": "周报海报"}, {})
        assert r["success"] is True, r


class TestThinkingRequestBody:
    def test_deepseek_low_body_has_effort(self, monkeypatch):
        import core.cloud_engine as ce
        from core.cloud_engine import CloudEngine
        state = {"cloud_thinking_level": "low", "cloud_api_format": "openai",
                 "cloud_base_url": "https://api.deepseek.com"}
        monkeypatch.setattr(ce, "_cfg", lambda k, d=None: state.get(k, d))
        captured = {}

        class _Stream:
            def __iter__(self):
                return iter([])

        class _Completions:
            def create(self, **kwargs):
                captured.update(kwargs)
                return _Stream()

        class _Chat:
            def __init__(self):
                self.completions = _Completions()

        class _Client:
            def __init__(self):
                self.chat = _Chat()

        client = _Client()
        eng = CloudEngine.__new__(CloudEngine)
        list(eng._iter_openai_events(client, "deepseek-v4-flash", [{"role": "user", "content": "hi"}], 32))
        assert captured.get("reasoning_effort") == "low"
        thinking = (captured.get("extra_body") or {}).get("thinking") or captured.get("thinking")
        assert thinking == {"type": "enabled"}

    def test_deepseek_high_omits_effort(self, monkeypatch):
        import core.cloud_engine as ce
        from core.cloud_engine import CloudEngine
        state = {"cloud_thinking_level": "high", "cloud_api_format": "openai",
                 "cloud_base_url": "https://api.deepseek.com"}
        monkeypatch.setattr(ce, "_cfg", lambda k, d=None: state.get(k, d))
        assert "reasoning_effort" not in CloudEngine._thinking_kwargs("deepseek-v4-flash")


class TestContextWindowUserOnly:
    def test_user_value_kept(self):
        from core.cloud_engine import CloudEngine
        assert CloudEngine.resolve_context_tokens(1000000) == (1000000, False)

    def test_zero_does_not_invent_dictionary_window(self):
        from core.cloud_engine import CloudEngine
        n, needs = CloudEngine.resolve_context_tokens(0)
        assert needs is True and n == 0
        assert n not in (131072, 1048576)

    def test_usage_ignores_dictionary(self, monkeypatch):
        import config
        import routers.chat as chat

        def fake(k, d=None):
            if k == "ai_mode":
                return "cloud"
            if k == "cloud_context_window":
                return 0
            if k == "cloud_model":
                return "DeepSeek-V4-Flash"
            return d

        monkeypatch.setattr(config, "get", fake)
        monkeypatch.setattr(chat, "get_current_chat", lambda: None)
        usage = chat._calc_context_usage(None)
        assert usage["total_tokens"] == 0
        assert usage["needs_confirm"] is True
        assert usage["total_tokens"] != 1048576


def _cfg_factory(memory):
    def fake(k, d=None):
        if k == "feature_memory":
            return memory
        if k == "ai_mode":
            return "cloud"
        return d
    return fake


class TestMemoryOffline:
    def test_tools_hidden_when_off(self, monkeypatch):
        import config
        import core.agent_tools as at
        monkeypatch.setattr(config, "get", _cfg_factory(False))
        tools, prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None, history=None)
        names = [t["function"]["name"] for t in tools]
        assert "save_memory" not in names
        assert "recall_memory" not in names
        assert "已载入会话记忆" not in prompt

    def test_tools_present_when_on(self, monkeypatch):
        import config
        import core.agent_tools as at
        monkeypatch.setattr(config, "get", _cfg_factory(True))
        tools, _prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None, history=None)
        names = [t["function"]["name"] for t in tools]
        assert "save_memory" in names
        assert "recall_memory" in names

    def test_inject_skipped_when_off(self, sandbox, monkeypatch):
        import config
        import core.curated_memory as cm
        mem = os.path.join(sandbox["proj"], ".sidemate", "memory.md")
        os.makedirs(os.path.dirname(mem), exist_ok=True)
        with open(mem, "w", encoding="utf-8") as f:
            f.write("# 项目记忆（桌伴策展）\n\n## 偏好\n- 交付默认同时给预览和文档\n")
        monkeypatch.setattr(config, "get", _cfg_factory(False))
        assert cm.inject_hint(sandbox["sid"]) == ""
        monkeypatch.setattr(config, "get", _cfg_factory(True))
        hinted = cm.inject_hint(sandbox["sid"])
        assert "交付默认同时给预览和文档" in hinted

    def test_save_refused_when_off_and_writes_when_on(self, tmp_path, monkeypatch):
        import config
        from core.agent_loop import AgentLoop
        from session.chat_store import append_memory_confirmation
        chats = tmp_path / "chats"
        (chats / "c1").mkdir(parents=True)
        (chats / "c1" / "meta.json").write_text("{}", encoding="utf-8")
        data = tmp_path / "data"
        data.mkdir()
        monkeypatch.setattr(config, "DATA_DIR", str(data))
        monkeypatch.setattr(chat_store, "CHAT_DIR", str(chats))
        import session.projects as projects
        monkeypatch.setattr(projects, "resolve_chat_project", lambda chat_id: None)
        mem = data / "memory" / "c1.md"
        monkeypatch.setattr(config, "get", _cfg_factory(False))
        r = AgentLoop(None, None, chat_id="c1")._execute_tool(
            "save_memory", {"section": "偏好", "text": "周报放在周一上午"}, {})
        assert r["success"] is False and r["error"] == "feature_off"
        assert not mem.exists()
        monkeypatch.setattr(config, "get", _cfg_factory(True))
        append_memory_confirmation(str(chats / "c1"), "记住：周报放在周一上午")
        r2 = AgentLoop(None, None, chat_id="c1")._execute_tool(
            "save_memory", {"section": "偏好", "text": "周报放在周一上午"}, {})
        assert r2["success"] is True, r2
        assert "周报放在周一上午" in mem.read_text(encoding="utf-8")

    def test_strip_memory_card_keeps_plan_card(self, monkeypatch):
        import config
        import core.curated_memory as cm
        mem = '前文\n```ask\n{"kind":"memory_save","question":"要记住吗","options":["同意写入"]}\n```\n'
        plan = '```ask\n{"kind":"plan_confirm","question":"执行？","options":["同意，执行写入"]}\n```'
        monkeypatch.setattr(config, "get", _cfg_factory(False))
        assert "memory_save" not in cm.strip_memory_ask(mem)
        assert "plan_confirm" in cm.strip_memory_ask(plan)
        monkeypatch.setattr(config, "get", _cfg_factory(True))
        assert "memory_save" in cm.strip_memory_ask(mem)


class TestGuideCopy:
    def test_empty_state_plain_language(self):
        path = os.path.join(os.path.dirname(os.path.dirname(__file__)),
                            "static", "js", "v2", "empty_state.js")
        text = open(path, encoding="utf-8").read()
        for gone in ("右视窗", "39 型", "多轮工具循环", "随时切随"):
            assert gone not in text, gone
        assert "先看效果，再下载 PPT" in text


def test_ui_pure_module():
    script = os.path.join(os.path.dirname(__file__), "rc5_ui_pure_check.mjs")
    proc = subprocess.run(["node", script], capture_output=True, text=True)
    assert proc.returncode == 0, proc.stdout + proc.stderr
