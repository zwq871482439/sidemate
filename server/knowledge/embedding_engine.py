# -*- coding: utf-8 -*-
"""嵌入引擎（sentence-transformers 模式）

使用 sentence-transformers 加载 bge-base-zh-v1.5 嵌入模型。
模型路径从扩展注册表读取；扩展未安装时 mode="none"，encode 返回零向量但不崩溃。
"""
import os
import logging
from typing import List

import numpy as np

log = logging.getLogger(__name__)


class EmbeddingEngine:
    """嵌入引擎：sentence-transformers bge-base-zh-v1.5

    扩展未安装时 mode="none"，encode 返回零向量但不崩溃。
    """

    def __init__(self, model_name: str = "BAAI/bge-base-zh-v1.5", vector_dim: int = 768):
        self.model_name = model_name
        self.vector_dim = vector_dim
        self._model = None
        self._mode = "none"          # "bge" | "none"
        self._model_path = None      # 实际加载的模型路径

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def available(self) -> bool:
        """模型是否加载成功"""
        return self._mode == "bge" and self._model is not None

    def load(self) -> bool:
        """加载嵌入模型，成功返回 True

        优先从扩展注册表读取模型路径，降级到项目根目录下的默认路径。
        """
        # 确定项目根目录：knowledge/ → 项目根目录
        _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        # 尝试从扩展注册表获取模型路径
        model_path = None
        try:
            from extensions import ExtensionRegistry
            from config import ROOT_DIR
            registry = ExtensionRegistry(os.path.join(ROOT_DIR, "extensions"))
            if registry.is_installed("knowledge"):
                registered_path = registry.get_model_path("knowledge", "embedding")
                if registered_path:
                    # 注册表返回的是相对于项目根目录的路径
                    candidate = os.path.join(ROOT_DIR, registered_path)
                    if os.path.isdir(candidate):
                        model_path = candidate
                        log.info("[KB] 从扩展注册表获取嵌入模型路径: %s", model_path)
        except Exception as e:
            log.debug("[KB] 读取扩展注册表失败: %s", str(e)[:80])

        # 降级：使用默认路径（按优先级逐级尝试）
        if model_path is None:
            model_basename = self.model_name.split("/")[-1]  # "bge-base-zh-v1.5"
            candidates = [
                os.path.join(_project_dir, "models", "embedding", model_basename),  # models/embedding/bge-base-zh-v1.5
                os.path.join(_project_dir, "models", "embedding"),                   # models/embedding/（文件直接放此）
                os.path.join(_project_dir, "models", model_basename),                 # models/bge-base-zh-v1.5
            ]
            for c in candidates:
                if os.path.isdir(c) and os.path.exists(os.path.join(c, "config.json")):
                    model_path = c
                    log.debug("[KB] fallback 嵌入模型路径: %s", model_path)
                    break

        # 加载 sentence-transformers 模型
        try:
            if os.path.isdir(model_path):
                from sentence_transformers import SentenceTransformer
                log.info("[KB] 从 sentence-transformers 加载嵌入模型: %s", model_path)
                self._model = SentenceTransformer(model_path)
                self._model_path = model_path
                self._mode = "bge"
                # sentence-transformers >= 5.0 重命名了此方法
                self.vector_dim = getattr(self._model, 'get_embedding_dimension',
                                          self._model.get_sentence_embedding_dimension)()
                log.info("[KB] 嵌入模型加载成功 (dim=%d)", self.vector_dim)
                return True
            else:
                log.warning("[KB] 嵌入模型目录不存在: %s", model_path)
        except Exception as e:
            log.warning("[KB] sentence-transformers 嵌入模型加载失败: %s", str(e)[:100])

        log.error("[KB] 无可用嵌入引擎。请导入文库扩展包以安装嵌入模型。")
        self._mode = "none"
        return False

    def encode(self, texts: List[str]) -> np.ndarray:
        """编码文本为向量矩阵 (N, dim)

        Args:
            texts: 待编码文本列表

        Returns:
            (N, dim) 的 numpy 数组，无引擎时返回零向量
        """
        if not texts:
            return np.array([]).reshape(0, self.vector_dim)

        # sentence-transformers 模式
        if self._mode == "bge" and self._model is not None:
            vectors = self._model.encode(texts, normalize_embeddings=True)
            return np.array(vectors, dtype=np.float32)

        # 无引擎 — 返回零向量（不崩溃）
        log.warning("[KB] 无可用嵌入引擎，返回零向量")
        return np.zeros((len(texts), self.vector_dim), dtype=np.float32)

    def encode_query(self, query: str) -> np.ndarray:
        """编码查询文本

        Args:
            query: 查询字符串

        Returns:
            (1, dim) 的 numpy 数组
        """
        return self.encode([query])
