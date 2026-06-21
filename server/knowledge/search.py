# -*- coding: utf-8 -*-
"""
knowledge/search.py — 文库检索 Mixin
====================================
包含 BM25 检索、向量检索、RRF 融合、Reranker 融合、MMR 重排序、
search() 主入口、get_context() 上下文拼接。
从 knowledge_base.py 拆分而来。
"""
import math
import time
import logging
import numpy as np
from typing import List, Dict, Tuple

log = logging.getLogger(__name__)


class _KBSearchMixin:
    """文库检索：bge-m3 dense+sparse + Reranker + MMR（Patch5：BM25 已彻底移除）"""

    def _search_vector(self, query: str, top_k: int = None) -> List[Dict]:
        """纯向量检索（原 search 逻辑，抽取为独立方法）"""
        if not self._embedder_loaded:
            self.init_embedder()

        if self.vectors is None or len(self.chunk_order) == 0:
            log.debug("[KB] 向量检索跳过: 索引为空")
            return []

        top_k = top_k or self.search_top_k
        top_k = min(top_k, len(self.chunk_order))

        query_vec = self.embedder.encode_query(query)
        scores = np.dot(self.vectors, query_vec.T).flatten()
        top_indices = np.argsort(scores)[::-1][:top_k]

        # 从 config 读取阈值（bge-base-zh 768维，0.35 过滤弱相关噪音，8B 模型需要更干净的 context）
        try:
            from config import get as _cfg
            vector_score_threshold = _cfg("kb_vector_score_threshold", 0.35)
        except Exception:
            vector_score_threshold = 0.35
        results = []
        filtered_count = 0
        for idx in top_indices:
            if idx >= len(self.chunk_order):
                continue
            score = float(scores[idx])
            if score < vector_score_threshold:
                filtered_count += 1
                continue  # 过滤低相关度结果
            chunk_id = self.chunk_order[idx]
            chunk = self.chunks.get(chunk_id)
            if not chunk:
                continue
            results.append({
                "chunk_id": chunk_id,
                "text": chunk.text,  # 不截断，由 get_context() 的 max_chars 控制总长度
                "score": score,
                "source_label": chunk.source_label,
                "doc_id": chunk.doc_id,
                "heading": chunk.heading,
                "index": chunk.index,
            })
        log.info("[KB] 向量检索: query=%s, 向量数=%d, 命中%d条(过滤%d条低分), top3分数=%s",
                 query[:50], len(self.chunk_order), len(results), filtered_count,
                 [round(r["score"], 4) for r in results[:3]])
        return results

    def _search_sparse(self, query: str, top_k: int = None) -> List[Dict]:
        """Patch5 T03: bge-m3 sparse 检索（学习型 BM25）

        使用 FlagModel 的 sparse 权重进行关键词匹配，替代 jieba+BM25。
        sparse 权重格式：{token_id: weight}

        Args:
            query: 查询文本
            top_k: 返回结果数

        Returns:
            结果列表（与 _search_vector 格式一致）
        """
        if not self._embedder_loaded:
            self.init_embedder()

        if not self.embedder.sparse_available:
            log.debug("[KB] sparse 检索跳过: FlagModel sparse 不可用")
            return []

        top_k = top_k or self.search_top_k

        # 检查是否有 sparse 索引（由 ops.py 在 process_document 中构建）
        sparse_index = getattr(self, '_sparse_index', None)
        if not sparse_index or len(self.chunk_order) == 0:
            log.debug("[KB] sparse 检索跳过: sparse 索引为空")
            return []

        # 获取查询的 sparse 权重
        query_weights = self.embedder.encode_query_sparse(query)
        if not query_weights:
            log.debug("[KB] sparse 检索跳过: 查询 sparse 权重为空")
            return []

        # 计算每个 chunk 的 sparse 分数（点积）
        scores = np.zeros(len(self.chunk_order), dtype=np.float32)
        for token_id, weight in query_weights.items():
            for idx, cid in enumerate(self.chunk_order):
                chunk_weights = sparse_index.get(cid, {})
                if token_id in chunk_weights:
                    scores[idx] += weight * chunk_weights[token_id]

        # 取 top_k
        top_indices = np.argsort(scores)[::-1][:top_k]

        results = []
        for idx in top_indices:
            if idx >= len(self.chunk_order):
                continue
            score = float(scores[idx])
            if score <= 0:
                continue  # 无匹配跳过
            chunk_id = self.chunk_order[idx]
            chunk = self.chunks.get(chunk_id)
            if not chunk:
                continue
            results.append({
                "chunk_id": chunk_id,
                "text": chunk.text,
                "score": score,
                "source_label": chunk.source_label,
                "doc_id": chunk.doc_id,
                "heading": chunk.heading,
                "index": chunk.index,
            })

        log.info("[KB] Sparse 检索: query=%s, 命中%d条, top3分数=%s",
                 query[:50], len(results),
                 [round(r["score"], 4) for r in results[:3]])
        return results

    @staticmethod
    def _dense_sparse_fusion(dense_results: List[Dict], sparse_results: List[Dict],
                             alpha: float = 0.7, top_k: int = None) -> List[Dict]:
        """Patch5 T03: dense + sparse 加权归一化融合

        score = α × dense_norm + (1-α) × sparse_norm

        替代原有的 RRF 融合（BM25 + 向量），改用 bge-m3 自带的 dense+sparse。

        Args:
            dense_results: dense 检索结果列表
            sparse_results: sparse 检索结果列表
            alpha: dense 权重（0-1），默认 0.7
            top_k: 返回结果数

        Returns:
            融合后的结果列表
        """
        if not dense_results and not sparse_results:
            return []
        if not dense_results:
            return sparse_results[:top_k] if top_k else sparse_results
        if not sparse_results:
            return dense_results[:top_k] if top_k else dense_results

        # 归一化函数
        def _normalize_scores(items):
            if not items:
                return items
            scores = [r["score"] for r in items]
            mn, mx = min(scores), max(scores)
            if mx > mn:
                for r in items:
                    r["norm_score"] = (r["score"] - mn) / (mx - mn)
            else:
                for r in items:
                    r["norm_score"] = 1.0
            return items

        dense_results = _normalize_scores(dense_results)
        sparse_results = _normalize_scores(sparse_results)

        # 合并：chunk_id → {dense_score, sparse_score, data}
        score_map: Dict[str, Dict] = {}
        for r in dense_results:
            cid = r["chunk_id"]
            score_map[cid] = {
                "dense_norm": r.get("norm_score", 0),
                "sparse_norm": 0,
                "data": r,
                "vector_score": r.get("score", 0),
            }
        for r in sparse_results:
            cid = r["chunk_id"]
            if cid in score_map:
                score_map[cid]["sparse_norm"] = r.get("norm_score", 0)
            else:
                score_map[cid] = {
                    "dense_norm": 0,
                    "sparse_norm": r.get("norm_score", 0),
                    "data": r,
                    "vector_score": 0,
                }

        # 计算融合分数
        for cid, info in score_map.items():
            info["fused_score"] = alpha * info["dense_norm"] + (1 - alpha) * info["sparse_norm"]

        # 排序
        sorted_items = sorted(score_map.values(), key=lambda x: x["fused_score"], reverse=True)
        if top_k:
            sorted_items = sorted_items[:top_k]

        results = []
        for item in sorted_items:
            r = dict(item["data"])
            r["fused_score"] = round(item["fused_score"], 6)
            r["vector_score"] = round(item["vector_score"], 4)
            r["score"] = round(item["fused_score"], 6)
            r["search_method"] = "dense_sparse"
            results.append(r)

        return results

    # Patch5：_rrf_merge 已删除（bge-m3 dense+sparse 是唯一路径，不再需要 RRF 融合 BM25）

    @staticmethod
    def _diversify_results(results: List[Dict], max_per_doc: int = 3) -> List[Dict]:
        """源多样性采样：限制每个文档最多返回 max_per_doc 条结果

        按 score 降序遍历，保证高分结果优先保留。
        如果某文档的 chunk 很多（覆盖率偏差），也不会霸占全部 Top-K。
        """
        from collections import Counter
        seen = Counter()
        filtered = []
        for r in results:
            doc_id = r.get("doc_id", "")
            if seen[doc_id] < max_per_doc:
                filtered.append(r)
                seen[doc_id] += 1
        if len(filtered) < len(results):
            log.info("[KB] 源多样性采样: %d条→%d条 (每文档限%d条)",
                     len(results), len(filtered), max_per_doc)
        return filtered

    def _blend_with_reranker(self, candidates: List[Dict], top_k: int = None) -> List[Dict]:
        """自适应加权融合：RRF 分数 + Reranker 分数

        核心：根据 Reranker 与 RRF 排序的排名一致性自适应调整权重。
        使用 NDCG@K 衡量两路排序的前K名一致性（而非 Jaccard 集合重叠）。
        - 高一致（NDCG≥0.8）：信任 Reranker，α=0.3（Reranker权重70%）
        - 低一致（NDCG<0.4）：回退 RRF，α=0.8（RRF权重80%）
        - 中间线性插值

        这样 Reranker 好的时候用 Reranker，差的时候自动退回 RRF。
        """
        if not candidates:
            return candidates

        top_k = top_k or len(candidates)

        # 检查是否有 reranker_score
        has_reranker = all("reranker_score" in c for c in candidates)
        if not has_reranker:
            return candidates[:top_k]

        # 提取 RRF 排序（按 rrf_score 或 score 降序）
        rrf_ranked = sorted(range(len(candidates)),
                           key=lambda i: candidates[i].get("rrf_score", candidates[i].get("score", 0)),
                           reverse=True)
        # 提取 Reranker 排序（按 reranker_score 降序）
        reranker_ranked = sorted(range(len(candidates)),
                                key=lambda i: candidates[i].get("reranker_score", 0),
                                reverse=True)

        # 用 NDCG@K 衡量排序一致性（而非 Jaccard 集合重叠）
        # Reranker 的 top1 在 RRF 排名中的位置越靠前，一致性越高
        check_k = min(top_k, 5)  # 用前5名的排名一致性，不受候选池大小影响
        rrf_rank_map = {idx: rank for rank, idx in enumerate(rrf_ranked)}
        ndcg = 0.0
        for i, idx in enumerate(reranker_ranked[:check_k]):
            rrf_rank = rrf_rank_map.get(idx, len(candidates))
            # 理想情况：RRF rank = i（完全一致）
            # 最差情况：RRF rank = len(candidates)-1
            discount = 1.0 / (1 + i)  # position discount
            gain = 1.0 / (1 + abs(rrf_rank - i))  # rank agreement
            ndcg += gain * discount
        # 归一化到 [0, 1]
        ideal_ndcg = sum(1.0 / (1 + i) for i in range(check_k))
        overlap = ndcg / ideal_ndcg if ideal_ndcg > 0 else 0.5

        # 自适应 α：一致性越高越信任 Reranker
        # overlap >= 0.8 → α = 0.3; overlap <= 0.4 → α = 0.8; 中间线性
        if overlap >= 0.8:
            alpha = 0.3
        elif overlap <= 0.4:
            alpha = 0.8
        else:
            # 0.4 ~ 0.8 线性映射到 0.8 ~ 0.3
            alpha = 0.8 - (overlap - 0.4) / 0.4 * 0.5

        # 归一化两路分数到 [0, 1]
        rrf_scores = np.array([c.get("rrf_score", c.get("score", 0)) for c in candidates], dtype=np.float32)
        reranker_scores = np.array([c.get("reranker_score", 0) for c in candidates], dtype=np.float32)

        def _normalize(arr):
            mn, mx = arr.min(), arr.max()
            return (arr - mn) / (mx - mn) if mx > mn else np.ones_like(arr)

        rrf_norm = _normalize(rrf_scores)
        reranker_norm = _normalize(reranker_scores)

        # 加权融合
        blended = alpha * rrf_norm + (1 - alpha) * reranker_norm

        # 按融合分数排序
        sorted_indices = np.argsort(-blended)
        result = []
        for idx in sorted_indices[:top_k]:
            r = dict(candidates[idx])
            r["blended_score"] = round(float(blended[idx]), 6)
            r["blend_alpha"] = round(alpha, 2)
            r["score"] = round(float(blended[idx]), 6)  # 最终分数
            result.append(r)

        log.info("[KB] 自适应融合: ndcg=%.2f, α=%.2f (RRF权重), top3来源=%s",
                 overlap, alpha,
                 [r.get("source_label", "")[:25] for r in result[:3]])
        return result

    def _mmr_rerank(self, query: str, candidates: List[Dict],
                    top_k: int = 5, lambda_param: float = 0.7) -> List[Dict]:
        """Maximal Marginal Relevance 重排序（v2: 用融合分数做relevance）

        关键设计：不重新计算 query-candidate 相关性！
        直接用 RRF 融合分数（或向量/BM25原始分数）作为 relevance，
        MMR 只负责计算候选之间的冗余度（diversity 部分）。
        
        这样 RRF/Reranker 的精排结果不会被 MMR 打散，MMR 只去重。

        Args:
            query: 原始查询文本（用于编码候选计算冗余度）
            candidates: 候选结果列表（需包含 score 和 text）
            top_k: 最终返回数量
            lambda_param: 相关性权重 (0=纯多样性, 1=纯相关性, 默认0.7)

        Returns:
            重排序后的 top_k 条结果
        """
        if not candidates:
            return []
        if len(candidates) <= top_k:
            return candidates

        # 归一化 RRF/原始分数到 [0, 1] 作为 relevance
        scores = np.array([r.get("score", 0) for r in candidates], dtype=np.float32)
        score_min = scores.min()
        score_max = scores.max()
        if score_max > score_min:
            normalized_scores = (scores - score_min) / (score_max - score_min)
        else:
            normalized_scores = np.ones_like(scores)

        # 编码候选文本用于计算冗余度
        cand_texts = [r["text"] for r in candidates]
        cand_vecs = self.embedder.encode(cand_texts)  # (n, dim)

        # 相关性地板：归一化分数低于此值的候选直接跳过
        # 避免低相关但"新颖"（与已选结果不相似）的噪声被 MMR 选入
        try:
            from config import get as _cfg
            relevance_floor = _cfg("kb_relevance_floor", 0.25)
        except Exception:
            relevance_floor = 0.25

        # MMR 贪心选择
        selected_indices = []
        selected_vecs = []
        remaining = set(range(len(candidates)))

        for _ in range(top_k):
            if not remaining:
                break

            best_idx = None
            best_mmr = float('-inf')

            for idx in remaining:
                # 相关性 = 归一化后的融合分数（不重新计算！）
                relevance = float(normalized_scores[idx])

                # 相关性地板：低于此值直接跳过
                if relevance < relevance_floor:
                    continue

                # 最大冗余度：与已选结果的最大向量相似度
                if selected_vecs:
                    sel_matrix = np.array(selected_vecs)
                    sim_to_selected = np.dot(sel_matrix, cand_vecs[idx]).flatten()
                    max_redundancy = float(np.max(sim_to_selected))
                    max_redundancy = max(0.0, min(1.0, max_redundancy))
                else:
                    max_redundancy = 0.0

                # MMR 分数 = λ × relevance - (1-λ) × redundancy
                mmr = lambda_param * relevance - (1 - lambda_param) * max_redundancy
                if mmr > best_mmr:
                    best_mmr = mmr
                    best_idx = idx

            if best_idx is not None:
                selected_indices.append(best_idx)
                selected_vecs.append(cand_vecs[best_idx])
                remaining.discard(best_idx)

        result = [candidates[i] for i in selected_indices]

        # MMR 只负责"选谁"，不负责"排第几"
        # 最终排序用 vector_score（余弦相似度）而非 blended_score
        # vector_score 是真正的语义相关性锚点，blended_score 可能因 Reranker 偏差导致弱相关排前面
        def _sort_key(x):
            vs = x.get("vector_score", 0)
            sc = x.get("score", 0)
            # 优先用 vector_score（如果有的话），否则用 score
            return vs if vs > 0 else sc

        result.sort(key=_sort_key, reverse=True)

        log.info("[KB] MMR重排序v2: %d候选→%d条, lambda=%.2f, 来源=%s",
                 len(candidates), len(result), lambda_param,
                 [r.get("source_label", "")[:25] for r in result[:3]])
        return result

    def search(self, query: str, top_k: int = None,
               accessible_doc_ids: set = None) -> List[Dict]:
        """Hybrid 检索：向量检索 + 关键词检索 → 融合排序

        Patch5 T03 改进：
          - bge-m3 sparse 可用时：走 dense+sparse 融合（替代 BM25+RRF）
          - bge-m3 sparse 不可用时：降级到 BM25+RRF（保留旧逻辑做 fallback）
          - 支持 accessible_doc_ids 过滤私密文档

        Args:
            query: 查询文本
            top_k: 返回结果数（默认用配置值）
            accessible_doc_ids: 可访问的文档 ID 集合（None=不过滤，用于私密文档控制）
        Returns:
            [{"chunk_id", "text", "score", "source_label", "doc_id", "heading", "index", "search_method"}]
        """
        top_k = top_k or self.search_top_k
        log.info("[KB] search() 开始: query=%s, top_k=%d", query[:80], top_k)

        # 加读锁保护向量/chunks 数据的一致性
        with self._processing_lock:
            # Patch4 v3.1 BUG#30：向量索引懒加载重建（首次检索时触发）
            if self.vectors is None and self._need_rebuild_vectors and self.chunks:
                log.info("[KB] 首次检索触发向量索引懒重建 (%d chunks)...", len(self.chunks))
                try:
                    self._rebuild_all_vectors()
                    self._need_rebuild_vectors = False
                    log.info("[KB] 向量索引懒重建完成 ✅")
                except Exception as e:
                    log.error("[KB] 向量索引懒重建失败: %s, 本次降级 BM25", str(e)[:100])
                    self._need_rebuild_vectors = False  # 避免每次都重试

            # ===== Patch5 T03: 检索路径选择 =====
            # 检查 sparse 是否可用
            sparse_enabled = False
            try:
                from config import get as _cfg
                sparse_enabled = _cfg("kb_enable_sparse", True)
            except Exception:
                sparse_enabled = True

            use_sparse = (
                sparse_enabled
                and self._embedder_loaded
                and self.embedder.sparse_available
                and hasattr(self, '_sparse_index')
                and getattr(self, '_sparse_index', None) is not None
            )

            if use_sparse:
                # ===== Patch5 T03: dense + sparse 融合路径（唯一主路径）=====
                vec_results = []
                sparse_results = []

                # dense 检索
                if self.vectors is not None and len(self.chunk_order) > 0:
                    if not self._embedder_loaded:
                        self.init_embedder()
                    vec_results = self._search_vector(query, top_k=int(math.ceil(top_k * 1.5)))

                # sparse 检索
                sparse_results = self._search_sparse(query, top_k=int(math.ceil(top_k * 1.5)))

                # 融合
                if vec_results and sparse_results:
                    try:
                        from config import get as _cfg2
                        alpha = _cfg2("kb_dense_sparse_alpha", 0.7)
                    except Exception:
                        alpha = 0.7

                    merged = self._dense_sparse_fusion(
                        vec_results, sparse_results,
                        alpha=alpha,
                        top_k=int(math.ceil(top_k * 1.5))
                    )
                    log.info("[KB] Dense+Sparse融合: dense=%d, sparse=%d → %d条 (α=%.1f), 来源=%s",
                             len(vec_results), len(sparse_results), len(merged), alpha,
                             [r.get("source_label", "")[:25] for r in merged[:3]])
                elif vec_results:
                    merged = vec_results
                elif sparse_results:
                    merged = sparse_results
                else:
                    merged = []

                if not merged:
                    log.warning("[KB] dense+sparse 均无结果: query=%s", query[:50])
                    return []

                # Reranker 精排
                reranker_ok = self._ensure_reranker()
                if reranker_ok and self.reranker.available:
                    merged = self.reranker.rerank(query, merged, top_k=int(math.ceil(top_k * 1.5)))
                    merged = self._blend_with_reranker(merged, top_k=int(math.ceil(top_k * 1.5)))

                # MMR 重排序
                merged = self._mmr_rerank(query, merged, top_k=top_k)
                self._schedule_reranker_unload()

                # Patch5 T03: 私密文档过滤
                if accessible_doc_ids is not None:
                    merged = [r for r in merged if r.get("doc_id", "") in accessible_doc_ids]

                # Patch5 B1: 检索热力图 — 命中的文档 hit_count += 1（按文档去重）
                hit_doc_ids = set(r.get("doc_id", "") for r in merged if r.get("doc_id", ""))
                for hit_doc_id in hit_doc_ids:
                    doc = self.documents.get(hit_doc_id)
                    if doc is not None:
                        doc.hit_count = getattr(doc, "hit_count", 0) + 1

                # Patch5 审计修复 P0-3: hit_count 批量延迟持久化
                _dirty = getattr(self, '_hit_count_dirty', 0) + len(hit_doc_ids)
                _last_flush = getattr(self, '_last_hit_flush', 0.0)
                _now = time.time()
                if _dirty >= 10 or (_now - _last_flush) > 60:
                    try:
                        self._save_meta()
                        self._hit_count_dirty = 0
                        self._last_hit_flush = _now
                    except Exception as e:
                        log.warning("[KB] hit_count 持久化失败: %s", e)
                else:
                    self._hit_count_dirty = _dirty

                log.info("[KB] Dense+Sparse+Reranker+MMR: %d条, 来源=%s",
                         len(merged), [r.get("source_label", "")[:25] for r in merged[:3]])
                return merged

            else:
                # ===== P6 审计修复：sparse 不可用时降级到纯向量检索 =====
                # 原决策（bge-m3 sparse 挂了就返回空）在 bge（非 m3）模式下永久失效
                # 新策略：
                #   - 如果有向量索引 → 走纯 dense 检索（接受召回率下降但不空）
                #   - 如果连向量都没有 → 才返回空 + 错误日志
                log.warning("[KB] sparse 不可用，降级到纯向量检索（embedder=%s, sparse_available=%s）",
                          self.embedder.mode if self._embedder_loaded else "not_loaded",
                          getattr(self.embedder, 'sparse_available', False))

                # 纯 dense 检索
                merged = []
                if self.vectors is not None and len(self.chunk_order) > 0:
                    if not self._embedder_loaded:
                        self.init_embedder()
                    merged = self._search_vector(query, top_k=top_k)

                if not merged:
                    log.error("[KB] 纯向量检索也无结果: query=%s, vectors=%s, chunks=%d",
                              query[:50],
                              "ok" if self.vectors is not None else "None",
                              len(self.chunk_order))
                    return []

                # Reranker 精排（如果有）
                reranker_ok = self._ensure_reranker()
                if reranker_ok and self.reranker.available:
                    merged = self.reranker.rerank(query, merged, top_k=top_k)

                # MMR
                merged = self._mmr_rerank(query, merged, top_k=top_k)
                self._schedule_reranker_unload()

                # 私密文档过滤
                if accessible_doc_ids is not None:
                    merged = [r for r in merged if r.get("doc_id", "") in accessible_doc_ids]

                # P6 修复：sparse 降级路径也要更新 hit_count
                hit_doc_ids = set(r.get("doc_id", "") for r in merged if r.get("doc_id", ""))
                for hit_doc_id in hit_doc_ids:
                    doc = self.documents.get(hit_doc_id)
                    if doc is not None:
                        doc.hit_count = getattr(doc, "hit_count", 0) + 1
                # 立即持久化（降级路径频率低，直接保存）
                try:
                    self._save_meta()
                except Exception as e:
                    log.warning("[KB] hit_count 持久化失败: %s", e)

                log.info("[KB] 纯向量+Reranker+MMR (sparse 降级): %d条", len(merged))
                return merged

    def get_context(self, query: str, top_k: int = None, max_chars: int = None,
                    ai_mode: str = None, accessible_doc_ids: set = None) -> Tuple[str, List[Dict]]:
        """检索相关 chunk 并拼接为上下文文本

        Patch4 v3.1：支持按 ai_mode 动态调整 top_k 和 max_chars
        - 本地模式（ai_mode='local'）：top_k=3, max_chars=5000（适配 4B 模型 16K 上下文）
        - 云端模式（ai_mode='cloud'）：top_k=5, max_chars=12000（云端 1M 随便吃）

        Patch5 T03：支持 accessible_doc_ids 私密文档过滤

        Returns:
            (context_text, sources)
        """
        # Patch4 v3.1：按模式动态调整参数
        if top_k is None or max_chars is None:
            try:
                from config import get as _cfg
                if ai_mode == 'local':
                    top_k = top_k or _cfg("kb_search_top_k_local", 3)
                    max_chars = max_chars or _cfg("kb_context_max_chars_local", 5000)
                else:
                    top_k = top_k or _cfg("kb_search_top_k_cloud", 5)
                    max_chars = max_chars or _cfg("kb_context_max_chars_cloud", 12000)
            except Exception:
                top_k = top_k or 5
                max_chars = max_chars or 8000  # fallback 旧默认值

        results = self.search(query, top_k=top_k, accessible_doc_ids=accessible_doc_ids)

        if not results:
            log.info("[KB] get_context(): 无检索结果, query=%s", query[:50])
            return "", []

        # 按 score 降序拼接，不超过 max_chars
        context_parts = []
        total_chars = 0
        sources = []
        for i, r in enumerate(results, 1):
            text = r["text"]
            if total_chars + len(text) > max_chars:
                # 截取剩余空间
                remaining = max_chars - total_chars
                if remaining > 100:
                    text = text[:remaining] + "..."
                else:
                    break
            # 编号标注，让模型在回答中引用 [1] [2] ...
            context_parts.append("【资料[%d] 来源: %s】\n%s" % (i, r["source_label"], text))
            # 保存 snippet（前200字）供前端展示来源卡片
            r["text_snippet"] = text[:200].strip()
            sources.append(r)
            total_chars += len(text)

        log.info("[KB] get_context(): query=%s, 检索%d条→取%d条, %d字, 来源=%s",
                 query[:50], len(results), len(sources), total_chars,
                 [s["source_label"] for s in sources])

        return "\n\n---\n\n".join(context_parts), sources
