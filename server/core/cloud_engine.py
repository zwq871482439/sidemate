# -*- coding: utf-8 -*-
"""CloudEngine — 云端 AI 引擎（OpenAI SDK → 兼容 API）

与 StreamEngine 输出格式完全一致：yield (phase, content) 元组，
让上层 20+ 调用点零修改。

依赖：openai>=1.30
"""
import base64
import time
import logging
from typing import Optional, List

try:
    import openai
    _HAS_OPENAI = True
except ImportError:
    _HAS_OPENAI = False

from config import get as _cfg

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")


# ===== Patch4 修复 8：云端 API 超时重试 =====
# 灰度测试发现 GLM 云端偶发 "read operation timed out" / "connection reset" / 503，
# 单次失败会中断整个 agent 任务。这里在 stream 调用外层包一层重试。
MAX_RETRIES = 2
# 仅重试网络类瞬时错误（业务错误如 401/400/429 不重试）
RETRYABLE_ERRORS = (
    "read operation timed out",
    "read timeout",
    "connection reset",
    "connection aborted",
    "connection broken",
    "503",  # service unavailable
    "502",  # bad gateway（部分代理/网关层瞬时故障）
)


def _is_retryable(error) -> bool:
    """判断异常是否属于可重试的瞬时网络错误"""
    err_lower = str(error).lower()
    return any(e in err_lower for e in RETRYABLE_ERRORS)


# ===== 友好错误翻译 =====

def _translate_cloud_error(exc: Exception) -> dict:
    """将云端 API 异常翻译为用户友好的中文提示

    Returns:
        dict: {"user_msg": "用户看到的中文提示", "error_type": "分类标识", "detail": "技术细节"}
    """
    err_str = str(exc)
    err_lower = err_str.lower()

    # 类型判断
    type_name = type(exc).__name__

    # DNS / 网络不通
    if "getaddrinfo" in err_lower or "enotfound" in err_lower or "name or service not known" in err_lower:
        return {
            "user_msg": " 网络连接失败：无法解析服务器地址。请检查网络连接是否正常。",
            "error_type": "network_dns",
            "detail": err_str[:200],
        }

    # 连接超时 / 拒绝
    if "timed out" in err_lower or "connectiontimeout" in err_lower or "timeout" in err_lower:
        return {
            "user_msg": "⏱️ 连接超时：服务器响应时间过长。请检查网络或稍后重试。",
            "error_type": "network_timeout",
            "detail": err_str[:200],
        }

    if "connectionrefused" in err_lower or "connection refused" in err_lower:
        return {
            "user_msg": " 连接被拒绝：无法连接到服务器。请检查 API 地址是否正确。",
            "error_type": "network_refused",
            "detail": err_str[:200],
        }

    # SSL / 证书错误
    if "ssl" in err_lower or "certificate" in err_lower or "tls" in err_lower:
        return {
            "user_msg": " 安全连接失败：SSL 证书验证出错。请检查系统时间或网络环境。",
            "error_type": "network_ssl",
            "detail": err_str[:200],
        }

    # HTTP 状态码错误（openai SDK 抛出的 APIStatusError）
    status_code = getattr(exc, 'status_code', None)
    if status_code is None:
        # 从字符串提取（某些 openai 版本）
        import re
        m = re.search(r'(\d{3})', err_str[:50])
        if m:
            status_code = int(m.group(1))

    if status_code:
        if status_code == 401:
            return {
                "user_msg": " 认证失败：API Key 无效或已过期。请在设置中检查 API Key。",
                "error_type": "auth_error",
                "detail": err_str[:200],
            }
        elif status_code == 403:
            return {
                "user_msg": " 权限不足：当前 API Key 无权访问此模型或功能。",
                "error_type": "auth_forbidden",
                "detail": err_str[:200],
            }
        elif status_code == 429:
            return {
                "user_msg": " 请求过于频繁：已触发限流。请等待几秒后重试。",
                "error_type": "rate_limit",
                "detail": err_str[:200],
            }
        elif status_code == 500:
            return {
                "user_msg": "️ 服务端错误（500）：云端模型服务暂时异常，请稍后重试。",
                "error_type": "server_error",
                "detail": err_str[:200],
            }
        elif status_code == 502:
            return {
                "user_msg": "️ 网关错误（502）：云端服务暂时不可用，请稍后重试。",
                "error_type": "server_error",
                "detail": err_str[:200],
            }
        elif status_code == 503:
            return {
                "user_msg": "️ 服务不可用（503）：云端模型正在维护或过载，请稍后重试。",
                "error_type": "server_error",
                "detail": err_str[:200],
            }
        elif status_code >= 400:
            return {
                "user_msg": "️ 请求错误（%d）：%s" % (status_code, err_str[:100]),
                "error_type": "http_error",
                "detail": err_str[:200],
            }

    # openai SDK 特有：APIConnectionError
    if "apiconnectionerror" in type_name.lower() or "connection error" in err_lower:
        return {
            "user_msg": " 网络连接失败：无法连接到云端服务。请检查网络是否正常。",
            "error_type": "network_error",
            "detail": err_str[:200],
        }

    # openai SDK：APIStatusError 的子类
    if "apistatuserror" in type_name.lower():
        return {
            "user_msg": "️ 云端 API 返回错误。请稍后重试。",
            "error_type": "api_error",
            "detail": err_str[:200],
        }

    # 兜底：通用错误
    return {
        "user_msg": "️ 云端请求失败，请稍后重试。",
        "error_type": "unknown",
        "detail": err_str[:200],
    }


class CloudEngine:
    """云端 AI 引擎：通过 OpenAI SDK 调用兼容 API"""

    # 模型能力表（2026-06 更新，来源：各厂商官方文档 + llm-stats + morphllm）
    # context_window = 最大上下文 token 数，max_output = 最大输出 token 数
    MODEL_CAPABILITIES = {
        # ===== OpenAI =====
        "gpt-4o": {"context_window": 131072, "max_output": 16384},
        "gpt-4o-mini": {"context_window": 131072, "max_output": 16384},
        "gpt-4.1": {"context_window": 1047576, "max_output": 32768},
        "gpt-4.1-mini": {"context_window": 1047576, "max_output": 32768},
        "gpt-4.1-nano": {"context_window": 1047576, "max_output": 32768},
        "gpt-5": {"context_window": 400000, "max_output": 128000},
        "gpt-5.2": {"context_window": 400000, "max_output": 128000},
        "gpt-5.4": {"context_window": 1050000, "max_output": 128000},
        "gpt-5.5": {"context_window": 1050000, "max_output": 128000},
        "o3": {"context_window": 200000, "max_output": 100000},
        "o3-mini": {"context_window": 200000, "max_output": 100000},
        "o4-mini": {"context_window": 200000, "max_output": 100000},
        # ===== Anthropic Claude =====
        "claude-sonnet-4": {"context_window": 200000, "max_output": 64000},
        "claude-sonnet-4.5": {"context_window": 200000, "max_output": 64000},
        "claude-sonnet-4.6": {"context_window": 200000, "max_output": 64000},
        "claude-haiku-4.5": {"context_window": 200000, "max_output": 64000},
        "claude-opus-4": {"context_window": 200000, "max_output": 32000},
        "claude-opus-4.5": {"context_window": 200000, "max_output": 64000},
        "claude-opus-4.6": {"context_window": 200000, "max_output": 64000},
        "claude-opus-4.7": {"context_window": 1000000, "max_output": 128000},
        "claude-opus-4.8": {"context_window": 1000000, "max_output": 128000},
        "claude-3.5-sonnet": {"context_window": 200000, "max_output": 8192},
        "claude-3.5-haiku": {"context_window": 200000, "max_output": 8192},
        # ===== DeepSeek =====
        "deepseek-chat": {"context_window": 163840, "max_output": 8192},
        "deepseek-reasoner": {"context_window": 163840, "max_output": 65536},
        "DeepSeek-V3": {"context_window": 163840, "max_output": 163840},
        "DeepSeek-V3-0324": {"context_window": 163840, "max_output": 163840},
        "DeepSeek-V3.1": {"context_window": 163840, "max_output": 163840},
        "DeepSeek-V3.2": {"context_window": 131072, "max_output": 65536},
        "DeepSeek-V4-Flash": {"context_window": 1048576, "max_output": 393216},
        "DeepSeek-V4-Pro": {"context_window": 1048576, "max_output": 393216},
        "DeepSeek-R1": {"context_window": 163840, "max_output": 163840},
        "DeepSeek-R1-0528": {"context_window": 163840, "max_output": 163840},
        # ===== Zhipu GLM =====
        "GLM-4.5": {"context_window": 131072, "max_output": 131072},
        "GLM-4.6": {"context_window": 204800, "max_output": 131072},
        "GLM-4.7": {"context_window": 204800, "max_output": 131072},
        "GLM-5": {"context_window": 200000, "max_output": 131072},
        "GLM-5.1": {"context_window": 200000, "max_output": 131072},
        "GLM-5-turbo": {"context_window": 200000, "max_output": 131072},
        "glm-4-flash": {"context_window": 128000, "max_output": 4096},
        "glm-4-plus": {"context_window": 128000, "max_output": 4096},
        # ===== Alibaba Qwen =====
        "qwen-turbo": {"context_window": 131072, "max_output": 16384},
        "qwen-plus": {"context_window": 131072, "max_output": 16384},
        "qwen-max": {"context_window": 131072, "max_output": 8192},
        "qwen3-max": {"context_window": 262144, "max_output": 131072},
        "qwen3.5-plus": {"context_window": 262144, "max_output": 131072},
        "qwen3.6-plus": {"context_window": 262144, "max_output": 131072},
        "qwen3.7-max": {"context_window": 1048576, "max_output": 131072},
        "qwen3-coder": {"context_window": 262144, "max_output": 131072},
        "Qwen3-235B-A22B": {"context_window": 262144, "max_output": 262144},
        "Qwen3.5-397B-A17B": {"context_window": 262144, "max_output": 262144},
        "QwQ-32B": {"context_window": 131072, "max_output": 131072},
        # ===== Google Gemini =====
        "gemini-2.0-flash": {"context_window": 1048576, "max_output": 8192},
        "gemini-2.5-pro": {"context_window": 1048576, "max_output": 65536},
        "gemini-2.5-flash": {"context_window": 1048576, "max_output": 65536},
        "gemini-3-pro": {"context_window": 1048576, "max_output": 65536},
        "gemini-3-flash": {"context_window": 1048576, "max_output": 65536},
        "gemini-3.1-pro": {"context_window": 2097152, "max_output": 65536},
        # ===== Moonshot / Kimi =====
        "moonshot-v1-8k": {"context_window": 8192, "max_output": 8192},
        "moonshot-v1-32k": {"context_window": 32768, "max_output": 32768},
        "moonshot-v1-128k": {"context_window": 131072, "max_output": 131072},
        "kimi-k2": {"context_window": 131072, "max_output": 131072},
        "kimi-k2.5": {"context_window": 262144, "max_output": 131072},
        "kimi-k2.6": {"context_window": 262144, "max_output": 98304},
        # ===== ByteDance Doubao =====
        "doubao-pro-32k": {"context_window": 32768, "max_output": 4096},
        "doubao-pro-128k": {"context_window": 131072, "max_output": 4096},
        "doubao-lite-32k": {"context_window": 32768, "max_output": 4096},
        # ===== Tencent Hunyuan =====
        "hunyuan-lite": {"context_window": 32768, "max_output": 4096},
        "hunyuan-standard": {"context_window": 32768, "max_output": 4096},
        "hunyuan-pro": {"context_window": 32768, "max_output": 4096},
        "hunyuan-turbo": {"context_window": 131072, "max_output": 4096},
        # ===== Baidu Ernie =====
        "ernie-4.0": {"context_window": 128000, "max_output": 4096},
        "ernie-3.5-turbo": {"context_window": 32768, "max_output": 4096},
        "ernie-speed": {"context_window": 32768, "max_output": 4096},
        # ===== Mistral =====
        "mistral-large-latest": {"context_window": 131072, "max_output": 131072},
        "mistral-large-3": {"context_window": 131072, "max_output": 131072},
        "mistral-medium-3": {"context_window": 131072, "max_output": 131072},
        "mistral-small-latest": {"context_window": 131072, "max_output": 131072},
        # ===== Meta Llama =====
        "Llama-4-Maverick-17B-128E-Instruct": {"context_window": 1048576, "max_output": 8192},
        "Llama-4-Scout-17B-16E-Instruct": {"context_window": 10485760, "max_output": 8192},
        # ===== xAI Grok =====
        "grok-4": {"context_window": 2097152, "max_output": 131072},
        "grok-4.1-fast": {"context_window": 2097152, "max_output": 131072},
        # ===== 01.AI Yi =====
        "yi-lightning": {"context_window": 16384, "max_output": 4096},
        "yi-large": {"context_window": 32768, "max_output": 32768},
        # ===== 默认 =====
        "_default": {"context_window": 131072, "max_output": 8192},
    }

    def __init__(self, model_manager):
        self._mm = model_manager
        self._client = None  # 延迟初始化

    def _get_client(self):
        """延迟创建 OpenAI 客户端（带超时保护）"""
        if self._client is not None:
            return self._client
        if not _HAS_OPENAI:
            raise ImportError("openai 包未安装，请运行 pip install openai>=1.30")
        base_url = _cfg("cloud_base_url", "https://api.openai.com/v1")
        api_key = self._decode_api_key(_cfg("cloud_api_key", ""))
        # 设置超时：连接 15s，读取 120s，防止网络不通时无限阻塞
        self._client = openai.OpenAI(
            base_url=base_url,
            api_key=api_key,
            timeout=openai.Timeout(connect=15.0, read=120.0, write=30.0, pool=15.0),
        )
        return self._client

    @staticmethod
    def _decode_api_key(encoded: str) -> str:
        """解码 base64 编码的 API Key"""
        if not encoded:
            return ""
        try:
            return base64.b64decode(encoded).decode("utf-8")
        except Exception:
            return encoded  # 如果不是 base64，原样返回

    @staticmethod
    def _encode_api_key(raw: str) -> str:
        """将 API Key 编码为 base64 存储"""
        if not raw:
            return ""
        return base64.b64encode(raw.encode("utf-8")).decode("utf-8")

    def _lookup_capabilities(self, model: str) -> dict:
        """查找模型能力（精确匹配 → 大小写不敏感 → 前缀包含 → _default）"""
        _default = self.MODEL_CAPABILITIES["_default"]
        caps = self.MODEL_CAPABILITIES.get(model)
        if caps:
            return self._ensure_capability_fields(caps, _default)
        # 大小写不敏感
        model_lower = model.lower()
        for name, cap in self.MODEL_CAPABILITIES.items():
            if name.lower() == model_lower:
                return self._ensure_capability_fields(cap, _default)
        # 前缀包含（如 "glm-5.1" 匹配 "GLM-5.1"）
        model_stripped = model_lower.replace("-", "").replace(".", "")
        for name, cap in self.MODEL_CAPABILITIES.items():
            name_stripped = name.lower().replace("-", "").replace(".", "")
            if name_stripped == model_stripped:
                return self._ensure_capability_fields(cap, _default)
            if name_stripped in model_stripped or model_stripped in name_stripped:
                return self._ensure_capability_fields(cap, _default)
        return dict(_default)

    @staticmethod
    def _ensure_capability_fields(cap: dict, fallback: dict) -> dict:
        """确保 cap dict 包含 context_window 和 max_output，缺失时用 fallback 填充"""
        if "context_window" not in cap or not cap["context_window"]:
            cap["context_window"] = fallback["context_window"]
        if "max_output" not in cap or not cap["max_output"]:
            cap["max_output"] = fallback["max_output"]
        return cap

    def get_context_window(self, model: str = None) -> int:
        """获取模型上下文窗口大小"""
        if model is None:
            model = _cfg("cloud_model", "gpt-4o-mini")
        return self._lookup_capabilities(model)["context_window"]

    def _build_messages(self, message: str, history: Optional[List] = None,
                        context_cache: str = None,
                        kb_mode: bool = False, strategy_enhancement: str = "",
                        kb_history_turns: int = 0, task_type: str = None,
                        _cloud_kb_mode: bool = False) -> list:
        """根据 context_policy 构建 messages 数组

        三种策略：
          - "full": system + full_history + [current_msg]
          - "current_only": [system, current_msg]
          - "slim_history": [system] + history[-N*2:] + [current_msg]
        """
        # 构建 system prompt
        system_content = "你是桌伴(Sidemate)，本地AI办公助手。中文直接回答。"
        try:
            if _cloud_kb_mode:
                # KB 对比模式云端列：用大模型专用 prompt，发挥推理+结构化能力
                from prompts import CLOUD_KB_SYSTEM_PROMPT
                system_content = CLOUD_KB_SYSTEM_PROMPT
            else:
                from prompts import SYSTEM_PROMPT_V2
                system_content = SYSTEM_PROMPT_V2
        except Exception:
            pass

        # 添加策略增强和任务类型提示
        extras = []
        if task_type and task_type != "text":
            extras.append("当前任务类型: %s" % task_type)
        if strategy_enhancement:
            extras.append(strategy_enhancement)
        if extras:
            system_content += "\n" + "\n".join(extras)

        # 添加上下文缓存
        if context_cache:
            system_content += "\n\n[上下文摘要]\n" + context_cache

        messages = [{"role": "system", "content": system_content}]

        # 根据 context_policy 裁剪 history
        policy = _cfg("cloud_context_policy", "full")
        slim_rounds = _cfg("cloud_slim_history_rounds", 6)

        if history:
            if policy == "current_only":
                # 不发送任何 history
                pass
            elif policy == "slim_history":
                # 只保留最近 N 轮（每轮 = user + assistant = 2 条）
                max_msgs = slim_rounds * 2
                trimmed = history[-max_msgs:] if len(history) > max_msgs else history
                for item in trimmed:
                    role = item.get("role", "user")
                    content = item.get("content", "")
                    if role in ("user", "assistant") and content:
                        messages.append({"role": role, "content": content})
            else:
                # "full" — 发送完整 history
                for item in history:
                    role = item.get("role", "user")
                    content = item.get("content", "")
                    if role in ("user", "assistant") and content:
                        messages.append({"role": role, "content": content})

        # KB 模式下，KB 文档内容不受裁剪，完整附加到当前消息前
        if kb_mode:
            pass  # KB 文档已通过 prompt_builder 处理，此处不额外干预

        # 当前用户消息
        messages.append({"role": "user", "content": message})

        return messages

    def run(self, message: str, model=None, max_tokens=None, history=None,
            context_cache=None,
            _agent_mode: bool = False, override_task_type: str = None,
            strategy_enhancement: str = "",
            kb_mode: bool = False,
            kb_history_turns: int = 0,
            _priority: str = None,
            _skip_queue: bool = False,
            _cloud_kb_mode: bool = False):
        """流式生成，yield (phase, content) — 与 StreamEngine.run() 完全一致

        phase 含义:
          "task_type" - 任务分类结果，content 为 (task_type, confidence) 元组
          "text" - 正文 token 流
          "raw" - 错误信息
        """
        mm = self._mm

        # ===== 检查 openai 包 =====
        if not _HAS_OPENAI:
            yield ("raw", "[ERROR] openai 包未安装，请运行 pip install openai>=1.30")
            return

        # ===== 确定模型 =====
        cloud_model = model if model else _cfg("cloud_model", "gpt-4o-mini")

        # ===== 智能任务分类（与 StreamEngine 一致）=====
        if kb_mode:
            task_type = "text"
            confidence = 0.99
        elif override_task_type:
            task_type = override_task_type
            confidence = 0.99
        elif _agent_mode:
            task_type = "agent"
            confidence = 0.95
        else:
            task_type = "text"
            confidence = 0.3
            try:
                from intelligence.task_classifier import classify_task
                task_type, confidence = classify_task(message, history)
            except Exception as e:
                log.debug("[CLOUD] task_classifier 失败: %s" % str(e)[:60])

        yield ("task_type", (task_type, confidence))

        # ===== 构建 messages =====
        messages = self._build_messages(
            message, history=history, context_cache=context_cache,
            kb_mode=kb_mode,
            strategy_enhancement=strategy_enhancement,
            kb_history_turns=kb_history_turns, task_type=task_type,
            _cloud_kb_mode=_cloud_kb_mode,
        )

        # ===== max_tokens =====
        if max_tokens is None:
            model_caps = self._lookup_capabilities(cloud_model)
            max_tokens = model_caps["max_output"]

        # KB 模式限制输出长度
        if kb_mode and max_tokens > 2048:
            max_tokens = 2048

        # ===== 流式调用 =====
        mm._gen_done.clear()
        mm.stop_requested = False

        t0 = time.time()
        total_chars = 0
        full_output = ""

        ticket = None
        try:
            if _skip_queue:
                # 对比模式云端列：不占用本地 GPU 队列，直接发起云端请求
                ticket = None
            else:
                from core.generate_queue import GenerateQueue
                queue_priority = _priority if _priority else GenerateQueue.HIGH
                ticket = mm.generate_queue.submit(priority=queue_priority, timeout=60)
                if ticket is None:
                    yield ("raw", "[ERROR] 等待设备释放超时（60s）或请求被取消")
                    return

            client = self._get_client()

            base_url = _cfg("cloud_base_url", "")
            api_key_set = bool(_cfg("cloud_api_key", ""))
            log_scan.info("[CLOUD] 开始流式请求: model=%s, messages=%d条, max_tokens=%d, base_url=%s, api_key_set=%s" % (
                cloud_model, len(messages), max_tokens, base_url[:50] if base_url else "(empty)", api_key_set))

            # Patch4 修复 8：在 stream 调用外层包一层重试
            # 约束：只要已经开始向下游 yield token/think_token，就不再重试（避免重复输出）
            _last_usage = None  # 最后一个 chunk 的 usage 字段
            _stream_done = False
            _cloud_call_start = time.time()  # 用量统计：记录调用起始时间
            for _attempt in range(MAX_RETRIES + 1):
                _reasoning_started = False  # 是否已发送 think_start
                _yielded_any = False  # 本轮是否已向下游 yield 任何 token
                try:
                    stream = client.chat.completions.create(
                        model=cloud_model,
                        messages=messages,
                        max_tokens=max_tokens,
                        stream=True,
                        stream_options={"include_usage": True},  # 用量统计：要求 API 返回真实 usage
                        temperature=0.7,
                    )

                    for chunk in stream:
                        if mm.stop_requested:
                            log_scan.info("[CLOUD] 用户停止，中断流式读取")
                            break

                        # 提取 usage（最后一个有效 chunk 的 usage 即为最终统计）
                        if hasattr(chunk, 'usage') and chunk.usage:
                            _last_usage = chunk.usage

                        if chunk.choices and chunk.choices[0].delta:
                            delta = chunk.choices[0].delta

                            # 1) 推理模型的 reasoning_content（如 GLM-5.1, DeepSeek-R1 等）
                            #    逐条推送，前端实时渲染（流式思考效果）
                            reasoning = getattr(delta, 'reasoning_content', None) or ""
                            if reasoning:
                                if not _reasoning_started:
                                    yield ("think_start", "")
                                    _reasoning_started = True
                                total_chars += len(reasoning)
                                _yielded_any = True
                                yield ("think_token", reasoning)

                            # 2) 正文 content
                            content = delta.content or ""
                            if content:
                                # 如果之前有推理内容，先关闭思考区
                                if _reasoning_started:
                                    yield ("think_end", "")
                                    _reasoning_started = False
                                full_output += content
                                total_chars += len(content)
                                _yielded_any = True
                                yield ("text", content)

                            # 检查结束原因
                            finish_reason = chunk.choices[0].finish_reason
                            if finish_reason == "stop":
                                # 如果结束时还在思考，关闭思考区
                                if _reasoning_started:
                                    yield ("think_end", "")
                                    _reasoning_started = False
                                break

                    # for 循环正常结束（或用户停止），本轮视为完成
                    _stream_done = True
                    break

                except Exception as stream_err:
                    # 关闭可能未关的思考区（best effort）
                    if _reasoning_started:
                        try:
                            yield ("think_end", "")
                        except Exception:
                            pass
                        _reasoning_started = False

                    # 已开始向下游 yield token → 不重试，直接抛出
                    if _yielded_any:
                        raise
                    # 已是最后一次尝试 → 抛出由外层 except 捕获
                    if _attempt >= MAX_RETRIES or not _is_retryable(stream_err):
                        raise
                    # 重试：简单退避
                    _backoff = 1.0 * (_attempt + 1)
                    log_scan.warning("[CLOUD] 第 %d 次重试（%s），%.1fs 后重试",
                                     _attempt + 1, str(stream_err)[:80], _backoff)
                    time.sleep(_backoff)
                    # 回退本轮已累积的输出（避免重复拼接）
                    # 注意：full_output/total_chars 在重试场景下应为 0（_yielded_any=False），
                    # 这里仍然清零，保险
                    full_output = ""
                    continue

            # for 循环正常结束后，如果还在思考区，关闭
            if _reasoning_started:
                yield ("think_end", "")
                _reasoning_started = False

            # 用量统计埋点（4 道防线之 1+3：正常完成记真实 usage，缺失也记请求次数）
            # 放在 token_stats 之前，确保不管有没有 usage 都记录这次调用
            try:
                from core.cloud_usage import record_usage
                _elapsed_ms = int((time.time() - _cloud_call_start) * 1000)
                if _last_usage:
                    _in_tok = getattr(_last_usage, 'prompt_tokens', 0) or 0
                    _out_tok = getattr(_last_usage, 'completion_tokens', 0) or 0
                    _reason_tok = (getattr(_last_usage, 'completion_tokens_details', None)
                                   and getattr(_last_usage.completion_tokens_details, 'reasoning_tokens', 0)) or 0
                    record_usage(cloud_model, input_tokens=_in_tok, output_tokens=_out_tok,
                                 reasoning_tokens=_reason_tok, elapsed_ms=_elapsed_ms, token_accurate=True)
                else:
                    # 诚实：API 未返回 usage，只记请求次数，不编造 token
                    record_usage(cloud_model, elapsed_ms=_elapsed_ms, token_accurate=False)
            except Exception as _ue:
                log.debug("[CLOUD] 用量记录失败(不影响主流程): %s", _ue)

            # 发送 token_stats（从 usage 提取）
            if _last_usage:
                _token_stats = {
                    "input_tokens": getattr(_last_usage, 'prompt_tokens', 0) or 0,
                    "output_tokens": getattr(_last_usage, 'completion_tokens', 0) or 0,
                    "reasoning_tokens": getattr(_last_usage, 'completion_tokens_details', None)
                                       and getattr(_last_usage.completion_tokens_details, 'reasoning_tokens', 0) or 0,
                }
                yield ("token_stats", _token_stats)

        except ImportError as e:
            err_info = _translate_cloud_error(e)
            log_scan.error("[CLOUD] 异常: %s", err_info["detail"])
            yield ("error", err_info)
            return
        except Exception as e:
            err_info = _translate_cloud_error(e)
            log_scan.error("[CLOUD] 异常: %s", err_info["detail"])
            yield ("error", err_info)
            return
        finally:
            if ticket is not None:
                ticket.release()
            mm._gen_done.set()

        elapsed = time.time() - t0
        with mm._stats_lock:
            mm._stats["total_requests"] += 1
            mm._stats["total_llm_chars"] += total_chars
            mm._stats["total_llm_time"] += elapsed

        log_scan.info("[CLOUD] 完成: content=%d字, elapsed=%.1fs, model=%s" % (
            total_chars, elapsed, cloud_model))

    def run_with_tools(self, messages, tools=None, model=None, max_tokens=None,
                       temperature=0.7):
        """带 FC 工具的流式调用 — 供 AgentLoop 使用

        与 run() 的区别：
        1. 接收 messages 数组而非 message 字符串（AgentLoop 自行管理 history）
        2. 传入 tools 参数（FC tools JSON）
        3. 新增 "tool_calls" phase：当模型返回 FC 调用时，content 为解析后的 tool_calls 列表

        Args:
            messages: OpenAI 格式的 messages 数组
            tools: FC tools JSON 列表（可选）
            model: 模型名称（可选，默认使用配置值）
            max_tokens: 最大 token 数（可选）
            temperature: 温度（默认 0.7）

        Yields:
            (phase, content) 元组:
              "text"        — 正文 token 流（str）
              "think_start" — 推理开始（""）
              "think_token" — 推理 token（str）
              "think_end"   — 推理结束（""）
              "tool_calls"  — FC 工具调用（list[dict]）
              "raw"         — 错误信息（str）
        """
        mm = self._mm

        if not _HAS_OPENAI:
            yield ("raw", "[ERROR] openai 包未安装，请运行 pip install openai>=1.30")
            return

        cloud_model = model if model else _cfg("cloud_model", "gpt-4o-mini")

        if max_tokens is None:
            model_caps = self._lookup_capabilities(cloud_model)
            max_tokens = model_caps["max_output"]

        mm._gen_done.clear()
        mm.stop_requested = False

        ticket = None
        try:
            from core.generate_queue import GenerateQueue
            ticket = mm.generate_queue.submit(priority=GenerateQueue.HIGH, timeout=60)
            if ticket is None:
                yield ("raw", "[ERROR] 等待设备释放超时（60s）或请求被取消")
                return

            client = self._get_client()

            # 构建请求参数
            create_kwargs = {
                "model": cloud_model,
                "messages": messages,
                "max_tokens": max_tokens,
                "stream": True,
                "stream_options": {"include_usage": True},  # 用量统计：要求 API 返回真实 usage
                "temperature": temperature,
            }
            if tools:
                create_kwargs["tools"] = tools

            # Patch4 修复 8：stream 调用外层包一层重试
            # 约束：已向下游 yield 任何 token/think_token/tool_calls 后不再重试
            _tc_buffers = {}  # index → {id, name, arguments}
            _last_usage_wt = None  # 最后一个 chunk 的 usage 字段
            _cloud_call_start_wt = time.time()  # 用量统计：记录调用起始时间
            finish_reason = None
            for _attempt_wt in range(MAX_RETRIES + 1):
                _reasoning_started = False
                _yielded_any = False
                _tc_buffers = {}  # 每次重试重置 tool_calls 累积器
                finish_reason = None
                try:
                    stream = client.chat.completions.create(**create_kwargs)

                    for chunk in stream:
                        if mm.stop_requested:
                            log_scan.info("[CLOUD-WT] 用户停止，中断流式读取")
                            break

                        # 提取 usage（即使 choices 为空，最后一个 chunk 可能只含 usage）
                        if hasattr(chunk, 'usage') and chunk.usage:
                            _last_usage_wt = chunk.usage

                        if not chunk.choices:
                            continue

                        choice = chunk.choices[0]
                        delta = choice.delta

                        # 1) 推理内容
                        reasoning = getattr(delta, 'reasoning_content', None) or ""
                        if reasoning:
                            if not _reasoning_started:
                                yield ("think_start", "")
                                _reasoning_started = True
                            _yielded_any = True
                            yield ("think_token", reasoning)

                        # 2) FC 工具调用（增量拼接）
                        if hasattr(delta, 'tool_calls') and delta.tool_calls:
                            for tc in delta.tool_calls:
                                idx = tc.index
                                if idx not in _tc_buffers:
                                    _tc_buffers[idx] = {
                                        "id": tc.id or "",
                                        "type": "function",
                                        "function": {
                                            "name": (tc.function.name or "") if tc.function else "",
                                            "arguments": ""
                                        }
                                    }
                                # 累积 id / name / arguments delta
                                if tc.id:
                                    _tc_buffers[idx]["id"] = tc.id
                                if tc.function:
                                    if tc.function.name:
                                        _tc_buffers[idx]["function"]["name"] = tc.function.name
                                    if tc.function.arguments:
                                        _tc_buffers[idx]["function"]["arguments"] += tc.function.arguments

                        # 3) 正文 content
                        content = delta.content or ""
                        if content:
                            if _reasoning_started:
                                yield ("think_end", "")
                                _reasoning_started = False
                            _yielded_any = True
                            yield ("text", content)

                        # 4) 流结束检查
                        finish_reason = choice.finish_reason
                        if finish_reason == "tool_calls":
                            # FC 调用完成，关闭思考区（如果还在）
                            if _reasoning_started:
                                yield ("think_end", "")
                                _reasoning_started = False
                            # 解析并返回完整的 tool_calls 列表
                            tc_list = []
                            for idx_key in sorted(_tc_buffers.keys()):
                                tc_list.append(_tc_buffers[idx_key])
                            _yielded_any = True
                            yield ("tool_calls", tc_list)
                            break
                        elif finish_reason == "stop":
                            if _reasoning_started:
                                yield ("think_end", "")
                                _reasoning_started = False
                            break

                    # 本轮 stream 正常结束
                    break

                except Exception as stream_err_wt:
                    # 关闭可能未关的思考区
                    if _reasoning_started:
                        try:
                            yield ("think_end", "")
                        except Exception:
                            pass
                        _reasoning_started = False

                    # 已开始向下游 yield → 不重试
                    if _yielded_any:
                        raise
                    # 已是最后一次尝试 → 抛出
                    if _attempt_wt >= MAX_RETRIES or not _is_retryable(stream_err_wt):
                        raise
                    # 重试
                    _backoff_wt = 1.0 * (_attempt_wt + 1)
                    log_scan.warning("[CLOUD-WT] 第 %d 次重试（%s），%.1fs 后重试",
                                     _attempt_wt + 1, str(stream_err_wt)[:80], _backoff_wt)
                    time.sleep(_backoff_wt)
                    continue

            # for 循环结束后，如果还在思考区，关闭
            if _reasoning_started:
                yield ("think_end", "")
                _reasoning_started = False

            # 如果有累积的 tool_calls 但没有收到 finish_reason=tool_calls
            # （某些 API 实现可能不发送 finish_reason）
            if _tc_buffers and finish_reason != "tool_calls":
                tc_list = []
                for idx_key in sorted(_tc_buffers.keys()):
                    tc_list.append(_tc_buffers[idx_key])
                yield ("tool_calls", tc_list)

            # 用量统计埋点（agent 工具调用路径）
            try:
                from core.cloud_usage import record_usage
                _elapsed_ms_wt = int((time.time() - _cloud_call_start_wt) * 1000)
                if _last_usage_wt:
                    _in_w = getattr(_last_usage_wt, 'prompt_tokens', 0) or 0
                    _out_w = getattr(_last_usage_wt, 'completion_tokens', 0) or 0
                    _reason_w = (getattr(_last_usage_wt, 'completion_tokens_details', None)
                                 and getattr(_last_usage_wt.completion_tokens_details, 'reasoning_tokens', 0)) or 0
                    record_usage(cloud_model, input_tokens=_in_w, output_tokens=_out_w,
                                 reasoning_tokens=_reason_w, elapsed_ms=_elapsed_ms_wt, token_accurate=True)
                else:
                    record_usage(cloud_model, elapsed_ms=_elapsed_ms_wt, token_accurate=False)
            except Exception as _ue:
                log.debug("[CLOUD-WT] 用量记录失败(不影响主流程): %s", _ue)

            # 发送 token_stats
            if _last_usage_wt:
                _token_stats_wt = {
                    "input_tokens": getattr(_last_usage_wt, 'prompt_tokens', 0) or 0,
                    "output_tokens": getattr(_last_usage_wt, 'completion_tokens', 0) or 0,
                    "reasoning_tokens": getattr(_last_usage_wt, 'completion_tokens_details', None)
                                       and getattr(_last_usage_wt.completion_tokens_details, 'reasoning_tokens', 0) or 0,
                }
                yield ("token_stats", _token_stats_wt)

        except ImportError as e:
            err_info = _translate_cloud_error(e)
            log_scan.error("[CLOUD-WT] 异常: %s", err_info["detail"])
            yield ("error", err_info)
            return
        except Exception as e:
            err_info = _translate_cloud_error(e)
            log_scan.error("[CLOUD-WT] 异常: %s", err_info["detail"])
            yield ("error", err_info)
            return
        finally:
            if ticket is not None:
                ticket.release()
            mm._gen_done.set()

    def test_connection(self, _temp_api_key: str = "", _temp_base_url: str = "", _temp_model: str = ""):
        """测试连接，返回 (ok, latency_ms, error)

        只调 models.list() 验证 API Key + 网络连通性，不发 LLM 请求。
        支持 _temp_* 参数：传入未保存的表单值用于测试连接。
        """
        if not _HAS_OPENAI:
            return (False, 0, "openai 包未安装")

        # N-4 修复：表单传入的 _temp_api_key 是原始明文 key，不能按 base64 解码；
        # 只有已保存的配置值 cloud_api_key 是 base64 编码，需要解码。
        if _temp_api_key:
            api_key = _temp_api_key
        else:
            api_key = self._decode_api_key(_cfg("cloud_api_key", ""))
        if not api_key:
            return (False, 0, "API Key 未配置")

        base_url = _temp_base_url or _cfg("cloud_base_url", "https://api.openai.com/v1")
        cloud_model = _temp_model or _cfg("cloud_model", "gpt-4o-mini")

        try:
            t0 = time.time()
            client = openai.OpenAI(base_url=base_url, api_key=api_key, timeout=15.0)
            # models.list() 只验证 Key + 网络连通，不消耗 token
            client.models.list()
            latency = int((time.time() - t0) * 1000)
            # 检查模型是否存在（可选）
            return (True, latency, None)
        except openai.APIConnectionError as e:
            return (False, 0, _translate_cloud_error(e).get("user_msg", str(e)[:200]))
        except openai.APITimeoutError:
            return (False, 0, "⏱️ 连接超时：服务器响应时间过长。请检查网络或稍后重试。")
        except openai.AuthenticationError:
            return (False, 0, " 认证失败：API Key 无效或已过期。请在设置中检查 API Key。")
        except Exception as e:
            return (False, 0, str(e)[:200])

    @staticmethod
    def mask_api_key(key: str) -> str:
        """API Key 脱敏显示: sk-***...***abc"""
        if not key or len(key) < 8:
            return "***"
        return key[:3] + "***...***" + key[-3:]
