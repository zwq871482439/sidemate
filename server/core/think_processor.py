# -*- coding: utf-8 -*-
"""ThinkProcessor — 思维链处理（v0.9 简化版）

v0.9 简化说明：
  - Ollama 的 OpenAI 兼容 API 会将 reasoning_content 和 content 分开返回
  - 不再需要从原始文本中检测 <think/> 标签
  - 保留 strip_think() 用于兼容旧对话历史中的残留 think 标签
  - 新增 process_reasoning() 处理 Ollama 返回的 reasoning_content
"""
import re
import logging

log = logging.getLogger(__name__)
log_scan = logging.getLogger("local-ai")


class ThinkProcessor:
    """思维链标签处理：兼容旧 think 标签 + 处理 Ollama reasoning_content"""

    def __init__(self):
        pass

    def strip_think(self, text: str) -> str:
        """公开接口：过滤思维链标签（委托给 _strip_think）"""
        return self._strip_think(text)

    def _strip_think(self, text: str) -> str:
        """过滤 LLM 输出中的所有标准思维链标签"""
        try:
            from intelligence.response_filter import strip_think_tags
            return strip_think_tags(text)
        except ImportError:
            # fallback: 简单正则清理
            text = re.sub(r'<think[^>]*>.*?</think[^>]*>', '', text, flags=re.DOTALL)
            text = re.sub(r'<think[^>\n]*[>\n]\s*', '', text, flags=re.DOTALL)
            return text.strip()

    def process_reasoning(self, reasoning_content: str) -> dict:
        """处理 Ollama 返回的 reasoning_content。

        Args:
            reasoning_content: Ollama API 返回的思考过程文本

        Returns:
            dict: {
                "fold": bool,       # 是否值得折叠展示
                "content": str,     # 思考内容
                "len": int,         # 思考内容长度
            }
        """
        if not reasoning_content or not reasoning_content.strip():
            return {"fold": False, "content": "", "len": 0}

        content = reasoning_content.strip()
        should_fold = len(content) >= 20

        return {
            "fold": should_fold,
            "content": content,
            "len": len(content),
        }

    def clean_response(self, text: str) -> str:
        """V2 回复后处理：strip think 标签 + 首字修正。

        防幻觉兜底：
          1. 移除残留的 think 标签（/no_think 失效时）
          2. 首字修正：如果以逗号、顿号开头，截掉（幻觉续写的典型特征）

        Args:
            text: 模型输出的文本

        Returns:
            str: 清理后的文本
        """
        if not text:
            return text

        # 1. 移除 think 标签
        text = self._strip_think(text)

        # 2. 首字修正：截掉开头的标点（逗号/顿号/分号/冒号）
        text = re.sub(r'^[，、；：]\s*', '', text)

        return text.strip()
