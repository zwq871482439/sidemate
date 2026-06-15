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

    def enqueue(self, doc_id: str):
        """文档上传后调用，加入打标队列"""
        with self._lock:
            if doc_id not in self._queue:
                self._queue.append(doc_id)
                log.info("[TAG] 入队: doc_id=%s, 队列长度=%d", doc_id, len(self._queue))
        self._has_work.set()

    def _worker(self):
        """后台线程：循环取任务 → 调用本地 LLM 打标 → 写回 KB 元数据"""
        log.info("[TAG] Worker 线程已启动")
        while self._running:
            # 等待工作信号
            self._has_work.wait(timeout=5.0)
            if not self._running:
                break
            self._has_work.clear()

            while True:
                # 取一个任务
                with self._lock:
                    if not self._queue:
                        break
                    doc_id = self._queue.pop(0)

                try:
                    self._process_one(doc_id)
                except Exception as e:
                    log.error("[TAG] 打标失败: doc_id=%s, error=%s", doc_id, str(e)[:200])

        log.info("[TAG] Worker 线程已退出")

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
        try:
            tags, summary = self._parse_tagging_response(response)
        except Exception as e:
            log.warning("[TAG] 解析失败: doc_id=%s, response=%s, error=%s",
                        doc_id, response[:200], str(e)[:100])
            self._re_enqueue(doc_id, "解析失败")
            return  # 避免同时触发"解析结果为空"重入队

        # 7. 更新文档元数据
        if tags or summary:
            from knowledge.tags import normalize_tag
            doc.tags = [normalize_tag(t) for t in tags if t.strip()]
            if summary:
                doc.summary = summary
            doc.tag_status = "done"
            kb._save_meta()
            log.info("[TAG] 打标完成: doc_id=%s, tags=%s, summary=%s",
                     doc_id, doc.tags, doc.summary[:80])
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
            (tags: list, summary: str)
        """
        tags = []
        summary = ""

        # 按行解析
        for line in response.split('\n'):
            line = line.strip()
            if not line:
                continue

            # 匹配标签行
            tag_match = re.match(r'标签[：:]\s*(.+)', line)
            if tag_match:
                tag_str = tag_match.group(1)
                # 兼容中英文逗号、顿号分隔
                tags = [t.strip() for t in re.split(r'[，,、]', tag_str) if t.strip()]
                continue

            # 匹配摘要行
            summary_match = re.match(r'摘要[：:]\s*(.+)', line)
            if summary_match:
                summary = summary_match.group(1).strip()
                continue

        return tags, summary

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
