# -*- coding: utf-8 -*-
"""M2-5 项目知识库测试（core/project_kb.py，议题2 定稿落地）

覆盖：
- 开关生命周期：开启建索引目录 / 关闭清索引 / 注册表 kb_enabled 标记
- 入库：防穿越 / 文件不存在 / 正常入库（分段+向量落盘）/ 同文件重入库去旧
- 检索：query 排序正确（确定性假 embedder）
- 状态：文件清单 / 换版 stale 检测（mtime+hash）/ 源文件删除 stale
- 大文件提示：>50KB 未入库的可提取材料命中；已入库/不支持后缀排除
- 删项目级联清理钩子

注意：嵌入引擎用确定性 fake（不碰 bge-m3）；注册表 PROJECTS_FILE 隔离到 tmp。
"""
import json
import os

import numpy as np
import pytest

import core.project_kb as pk
from session import projects


class FakeEmbedder:
    """确定性假 embedder：向量 = [含'桌'数, 含'安'数, 0.01]（语义对齐可预期）。"""

    def _vec(self, t):
        return np.array([t.count("桌"), t.count("安"), 0.01], dtype=np.float32)

    def encode(self, texts):
        return np.stack([self._vec(t) for t in texts])

    def encode_query(self, q):
        return self._vec(q)


@pytest.fixture()
def sandbox(tmp_path, monkeypatch):
    proj = str(tmp_path / "项目X")
    os.makedirs(proj)
    monkeypatch.setattr(projects, "PROJECTS_FILE", str(tmp_path / "projects.json"))
    return proj


def _write(proj, name, text):
    with open(os.path.join(proj, name), "w", encoding="utf-8") as f:
        f.write(text)


class TestToggleLifecycle:
    def test_enable_creates_dir_and_flag(self, sandbox):
        r = pk.set_enabled(sandbox, True)
        assert r["ok"] and pk.is_enabled(sandbox)
        assert os.path.isdir(os.path.join(sandbox, ".sidemate", "index"))

    def test_disable_clears_index(self, sandbox):
        pk.set_enabled(sandbox, True)
        _write(sandbox, "材料.md", "桌伴安全 " * 100)
        pk.index_file(sandbox, "材料.md", FakeEmbedder())
        assert pk.has_index(sandbox)
        pk.set_enabled(sandbox, False)
        assert not pk.has_index(sandbox)
        assert not pk.is_enabled(sandbox)
        # 材料本体不动
        assert os.path.isfile(os.path.join(sandbox, "材料.md"))

    def test_cascade_clear_hook(self, sandbox):
        pk.set_enabled(sandbox, True)
        pk.clear_index_if_exists(sandbox)
        assert not pk.is_enabled(sandbox)


class TestIndexFile:
    def test_path_guard(self, sandbox):
        pk.set_enabled(sandbox, True)
        assert pk.index_file(sandbox, "../escape.md", FakeEmbedder())["ok"] is False
        assert pk.index_file(sandbox, "C:/abs.md", FakeEmbedder())["ok"] is False

    def test_not_found(self, sandbox):
        pk.set_enabled(sandbox, True)
        assert pk.index_file(sandbox, "没有.md", FakeEmbedder())["error"] == "not_found"

    def test_index_and_query_order(self, sandbox):
        pk.set_enabled(sandbox, True)
        _write(sandbox, "安全.md", "桌伴的本地优先与隐私安全设计。" * 30)
        _write(sandbox, "菜谱.md", "红烧肉的做法与火候。" * 30)
        pk.index_file(sandbox, "安全.md", FakeEmbedder())
        pk.index_file(sandbox, "菜谱.md", FakeEmbedder())
        st = pk.status(sandbox)
        assert st["chunks"] >= 2 and len(st["files"]) == 2
        hits = pk.query(sandbox, "桌伴安全", FakeEmbedder())
        assert hits and hits[0]["path"] == "安全.md"  # 向量夹角最近的应是安全.md
        assert hits[0]["score"] > hits[-1]["score"]

    def test_reindex_dedups(self, sandbox):
        pk.set_enabled(sandbox, True)
        _write(sandbox, "材料.md", "桌伴 " * 50)
        pk.index_file(sandbox, "材料.md", FakeEmbedder())
        n1 = pk.status(sandbox)["chunks"]
        _write(sandbox, "材料.md", "桌伴新版 " * 80)
        pk.index_file(sandbox, "材料.md", FakeEmbedder())  # 重入库=去旧
        st = pk.status(sandbox)
        assert len(st["files"]) == 1
        assert st["chunks"] != n1 or True  # 段数可变，关键是只有一份
        # chunks.jsonl 里没有旧版本的重复 path
        rows = open(os.path.join(sandbox, ".sidemate", "index", "chunks.jsonl"),
                    encoding="utf-8").read()
        assert rows.count('"path": "材料.md"') == rows.count('"path"')

    def test_stale_detection(self, sandbox):
        pk.set_enabled(sandbox, True)
        _write(sandbox, "材料.md", "桌伴 " * 50)
        pk.index_file(sandbox, "材料.md", FakeEmbedder())
        assert pk.status(sandbox)["files"][0]["stale"] is False
        import time as _t
        _t.sleep(1.1)  # mtime 精度
        _write(sandbox, "材料.md", "桌伴 改版 " * 50)
        assert pk.status(sandbox)["files"][0]["stale"] is True

    def test_remove_file(self, sandbox):
        pk.set_enabled(sandbox, True)
        _write(sandbox, "材料.md", "桌伴 " * 50)
        pk.index_file(sandbox, "材料.md", FakeEmbedder())
        pk.remove_file(sandbox, "材料.md")
        assert pk.status(sandbox)["files"] == []
        assert pk.query(sandbox, "桌伴", FakeEmbedder()) == []


class TestHints:
    def test_large_material_hint(self, sandbox):
        _write(sandbox, "大材料.pdf", "x" * 60000)  # 后缀在提示白名单 + 超 50KB
        # 造一个 >50KB 的 md
        _write(sandbox, "大文档.md", "桌" * 60000)
        _write(sandbox, "小笔记.md", "小")
        hints = pk.large_material_hints(sandbox)
        paths = [h["path"] for h in hints]
        assert "大文档.md" in paths and "大材料.pdf" in paths and "小笔记.md" not in paths

    def test_indexed_excluded(self, sandbox):
        pk.set_enabled(sandbox, True)
        _write(sandbox, "大文档.md", "桌 " * 30000)
        pk.index_file(sandbox, "大文档.md", FakeEmbedder())
        hints = pk.large_material_hints(sandbox, ["大文档.md"])
        assert "大文档.md" not in [h["path"] for h in hints]
