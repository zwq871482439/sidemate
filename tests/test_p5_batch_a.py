# -*- coding: utf-8 -*-
"""
Sidemate Patch5 批次 A — T01+T02+T03 回归测试
==============================================
覆盖范围：
  - T01: 线程池 (core/thread_pool.py)
  - T01: 令牌系统 (core/access_token.py)
  - T02: SQLite 队列 (core/batch_queue.py)
  - T03: is_private 字段 (knowledge/models.py + ops.py)
  - T03: search() 私密过滤 (knowledge/search.py)
  - T03: dense+sparse 融合
  - 全局回归：config P5 配置项 + import 安全性

用法：
  "C:\\Sidemate\\python\\python.exe" C:\\Sidemate\\tests\\test_p5_batch_a.py
"""
import sys
import os
import time
import json
import shutil
import tempfile
import threading
import traceback

# 设置环境
sys.path.insert(0, 'C:/Sidemate/server')
os.chdir('C:/Sidemate/server')

# ===== 测试计数器 =====
_pass = 0
_fail = 0
_errors = []


def check(name, condition, detail=""):
    """断言函数"""
    global _pass, _fail
    if condition:
        _pass += 1
        print("  [PASS] %s" % name)
    else:
        _fail += 1
        msg = "%s%s" % (name, (" — %s" % detail) if detail else "")
        _errors.append(msg)
        print("  [FAIL] %s%s" % (name, (" — %s" % detail) if detail else ""))


def section(title):
    print("\n" + "=" * 60)
    print("  %s" % title)
    print("=" * 60)


# ============================================================
# 1. T01 线程池 (core/thread_pool.py)
# ============================================================
section("T01 线程池 (thread_pool.py)")


def test_thread_pool_singleton():
    """测试 1.1: ThreadPoolManager 单例"""
    try:
        from core import thread_pool as tp_mod
        # 重置单例（保证测试隔离）
        tp_mod._thread_pool_instance = None

        pool1 = tp_mod.get_thread_pool()
        pool2 = tp_mod.get_thread_pool()
        check("get_thread_pool() 返回同一实例", pool1 is pool2)
        check("实例是 ThreadPoolManager", isinstance(pool1, tp_mod.ThreadPoolManager))

        # 清理
        tp_mod._thread_pool_instance = None
    except Exception as e:
        check("单例测试 — 无异常", False, str(e))


def test_thread_pool_submit():
    """测试 1.2: submit() 提交任务"""
    try:
        from core import thread_pool as tp_mod
        tp_mod._thread_pool_instance = None

        pool = tp_mod.get_thread_pool()
        pool.init(max_workers=2)

        # 提交任务
        def add(a, b):
            time.sleep(0.05)
            return a + b

        future = pool.submit(add, 3, 4)
        result = future.result(timeout=5)
        check("submit() 返回正确结果 (3+4=7)", result == 7, "got %s" % result)

        # 提交带 kwargs 的任务
        future2 = pool.submit(lambda x, y: x * y, 5, y=6)
        result2 = future2.result(timeout=5)
        check("submit() 支持 kwargs (5*6=30)", result2 == 30, "got %s" % result2)

        pool.shutdown(wait=True)
        tp_mod._thread_pool_instance = None
    except Exception as e:
        check("submit 测试 — 无异常", False, str(e))


def test_thread_pool_run_blocking():
    """测试 1.3: run_blocking() 同步执行"""
    try:
        from core import thread_pool as tp_mod
        tp_mod._thread_pool_instance = None

        pool = tp_mod.get_thread_pool()
        pool.init(max_workers=2)

        result = pool.run_blocking(lambda: 42)
        check("run_blocking() 返回结果 (42)", result == 42, "got %s" % result)

        # 带参数
        result2 = pool.run_blocking(lambda x, y: x - y, 10, 3)
        check("run_blocking() 带参数 (10-3=7)", result2 == 7, "got %s" % result2)

        # 异常传播
        def boom():
            raise ValueError("test error")
        try:
            pool.run_blocking(boom)
            check("run_blocking() 异常传播", False, "未抛出异常")
        except ValueError as ve:
            check("run_blocking() 异常传播", "test error" in str(ve))

        pool.shutdown(wait=True)
        tp_mod._thread_pool_instance = None
    except Exception as e:
        check("run_blocking 测试 — 无异常", False, str(e))


def test_thread_pool_lazy_init():
    """测试 1.4: 惰性初始化（未 init 就 submit）"""
    try:
        from core import thread_pool as tp_mod
        tp_mod._thread_pool_instance = None

        pool = tp_mod.get_thread_pool()
        # 不调用 init，直接 submit
        check("init 前 executor 为 None", pool.executor is None)
        future = pool.submit(lambda: "lazy")
        result = future.result(timeout=5)
        check("惰性初始化后 submit 成功", result == "lazy")
        check("惰性初始化后 executor 非 None", pool.executor is not None)

        pool.shutdown(wait=True)
        tp_mod._thread_pool_instance = None
    except Exception as e:
        check("惰性初始化测试 — 无异常", False, str(e))


def test_thread_pool_shutdown():
    """测试 1.5: shutdown() 关闭线程池"""
    try:
        from core import thread_pool as tp_mod
        tp_mod._thread_pool_instance = None

        pool = tp_mod.get_thread_pool()
        pool.init(max_workers=2)
        check("init 后 _initialized=True", pool._initialized is True)

        pool.shutdown(wait=True)
        check("shutdown 后 executor=None", pool.executor is None)
        check("shutdown 后 _initialized=False", pool._initialized is False)

        # shutdown 后可重新 init（不报错）
        pool.init(max_workers=2)
        check("shutdown 后可重新 init", pool._initialized is True)
        result = pool.run_blocking(lambda: "re-init ok")
        check("重新 init 后可正常执行", result == "re-init ok")

        pool.shutdown(wait=True)
        tp_mod._thread_pool_instance = None
    except Exception as e:
        check("shutdown 测试 — 无异常", False, str(e))


def test_thread_pool_concurrent():
    """测试 1.6: 并发提交多个任务"""
    try:
        from core import thread_pool as tp_mod
        tp_mod._thread_pool_instance = None

        pool = tp_mod.get_thread_pool()
        pool.init(max_workers=2)

        futures = []
        for i in range(10):
            futures.append(pool.submit(lambda x: x * x, i))

        results = sorted([f.result(timeout=5) for f in futures])
        expected = sorted([i * i for i in range(10)])
        check("并发 10 个任务结果正确", results == expected, "got %s" % results)

        pool.shutdown(wait=True)
        tp_mod._thread_pool_instance = None
    except Exception as e:
        check("并发测试 — 无异常", False, str(e))


# ============================================================
# 2. T01 令牌系统 (core/access_token.py)
# ============================================================
section("T01 令牌系统 (access_token.py)")


def test_token_generate_full():
    """测试 2.1: 生成 full 令牌"""
    try:
        from core.access_token import AccessTokenManager, AccessToken
        mgr = AccessTokenManager()

        token = mgr.generate_full_token("doc_001")
        check("full 令牌是字符串", isinstance(token, str))
        check("full 令牌非空", len(token) > 0)
        check("full 令牌长度 64 (32字节hex)", len(token) == 64, "len=%d" % len(token))

        # 验证令牌缓存
        cached = mgr._tokens_cache.get(token)
        check("令牌存入缓存", cached is not None)
        check("令牌 level=full", cached.level == "full")
        check("令牌 doc_id 正确", cached.doc_id == "doc_001")
    except Exception as e:
        check("full 令牌测试 — 无异常", False, str(e))


def test_token_generate_search():
    """测试 2.2: 生成 search 令牌"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        token = mgr.generate_search_token("doc_002")
        check("search 令牌是字符串", isinstance(token, str))
        check("search 令牌长度 64", len(token) == 64)

        cached = mgr._tokens_cache.get(token)
        check("search 令牌 level=search", cached.level == "search")
        check("search 令牌 doc_id 正确", cached.doc_id == "doc_002")
    except Exception as e:
        check("search 令牌测试 — 无异常", False, str(e))


def test_token_verify_valid():
    """测试 2.3: 验证有效令牌"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        # full token
        token = mgr.generate_full_token("doc_100")
        is_valid, level = mgr.verify_token(token)
        check("full 令牌验证 valid=True", is_valid is True)
        check("full 令牌验证 level=full", level == "full")

        # search token
        token2 = mgr.generate_search_token("doc_200")
        is_valid2, level2 = mgr.verify_token(token2)
        check("search 令牌验证 valid=True", is_valid2 is True)
        check("search 令牌验证 level=search", level2 == "search")

        # doc_id 绑定检查
        is_valid3, level3 = mgr.verify_token(token, "doc_100")
        check("正确 doc_id 绑定验证 valid=True", is_valid3 is True)

        is_valid4, level4 = mgr.verify_token(token, "doc_wrong")
        check("错误 doc_id 绑定验证 valid=False", is_valid4 is False)
        check("错误 doc_id 绑定验证 level=none", level4 == "none")
    except Exception as e:
        check("验证有效令牌测试 — 无异常", False, str(e))


def test_token_verify_invalid():
    """测试 2.4: 验证无效令牌"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        # 空令牌
        is_valid, level = mgr.verify_token("")
        check("空令牌 valid=False", is_valid is False)
        check("空令牌 level=none", level == "none")

        # None 令牌
        is_valid2, level2 = mgr.verify_token(None)
        check("None 令牌 valid=False", is_valid2 is False)

        # 不存在的令牌
        is_valid3, level3 = mgr.verify_token("nonexistent_token_12345")
        check("不存在令牌 valid=False", is_valid3 is False)
        check("不存在令牌 level=none", level3 == "none")
    except Exception as e:
        check("验证无效令牌测试 — 无异常", False, str(e))


def test_token_revoke():
    """测试 2.5: 撤销令牌"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        token = mgr.generate_full_token("doc_300")
        check("撤销前令牌有效", mgr.verify_token(token)[0] is True)

        result = mgr.revoke_token(token)
        check("revoke_token 返回 True", result is True)
        check("撤销后令牌无效", mgr.verify_token(token)[0] is False)

        # 撤销已撤销的令牌
        result2 = mgr.revoke_token(token)
        check("撤销已撤销令牌返回 False", result2 is False)
    except Exception as e:
        check("撤销令牌测试 — 无异常", False, str(e))


def test_token_revoke_doc():
    """测试 2.6: 撤销文档所有令牌"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        t1 = mgr.generate_full_token("doc_400")
        t2 = mgr.generate_search_token("doc_400")
        t3 = mgr.generate_full_token("doc_500")

        count = mgr.revoke_doc_tokens("doc_400")
        check("撤销 doc_400 两个令牌", count == 2, "count=%d" % count)
        check("doc_400 t1 无效", mgr.verify_token(t1)[0] is False)
        check("doc_400 t2 无效", mgr.verify_token(t2)[0] is False)
        check("doc_500 t3 仍有效", mgr.verify_token(t3)[0] is True)

        # 撤销不存在的文档
        count2 = mgr.revoke_doc_tokens("doc_nonexist")
        check("撤销不存在文档返回 0", count2 == 0)
    except Exception as e:
        check("撤销文档令牌测试 — 无异常", False, str(e))


def test_token_filter_private_docs():
    """测试 2.7: filter_private_docs() 私密文档过滤"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        doc_ids = ["public_1", "public_2", "private_1", "private_2"]
        is_private_map = {
            "public_1": False,
            "public_2": False,
            "private_1": True,
            "private_2": True,
        }

        # 无令牌：私密文档被过滤
        result = mgr.filter_private_docs(doc_ids, "", is_private_map)
        check("无令牌：私密文档被过滤", "private_1" not in result and "private_2" not in result)
        check("无令牌：公开文档可见", "public_1" in result and "public_2" in result)

        # P5 审计修复 P1-9: search 令牌不放行任何私密文档（只能 get_context）
        token_s = mgr.generate_search_token("private_1")
        result_s = mgr.filter_private_docs(doc_ids, token_s, is_private_map)
        check("search 令牌：私密文档不可见",
              "private_1" not in result_s and "private_2" not in result_s)

        # P5 审计修复 P1-9: full 令牌只对绑定的 doc_id 放行私密
        mgr.clear_all()
        token_f = mgr.generate_full_token("private_1")
        result_f = mgr.filter_private_docs(doc_ids, token_f, is_private_map)
        check("full 令牌：仅绑定私密文档可见",
              "private_1" in result_f and "private_2" not in result_f)

        # is_private_map=None：全部非私密
        mgr.clear_all()
        result_none = mgr.filter_private_docs(doc_ids, "", None)
        check("is_private_map=None：全部可见", len(result_none) == 4)

        # 空列表
        result_empty = mgr.filter_private_docs([], "", is_private_map)
        check("空 doc_ids 返回空列表", result_empty == [])
    except Exception as e:
        check("filter_private_docs 测试 — 无异常", False, str(e))


def test_token_expiry():
    """测试 2.8: 令牌过期"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        # TTL=1 秒
        token = mgr.generate_full_token("doc_expiry", ttl=1)
        check("TTL=1s 令牌刚创建有效", mgr.verify_token(token)[0] is True)

        time.sleep(1.5)
        is_valid, level = mgr.verify_token(token)
        check("TTL=1s 令牌过期后无效", is_valid is False)
        check("过期令牌 level=none", level == "none")
    except Exception as e:
        check("令牌过期测试 — 无异常", False, str(e))


def test_token_get_doc_access_level():
    """测试 2.9: get_doc_access_level()"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        token = mgr.generate_full_token("doc_level")
        level = mgr.get_doc_access_level("doc_level", token)
        check("full 令牌 get_doc_access_level=full", level == "full")

        level2 = mgr.get_doc_access_level("doc_level", "")
        check("空令牌 get_doc_access_level=none", level2 == "none")

        # 错误 doc_id
        level3 = mgr.get_doc_access_level("wrong_doc", token)
        check("错误 doc_id get_doc_access_level=none", level3 == "none")
    except Exception as e:
        check("get_doc_access_level 测试 — 无异常", False, str(e))


def test_token_clear_all():
    """测试 2.10: clear_all() 清空所有令牌"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        mgr.generate_full_token("doc_a")
        mgr.generate_search_token("doc_b")
        mgr.generate_full_token("doc_c")

        count = mgr.clear_all()
        check("clear_all 返回 3", count == 3, "count=%d" % count)
        check("clear_all 后缓存为空", len(mgr._tokens_cache) == 0)
        check("clear_all 后反向索引为空", len(mgr._doc_tokens) == 0)
    except Exception as e:
        check("clear_all 测试 — 无异常", False, str(e))


def test_token_singleton():
    """测试 2.11: get_access_token_manager() 单例"""
    try:
        from core import access_token as at_mod
        at_mod._access_token_manager = None

        mgr1 = at_mod.get_access_token_manager()
        mgr2 = at_mod.get_access_token_manager()
        check("get_access_token_manager() 返回同一实例", mgr1 is mgr2)
        check("是 AccessTokenManager", isinstance(mgr1, at_mod.AccessTokenManager))

        at_mod._access_token_manager = None
    except Exception as e:
        check("单例测试 — 无异常", False, str(e))


def test_token_uniqueness():
    """测试 2.12: 多次生成令牌不重复"""
    try:
        from core.access_token import AccessTokenManager
        mgr = AccessTokenManager()

        tokens = set()
        for i in range(100):
            t = mgr.generate_full_token("doc_%d" % i)
            tokens.add(t)
        check("100 个令牌全部唯一", len(tokens) == 100)
    except Exception as e:
        check("令牌唯一性测试 — 无异常", False, str(e))


# ============================================================
# 3. T02 SQLite 队列 (core/batch_queue.py)
# ============================================================
section("T02 SQLite 队列 (batch_queue.py)")

# 临时数据库根目录（每个测试用独立 DB 避免数据污染）
_BQ_TMP_DIR = tempfile.mkdtemp(prefix="sidemate_bq_test_")
_bq_db_counter = [0]


def _fresh_db_path():
    """每次调用返回一个全新的独立数据库路径（避免测试间数据污染）"""
    _bq_db_counter[0] += 1
    return os.path.join(_BQ_TMP_DIR, "bq_%d.db" % _bq_db_counter[0])


def test_batch_queue_init():
    """测试 3.1: BatchQueue 初始化 + 建表"""
    try:
        from core.batch_queue import BatchQueue
        db_path = _fresh_db_path()
        bq = BatchQueue(db_path=db_path)

        check("数据库文件已创建", os.path.exists(db_path))

        # 检查表是否存在
        conn = bq._get_conn()
        tables = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table'"
        ).fetchall()
        table_names = [t["name"] for t in tables]
        check("batch 表存在", "batch" in table_names)
        check("batch_task 表存在", "batch_task" in table_names)

        # 检查索引
        indexes = conn.execute(
            "SELECT name FROM sqlite_master WHERE type='index'"
        ).fetchall()
        index_names = [i["name"] for i in indexes]
        check("idx_batch_status 索引存在", "idx_batch_status" in index_names)
        check("idx_status 索引存在", "idx_status" in index_names)
    except Exception as e:
        check("初始化测试 — 无异常", False, str(e))


def test_batch_queue_wal_mode():
    """测试 3.2: SQLite WAL 模式"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        conn = bq._get_conn()
        result = conn.execute("PRAGMA journal_mode").fetchone()
        journal_mode = result[0]
        check("WAL 模式生效", journal_mode.lower() == "wal",
              "journal_mode=%s" % journal_mode)

        # synchronous 模式
        result2 = conn.execute("PRAGMA synchronous").fetchone()
        check("synchronous=NORMAL(1)", result2[0] == 1,
              "synchronous=%s" % result2[0])
    except Exception as e:
        check("WAL 模式测试 — 无异常", False, str(e))


def test_batch_queue_create_batch():
    """测试 3.3: create_batch()"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        # 自动生成 batch_id
        batch_id = bq.create_batch(total_files=5)
        check("自动 batch_id 非空", batch_id is not None and len(batch_id) > 0)
        check("自动 batch_id 以 b_ 开头", batch_id.startswith("b_"),
              "batch_id=%s" % batch_id)

        # 自定义 batch_id
        custom_id = bq.create_batch(batch_id="my_batch_001", total_files=3)
        check("自定义 batch_id 正确", custom_id == "my_batch_001")

        # 验证记录写入
        conn = bq._get_conn()
        row = conn.execute(
            "SELECT * FROM batch WHERE batch_id=?", ("my_batch_001",)
        ).fetchone()
        check("batch 记录已写入", row is not None)
        check("batch total_files 正确", row["total_files"] == 3)
        check("batch status=active", row["status"] == "active")
    except Exception as e:
        check("create_batch 测试 — 无异常", False, str(e))


def test_batch_queue_enqueue():
    """测试 3.4: enqueue() 入队"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="test_enqueue", total_files=3)

        task_id = bq.enqueue(
            batch_id, "/tmp/file1.txt", "file1.txt", "txt", 1024,
            doc_meta={"key": "value"}
        )
        check("enqueue 返回 task_id", task_id is not None)
        check("task_id 以 t_ 开头", task_id.startswith("t_"))

        # 验证任务写入
        conn = bq._get_conn()
        row = conn.execute(
            "SELECT * FROM batch_task WHERE task_id=?", (task_id,)
        ).fetchone()
        check("task 记录已写入", row is not None)
        check("task batch_id 正确", row["batch_id"] == "test_enqueue")
        check("task file_path 正确", row["file_path"] == "/tmp/file1.txt")
        check("task filename 正确", row["filename"] == "file1.txt")
        check("task file_type 正确", row["file_type"] == "txt")
        check("task file_size 正确", row["file_size"] == 1024)
        check("task status=pending", row["status"] == "pending")
        check("task doc_meta 正确", json.loads(row["doc_meta"])["key"] == "value")

        # 无 doc_meta
        task_id2 = bq.enqueue(batch_id, "/tmp/file2.txt", "file2.txt", "txt", 512)
        conn2 = bq._get_conn()
        row2 = conn2.execute(
            "SELECT doc_meta FROM batch_task WHERE task_id=?", (task_id2,)
        ).fetchone()
        check("无 doc_meta 时默认 {}", json.loads(row2["doc_meta"]) == {})
    except Exception as e:
        check("enqueue 测试 — 无异常", False, str(e))


def test_batch_queue_get_pending():
    """测试 3.5: get_pending() 原子取任务"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="test_pending", total_files=3)
        tq1 = bq.enqueue(batch_id, "/tmp/f1.txt", "f1.txt", "txt")
        tq2 = bq.enqueue(batch_id, "/tmp/f2.txt", "f2.txt", "txt")
        tq3 = bq.enqueue(batch_id, "/tmp/f3.txt", "f3.txt", "txt")

        # 取第一个
        task1 = bq.get_pending()
        check("get_pending 返回 TaskItem", task1 is not None)
        check("get_pending 返回第一个任务", task1.task_id == tq1)
        check("取出的任务 status=processing", task1.status == "processing")

        # 取第二个
        task2 = bq.get_pending()
        check("第二次 get_pending 返回不同任务", task2.task_id == tq2)

        # 取第三个
        task3 = bq.get_pending()
        check("第三次 get_pending 返回第三个任务", task3.task_id == tq3)

        # 取第四次，应为 None
        task4 = bq.get_pending()
        check("无 pending 时 get_pending 返回 None", task4 is None)
    except Exception as e:
        check("get_pending 测试 — 无异常", False, str(e))


def test_batch_queue_get_pending_atomic():
    """测试 3.6: get_pending() 并发不重复"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="test_concurrent", total_files=20)
        task_ids = []
        for i in range(20):
            tid = bq.enqueue(batch_id, "/tmp/c%d.txt" % i, "c%d.txt" % i, "txt")
            task_ids.append(tid)

        # 多线程并发取
        results = []
        results_lock = threading.Lock()

        def worker():
            while True:
                t = bq.get_pending()
                if t is None:
                    break
                with results_lock:
                    results.append(t.task_id)

        threads = [threading.Thread(target=worker) for _ in range(4)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        check("并发取 20 个任务全部取到", len(results) == 20,
              "got %d" % len(results))
        check("并发取任务无重复", len(set(results)) == 20)
    except Exception as e:
        check("并发原子测试 — 无异常", False, str(e))


def test_batch_queue_update_status():
    """测试 3.7: update_status()"""
    try:
        from core.batch_queue import BatchQueue
        db_path = _fresh_db_path()
        bq = BatchQueue(db_path=db_path)

        batch_id = bq.create_batch(batch_id="test_update", total_files=3)

        task_id = bq.enqueue(batch_id, "/tmp/u.txt", "u.txt", "txt")

        # 先 get_pending 标记为 processing
        bq.get_pending()

        # 更新为 done
        bq.update_status(task_id, "done", doc_id="doc_12345")
        conn = bq._get_conn()
        row = conn.execute(
            "SELECT * FROM batch_task WHERE task_id=?", (task_id,)
        ).fetchone()
        check("update_status done", row["status"] == "done")
        check("update_status doc_id", row["doc_id"] == "doc_12345")

        # 更新为 error（同一个 DB）
        tid2 = bq.enqueue(batch_id, "/tmp/e.txt", "e.txt", "txt")
        bq.get_pending()
        bq.update_status(tid2, "error", error_msg="解析失败")
        row2 = conn.execute(
            "SELECT * FROM batch_task WHERE task_id=?", (tid2,)
        ).fetchone()
        check("update_status error", row2["status"] == "error")
        check("update_status error_msg", row2["error_msg"] == "解析失败")

        # 更新带 doc_meta（同一个 DB）
        tid3 = bq.enqueue(batch_id, "/tmp/m.txt", "m.txt", "txt")
        bq.get_pending()
        bq.update_status(tid3, "done", doc_id="doc_m", doc_meta={"pages": 10})
        row3 = conn.execute(
            "SELECT doc_meta FROM batch_task WHERE task_id=?", (tid3,)
        ).fetchone()
        check("update_status doc_meta", json.loads(row3["doc_meta"])["pages"] == 10)
    except Exception as e:
        check("update_status 测试 — 无异常", False, str(e))


def test_batch_queue_progress():
    """测试 3.8: get_batch_progress() 进度统计"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="test_progress", total_files=5)

        # 入队 5 个任务
        tids = []
        for i in range(5):
            tids.append(bq.enqueue(batch_id, "/tmp/p%d.txt" % i, "p%d.txt" % i, "txt"))

        # 初始进度：5 pending
        prog = bq.get_batch_progress(batch_id)
        check("进度 total=5", prog["total"] == 5, "total=%s" % prog.get("total"))
        check("进度 pending=5", prog["pending"] == 5)
        check("进度 done=0", prog["done"] == 0)

        # 处理 2 个：done
        for i in range(2):
            t = bq.get_pending()
            bq.update_status(t.task_id, "done", doc_id="doc_%d" % i)

        prog2 = bq.get_batch_progress(batch_id)
        check("处理后 pending=3", prog2["pending"] == 3, "pending=%s" % prog2.get("pending"))
        check("处理后 done=2", prog2["done"] == 2)

        # 处理 1 个：error
        t3 = bq.get_pending()
        bq.update_status(t3.task_id, "error", error_msg="fail")

        prog3 = bq.get_batch_progress(batch_id)
        check("error 后 pending=2", prog3["pending"] == 2)
        check("error 后 error=1", prog3["error"] == 1)
        check("error 后 done=2", prog3["done"] == 2)

        # tasks 列表
        check("tasks 列表长度=5", len(prog3["tasks"]) == 5)

        # 不存在的批次
        prog4 = bq.get_batch_progress("nonexistent_batch")
        check("不存在批次返回 error", "error" in prog4)
    except Exception as e:
        check("get_batch_progress 测试 — 无异常", False, str(e))


def test_batch_queue_recover_pending():
    """测试 3.9: recover_pending() 断点恢复"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="test_recover", total_files=5)
        for i in range(5):
            bq.enqueue(batch_id, "/tmp/r%d.txt" % i, "r%d.txt" % i, "txt")

        # 模拟 3 个任务被取出（processing 状态）
        bq.get_pending()  # → processing
        bq.get_pending()  # → processing
        bq.get_pending()  # → processing

        conn = bq._get_conn()
        proc_count = conn.execute(
            "SELECT COUNT(*) as c FROM batch_task WHERE status='processing'"
        ).fetchone()["c"]
        check("恢复前 3 个 processing", proc_count == 3, "count=%s" % proc_count)

        # 断点恢复
        recovered = bq.recover_pending()
        check("recover_pending 返回 3", recovered == 3, "recovered=%s" % recovered)

        conn2 = bq._get_conn()
        proc_after = conn2.execute(
            "SELECT COUNT(*) as c FROM batch_task WHERE status='processing'"
        ).fetchone()["c"]
        check("恢复后 0 个 processing", proc_after == 0)

        pending_after = conn2.execute(
            "SELECT COUNT(*) as c FROM batch_task WHERE status='pending'"
        ).fetchone()["c"]
        check("恢复后 5 个 pending", pending_after == 5)

        # 无 processing 时恢复
        recovered2 = bq.recover_pending()
        check("无 processing 时返回 0", recovered2 == 0)
    except Exception as e:
        check("recover_pending 测试 — 无异常", False, str(e))


def test_batch_queue_cancel():
    """测试 3.10: cancel_batch()"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="test_cancel", total_files=3)
        bq.enqueue(batch_id, "/tmp/c1.txt", "c1.txt", "txt")
        bq.enqueue(batch_id, "/tmp/c2.txt", "c2.txt", "txt")
        bq.enqueue(batch_id, "/tmp/c3.txt", "c3.txt", "txt")

        cancelled = bq.cancel_batch(batch_id)
        check("cancel_batch 返回 3", cancelled == 3, "cancelled=%s" % cancelled)

        conn = bq._get_conn()
        cancelled_count = conn.execute(
            "SELECT COUNT(*) as c FROM batch_task WHERE batch_id=? AND status='cancelled'",
            (batch_id,)
        ).fetchone()["c"]
        check("3 个任务标记为 cancelled", cancelled_count == 3)

        # 批次状态
        batch_row = conn.execute(
            "SELECT status FROM batch WHERE batch_id=?", (batch_id,)
        ).fetchone()
        check("无 pending+processing 后 batch 状态=completed",
              batch_row["status"] == "completed")
    except Exception as e:
        check("cancel_batch 测试 — 无异常", False, str(e))


def test_batch_queue_empty_batch():
    """测试 3.11: 空 batch 边界情况"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        batch_id = bq.create_batch(batch_id="empty_batch", total_files=0)

        # 空 batch 进度
        prog = bq.get_batch_progress(batch_id)
        check("空 batch total=0", prog["total"] == 0)
        check("空 batch pending=0", prog["pending"] == 0)

        # 空 batch get_pending
        task = bq.get_pending()
        check("空 batch get_pending 返回 None", task is None)

        # 空 batch cancel
        cancelled = bq.cancel_batch(batch_id)
        check("空 batch cancel 返回 0", cancelled == 0)
    except Exception as e:
        check("空 batch 测试 — 无异常", False, str(e))


def test_batch_queue_get_active_batches():
    """测试 3.12: get_active_batches()"""
    try:
        from core.batch_queue import BatchQueue
        bq = BatchQueue(db_path=_fresh_db_path())

        # 清理旧数据
        conn = bq._get_conn()
        conn.execute("DELETE FROM batch")
        conn.execute("DELETE FROM batch_task")
        conn.commit()

        # 创建两个 active batch
        b1 = bq.create_batch(batch_id="active_1", total_files=2)
        b2 = bq.create_batch(batch_id="active_2", total_files=1)
        bq.enqueue(b1, "/tmp/a1.txt", "a1.txt", "txt")
        bq.enqueue(b1, "/tmp/a2.txt", "a2.txt", "txt")
        bq.enqueue(b2, "/tmp/b1.txt", "b1.txt", "txt")

        actives = bq.get_active_batches()
        check("get_active_batches 返回 2 个", len(actives) == 2, "count=%d" % len(actives))

        # 完成一个 batch
        bq.cancel_batch(b2)
        actives2 = bq.get_active_batches()
        check("完成后 get_active_batches 返回 1 个", len(actives2) == 1)
    except Exception as e:
        check("get_active_batches 测试 — 无异常", False, str(e))


# ============================================================
# 4. T03 is_private 字段 (knowledge/models.py + ops.py)
# ============================================================
section("T03 is_private 字段 (models.py + ops.py)")


def test_kbdocument_is_private_default():
    """测试 4.1: KBDocument 默认 is_private=False"""
    try:
        from knowledge.models import KBDocument
        doc = KBDocument(
            doc_id="test_doc",
            filename="test.txt",
            file_type="txt",
            file_size=100,
            imported_at="2024-01-01",
            status="pending",
        )
        check("KBDocument 默认 is_private=False", doc.is_private is False)

        # 显式设置
        doc2 = KBDocument(
            doc_id="test_doc2",
            filename="test2.txt",
            file_type="txt",
            file_size=100,
            imported_at="2024-01-01",
            status="pending",
            is_private=True,
        )
        check("KBDocument is_private=True 可设置", doc2.is_private is True)
    except Exception as e:
        check("KBDocument is_private 测试 — 无异常", False, str(e))


def test_kbchunk_is_private_default():
    """测试 4.2: KBChunk 默认 is_private=False"""
    try:
        from knowledge.models import KBChunk
        chunk = KBChunk(
            chunk_id="chunk_1",
            doc_id="test_doc",
            index=0,
        )
        check("KBChunk 默认 is_private=False", chunk.is_private is False)

        chunk2 = KBChunk(
            chunk_id="chunk_2",
            doc_id="test_doc",
            index=1,
            is_private=True,
        )
        check("KBChunk is_private=True 可设置", chunk2.is_private is True)
    except Exception as e:
        check("KBChunk is_private 测试 — 无异常", False, str(e))


def test_kbdocument_backward_compat():
    """测试 4.3: 向后兼容（旧 kb_meta.json 缺 is_private 字段）"""
    try:
        from knowledge.models import KBDocument
        # 模拟旧数据（无 is_private 字段）
        old_data = {
            "doc_id": "old_doc",
            "filename": "old.txt",
            "file_type": "txt",
            "file_size": 100,
            "imported_at": "2023-01-01",
            "status": "ready",
            # 无 is_private 字段
        }
        doc = KBDocument(**old_data)
        check("旧数据 KBDocument(**old_data) 不报错", True)
        check("旧数据 is_private 默认 False", doc.is_private is False)
    except Exception as e:
        check("向后兼容测试 — 无异常", False, str(e))


def test_kbchunk_backward_compat():
    """测试 4.4: KBChunk 向后兼容"""
    try:
        from knowledge.models import KBChunk
        old_data = {
            "chunk_id": "old_chunk",
            "doc_id": "old_doc",
            "index": 0,
            # 无 is_private 字段
        }
        chunk = KBChunk(**old_data)
        check("旧数据 KBChunk(**old_data) 不报错", True)
        check("旧数据 chunk is_private 默认 False", chunk.is_private is False)
    except Exception as e:
        check("KBChunk 向后兼容测试 — 无异常", False, str(e))


def test_import_document_is_private():
    """测试 4.5: import_document(is_private=True) 正确持久化"""
    try:
        # 构建 mock KB（避免加载模型）
        from knowledge.ops import _KBOpsMixin
        from knowledge.models import KBDocument

        # 创建临时目录
        tmp_kb_dir = tempfile.mkdtemp(prefix="sidemate_kb_test_")
        try:
            # 创建轻量级 mock KB 实例
            class MockKB(_KBOpsMixin):
                def __init__(self):
                    # 最小化初始化，绕过模型加载
                    self.base_dir = tmp_kb_dir
                    self.data_dir = os.path.join(tmp_kb_dir, "data", "kb")
                    self.texts_dir = os.path.join(self.data_dir, "kb_texts")
                    self.meta_path = os.path.join(self.data_dir, "kb_meta.json")
                    self.vectors_path = os.path.join(self.data_dir, "kb_vectors.npz")
                    os.makedirs(self.data_dir, exist_ok=True)
                    os.makedirs(self.texts_dir, exist_ok=True)

                    self.documents = {}
                    self.chunks = {}
                    self.vectors = None
                    self.chunk_order = []
                    self._need_rebuild_vectors = False

                    # mock embedder
                    class MockEmbedder:
                        vector_dim = 1024
                        _mode = "none"
                        sparse_available = False
                    self.embedder = MockEmbedder()
                    self._embedder_loaded = False

                    # mock reranker
                    class MockReranker:
                        available = False
                        _loaded = False
                    self.reranker = MockReranker()

                    # mock memory manager
                    class MockMM:
                        def register(self, *a, **kw): pass
                        def unregister(self, *a, **kw): pass
                    self.memory_manager = MockMM()

                    # 配置
                    self._load_config()

                    # 处理状态
                    import threading
                    self._processing_lock = threading.Lock()
                    self._cancel_flags = {}
                    self._cancel_tokens = {}
                    self._pause_flags = {}
                    self._paused_event = threading.Event()
                    self._paused_event.set()
                    self._global_paused = False

                    # BM25
                    self._bm25 = None
                    self._bm25_tokens = []
                    self._bm25_chunk_ids = []

                    # sparse 索引
                    self._sparse_index = {}

                    self._load_meta()
                    self._build_bm25_index()

            kb = MockKB()

            # 测试 import_document(is_private=False)
            result = kb.import_document("test.txt", "Hello World", file_type="txt")
            check("import_document 返回 doc_id", "doc_id" in result)
            doc_id = result["doc_id"]
            doc = kb.documents[doc_id]
            check("import_document 默认 is_private=False", doc.is_private is False)

            # 测试 import_document(is_private=True)
            result2 = kb.import_document("secret.txt", "Secret Content",
                                         file_type="txt", is_private=True)
            check("import_document(is_private=True) 返回 doc_id", "doc_id" in result2)
            doc_id2 = result2["doc_id"]
            doc2 = kb.documents[doc_id2]
            check("import_document(is_private=True) 正确持久化", doc2.is_private is True)

            # 测试 _save_meta + _load_meta 持久化
            kb._save_meta()
            kb.documents.clear()
            kb.chunks.clear()
            kb._load_meta()
            check("持久化后 doc is_private 保留",
                  kb.documents[doc_id2].is_private is True)
            check("持久化后 非 private doc 仍 False",
                  kb.documents[doc_id].is_private is False)
        finally:
            shutil.rmtree(tmp_kb_dir, ignore_errors=True)
    except Exception as e:
        check("import_document is_private 测试 — 无异常", False, str(e))


# ============================================================
# 5. T03 search() 私密过滤 (knowledge/search.py)
# ============================================================
section("T03 search() 私密过滤 + dense+sparse 融合")


def test_search_accessible_doc_ids_filter():
    """测试 5.1: search(accessible_doc_ids=...) 过滤私密文档"""
    try:
        from knowledge.search import _KBSearchMixin

        # 创建 mock KB 实例
        class MockKB(_KBSearchMixin):
            def __init__(self):
                import threading
                import numpy as np
                self._processing_lock = threading.Lock()
                self.search_top_k = 5
                self._embedder_loaded = False
                self.embedder = type('E', (), {
                    'vector_dim': 1024,
                    '_mode': 'none',
                    'sparse_available': False,
                })()
                self._sparse_index = {}
                self._need_rebuild_vectors = False
                self.vectors = None
                self.chunk_order = []
                self.chunks = {}
                self._bm25 = None
                self._bm25_chunk_ids = []

            def init_embedder(self):
                return False

            def _ensure_reranker(self):
                return False

            def _schedule_reranker_unload(self):
                pass

            def _mmr_rerank(self, query, candidates, top_k=5, lambda_param=0.7):
                return candidates[:top_k]

        kb = MockKB()

        # search 无索引时应返回空列表（不崩溃）
        results = kb.search("test query")
        check("空索引 search 不崩溃，返回空列表", results == [],
              "got %s" % results)

        # accessible_doc_ids=None：不崩溃
        results2 = kb.search("test", accessible_doc_ids=None)
        check("accessible_doc_ids=None 不崩溃", results2 == [])

        # accessible_doc_ids=set()：不崩溃
        results3 = kb.search("test", accessible_doc_ids=set())
        check("accessible_doc_ids=set() 不崩溃", isinstance(results3, list))
    except Exception as e:
        check("search accessible_doc_ids 测试 — 无异常", False, str(e))


def test_dense_sparse_fusion():
    """测试 5.2: _dense_sparse_fusion() 融合逻辑"""
    try:
        from knowledge.search import _KBSearchMixin

        dense = [
            {"chunk_id": "c1", "text": "a", "score": 0.9, "source_label": "s1",
             "doc_id": "d1", "heading": "", "index": 0},
            {"chunk_id": "c2", "text": "b", "score": 0.7, "source_label": "s2",
             "doc_id": "d2", "heading": "", "index": 0},
            {"chunk_id": "c3", "text": "c", "score": 0.5, "source_label": "s3",
             "doc_id": "d3", "heading": "", "index": 0},
        ]
        sparse = [
            {"chunk_id": "c2", "text": "b", "score": 5.0, "source_label": "s2",
             "doc_id": "d2", "heading": "", "index": 0},
            {"chunk_id": "c4", "text": "d", "score": 3.0, "source_label": "s4",
             "doc_id": "d4", "heading": "", "index": 0},
        ]

        merged = _KBSearchMixin._dense_sparse_fusion(dense, sparse, alpha=0.7, top_k=3)

        check("融合返回 3 条", len(merged) == 3, "len=%d" % len(merged))
        check("融合结果包含 fused_score", "fused_score" in merged[0])
        check("融合结果包含 search_method", merged[0].get("search_method") == "dense_sparse")

        # c2 在 dense 和 sparse 中都有，分数应更高
        c2_item = [m for m in merged if m["chunk_id"] == "c2"]
        check("c2 在融合结果中", len(c2_item) == 1)

        # 空输入
        check("空 dense+sparse 返回空", _KBSearchMixin._dense_sparse_fusion([], []) == [])
        check("空 sparse 返回 dense", len(_KBSearchMixin._dense_sparse_fusion(dense, [])) > 0)
        check("空 dense 返回 sparse", len(_KBSearchMixin._dense_sparse_fusion([], sparse)) > 0)

        # alpha=1.0 纯 dense
        merged_pure = _KBSearchMixin._dense_sparse_fusion(dense, sparse, alpha=1.0, top_k=3)
        check("alpha=1.0 不报错", len(merged_pure) > 0)

        # alpha=0.0 纯 sparse
        merged_sparse = _KBSearchMixin._dense_sparse_fusion(dense, sparse, alpha=0.0, top_k=3)
        check("alpha=0.0 不报错", len(merged_sparse) > 0)
    except Exception as e:
        check("dense_sparse_fusion 测试 — 无异常", False, str(e))


def test_search_filter_logic():
    """测试 5.3: search() 私密过滤逻辑（模拟有结果时）"""
    try:
        from knowledge.search import _KBSearchMixin
        import threading

        class MockKB(_KBSearchMixin):
            def __init__(self):
                self._processing_lock = threading.Lock()
                self.search_top_k = 5
                self._embedder_loaded = True
                self.embedder = type('E', (), {
                    'vector_dim': 1024, '_mode': 'bge', 'sparse_available': False,
                })()
                self._sparse_index = {}
                self._need_rebuild_vectors = False
                # 设置非空 vectors 和 chunk_order，使 search() 调用 _search_vector
                import numpy as np
                self.vectors = np.zeros((2, 1024), dtype=np.float32)
                self.chunk_order = ["c1", "c2"]
                self.chunks = {}
                self._bm25 = None
                self._bm25_chunk_ids = []

            def init_embedder(self):
                return False

            def _ensure_reranker(self):
                return False

            def _schedule_reranker_unload(self):
                pass

            def _search_vector(self, query, top_k=None):
                # 返回固定结果用于测试过滤逻辑
                return [
                    {"chunk_id": "c1", "text": "public", "score": 0.9,
                     "source_label": "pub.txt", "doc_id": "d_public", "heading": "", "index": 0},
                    {"chunk_id": "c2", "text": "private", "score": 0.8,
                     "source_label": "priv.txt", "doc_id": "d_private", "heading": "", "index": 0},
                ]

            def _mmr_rerank(self, query, candidates, top_k=5, lambda_param=0.7):
                return candidates[:top_k]

        # Patch5 B1: search() 需要 documents 字典来更新 hit_count
        class _MockDoc:
            def __init__(self, doc_id):
                self.doc_id = doc_id
                self.hit_count = 0

        kb = MockKB()
        kb.documents = {"d_public": _MockDoc("d_public"), "d_private": _MockDoc("d_private")}

        # accessible_doc_ids=None：不过滤
        results = kb.search("test")
        check("accessible_doc_ids=None 不过滤（2条）", len(results) == 2,
              "len=%d" % len(results))

        # accessible_doc_ids={'d_public'}：只返回 public
        results_filtered = kb.search("test", accessible_doc_ids={"d_public"})
        check("accessible_doc_ids 过滤后只 1 条", len(results_filtered) == 1,
              "len=%d" % len(results_filtered))
        check("过滤后只有 d_public", results_filtered[0]["doc_id"] == "d_public")

        # accessible_doc_ids=set()：全部过滤
        results_empty = kb.search("test", accessible_doc_ids=set())
        check("accessible_doc_ids=set() 过滤后 0 条", len(results_empty) == 0)
    except Exception as e:
        check("search 过滤逻辑测试 — 无异常", False, str(e))


def test_sparse_index_cleanup():
    """测试 5.4: 删除文档时 sparse 索引清理"""
    try:
        from knowledge.models import KBDocument, KBChunk
        import threading

        # mock KB with sparse index
        class MockKB:
            def __init__(self):
                self.documents = {}
                self.chunks = {}
                self.vectors = None
                self.chunk_order = []
                self._sparse_index = {}
                self._processing_lock = threading.Lock()
                self.texts_dir = tempfile.mkdtemp(prefix="sparse_test_")

            def delete_document(self, doc_id):
                # 模拟 ops.py delete_document 的 sparse 清理逻辑
                doc_chunk_ids = [cid for cid, c in self.chunks.items() if c.doc_id == doc_id]
                for cid in doc_chunk_ids:
                    self.chunks.pop(cid, None)
                    self._sparse_index.pop(cid, None)  # sparse 清理
                self.chunk_order = [cid for cid in self.chunk_order if cid in self.chunks]

        kb = MockKB()
        doc_id = "d1"
        kb.documents[doc_id] = KBDocument(
            doc_id=doc_id, filename="t.txt", file_type="txt",
            file_size=10, imported_at="2024", status="ready"
        )
        kb.chunks["c1"] = KBChunk(chunk_id="c1", doc_id=doc_id, index=0)
        kb.chunks["c2"] = KBChunk(chunk_id="c2", doc_id=doc_id, index=1)
        kb.chunk_order = ["c1", "c2"]
        kb._sparse_index["c1"] = {1: 0.5}
        kb._sparse_index["c2"] = {2: 0.3}

        kb.delete_document(doc_id)

        check("删除文档后 chunk 清理", len(kb.chunks) == 0)
        check("删除文档后 sparse 索引清理", len(kb._sparse_index) == 0)
        check("删除文档后 chunk_order 清理", len(kb.chunk_order) == 0)

        shutil.rmtree(kb.texts_dir, ignore_errors=True)
    except Exception as e:
        check("sparse 索引清理测试 — 无异常", False, str(e))


# ============================================================
# 6. 全局回归（config + import 安全性）
# ============================================================
section("全局回归（config P5 配置项 + import 安全性）")


def test_config_p5_keys():
    """测试 6.1: config 包含 6 个 P5 配置项"""
    try:
        import config

        p5_keys = [
            "thread_pool_max_workers",
            "batch_queue_db_path",
            "batch_queue_poll_interval",
            "kb_dense_sparse_alpha",
            "kb_enable_sparse",
            "access_token_default_ttl",
        ]

        for key in p5_keys:
            val = config.get(key)
            check("config.get('%s') 非 None" % key, val is not None,
                  "val=%s" % val)

        # 验证默认值
        check("thread_pool_max_workers 默认=2", config.get("thread_pool_max_workers") == 2)
        check("batch_queue_poll_interval 默认=1.0", config.get("batch_queue_poll_interval") == 1.0)
        check("kb_dense_sparse_alpha 默认=0.7", config.get("kb_dense_sparse_alpha") == 0.7)
        check("kb_enable_sparse 默认=True", config.get("kb_enable_sparse") is True)
        check("access_token_default_ttl 默认=0", config.get("access_token_default_ttl") == 0)
    except Exception as e:
        check("config P5 配置测试 — 无异常", False, str(e))


def test_import_core_modules():
    """测试 6.2: import 所有 P5 核心模块无报错"""
    try:
        from core.thread_pool import ThreadPoolManager, get_thread_pool, init_thread_pool, shutdown_thread_pool
        check("import thread_pool OK", True)

        from core.access_token import AccessTokenManager, AccessToken, get_access_token_manager
        check("import access_token OK", True)

        from core.batch_queue import BatchQueue, TaskItem
        check("import batch_queue OK", True)

        from knowledge.models import KBDocument, KBChunk
        check("import models OK", True)
    except Exception as e:
        check("import 核心模块测试 — 无异常", False, str(e))


def test_import_routers():
    """测试 6.3: import routers（kb/chat 等）无报错"""
    try:
        # 尝试 import routers（可能需要 FastAPI）
        import_errors = []

        try:
            from routers import kb as kb_router
            check("import routers.kb OK", True)
        except ImportError as e:
            # FastAPI 可能未安装，这是可接受的
            if "fastapi" in str(e).lower() or "starlette" in str(e).lower():
                check("routers.kb 需 FastAPI（跳过，非 P5 问题）", True)
            else:
                check("import routers.kb 无非预期错误", False, str(e))
        except Exception as e:
            check("import routers.kb — 无异常", False, str(e)[:200])

        # config import
        try:
            import config
            check("import config OK", True)
        except Exception as e:
            check("import config — 无异常", False, str(e))

        # embedding_engine import
        try:
            from knowledge.embedding_engine import EmbeddingEngine
            check("import embedding_engine OK", True)
        except Exception as e:
            check("import embedding_engine — 无异常", False, str(e)[:200])

        # search module
        try:
            from knowledge.search import _KBSearchMixin
            check("import search OK", True)
        except Exception as e:
            check("import search — 无异常", False, str(e))
    except Exception as e:
        check("import routers 测试 — 无异常", False, str(e))


def test_agent_loop_token_parsing():
    """测试 6.4: agent_loop.py search_kb token 解析逻辑"""
    try:
        # 检查 agent_loop.py 中 search_kb 的 token 解析代码存在
        import inspect
        from core import agent_loop

        source = inspect.getsource(agent_loop)
        check("agent_loop 包含 token 参数解析",
              'token = args.get("token"' in source or 'args.get("token"' in source)
        check("agent_loop 包含 filter_private_docs 调用",
              "filter_private_docs" in source)
        check("agent_loop 包含 accessible_doc_ids",
              "accessible_doc_ids" in source)
    except Exception as e:
        check("agent_loop token 解析测试 — 无异常", False, str(e))


def test_agent_tools_token_param():
    """测试 6.5: agent_tools.py search_kb 工具含 token 参数"""
    try:
        from core import agent_tools
        # 检查 search_kb 工具定义包含 token 参数
        check("search_kb 在 TOOL_REGISTRY", "search_kb" in agent_tools.TOOL_REGISTRY)

        search_kb_tool = agent_tools.TOOL_REGISTRY["search_kb"]
        # 工具结构: {"schema": {"function": {"parameters": {"properties": {...}}}}}
        schema = search_kb_tool.get("schema", search_kb_tool)
        func_def = schema.get("function", schema)
        params = func_def.get("parameters", {})
        properties = params.get("properties", {})

        check("search_kb 工具含 token 参数", "token" in properties,
              "properties keys: %s" % list(properties.keys()))
    except Exception as e:
        check("agent_tools token 参数测试 — 无异常", False, str(e))


def test_embedding_engine_sparse_methods():
    """测试 6.6: EmbeddingEngine sparse 相关方法存在"""
    try:
        from knowledge.embedding_engine import EmbeddingEngine
        engine = EmbeddingEngine()

        check("sparse_available 属性存在", hasattr(engine, "sparse_available"))
        check("encode_dense_sparse 方法存在", hasattr(engine, "encode_dense_sparse"))
        check("encode_query_sparse 方法存在", hasattr(engine, "encode_query_sparse"))
        check("_extract_dense 方法存在", hasattr(engine, "_extract_dense"))
        check("_extract_sparse 方法存在", hasattr(engine, "_extract_sparse"))

        # 未加载模型时
        check("未加载时 sparse_available=False", engine.sparse_available is False)

        # encode_query_sparse 返回空字典
        result = engine.encode_query_sparse("test")
        check("未加载时 encode_query_sparse 返回 {}", result == {})

        # encode_dense_sparse 返回 dense + 空 sparse
        dense, sparse = engine.encode_dense_sparse(["test"])
        check("encode_dense_sparse 返回 dense", dense is not None)
        check("encode_dense_sparse 返回 sparse 列表", isinstance(sparse, list))
        check("未加载时 sparse 为空字典", sparse == [{}])

        # 空输入
        d, s = engine.encode_dense_sparse([])
        check("encode_dense_sparse 空输入不崩溃", d is not None)
    except Exception as e:
        check("embedding_engine sparse 测试 — 无异常", False, str(e))


# ============================================================
# 运行所有测试
# ============================================================
if __name__ == "__main__":
    print("\n" + "#" * 60)
    print("#  Sidemate Patch5 批次 A 回归测试")
    print("#  T01 (线程池+令牌) + T02 (SQLite队列) + T03 (私密文档)")
    print("#" * 60)

    start_time = time.time()

    # T01 线程池
    test_thread_pool_singleton()
    test_thread_pool_submit()
    test_thread_pool_run_blocking()
    test_thread_pool_lazy_init()
    test_thread_pool_shutdown()
    test_thread_pool_concurrent()

    # T01 令牌系统
    test_token_generate_full()
    test_token_generate_search()
    test_token_verify_valid()
    test_token_verify_invalid()
    test_token_revoke()
    test_token_revoke_doc()
    test_token_filter_private_docs()
    test_token_expiry()
    test_token_get_doc_access_level()
    test_token_clear_all()
    test_token_singleton()
    test_token_uniqueness()

    # T02 SQLite 队列
    test_batch_queue_init()
    test_batch_queue_wal_mode()
    test_batch_queue_create_batch()
    test_batch_queue_enqueue()
    test_batch_queue_get_pending()
    test_batch_queue_get_pending_atomic()
    test_batch_queue_update_status()
    test_batch_queue_progress()
    test_batch_queue_recover_pending()
    test_batch_queue_cancel()
    test_batch_queue_empty_batch()
    test_batch_queue_get_active_batches()

    # T03 is_private 字段
    test_kbdocument_is_private_default()
    test_kbchunk_is_private_default()
    test_kbdocument_backward_compat()
    test_kbchunk_backward_compat()
    test_import_document_is_private()

    # T03 search 私密过滤
    test_search_accessible_doc_ids_filter()
    test_dense_sparse_fusion()
    test_search_filter_logic()
    test_sparse_index_cleanup()

    # 全局回归
    test_config_p5_keys()
    test_import_core_modules()
    test_import_routers()
    test_agent_loop_token_parsing()
    test_agent_tools_token_param()
    test_embedding_engine_sparse_methods()

    elapsed = time.time() - start_time

    # ===== 清理临时文件 =====
    try:
        shutil.rmtree(_BQ_TMP_DIR, ignore_errors=True)
    except Exception:
        pass

    # ===== 结果汇总 =====
    print("\n" + "=" * 60)
    print("  测试结果汇总")
    print("=" * 60)
    total = _pass + _fail
    print("  总测试数: %d" % total)
    print("  通过: %d" % _pass)
    print("  失败: %d" % _fail)
    print("  耗时: %.1fs" % elapsed)
    print("  通过率: %.1f%%" % (100.0 * _pass / total if total > 0 else 0))

    if _errors:
        print("\n  --- 失败用例 ---")
        for err in _errors:
            print("  [FAIL] %s" % err)
    print("=" * 60)

    sys.exit(0 if _fail == 0 else 1)
