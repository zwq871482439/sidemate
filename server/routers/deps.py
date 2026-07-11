# -*- coding: utf-8 -*-
"""
routers/deps.py — 共享依赖注入

每个 Router 通过 FastAPI Depends() 获取全局服务实例，
避免直接从 server.py import 造成循环依赖。
"""
import os
import logging
import threading

log = logging.getLogger(__name__)

# 全局常量 — 从 config 获取
from config import WORKSPACE_DIR, CHAT_DIR, UPLOAD_DIR, FILES_DIR

# _current_chat_file 并发保护
_chat_file_lock = threading.Lock()


def get_mgr():
    """获取全局 ModelManager 实例"""
    from server import mgr
    return mgr


def get_kb():
    """获取全局 KnowledgeBase 实例"""
    from server import kb
    return kb


# P6 归档：get_recorder() 已移除（recorder_pkg 已归档）


def get_ollama():
    """获取全局 OllamaManager 实例"""
    from server import ollama_manager
    return ollama_manager


# (get_skill_loader 已移除 — Skill 框架已归档)


def get_notebook():
    """获取全局 PetNotebook 实例（挂在 mgr.notebook）"""
    from server import mgr
    return mgr.notebook


def get_current_chat_file():
    """获取当前对话文件路径（可变列表包装）"""
    from server import _current_chat_file
    return _current_chat_file


def get_current_chat() -> str:
    """线程安全地获取当前对话文件路径"""
    with _chat_file_lock:
        from server import _current_chat_file
        return _current_chat_file[0]


def set_current_chat(path: str) -> None:
    """线程安全地设置当前对话文件路径"""
    with _chat_file_lock:
        from server import _current_chat_file
        _current_chat_file[0] = path


def get_default_llm():
    """获取默认 LLM 名称"""
    from server import DEFAULT_LLM
    return DEFAULT_LLM


def get_log():
    """获取主 logger"""
    return log


# (get_perm_mgr / get_audit_logger 已移除 — 权限/审计已归档)


# (get_feedback_mgr / get_training_mgr / get_active_pipelines 已移除 — 死代码，全局零引用)
