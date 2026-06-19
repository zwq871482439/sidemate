# -*- coding: utf-8 -*-
"""
core/batch_queue.py — SQLite 持久化任务队列 + 断点恢复（Patch5 T02）
====================================================================

解决批量文件导入的可靠性问题：
  - 每个文件是一个 TaskItem，持久化到 SQLite
  - 进程中断后重启可断点恢复（processing → pending）
  - worker 线程在线程池中运行，不阻塞 FastAPI 事件循环

SQLite 表结构：
  - batch: 批次表（一次批量上传对应一个 batch_id）
  - batch_task: 任务表（每个文件一条记录）

状态机：pending → processing → done/error/cancelled
重启恢复：processing → pending（lifespan startup 自动执行）

用法：
    from core.batch_queue import BatchQueue
    bq = BatchQueue(db_path="data/batch_queue.db")
    batch_id = bq.create_batch("batch_001")
    for f in files:
        bq.enqueue(batch_id, f.path, f.filename, f.type, f.size)
    bq.start_worker(kb_instance)
"""
import os
import json
import uuid
import time
import sqlite3
import logging
import threading
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Callable

log = logging.getLogger(__name__)


@dataclass
class TaskItem:
    """队列任务项

    Attributes:
        task_id: 任务 UUID
        batch_id: 所属批次 ID
        file_path: 临时文件路径
        filename: 原始文件名
        file_type: 文件扩展名
        file_size: 文件大小（字节）
        status: 任务状态 pending/processing/done/error/cancelled
        doc_id: 处理完成后关联的文档 ID
        error_msg: 错误信息
        created_at: 创建时间
        updated_at: 更新时间
        doc_meta: JSON 文档元数据
    """
    task_id: str
    batch_id: str
    file_path: str
    filename: str
    file_type: str
    file_size: int = 0
    status: str = "pending"
    doc_id: str = ""
    error_msg: str = ""
    created_at: str = ""
    updated_at: str = ""
    doc_meta: str = "{}"


# 支持的文件扩展名（与 kb.py upload 端点保持一致）
# B2: 新增 epub/html/srt/rtf 四种格式
_SUPPORTED_EXTENSIONS = frozenset({"txt", "md", "csv", "docx", "xlsx", "pdf", "epub", "html", "htm", "srt", "rtf"})


class BatchQueue:
    """SQLite 持久化任务队列 + worker 消费循环

    SQLite 使用 WAL 模式（Write-Ahead Logging），支持并发读写。
    worker 在 T01 的 ThreadPoolManager 中运行，不阻塞事件循环。
    """

    def __init__(self, db_path: str = None, data_dir: str = None):
        """初始化任务队列

        Args:
            db_path: SQLite 数据库路径，None 则自动解析
            data_dir: 数据根目录（用于自动解析 db_path）
        """
        # 解析数据库路径
        if db_path:
            self.db_path = db_path
        else:
            _dir = data_dir or os.path.join(os.path.dirname(__file__), "..", "data")
            _dir = os.path.abspath(_dir)
            self.db_path = os.path.join(_dir, "batch_queue.db")

        # 确保目录存在
        os.makedirs(os.path.dirname(self.db_path), exist_ok=True)

        # SQLite 连接（线程局部）
        self._local = threading.local()
        self._init_lock = threading.Lock()
        self._initialized = False

        # worker 控制
        self._worker_thread: Optional[threading.Thread] = None
        self._worker_stop = threading.Event()
        self._kb_instance = None  # KnowledgeBase 引用

        # 初始化数据库
        self._init_db()

    # ===== SQLite 连接管理 =====

    def _get_conn(self) -> sqlite3.Connection:
        """获取当前线程的 SQLite 连接（线程局部）

        SQLite 连接不能跨线程共享，每个线程需要独立连接。
        """
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.db_path, timeout=30, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            # WAL 模式：支持并发读写
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            self._local.conn = conn
        return conn

    def _init_db(self) -> None:
        """初始化数据库表结构"""
        with self._init_lock:
            if self._initialized:
                return
            conn = self._get_conn()
            try:
                conn.executescript("""
                    -- 批次表
                    CREATE TABLE IF NOT EXISTS batch (
                        batch_id    TEXT PRIMARY KEY,
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        total_files INTEGER NOT NULL DEFAULT 0,
                        status      TEXT NOT NULL DEFAULT 'active'
                    );

                    -- 任务表（每个文件一条记录）
                    CREATE TABLE IF NOT EXISTS batch_task (
                        task_id     TEXT PRIMARY KEY,
                        batch_id    TEXT NOT NULL,
                        file_path   TEXT NOT NULL,
                        filename    TEXT NOT NULL,
                        file_type   TEXT NOT NULL,
                        file_size   INTEGER DEFAULT 0,
                        status      TEXT NOT NULL DEFAULT 'pending',
                        doc_id      TEXT DEFAULT '',
                        error_msg   TEXT DEFAULT '',
                        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
                        doc_meta    TEXT DEFAULT '{}',
                        FOREIGN KEY (batch_id) REFERENCES batch(batch_id)
                    );

                    -- 索引：按 batch_id + status 查询（进度统计用）
                    CREATE INDEX IF NOT EXISTS idx_batch_status ON batch_task(batch_id, status);
                    -- 索引：启动恢复用（查所有 pending/processing）
                    CREATE INDEX IF NOT EXISTS idx_status ON batch_task(status);
                """)
                conn.commit()
                self._initialized = True
                log.info("[BATCH_QUEUE] 数据库初始化完成: %s", self.db_path)
            except Exception as e:
                log.error("[BATCH_QUEUE] 数据库初始化失败: %s", str(e))
                raise

    # ===== 批次管理 =====

    def create_batch(self, batch_id: str = None, total_files: int = 0) -> str:
        """创建新批次

        Args:
            batch_id: 自定义批次 ID，None 则自动生成
            total_files: 批次文件总数

        Returns:
            batch_id 字符串
        """
        if batch_id is None:
            batch_id = "b_%s_%s" % (
                time.strftime("%Y%m%d"),
                uuid.uuid4().hex[:8]
            )
        conn = self._get_conn()
        try:
            conn.execute(
                "INSERT INTO batch (batch_id, total_files, status) VALUES (?, ?, 'active')",
                (batch_id, total_files)
            )
            conn.commit()
            log.info("[BATCH_QUEUE] 创建批次: %s, total_files=%d", batch_id, total_files)
            return batch_id
        except Exception as e:
            log.error("[BATCH_QUEUE] 创建批次失败: %s", str(e))
            raise

    def enqueue(self, batch_id: str, file_path: str, filename: str,
                file_type: str, file_size: int = 0,
                doc_meta: Dict = None) -> str:
        """入队一个文件任务

        Args:
            batch_id: 批次 ID
            file_path: 临时文件路径
            filename: 原始文件名
            file_type: 文件扩展名
            file_size: 文件大小
            doc_meta: 文档元数据字典

        Returns:
            task_id 字符串
        """
        task_id = "t_%s" % uuid.uuid4().hex[:12]
        meta_json = json.dumps(doc_meta or {}, ensure_ascii=False)
        conn = self._get_conn()
        try:
            conn.execute(
                """INSERT INTO batch_task
                   (task_id, batch_id, file_path, filename, file_type, file_size, status, doc_meta)
                   VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)""",
                (task_id, batch_id, file_path, filename, file_type, file_size, meta_json)
            )
            conn.commit()
            return task_id
        except Exception as e:
            log.error("[BATCH_QUEUE] 入队失败: %s (batch=%s, file=%s)", str(e), batch_id, filename)
            raise

    def get_pending(self) -> Optional[TaskItem]:
        """原子地获取一个 pending 任务并标记为 processing

        使用 SELECT + UPDATE 原子操作（SQLite 事务内完成）。
        多个 worker 线程不会抢到同一个任务。

        Returns:
            TaskItem 或 None（无 pending 任务时）
        """
        conn = self._get_conn()
        try:
            # 原子操作：查一个 pending → 标记为 processing
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM batch_task WHERE status='pending' ORDER BY created_at LIMIT 1"
            ).fetchone()
            if row is None:
                conn.rollback()
                return None
            # 标记为 processing
            conn.execute(
                "UPDATE batch_task SET status='processing', updated_at=datetime('now') WHERE task_id=?",
                (row["task_id"],)
            )
            conn.commit()
            return self._row_to_taskitem(row)
        except Exception as e:
            conn.rollback()
            log.error("[BATCH_QUEUE] get_pending 失败: %s", str(e))
            return None

    def update_status(self, task_id: str, status: str, error_msg: str = "",
                      doc_id: str = "", doc_meta: Dict = None) -> None:
        """更新任务状态

        Args:
            task_id: 任务 ID
            status: 新状态 done/error/cancelled
            error_msg: 错误信息
            doc_id: 关联的文档 ID（done 时设置）
            doc_meta: 更新的文档元数据
        """
        conn = self._get_conn()
        meta_clause = ""
        params = [status, error_msg, doc_id]
        if doc_meta is not None:
            meta_clause = ", doc_meta=?"
            params.append(json.dumps(doc_meta, ensure_ascii=False))
        params.append(task_id)
        try:
            conn.execute(
                "UPDATE batch_task SET status=?, error_msg=?, doc_id=?, updated_at=datetime('now')%s WHERE task_id=?" % meta_clause,
                params
            )
            conn.commit()
        except Exception as e:
            log.error("[BATCH_QUEUE] 更新状态失败: %s (task=%s)", str(e), task_id)

    def get_batch_progress(self, batch_id: str) -> Dict[str, Any]:
        """获取批次进度

        Args:
            batch_id: 批次 ID

        Returns:
            进度字典 {batch_id, total, done, processing, pending, error, status, tasks}
        """
        conn = self._get_conn()
        try:
            # 批次信息
            batch_row = conn.execute(
                "SELECT * FROM batch WHERE batch_id=?", (batch_id,)
            ).fetchone()

            if batch_row is None:
                return {"error": "批次不存在", "batch_id": batch_id}

            # 按状态统计
            status_rows = conn.execute(
                "SELECT status, COUNT(*) as cnt FROM batch_task WHERE batch_id=? GROUP BY status",
                (batch_id,)
            ).fetchall()
            status_counts = {r["status"]: r["cnt"] for r in status_rows}

            total = sum(status_counts.values())
            done = status_counts.get("done", 0)
            processing = status_counts.get("processing", 0)
            pending = status_counts.get("pending", 0)
            error = status_counts.get("error", 0)
            cancelled = status_counts.get("cancelled", 0)

            # 任务详情
            task_rows = conn.execute(
                "SELECT task_id, filename, status, doc_id, error_msg FROM batch_task WHERE batch_id=? ORDER BY created_at",
                (batch_id,)
            ).fetchall()
            tasks = []
            for r in task_rows:
                tasks.append({
                    "task_id": r["task_id"],
                    "filename": r["filename"],
                    "status": r["status"],
                    "doc_id": r["doc_id"] or "",
                    "error_msg": r["error_msg"] or "",
                })

            return {
                "batch_id": batch_id,
                "total": total,
                "done": done,
                "processing": processing,
                "pending": pending,
                "error": error,
                "cancelled": cancelled,
                "status": batch_row["status"],
                "tasks": tasks,
            }
        except Exception as e:
            log.error("[BATCH_QUEUE] 获取进度失败: %s (batch=%s)", str(e), batch_id)
            return {"error": str(e), "batch_id": batch_id}

    def cancel_batch(self, batch_id: str) -> int:
        """取消批次中所有 pending 任务

        Args:
            batch_id: 批次 ID

        Returns:
            取消的任务数量
        """
        conn = self._get_conn()
        try:
            cursor = conn.execute(
                "UPDATE batch_task SET status='cancelled', updated_at=datetime('now') "
                "WHERE batch_id=? AND status='pending'",
                (batch_id,)
            )
            cancelled_count = cursor.rowcount
            conn.commit()
            # 如果批次没有 pending+processing 任务了，标记为 completed
            remaining = conn.execute(
                "SELECT COUNT(*) as cnt FROM batch_task WHERE batch_id=? AND status IN ('pending','processing')",
                (batch_id,)
            ).fetchone()
            if remaining["cnt"] == 0:
                conn.execute(
                    "UPDATE batch SET status='completed' WHERE batch_id=?", (batch_id,)
                )
                conn.commit()
            log.info("[BATCH_QUEUE] 取消批次 %s 的 %d 个 pending 任务", batch_id, cancelled_count)
            return cancelled_count
        except Exception as e:
            log.error("[BATCH_QUEUE] 取消批次失败: %s (batch=%s)", str(e), batch_id)
            return 0

    def get_active_batches(self) -> List[Dict]:
        """获取所有活跃批次列表

        Returns:
            批次进度列表
        """
        conn = self._get_conn()
        try:
            batch_rows = conn.execute(
                "SELECT batch_id FROM batch WHERE status='active' ORDER BY created_at DESC"
            ).fetchall()
            result = []
            for row in batch_rows:
                progress = self.get_batch_progress(row["batch_id"])
                # QA BUG#1: progress 总是含 'error' 键（整数失败计数，0 表示无错误）
                # 只有真正失败（批次不存在）时 error 值才是字符串。用 isinstance 排除字符串错误。
                if not isinstance(progress.get("error"), str):
                    result.append(progress)
            return result
        except Exception as e:
            log.error("[BATCH_QUEUE] 获取活跃批次失败: %s", str(e))
            return []

    # ===== 断点恢复 =====

    def recover_pending(self) -> int:
        """断点恢复：将所有 processing 状态的任务重置为 pending

        在 server.py lifespan startup 中调用。
        上次进程中断时，正在 processing 的任务会卡住，需要重置。

        Returns:
            重置的任务数量
        """
        conn = self._get_conn()
        try:
            cursor = conn.execute(
                "UPDATE batch_task SET status='pending', updated_at=datetime('now') "
                "WHERE status='processing'"
            )
            count = cursor.rowcount
            conn.commit()
            if count > 0:
                log.info("[BATCH_QUEUE] 断点恢复: %d 个 processing → pending", count)
            return count
        except Exception as e:
            log.error("[BATCH_QUEUE] 断点恢复失败: %s", str(e))
            return 0

    # ===== Worker 消费循环 =====

    def start_worker(self, kb_instance) -> None:
        """启动 worker 消费循环（在独立线程中运行）

        worker 内部使用 ThreadPoolManager.submit() 提交每个文件的处理任务，
        避免直接在事件循环中阻塞。

        Args:
            kb_instance: KnowledgeBase 实例
        """
        self._kb_instance = kb_instance
        self._worker_stop.clear()

        if self._worker_thread is not None and self._worker_thread.is_alive():
            log.warning("[BATCH_QUEUE] worker 已在运行")
            return

        self._worker_thread = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker_thread.start()
        log.info("[BATCH_QUEUE] worker 线程已启动")

    def stop_worker(self, timeout: float = 5.0) -> None:
        """优雅停止 worker

        Args:
            timeout: 等待超时时间（秒）
        """
        self._worker_stop.set()
        if self._worker_thread is not None and self._worker_thread.is_alive():
            self._worker_thread.join(timeout=timeout)
            log.info("[BATCH_QUEUE] worker 线程已停止")
        self._worker_thread = None

    def _worker_loop(self) -> None:
        """worker 消费循环：不断从队列取 pending 任务，在线程池中处理

        循环退出条件：
          1. _worker_stop 被设置（stop_worker 调用）
          2. 主线程退出（daemon 线程自动终止）
        """
        try:
            from config import get as _cfg
            poll_interval = _cfg("batch_queue_poll_interval", 1.0)
        except Exception:
            poll_interval = 1.0

        log.info("[BATCH_QUEUE] worker 循环开始, poll_interval=%.1fs", poll_interval)

        while not self._worker_stop.is_set():
            try:
                task = self.get_pending()
                if task is None:
                    # 无任务，等待轮询间隔
                    self._worker_stop.wait(timeout=poll_interval)
                    continue

                # 在当前线程中直接处理（worker 本身就是独立线程）
                # 使用线程池 submit 后同步等待，确保不超出 max_workers
                self._process_task(task)

            except Exception as e:
                log.error("[BATCH_QUEUE] worker 循环异常: %s", str(e)[:200])
                self._worker_stop.wait(timeout=poll_interval)

        log.info("[BATCH_QUEUE] worker 循环结束")

    def _process_task(self, task: TaskItem) -> None:
        """处理单个文件任务

        步骤：
          1. 从临时文件路径读取文件
          2. 根据扩展名提取文本
          3. 调用 kb.import_document() 创建文档记录
          4. 调用 kb.process_document() 分块 + 嵌入
          5. 更新任务状态

        Args:
            task: 任务项
        """
        kb = self._kb_instance
        if kb is None:
            log.error("[BATCH_QUEUE] KnowledgeBase 实例未设置，无法处理任务")
            self.update_status(task.task_id, "error", error_msg="KB实例未初始化")
            return

        log.info("[BATCH_QUEUE] 开始处理: %s (task=%s)", task.filename, task.task_id)

        try:
            # 检查文件是否存在
            if not os.path.exists(task.file_path):
                self.update_status(task.task_id, "error",
                                   error_msg="文件不存在: %s" % task.file_path)
                return

            # 检查文档数上限
            stats = kb.get_stats()
            if stats["ready_documents"] + stats["processing_documents"] >= stats["max_documents"]:
                self.update_status(task.task_id, "error",
                                   error_msg="文库已满（最多%d个文档）" % stats["max_documents"])
                return

            # 提取文本（复用 kb.py 的文件解析逻辑）
            text = _extract_file_text(task.file_path, task.file_type)
            if not text or not text.strip():
                self.update_status(task.task_id, "error",
                                   error_msg="文件内容为空或无法提取文字")
                return

            # 导入文档
            doc_meta = json.loads(task.doc_meta) if task.doc_meta else {}
            result = kb.import_document(
                task.filename, text,
                file_type=task.file_type,
                metadata=doc_meta
            )
            if "error" in result:
                self.update_status(task.task_id, "error",
                                   error_msg=result["error"])
                return

            doc_id = result["doc_id"]

            # 处理文档（分块 + 嵌入）— 同步调用，因为 worker 本身就是独立线程
            kb.process_document(doc_id, text)

            # 文档处理完成后 enqueue 打标
            scheduler = getattr(kb, '_tagging_scheduler', None)
            if scheduler:
                try:
                    scheduler.enqueue(doc_id)
                except Exception as e:
                    log.warning("[BATCH_QUEUE] 打标入队失败: %s", str(e)[:80])

            self.update_status(task.task_id, "done", doc_id=doc_id)
            log.info("[BATCH_QUEUE] 处理完成: %s (task=%s, doc=%s)",
                     task.filename, task.task_id, doc_id)

        except Exception as e:
            log.error("[BATCH_QUEUE] 处理失败: %s (task=%s, file=%s): %s",
                      task.filename, task.task_id, task.file_path, str(e)[:200])
            self.update_status(task.task_id, "error", error_msg=str(e)[:200])

            # 标记文档为 error 状态（如果已创建）
            try:
                if 'doc_id' in locals() and doc_id:
                    doc = kb.get_document(doc_id)
                    if doc and doc.status == "processing":
                        doc.status = "error"
                        doc.error_msg = str(e)[:200]
                        kb._save_meta()
            except Exception:
                pass

        finally:
            # 清理临时文件
            try:
                _tmp_dir = os.path.dirname(task.file_path)
                if _tmp_dir and os.path.isdir(_tmp_dir) and "kb_upload" in _tmp_dir:
                    import shutil
                    shutil.rmtree(_tmp_dir, ignore_errors=True)
            except Exception:
                pass

    @staticmethod
    def _row_to_taskitem(row: sqlite3.Row) -> TaskItem:
        """将 SQLite Row 转换为 TaskItem"""
        return TaskItem(
            task_id=row["task_id"],
            batch_id=row["batch_id"],
            file_path=row["file_path"],
            filename=row["filename"],
            file_type=row["file_type"],
            file_size=row["file_size"],
            status="processing",  # get_pending 已标记为 processing
            doc_id=row["doc_id"] or "",
            error_msg=row["error_msg"] or "",
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            doc_meta=row["doc_meta"] or "{}",
        )


# ===== 辅助函数 =====

def _extract_file_text(file_path: str, file_type: str) -> str:
    """从文件中提取文本（复用 kb.py 的解析逻辑）

    支持：txt/md/csv, docx, xlsx, pdf

    Args:
        file_path: 文件路径
        file_type: 文件扩展名（小写，不含点）

    Returns:
        提取的文本内容，失败返回空字符串
    """
    try:
        if file_type in ("txt", "md", "csv"):
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                return f.read()

        elif file_type == "docx":
            from knowledge.doc_reader import DocReader
            reader = DocReader()
            return reader.extract_text(file_path) or ""

        elif file_type == "xlsx":
            import io
            import openpyxl
            text = ""
            with open(file_path, "rb") as f:
                content = f.read()
            wb = openpyxl.load_workbook(io.BytesIO(content), read_only=True, data_only=True)
            for ws in wb.worksheets:
                text += "## Sheet: " + (ws.title or "Sheet") + "\n"
                for row in ws.iter_rows(max_row=200, values_only=True):
                    cells = [str(c) if c is not None else "" for c in row]
                    if any(cells):
                        text += " | ".join(cells) + "\n"
                text += "\n"
            wb.close()
            return text

        elif file_type == "pdf":
            text = ""
            try:
                import pdfplumber
                with pdfplumber.open(file_path) as pdf:
                    for i, page in enumerate(pdf.pages[:100]):
                        page_text = page.extract_text() or ""
                        if page_text:
                            text += page_text + "\n"
                        tables = page.extract_tables()
                        for table in tables:
                            for row in table:
                                cells = [str(c) if c else "" for c in row]
                                if any(cells):
                                    text += " | ".join(cells) + "\n"
                            text += "\n"
                        if page_text or tables:
                            text += "\n"
            except ImportError:
                from pypdf import PdfReader
                pdf = PdfReader(file_path)
                for page in pdf.pages[:100]:
                    page_text = page.extract_text()
                    if page_text:
                        text += page_text + "\n\n"
            return text

        elif file_type == "epub":
            # B2: EPUB 电子书解析（委托给 file_extractor 统一逻辑）
            try:
                from knowledge.file_extractor import extract_text
                return extract_text(file_path)
            except Exception as e:
                log.error("[BATCH_QUEUE] EPUB 解析失败: %s", str(e)[:200])
                return ""

        elif file_type in ("html", "htm"):
            # B2: HTML 网页文件解析（委托给 file_extractor 统一逻辑）
            try:
                from knowledge.file_extractor import extract_text
                return extract_text(file_path)
            except Exception as e:
                log.error("[BATCH_QUEUE] HTML 解析失败: %s", str(e)[:200])
                return ""

        elif file_type == "srt":
            # B2: SRT 字幕文件解析（委托给 file_extractor 统一逻辑）
            try:
                from knowledge.file_extractor import extract_text
                return extract_text(file_path)
            except Exception as e:
                log.error("[BATCH_QUEUE] SRT 解析失败: %s", str(e)[:200])
                return ""

        elif file_type == "rtf":
            # B2: RTF 富文本解析（委托给 file_extractor 统一逻辑）
            try:
                from knowledge.file_extractor import extract_text
                return extract_text(file_path)
            except Exception as e:
                log.error("[BATCH_QUEUE] RTF 解析失败: %s", str(e)[:200])
                return ""

        else:
            log.warning("[BATCH_QUEUE] 不支持的文件格式: .%s", file_type)
            return ""

    except Exception as e:
        log.error("[BATCH_QUEUE] 文件解析失败 (%s): %s", file_type, str(e)[:200])
        return ""
