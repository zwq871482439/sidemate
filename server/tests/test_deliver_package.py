# -*- coding: utf-8 -*-
"""M2-4 deliver_package 成果包测试（agent_loop 分支）

覆盖：
- 默认打包：工作区根下全部交付物（docx/xlsx/pptx/html/md/txt/csv）进 zip，
  子目录工程文件（ppt/svg_output）不进包
- 显式 files 清单：只打指定文件；不存在的文件报错
- 无产物时报错（no_artifacts）
- 标题特殊字符清洗

注意：doc_session 的 _workspace_root/list_workspace_files 隔离到 tmp。
"""
import json
import os
import zipfile

import pytest

import core.agent_loop as al
from collections import defaultdict


@pytest.fixture()
def ws(tmp_path, monkeypatch):
    ws_root = tmp_path / "ws"
    ws_root.mkdir()
    # 造几个交付物 + 一个工程中间件目录
    (ws_root / "报告.docx").write_bytes(b"doc")
    (ws_root / "数据.xlsx").write_bytes(b"xls")
    (ws_root / "汇报.pptx").write_bytes(b"ppt")
    (ws_root / "说明.md").write_text("# 说明", encoding="utf-8")
    (ws_root / "笔记.json").write_text("{}", encoding="utf-8")  # 非交付物
    (ws_root / "ppt").mkdir()
    (ws_root / "ppt" / "deck.svg").write_text("<svg/>", encoding="utf-8")  # 工程文件
    import core.doc_session as _ds
    monkeypatch.setattr(_ds, "_workspace_root", lambda cid: str(ws_root))
    monkeypatch.setattr(_ds, "list_workspace_files", lambda cid: [
        {"name": f, "size": 1} for f in os.listdir(str(ws_root))
    ])
    return ws_root


def _loop():
    return al.AgentLoop(cloud_engine=None, search_engine=None, kb=None,
                        chat_id="t1", history=None)


class TestDeliverPackage:
    def test_default_pack(self, ws):
        r = _loop()._execute_tool("deliver_package", {"title": "周报收付"}, defaultdict(int))
        assert r["success"] is True
        zip_path = ws / "周报收付.zip"
        assert zip_path.exists()
        names = zipfile.ZipFile(str(zip_path)).namelist()
        assert set(names) == {"报告.docx", "数据.xlsx", "汇报.pptx", "说明.md"}
        # json 非交付物、ppt/ 工程目录不进包
        assert "笔记.json" not in names and not any(n.startswith("ppt/") or n.startswith("ppt\\") for n in names)

    def test_explicit_files(self, ws):
        r = _loop()._execute_tool("deliver_package",
                                  {"title": "精选", "files": ["报告.docx", "说明.md"]},
                                  defaultdict(int))
        names = zipfile.ZipFile(str(ws / "精选.zip")).namelist()
        assert set(names) == {"报告.docx", "说明.md"}

    def test_missing_file_rejected(self, ws):
        r = _loop()._execute_tool("deliver_package",
                                  {"title": "x", "files": ["不存在.docx"]},
                                  defaultdict(int))
        assert r["success"] is False and r["error"] == "files_missing"

    def test_no_artifacts(self, tmp_path, monkeypatch):
        empty = tmp_path / "empty"
        empty.mkdir()
        import core.doc_session as _ds
        monkeypatch.setattr(_ds, "_workspace_root", lambda cid: str(empty))
        monkeypatch.setattr(_ds, "list_workspace_files", lambda cid: [])
        r = _loop()._execute_tool("deliver_package", {"title": "空包"}, defaultdict(int))
        assert r["success"] is False and r["error"] == "no_artifacts"

    def test_title_sanitized(self, ws):
        r = _loop()._execute_tool("deliver_package", {"title": 'a/b:c*d"e"'}, defaultdict(int))
        assert r["success"]
        assert "/" not in r["data"]["name"] and ":" not in r["data"]["name"]
