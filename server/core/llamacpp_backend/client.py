# -*- coding: utf-8 -*-
"""LlamaCppClient — OpenAI 兼容 API 客户端

P7-4 底座替换：替代 stream_engine.py 中直接调用 Ollama /api/chat 的部分。

与 Ollama API 的关键差异：
  - 请求端点：/api/chat → /v1/chat/completions
  - 请求体：options.num_ctx/num_predict → 顶层 max_tokens/temperature/top_p
  - 流格式：Ollama NDJSON（每行一个 JSON）→ OpenAI SSE（data: {...}\n\n）
  - 正文字段：message.content → delta.content
  - 思考字段：think → delta.reasoning_content
  - 结束标记：obj.done=true → data: [DONE]
  - think 控制：payload think=false → extra_body.chat_template_kwargs.enable_thinking=False
  - keep_alive：Ollama 独有 → 删除（llama-server 启动即常驻）

补充了 PoC 缺失的生产能力：
  - 停止生成（_active_response + stop_requested）
  - 流式 token 统计（stream_options.include_usage）
  - Qwen3.5 <｜end▁of▁thinking｜> 标签处理
"""
import re
import logging
from typing import Optional, List, Iterator, Dict, Union

log = logging.getLogger(__name__)

# Qwen3.5 思考结束标签（从 stream_engine 搬迁）
_THINK_END_TAG = "\u200b\u2502\u2581end\u2581of\u2581thinking\u2581\u2502\u200b"


class LlamaCppClient:
    """通过 OpenAI 兼容协议调用 llama-server"""

    def __init__(self, base_url: str, api_key: str = "not-needed", timeout: float = 120.0):
        try:
            from openai import OpenAI
        except ImportError:
            raise ImportError("openai 包未安装，请运行 pip install openai>=1.30")

        self._client = OpenAI(base_url=base_url, api_key=api_key, timeout=timeout)
        self._base_url = base_url
        # 停止生成控制（从 stream_engine 搬迁）
        self._stop_requested = False
        self._active_response = None

    def stop_generation(self):
        """停止当前流式生成"""
        self._stop_requested = True
        if self._active_response is not None:
            try:
                self._active_response.close()
            except Exception:
                pass
            self._active_response = None
        log.info("[LLAMACPP-CLIENT] 停止生成请求已发送")

    def chat_stream(self,
                    messages: List[Dict],
                    model: str,
                    temperature: float = 0.7,
                    max_tokens: int = 1500,
                    top_p: float = 0.9,
                    repeat_penalty: float = 1.1,
                    enable_thinking: bool = False,
                    tools: Optional[List[Dict]] = None,
                    tool_choice: Optional[Union[str, Dict]] = None,
                    ) -> Iterator[Dict]:
        """流式对话生成器。

        Yields:
            {"phase": "text"|"think"|"done"|"token_stats"|"raw", "content"/"delta": str}
            - text: 正文增量（delta 字段）
            - think: 思考过程增量（delta 字段）
            - token_stats: token 统计（最后一帧 usage）
            - done: 完成事件
            - raw: 错误
        """
        self._stop_requested = False

        kwargs = dict(
            model=model,
            messages=messages,
            stream=True,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            # 流式 token 统计（PoC 缺失，这里补上）
            stream_options={"include_usage": True},
        )
        if tools is not None:
            kwargs["tools"] = tools
        if tool_choice is not None:
            kwargs["tool_choice"] = tool_choice
        # think 模式控制：默认关闭（Qwen3.5 默认 ON 会陷入死循环）
        kwargs["extra_body"] = {
            "chat_template_kwargs": {"enable_thinking": enable_thinking},
            "repeat_penalty": repeat_penalty,
        }

        # P8-9: 启动窗口容错——llama-server 比 app 的 HTTP 服务晚几秒就绪（装模型进显存），
        # 此窗口内的连接错误/502/503 是可恢复瞬时状态，重试 3 次再报错
        response = None
        _last_err = None
        for _attempt in range(3):
            try:
                response = self._client.chat.completions.create(**kwargs)
                break
            except Exception as e:
                _last_err = e
                _emsg = str(e).lower()
                _retryable = ("502" in _emsg or "503" in _emsg or "connection" in _emsg
                              or "connect" in type(e).__name__.lower())
                if not _retryable or _attempt >= 2:
                    break
                log.info("[LLAMACPP-CLIENT] 启动窗口重试 %d/3: %s", _attempt + 1, str(e)[:60])
                import time as _time
                _time.sleep(2)
        if response is None:
            yield {"phase": "raw", "content": "[ERROR] %s" % str(_last_err)[:200]}
            return
        self._active_response = response

        full_content = ""
        full_thinking = ""
        chunk_count = 0
        usage_data = None

        try:
            for chunk in response:
                if self._stop_requested:
                    log.info("[LLAMACPP-CLIENT] 用户请求停止，中断流")
                    break

                chunk_count += 1

                # token 统计（最后一个 chunk 可能有 usage 字段）
                if hasattr(chunk, "usage") and chunk.usage:
                    usage_data = {
                        "prompt_eval_count": getattr(chunk.usage, "prompt_tokens", 0),
                        "eval_count": getattr(chunk.usage, "completion_tokens", 0),
                    }

                if not chunk.choices:
                    continue
                delta = chunk.choices[0].delta

                # 正文
                content_piece = getattr(delta, "content", None)
                if content_piece:
                    # Qwen3.5 think 标签处理：如果正文里混入了思考标签，分离
                    if _THINK_END_TAG in content_piece:
                        content_piece = content_piece.split(_THINK_END_TAG)[-1]
                    if content_piece:
                        full_content += content_piece
                        yield {"phase": "text", "delta": content_piece, "content": full_content}

                # 思考（llama.cpp 的 reasoning_content 扩展字段）
                reasoning_piece = getattr(delta, "reasoning_content", None)
                if reasoning_piece:
                    full_thinking += reasoning_piece
                    yield {"phase": "think", "delta": reasoning_piece, "content": full_thinking}

                # 工具调用
                tool_calls = getattr(delta, "tool_calls", None)
                if tool_calls:
                    for tc in tool_calls:
                        fn = getattr(tc, "function", None)
                        if fn:
                            yield {"phase": "tool_call", "delta": getattr(fn, "arguments", ""),
                                   "tool_name": getattr(fn, "name", ""), "tool_id": getattr(tc, "id", "")}

            # token 统计
            if usage_data:
                yield {"phase": "token_stats", "content": usage_data}

            yield {
                "phase": "done",
                "content": full_content,
                "think": full_thinking,
                "chunks": chunk_count,
            }
        except Exception as e:
            if self._stop_requested:
                yield {"phase": "done", "content": full_content, "think": full_thinking,
                       "chunks": chunk_count, "stopped": True}
            else:
                yield {"phase": "raw", "content": "[ERROR] 流式中断: %s" % str(e)[:200]}
        finally:
            self._active_response = None

    def chat(self,
             messages: List[Dict],
             model: str,
             temperature: float = 0.7,
             max_tokens: int = 1500,
             top_p: float = 0.9,
             repeat_penalty: float = 1.1,
             enable_thinking: bool = False,
             ) -> Dict:
        """非流式对话。

        Returns:
            dict: {"content": str, "think": str, "usage": {...}}
        """
        kwargs = dict(
            model=model,
            messages=messages,
            stream=False,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
        )
        kwargs["extra_body"] = {
            "chat_template_kwargs": {"enable_thinking": enable_thinking},
            "repeat_penalty": repeat_penalty,
        }
        try:
            resp = self._client.chat.completions.create(**kwargs)
        except Exception as e:
            return {"error": str(e)[:200]}

        if not resp.choices:
            return {"error": "空响应"}

        msg = resp.choices[0].message
        content = getattr(msg, "content", "") or ""
        think_part = getattr(msg, "reasoning_content", "") or ""

        # Qwen3.5 think 标签清理
        if _THINK_END_TAG in content:
            content = content.split(_THINK_END_TAG)[-1].strip()

        usage = {}
        if hasattr(resp, "usage") and resp.usage:
            usage = {
                "prompt_tokens": getattr(resp.usage, "prompt_tokens", None),
                "completion_tokens": getattr(resp.usage, "completion_tokens", None),
                "total_tokens": getattr(resp.usage, "total_tokens", None),
            }

        return {
            "content": content,
            "think": think_part,
            "usage": usage,
            "model": getattr(resp, "model", model),
        }

    def list_models(self) -> List[Dict]:
        """查询 llama-server 已加载的模型"""
        try:
            resp = self._client.models.list()
            return [{"id": m.id, "object": m.object} for m in resp.data]
        except Exception as e:
            log.warning("[LLAMACPP-CLIENT] list_models 失败: %s" % str(e)[:80])
            return []
