# -*- coding: utf-8 -*-
"""
knowledge/ops.py — 文库核心操作 Mixin
======================================
包含 __init__、持久化、文档管理、处理控制（暂停/取消/恢复）、模型卸载/加载。
从 knowledge_base.py 拆分而来。
"""
import os
import re
import uuid
import time
import json
import threading
import logging
import numpy as np
from typing import Optional, List, Dict, Any, Tuple
from dataclasses import asdict
from datetime import datetime

from common.utils import TaskCancelledError, CancellationToken
from knowledge.models import KBDocument, KBChunk
from knowledge.tags import normalize_tag
from knowledge.embedding_engine import EmbeddingEngine
from knowledge.reranker_engine import RerankerEngine

log = logging.getLogger(__name__)


class _KBOpsMixin:
    """文库核心操作：初始化、持久化、文档管理、处理控制"""

    def __init__(self, base_dir: str = None):
        from config import KB_DATA_DIR
        self.base_dir = base_dir or os.path.dirname(os.path.abspath(__file__))
        self.data_dir = KB_DATA_DIR  # D1 重构：C:\Sidemate\data\kb
        self.texts_dir = os.path.join(self.data_dir, "kb_texts")
        self.meta_path = os.path.join(self.data_dir, "kb_meta.json")
        self.vectors_path = os.path.join(self.data_dir, "kb_vectors.npz")

        os.makedirs(self.data_dir, exist_ok=True)
        os.makedirs(self.texts_dir, exist_ok=True)

        # 数据
        self.documents: Dict[str, KBDocument] = {}
        self.chunks: Dict[str, KBChunk] = {}
        self.vectors: Optional[np.ndarray] = None   # (N, dim)
        self.chunk_order: List[str] = []             # chunk_id 有序列表，与 vectors 行对齐
        self._need_rebuild_vectors = False           # 模型升级后需要重建向量索引

        # 嵌入引擎
        self.embedder = EmbeddingEngine()
        self._embedder_loaded = False
        self._embedder_mem_mb = 0  # 实测内存占用（psutil RSS 差值）

        # Reranker 精排引擎（延迟加载）
        self.reranker = RerankerEngine()
        self._reranker_mem_mb = 0  # 实测内存占用（psutil RSS 差值）

        # Reranker 懒加载 + 空闲超时卸载（Patch 8 P8-2）
        self._reranker_lock = threading.Lock()       # 保护 _unload_reranker 的线程安全
        self._reranker_timer: Optional[threading.Timer] = None  # 空闲超时计时器
        self._reranker_last_use: float = 0.0         # 上次使用时间戳
        self._reranker_unloaded_at: float = 0.0      # 上次卸载时间戳（用于冷却期）

        # 配置
        self._load_config()

        # 处理状态
        self._processing_lock = threading.Lock()
        # 注意：已移除 _summary_lock（GenerateQueue 已保证 GPU 互斥，无需二次串行化）
        self._cancel_flags: Dict[str, bool] = {}      # doc_id -> cancel?（兼容旧接口）
        self._cancel_tokens: Dict[str, CancellationToken] = {}  # doc_id -> CancellationToken
        self._pause_flags: Dict[str, bool] = {}        # doc_id -> pause?
        self._paused_event = threading.Event()
        self._paused_event.set()                       # 初始不暂停
        self._global_paused = False                    # D31: 录音时全局暂停

        # Patch5: BM25 索引已彻底移除（bge-m3 sparse 替代）
        # 保留三个空字段只是为了兼容 __getattr__ 防止老代码 AttributeError
        self._bm25 = None
        self._bm25_tokens = []
        self._bm25_chunk_ids = []

        # Patch5 T03: bge-m3 sparse 索引（dense+sparse 检索用）
        # 格式：{chunk_id: {token_id: weight}}
        self._sparse_index: Dict[str, Dict[int, float]] = {}

        # Patch5 审计修复 P0-3: hit_count 批量延迟写入计数器
        self._hit_count_dirty = 0
        self._last_hit_flush = 0.0

        # 加载已有数据
        self._load_meta()
        # Patch5: BM25 索引构建已移除（bge-m3 sparse 替代）

    # ===== 文档状态机 =====
    # 合法状态转换：current → {allowed_next}
    _VALID_TRANSITIONS = {
        "pending":     {"processing", "cancelled"},
        "processing":  {"indexing", "cancelled", "error"},
        "indexing":    {"ready", "cancelled", "error"},
        "ready":       {"cancelled", "error"},
        "error":       set(),  # 终态，只能删除后重新导入
        "cancelled":   set(),  # 终态
    }

    def _transition(self, doc_id: str, new_status: str):
        """安全的状态转换（带校验和日志）

        Args:
            doc_id: 文档ID
            new_status: 目标状态
        Returns:
            True 如果转换合法，False 如果非法
        """
        doc = self.documents.get(doc_id)
        if not doc:
            return False
        current = doc.status
        allowed = self._VALID_TRANSITIONS.get(current, set())
        if new_status not in allowed and new_status != current:
            log.error("[KB] 非法状态转换: %s → %s (doc=%s)", current, new_status, doc_id)
            return False
        if current != new_status:
            log.debug("[KB] 状态转换: %s → %s (doc=%s)", current, new_status, doc_id)
            doc.status = new_status
        return True

    def _load_config(self):
        """从 config.py 读取配置"""
        try:
            from config import get as _cfg
            self.max_documents = _cfg("kb_max_documents", 50)
            self.max_total_chunks = _cfg("kb_max_total_chunks", 1000)
            self.chunk_max_chars = _cfg("kb_chunk_max_chars", 2500)
            self.chunk_overlap_chars = _cfg("kb_chunk_overlap_chars", 200)
            self.search_top_k = _cfg("kb_search_top_k", 5)
            self.embed_batch_size = _cfg("kb_embed_batch_size", 50)
        except Exception as e:
            log.warning("[KB] 配置加载失败，使用默认值: %s", str(e)[:80])
            self.max_documents = 50
            self.max_total_chunks = 1000
            self.chunk_max_chars = 2500
            self.chunk_overlap_chars = 200
            self.search_top_k = 5
            self.embed_batch_size = 50

    @staticmethod
    def _rss_mb() -> int:
        """获取当前进程 RSS（MB），psutil 不可用时返回 0"""
        try:
            import psutil
            return int(psutil.Process(os.getpid()).memory_info().rss / 1024 / 1024)
        except Exception as e:
            log.warning("[KB] psutil RSS 获取失败: %s", str(e)[:80])
            return 0

    def init_embedder(self) -> bool:
        """初始化嵌入引擎（延迟加载，服务启动时调用）"""
        if self._embedder_loaded:
            return True
        rss_before = self._rss_mb()
        ok = self.embedder.load()
        self._embedder_loaded = ok
        if ok:
            rss_after = self._rss_mb()
            raw_delta = max(0, rss_after - rss_before)
            # OV pipeline 使用共享内存映射，RSS 差值可能虚高（含被多次计数的共享页）
            # 截断到模型文件大小上限作为合理估计
            self._embedder_mem_mb = min(raw_delta, 800)  # bge-base 768维 上限 ~800MB
            log.info("[KB] 嵌入模型加载完成，实测占用 %d MB (raw_delta: %d, RSS: %d→%d)",
                     self._embedder_mem_mb, raw_delta, rss_before, rss_after)
        return ok

    def init_reranker(self) -> bool:
        """初始化 Reranker 精排引擎（延迟加载，首次检索时触发）"""
        if self.reranker.available:
            return True
        rss_before = self._rss_mb()
        ok = self.reranker.load()
        if ok:
            rss_after = self._rss_mb()
            raw_delta = max(0, rss_after - rss_before)
            # OV pipeline 使用共享内存映射，RSS 差值可能虚高（含被多次计数的共享页）
            # 截断到模型文件大小上限作为合理估计
            self._reranker_mem_mb = min(raw_delta, 600)  # bge-reranker-base 上限 ~600MB
            log.info("[KB] Reranker 加载完成，实测占用 %d MB (raw_delta: %d, RSS: %d→%d)",
                     self._reranker_mem_mb, raw_delta, rss_before, rss_after)
        return ok

    def _ensure_reranker(self) -> bool:
        """检索前调用：确保 Reranker 可用（如未加载则加载）

        同时取消已排定的空闲卸载计时器。
        """
        # 取消排定的卸载计时器
        if self._reranker_timer is not None:
            self._reranker_timer.cancel()
            self._reranker_timer = None

        if self.reranker.available:
            self._reranker_last_use = time.time()
            return True

        with self._reranker_lock:
            # 双重检查：获取锁后可能已被其他线程加载
            if self.reranker.available:
                self._reranker_last_use = time.time()
                return True
            ok = self.init_reranker()
            if ok:
                self._reranker_last_use = time.time()
            return ok

    def _schedule_reranker_unload(self):
        """检索后调用：如果非常驻模式，启动空闲超时计时器

        计时器到期后执行 _unload_reranker()，但受冷却期保护。
        """
        try:
            from config import get as _cfg
            resident = _cfg("reranker_resident", False)
        except Exception as e:
            log.warning("[KB] 读取 reranker_resident 配置失败: %s", str(e)[:80])
            resident = False

        if resident:
            log.debug("[KB] Reranker 常驻模式，跳过空闲卸载调度")
            return

        try:
            from config import get as _cfg
            timeout_sec = _cfg("reranker_idle_timeout_sec", 300)
        except Exception as e:
            log.warning("[KB] 读取 reranker_idle_timeout_sec 配置失败: %s", str(e)[:80])
            timeout_sec = 300

        # 取消已有计时器
        if self._reranker_timer is not None:
            self._reranker_timer.cancel()
            self._reranker_timer = None

        def _on_timeout():
            self._reranker_timer = None
            # 冷却期检查：卸载后 30 秒内不再卸载
            if self._reranker_unloaded_at > 0 and (time.time() - self._reranker_unloaded_at) < 30:
                log.debug("[KB] Reranker 冷却期内，跳过卸载")
                return
            self._unload_reranker()

        self._reranker_timer = threading.Timer(timeout_sec, _on_timeout)
        self._reranker_timer.daemon = True
        self._reranker_timer.start()
        log.debug("[KB] Reranker 空闲卸载计时器已启动: %ds", timeout_sec)

    def _unload_reranker(self):
        """实际卸载 Reranker，释放内存，清理相关变量

        线程安全：通过 _reranker_lock 保护卸载过程。
        """
        with self._reranker_lock:
            if not self.reranker._loaded:
                return
            log.info("[KB] Reranker 空闲超时，开始卸载...")
            self._release_model_object(self.reranker)
            self.reranker.unload()
            self._reranker_mem_mb = 0
            self._reranker_unloaded_at = time.time()

            import gc
            gc.collect()

            # 尝试 trim 进程内存
            try:
                import ctypes
                kernel32 = ctypes.windll.kernel32
                handle = kernel32.GetCurrentProcess()
                kernel32.SetProcessWorkingSetSize(handle, ctypes.c_size_t(-1), ctypes.c_size_t(-1))
            except Exception as e:
                log.debug("[KB] 内存 trim 失败（非 Windows 或权限不足）: %s", str(e)[:60])

            log.info("[KB] Reranker 卸载完成")

    def unload_models(self) -> Dict:
        """卸载嵌入模型和 Reranker，释放内存

        数据（文档/chunks/向量索引）保留在磁盘，模型卸载后：
        - 无法导入新文档（需要嵌入模型）
        - 无法做语义检索（降级到 BM25 或完全不可用）
        - 已有的文档数据不受影响

        Returns:
            {"success": True, "freed_mb": 实测释放的内存MB}
        """
        import gc

        # ① 先取消所有进行中的处理（摘要生成等）
        self._cancel_all_processing()

        # 取消 Reranker 空闲卸载计时器
        if self._reranker_timer is not None:
            self._reranker_timer.cancel()
            self._reranker_timer = None

        freed = self._embedder_mem_mb + self._reranker_mem_mb  # 使用实测值

        # 卸载 Reranker
        if self.reranker._loaded:
            self._release_model_object(self.reranker)
            self.reranker.unload()
            self._reranker_mem_mb = 0
            log.info("[KB] Reranker 已卸载")

        # 卸载嵌入模型
        if self._embedder_loaded:
            self._release_model_object(self.embedder)
            self.embedder._model = None
            self._embedder_loaded = False
            self.embedder._mode = "none"
            self._embedder_mem_mb = 0
            log.info("[KB] 嵌入模型已卸载")

        gc.collect()

        # 尝试清理 PyTorch 内部内存缓存
        try:
            import torch
            if hasattr(torch, 'cuda') and torch.cuda.is_available():
                torch.cuda.empty_cache()
        except Exception as e:
            log.debug("[KB] PyTorch CUDA 缓存清理跳过: %s", str(e)[:60])

        # 强制 OS 回收进程的空闲内存页
        # Python/malloc free 后内存不一定立刻还给 OS，需要主动 trim
        try:
            import ctypes
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.GetCurrentProcess()
            kernel32.SetProcessWorkingSetSize(handle, ctypes.c_size_t(-1), ctypes.c_size_t(-1))
        except Exception as e:
            log.debug("[KB] 内存 trim 失败（非 Windows 或权限不足）: %s", str(e)[:60])

        log.info("[KB] 模型卸载完成，估算释放 ~%dMB", freed)
        return {"success": True, "freed_mb": freed}

    @staticmethod
    def _release_model_object(engine):
        """彻底释放 sentence-transformers 模型内存

        仅设置 _model = None 不够：
        - PyTorch nn.Module 持有大量 Parameter tensors（每个都是独立的内存分配）
        - Python GC 只回收"不可达"对象，但 engine._model 仍引用模型 → 所有参数都不会回收
        - 必须先 del engine._model（解除引用），再 gc.collect()
        - sentence-transformers 内部还可能缓存 tokenizer、model cards 等
        """
        model = engine._model
        if model is None:
            return
        try:
            # 把模型参数移到 CPU，确保不留 GPU 引用
            if hasattr(model, 'to'):
                model.to('cpu')
            # 清理 sentence-transformers 内部缓存
            for attr in ['_cache_dir', '_model_card_vars', '_model_card_text']:
                try:
                    setattr(model, attr, None)
                except Exception:
                    pass  # 属性可能只读，忽略
            # 清理 tokenizer 缓存
            tokenizer = getattr(model, 'tokenizer', None)
            if tokenizer is not None:
                try:
                    del tokenizer
                except Exception:
                    pass  # tokenizer 可能被其他对象持有
        except Exception as e:
            log.debug("[KB] 模型对象清理部分失败: %s", str(e)[:60])
        # 关键：先删除引擎上的引用，再 gc 收集
        engine._model = None
        del model

    # 最近一次加载错误信息（供 module-status 端点返回给前端）
    _last_load_error: str = ""

    def load_models(self) -> Dict:
        """重新加载嵌入模型和 Reranker

        Returns:
            {"success": bool, "embedder": bool, "reranker": bool, "loaded_mb": 实测占用的内存MB, "error": str}
        """
        self._last_load_error = ""
        embedder_ok = self.init_embedder()
        reranker_ok = self.init_reranker()
        loaded = self._embedder_mem_mb + self._reranker_mem_mb

        # 收集错误信息
        errors = []
        if not embedder_ok:
            errors.append("嵌入模型加载失败")
        if not reranker_ok:
            errors.append("Reranker 加载失败")

        if errors:
            self._last_load_error = "；".join(errors)
            # 追加嵌入引擎的具体错误
            if not embedder_ok and self.embedder._mode == "none":
                # 检测常见原因
                try:
                    import sentence_transformers  # noqa: F401
                except ImportError as ie:
                    self._last_load_error += "（缺少依赖：%s，请重新导入文库扩展包）" % str(ie)[:80]
                except Exception as ex:
                    self._last_load_error += "（%s）" % str(ex)[:80]

        log.info("[KB] 模型重新加载: embedder=%s(%dMB), reranker=%s(%dMB), 合计~%dMB%s",
                 embedder_ok, self._embedder_mem_mb,
                 reranker_ok, self._reranker_mem_mb, loaded,
                 (" ERR: " + self._last_load_error) if self._last_load_error else "")
        return {
            "success": embedder_ok,  # 至少嵌入模型要成功
            "embedder": embedder_ok,
            "reranker": reranker_ok,
            "loaded_mb": loaded,
            "error": self._last_load_error or None,
        }

    # ===== 持久化 =====

    def _load_meta(self):
        """加载元数据"""
        # 启动时清理残留的 .tmp 文件（可能是上次进程中断遗留）
        try:
            for f in os.listdir(self.data_dir):
                if f.endswith(".tmp") or f.endswith(".tmp.npz"):
                    tmp_path = os.path.join(self.data_dir, f)
                    os.remove(tmp_path)
                    log.info("[KB] 清理残留临时文件: %s", f)
        except Exception:
            pass

        if not os.path.exists(self.meta_path):
            return
        try:
            with open(self.meta_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            log.error("[KB] 加载元数据失败: %s", str(e))
            return

        # 恢复文档
        for doc_data in data.get("documents", []):
            doc = KBDocument(**doc_data)
            self.documents[doc.doc_id] = doc

        # 恢复 chunks
        for chunk_data in data.get("chunks", []):
            chunk = KBChunk(**chunk_data)
            self.chunks[chunk.chunk_id] = chunk
            # 加载文本（异常隔离，避免单个 chunk 损坏阻断整个加载）
            text_path = os.path.join(self.texts_dir, chunk.chunk_id + ".txt")
            try:
                with open(text_path, "r", encoding="utf-8") as f:
                    chunk.text = f.read()
            except Exception as e:
                log.warning("_load_meta: chunk text read failed (%s): %s" % (text_path, str(e)[:80]))
                chunk.text = chunk.text or ""

        # 恢复向量索引
        if os.path.exists(self.vectors_path):
            # 防御性检查：0 字节或极小的 npz 文件无法包含有效向量
            _vec_file_size = os.path.getsize(self.vectors_path)
            if _vec_file_size < 100:
                log.warning("[KB] 向量索引文件异常（%d 字节），视为损坏并删除", _vec_file_size)
                try:
                    os.remove(self.vectors_path)
                except OSError:
                    pass
                self.vectors = None
                self.chunk_order = []
            else:
                try:
                    npz = np.load(self.vectors_path)
                    self.vectors = npz["vectors"]
                    self.chunk_order = list(npz["chunk_order"].astype(str))
                    log.info("[KB] 向量索引加载: %d vectors, dim=%d", len(self.chunk_order), self.vectors.shape[1])
                    # 维度兼容性检查：如果维度不匹配（如升级了嵌入模型），自动清除旧索引
                    if self.vectors.shape[1] != self.embedder.vector_dim:
                        log.warning("[KB] 向量维度不匹配: 索引=%d维, 模型=%d维, 清除旧索引将自动重建",
                                   self.vectors.shape[1], self.embedder.vector_dim)
                        self.vectors = None
                        self.chunk_order = []
                        # 标记需要重建向量
                        self._need_rebuild_vectors = True
                except Exception as e:
                    log.error("[KB] 向量索引加载失败: %s", str(e))
                    self.vectors = None
                    self.chunk_order = []

        # 构建有序 chunk 列表
        if not self.chunk_order:
            self.chunk_order = list(self.chunks.keys())

        log.info("[KB] 元数据加载: %d 文档, %d chunks", len(self.documents), len(self.chunks))

        # 总字符数上限检查
        total_chars = sum(len(c.text) for c in self.chunks.values() if c.text)
        if total_chars > 200 * 1024 * 1024:  # Patch4 v3.1：50MB → 200MB
            log.warning("[KB] 文库总字符数 %.1fMB 超过 200MB 上限，可能影响内存和检索性能",
                        total_chars / 1024 / 1024)

        # Patch4 v3.1 BUG#29：向量索引缺失但有 chunks → 触发重建
        # 之前只在"文件存在但维度不匹配"时才设 _need_rebuild_vectors
        # 文件被删/损坏清除后，这个 flag 不会被设，导致向量索引永远不重建
        # Patch4 v3.1 BUG#30：加 kb_auto_rebuild 开关，启动时重建太慢会卡死服务
        # 改为懒加载模式：首次 search 时才重建（避免启动卡死）
        try:
            from config import get as _cfg
            _auto_rebuild_on_start = _cfg("kb_auto_rebuild_on_start", False)
        except Exception:
            _auto_rebuild_on_start = False

        if self.vectors is None and self.chunks and not os.path.exists(self.vectors_path):
            if _auto_rebuild_on_start:
                log.info("[KB] 向量索引缺失但有 %d chunks，标记重建", len(self.chunks))
                self._need_rebuild_vectors = True
            else:
                log.info("[KB] 向量索引缺失，懒加载模式（首次检索时重建）")
                self._need_rebuild_vectors = True  # 标记，但不阻塞启动

        # 向量维度不匹配时，自动重建向量索引（仅在配置开启时启动期执行）
        if self._need_rebuild_vectors and self.chunks and _auto_rebuild_on_start:
            log.info("[KB] 开始自动重建向量索引 (%d chunks)...", len(self.chunks))
            try:
                self._rebuild_all_vectors()
                self._need_rebuild_vectors = False
                log.info("[KB] 向量索引重建完成")
            except Exception as e:
                log.error("[KB] 向量索引自动重建失败: %s, 将在首次搜索时重建", str(e))

    def _save_meta(self):
        """保存元数据"""
        data = {
            "version": 1,
            "documents": [asdict(d) for d in self.documents.values()],
            "chunks": [
                {k: v for k, v in asdict(c).items() if k != "text"}
                for c in self.chunks.values()
            ],
        }
        try:
            import tempfile
            tmp_fd, tmp_path = tempfile.mkstemp(
                suffix=".tmp", dir=os.path.dirname(self.meta_path), prefix="kb_meta_"
            )
            try:
                with os.fdopen(tmp_fd, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                os.replace(tmp_path, self.meta_path)
            except Exception:
                # 清理临时文件
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except Exception as e:
            log.error("[KB] 保存元数据失败: %s", str(e))

    def _rebuild_all_vectors(self):
        """重建全部向量索引（模型升级后维度变化时调用）"""
        if not self.chunks:
            return
        # 确保嵌入模型已加载
        if not self._embedder_loaded:
            self.init_embedder()
        chunk_ids = list(self.chunks.keys())
        texts = [self.chunks[cid].text for cid in chunk_ids]
        # 分批编码（避免内存溢出）
        batch_size = 64
        all_vecs = []
        for i in range(0, len(texts), batch_size):
            batch = texts[i:i + batch_size]
            vecs = self.embedder.encode(batch)
            if vecs is not None and len(vecs) > 0:
                all_vecs.append(vecs)
        if all_vecs:
            self.vectors = np.vstack(all_vecs)
            self.chunk_order = chunk_ids
            self._save_vectors()
            log.info("[KB] 向量索引重建完成: %d vectors, dim=%d", len(chunk_ids), self.vectors.shape[1])

    def _save_vectors(self):
        """保存向量索引"""
        if self.vectors is None or len(self.chunk_order) == 0:
            return
        try:
            import tempfile
            tmp_fd, tmp_path = tempfile.mkstemp(
                suffix=".tmp", dir=os.path.dirname(self.vectors_path), prefix="kb_vec_"
            )
            try:
                os.close(tmp_fd)
                np.savez_compressed(
                    tmp_path,
                    vectors=self.vectors,
                    chunk_order=np.array(self.chunk_order),
                )
                os.replace(tmp_path, self.vectors_path)
            except Exception:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
                raise
        except Exception as e:
            log.error("[KB] 保存向量索引失败: %s", str(e))

    def _save_chunk_text(self, chunk: KBChunk):
        """保存 chunk 原文到文件"""
        text_path = os.path.join(self.texts_dir, chunk.chunk_id + ".txt")
        try:
            with open(text_path, "w", encoding="utf-8") as f:
                f.write(chunk.text)
        except Exception as e:
            log.error("[KB] 保存 chunk 文本失败: %s", str(e))

    # ===== 文档管理 =====

    def list_documents(self) -> List[Dict]:
        """列出所有文档"""
        result = []
        for doc in self.documents.values():
            d = asdict(doc)
            d.pop("error_msg", None)  # 不暴露内部错误
            result.append(d)
        return result

    def get_document(self, doc_id: str) -> Optional[KBDocument]:
        """获取文档信息"""
        return self.documents.get(doc_id)

    def get_document_status(self, doc_id: str) -> Optional[Dict]:
        """获取文档处理状态"""
        doc = self.documents.get(doc_id)
        if not doc:
            return None
        return {
            "doc_id": doc.doc_id,
            "filename": doc.filename,
            "status": doc.status,
            "progress": doc.progress,
            "chunk_count": doc.chunk_count,
            "total_chars": doc.total_chars,
            "error_msg": doc.error_msg,
        }

    def import_document(self, filename: str, text: str, file_type: str = "txt",
                        source: str = "upload", metadata: Dict = None,
                        is_private: bool = False) -> Dict:
        """导入文档（创建记录，返回 doc_id，异步处理由 process_document 完成）

        Args:
            filename: 文件名
            text: 提取的文本内容
            file_type: 文件扩展名
            source: "upload" | "transcript"
            metadata: 额外元数据（如 has_images, image_count）
            is_private: Patch5 私密文档标记（持久化到 kb_meta.json）
        Returns:
            {"doc_id": "...", "status": "pending"} 或 {"error": "..."}
        """
        # 检查文档数上限
        ready_count = sum(1 for d in self.documents.values() if d.status in ("ready", "processing", "indexing"))
        if ready_count >= self.max_documents:
            return {"error": "文库已满（最多 %d 个文档），请先删除旧文档" % self.max_documents}

        if not text.strip():
            return {"error": "文件内容为空"}

        doc_id = uuid.uuid4().hex[:12]
        doc = KBDocument(
            doc_id=doc_id,
            filename=filename,
            file_type=file_type,
            file_size=len(text.encode("utf-8")),
            imported_at=datetime.now().isoformat(),
            status="pending",
            source=source,
            total_chars=len(text),
            metadata=metadata or {},
            is_private=is_private,  # Patch5: 私密标记
        )
        self.documents[doc_id] = doc
        self._save_meta()

        log.info("[KB] 文档导入: %s (%s, %d字, private=%s)", filename, doc_id, len(text), is_private)
        return {"doc_id": doc_id, "status": "pending"}

    def process_document(self, doc_id: str, text: str):
        """处理文档：分块 + 嵌入 + 摘要（可在线程中运行）

        支持暂停/取消：
        - 使用 CancellationToken 统一取消传播
        - 各阶段通过 token.check_or_raise() 检查取消
        - D31: 检查 _global_paused（录音时全局暂停）
        """
        doc = self.documents.get(doc_id)
        if not doc:
            return

        # 创建此文档的 CancellationToken
        token = CancellationToken(doc_id)
        self._cancel_tokens[doc_id] = token
        # 兼容：如果之前已设置了 cancel flag，立即触发 token
        if self._cancel_flags.get(doc_id):
            token.cancel()

        # 检查总 chunk 数上限
        current_chunks = len(self.chunks)
        if current_chunks >= self.max_total_chunks:
            doc.status = "error"
            doc.error_msg = "chunk 总数已达上限 %d" % self.max_total_chunks
            self._save_meta()
            return

        self._transition(doc_id, "processing")
        self._save_meta()

        try:
            # === 1. 分块 ===
            token.check_or_raise()
            from knowledge.chunker import chunk_text
            plan = chunk_text(
                text,
                max_chars=self.chunk_max_chars,
                overlap_chars=self.chunk_overlap_chars,
                max_chunks=200,  # 单文档最多 200 块
            )

            if plan.total_chunks == 0:
                doc.status = "error"
                doc.error_msg = "分块结果为空"
                self._save_meta()
                return

            token.check_or_raise()

            # 创建 chunk 记录
            new_chunks = []
            for ck in plan.chunks:
                chunk_id = uuid.uuid4().hex[:12]
                heading = ck.section_title or ""
                chunk = KBChunk(
                    chunk_id=chunk_id,
                    doc_id=doc_id,
                    index=ck.index,
                    text=ck.text,
                    char_count=len(ck.text),
                    heading=heading,
                    source_label=self._build_source_label(doc.filename, heading),
                    is_private=getattr(doc, 'is_private', False),  # Patch5: 继承文档私密标记
                )
                self.chunks[chunk_id] = chunk
                new_chunks.append(chunk)
                self._save_chunk_text(chunk)

            doc.chunk_count = len(new_chunks)
            doc.progress = 0.3  # 分块完成 30%
            self._transition(doc_id, "indexing")
            self._save_meta()

            # === 2. 嵌入 ===
            if not self._embedder_loaded:
                self.init_embedder()

            batch_size = self.embed_batch_size
            all_vectors = []
            for i in range(0, len(new_chunks), batch_size):
                token.check_or_raise()

                # 检查暂停（D31 全局暂停 + D32 单文档暂停）
                while self._pause_flags.get(doc_id) or self._global_paused:
                    self._paused_event.clear()
                    self._paused_event.wait(timeout=2.0)  # 每 2 秒检查一次
                    token.check_or_raise()

                batch = new_chunks[i:i + batch_size]
                batch_texts = [c.text for c in batch]
                vecs = self.embedder.encode(batch_texts)
                all_vectors.append(vecs)

                # 更新进度
                progress = 0.3 + 0.7 * min(1.0, (i + batch_size) / len(new_chunks))
                doc.progress = round(progress, 2)
                self._save_meta()

            # 合并向量
            if all_vectors:
                new_vecs = np.vstack(all_vectors)
            else:
                new_vecs = np.array([]).reshape(0, self.embedder.vector_dim)

            # === 3. 合入全局向量索引 ===
            with self._processing_lock:
                new_chunk_ids = [c.chunk_id for c in new_chunks]
                if self.vectors is None or len(self.chunk_order) == 0:
                    self.vectors = new_vecs
                    self.chunk_order = new_chunk_ids
                else:
                    self.vectors = np.vstack([self.vectors, new_vecs])
                    self.chunk_order.extend(new_chunk_ids)

                self._save_vectors()

                # Patch5 T03: 构建新 chunk 的 sparse 索引（bge-m3 dense+sparse）
                if self._embedder_loaded and self.embedder.sparse_available:
                    try:
                        batch_texts = [c.text for c in new_chunks]
                        _, sparse_weights = self.embedder.encode_dense_sparse(batch_texts)
                        for chunk, weights in zip(new_chunks, sparse_weights):
                            if weights:
                                self._sparse_index[chunk.chunk_id] = weights
                        log.info("[KB] sparse 索引构建: +%d chunks → 共%d", len(new_chunks), len(self._sparse_index))
                    except Exception as e:
                        log.warning("[KB] sparse 索引构建失败（不影响 dense 检索）: %s", str(e)[:100])

                # Patch5: BM25 索引重建已移除（bge-m3 sparse 替代）

            # === 4. 摘要：用文档前200字直接填充（不再调 LLM） ===
            # LLM 摘要功能已移除：Qwen3 think 模式导致空输出 + GPU 占用 + 几乎零检索提升
            full_text = "\n".join(c.text for c in new_chunks if hasattr(c, 'text'))
            doc.summary = (full_text[:200] + "...") if len(full_text) > 200 else full_text

            self._transition(doc_id, "ready")
            doc.progress = 1.0
            self._save_meta()

            log.info("[KB] 文档处理完成: %s → %d chunks, %d total",
                     doc.filename, len(new_chunks), len(self.chunk_order))

        except TaskCancelledError:
            log.info("[KB] 文档处理被取消: %s", doc_id)
            # 清理 chunks（cancel_processing 可能已同步清理，这里做兜底）
            remaining_chunks = [cid for cid, c in self.chunks.items() if c.doc_id == doc_id]
            if remaining_chunks:
                self._cleanup_cancelled_chunks(doc_id)
            doc.status = "cancelled"
            doc.chunk_count = 0
            doc.progress = 0.0
            self._save_meta()
        except Exception as e:
            log.error("[KB] 文档处理失败: %s - %s", doc_id, str(e))
            doc.status = "error"
            doc.error_msg = str(e)[:200]
            doc.progress = 0.0
            self._save_meta()
        finally:
            # 清理 CancellationToken（防止内存泄漏）
            self._cancel_tokens.pop(doc_id, None)
            self._cancel_flags.pop(doc_id, None)

    # (_generate_doc_summary 已移除 — LLM 摘要功能砍掉，用文档前200字直接填充)

    # ===== BM25 索引（Hybrid Search Phase 1）=====

    # 中文停用词表（BM25 高频虚词过滤）
    _STOP_WORDS = frozenset({
        "的", "了", "在", "是", "我", "有", "和", "就", "不", "人", "都", "一", "一个",
        "上", "也", "很", "到", "说", "要", "去", "你", "会", "着", "没有", "看", "好",
        "自己", "这", "他", "她", "它", "们", "那", "被", "从", "把", "对", "与", "以",
        "但", "而", "或", "所", "其", "这个", "那个", "什么", "怎么", "如何", "可以",
        "因为", "所以", "如果", "虽然", "但是", "而且", "以及", "还是", "已经", "可能",
        "应该", "需要", "能", "得", "地", "么", "吗", "呢", "吧", "啊", "呀", "哦",
        "嗯", "嘛", "哈", "哪", "谁", "多", "些", "每", "之", "等", "及", "于", "中",
    })

    # Patch5: _tokenize_zh / _build_bm25_index / _refine_for_bm25 / _QUERY_NOISE 已全部删除
    # bge-m3 sparse 替代了 BM25，不再需要 jieba 分词和查询精炼

    def _build_source_label(self, filename: str, heading: str) -> str:
        """构建来源标注"""
        if heading:
            return "%s \u00a7%s" % (filename, heading)
        return filename

    def delete_document(self, doc_id: str) -> Dict:
        """删除文档 + chunk + 向量（D30）

        如果文档正在处理中，先取消再删除。
        """
        doc = self.documents.get(doc_id)
        if not doc:
            return {"error": "文档不存在"}

        # 如果正在处理中，先取消
        if doc.status in ('processing', 'chunking', 'indexing'):
            self.cancel_processing(doc_id)

        # 找到该文档的所有 chunk
        doc_chunk_ids = [cid for cid, c in self.chunks.items() if c.doc_id == doc_id]
        doc_chunk_id_set = set(doc_chunk_ids)

        with self._processing_lock:
            # 删除 chunk 记录和文本
            for cid in doc_chunk_ids:
                self.chunks.pop(cid, None)
                text_path = os.path.join(self.texts_dir, cid + ".txt")
                if os.path.exists(text_path):
                    os.remove(text_path)

            # 使用集合过滤替代逐个 remove（O(n) → O(n) 一次遍历）
            self.chunk_order = [cid for cid in self.chunk_order if cid not in doc_chunk_id_set]

            # Patch5 T03: 清理 sparse 索引
            for cid in doc_chunk_ids:
                self._sparse_index.pop(cid, None)

            # 重建向量索引（移除对应行）
            if self.vectors is not None and doc_chunk_ids:
                keep_indices = [i for i, cid in enumerate(self.chunk_order) if cid in self.chunks]
                if keep_indices:
                    self.vectors = self.vectors[keep_indices]
                else:
                    self.vectors = None
                self.chunk_order = [cid for cid in self.chunk_order if cid in self.chunks]
                self._save_vectors()

            # 删除文档记录
            del self.documents[doc_id]
            self._save_meta()

            # BM25 重建
            self._build_bm25_index()

        log.info("[KB] 文档删除: %s (%s), 移除 %d chunks", doc.filename, doc_id, len(doc_chunk_ids))
        return {"ok": True, "removed_chunks": len(doc_chunk_ids)}

    def delete_documents_batch(self, doc_ids: List[str]) -> Dict:
        """批量删除文档（B1 优化版）

        减少重复 _save_meta() 和 _build_bm25_index() 调用次数：
        - 所有文档的 chunk 删除在一次遍历中完成
        - _save_meta() 和 _save_vectors() 各只调用一次
        - _build_bm25_index() 只在最后调用一次

        Args:
            doc_ids: 要删除的文档 ID 列表

        Returns:
            {"ok": True, "deleted": N, "failed": [{"doc_id": "...", "error": "..."}]}
        """
        deleted = 0
        failed = []
        valid_doc_ids = set()
        total_removed_chunks = 0

        # 预检查：确认文档存在，取消正在处理的文档
        for doc_id in doc_ids:
            doc = self.documents.get(doc_id)
            if not doc:
                failed.append({"doc_id": doc_id, "error": "文档不存在"})
                continue
            # 如果正在处理中，先取消
            if doc.status in ('processing', 'chunking', 'indexing'):
                self.cancel_processing(doc_id)
            valid_doc_ids.add(doc_id)

        if not valid_doc_ids:
            return {"ok": True, "deleted": 0, "failed": failed}

        # 收集所有要删除的 chunk_id
        all_doc_chunk_ids = set()
        for doc_id in valid_doc_ids:
            doc_chunk_ids = [cid for cid, c in self.chunks.items() if c.doc_id == doc_id]
            all_doc_chunk_ids.update(doc_chunk_ids)
            total_removed_chunks += len(doc_chunk_ids)

        with self._processing_lock:
            # 删除 chunk 记录和文本文件
            for cid in all_doc_chunk_ids:
                self.chunks.pop(cid, None)
                text_path = os.path.join(self.texts_dir, cid + ".txt")
                if os.path.exists(text_path):
                    try:
                        os.remove(text_path)
                    except OSError:
                        pass

            # 过滤 chunk_order
            self.chunk_order = [cid for cid in self.chunk_order if cid not in all_doc_chunk_ids]

            # Patch5 T03: 清理 sparse 索引
            for cid in all_doc_chunk_ids:
                self._sparse_index.pop(cid, None)

            # 重建向量索引（移除对应行）
            if self.vectors is not None and all_doc_chunk_ids:
                keep_indices = [i for i, cid in enumerate(self.chunk_order) if cid in self.chunks]
                if keep_indices:
                    self.vectors = self.vectors[keep_indices]
                else:
                    self.vectors = None
                self.chunk_order = [cid for cid in self.chunk_order if cid in self.chunks]
                self._save_vectors()

            # 删除文档记录
            for doc_id in valid_doc_ids:
                if doc_id in self.documents:
                    doc = self.documents[doc_id]
                    del self.documents[doc_id]
                    deleted += 1

            # 统一只保存一次 meta
            self._save_meta()

            # BM25 重建（只需一次）
            self._build_bm25_index()

        log.info("[KB] 批量删除: %d 个文档, 移除 %d chunks", deleted, total_removed_chunks)
        return {"ok": True, "deleted": deleted, "removed_chunks": total_removed_chunks, "failed": failed}

    # ===== 处理控制（D31/D32）=====

    def pause_processing(self, doc_id: str):
        """暂停单文档处理（D32）"""
        self._pause_flags[doc_id] = True
        log.info("[KB] 暂停处理: %s", doc_id)

    def resume_processing(self, doc_id: str):
        """恢复单文档处理（D32）"""
        self._pause_flags.pop(doc_id, None)
        self._paused_event.set()
        log.info("[KB] 恢复处理: %s", doc_id)

    def cancel_processing(self, doc_id: str):
        """取消单文档处理（D32）

        同时触发 CancellationToken 和取消 GenerateQueue 中的 LOW 请求。
        立即更新文档状态为 cancelled，不等后台线程。
        """
        self._cancel_flags[doc_id] = True  # 兼容旧路径
        self._pause_flags.pop(doc_id, None)
        self._paused_event.set()
        # 触发 CancellationToken（如果存在）
        token = self._cancel_tokens.get(doc_id)
        if token:
            token.cancel()
        # 尝试取消 GenerateQueue 中排队的 LOW 请求
        try:
            mgr = getattr(self, '_model_manager', None)
            if mgr and hasattr(mgr, 'generate_queue'):
                mgr.generate_queue.cancel_all_low()
                log.info("[KB] 已取消 GenerateQueue 中的 LOW 请求")
        except Exception as e:
            log.debug("[KB] 取消 GenerateQueue LOW 请求失败: %s", str(e)[:60])

        # 立即更新文档状态（不等后台线程）
        doc = self.documents.get(doc_id)
        if doc and doc.status in ('processing', 'summarizing', 'chunking', 'indexing'):
            doc.status = 'cancelled'
            doc.progress = 0.0
            self._cleanup_cancelled_chunks(doc_id)
            self._save_meta()
            log.info("[KB] 文档已标记取消（同步）: %s", doc_id)
        else:
            log.info("[KB] 取消处理: %s", doc_id)

    def _cleanup_cancelled_chunks(self, doc_id: str):
        """清理被取消文档的 chunks 和文本文件"""
        doc_chunk_ids = [cid for cid, c in self.chunks.items() if c.doc_id == doc_id]
        for cid in doc_chunk_ids:
            self.chunks.pop(cid, None)
            text_path = os.path.join(self.texts_dir, cid + ".txt")
            if os.path.exists(text_path):
                os.remove(text_path)
        # 从有序列表中移除
        self.chunk_order = [cid for cid in self.chunk_order if cid in self.chunks]

    def _cancel_all_processing(self):
        """取消所有进行中的文档处理（卸载时调用）"""
        doc_ids_to_cancel = []
        for doc_id, doc in self.documents.items():
            if doc.status in ('processing', 'chunking', 'indexing'):
                doc_ids_to_cancel.append(doc_id)

        for doc_id in doc_ids_to_cancel:
            self._cancel_flags[doc_id] = True
            # 触发 CancellationToken
            token = self._cancel_tokens.get(doc_id)
            if token:
                token.cancel()
            self.documents[doc_id].status = 'cancelled'
            self.documents[doc_id].progress = 0.0
            log.info("[KB] 取消处理（卸载清理）: %s", doc_id)

        if doc_ids_to_cancel:
            self._save_meta()

        # 取消 GenerateQueue 中的 LOW 请求
        try:
            mgr = getattr(self, '_model_manager', None)
            if mgr and hasattr(mgr, 'generate_queue'):
                mgr.generate_queue.cancel_all_low()
                log.info("[KB] 已取消所有 GenerateQueue LOW 请求（卸载清理）")
        except Exception:
            pass

    def pause_all(self):
        """全局暂停文库处理（D31：录音时让步）"""
        self._global_paused = True
        log.info("[KB] 全局暂停（录音让步）")

    def resume_all(self):
        """全局恢复文库处理（D31：录音结束后）"""
        self._global_paused = False
        self._paused_event.set()
        log.info("[KB] 全局恢复")
