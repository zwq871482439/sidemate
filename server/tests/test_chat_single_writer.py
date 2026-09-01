# -*- coding: utf-8 -*-
"""0.10.1 M1-B 后端单写消息流测试

覆盖：
- append_message：id 分配（m%04d 单调递增）、字段保留、folder/json 双格式
- persist_turn 单写路径：user 消息开局落盘后 assistant 追加，_file_tag/ts 不被覆写
- persist_turn legacy 回退：旧行为重建 + chat_store 两级匹配兜底 _file_tag（双轨兼容）
- 中断形态：_aborted 标记落盘
- 旧消息无 id 不回填（旧数据不动）
"""
import json
import os
import time

import pytest

from session import chat_store
from session.chat_store import (
    append_message, load_chat, save_chat, new_chat_file, _next_msg_id,
)
from pipelines._base import StreamContext, persist_turn


@pytest.fixture()
def chat_dir(tmp_path, monkeypatch):
    """隔离的 CHAT_DIR

    注意：new_chat_file 会调 set_current_chat（routers.deps → import server），
    测试环境必须屏蔽，否则会把整个 server.py（含看门狗）拉起来。
    """
    d = str(tmp_path / "chats")
    os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(chat_store, "CHAT_DIR", d)
    # 迁移标记全局只跑一次，测试间互不影响（tmp 目录无旧文件，迁移是 no-op）
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    return d


def _ctx(chat_file, message="你好", history=None, saved=False, uid="", body=None):
    return StreamContext(
        message=message,
        model_name="test-model",
        max_tokens=None,
        chat_file=chat_file,
        history_raw=history or [],
        action_mode="chat",
        file_path=None,
        ai_mode="local",
        mgr=None,
        kb=None,
        body=body or {},
        user_msg_id=uid,
        user_msg_saved=saved,
    )


# ---------- append_message ----------

class TestAppendMessage:
    def test_assigns_monotonic_ids_and_preserves_fields(self, chat_dir):
        path = new_chat_file()
        m1 = append_message(path, {"role": "user", "content": "hi", "ts": "10:00:00",
                                   "_file_tag": {"name": "a.docx", "source": "upload"}})
        m2 = append_message(path, {"role": "assistant", "content": "你好", "ts": "10:00:05"})
        assert m1["id"] == "m0001"
        assert m2["id"] == "m0002"
        msgs = load_chat(path)
        assert len(msgs) == 2
        assert msgs[0]["_file_tag"]["name"] == "a.docx"
        assert msgs[0]["ts"] == "10:00:00"
        # meta 同步
        meta = json.load(open(os.path.join(path, "meta.json"), encoding="utf-8"))
        assert meta["message_count"] == 2

    def test_existing_id_not_overwritten(self, chat_dir):
        path = new_chat_file()
        m = append_message(path, {"role": "user", "content": "x", "id": "m0009"})
        assert m["id"] == "m0009"
        m2 = append_message(path, {"role": "user", "content": "y"})
        assert m2["id"] == "m0010"

    def test_legacy_json_format(self, chat_dir):
        # 旧 .json 单文件格式
        fp = os.path.join(chat_dir, "2026-01-01_001.json")
        with open(fp, "w", encoding="utf-8") as f:
            json.dump({"version": 2, "messages": [{"role": "user", "content": "old", "ts": "09:00:00"}]}, f)
        m = append_message(fp, {"role": "assistant", "content": "resp", "ts": "09:00:10"})
        assert m["id"] == "m0001"
        msgs = load_chat(fp)
        assert len(msgs) == 2
        # 旧消息不回填 id（旧数据不动）
        assert "id" not in msgs[0]

    def test_invalid_path_returns_none(self, chat_dir):
        assert append_message(os.path.join(chat_dir, "nonexistent"), {"role": "user"}) is None


# ---------- persist_turn 单写路径 ----------

class TestPersistTurnAppend:
    def test_assistant_appended_after_early_saved_user(self, chat_dir):
        """单写主路径：开局落盘的 user 消息保持 ts/_file_tag 终态，assistant 追加"""
        path = new_chat_file()
        user = append_message(path, {
            "role": "user", "content": "总结这个文档", "ts": "18:21:30",
            "_file_tag": {"name": "委托书.docx", "source": "upload"}})
        ctx = _ctx(path, message="总结这个文档", saved=True, uid=user["id"])
        asst = {"role": "assistant", "content": "这是总结…", "ts": "18:21:45",
                "model": "m", "token_stats": {"total": 100}}
        messages, mode = persist_turn(ctx, asst)
        assert mode == "append"
        assert len(messages) == 2
        # user 消息未被重建/覆写：引用标记与发送时刻原样存活（0.9.8 回归的根治）
        assert messages[0]["_file_tag"]["name"] == "委托书.docx"
        assert messages[0]["ts"] == "18:21:30"
        assert messages[0]["id"] == user["id"]
        assert messages[1]["id"] == "m0002"
        assert messages[1]["token_stats"]["total"] == 100
        # 磁盘一致
        assert load_chat(path) == messages

    def test_user_ts_not_overwritten_by_completion_time(self, chat_dir):
        """发送时刻 ts 不被完成时刻覆写（旧版两级匹配改 ts 的场景不再发生）"""
        path = new_chat_file()
        user = append_message(path, {"role": "user", "content": "q", "ts": "08:00:00"})
        time.sleep(0.01)
        ctx = _ctx(path, message="q", saved=True, uid=user["id"])
        persist_turn(ctx, {"role": "assistant", "content": "a", "ts": "08:00:09"})
        msgs = load_chat(path)
        assert msgs[0]["ts"] == "08:00:00"

    def test_none_assistant_keeps_user_only(self, chat_dir):
        """空回复场景：assistant_msg=None 时只保留 user 消息"""
        path = new_chat_file()
        user = append_message(path, {"role": "user", "content": "q", "ts": "08:00:00"})
        ctx = _ctx(path, message="q", saved=True, uid=user["id"])
        messages, mode = persist_turn(ctx, None)
        assert mode == "append"
        assert len(messages) == 1
        assert messages[0]["role"] == "user"

    def test_abort_shape_persists(self, chat_dir):
        """中断形态：_aborted/_abort_reason 落盘，内容保留"""
        path = new_chat_file()
        user = append_message(path, {"role": "user", "content": "q", "ts": "08:00:00"})
        ctx = _ctx(path, message="q", saved=True, uid=user["id"])
        persist_turn(ctx, {"role": "assistant", "content": "半截回答", "ts": "08:00:03",
                           "_aborted": True, "_abort_reason": "user_stop"})
        msgs = load_chat(path)
        assert msgs[1]["_aborted"] is True
        assert msgs[1]["_abort_reason"] == "user_stop"
        assert msgs[1]["content"] == "半截回答"

    def test_engine_field_stamped(self, chat_dir):
        """engine 字段由管道按 ai_mode 打标（修「云端模型显示成离线 AI」）"""
        path = new_chat_file()
        user = append_message(path, {"role": "user", "content": "q", "ts": "08:00:00"})
        ctx = _ctx(path, message="q", saved=True, uid=user["id"])
        ctx.ai_mode = "cloud"
        persist_turn(ctx, {"role": "assistant", "content": "a", "ts": "08:00:01"})
        msgs = load_chat(path)
        assert msgs[1]["engine"] == "cloud"
        # 已带 engine 的不覆盖
        ctx2 = _ctx(path, message="q2", saved=False)
        ctx2.ai_mode = "local"
        messages, _ = persist_turn(ctx2, {"role": "assistant", "content": "b",
                                          "ts": "08:02:00", "engine": "custom"})
        assert messages[-1]["engine"] == "custom"


# ---------- persist_turn legacy 回退（双轨兼容） ----------

class TestPersistTurnLegacy:
    def test_rebuild_when_no_early_save(self, chat_dir):
        """开局未落盘（旧前端/落盘失败）→ 历史行为重建 history + [user, assistant]"""
        path = new_chat_file()
        ctx = _ctx(path, message="问题", history=[{"role": "user", "content": "旧轮", "ts": "07:00:00"}])
        messages, mode = persist_turn(ctx, {"role": "assistant", "content": "答", "ts": "07:01:00"})
        assert mode == "legacy"
        assert [m["role"] for m in messages] == ["user", "user", "assistant"]
        assert messages[1]["content"] == "问题"
        assert messages[1]["ts"]  # 有 ts

    def test_file_tag_survives_via_two_level_matching(self, chat_dir):
        """双轨兼容核心：旧版 append 的 _file_tag 在 legacy 重建时仍被两级匹配继承"""
        path = new_chat_file()
        # 模拟旧版前端 append：user 消息带引用标记，ts 为发送时刻
        save_chat(path, [{"role": "user", "content": "看下这份合同", "ts": "10:00:00",
                          "_file_tag": {"name": "合同.pdf", "source": "upload"}}])
        # 模拟旧版 pipeline 完成保存：重建裸 user 消息（无 tag，ts 为完成时刻）
        ctx = _ctx(path, message="看下这份合同", saved=False)
        messages, mode = persist_turn(ctx, {"role": "assistant", "content": "合同要点…", "ts": "10:00:30"})
        assert mode == "legacy"
        assert messages[0]["_file_tag"]["name"] == "合同.pdf"
        # 兜底匹配同时把 ts 还原回发送时刻
        assert messages[0]["ts"] == "10:00:00"

    def test_legacy_messages_keep_no_id(self, chat_dir):
        """旧消息无 id 不回填；legacy 重建的新消息按序分配 id"""
        path = new_chat_file()
        save_chat(path, [{"role": "user", "content": "旧消息", "ts": "06:00:00"},
                         {"role": "assistant", "content": "旧回答", "ts": "06:00:10"}])
        ctx = _ctx(path, message="新问", saved=False,
                   history=[{"role": "user", "content": "旧消息", "ts": "06:00:00"},
                            {"role": "assistant", "content": "旧回答", "ts": "06:00:10"}])
        messages, _ = persist_turn(ctx, {"role": "assistant", "content": "新答", "ts": "06:01:00"})
        assert "id" not in messages[0]
        assert "id" not in messages[1]
        assert messages[2]["id"] == "m0001"  # 新 user
        assert messages[3]["id"] == "m0002"  # 新 assistant
