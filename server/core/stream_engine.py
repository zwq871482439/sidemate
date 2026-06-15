# -*- coding: utf-8 -*-
"""StreamEngine — 流式生成核心循环（Ollama 原生 API 版）

V4: 彻底简化
  - 统一使用 Ollama 原生 /api/chat 端点（不用 OpenAI 兼容层）
  - think_mode=off → payload 加 "think": false（Ollama 原生支持）
  - 原生端点不分离 reasoning_content，思考内容在 data["think"]，正文在 data["message"]["content"]
  - iter_bytes() 手动拆行（避免 httpx iter_lines 缓冲问题）
  - 删除所有叠甲逻辑（reasoning_buffer / fold / think_open / strip_think fallback）
"""
import time
import json
import logging
from typing import Optional, List

import httpx

from core.generate_queue import GenerateQueue

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")


class StreamEngine:
    """流式生成引擎：Ollama 原生 /api/chat 流式对话"""

    def __init__(self, model_manager):
        self._mm = model_manager
        self._response_client: Optional[httpx.Client] = None
        self._active_response = None  # 当前活跃的 httpx stream response（用于强制关闭）

    def run(self, message: str, model: str = None,
            max_tokens: int = None, history: Optional[List] = None,
            context_cache: str = None, drift_hint: str = None,
            _agent_mode: bool = False, override_task_type: str = None,
            strategy_enhancement: str = "",
            kb_mode: bool = False,
            kb_history_turns: int = 0,
            _priority: str = None):
        """LLM 流式对话生成器，yield (phase, content) 元组

        phase:
          "task_type" - 任务分类结果，content 为 (task_type, confidence) 元组
          "raw"  - 原始 token 流（错误信息）
          "text" - 正文 token 流
          "fold" - 思考过程完成（think_mode=free 时），content 为思考内容
          "mode_hint" - 模式切换建议
          "reload" - 模型正在重载
        """
        mm = self._mm
        if model is None:
            model = mm._get_default_llm()

        matched_name = mm._find_model_name(model)
        if matched_name is None:
            yield ("raw", "[ERROR] 未知模型: %s" % model)
            return

        cfg = mm.model_configs.get(matched_name, {})
        if cfg.get("type") != "llm":
            yield ("raw", "[ERROR] %s 不是 LLM 模型" % matched_name)
            return

        profile = mm._get_profile(matched_name)
        max_tokens = max_tokens if max_tokens is not None else profile.get("default_max_tokens", 1500)

        # ===== 智能任务分类 =====
        if kb_mode:
            task_type = "text"
            confidence = 0.99
            temp_offset = -0.25
            classify_signals = {}
        elif override_task_type:
            task_type = override_task_type
            confidence = 0.99
            classify_signals = {}
            try:
                from intelligence.task_classifier import get_temperature_offset, get_classify_signals
                temp_offset = get_temperature_offset(task_type)
                classify_signals = get_classify_signals(message, task_type)
            except Exception:
                temp_offset = 0.0
        elif _agent_mode:
            task_type = "agent"
            confidence = 0.95
            temp_offset = -0.1
            classify_signals = {}
        else:
            task_type = "text"
            confidence = 0.3
            classify_signals = {}
            try:
                from intelligence.task_classifier import classify_task, get_temperature_offset, get_classify_signals
                task_type, confidence = classify_task(message, history)
                temp_offset = get_temperature_offset(task_type)
                classify_signals = get_classify_signals(message, task_type)
            except Exception as e:
                log.debug("[MODEL] task_classifier 辅助函数失败: %s" % str(e)[:60])
                temp_offset = 0.0
                classify_signals = {}
        yield ("task_type", (task_type, confidence))

        # ===== think_mode 读取 =====
        think_mode = "off"
        sampler_overrides = {}
        try:
            from intelligence.task_classifier import resolve_strategy
            from prompts import STRATEGY_CONFIG_V2
            strategy = resolve_strategy(message)
            strategy_name = strategy.get("type", "default")
            strategy_config = STRATEGY_CONFIG_V2.get(strategy_name, {})
            think_mode = strategy_config.get("think_mode", "off")
        except Exception as e:
            log.debug("[MODEL] think_mode 解析失败: %s" % str(e)[:60])
            think_mode = "off"

        # KB 模式强制禁用思考
        if kb_mode:
            think_mode = "off"

        # ===== KB 模式限制输出长度 =====
        if kb_mode:
            from config import MAX_OUTPUT_TOKENS
            if max_tokens > MAX_OUTPUT_TOKENS:
                max_tokens = MAX_OUTPUT_TOKENS
        if not kb_mode:
            try:
                from intelligence.task_classifier import get_dynamic_max_tokens
                task_max = get_dynamic_max_tokens(task_type, message)
                if task_max and task_max > 0 and max_tokens > task_max:
                    max_tokens = task_max
            except Exception as e:
                log.debug("[MODEL] get_dynamic_max_tokens 失败: %s" % str(e)[:60])

            try:
                from intelligence.task_classifier import check_mode_hint
                mode_hint = check_mode_hint("chat", message)
                if mode_hint:
                    yield ("mode_hint", mode_hint)
            except Exception as e:
                log.debug("[MODEL] check_mode_hint 失败: %s" % str(e)[:60])

        # 确保"模型已加载"
        if matched_name not in mm._loaded:
            is_auto_reload = mm._auto_reload_after_stop and mm._last_loaded_model == matched_name
            if is_auto_reload:
                mm._auto_reload_after_stop = False
                log_scan.info("[AUTO-RELOAD] 正在自动重载模型: %s" % matched_name)
                yield ("reload", matched_name)
            r = mm.load(matched_name)
            if "error" in r:
                yield ("raw", "[ERROR] 加载失败: %s" % r["error"])
                return
            if is_auto_reload:
                log_scan.info("[AUTO-RELOAD] 模型 %s 已自动重载成功" % matched_name)

        # 构建 messages
        messages = mm._build_prompt(None, message, history, model_name=matched_name,
                                     context_cache=context_cache, task_type=task_type,
                                     drift_hint=drift_hint, signals=classify_signals,
                                     kb_mode=kb_mode,
                                     strategy_enhancement=strategy_enhancement,
                                     kb_history_turns=kb_history_turns,
                                     think_mode=think_mode)

        adjusted_temp = max(0.1, min(1.5, profile["temperature"] + temp_offset))

        # ===== Ollama 原生 API 流式调用 =====
        mm._gen_done.clear()
        mm.stop_requested = False

        ticket = None
        try:
            queue_priority = _priority if _priority else GenerateQueue.HIGH
            ticket = mm.generate_queue.submit(priority=queue_priority, timeout=60)
            if ticket is None:
                yield ("raw", "[ERROR] 等待设备释放超时（60s）或请求被取消")
                return

            yield from self._stream_chat(
                matched_name, messages, max_tokens, adjusted_temp, profile, think_mode,
                sampler_overrides=sampler_overrides
            )

        except Exception as e:
            log_scan.error("[STREAM] 异常: %s" % str(e)[:200])
            yield ("raw", "[ERROR] %s" % str(e)[:200])
        finally:
            if ticket is not None:
                ticket.release()
            mm._gen_done.set()

    def _stream_chat(self, model_name: str, messages: list,
                     max_tokens: int, temperature: float,
                     profile: dict, think_mode: str,
                     sampler_overrides: dict = None):
        """调用 Ollama 原生 /api/chat 端点（NDJSON 流式）。

        think_mode=off → payload 加 "think": false
        think_mode=free → payload 不传 think（默认开启）或 "think": true

        原生端点响应格式（每行一个 JSON）：
          {"message":{"role":"assistant","content":"正文"},"done":false}
          think_mode=free 时还有："think":"思考内容"（与 content 同级）
          {"done":true,...}
        """
        mm = self._mm
        base_url = mm._ollama_base_url
        url = "%s/api/chat" % base_url

        payload = {
            "model": model_name,
            "messages": messages,
            "stream": True,
            "options": {
                "num_ctx": 16384,
                "num_predict": max_tokens,
                "temperature": temperature,
                "top_p": profile.get("top_p", 0.9),
            },
        }

        # keep_alive：让模型常驻显存/内存，避免空闲后重新加载
        try:
            from config import get as _cfg
            _keep_alive = _cfg("ollama_keep_alive", "24h")
        except Exception:
            _keep_alive = "24h"
        payload["keep_alive"] = _keep_alive

        # 核心参数：Ollama 原生 think 控制
        if think_mode == "off":
            payload["think"] = False
        else:
            payload["think"] = True

        # 叠加 sampler_overrides
        if sampler_overrides:
            for k, v in sampler_overrides.items():
                if k == "temperature":
                    payload["options"]["temperature"] = v
                elif k == "top_p":
                    payload["options"]["top_p"] = v
                elif k == "repeat_penalty":
                    payload["options"]["repeat_penalty"] = v

        t0 = time.time()
        total_chars = 0
        full_output = ""
        thinking_content = ""
        _chunk_count = 0
        _last_token_stats = None  # Ollama done 帧的 token 统计

        try:
            with httpx.stream(
                "POST", url,
                json=payload,
                timeout=httpx.Timeout(
                    connect=float(mm._ollama_connect_timeout),
                    read=float(mm._ollama_read_timeout),
                    write=30.0,
                    pool=30.0,
                ),
            ) as response:
                self._active_response = response  # 保存引用，stop_generation 可强制关闭
                if response.status_code != 200:
                    error_text = ""
                    try:
                        error_text = response.read().decode("utf-8", errors="replace")[:500]
                    except Exception:
                        pass
                    yield ("raw", "[ERROR] Ollama API 错误: %d %s" % (response.status_code, error_text))
                    return

                log_scan.info("[STREAM] 原生 API 连接建立, status=%d, think=%s" % (
                    response.status_code, think_mode))

                _buffer = ""
                for raw_bytes in response.iter_bytes():
                    if mm.stop_requested:
                        log_scan.info("[STREAM] 用户停止，中断流式读取")
                        break

                    _buffer += raw_bytes.decode("utf-8", errors="replace")

                    while "\n" in _buffer:
                        line, _buffer = _buffer.split("\n", 1)
                        line = line.strip()
                        if not line:
                            continue

                        _chunk_count += 1
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue

                        # think_mode=free 时，Ollama 原生端点会在 message 同级返回 "think" 字段
                        think_text = obj.get("think", "")
                        if think_text:
                            thinking_content += think_text

                        # 正文内容
                        msg = obj.get("message", {})
                        content = msg.get("content", "")

                        if content:
                            content = content.replace("<|endoftext|>", "").replace("<|endoftext|>", "")
                            content = content.replace("<|im_start|>", "").replace("<|im_end|>", "")
                            # Qwen3.5 即使 think=false 也可能输出 <｜end▁of▁thinking｜> 标签包裹的思考内容
                            end_tag = "<｜end▁of▁thinking｜>"
                            if think_mode == "off" and end_tag in content:
                                import re as _re_stream
                                content = _re_stream.sub(r"</?\s*response\s*/?>", "", content).strip()
                                if not content:
                                    continue  # 标签移除后为空，跳过此 chunk
                            if content:
                                full_output += content
                                total_chars += len(content)
                                yield ("text", content)

                        if obj.get("done"):
                            # 提取 Ollama done 帧的 token 统计
                            _prompt_eval = obj.get("prompt_eval_count", 0) or 0
                            _eval = obj.get("eval_count", 0) or 0
                            if _prompt_eval or _eval:
                                _last_token_stats = {
                                    "input_tokens": _prompt_eval,
                                    "output_tokens": _eval,
                                    "reasoning_tokens": None,
                                }
                            break

        except httpx.ConnectError as e:
            yield ("raw", "[ERROR] 无法连接 Ollama 服务: %s" % str(e)[:100])
            return
        except httpx.ReadTimeout:
            if total_chars > 0:
                log_scan.warning("[STREAM] Ollama 读取超时，已输出 %d 字" % total_chars)
            else:
                yield ("raw", "[ERROR] Ollama 响应超时")
                return
        except Exception as e:
            if mm.stop_requested:
                pass
            else:
                log_scan.error("[STREAM] Ollama 异常: %s" % str(e)[:200])
                yield ("raw", "[ERROR] 流式生成异常: %s" % str(e)[:100])
                return

        # think_mode=free 且有思考内容 → fold
        if thinking_content and think_mode != "off" and len(thinking_content) >= 20:
            yield ("fold", thinking_content)

        # 发送 token_stats
        if _last_token_stats:
            yield ("token_stats", _last_token_stats)

        # 空回复保护
        if not full_output and not mm.stop_requested:
            log_scan.warning("[STREAM] Ollama 未产生任何输出 (chunks=%d, think=%d字, elapsed=%.1fs)" % (
                _chunk_count, len(thinking_content), time.time() - t0))
        else:
            log_scan.info("[STREAM] 完成: chunks=%d, content=%d字, think=%d字, elapsed=%.1fs" % (
                _chunk_count, len(full_output), len(thinking_content), time.time() - t0))

        elapsed = time.time() - t0
        with mm._stats_lock:
            mm._stats["total_requests"] += 1
            mm._stats["total_llm_chars"] += total_chars
            mm._stats["total_llm_time"] += elapsed

        # 清理活跃 response 引用
        self._active_response = None

    def stop_generation(self):
        """停止生成：设置标志位 + 强制关闭活跃的 HTTP 连接"""
        self._mm.stop_requested = True
        if self._active_response is not None:
            try:
                self._active_response.close()
                log.info("[STREAM] 强制关闭 Ollama HTTP 连接")
            except Exception as e:
                log.debug("[STREAM] 关闭 response 异常（可忽略）: %s" % str(e)[:60])
            self._active_response = None
