# -*- coding: utf-8 -*-
"""
task_classifier.py — 策略路由器 v10
关键词优先级链匹配，零 token 成本。
替代旧的贝叶斯先验 + 加权关键词评分 + Agent子意图 等全部逻辑。
"""
__version__ = "v10"

import re
import logging

log = logging.getLogger(__name__)

# 从 prompts 导入 STRATEGY_CONFIG
try:
    from prompts import STRATEGY_CONFIG
except ImportError:
    log.warning("STRATEGY_CONFIG 导入失败，使用空配置")
    STRATEGY_CONFIG = {}

# ===== 闲聊精确匹配模式（整句匹配） =====
_GREETING_PATTERNS = [
    r'^(你好|hi|hello|嗨|hey|嘿|早上好|下午好|晚上好|早安|晚安|'
    r'谢谢|感谢|thanks|thank you|ok|好的|嗯|哦|bye|再见|拜拜|'
    r'哈哈|嘻嘻|呵呵|牛|厉害|不错|可以的|行|好)$',
]

# ===== 关键词列表（有序，优先级从高到低） =====
_CODE_KEYWORDS = [
    "代码", "编程", "函数", "算法", "调试", "优化", "重构", "递归", "正则",
    "部署", "api", "接口", "python", "java", "javascript", "js", "sql",
    "css", "html", "vue", "react", "flask", "django", "fastapi",
    "bug", "error", "debug", "traceback", "异常", "报错",
]
_CODE_PHRASES = ["写个", "实现一个", "帮我写", "写一段"]

_MATH_KEYWORDS = [
    "计算", "方程", "求解", "证明", "推导", "积分", "微分", "概率", "矩阵",
    "等于几", "加", "减", "乘", "除", "数学", "算术", "开方", "平方", "立方",
]

_LOGIC_KEYWORDS = [
    "推理", "逻辑", "如果", "那么", "假设", "推导", "真假", "命题", "悖论", "必然",
]

_SUMMARIZE_KEYWORDS = [
    "总结", "摘要", "概括", "提炼", "归纳", "要点", "核心内容", "主要内容",
    "summarize", "summary",
]

_ANALYSIS_KEYWORDS = [
    "分析", "对比", "比较", "评估", "评价", "优缺点", "利弊", "方案", "可行性",
    "为什么", "原因", "深入",
]

_CREATIVE_KEYWORDS = [
    "创作", "故事", "小说", "诗歌", "散文", "文案", "广告", "演讲",
    "读后感", "观后感", "想象", "幻想", "虚构",
]
# creative 不含"写"字——"写个函数"走 code，"写个故事"走 creative
# "帮我写周报"等无 code/creative 信号的走 default


def is_greeting(message: str) -> bool:
    """精确匹配闲聊，整句 trim 后匹配"""
    msg = message.strip().lower()
    return any(re.match(p, msg) for p in _GREETING_PATTERNS)


def resolve_strategy(message: str, strategy_override: str = None) -> dict:
    """
    根据用户输入解析策略。返回 STRATEGY_CONFIG 中的一个 dict。

    Args:
        message: 用户输入文本（可能已去掉 /xx 前缀）
        strategy_override: /xx 指令指定的策略类型，优先级最高

    Returns:
        {"type": "code", "system_enhancement": "...", "temperature_offset": -0.2, "think_instruction": ""}
    """
    # 0. 指令覆盖（最高优先级）
    if strategy_override:
        config = STRATEGY_CONFIG.get(strategy_override, STRATEGY_CONFIG.get("default", {}))
        return {"type": strategy_override, **config}

    msg = message.strip()
    msg_lower = msg.lower()

    # 1. greeting（确定性最高）
    if is_greeting(msg):
        config = STRATEGY_CONFIG.get("greeting", {})
        return {"type": "greeting", **config}

    # 2. code（编程短语优先于纯关键词）
    if any(phrase in msg_lower for phrase in _CODE_PHRASES):
        has_creative_signal = any(kw in msg_lower for kw in _CREATIVE_KEYWORDS)
        if not has_creative_signal:
            config = STRATEGY_CONFIG.get("code", {})
            return {"type": "code", **config}

    if any(kw in msg_lower for kw in _CODE_KEYWORDS):
        config = STRATEGY_CONFIG.get("code", {})
        return {"type": "code", **config}

    # 3. math
    if any(kw in msg_lower for kw in _MATH_KEYWORDS):
        config = STRATEGY_CONFIG.get("math", {})
        return {"type": "math", **config}

    # 4. logic
    if any(kw in msg_lower for kw in _LOGIC_KEYWORDS):
        config = STRATEGY_CONFIG.get("logic", {})
        return {"type": "logic", **config}

    # 5. summarize
    if any(kw in msg_lower for kw in _SUMMARIZE_KEYWORDS):
        config = STRATEGY_CONFIG.get("summarize", {})
        return {"type": "summarize", **config}

    # 6. analysis
    if any(kw in msg_lower for kw in _ANALYSIS_KEYWORDS):
        config = STRATEGY_CONFIG.get("analysis", {})
        return {"type": "analysis", **config}

    # 7. creative
    if any(kw in msg_lower for kw in _CREATIVE_KEYWORDS):
        config = STRATEGY_CONFIG.get("creative", {})
        return {"type": "creative", **config}

    # 8. default（兜底）
    config = STRATEGY_CONFIG.get("default", {})
    return {"type": "default", **config}


# ===== 向后兼容函数（供 models.py 逐步迁移） =====
# 这些函数保留接口但简化实现，避免 models.py 改动太大导致连锁报错

def classify_task(message: str, history: list = None, scene: str = None) -> tuple:
    """向后兼容：将 resolve_strategy 结果映射为旧的 (task_type, confidence) 格式"""
    strategy = resolve_strategy(message)
    # 映射 strategy type → 旧 task_type
    _MAP = {
        "greeting": "text", "qa": "text", "math": "reasoning",
        "logic": "reasoning", "code": "code", "analysis": "reasoning",
        "creative": "text", "summarize": "text", "default": "text",
    }
    task_type = _MAP.get(strategy["type"], "text")
    return (task_type, 0.8)

def get_think_instruction(task_type: str) -> str:
    """向后兼容：返回空字符串（不再控制思考模式）"""
    return ""

def get_temperature_offset(task_type: str) -> float:
    """向后兼容：返回 0.0（由 strategy 替代）"""
    return 0.0

def get_max_tokens(task_type: str) -> int:
    """向后兼容：返回 0（不限制）"""
    return 0

def get_dynamic_max_tokens(task_type: str, message: str) -> int:
    """向后兼容：返回 0"""
    return 0

def get_classify_signals(message: str, task_type: str = None) -> dict:
    """向后兼容：返回空字典"""
    return {}

def check_mode_hint(current_scene: str, message: str) -> str:
    """向后兼容：返回空字符串"""
    return ""

# P6: check_topic_drift 已移除（死代码，误报率高，全链路清理）
# P6: extract_keywords 已移除（仅被 check_topic_drift 调用）

def get_agent_hint(message: str) -> dict:
    """向后兼容：返回默认 agent hint"""
    return {"task_type": "agent", "suggested_tools": [], "hint": "",
            "estimated_steps": 0, "sub_intent": "unknown"}

# P6: extract_keywords 已移除（仅被 check_topic_drift 调用，已随该函数删除）
