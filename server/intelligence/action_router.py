# -*- coding: utf-8 -*-
"""
action_router.py — Action 路由器
解析 /xx 指令，确定 Action（用户选）和 Strategy（规则自动）
"""

import re

# /xx 指令 → Action 映射（改变 action）— 键不含 /，与正则捕获组匹配
_SLASH_ACTION = {
    "doc": "doc",
}

# /xx 指令 → Strategy 映射（覆盖策略，不改 action）— 键不含 /
_SLASH_STRATEGY = {
    "fast":  "greeting",
    "qa":    "qa",
    "code":  "code",
    "math":  "math",
    "logic": "logic",
    "deep":  "analysis",
    "write": "creative",
    "sum":   "summarize",
}

# 合并所有 /xx 指令（用于前端提示）
_SLASH_HINTS = {
    "doc":  " 文档生成模式（本次）",
    "fast": " 轻量策略（本次）",
    "qa":   " 问答策略（本次）",
    "code": " 编程策略（本次）",
    "math": " 数学策略（本次）",
    "logic":" 逻辑推理策略（本次）",
    "deep": " 深度分析策略（本次）",
    "write":"️ 创意写作策略（本次）",
    "sum":  " 摘要策略（本次）",
}

# 匹配 /xx 前缀的正则
_SLASH_RE = re.compile(r'^/([a-zA-Z]+)\s*(.*)', re.DOTALL)


def resolve_action(message: str, current_action: str = "chat") -> dict:
    """
    解析用户输入，确定 Action 和 Strategy。
    
    Args:
        message: 用户原始输入
        current_action: 当前 Action（默认 "chat"）
    
    Returns:
        {
            "action": str,           # 最终 action: "chat"|"doc"|扩展ID
            "strategy_override": str|None,  # 策略覆盖（如有 /xx 指令）
            "clean_message": str,    # 去掉 /xx 前缀后的消息
            "slash_hint": str|None,  # /xx 提示文本（如有）
            "slash_key": str|None,   # /xx 原始 key（如 "kb", "code"）
        }
    """
    result = {
        "action": current_action,
        "strategy_override": None,
        "clean_message": message,
        "slash_hint": None,
        "slash_key": None,
    }
    
    if not message:
        return result
    
    m = _SLASH_RE.match(message.strip())
    if not m:
        return result
    
    slash_key = m.group(1).lower()
    rest = m.group(2).strip()
    
    # 检查是否是已知的 /xx 指令
    if slash_key in _SLASH_ACTION:
        result["action"] = _SLASH_ACTION[slash_key]
        result["clean_message"] = rest or message
        result["slash_hint"] = _SLASH_HINTS.get(slash_key)
        result["slash_key"] = slash_key
    elif slash_key in _SLASH_STRATEGY:
        result["strategy_override"] = _SLASH_STRATEGY[slash_key]
        result["clean_message"] = rest or message
        result["slash_hint"] = _SLASH_HINTS.get(slash_key)
        result["slash_key"] = slash_key
    else:
        # 未知 /xx 指令，原样保留（不处理）
        return result
    
    return result


def get_slash_hints() -> dict:
    """返回所有 /xx 提示文本（供前端使用）"""
    return dict(_SLASH_HINTS)
