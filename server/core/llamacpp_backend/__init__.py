# -*- coding: utf-8 -*-
"""
llamacpp_backend — llama.cpp 推理后端（P7-4 底座替换）

替代 ollama_manager.py + stream_engine.py 中的 Ollama 交互层。

模块组成：
  - manager.py   : llama-server 进程生命周期管理（启动/停止/watchdog/ownership）
  - client.py    : OpenAI 兼容 API 客户端（流式/非流式/think/工具调用）
  - registry.py  : 模型注册表（meta.json 扫描 + 硬件推荐）
"""
from .manager import LlamaCppManager
from .client import LlamaCppClient
from .registry import ModelRegistry, ModelInfo

__all__ = ["LlamaCppManager", "LlamaCppClient", "ModelRegistry", "ModelInfo"]
