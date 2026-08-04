# -*- coding: utf-8 -*-
"""anthropic_adapter — Anthropic 原生接口适配器（P8-1）

零新依赖：复用 openai 带来的 httpx，直连 /v1/messages。

对外提供：
  build_messages_url(base_url)   拼接 messages 端点（容忍 base 带/不带 /v1）
  convert_messages(msgs)         OpenAI messages → (system, anthropic_messages)
  convert_tools(tools)           OpenAI FC tools → Anthropic tools
  iter_stream_events(...)        发起流式请求，yield 归一化事件：
      ("reasoning", str)        思考 token（thinking_delta）
      ("text", str)             正文 token
      ("tool_delta", dict)      {index, id?, name?, arguments?}（增量）
      ("usage", dict)           {prompt_tokens, completion_tokens, reasoning_tokens}
      ("finish", str)           "stop" | "tool_calls" | "max_tokens"
  list_models(base_url, api_key) GET /v1/models（测试连接/拉取列表用）

与 OpenAI 路径的归一化事件约定一致，CloudEngine 消费循环不关心格式差异。
"""
import json
import logging

import httpx

log = logging.getLogger(__name__)

ANTHROPIC_VERSION = "2023-06-01"
DEFAULT_BASE = "https://api.anthropic.com"

_TIMEOUT = httpx.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0)
_TIMEOUT_SHORT = httpx.Timeout(connect=15.0, read=30.0, write=15.0, pool=15.0)


class AnthropicAPIError(Exception):
    """带 status_code 的异常，供 _translate_cloud_error 分类（与 openai.APIStatusError 同构）"""

    def __init__(self, message, status_code=None):
        super().__init__(message)
        self.status_code = status_code


def _norm_base(base_url: str) -> str:
    """统一 base：去尾斜杠，补 /v1（用户填 https://api.anthropic.com 或带 /v1 都可）"""
    b = (base_url or "").strip().rstrip("/")
    if not b:
        b = DEFAULT_BASE
    if not b.endswith("/v1"):
        b += "/v1"
    return b


def build_messages_url(base_url: str) -> str:
    return _norm_base(base_url) + "/messages"


def _headers(api_key: str) -> dict:
    return {
        "x-api-key": api_key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
    }


# ============================================================
#  请求构造：OpenAI 格式 → Anthropic 格式
# ============================================================

def convert_messages(messages: list) -> tuple:
    """OpenAI messages → (system_prompt, anthropic_messages)

    映射规则：
      role=system            → 顶层 system 字段（多条拼接）
      role=user/assistant    → 直通（文本 content）
      assistant + tool_calls → content blocks: [text?, tool_use...]
      role=tool              → user 消息 content blocks: [tool_result...]（连续的合并）
      连续同 role            → 合并（Anthropic 要求 user/assistant 严格交替）
    """
    system_parts = []
    out = []

    def _append(role, content):
        if out and out[-1]["role"] == role:
            prev = out[-1]["content"]
            # 统一成 blocks 再合并
            prev_blocks = prev if isinstance(prev, list) else ([{"type": "text", "text": prev}] if prev else [])
            new_blocks = content if isinstance(content, list) else ([{"type": "text", "text": content}] if content else [])
            merged = prev_blocks + new_blocks
            # 纯文本块可折叠回字符串，减少噪音
            if all(b.get("type") == "text" for b in merged):
                out[-1]["content"] = "\n".join(b.get("text", "") for b in merged if b.get("text"))
            else:
                out[-1]["content"] = merged
        else:
            out.append({"role": role, "content": content})

    for msg in messages or []:
        role = msg.get("role", "user")
        content = msg.get("content") or ""

        if role == "system":
            if content:
                system_parts.append(content)
            continue

        if role == "tool":
            # OpenAI tool 结果 → Anthropic user 消息里的 tool_result 块
            block = {
                "type": "tool_result",
                "tool_use_id": msg.get("tool_call_id", ""),
                "content": content if isinstance(content, str) else json.dumps(content, ensure_ascii=False),
            }
            _append("user", [block])
            continue

        if role == "assistant" and msg.get("tool_calls"):
            blocks = []
            if content:
                blocks.append({"type": "text", "text": content})
            for tc in msg["tool_calls"]:
                fn = tc.get("function", {})
                args_raw = fn.get("arguments", "") or ""
                try:
                    args = json.loads(args_raw) if isinstance(args_raw, str) else args_raw
                except Exception:
                    args = {"_raw": args_raw}
                blocks.append({
                    "type": "tool_use",
                    "id": tc.get("id", ""),
                    "name": fn.get("name", ""),
                    "input": args if isinstance(args, dict) else {},
                })
            _append("assistant", blocks)
            continue

        if role in ("user", "assistant"):
            _append(role, content)

    # Anthropic 要求首条必须是 user
    if out and out[0]["role"] != "user":
        out.insert(0, {"role": "user", "content": "（继续）"})

    return ("\n\n".join(system_parts), out)


def convert_tools(tools: list) -> list:
    """OpenAI FC tools → Anthropic tools（input_schema 即 parameters）"""
    out = []
    for t in tools or []:
        fn = t.get("function", {}) if t.get("type") == "function" else t
        name = fn.get("name")
        if not name:
            continue
        out.append({
            "name": name,
            "description": fn.get("description", ""),
            "input_schema": fn.get("parameters") or {"type": "object", "properties": {}},
        })
    return out


def build_request_body(model: str, openai_messages: list, max_tokens: int,
                       tools: list = None, temperature: float = 0.7) -> dict:
    """组装 /v1/messages 请求体（max_tokens 必填）"""
    system, messages = convert_messages(openai_messages)
    if not messages:
        messages = [{"role": "user", "content": "（空对话）"}]
    body = {
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        "stream": True,
        "temperature": temperature,
    }
    if system:
        body["system"] = system
    if tools:
        body["tools"] = convert_tools(tools)
    return body


# ============================================================
#  流式调用 + SSE 解析
# ============================================================

_STOP_REASON_MAP = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "tool_use": "tool_calls",
    "max_tokens": "max_tokens",
}


def iter_stream_events(base_url: str, api_key: str, model: str,
                       openai_messages: list, max_tokens: int,
                       tools: list = None, temperature: float = 0.7):
    """发起 Anthropic 流式请求，yield 归一化事件（见模块docstring）。

    网络/HTTP 错误抛 AnthropicAPIError（或 httpx 原生异常），
    由 CloudEngine 外层统一重试/翻译。
    """
    url = build_messages_url(base_url)
    body = build_request_body(model, openai_messages, max_tokens, tools, temperature)
    log.info("[ANTHROPIC] POST %s model=%s messages=%d max_tokens=%d",
             url, model, len(body["messages"]), max_tokens)

    input_tokens = 0
    output_tokens = 0
    stop_reason = None

    with httpx.stream("POST", url, headers=_headers(api_key), json=body,
                      timeout=_TIMEOUT) as resp:
        if resp.status_code != 200:
            detail = ""
            try:
                detail = resp.read().decode("utf-8", "replace")[:300]
            except Exception:
                pass
            raise AnthropicAPIError(
                "Anthropic API 错误（%d）: %s" % (resp.status_code, detail),
                status_code=resp.status_code)

        event_type = None
        for line in resp.iter_lines():
            if not line:
                continue
            if line.startswith("event:"):
                event_type = line[6:].strip()
                continue
            if not line.startswith("data:"):
                continue
            data_str = line[5:].strip()
            try:
                data = json.loads(data_str)
            except Exception:
                continue

            etype = event_type or data.get("type", "")

            if etype == "error":
                err = data.get("error", {})
                raise AnthropicAPIError(
                    "Anthropic 流内错误: %s" % (err.get("message", data_str[:200])),
                    status_code=None)

            if etype == "message_start":
                usage = (data.get("message") or {}).get("usage") or {}
                input_tokens = usage.get("input_tokens", 0) or 0

            elif etype == "content_block_start":
                block = data.get("content_block") or {}
                if block.get("type") == "tool_use":
                    yield ("tool_delta", {
                        "index": data.get("index", 0),
                        "id": block.get("id"),
                        "name": block.get("name"),
                        "arguments": None,
                    })

            elif etype == "content_block_delta":
                delta = data.get("delta") or {}
                dt = delta.get("type")
                if dt == "text_delta":
                    text = delta.get("text") or ""
                    if text:
                        yield ("text", text)
                elif dt == "thinking_delta":
                    thinking = delta.get("thinking") or ""
                    if thinking:
                        yield ("reasoning", thinking)
                elif dt == "input_json_delta":
                    frag = delta.get("partial_json") or ""
                    if frag:
                        yield ("tool_delta", {
                            "index": data.get("index", 0),
                            "id": None, "name": None,
                            "arguments": frag,
                        })

            elif etype == "message_delta":
                sr = (data.get("delta") or {}).get("stop_reason")
                if sr:
                    stop_reason = sr
                usage = data.get("usage") or {}
                if usage.get("output_tokens") is not None:
                    output_tokens = usage.get("output_tokens") or 0

            elif etype == "message_stop":
                break

            # ping / content_block_stop 等忽略

    # 归一化 usage（一次产出，字段名对齐 OpenAI 口径）
    if input_tokens or output_tokens:
        yield ("usage", {
            "prompt_tokens": input_tokens,
            "completion_tokens": output_tokens,
            "reasoning_tokens": 0,
        })
    yield ("finish", _STOP_REASON_MAP.get(stop_reason, "stop"))


# ============================================================
#  模型列表（测试连接 / 拉取模型列表共用）
# ============================================================

def list_models(base_url: str, api_key: str) -> list:
    """GET /v1/models，返回 [{"id": ..., "display_name": ...}, ...]

    Anthropic 的 models 接口不返回上下文长度——上层显示"上下文未知"，
    输入上限靠内置表匹配或用户手填（P8-3 原型决议）。
    """
    url = _norm_base(base_url) + "/models"
    with httpx.Client(timeout=_TIMEOUT_SHORT) as cli:
        resp = cli.get(url, headers=_headers(api_key))
    if resp.status_code != 200:
        raise AnthropicAPIError(
            "Anthropic API 错误（%d）: %s" % (resp.status_code, resp.text[:200]),
            status_code=resp.status_code)
    data = resp.json()
    return [
        {"id": m.get("id"), "display_name": m.get("display_name") or m.get("id"),
         "context_window": None}
        for m in data.get("data", [])
    ]


def test_connection(base_url: str, api_key: str) -> tuple:
    """测试连接：GET /v1/models 验证 Key + 连通性。返回 (ok, latency_ms, error)"""
    import time
    if not api_key:
        return (False, 0, "API Key 未配置")
    try:
        t0 = time.time()
        list_models(base_url, api_key)
        return (True, int((time.time() - t0) * 1000), None)
    except AnthropicAPIError as e:
        if e.status_code == 401:
            return (False, 0, " 认证失败：API Key 无效或已过期。请在设置中检查 API Key。")
        if e.status_code == 403:
            return (False, 0, " 权限不足：当前 API Key 无权访问。")
        return (False, 0, str(e)[:200])
    except httpx.TimeoutException:
        return (False, 0, "⏱️ 连接超时：服务器响应时间过长。请检查网络或稍后重试。")
    except Exception as e:
        return (False, 0, str(e)[:200])
