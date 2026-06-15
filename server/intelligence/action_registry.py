# -*- coding: utf-8 -*-
"""
action_registry.py — Action 扩展注册表
管理内置 Action 和已安装的扩展 Action。
"""
import logging
import threading

log = logging.getLogger(__name__)

# 内置 Action（不允许被扩展覆盖）
BUILTIN_ACTIONS = {
    "chat": {
        "icon_svg": '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        "label": "聊天",
        "title": "直接对话",
        "placeholder": "说点什么...",
    },
    "doc": {
        "icon_svg": '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>',
        "label": "文档生成",
        "title": "文档生成",
        "placeholder": "描述要生成的文档...",
    },
}

# 运行时注册的扩展 Actions
_installed_actions: dict = {}
_actions_lock = threading.Lock()


def register_action(meta: dict):
    """安装 .sidemate action 扩展时调用
    
    Args:
        meta: 包含 action_id, action_label, action_title, action_placeholder, steps 等字段
    
    Raises:
        ValueError: 如果 action_id 与内置 Action 冲突
    """
    action_id = meta.get("action_id", "")
    if not action_id:
        raise ValueError("action_id 不能为空")
    if action_id in BUILTIN_ACTIONS:
        raise ValueError("内置 Action '%s' 不允许被覆盖" % action_id)
    
    with _actions_lock:
        _installed_actions[action_id] = {
            "label": meta.get("action_label", "🔧"),
            "title": meta.get("action_title", action_id),
            "placeholder": meta.get("action_placeholder", "输入指令…"),
            "action_config": meta.get("steps", []),
        }
    log.info("[ACTION] 注册扩展 Action: %s (%s)" % (action_id, meta.get("action_title", "")))


def unregister_action(action_id: str):
    """卸载扩展 Action"""
    if action_id in BUILTIN_ACTIONS:
        log.warning("[ACTION] 不能卸载内置 Action: %s" % action_id)
        return False
    with _actions_lock:
        removed = _installed_actions.pop(action_id, None)
    if removed:
        log.info("[ACTION] 卸载扩展 Action: %s" % action_id)
        return True
    return False


def get_available_actions() -> list:
    """获取所有可用 Action（前端调用）"""
    actions = []
    for aid, info in BUILTIN_ACTIONS.items():
        actions.append({"id": aid, "builtin": True, **info})
    with _actions_lock:
        for aid, info in _installed_actions.items():
            actions.append({"id": aid, "builtin": False, **info})
    return actions


def get_action_config(action_id: str) -> dict:
    """获取指定 Action 的配置（扩展用）"""
    if action_id in BUILTIN_ACTIONS:
        return {"id": action_id, "builtin": True, **BUILTIN_ACTIONS[action_id]}
    if action_id in _installed_actions:
        return {"id": action_id, "builtin": False, **_installed_actions[action_id]}
    return None
