# -*- coding: utf-8 -*-
"""P0 #43：在线调用失败静默——错误持久化 + 测试连接修复（先红后绿）。

场景来源：PM 实测 rc.6——Anthropic 协议 404 后会话内无任何留存，
错误提示闪现即逝；「测试连接」不分协议 GET /v1/models 两头失真。
"""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pipelines._base as pbase
import core.anthropic_adapter as ant


# ---------------------------------------------------------------- persist_error_turn
class _CtxStub:
    """persist_turn 需要的最小 StreamContext 形状。"""
    def __init__(self, chat_file, ai_mode="cloud", model_choice="deepseek-flash"):
        self.chat_file = chat_file
        self.ai_mode = ai_mode
        self.model_choice = model_choice
        self.message = "什么是刮五指？"
        self.user_msg_saved = True
        self.user_msg_id = -1
        self.history_raw = []
        self.body = {}


class TestErrorTurnPersisted(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="p0err_")
        self.chat_file = os.path.join(self.tmp, "chat.json")
        # 命名钩子会真调 LLM（run_text_once），单测必须掐掉
        import pipelines as _pl
        self._orig_name = getattr(_pl, "auto_name_if_default", None)
        _pl.auto_name_if_default = lambda *a, **k: None

    def tearDown(self):
        import pipelines as _pl
        if self._orig_name is not None:
            _pl.auto_name_if_default = self._orig_name

    def _seed_user_msg(self):
        from session.chat_store import append_message
        append_message(self.chat_file, {"role": "user", "content": "hi", "ts": "20:00:00"})

    def test_error_turn_written_to_history(self):
        """在线失败必须落一条 assistant 错误消息，刷新/切换会话后仍在。"""
        self._seed_user_msg()
        ctx = _CtxStub(self.chat_file)
        pbase.persist_error_turn(
            ctx, "在线 AI 调用失败：Anthropic API 错误（404）",
            error_type="api_error", detail="端点不存在")
        from session.chat_store import load_chat
        msgs = load_chat(self.chat_file)
        errs = [m for m in msgs if m.get("role") == "assistant" and m.get("task_type") == "error"]
        self.assertTrue(errs, "错误回合未落盘——在线失败仍然静默")
        m = errs[-1]
        self.assertIn("404", m.get("content", ""))
        self.assertEqual(m.get("engine"), "cloud")

    def test_persist_error_survives_reload(self):
        """落盘后的错误消息重读仍在（模拟刷新会话）。"""
        self.test_error_turn_written_to_history()
        from session.chat_store import load_chat
        again = load_chat(self.chat_file)
        self.assertTrue([m for m in again if m.get("task_type") == "error"])


# ---------------------------------------------------------------- 管道分支守卫（静态）
class TestPipelineErrorBranchesGuard(unittest.TestCase):
    """cloud_pipeline 所有终止性 error 分支必须调用 persist_error_turn（防回归哨兵）。"""

    def test_cloud_pipeline_error_branches_persist(self):
        src = Path(pbase.__file__).parent.joinpath("cloud_pipeline.py").read_text(encoding="utf-8")
        # error SSE 事件出现次数（终止性分支）
        sse_errors = src.count('sse_event("error"')
        persists = src.count("persist_error_turn")
        self.assertGreaterEqual(persists, sse_errors,
            "cloud_pipeline 存在只发 SSE 不落盘的 error 分支（%d 个 SSE error vs %d 处落盘）"
            % (sse_errors, persists))

    def test_local_not_ready_gate_persists(self):
        """chat.py 本地模型加载失败 gate 同样不留无痕回合。"""
        src = Path(pbase.__file__).parents[1].joinpath("routers", "chat.py").read_text(encoding="utf-8")
        anchor = src.find("_lz_ok")
        seg = src[anchor:anchor + 900]
        self.assertIn("persist_error_turn", seg, "local gate 失败未落错误消息")


# ---------------------------------------------------------------- anthropic test_connection
class _FakeResp:
    def __init__(self, status_code, body=""):
        self.status_code = status_code
        self._body = body
        self.request = type("R", (), {"url": "x"})()

    def read(self):
        return self._body.encode("utf-8", "replace")

    @property
    def text(self):
        return self._body

    def json(self):
        return json.loads(self._body or "{}")


class _FakeStreamCtx:
    def __init__(self, resp):
        self._resp = resp

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_lines(self):
        yield ""


class _FakeClient:
    """记录请求方法/URL/body，按预设回放响应。"""
    resp = _FakeResp(200, "{}")
    calls = []

    def __init__(self, *a, **kw):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def get(self, url, headers=None):
        _FakeClient.calls.append(("GET", url, None))
        return _FakeClient.resp

    def post(self, url, headers=None, json=None):
        _FakeClient.calls.append(("POST", url, json))
        return _FakeClient.resp

    def stream(self, method, url, headers=None, json=None):
        _FakeClient.calls.append((method, url, json))
        return _FakeStreamCtx(_FakeClient.resp)


class TestAnthropicTestConnection(unittest.TestCase):
    def setUp(self):
        self._real = ant.httpx.Client
        ant.httpx.Client = _FakeClient
        _FakeClient.calls = []

    def tearDown(self):
        ant.httpx.Client = self._real

    def test_uses_real_messages_request(self):
        """有模型时必须真发最小 messages 请求（PM 两步测试的「模型测试」），不再 GET /v1/models。"""
        _FakeClient.resp = _FakeResp(200, json.dumps(
            {"type": "message", "content": [], "usage": {}}))
        ok, latency, err = ant.test_connection(
            "https://api.deepseek.com/anthropic", "sk-test", model="deepseek-flash")
        self.assertTrue(ok, "200 应判成功: %s" % err)
        method, url, body = _FakeClient.calls[-1]
        self.assertEqual(method, "POST")
        self.assertTrue(url.endswith("/v1/messages"), "应 POST {base}/v1/messages，实际 %s" % url)
        self.assertEqual(body.get("max_tokens"), 1)

    def test_404_gives_actionable_error(self):
        """404 必须给出可操作提示（检查地址与协议组合），而不是空 detail。"""
        _FakeClient.resp = _FakeResp(404, "")
        ok, latency, err = ant.test_connection(
            "https://api.deepseek.com", "sk-test", model="deepseek-flash")
        self.assertFalse(ok)
        self.assertIn("404", str(err))
        self.assertTrue(str(err).strip().endswith(("。", "）", "】", "：", "！"))
                        or len(str(err).strip()) > len("Anthropic API 错误（404）: "),
                        "404 错误详情为空（闪没后无从排障）: %r" % err)

    def test_401_gives_key_hint(self):
        _FakeClient.resp = _FakeResp(401, json.dumps({"error": {"message": "Authentication Fails"}}))
        ok, latency, err = ant.test_connection(
            "https://api.deepseek.com/anthropic", "sk-bad", model="deepseek-flash")
        self.assertFalse(ok)
        self.assertIn("Key", str(err))


# ---------------------------------------------------------------- cfNote 位置守卫
class TestNotePlacementGuard(unittest.TestCase):
    def test_cfnote_below_buttons(self):
        """测试/保存反馈必须紧邻按钮行（曾在分组最底部，隔 300px 用户看不见）。"""
        src = Path(pbase.__file__).parents[1].joinpath(
            "static", "js", "v2", "settings.js").read_text(encoding="utf-8")
        self.assertIn('id="cfNote"', src)
        i_btn = src.find('class="pv-acts-row"')
        i_note = src.find('id="cfNote"')
        i_sep = src.find('class="pv-sep"', i_btn)
        self.assertTrue(0 <= i_btn < i_note < i_sep,
                        "cfNote 应位于按钮行（pv-acts-row）与分隔线之间，现在位置不对")


# ---------------------------------------------------------------- 404 空 detail 兜底
class TestDetailFallback(unittest.TestCase):
    def test_error_str_not_empty_tail(self):
        e = ant.AnthropicAPIError("Anthropic API 错误（404）: ", status_code=404)
        msg = ant.friendly_error_detail(e)
        self.assertTrue(msg.strip(), "空 detail 必须兜底成可读文案")


if __name__ == "__main__":
    unittest.main(verbosity=2)
