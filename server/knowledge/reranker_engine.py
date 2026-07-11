# -*- coding: utf-8 -*-
"""Reranker 引擎（Cross-Encoder 精排）

与 Bi-Encoder（bge）不同，Cross-Encoder 把 query+doc 拼在一起做注意力，
精度更高但速度更慢，适合对少量候选（10-20条）精排。
运行在 CPU 上，轻量快速，不影响 LLM 推理。

纯 PyTorch 模式（transformers AutoModelForSequenceClassification）。
模型路径从扩展注册表读取；扩展未安装时 _loaded=False，rerank() 直接返回原始候选。
"""
import os
import logging
from typing import List, Dict

log = logging.getLogger(__name__)


class RerankerEngine:
    """Reranker 引擎：Cross-Encoder 交叉编码器，用于检索后精排"""

    def __init__(self, model_name: str = "BAAI/bge-reranker-v2-m3"):
        self.model_name = model_name
        self._model = None
        self._tokenizer = None
        self._loaded = False
        self._mode = "none"          # "pytorch" | "none"
        self._device = "cpu"  # Reranker 跑 CPU

    @property
    def available(self) -> bool:
        """模型是否加载成功"""
        return self._loaded

    def load(self) -> bool:
        """加载 Reranker 模型（PyTorch）

        优先从扩展注册表读取模型路径，降级到项目根目录下的默认路径。
        """
        if self._loaded:
            return True

        # 确定项目根目录：knowledge/ → 项目根目录
        _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

        # 可能的模型根：ROOT_DIR(server/) 和 PROJECT_ROOT(server 父目录) 都试
        try:
            from config import ROOT_DIR as _root_dir, PROJECT_ROOT as _proj_root
        except ImportError:
            _root_dir = _project_dir
            _proj_root = os.path.dirname(_project_dir)
        model_roots = [_root_dir, _proj_root]

        # 尝试从扩展注册表获取模型路径
        model_path = None
        try:
            from core.extension_manager import ExtensionRegistry
            from config import EXTENSIONS_DIR
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            if registry.is_installed("knowledge"):
                registered_path = registry.get_model_path("knowledge", "reranker")
                if registered_path:
                    # registered_path 形如 "models/reranker"，需对每个候选根拼接验证
                    for root in model_roots:
                        candidate = os.path.join(root, registered_path)
                        if os.path.isdir(candidate):
                            model_path = candidate
                            log.info("[KB-Reranker] 从扩展注册表获取 reranker 模型路径: %s", model_path)
                            break
        except Exception as e:
            log.debug("[KB-Reranker] 读取扩展注册表失败: %s", str(e)[:80])

        # 降级：使用默认路径（按优先级逐级尝试，覆盖两个根）
        if model_path is None:
            model_basename = self.model_name.split("/")[-1]
            candidates = []
            for root in model_roots:
                candidates.extend([
                    os.path.join(root, "models", "reranker", model_basename),  # models/reranker/bge-reranker-base
                    os.path.join(root, "models", "reranker"),                   # models/reranker/（文件直接放此）
                    os.path.join(root, "models", model_basename),               # models/bge-reranker-base
                ])
            for c in candidates:
                if os.path.isdir(c) and os.path.exists(os.path.join(c, "config.json")):
                    model_path = c
                    log.debug("[KB-Reranker] fallback reranker 模型路径: %s", model_path)
                    break

        # 加载 PyTorch 模型（safetensors / pytorch_model.bin）
        # 注意：model_path 可能为 None（注册表和 fallback 都没命中），必须先判空
        if model_path and os.path.isdir(model_path) and os.path.exists(os.path.join(model_path, "config.json")):
            has_weights = (
                os.path.exists(os.path.join(model_path, "model.safetensors"))
                or os.path.exists(os.path.join(model_path, "pytorch_model.bin"))
            )
            if has_weights:
                try:
                    import torch
                    from transformers import AutoTokenizer, AutoModelForSequenceClassification
                    log.info("[KB-Reranker] 从 PyTorch 加载: %s", model_path)
                    self._tokenizer = AutoTokenizer.from_pretrained(model_path)
                    self._model = AutoModelForSequenceClassification.from_pretrained(model_path)
                    self._model.eval()
                    self._loaded = True
                    self._mode = "pytorch"
                    log.info("[KB-Reranker] 加载成功 (PyTorch, CPU)")
                    return True
                except Exception as e:
                    log.error("[KB-Reranker] PyTorch 加载失败: %s", str(e)[:100])
            else:
                log.warning("[KB-Reranker] 模型目录存在但缺少权重文件: %s", model_path)
        else:
            log.warning("[KB-Reranker] 模型目录不存在或缺少 config.json: %s", model_path)

        self._loaded = False
        return False

    def unload(self):
        """卸载模型，清理内部状态，释放内存"""
        if not self._loaded:
            return
        self._model = None
        self._tokenizer = None
        self._loaded = False
        self._mode = "none"
        log.info("[KB-Reranker] 模型已卸载，内存已释放")

    def rerank(self, query: str, candidates: List[Dict],
               top_k: int = None, max_length: int = 256) -> List[Dict]:
        """对候选结果精排（只打分不重排，由 _blend_with_reranker 做自适应融合）

        Args:
            query: 用户查询
            candidates: 候选列表 [{"text": ..., "score": ..., ...}]
            top_k: 返回数量（默认全部返回）
            max_length: 每对 (query, doc) 最大 token 长度

        Returns:
            带有 reranker_score 字段的候选列表（保留原始排序不变）
        """
        if not self._loaded or not candidates:
            return candidates

        top_k = top_k or len(candidates)

        # PyTorch 模式
        if self._mode == "pytorch" and self._model is not None:
            try:
                import torch
                pairs = [(query, c["text"][:max_length * 3]) for c in candidates]
                features = self._tokenizer(
                    pairs, padding=True, truncation=True,
                    max_length=max_length, return_tensors="pt"
                )
                with torch.no_grad():
                    scores = self._model(**features).logits.squeeze(-1)
                if scores.dim() == 0:
                    scores = scores.unsqueeze(0)
                probs = torch.sigmoid(scores).tolist()

                result = []
                for i, cand in enumerate(candidates):
                    r = dict(cand)
                    r["reranker_score"] = round(float(probs[i]), 4)
                    result.append(r)
                log.info("[KB-Reranker] PT精排打分: %d候选, top3=%s",
                         len(result),
                         sorted([r["reranker_score"] for r in result], reverse=True)[:3])
                return result
            except Exception as e:
                log.warning("[KB-Reranker] PT精排失败: %s, 返回原始排序", str(e)[:80])
                return candidates[:top_k]

        return candidates[:top_k]
