# -*- coding: utf-8 -*-
"""
tagging_scheduler.py — 异步文档打标调度器（P2 优先级，FIFO）

后台线程：循环取 doc_id → 调用本地 LLM 生成标签+摘要 → 写回 KB 元数据。
设计为同步架构（threading.Thread），适配 FastAPI 同步模式。
"""
import threading
import logging
import re

log = logging.getLogger(__name__)


class TaggingScheduler:
    """异步文档打标调度器"""

    def __init__(self, kb, mgr):
        """kb: KnowledgeBase 实例, mgr: ModelManager 实例"""
        self._kb = kb
        self._mgr = mgr
        self._queue = []          # FIFO 列表，元素为 doc_id
        self._running = False
        self._thread = None
        self._lock = threading.Lock()
        self._has_work = threading.Event()
        # Patch5 G：batch_queue 引用，gating 用（None 时不 gating）
        self._batch_queue = None
        self._pending_ready = set()  # 已 ready 但还没入队的 doc_id（等 batch 空闲）
        # P6 审计修复：记录启动时间，用于 batch_queue 注入超时判断
        import time as _time
        self._started_at = _time.time()

    def set_batch_queue(self, batch_queue):
        """注入 BatchQueue 实例，用于 gating 判断"""
        self._batch_queue = batch_queue
        log.info("[TAG] 已注入 batch_queue 引用，启用 gating")

    def notify_doc_ready(self, doc_id: str):
        """文档向量化完成后调用：登记到 pending_ready，等 batch 空闲再入队"""
        with self._lock:
            self._pending_ready.add(doc_id)
        log.info("[TAG] doc_ready 通知: %s，等 batch 空闲后入队", doc_id)
        self._has_work.set()

    def _is_batch_idle(self) -> bool:
        """检查 batch_queue 是否空闲（无 pending/processing 任务）

        P6 审计修复 M2 + 超时兜底：
        - batch_queue 已注入：按实际状态判断
        - batch_queue 未注入但启动超过 60 秒：认为不会有 batch_queue，放行
        - batch_queue 未注入且启动未超 60 秒：保守 gating
        """
        if self._batch_queue is None:
            # 超过 60 秒还没注入，认为不会有 batch_queue（单文档/普通上传场景）
            import time as _time
            if _time.time() - self._started_at > 60:
                return True
            return False  # 启动窗口期内保守 gating
        try:
            stats = self._batch_queue.get_stats()
            pending = stats.get("pending", 0)
            processing = stats.get("processing", 0)
            return pending == 0 and processing == 0
        except Exception as e:
            log.warning("[TAG] batch_queue 状态查询失败: %s", str(e)[:80])
            return False  # P6 修复：失败时保守 gating

    def enqueue(self, doc_id: str):
        """文档上传后调用，加入打标队列"""
        with self._lock:
            if doc_id not in self._queue:
                self._queue.append(doc_id)
                log.info("[TAG] 入队: doc_id=%s, 队列长度=%d", doc_id, len(self._queue))
        self._has_work.set()

    def _worker(self):
        """后台线程：循环取任务 → 调用本地 LLM 打标 → 写回 KB 元数据

        Patch5 G：增加 gating — batch_queue 不空闲时不取任务，避免 GPU 抢占
        """
        log.info("[TAG] Worker 线程已启动（gating=%s）", "on" if self._batch_queue else "off")
        while self._running:
            # 等待工作信号
            self._has_work.wait(timeout=5.0)
            if not self._running:
                break
            self._has_work.clear()

            # Patch5 G：把 pending_ready 中 batch 已空闲的迁到 queue
            self._promote_pending_if_idle()

            while True:
                # Patch5 G：gating — batch 不空闲就跳出，等下一轮
                if not self._is_batch_idle():
                    log.debug("[TAG] batch 未空闲，暂停打标，等 10s 后重试")
                    break

                # 取一个任务
                with self._lock:
                    if not self._queue:
                        break
                    doc_id = self._queue.pop(0)

                try:
                    self._process_one(doc_id)
                except Exception as e:
                    log.error("[TAG] 打标失败: doc_id=%s, error=%s", doc_id, str(e)[:200])

                # 每处理完一个再 check gating
                if not self._is_batch_idle():
                    log.debug("[TAG] 处理完一个文档后 batch 仍忙，暂停等 10s")
                    break

        log.info("[TAG] Worker 线程已退出")

    def _promote_pending_if_idle(self):
        """如果 batch 已空闲，把 pending_ready 中的 doc_id 提升到 queue"""
        if not self._pending_ready:
            return
        if not self._is_batch_idle():
            return  # batch 还忙，先不动
        with self._lock:
            to_promote = list(self._pending_ready)
            self._pending_ready.clear()
        for doc_id in to_promote:
            # 复用 enqueue 逻辑
            self.enqueue(doc_id)
            log.info("[TAG] pending→queue: %s（batch 空闲）", doc_id)

    def _process_one(self, doc_id: str):
        """处理单个文档的打标任务，失败自动重入队"""
        kb = self._kb
        mgr = self._mgr

        # 1. 获取文档
        doc = kb.get_document(doc_id)
        if not doc:
            log.warning("[TAG] 文档不存在: %s", doc_id)
            return

        # 只处理 ready 状态的文档
        if doc.status != "ready":
            log.warning("[TAG] 文档状态非 ready: %s (status=%s)", doc_id, doc.status)
            return

        # 2. 获取文档内容
        chunks_text = []
        for chunk in kb.chunks.values():
            if chunk.doc_id == doc_id and chunk.text:
                chunks_text.append(chunk.text)
        full_text = "\n".join(chunks_text)
        if not full_text.strip():
            log.warning("[TAG] 文档内容为空: %s", doc_id)
            return

        # 3. 截断策略
        if len(full_text) <= 3000:
            content = full_text
        else:
            from knowledge.tags import extract_title_and_first_paragraphs
            content = extract_title_and_first_paragraphs(full_text, max_chars=3000)

        title = doc.filename or "未命名文档"

        # 4. 拼接 prompt
        from prompts import TAGGING_PROMPT
        prompt = TAGGING_PROMPT.format(title=title, content=content)

        # 5. 标记为 generating 状态（前端可见进度）
        doc.tag_status = "generating"
        kb._save_meta()
        log.info("[TAG] 开始打标: doc_id=%s, filename=%s, content_len=%d",
                 doc_id, doc.filename, len(content))
        try:
            from core.generate_queue import GenerateQueue
            response_parts = []
            se = mgr._stream_engine
            for chunk_type, chunk_text in se.run(
                message=prompt,
                model=None,  # 默认本地 LLM
                max_tokens=400,
                history=[],
                context_cache=None,
                override_task_type="text",
                kb_mode=False,
                _priority=GenerateQueue.LOW,  # P2 后台任务
            ):
                if chunk_type in ("text", "raw"):
                    response_parts.append(chunk_text)
            response = "".join(response_parts).strip()
        except Exception as e:
            log.error("[TAG] LLM 调用失败: doc_id=%s, error=%s", doc_id, str(e)[:200])
            self._re_enqueue(doc_id, "LLM调用失败")
            return

        if not response:
            log.warning("[TAG] LLM 返回为空: doc_id=%s", doc_id)
            self._re_enqueue(doc_id, "LLM返回为空")
            return

        # 6. 解析输出
        tags = []
        summary = ""
        category = ""
        try:
            tags, summary, category = self._parse_tagging_response(response)
        except Exception as e:
            log.warning("[TAG] 解析失败: doc_id=%s, response=%s, error=%s",
                        doc_id, response[:200], str(e)[:100])
            self._re_enqueue(doc_id, "解析失败")
            return  # 避免同时触发"解析结果为空"重入队

        # 7. 更新文档元数据
        if tags or summary or category:
            from knowledge.tags import normalize_tag
            doc.tags = [normalize_tag(t) for t in tags if t.strip()]
            if summary:
                doc.summary = summary
            # P6: 保存主题分类（一个文档一个分类，用于侧栏分组）
            if category:
                doc.category = category
            doc.tag_status = "done"
            kb._save_meta()
            log.info("[TAG] 打标完成: doc_id=%s, category=%s, tags=%s, summary=%s",
                     doc_id, category, doc.tags, doc.summary[:80])
        else:
            log.warning("[TAG] 解析结果为空，跳过: doc_id=%s", doc_id)
            self._re_enqueue(doc_id, "解析结果为空")

    def _re_enqueue(self, doc_id: str, reason: str):
        """打标失败后延迟重入队（最多重试 3 次）"""
        doc = self._kb.get_document(doc_id)
        if not doc:
            return
        retry_count = getattr(doc, '_tag_retry_count', 0) + 1
        doc._tag_retry_count = retry_count
        if retry_count > 3:
            log.warning("[TAG] 已达最大重试次数(%d)，放弃打标: doc_id=%s, reason=%s",
                        retry_count, doc_id, reason)
            doc.tag_status = "failed"
            self._kb._save_meta()
            return
        log.info("[TAG] 重入队(%d/3): doc_id=%s, reason=%s", retry_count, doc_id, reason)
        with self._lock:
            if doc_id not in self._queue:
                self._queue.append(doc_id)
        self._has_work.set()

    @staticmethod
    def _parse_tagging_response(response: str):
        """解析 LLM 打标输出

        Returns:
            (tags: list, summary: str, category: str)
            P6: 新增 category 字段（文档级单一主题分类）
        """
        tags = []
        summary = ""
        category = ""

        # 按行解析
        for line in response.split('\n'):
            line = line.strip()
            if not line:
                continue

            # P6: 匹配主题行（新增）
            cat_match = re.match(r'主题[：:]\s*(.+)', line)
            if cat_match:
                category = cat_match.group(1).strip()
                continue

            # 匹配标签行
            tag_match = re.match(r'标签[：:]\s*(.+)', line)
            if tag_match:
                tag_str = tag_match.group(1)
                tags = [t.strip() for t in re.split(r'[，,、\s]+', tag_str) if t.strip()]
                continue

            # 匹配摘要行
            summary_match = re.match(r'摘要[：:]\s*(.+)', line)
            if summary_match:
                summary = summary_match.group(1).strip()
                continue

        return tags, summary, category

    def start(self):
        """启动后台 worker 线程"""
        self._running = True
        self._thread = threading.Thread(target=self._worker, daemon=True)
        self._thread.start()
        log.info("[TAG] TaggingScheduler 已启动")

    def stop(self):
        """停止 worker（设标志位，等待线程结束）"""
        self._running = False
        self._has_work.set()  # 唤醒线程
        if self._thread and self._thread.is_alive():
            self._thread.join(timeout=10)
        log.info("[TAG] TaggingScheduler 已停止")

    def get_status(self, doc_id: str) -> str:
        """返回打标状态

        Returns:
            'pending' / 'done' / 'not_found'
        """
        with self._lock:
            if doc_id in self._queue:
                return "pending"

        doc = self._kb.get_document(doc_id)
        if not doc:
            return "not_found"
        return doc.tag_status
