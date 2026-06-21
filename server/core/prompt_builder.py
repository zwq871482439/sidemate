# -*- coding: utf-8 -*-
"""PromptBuilder — Prompt 构建逻辑（Ollama 版）

v0.9 变更：
  - build() 返回 OpenAI messages 数组 [{role, content}, ...]
  - 移除 apply_chat_template()（Ollama 自行处理模板）
  - 历史截断从 token 计数改为字符数估算
  - 保留系统提示词构建逻辑、文库上下文注入
"""
import re
import logging
from typing import Optional, List

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")

# 延迟导入：首次使用时才加载压缩器
_context_compressor = None


def _get_compressor():
    """延迟加载上下文压缩器"""
    global _context_compressor
    if _context_compressor is None:
        try:
            from common.context_compressor import compress_messages
            _context_compressor = compress_messages
        except ImportError:
            _context_compressor = None
    return _context_compressor


class PromptBuilder:
    """Prompt 构建器：V5.1 两段式（通用prompt + 场景一句话）

    V5.1 变更：
      - 身份+规则+格式合并为一段 ~100 字通用 prompt
      - 场景增强精简为一句话（~20字），不再给模板
      - prompt_builder 层简化：两层叠加 → 两段拼接
      - KB prompt 同步精简到 5 条规则
    """

    def __init__(self, model_manager):
        """初始化 PromptBuilder。

        Args:
            model_manager: ModelManager 实例（用于获取 profile、配置等）
        """
        self._mm = model_manager

    def _build_system_prompt(self, kb_mode: bool, strategy_name: str,
                              context_cache: str = None,
                              kb_context: str = None) -> str:
        """构建 system prompt，V5.1 两段式（通用+场景一句话）。

        Args:
            kb_mode: 文库问答模式
            strategy_name: 策略名称
            context_cache: session 级压缩摘要
            kb_context: KB 检索到的上下文
        """
        if kb_mode:
            # KB 模式：使用独立 prompt 模板
            try:
                from prompts import KB_SYSTEM_PROMPT_TEMPLATE
                return KB_SYSTEM_PROMPT_TEMPLATE.format(context=kb_context or "（无参考资料）")
            except ImportError:
                return "你是文库问答助手。严格基于参考资料回答问题。"

        # Chat 模式：通用 prompt + 场景一句话
        try:
            from prompts import SYSTEM_PROMPT_V2, STRATEGY_ENHANCEMENTS
            parts = [SYSTEM_PROMPT_V2]

            # 场景增强（一句话）
            enhancement = STRATEGY_ENHANCEMENTS.get(strategy_name, "")
            if enhancement:
                parts.append(enhancement)
        except ImportError:
            # fallback
            parts = ["你是桌伴，本地AI办公助手。直接回答问题。"]

        # 会话摘要（如有）
        if context_cache:
            parts.append("[本会话较早的对话摘要] " + context_cache)

        return "\n".join(parts)

    def get_sampler_overrides(self, strategy_name: str, user_message: str = "") -> dict:
        """返回策略对应的采样参数覆盖 + 短输入保护。

        Args:
            strategy_name: 策略名称
            user_message: 用户消息（用于短输入检测）

        Returns:
            dict: {temperature, top_p, repeat_penalty, ...} 或空 dict
        """
        try:
            from prompts import STRATEGY_CONFIG_V2, SHORT_INPUT_PROTECTION, SHORT_INPUT_THRESHOLD
        except ImportError:
            return {}

        config = STRATEGY_CONFIG_V2.get(strategy_name, STRATEGY_CONFIG_V2.get("default", {}))
        mm = self._mm
        profile = mm._get_profile(mm._get_default_llm())
        overrides = {}

        # 温度偏移
        temp_offset = config.get("temperature_offset", 0.0)
        if temp_offset:
            base_temp = profile.get("temperature", 0.7)
            overrides["temperature"] = max(0.1, min(1.5, base_temp + temp_offset))

        # top_p 偏移
        top_p_offset = config.get("top_p_offset", 0.0)
        if top_p_offset:
            base_top_p = profile.get("top_p", 0.9)
            overrides["top_p"] = max(0.1, min(1.0, base_top_p + top_p_offset))

        # repeat_penalty 偏移
        rp_offset = config.get("repeat_penalty_offset", 0.0)
        if rp_offset:
            base_rp = profile.get("repeat_penalty", 1.1)
            overrides["repeat_penalty"] = base_rp + rp_offset

        # 短输入保护
        msg_len = len(user_message.strip())
        if msg_len <= SHORT_INPUT_THRESHOLD:
            for k, v in SHORT_INPUT_PROTECTION.items():
                if k == "repeat_penalty":
                    overrides[k] = max(overrides.get(k, 1.1), v)
                elif k == "temperature":
                    overrides[k] = min(overrides.get(k, 0.7), v)

        return overrides

    def build(self, pipe, message: str, history: Optional[List] = None,
              model_name: str = None, context_cache: str = None,
              task_type: str = None,
              signals: dict = None, kb_mode: bool = False,
              strategy_enhancement: str = "",
              kb_history_turns: int = 0,
              think_mode: str = None) -> list:
        """构建 OpenAI messages 数组（V2 三层分层）。

        pipe 参数保留签名兼容（Ollama 版不需要 tokenizer），内部不使用。

        Args:
            pipe: 保留参数（Ollama 版不使用）
            message: 用户消息
            history: 对话历史列表
            model_name: 模型名
            context_cache: session 级压缩摘要
            task_type: "reasoning"|"code"|"text"
            signals: 分类信号
            kb_mode: 文库问答模式
            strategy_enhancement: 策略增强注入（V2 由 _build_system_prompt 自动处理）
            kb_history_turns: KB 问答历史轮数
            think_mode: "off"=禁用思考, "free"=允许思考

        Returns:
            list: OpenAI messages 数组 [{role, content}, ...]
        """
        mm = self._mm
        # 根据模型大小获取参数
        profile = mm._get_profile(model_name or mm._get_default_llm())
        max_history = profile["max_history_chars"]

        # P1-A9: 动态计算 prompt 字符数上限（从模型 context_window 推导）
        context_window = mm._get_device_token_limit(model_name or mm._get_default_llm())
        max_prompt_chars = int(context_window * 1.5 * 0.7)

        # 获取策略名称（用于三层 prompt 构建）
        strategy_name = "default"
        try:
            from intelligence.task_classifier import resolve_strategy
            strategy_result = resolve_strategy(message)
            strategy_name = strategy_result.get("type", "default")
        except Exception:
            pass

        # ===== V2：三层 system prompt 构建 =====
        kb_context = None
        if kb_mode:
            # KB 模式从 signals 或其他来源获取 context
            kb_context = signals.get("kb_context") if signals else None

        system_content = self._build_system_prompt(
            kb_mode=kb_mode,
            strategy_name=strategy_name,
            context_cache=context_cache,
            kb_context=kb_context,
        )

        messages = [{"role": "system", "content": system_content}]

        # 历史注入：自适应裁剪（Patch3 移除固定轮数）
        _working_history = history or []

        if _working_history:
            # 先检查是否需要压缩
            history_chars = sum(len(h.get("content", "")) for h in _working_history if h.get("content"))
            if history_chars > max_history:
                compressor = _get_compressor()
                if compressor:
                    model_size = mm._get_model_size(model_name or mm._get_default_llm())
                    try:
                        compressed = compressor(_working_history, max_history, model_size=model_size)
                        _working_history = compressed
                    except Exception as e:
                        log_scan.warning("_build_prompt: compress failed (%s), fallback to truncation" % str(e)[:80])

            # 从最新往前取，总字符数不超过 max_history
            selected = []
            total_chars = 0
            for h in reversed(_working_history):
                role = h.get("role", "user")
                content = h.get("content", "")
                # 助手回复中剥离 think 标签
                if role == "assistant":
                    content = mm._think_processor.strip_think(content)
                if role in ("user", "assistant", "system") and content:
                    content_len = len(content)
                    if total_chars + content_len > max_history:
                        break
                    selected.insert(0, {"role": role, "content": content})
                    total_chars += content_len
            messages.extend(selected)

        # 用户消息
        messages.append({"role": "user", "content": message})

        # 字符数安全检查
        total_message_chars = sum(len(m.get("content", "")) for m in messages)
        if total_message_chars > max_prompt_chars:
            log_scan.warning("_build_prompt: prompt too long (%d chars, limit=%d), truncating history" % (
                total_message_chars, max_prompt_chars))
            # 截断历史，保留 system + user
            if len(messages) > 2:
                messages[:] = [messages[0]] + messages[-1:]

            # 最终兜底：截断 user message
            total_message_chars = sum(len(m.get("content", "")) for m in messages)
            if total_message_chars > max_prompt_chars:
                budget = max_prompt_chars - len(messages[0].get("content", ""))
                messages[-1]["content"] = message[:budget] + "\n[系统提示：输入过长，已截断]"

        return messages
