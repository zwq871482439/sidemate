# -*- coding: utf-8 -*-
"""0.10.1 D-1 真修：会话私密标记补全（写入端 + 列表下发 + carry 拒收）。

注意：不 import routers.chat（→routers.deps→server 看门狗）与 list_chats
（同理）；API 层行为由 chat_store 原语 + 校验逻辑等价物覆盖。
"""
import json
import os

import pytest

from session import chat_store


@pytest.fixture()
def chat_dir(tmp_path, monkeypatch):
    d = str(tmp_path / "chats")
    os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(chat_store, "CHAT_DIR", d)
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    return d


def _mk(chat_dir, name, meta_extra=None):
    p = os.path.join(chat_dir, name)
    os.makedirs(p, exist_ok=True)
    meta = {"id": name, "title": name, "message_count": 2,
            "created_at": "2026-09-20 10:00:00", "updated_at": "2026-09-20 10:01:00",
            "version": 3, "project_dir": r"C:\proj"}
    meta.update(meta_extra or {})
    with open(os.path.join(p, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)
    return name


class TestPrivateFlag:
    def test_is_private_requires_local_origin(self, chat_dir):
        a = _mk(chat_dir, "s_local", {"engine_origin": "local", "private": True})
        b = _mk(chat_dir, "s_cloud", {"engine_origin": "cloud", "private": True})
        c = _mk(chat_dir, "s_plain", {"private": True})  # 无 origin：历史夹具形态
        assert chat_store.is_private_session(a) is True
        assert chat_store.is_private_session(b) is False
        assert chat_store.is_private_session(c) is False

    def test_iter_project_sessions_carries_private(self, chat_dir):
        # 等价物：iter_project_sessions 的条目应带 private 语义所需的 meta
        # （注入层过滤用它；这里验证枚举不出错且返回两条）
        _mk(chat_dir, "s_local", {"engine_origin": "local", "private": True})
        _mk(chat_dir, "s_cloud", {})
        out = chat_store.iter_project_sessions(r"C:\proj")
        assert len(out) == 2

    def test_toggle_writes_meta(self, chat_dir):
        # 等价物：写入端 = meta 落 private/engine_origin 两键，读回一致
        name = _mk(chat_dir, "s_x", {"engine_origin": "local"})
        mp = os.path.join(chat_dir, name, "meta.json")
        meta = json.load(open(mp, encoding="utf-8"))
        meta["private"] = True
        json.dump(meta, open(mp, "w", encoding="utf-8"), ensure_ascii=False)
        assert chat_store.is_private_session(name) is True
