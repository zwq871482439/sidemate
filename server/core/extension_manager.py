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
  - "llm"       : LLM 模型扩展（本地大语言模型）
"""
import os
import json
import logging
from typing import Dict, List, Optional

log = logging.getLogger(__name__)

# Patch5 D3: 扩展"模型存在性兜底"——注册表丢失时（如 D1 重构误删运行时数据）
# 通过检查关键模型文件是否存在来判断扩展是否已实际安装。
# 命中后自动补登记到注册表，下次直接走快路径。
# 关键文件用 all() 判断，缺一个就视为未装，避免半装状态误展示。
REQUIRED_FILES_BY_EXT = {
    "knowledge": [
        # 主权重（兼容 safetensors 与 pytorch bin 两种格式之一）
        ("models/embedding/model.safetensors", "models/embedding/pytorch_model.bin"),
        "models/embedding/config.json",
        "models/embedding/tokenizer.json",
        ("models/reranker/model.safetensors", "models/reranker/pytorch_model.bin"),
        "models/reranker/config.json",
    ],
    # llm 走 Ollama，blob 文件名是 hash，无法用固定路径校验，不参与兜底
}


def _project_root() -> str:
    """获取项目根目录（data/extensions 的父目录的父目录）"""
    # extension_manager.py 位于 server/core/，项目根是 server 的父目录
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.dirname(os.path.dirname(here))


def _file_exists_any(variants, root: str) -> bool:
    """检查变体文件中任一存在（元组表示"或"关系）"""
    if isinstance(variants, tuple):
        return any(os.path.exists(os.path.join(root, v)) for v in variants)
    return os.path.exists(os.path.join(root, variants))


def _check_required_files(ext_id: str) -> bool:
    """检查扩展的关键模型文件是否全部存在

    Args:
        ext_id: 扩展 ID
        root: 项目根目录

    Returns:
        True 如果所有关键文件都存在（元组表示"或"关系，至少一个存在即满足）
    """
    required = REQUIRED_FILES_BY_EXT.get(ext_id)
    if not required:
        return False  # 未配置关键文件的扩展不参与兜底
    root = _project_root()
    return all(_file_exists_any(item, root) for item in required)


class ExtensionRegistry:
    """扩展注册中心 — 管理已安装的扩展"""

    # 合法的扩展 ID
    VALID_IDS = {"knowledge", "llm"}

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
            ext_id: 扩展 ID（"knowledge" | "llm"）

        Returns:
            注册 JSON 文件的绝对路径
        """
        return os.path.join(self.extensions_dir, "%s.json" % ext_id)

    def is_installed(self, ext_id: str, _auto_repair: bool = True) -> bool:
        """检查扩展是否已安装（带模型存在性兜底）

        检查顺序：
          1. 注册表 JSON 存在且可解析 → True
          2. 兜底：关键模型文件全部存在 → True（并自动补登记）
          3. 否则 False

        Args:
            ext_id: 扩展 ID（"knowledge" | "llm"）
            _auto_repair: 兜底命中时是否自动写回注册表（默认 True，避免下次重复检查）

        Returns:
            True 如果扩展已安装
        """
        # 1. 注册表查
        path = self._registry_path(ext_id)
        if os.path.exists(path):
            try:
                with open(path, "r", encoding="utf-8") as f:
                    data = json.load(f)
                if isinstance(data, dict) and data.get("id") == ext_id:
                    return True
            except Exception as e:
                log.warning("[EXT-REG] 解析注册文件失败 %s: %s", ext_id, str(e)[:80])

        # 2. 兜底：关键模型文件检查（仅 knowledge / recorder，llm 走 Ollama 不兜底）
        if _check_required_files(ext_id):
            if _auto_repair:
                # 自动补登记，下次直接走快路径
                default_info = self._default_register_info(ext_id)
                try:
                    self.register(ext_id, default_info)
                    log.info("[EXT-REG] 模型存在性兜底命中，已自动补登记 %s", ext_id)
                except Exception as e:
                    log.warning("[EXT-REG] 自动补登记失败 %s: %s", ext_id, str(e)[:80])
            return True

        return False

    def _default_register_info(self, ext_id: str) -> dict:
        """兜底自动补登记时使用的默认注册信息"""
        from datetime import datetime
        defaults = {
            "knowledge": {
                "id": "knowledge",
                "version": "auto-detected",
                "models": {
                    "embedding": "models/embedding",
                    "reranker": "models/reranker",
                },
            },
        }
        info = defaults.get(ext_id, {"id": ext_id, "version": "auto-detected"})
        info["installed_at"] = datetime.now().isoformat()
        info["auto_detected"] = True  # 标记为兜底自动登记
        return info

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
            ext_id: 扩展 ID（"knowledge" | "llm"）
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
            "llm": {
                "llm": "models/llm",
            },
        }
        ext_defaults = defaults.get(ext_id, {})
        return ext_defaults.get(model_type, "")
