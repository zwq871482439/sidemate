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


