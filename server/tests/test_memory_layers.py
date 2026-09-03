# -*- coding: utf-8 -*-
"""M2-2 记忆分层三件测试（②+++ 议题1 落地）

覆盖：
- 会话索引段注入：同项目最近 8 条一行式 / 跨项目排除 / 私密会话排除
  （隐私铁律：离线私密不进在线注入）/ 旧版会话不注入
- 选带层注入：carry_sids 摘要注入 / 同项目校验 / 私密跳过 / 去重封顶
- read_session 冷层：同项目校验拒跨项目 / 私密拒读 / 每 sid 只读一次
  防循环 / 正常摘要返回
- session_digest / is_private_session 助手

注意：CHAT_DIR 隔离；read_session 走 AgentLoop._execute_tool（不发网络）。
"""
import json
import os

import pytest

from session import chat_store
import core.agent_tools as at
import core.agent_loop as al


PROJ = None  # fixture 里填


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    """隔离 CHAT_DIR + 两个项目目录。"""
    chats = str(tmp_path / "chats")
    proj_a = str(tmp_path / "projects" / "项目A")
    proj_b = str(tmp_path / "projects" / "项目B")
    for d in (chats, proj_a, proj_b):
        os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(chat_store, "CHAT_DIR", chats)
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    # doc_session 模块级 from config import CHAT_DIR（值绑定），注入链走它的 _chat_root
    import core.doc_session as _ds
    monkeypatch.setattr(_ds, "CHAT_DIR", chats)
    import config as _cfg
    monkeypatch.setattr(_cfg, "DEFAULT_PROJECT_DIR", str(tmp_path / "projects" / "默认项目"))
    return {"chats": chats, "proj_a": proj_a, "proj_b": proj_b}


def _mk_chat(sandbox, name, project_dir, title=None, private=False, msgs=None):
    """直接造一个会话文件夹（绕过 new_chat_file 的编号逻辑）。"""
    d = os.path.join(sandbox["chats"], name)
    os.makedirs(d, exist_ok=True)
    meta = {
        "id": name, "title": title or name,
        "project_dir": project_dir,
        "created_at": "2026-09-04 10:00:00", "updated_at": "2026-09-04 10:00:00",
        "message_count": len(msgs or []), "version": 3,
    }
    if private:
        meta["engine_origin"] = "local"
        meta["private"] = True
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    with open(os.path.join(d, "messages.json"), "w", encoding="utf-8") as f:
        json.dump({"messages": msgs or []}, f, ensure_ascii=False)
    return name


_MSGS = [
    {"role": "user", "content": "桌伴的记忆分层怎么设计？"},
    {"role": "assistant", "content": "记忆分层分热层、选带层、冷层三层，热层用 handoff 重写制。"},
]


def _inject(chat_id):
    return at._inject_session_context(chat_id=chat_id, kb=None,
                                      base_prompt="BASE", kb_tag_str="", history=None)


class TestSessionIndex:
    def test_peers_injected(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], title="旧任务一", msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        out = _inject("2026-09-04_002")
        assert "[项目会话索引" in out
        assert "旧任务一" in out and "sid:2026-09-04_001" in out
        assert "2026-09-04_002（" not in out  # 不含自己

    def test_cross_project_excluded(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_b"], title="别的项目")
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        out = _inject("2026-09-04_002")
        assert "别的项目" not in out

    def test_private_excluded(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], title="私密旧会话",
                 private=True, msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        out = _inject("2026-09-04_002")
        assert "私密旧会话" not in out  # 隐私铁律：私密不进在线索引段

    def test_legacy_chat_no_index(self, sandbox):
        # 旧版会话（meta 无 project_dir）不注入索引
        d = os.path.join(sandbox["chats"], "2026-09-04_009")
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
            json.dump({"id": "2026-09-04_009", "title": "2026-09-04_009"}, f)
        out = _inject("2026-09-04_009")
        assert "[项目会话索引" not in out


class TestCarryLayer:
    def test_carry_digest_injected(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], title="配色方案讨论", msgs=_MSGS)
        cur = _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        meta_path = os.path.join(sandbox["chats"], cur, "meta.json")
        meta = json.load(open(meta_path, encoding="utf-8"))
        meta["carry_sids"] = ["2026-09-04_001"]
        json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False)
        out = _inject(cur)
        assert "[用户指定携带的前情会话" in out
        assert "配色方案讨论" in out
        assert "首条提问" in out

    def test_carry_skips_private_and_cross(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], title="私密会话",
                 private=True, msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_003", sandbox["proj_b"], title="跨项目会话", msgs=_MSGS)
        cur = _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        meta_path = os.path.join(sandbox["chats"], cur, "meta.json")
        meta = json.load(open(meta_path, encoding="utf-8"))
        meta["carry_sids"] = ["2026-09-04_001", "2026-09-04_003"]
        json.dump(meta, open(meta_path, "w", encoding="utf-8"), ensure_ascii=False)
        out = _inject(cur)
        assert "私密会话" not in out and "跨项目会话" not in out


class TestReadSession:
    def _loop(self):
        return al.AgentLoop(cloud_engine=None, search_engine=None, kb=None,
                            chat_id="2026-09-04_002", history=None)

    def test_cross_project_rejected(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_b"], msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        r = self._loop()._execute_tool("read_session", {"chat_name": "2026-09-04_001"}, {})
        assert r["success"] is False and r["error"] == "cross_project"

    def test_private_rejected(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], private=True, msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        r = self._loop()._execute_tool("read_session", {"chat_name": "2026-09-04_001"}, {})
        assert r["success"] is False and r["error"] == "private_session"

    def test_read_once_guard(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], title="历史讨论", msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        loop = self._loop()
        r1 = loop._execute_tool("read_session", {"chat_name": "2026-09-04_001"}, {})
        assert r1["success"] is True
        assert "历史讨论" in r1["data"]["digest"]
        assert "首条提问" in r1["data"]["digest"]
        r2 = loop._execute_tool("read_session", {"chat_name": "2026-09-04_001"}, {})
        assert r2["success"] is False and r2["error"] == "already_read"  # 防循环

    def test_not_found(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        r = self._loop()._execute_tool("read_session", {"chat_name": "2026-09-04_099"}, {})
        assert r["success"] is False


class TestHelpers:
    def test_digest(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], title="测试标题", msgs=_MSGS)
        dg = chat_store.session_digest("2026-09-04_001")
        assert "测试标题" in dg and "首条提问" in dg and "最近回答" in dg
        assert chat_store.session_digest("不存在_999") == ""

    def test_private_judgement(self, sandbox):
        _mk_chat(sandbox, "2026-09-04_001", sandbox["proj_a"], private=True, msgs=_MSGS)
        _mk_chat(sandbox, "2026-09-04_002", sandbox["proj_a"], msgs=_MSGS)
        assert chat_store.is_private_session("2026-09-04_001") is True
        assert chat_store.is_private_session("2026-09-04_002") is False
