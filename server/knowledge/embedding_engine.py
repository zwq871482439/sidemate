# -*- coding: utf-8 -*-
"""嵌入引擎（bge-m3 dense+sparse 模式）

Patch5 T03: 升级为 FlagModel（FlagEmbedding），支持 dense + sparse 双向量编码。
- dense：传统稠密向量（语义检索）
- sparse：学习型 BM25 权重（关键词匹配，替代 jieba + rank_bm25）

降级链：
  1. FlagModel（bge-m3 dense+sparse）— 最佳
  2. SentenceTransformer（bge-m3 纯 dense）— FlagEmbedding 不可用时降级
  3. none — 模型未加载，返回零向量但不崩溃

模型路径从扩展注册表读取；扩展未安装时 mode="none"，encode 返回零向量但不崩溃。
"""
import os
import logging
from typing import List, Tuple, Dict, Any

import numpy as np

log = logging.getLogger(__name__)


class EmbeddingEngine:
    """嵌入引擎：bge-m3 dense+sparse（FlagModel）

    Patch5 升级：
      - 优先使用 FlagEmbedding 的 FlagModel（支持 dense+sparse）
      - FlagModel 加载失败时降级到 SentenceTransformer（纯 dense）
      - 保留 encode() / encode_query() 兼容接口（内部调 dense）

    Attributes:
        model_name: 模型名称
        vector_dim: 向量维度
        _model: FlagModel 或 SentenceTransformer 实例
        _mode: 引擎模式 "flag_model" | "bge" | "none"
        _sparse_available: sparse 检索是否可用（仅 FlagModel 模式为 True）
    """

    def __init__(self, model_name: str = "BAAI/bge-m3", vector_dim: int = 1024):
        self.model_name = model_name
        self.vector_dim = vector_dim
        self._model = None
        self._mode = "none"               # "flag_model" | "bge" | "none"
        self._model_path = None           # 实际加载的模型路径
        self._sparse_available = False     # sparse 是否可用

    @property
    def mode(self) -> str:
        return self._mode

    @property
    def available(self) -> bool:
        """模型是否加载成功"""
        return self._mode in ("flag_model", "bge") and self._model is not None

    @property
    def sparse_available(self) -> bool:
        """sparse 检索是否可用（仅 FlagModel 模式）"""
        return self._sparse_available

    def _resolve_model_path(self) -> str:
        """解析模型路径（优先扩展注册表，降级到默认路径）

        Returns:
            模型目录路径，找不到返回空字符串
        """
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
                    candidate = os.path.join(ROOT_DIR, registered_path)
                    if os.path.isdir(candidate):
                        model_path = candidate
                        log.info("[KB] 从扩展注册表获取嵌入模型路径: %s", model_path)
        except Exception as e:
            log.debug("[KB] 读取扩展注册表失败: %s", str(e)[:80])

        # 降级：使用默认路径（按优先级逐级尝试）
        if model_path is None:
            model_basename = self.model_name.split("/")[-1]
            candidates = [
                os.path.join(_project_dir, "models", "embedding", model_basename),
                os.path.join(_project_dir, "models", "embedding"),
                os.path.join(_project_dir, "models", model_basename),
            ]
            for c in candidates:
                if os.path.isdir(c) and os.path.exists(os.path.join(c, "config.json")):
                    model_path = c
                    log.debug("[KB] fallback 嵌入模型路径: %s", model_path)
                    break

        return model_path or ""

    def load(self) -> bool:
        """加载嵌入模型，成功返回 True

        降级链：FlagModel → SentenceTransformer → none

        Returns:
            是否加载成功
        """
        model_path = self._resolve_model_path()

        if not model_path or not os.path.isdir(model_path):
            log.error("[KB] 无可用嵌入引擎。请导入文库扩展包以安装嵌入模型。")
            self._mode = "none"
            return False

        # ===== 尝试 1: FlagModel（bge-m3 dense+sparse）=====
        try:
            from FlagEmbedding import BGEM3FlagModel
            log.info("[KB] 从 FlagEmbedding 加载 bge-m3 (dense+sparse): %s", model_path)
            self._model = BGEM3FlagModel(
                model_path,
                use_fp16=True,  # 半精度加速
            )
            self._model_path = model_path
            self._mode = "flag_model"
            self._sparse_available = True

            # 检测向量维度
            test_output = self._model.encode(
                ["维度检测"], return_dense=True, return_sparse=False, return_colbert_vecs=False
            )
            if hasattr(test_output, 'dense_vecs'):
                self.vector_dim = test_output['dense_vecs'].shape[1]
            elif isinstance(test_output, dict) and 'dense_vecs' in test_output:
                self.vector_dim = test_output['dense_vecs'].shape[1]
            else:
                # BGEM3FlagModel 可能返回命名元组
                dense = getattr(test_output, 'dense_vecs', None)
                if dense is not None:
                    self.vector_dim = dense.shape[1]

            log.info("[KB] FlagModel 加载成功 (dim=%d, sparse=available)", self.vector_dim)
            return True

        except ImportError:
            log.info("[KB] FlagEmbedding 未安装，尝试 SentenceTransformer 降级")
        except Exception as e:
            log.warning("[KB] FlagModel 加载失败，降级到 SentenceTransformer: %s", str(e)[:120])

        # ===== 尝试 2: SentenceTransformer（纯 dense）=====
        try:
            from sentence_transformers import SentenceTransformer
            log.info("[KB] 从 sentence-transformers 加载嵌入模型 (dense only): %s", model_path)
            self._model = SentenceTransformer(model_path)
            self._model_path = model_path
            self._mode = "bge"
            self._sparse_available = False
            # sentence-transformers >= 5.0 重命名了此方法
            self.vector_dim = getattr(self._model, 'get_embedding_dimension',
                                      self._model.get_sentence_embedding_dimension)()
            log.info("[KB] SentenceTransformer 加载成功 (dim=%d, sparse=unavailable)", self.vector_dim)
            return True
        except Exception as e:
            log.warning("[KB] sentence-transformers 嵌入模型加载失败: %s", str(e)[:100])

        log.error("[KB] 无可用嵌入引擎。请导入文库扩展包以安装嵌入模型。")
        self._mode = "none"
        self._sparse_available = False
        return False

    def encode(self, texts: List[str]) -> np.ndarray:
        """编码文本为 dense 向量矩阵 (N, dim)

        兼容接口：无论 FlagModel 还是 SentenceTransformer 都只返回 dense 向量。

        Args:
            texts: 待编码文本列表

        Returns:
            (N, dim) 的 numpy 数组，无引擎时返回零向量
        """
        if not texts:
            return np.array([]).reshape(0, self.vector_dim)

        # FlagModel 模式
        if self._mode == "flag_model" and self._model is not None:
            output = self._model.encode(
                texts,
                return_dense=True,
                return_sparse=False,
                return_colbert_vecs=False,
                batch_size=min(12, len(texts)),  # bge-m3 较大，控制 batch
            )
            dense_vecs = self._extract_dense(output)
            return np.array(dense_vecs, dtype=np.float32)

        # SentenceTransformer 模式
        if self._mode == "bge" and self._model is not None:
            vectors = self._model.encode(texts, normalize_embeddings=True)
            return np.array(vectors, dtype=np.float32)

        # 无引擎 — 返回零向量（不崩溃）
        log.warning("[KB] 无可用嵌入引擎，返回零向量")
        return np.zeros((len(texts), self.vector_dim), dtype=np.float32)

    def encode_dense_sparse(self, texts: List[str]) -> Tuple[np.ndarray, List[Dict[int, float]]]:
        """编码文本为 dense + sparse 双向量

        仅 FlagModel 模式可用。其他模式返回 dense + 空 sparse。

        Args:
            texts: 待编码文本列表

        Returns:
            (dense_matrix, sparse_weights_list)
            - dense_matrix: (N, dim) numpy 数组
            - sparse_weights_list: [{token_id: weight}, ...] 每个文本的 sparse 权重
        """
        if not texts:
            return np.array([]).reshape(0, self.vector_dim), []

        # FlagModel 模式：同时返回 dense + sparse
        if self._mode == "flag_model" and self._model is not None:
            try:
                output = self._model.encode(
                    texts,
                    return_dense=True,
                    return_sparse=True,
                    return_colbert_vecs=False,
                    batch_size=min(12, len(texts)),
                )
                dense_vecs = self._extract_dense(output)
                sparse_weights = self._extract_sparse(output, len(texts))
                return np.array(dense_vecs, dtype=np.float32), sparse_weights
            except Exception as e:
                log.warning("[KB] FlagModel dense+sparse 编码失败，降级纯 dense: %s", str(e)[:100])

        # 其他模式：返回 dense + 空 sparse
        dense = self.encode(texts)
        empty_sparse = [{} for _ in range(len(texts))]
        return dense, empty_sparse

    def encode_query(self, query: str) -> np.ndarray:
        """编码查询文本为 dense 向量

        Args:
            query: 查询字符串

        Returns:
            (dim,) 的一维 numpy 数组（或 (1, dim) 兼容旧代码）
        """
        result = self.encode([query])
        if result.shape[0] > 0:
            return result  # 返回 (1, dim)，兼容 np.dot(self.vectors, query_vec.T)
        return np.zeros((1, self.vector_dim), dtype=np.float32)

    def encode_query_sparse(self, query: str) -> Dict[int, float]:
        """编码查询文本为 sparse 权重

        Args:
            query: 查询字符串

        Returns:
            {token_id: weight} 字典，sparse 不可用时返回空字典
        """
        if not self._sparse_available or self._mode != "flag_model":
            return {}

        try:
            output = self._model.encode(
                [query],
                return_dense=False,
                return_sparse=True,
                return_colbert_vecs=False,
            )
            sparse_list = self._extract_sparse(output, 1)
            return sparse_list[0] if sparse_list else {}
        except Exception as e:
            log.warning("[KB] encode_query_sparse 失败: %s", str(e)[:80])
            return {}

    @staticmethod
    def _extract_dense(output: Any) -> np.ndarray:
        """从 FlagModel.encode() 输出中提取 dense 向量

        BGEM3FlagModel.encode 返回格式可能为：
          - dict: {'dense_vecs': ndarray, 'sparse_vecs': list, 'colbert_vecs': ...}
          - namedtuple: 具有同名属性
        """
        if isinstance(output, dict):
            return output['dense_vecs']
        # 命名元组
        return output.dense_vecs

    @staticmethod
    def _extract_sparse(output: Any, expected_count: int) -> List[Dict[int, float]]:
        """从 FlagModel.encode() 输出中提取 sparse 权重

        Returns:
            [{token_id: weight}, ...] 列表
        """
        sparse_data = None
        if isinstance(output, dict):
            sparse_data = output.get('lexical_weights') or output.get('sparse_vecs')
        else:
            sparse_data = getattr(output, 'lexical_weights', None) or getattr(output, 'sparse_vecs', None)

        if sparse_data is None:
            return [{} for _ in range(expected_count)]

        # sparse_data 是 [{token_id_str: weight}, ...] 格式
        # FlagModel 返回的 token_id 可能是字符串，需转为 int
        result = []
        for item in sparse_data:
            weights = {}
            if isinstance(item, dict):
                for tid, w in item.items():
                    try:
                        weights[int(tid)] = float(w)
                    except (ValueError, TypeError):
                        pass
            result.append(weights)
        return result
