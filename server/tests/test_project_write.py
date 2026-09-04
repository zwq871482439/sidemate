# -*- coding: utf-8 -*-
"""M2-3 项目写权限测试（core/project_write.py）

覆盖：
- 路径防穿越：绝对路径/../ 穿越/.sidemate 系统区/盘符全部拒绝
- 计划模式：project_write 只登记不落盘（pending_plan 记账，覆盖标记）
- 执行模式：真落盘 + 覆盖写前备份 + log.jsonl + manifest 同步 +
  成功后移出待执行计划
- 撤销：覆盖→恢复旧版；新建→移除
- 变更感知：外部新增/修改/删除检出；AI 自己的写入不误报；每次只报一次
- set_exec_mode/set_goal/discard_plan 边界
- 注入：goal/pending_plan/外部变更提示进 prompt

安全基线：AI 不删文件（无 delete 动作）；写前必备份；穿越必拒。
"""
import json
import os

import pytest

from session import chat_store
import core.project_write as pw
import core.agent_tools as at


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    chats = str(tmp_path / "chats")
    proj = str(tmp_path / "projects" / "我的项目")
    for d in (chats, proj):
        os.makedirs(d, exist_ok=True)
    monkeypatch.setattr(chat_store, "CHAT_DIR", chats)
    monkeypatch.setattr(chat_store, "_migration_done", True)
    monkeypatch.setattr(chat_store, "set_current_chat", lambda p: None)
    import core.doc_session as _ds
    monkeypatch.setattr(_ds, "CHAT_DIR", chats)
    import config as _cfg
    monkeypatch.setattr(_cfg, "DEFAULT_PROJECT_DIR", str(tmp_path / "projects" / "默认项目"))
    _mk_session(chats, "s1", proj)
    return {"chats": chats, "proj": proj, "sid": "s1"}


def _mk_session(chats, name, proj_dir):
    d = os.path.join(chats, name)
    os.makedirs(d, exist_ok=True)
    meta = {"id": name, "title": name, "project_dir": proj_dir,
            "created_at": "2026-09-04 10:00:00", "updated_at": "2026-09-04 10:00:00",
            "message_count": 0, "version": 3}
    with open(os.path.join(d, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False)


def _read(path):
    return open(path, encoding="utf-8").read()


class TestPathGuard:
    def test_absolute_rejected(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        r = pw.write_file(sandbox["sid"], "C:/Windows/evil.txt", "x")
        assert r["ok"] is False and r["error"] == "path_violation"

    def test_traversal_rejected(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        r = pw.write_file(sandbox["sid"], "../escape.txt", "x")
        assert r["ok"] is False and r["error"] == "path_violation"
        r2 = pw.write_file(sandbox["sid"], "a/../../escape.txt", "x")
        assert r2["ok"] is False

    def test_sidemate_rejected(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        r = pw.write_file(sandbox["sid"], ".sidemate/log.jsonl", "x")
        assert r["ok"] is False and "sidemate" in r["message"]

    def test_empty_rejected(self, sandbox):
        assert pw.write_file(sandbox["sid"], "", "x")["ok"] is False


class TestPlanMode:
    def test_plan_mode_registers_not_writes(self, sandbox):
        """默认 plan 模式：写入只登记，磁盘无文件。"""
        r = pw.write_file(sandbox["sid"], "报告/周报.md", "# 周报")
        assert r["ok"] is False and r["error"] == "plan_mode" and r["pending"] is True
        assert not os.path.exists(os.path.join(sandbox["proj"], "报告", "周报.md"))
        st = pw.get_harness_state(sandbox["sid"])
        assert st["pending_plan"][0]["path"] == "报告/周报.md"
        assert st["pending_plan"][0]["overwrite"] is False

    def test_pending_overwrite_flag(self, sandbox):
        """覆盖已有文件的计划条目带 overwrite=True（计划卡标红的数据源）。"""
        existing = os.path.join(sandbox["proj"], "旧文件.md")
        open(existing, "w", encoding="utf-8").write("旧内容")
        pw.write_file(sandbox["sid"], "旧文件.md", "新内容")
        st = pw.get_harness_state(sandbox["sid"])
        assert st["pending_plan"][0]["overwrite"] is True

    def test_pending_dedup_by_path(self, sandbox):
        pw.write_file(sandbox["sid"], "a.md", "v1")
        pw.write_file(sandbox["sid"], "a.md", "v2")
        st = pw.get_harness_state(sandbox["sid"])
        assert len(st["pending_plan"]) == 1

    def test_discard_plan(self, sandbox):
        pw.write_file(sandbox["sid"], "a.md", "v1")
        r = pw.discard_plan(sandbox["sid"])
        assert r["ok"] and r["cleared"] == 1
        assert pw.get_harness_state(sandbox["sid"])["pending_plan"] == []


class TestExecuteMode:
    def test_write_new_file(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        r = pw.write_file(sandbox["sid"], "产物/方案.md", "# 方案", note="初稿")
        assert r["ok"] and not r["overwritten"] and not r["backed_up"]
        assert _read(os.path.join(sandbox["proj"], "产物", "方案.md")) == "# 方案"
        # log.jsonl 记账
        log_lines = open(os.path.join(sandbox["proj"], ".sidemate", "log.jsonl"),
                         encoding="utf-8").read().splitlines()
        entry = json.loads(log_lines[-1])
        assert entry["action"] == "write" and entry["path"] == "产物/方案.md"
        assert entry["note"] == "初稿"

    def test_overwrite_backed_up(self, sandbox):
        target = os.path.join(sandbox["proj"], "报告.md")
        open(target, "w", encoding="utf-8").write("旧版")
        pw.set_exec_mode(sandbox["sid"], "execute")
        r = pw.write_file(sandbox["sid"], "报告.md", "新版")
        assert r["ok"] and r["overwritten"] and r["backed_up"]
        assert _read(target) == "新版"
        vdir = os.path.join(sandbox["proj"], ".sidemate", "versions", "报告.md")
        backups = os.listdir(vdir)
        assert len(backups) == 1
        assert _read(os.path.join(vdir, backups[0])) == "旧版"

    def test_write_clears_pending(self, sandbox):
        pw.write_file(sandbox["sid"], "a.md", "x")  # plan 登记
        pw.set_exec_mode(sandbox["sid"], "execute")
        pw.write_file(sandbox["sid"], "a.md", "x")  # 执行
        assert pw.get_harness_state(sandbox["sid"])["pending_plan"] == []


class TestUndo:
    def test_undo_overwrite_restores(self, sandbox):
        target = os.path.join(sandbox["proj"], "报告.md")
        open(target, "w", encoding="utf-8").write("旧版")
        pw.set_exec_mode(sandbox["sid"], "execute")
        pw.write_file(sandbox["sid"], "报告.md", "新版")
        r = pw.undo_last_write(sandbox["sid"])
        assert r["ok"] and r["result"] == "restored"
        assert _read(target) == "旧版"

    def test_undo_new_file_removes(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        pw.write_file(sandbox["sid"], "新建.md", "内容")
        r = pw.undo_last_write(sandbox["sid"])
        assert r["ok"] and r["result"] == "removed"
        assert not os.path.exists(os.path.join(sandbox["proj"], "新建.md"))

    def test_undo_without_writes(self, sandbox):
        r = pw.undo_last_write(sandbox["sid"])
        assert r["ok"] is False


class TestScanChanges:
    def test_external_changes_detected_once(self, sandbox):
        pw.set_exec_mode(sandbox["sid"], "execute")
        pw.write_file(sandbox["sid"], "a.md", "v1")
        # AI 写完立刻扫描：自己的写入不误报
        assert pw.scan_changes(sandbox["sid"]) is None
        # 外部修改
        open(os.path.join(sandbox["proj"], "a.md"), "w", encoding="utf-8").write("用户改的")
        chg = pw.scan_changes(sandbox["sid"])
        assert chg and "a.md" in chg["changed"]
        # 扫描后 manifest 已更新——再扫不报
        assert pw.scan_changes(sandbox["sid"]) is None

    def test_external_add_remove(self, sandbox):
        pw.scan_changes(sandbox["sid"])  # 基线
        open(os.path.join(sandbox["proj"], "外部新增.txt"), "w").write("x")
        chg = pw.scan_changes(sandbox["sid"])
        assert "外部新增.txt" in chg["added"]
        os.remove(os.path.join(sandbox["proj"], "外部新增.txt"))
        chg2 = pw.scan_changes(sandbox["sid"])
        assert "外部新增.txt" in chg2["removed"]


class TestHarnessStateAndInjection:
    def test_exec_mode_validation(self, sandbox):
        assert pw.set_exec_mode(sandbox["sid"], "bogus")["ok"] is False
        assert pw.set_exec_mode(sandbox["sid"], "execute")["ok"] is True
        assert pw.get_harness_state(sandbox["sid"])["exec_mode"] == "execute"

    def test_goal(self, sandbox):
        pw.set_goal(sandbox["sid"], "写完季度汇报 PPT")
        assert pw.get_harness_state(sandbox["sid"])["goal"] == "写完季度汇报 PPT"

    def test_injection_goal_and_pending(self, sandbox):
        pw.set_goal(sandbox["sid"], "整理项目材料")
        pw.write_file(sandbox["sid"], "汇总.md", "x")  # plan 登记
        out = at._inject_session_context(chat_id=sandbox["sid"], kb=None,
                                         base_prompt="BASE", kb_tag_str="", history=None)
        assert "[当前任务目标] 整理项目材料" in out
        assert "[待执行计划" in out and "汇总.md" in out

    def test_injection_external_change_notice(self, sandbox):
        pw.scan_changes(sandbox["sid"])  # 基线
        open(os.path.join(sandbox["proj"], "用户手改.md"), "w").write("x")
        out = at._inject_session_context(chat_id=sandbox["sid"], kb=None,
                                         base_prompt="BASE", kb_tag_str="", history=None)
        assert "[项目目录变更" in out and "用户手改.md" in out
