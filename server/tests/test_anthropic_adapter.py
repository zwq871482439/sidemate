# -*- coding: utf-8 -*-
"""test_anthropic_adapter.py — P8-1 Anthropic 适配器纯单测（无网络）

覆盖：
  1. URL 拼接（带/不带 /v1、尾斜杠、空值）
  2. convert_messages：system 合并 / tool_calls 块 / tool_result 合并 / 角色交替 / 首条必须 user
  3. convert_tools：FC → input_schema
  4. build_request_body：max_tokens 必填、system 顶层、tools 挂载
  5. iter_stream_events：模拟 SSE 流解析（text / thinking / tool_use 增量 / usage / stop_reason）
  6. HTTP 错误 → AnthropicAPIError(status_code)
"""
import os
import sys
import json
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from core import anthropic_adapter as ant


class FakeStreamResponse:
    """模拟 httpx stream 的响应对象（同步上下文管理器 + iter_lines）"""

    def __init__(self, lines, status_code=200, body=b""):
        self._lines = lines
        self.status_code = status_code
        self._body = body
        self.text = body.decode("utf-8", "replace") if body else ""

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_lines(self):
        return iter(self._lines)

    def read(self):
        return self._body


class FakeClient:
    """模拟 httpx.Client（P8-7 后适配器改为显式 Client + trust_env）"""

    def __init__(self, lines, status_code=200, body=b""):
        self._resp = FakeStreamResponse(lines, status_code, body)

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def stream(self, *a, **kw):
        return self._resp


def _sse(events):
    """把 [(event, data_dict), ...] 编成 SSE 行序列"""
    lines = []
    for ev, data in events:
        lines.append("event: %s" % ev)
        lines.append("data: %s" % json.dumps(data, ensure_ascii=False))
        lines.append("")
    return lines


class TestUrl(unittest.TestCase):
    def test_base_without_v1(self):
        self.assertEqual(ant.build_messages_url("https://api.anthropic.com"),
                         "https://api.anthropic.com/v1/messages")

    def test_base_with_v1(self):
        self.assertEqual(ant.build_messages_url("https://api.anthropic.com/v1"),
                         "https://api.anthropic.com/v1/messages")

    def test_trailing_slash(self):
        self.assertEqual(ant.build_messages_url("https://proxy.example.com/"),
                         "https://proxy.example.com/v1/messages")

    def test_empty_base(self):
        self.assertEqual(ant.build_messages_url(""),
                         "https://api.anthropic.com/v1/messages")


class TestConvertMessages(unittest.TestCase):
    def test_system_extracted(self):
        system, msgs = ant.convert_messages([
            {"role": "system", "content": "你是助手"},
            {"role": "user", "content": "hi"},
        ])
        self.assertEqual(system, "你是助手")
        self.assertEqual(msgs, [{"role": "user", "content": "hi"}])

    def test_multiple_system_joined(self):
        system, _ = ant.convert_messages([
            {"role": "system", "content": "A"},
            {"role": "system", "content": "B"},
            {"role": "user", "content": "hi"},
        ])
        self.assertEqual(system, "A\n\nB")

    def test_assistant_tool_calls(self):
        _, msgs = ant.convert_messages([
            {"role": "user", "content": "查一下"},
            {"role": "assistant", "content": "我来查",
             "tool_calls": [{"id": "call_1", "type": "function",
                             "function": {"name": "search_web", "arguments": '{"q":"x"}'}}]},
        ])
        asst = msgs[1]
        self.assertEqual(asst["role"], "assistant")
        blocks = asst["content"]
        self.assertEqual(blocks[0], {"type": "text", "text": "我来查"})
        self.assertEqual(blocks[1]["type"], "tool_use")
        self.assertEqual(blocks[1]["id"], "call_1")
        self.assertEqual(blocks[1]["name"], "search_web")
        self.assertEqual(blocks[1]["input"], {"q": "x"})

    def test_tool_results_merged_into_user(self):
        _, msgs = ant.convert_messages([
            {"role": "user", "content": "查一下"},
            {"role": "assistant", "content": "",
             "tool_calls": [{"id": "c1", "function": {"name": "f", "arguments": "{}"}},
                            {"id": "c2", "function": {"name": "g", "arguments": "{}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "结果1"},
            {"role": "tool", "tool_call_id": "c2", "content": "结果2"},
        ])
        # 两条连续 tool 合并为一个 user 消息
        tool_msg = msgs[2]
        self.assertEqual(tool_msg["role"], "user")
        self.assertEqual(len(tool_msg["content"]), 2)
        self.assertEqual(tool_msg["content"][0]["type"], "tool_result")
        self.assertEqual(tool_msg["content"][0]["tool_use_id"], "c1")
        self.assertEqual(tool_msg["content"][1]["tool_use_id"], "c2")

    def test_first_must_be_user(self):
        _, msgs = ant.convert_messages([
            {"role": "assistant", "content": "你好"},
        ])
        self.assertEqual(msgs[0]["role"], "user")

    def test_bad_arguments_json_fallback(self):
        _, msgs = ant.convert_messages([
            {"role": "user", "content": "x"},
            {"role": "assistant", "content": "",
             "tool_calls": [{"id": "c1", "function": {"name": "f", "arguments": "{broken"}}]},
        ])
        blocks = msgs[1]["content"]
        # arguments 不是合法 JSON 时不崩溃，input 落为 dict
        self.assertIsInstance(blocks[0]["input"], dict)


class TestConvertTools(unittest.TestCase):
    def test_fc_to_input_schema(self):
        tools = ant.convert_tools([
            {"type": "function", "function": {
                "name": "search_web",
                "description": "搜索",
                "parameters": {"type": "object", "properties": {"q": {"type": "string"}}},
            }},
        ])
        self.assertEqual(len(tools), 1)
        self.assertEqual(tools[0]["name"], "search_web")
        self.assertEqual(tools[0]["input_schema"]["properties"]["q"]["type"], "string")
        self.assertNotIn("type", {k: v for k, v in tools[0].items() if k == "type"})

    def test_empty_tools(self):
        self.assertEqual(ant.convert_tools([]), [])
        self.assertEqual(ant.convert_tools(None), [])


class TestBuildBody(unittest.TestCase):
    def test_required_fields(self):
        body = ant.build_request_body("claude-sonnet-4-5", [
            {"role": "system", "content": "S"},
            {"role": "user", "content": "hi"},
        ], max_tokens=1024)
        self.assertEqual(body["model"], "claude-sonnet-4-5")
        self.assertEqual(body["max_tokens"], 1024)  # Anthropic 必填
        self.assertEqual(body["system"], "S")
        self.assertTrue(body["stream"])
        self.assertEqual(body["messages"], [{"role": "user", "content": "hi"}])


class TestStreamEvents(unittest.TestCase):
    def _run(self, events, **kwargs):
        lines = _sse(events)
        with patch("httpx.Client", lambda **kw: FakeClient(lines)):
            return list(ant.iter_stream_events(
                "https://api.anthropic.com", "sk-ant-x", "claude-sonnet-4-5",
                [{"role": "user", "content": "hi"}], max_tokens=100, **kwargs))

    def test_text_flow(self):
        evs = self._run([
            ("message_start", {"message": {"usage": {"input_tokens": 12}}}),
            ("content_block_start", {"index": 0, "content_block": {"type": "text", "text": ""}}),
            ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "你好"}}),
            ("content_block_delta", {"index": 0, "delta": {"type": "text_delta", "text": "世界"}}),
            ("content_block_stop", {"index": 0}),
            ("message_delta", {"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 7}}),
            ("message_stop", {}),
        ])
        texts = [p for k, p in evs if k == "text"]
        self.assertEqual(texts, ["你好", "世界"])
        usage = [p for k, p in evs if k == "usage"]
        self.assertEqual(usage, [{"prompt_tokens": 12, "completion_tokens": 7, "reasoning_tokens": 0}])
        finish = [p for k, p in evs if k == "finish"]
        self.assertEqual(finish, ["stop"])

    def test_tool_use_flow(self):
        evs = self._run([
            ("message_start", {"message": {"usage": {"input_tokens": 20}}}),
            ("content_block_start", {"index": 0, "content_block": {
                "type": "tool_use", "id": "toolu_1", "name": "search_web"}}),
            ("content_block_delta", {"index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"q":'}}),
            ("content_block_delta", {"index": 0, "delta": {"type": "input_json_delta", "partial_json": '"桌伴"}'}}),
            ("content_block_stop", {"index": 0}),
            ("message_delta", {"delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 15}}),
            ("message_stop", {}),
        ])
        deltas = [p for k, p in evs if k == "tool_delta"]
        self.assertEqual(deltas[0], {"index": 0, "id": "toolu_1", "name": "search_web", "arguments": None})
        args = "".join(d["arguments"] or "" for d in deltas)
        self.assertEqual(args, '{"q":"桌伴"}')
        finish = [p for k, p in evs if k == "finish"]
        self.assertEqual(finish, ["tool_calls"])

    def test_thinking_flow(self):
        evs = self._run([
            ("message_start", {"message": {"usage": {"input_tokens": 5}}}),
            ("content_block_delta", {"index": 0, "delta": {"type": "thinking_delta", "thinking": "让我想想"}}),
            ("content_block_delta", {"index": 1, "delta": {"type": "text_delta", "text": "答案"}}),
            ("message_delta", {"delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": 3}}),
            ("message_stop", {}),
        ])
        self.assertIn(("reasoning", "让我想想"), evs)
        self.assertIn(("text", "答案"), evs)

    def test_http_error_raises(self):
        with patch("httpx.Client", lambda **kw: FakeClient([], status_code=401, body=b'{"error":{"message":"invalid x-api-key"}}')):
            with self.assertRaises(ant.AnthropicAPIError) as ctx:
                list(ant.iter_stream_events(
                    "https://api.anthropic.com", "bad-key", "claude-sonnet-4-5",
                    [{"role": "user", "content": "hi"}], max_tokens=10))
        self.assertEqual(ctx.exception.status_code, 401)

    def test_stream_inner_error_raises(self):
        evs = [("error", {"error": {"type": "overloaded_error", "message": "Overloaded"}})]
        lines = _sse(evs)
        with patch("httpx.Client", lambda **kw: FakeClient(lines)):
            with self.assertRaises(ant.AnthropicAPIError):
                list(ant.iter_stream_events(
                    "https://api.anthropic.com", "k", "m",
                    [{"role": "user", "content": "hi"}], max_tokens=10))


class TestCloudEngineDispatch(unittest.TestCase):
    """CloudEngine 侧：格式分发 + OpenAI 事件归一化（不发起真实请求）"""

    def test_openai_events_normalization(self):
        from core.cloud_engine import CloudEngine

        class _U:
            prompt_tokens = 10
            completion_tokens = 5
            completion_tokens_details = None

        class _Delta:
            content = "你好"
            reasoning_content = "思考一下"
            tool_calls = None

        class _Choice:
            delta = _Delta()
            finish_reason = "stop"

        class _Chunk:
            choices = [_Choice()]
            usage = _U()

        class _FakeChat:
            class completions:
                @staticmethod
                def create(**kw):
                    return iter([_Chunk()])

        class _FakeClient:
            chat = _FakeChat()

        eng = CloudEngine.__new__(CloudEngine)
        evs = list(eng._iter_openai_events(_FakeClient(), "m", [{"role": "user", "content": "x"}], 100))
        kinds = [k for k, _ in evs]
        self.assertEqual(kinds, ["usage", "reasoning", "text", "finish"])
        self.assertEqual(evs[0][1]["prompt_tokens"], 10)
        self.assertEqual(evs[3], ("finish", "stop"))

    def test_openai_tool_delta_normalization(self):
        from core.cloud_engine import CloudEngine

        class _Fn:
            name = "search_web"
            arguments = '{"q":'

        class _TC:
            index = 0
            id = "call_1"
            function = _Fn()

        class _Delta:
            content = None
            reasoning_content = None
            tool_calls = [_TC()]

        class _Choice:
            delta = _Delta()
            finish_reason = "tool_calls"

        class _Chunk:
            choices = [_Choice()]
            usage = None

        class _FakeChat:
            class completions:
                @staticmethod
                def create(**kw):
                    return iter([_Chunk()])

        class _FakeClient:
            chat = _FakeChat()

        eng = CloudEngine.__new__(CloudEngine)
        evs = list(eng._iter_openai_events(_FakeClient(), "m", [], 100, tools=[{"type": "function"}]))
        self.assertEqual(evs[0], ("tool_delta", {"index": 0, "id": "call_1",
                                                 "name": "search_web", "arguments": '{"q":'}))
        self.assertEqual(evs[1], ("finish", "tool_calls"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
