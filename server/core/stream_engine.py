# -*- coding: utf-8 -*-
"""StreamEngine — 流式生成核心循环（llama.cpp OpenAI 兼容 API 版）

P7-4 底座替换：从 Ollama 原生 /api/chat 迁移到 llama-server /v1/chat/completions。

保留（不变）：
  - run() 方法：任务分类 / 策略解析 / prompt 构建 / 生成队列 / 模型加载
  - stop_generation() + stop_requested 标志
  - phase 输出协议：text / fold / token_stats / raw / task_type / reload / mode_hint

变更（_stream_chat 内部重写）：
  - 请求：httpx POST /api/chat → LlamaCppClient.chat_stream()（OpenAI SDK）
  - 请求体：options.num_ctx/num_predict → 顶层 max_tokens/temperature/top_p
  - 流格式：Ollama NDJSON（按行拆 JSON）→ OpenAI SSE（SDK 自动解析）
  - 字段映射：message.content → delta.content；think → delta.reasoning_content
  - think 控制：payload think=false → extra_body.enable_thinking=False
  - token 统计：done 帧 prompt_eval_count/eval_count → chunk.usage
  - keep_alive：删除（llama-server 启动即常驻）
"""
import time
import logging
from typing import Optional, List

from core.generate_queue import GenerateQueue

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")


class StreamEngine:
    """流式生成引擎：Ollama 原生 /api/chat 流式对话"""

    def __init__(self, model_manager):
        self._mm = model_manager
        self._active_response = None  # 兼容旧引用（stop_generation 兜底关闭）

    def run(self, message: str, model: str = None,
            max_tokens: int = None, history: Optional[List] = None,
            context_cache: str = None,
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
        # Bug1 修复：温度链路曾断裂——get_temperature_offset 是空壳恒返回 0.0，
        # 导致所有策略的温度偏移失效。现在统一从 resolve_strategy + STRATEGY_CONFIG_V2
        # 取 temperature_offset/top_p_offset，让策略温度真正生效。
        # kb_mode/override/agent 三个分支保留各自的特殊温度（刻意设计），不受影响。
        if kb_mode:
            task_type = "text"
            confidence = 0.99
            temp_offset = -0.25
            classify_signals = {}
        elif override_task_type:
            task_type = override_task_type
            confidence = 0.99
            classify_signals = {}
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
            temp_offset = 0.0
        yield ("task_type", (task_type, confidence))

        # ===== 策略解析（统一入口：think_mode + temperature_offset + sampler_overrides）=====
        # Bug1 修复：原来这里只取 think_mode，temperature 靠前面空壳函数（恒 0.0）。
        # 现在统一从 strategy 取所有采样参数。自动分类分支(else)用 strategy 的温度；
        # kb_mode/override/agent 分支只取 think_mode，温度保持各自的特殊值。
        think_mode = "off"
        sampler_overrides = {}
        try:
            from intelligence.task_classifier import resolve_strategy
            from prompts import STRATEGY_CONFIG_V2
            strategy = resolve_strategy(message)
            strategy_name = strategy.get("type", "default")
            strategy_config = STRATEGY_CONFIG_V2.get(strategy_name, {})

            # 自动分类分支：用 strategy 的温度偏移（让 code -0.2 / creative +0.3 等真正生效）
            if not kb_mode and not override_task_type and not _agent_mode:
                temp_offset = strategy_config.get("temperature_offset", 0.0)

            think_mode = strategy_config.get("think_mode", "off")

            # sampler_overrides：top_p / repeat_penalty 的策略微调
            top_p_off = strategy_config.get("top_p_offset", 0.0)
            rp_off = strategy_config.get("repeat_penalty_offset", 0.0)
            if top_p_off:
                sampler_overrides["top_p"] = max(0.1, min(1.0, profile.get("top_p", 0.9) + top_p_off))
            if rp_off:
                sampler_overrides["repeat_penalty"] = max(1.0, min(2.0, profile.get("repeat_penalty", 1.1) + rp_off))
        except Exception as e:
            log.debug("[MODEL] 策略解析失败: %s" % str(e)[:60])
            think_mode = "off"

        # KB 模式强制禁用思考
        if kb_mode:
            think_mode = "off"

        # ===== KB 模式限制输出长度（动态预留，原 MAX_OUTPUT_TOKENS=4096 浪费一半窗口）=====
        if kb_mode:
            # 用动态预留替代固定 MAX_OUTPUT_TOKENS：KB 模式预留 1500，释放空间给历史
            _hist_chars = sum(len(m.get("content", "")) for m in (history or []))
            _reserved = mm.calc_output_reservation(kb_mode=True, history_chars=_hist_chars)
            if max_tokens > _reserved:
                max_tokens = _reserved
        # 注：非 KB 模式原有一次 get_dynamic_max_tokens/check_mode_hint 调用，
        # 但两者都是空壳函数（恒返回 0/空串），属死代码，已随 Bug1 温度修复一并清理。

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
                                     signals=classify_signals,
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
        """调用 llama-server /v1/chat/completions 端点（OpenAI SSE 流式）。

        P7-4 底座替换：从 Ollama 原生 /api/chat 迁移到 OpenAI 兼容 API。

        think_mode=off → enable_thinking=False（Qwen3.5 默认 ON 会陷入死循环）
        think_mode=free → enable_thinking=True

        phase 输出协议保持不变（text/fold/token_stats/raw），run() 和调用方不用改。
        """
        mm = self._mm

        # 获取 LlamaCppClient（从 model_manager 拿，或现场创建）
        client = getattr(mm, '_llamacpp_client', None)
        if client is None:
            # 兼容：如果 model_manager 还没初始化 client，现场创建
            from core.llamacpp_backend import LlamaCppClient
            base_url = getattr(mm, '_llamacpp_base_url', None) or mm._ollama_base_url
            # Ollama base_url 是 http://host:port，llama.cpp 需要 /v1 后缀
            if not base_url.endswith("/v1"):
                base_url = base_url.rstrip("/") + "/v1"
            client = LlamaCppClient(base_url)
            mm._llamacpp_client = client

        # 采样参数
        top_p = profile.get("top_p", 0.9)
        repeat_penalty = profile.get("repeat_penalty", 1.1)
        if sampler_overrides:
            top_p = sampler_overrides.get("top_p", top_p)
            repeat_penalty = sampler_overrides.get("repeat_penalty", repeat_penalty)

        # think 控制
        enable_thinking = (think_mode != "off")

        # 模型名：llama-server 用 GGUF 文件名或 model_id
        # model_name 可能是 Ollama 的 Modelfile 名（如 "qwen3-5-4b"），
        # 也可能是 llama-server 的 model_id。先尝试从 registry 找 GGUF 文件名。
        _model_for_api = model_name
        _registry = getattr(mm, '_model_registry', None)
        if _registry:
            _info = _registry.get(model_name)
            if _info:
                _model_for_api = _info.gguf_filename or model_name

        t0 = time.time()
        total_chars = 0
        full_output = ""
        thinking_content = ""
        _chunk_count = 0
        _last_token_stats = None

        # 调用 LlamaCppClient.chat_stream
        for event in client.chat_stream(
            messages=messages,
            model=_model_for_api,
            temperature=temperature,
            max_tokens=max_tokens,
            top_p=top_p,
            repeat_penalty=repeat_penalty,
            enable_thinking=enable_thinking,
        ):
            if mm.stop_requested:
                break

            phase = event.get("phase", "")

            if phase == "text":
                content = event.get("delta", "")
                if content:
                    content = content.replace("<|endoftext|>", "").replace("<|im_start|>", "").replace("<|im_end|>", "")
                    if content:
                        full_output += content
                        total_chars += len(content)
                        _chunk_count += 1
                        yield ("text", content)

            elif phase == "think":
                think_delta = event.get("delta", "")
                if think_delta:
                    thinking_content += think_delta

            elif phase == "token_stats":
                _stats = event.get("content", {})
                if _stats:
                    _last_token_stats = {
                        "input_tokens": _stats.get("prompt_eval_count", 0) or _stats.get("prompt_tokens", 0) or 0,
                        "output_tokens": _stats.get("eval_count", 0) or _stats.get("completion_tokens", 0) or 0,
                        "reasoning_tokens": None,
                    }

            elif phase == "raw":
                yield ("raw", event.get("content", ""))
                return

            elif phase == "done":
                break

        # think_mode=free 且有思考内容 → fold
        if thinking_content and think_mode != "off" and len(thinking_content) >= 20:
            yield ("fold", thinking_content)

        # 发送 token_stats
        if _last_token_stats:
            yield ("token_stats", _last_token_stats)

        # 空回复保护
        if not full_output and not mm.stop_requested:
            log_scan.warning("[STREAM] llama-server 未产生任何输出 (chunks=%d, think=%d字, elapsed=%.1fs)" % (
                _chunk_count, len(thinking_content), time.time() - t0))
        else:
            log_scan.info("[STREAM] 完成: chunks=%d, content=%d字, think=%d字, elapsed=%.1fs" % (
                _chunk_count, len(full_output), len(thinking_content), time.time() - t0))

        elapsed = time.time() - t0
        with mm._stats_lock:
            mm._stats["total_requests"] += 1
            mm._stats["total_llm_chars"] += total_chars
            mm._stats["total_llm_time"] += elapsed

    def stop_generation(self):
        """停止生成：设置标志位 + 通过 LlamaCppClient 关闭活跃流"""
        self._mm.stop_requested = True
        # P7-4: 通过 LlamaCppClient 停止（替代 httpx response.close）
        client = getattr(self._mm, '_llamacpp_client', None)
        if client:
            client.stop_generation()
            log.info("[STREAM] 已请求停止 llama-server 流式生成")
        # 兼容：如果还有旧的 httpx response 引用，也尝试关闭
        if self._active_response is not None:
            try:
                self._active_response.close()
            except Exception:
                pass
            self._active_response = None
