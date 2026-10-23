# -*- coding: utf-8 -*-
"""0.11.1 GA 收尾三修复的用例（dispatch 2026-10-14-1 任务 1/2/3）

- #45 中文安装路径下离线模型加载：_launch_process 的 cwd/短路径策略
- #43 带出：错误回合（task_type=error）不进模型历史
- #52 带出：_html_to_pdf/_md_to_pdf 返回值补 dst_name/src_format/dst_format
"""
import os
import subprocess
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core.llamacpp_backend.manager import LlamaCppManager  # noqa: E402
from session.context_cache import clean_history_for_model  # noqa: E402


class _FakePopen:
    pid = 4242

    def __init__(self):
        self.cmd = None
        self.kwargs = None

    def __call__(self, cmd, **kwargs):
        self.cmd = cmd
        self.kwargs = kwargs
        return self

    def poll(self):
        return None


def _mk_manager(monkeypatch, fake_popen):
    m = LlamaCppManager(llama_server_path="llama-server")
    monkeypatch.setattr(
        "core.llamacpp_backend.manager.subprocess.Popen", fake_popen)
    return m


# ---------- 任务 1：中文路径下 llama-server 启动参数 ----------

def test_ascii_path_launch_unchanged(monkeypatch):
    """纯 ASCII 路径：行为不变——--model 传完整路径、不设 cwd"""
    fp = _FakePopen()
    m = _mk_manager(monkeypatch, fp)
    m._launch_process(r"C:\Sidemate\models\qwen.gguf")
    args = fp.kwargs
    assert fp.cmd[fp.cmd.index("--model") + 1] == r"C:\Sidemate\models\qwen.gguf"
    assert args.get("cwd") is None
    assert m._current_model == r"C:\Sidemate\models\qwen.gguf"


def test_cjk_dir_ascii_filename_uses_cwd_and_basename(monkeypatch):
    """目录含中文、文件名 ASCII：cwd=模型目录、--model 只传文件名；
    _current_model/_restart_model 仍存完整路径（EXTERNAL 复用/重启匹配不变）"""
    fp = _FakePopen()
    m = _mk_manager(monkeypatch, fp)
    full = r"C:\Users\张三\Sidemate\models\qwen3.5-4b-q4.gguf"
    m._launch_process(full)
    assert fp.cmd[fp.cmd.index("--model") + 1] == "qwen3.5-4b-q4.gguf"
    assert fp.kwargs.get("cwd") == r"C:\Users\张三\Sidemate\models"
    assert m._current_model == full
    assert m._restart_model == full


def test_cjk_filename_falls_back_to_short_path(monkeypatch):
    """文件名也含中文：退回 GetShortPathNameW 8.3 短路径（cwd 不设）"""
    fp = _FakePopen()
    m = _mk_manager(monkeypatch, fp)
    monkeypatch.setattr(
        "core.llamacpp_backend.manager._windows_short_path",
        lambda p: r"C:\Users\~1\Sidemate\MODEL~1.GGU")
    full = r"C:\Users\张三\Sidemate\models\千问模型.gguf"
    m._launch_process(full)
    assert fp.cmd[fp.cmd.index("--model") + 1] == r"C:\Users\~1\Sidemate\MODEL~1.GGU"
    assert fp.kwargs.get("cwd") is None
    assert m._current_model == full


def test_short_path_unavailable_raises_actionable_error(monkeypatch, tmp_path):
    """短路径拿不到（8.3 被禁）：报错含『请安装到英文路径』，
    start() 转为 error 结果、不起进程"""
    fp = _FakePopen()
    m = _mk_manager(monkeypatch, fp)
    monkeypatch.setattr(
        "core.llamacpp_backend.manager._windows_short_path", lambda p: None)
    d = tmp_path / "模型目录"
    d.mkdir()
    f = d / "模型.gguf"
    f.write_bytes(b"x" * 16)
    result = m.start(str(f))
    assert result["status"] == "error"
    assert "英文路径" in result["error"]
    assert fp.cmd is None  # 没有真正 Popen


# ---------- 任务 2：错误回合不进模型历史 ----------

def _hist():
    return [
        {"role": "user", "content": "第一问"},
        {"role": "assistant", "content": "第一答"},
        {"role": "user", "content": "第二问"},
        {"role": "assistant", "content": "在线 AI 调用失败：连接超时",
         "task_type": "error"},
        {"role": "user", "content": "第三问"},
        {"role": "assistant", "content": "第三答"},
    ]


def test_error_turn_excluded_from_model_history(monkeypatch):
    monkeypatch.setattr("session.context_cache.get_mgr", lambda: object())
    cleaned = clean_history_for_model(_hist(), max_rounds=10, ai_mode=None)
    assert all("调用失败" not in m["content"] for m in cleaned)
    assert [m["content"] for m in cleaned] == ["第一问", "第一答", "第二问", "第三问", "第三答"]


def test_normal_history_unaffected(monkeypatch):
    monkeypatch.setattr("session.context_cache.get_mgr", lambda: object())
    cleaned = clean_history_for_model(_hist()[:2], max_rounds=10, ai_mode=None)
    assert [m["content"] for m in cleaned] == ["第一问", "第一答"]


# ---------- 任务 3：PDF 转换返回值补字段 ----------

def test_html_to_pdf_return_has_name_and_formats(tmp_path):
    from core import file_converter as fc
    src = tmp_path / "报告.html"
    src.write_text("<html><body><h1>标题</h1><p>内容内容内容</p></body></html>",
                   encoding="utf-8")
    dst = tmp_path / "报告.pdf"
    r = fc.convert(str(src), str(dst))
    assert r["ok"] is True, r.get("error")
    assert r["dst_name"] == "报告.pdf"
    assert r["src_format"] == "html"
    assert r["dst_format"] == "pdf"


def test_md_to_pdf_return_has_md_src_format(tmp_path):
    from core import file_converter as fc
    src = tmp_path / "笔记.md"
    src.write_text("# 标题\n\n正文段落一。\n", encoding="utf-8")
    dst = tmp_path / "笔记.pdf"
    r = fc.convert(str(src), str(dst))
    assert r["ok"] is True, r.get("error")
    assert r["src_format"] == "md"
    assert r["dst_format"] == "pdf"
    assert r["dst_name"] == "笔记.pdf"
