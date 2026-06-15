# -*- coding: utf-8 -*-
"""
extensions/registry.py — 扩展注册中心
=====================================
管理已安装扩展的注册信息，以 JSON 文件为持久化载体。

每个扩展对应一个 JSON 文件：
  extensions/{ext_id}.json
  内容示例:
  {
    "id": "knowledge",
    "version": "1.0.0",
    "models": {
      "embedding": "models/embedding",
      "reranker": "models/reranker"
    },
    "installed_at": "2025-01-01T00:00:00"
  }

支持的 ext_id:
  - "knowledge" : 文库扩展（embedding + reranker）
  - "recorder"  : 纪要扩展（faster-whisper）
  - "llm"       : LLM 模型扩展（本地大语言模型）
"""
import os
import json
import logging
from typing import Dict, List, Optional

log = logging.getLogger(__name__)


class ExtensionRegistry:
    """扩展注册中心 — 管理已安装的扩展"""

    # 合法的扩展 ID
    VALID_IDS = {"knowledge", "recorder", "llm"}

    def __init__(self, extensions_dir: str):
        """初始化扩展注册中心

        Args:
            extensions_dir: 存放注册 JSON 的目录（通常是项目根目录下的 extensions/）
        """
        self.extensions_dir = extensions_dir
        os.makedirs(self.extensions_dir, exist_ok=True)

    def _registry_path(self, ext_id: str) -> str:
        """获取扩展注册文件路径

        Args:
            ext_id: 扩展 ID（"knowledge" | "recorder"）

        Returns:
            注册 JSON 文件的绝对路径
        """
        return os.path.join(self.extensions_dir, "%s.json" % ext_id)

    def is_installed(self, ext_id: str) -> bool:
        """检查扩展是否已安装

        Args:
            ext_id: 扩展 ID（"knowledge" | "recorder"）

        Returns:
            True 如果注册文件存在且可解析
        """
        path = self._registry_path(ext_id)
        if not os.path.exists(path):
            return False
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return isinstance(data, dict) and data.get("id") == ext_id
        except Exception as e:
            log.warning("[EXT-REG] 解析注册文件失败 %s: %s", ext_id, str(e)[:80])
            return False

    def get_info(self, ext_id: str) -> dict:
        """获取扩展注册信息

        Args:
            ext_id: 扩展 ID

        Returns:
            注册信息字典，未安装时返回空字典
        """
        path = self._registry_path(ext_id)
        if not os.path.exists(path):
            return {}
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            log.warning("[EXT-REG] 读取注册信息失败 %s: %s", ext_id, str(e)[:80])
            return {}

    def register(self, ext_id: str, info: dict) -> bool:
        """注册扩展（写入 JSON 文件）

        Args:
            ext_id: 扩展 ID
            info: 扩展信息字典，至少包含 "id" 和 "version"

        Returns:
            True 如果注册成功
        """
        if ext_id not in self.VALID_IDS:
            log.error("[EXT-REG] 无效的扩展 ID: %s", ext_id)
            return False

        # 确保信息中包含 id
        info["id"] = ext_id

        # 补充安装时间
        if "installed_at" not in info:
            from datetime import datetime
            info["installed_at"] = datetime.now().isoformat()

        path = self._registry_path(ext_id)
        try:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "w", encoding="utf-8") as f:
                json.dump(info, f, ensure_ascii=False, indent=2)
            log.info("[EXT-REG] 扩展注册成功: %s v%s", ext_id, info.get("version", "?"))
            return True
        except Exception as e:
            log.error("[EXT-REG] 注册失败 %s: %s", ext_id, str(e)[:100])
            return False

    def unregister(self, ext_id: str) -> bool:
        """注销扩展（删除 JSON 文件）

        Args:
            ext_id: 扩展 ID

        Returns:
            True 如果注销成功或文件不存在
        """
        path = self._registry_path(ext_id)
        if not os.path.exists(path):
            return True
        try:
            os.remove(path)
            log.info("[EXT-REG] 扩展已注销: %s", ext_id)
            return True
        except Exception as e:
            log.error("[EXT-REG] 注销失败 %s: %s", ext_id, str(e)[:100])
            return False

    def list_installed(self) -> list:
        """列出所有已安装扩展

        Returns:
            已安装扩展的信息列表
        """
        result = []
        for ext_id in self.VALID_IDS:
            if self.is_installed(ext_id):
                info = self.get_info(ext_id)
                if info:
                    result.append(info)
        return result

    def get_model_path(self, ext_id: str, model_type: str) -> str:
        """获取扩展内的模型路径

        Args:
            ext_id: 扩展 ID（"knowledge" | "recorder"）
            model_type: 模型类型（"embedding" | "reranker" | "whisper"）

        Returns:
            模型目录的相对路径（相对于项目根目录），未找到时返回空字符串
        """
        info = self.get_info(ext_id)
        if not info:
            return ""

        models = info.get("models", {})
        if not isinstance(models, dict):
            return ""

        path = models.get(model_type, "")
        if path:
            return path

        # 内置默认路径
        defaults = {
            "knowledge": {
                "embedding": "models/embedding",
                "reranker": "models/reranker",
            },
            "recorder": {
                "whisper": "models/whisper",
            },
            "llm": {
                "llm": "models/llm",
            },
        }
        ext_defaults = defaults.get(ext_id, {})
        return ext_defaults.get(model_type, "")
