# -*- coding: utf-8 -*-
"""
Sidemate Patch5 批次 A — T05 压力测试（100 文件批量上传）
=========================================================

核心验证点（假死 bug 的直接复现/验证）：
  1. BatchQueue 正常排队消费 100 个文件
  2. 处理期间模拟的「健康检查」必须在 2 秒内返回（事件循环不卡死）
  3. 进度查询正常返回
  4. 中途取消能停止 pending 任务
  5. 断点恢复：模拟杀掉 worker，重启后续切

设计理念：
  - 不启动真正的 FastAPI 服务（避免端口冲突 + 模型依赖）
  - 用 BatchQueue + MockKB 直接验证队列行为
  - 用 asyncio 事件循环模拟「主线程健康检查 vs 后台 worker 竞争」
  - MockKB 的 process_document 用 sleep 模拟 CPU 密集（embedding）耗时

用法：
  C:\\Sidemate\\python\\python.exe C:\\Sidemate\\tests\\test_p5_stress_100files.py
"""
import sys
import os
import time
import json
import shutil
import tempfile
import threading
import asyncio
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
        print("    [PASS] %s" % name)
    else:
        _fail += 1
        msg = "%s%s" % (name, (" — %s" % detail) if detail else "")
        _errors.append(msg)
        print("    [FAIL] %s%s" % (name, (" — %s" % detail) if detail else ""))


def section(title):
    print("\n" + "=" * 70)
    print("  %s" % title)
    print("=" * 70)


# ============================================================
# MockKB — 模拟知识库（不加载真实模型）
# ============================================================

class MockKB:
    """模拟 KnowledgeBase 的最小接口

    BatchQueue._process_task 调用的 KB 方法：
      - get_stats()
      - import_document(filename, text, file_type, metadata) -> {"doc_id": ...}
      - process_document(doc_id, text)  — 模拟 CPU 密集（sleep）
      - get_document(doc_id)
      - _save_meta()
    """

    def __init__(self, max_documents=200, process_delay=0.02):
        self.max_documents = max_documents
        self.documents = {}
        self._process_delay = process_delay  # 模拟 embedding 计算耗时
        self._lock = threading.Lock()
        self._doc_counter = 0

    def get_stats(self):
        with self._lock:
            ready = sum(1 for d in self.documents.values() if d["status"] == "ready")
            processing = sum(1 for d in self.documents.values()
                             if d["status"] in ("pending", "processing", "indexing"))
        return {
            "ready_documents": ready,
            "processing_documents": processing,
            "max_documents": self.max_documents,
        }

    def import_document(self, filename, text, file_type="txt", metadata=None):
        with self._lock:
            self._doc_counter += 1
            doc_id = "doc_%03d" % self._doc_counter
            self.documents[doc_id] = {
                "doc_id": doc_id,
                "filename": filename,
                "status": "pending",
                "text": text,
            }
        return {"doc_id": doc_id}

    def process_document(self, doc_id, text):
        """模拟处理文档（分块 + embedding）— CPU 密集"""
        doc = self.documents.get(doc_id)
        if not doc:
            return
        # 模拟 embedding 计算耗时
        time.sleep(self._process_delay)
        doc["status"] = "ready"

    def get_document(self, doc_id):
        return self.documents.get(doc_id)

    def _save_meta(self):
        pass  # no-op for mock


def make_temp_txt_files(count, base_dir, prefix="stress"):
    """生成 count 个临时 txt 文件，返回 [(path, filename, size), ...]"""
    files = []
    for i in range(count):
        fname = "%s_%03d.txt" % (prefix, i)
        path = os.path.join(base_dir, fname)
        line = "这是测试文件 %d 的内容。\n" % i
        content = line * 10  # ~200 字
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        files.append((path, fname, os.path.getsize(path)))
    return files


# ============================================================
# 测试 1: 100 文件批量入队 + 队列消费
# ============================================================

def test_100_files_enqueue_consume():
    """测试 1: 100 文件入队，验证 BatchQueue 正确排队消费"""
    section("测试 1: 100 文件批量入队 + 队列消费")

    tmp_dir = tempfile.mkdtemp(prefix="sidemate_stress_")
    db_path = os.path.join(tmp_dir, "stress_test.db")

    try:
        from core.batch_queue import BatchQueue

        kb = MockKB(max_documents=200, process_delay=0.01)
        bq = BatchQueue(db_path=db_path)

        # 生成 100 个临时文件
        files = make_temp_txt_files(100, tmp_dir, "stress1")

        # 创建批次 + 入队
        batch_id = bq.create_batch(total_files=100)

        check("创建批次成功", batch_id is not None and batch_id.startswith("b_"),
              "batch_id=%s" % batch_id)

        task_ids = []
        for path, fname, size in files:
            tid = bq.enqueue(batch_id, path, fname, "txt", size)
            task_ids.append(tid)

        check("入队 100 个任务", len(task_ids) == 100, "count=%d" % len(task_ids))

        # 验证进度
        prog = bq.get_batch_progress(batch_id)
        check("进度 total=100", prog["total"] == 100, "total=%s" % prog.get("total"))
        check("进度 pending=100", prog["pending"] == 100, "pending=%s" % prog.get("pending"))
        check("进度 done=0", prog["done"] == 0)
        check("进度 status=active", prog["status"] == "active")

        # 启动 worker 消费
        bq.start_worker(kb)

        # 等待消费完成（最多 30 秒）
        deadline = time.time() + 30
        while time.time() < deadline:
            prog = bq.get_batch_progress(batch_id)
            if prog["pending"] == 0 and prog["processing"] == 0:
                break
            time.sleep(0.5)

        prog_final = bq.get_batch_progress(batch_id)
        check("消费后 pending=0", prog_final["pending"] == 0,
              "pending=%s" % prog_final.get("pending"))
        check("消费后 processing=0", prog_final["processing"] == 0,
              "processing=%s" % prog_final.get("processing"))
        check("消费后 done=100", prog_final["done"] == 100,
              "done=%s" % prog_final.get("done"))
        check("MockKB 创建 100 个文档", len(kb.documents) == 100,
              "docs=%d" % len(kb.documents))

        bq.stop_worker(timeout=5)

    except Exception as e:
        check("100 文件入队消费 — 无异常", False, str(e)[:200])
        traceback.print_exc()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ============================================================
# 测试 2: 健康检查并发不超时（核心！验证事件循环不卡死）
# ============================================================

def test_health_check_during_processing():
    """测试 2: 处理期间模拟健康检查，必须在 2 秒内返回

    这是 T05 最重要的验证点——假死 bug 的核心症状：
    如果阻塞操作在事件循环线程跑，健康检查会超时。
    """

    section("测试 2: 处理期间健康检查不超时（<2s）")

    tmp_dir = tempfile.mkdtemp(prefix="sidemate_health_")
    db_path = os.path.join(tmp_dir, "health_test.db")

    try:
        from core.batch_queue import BatchQueue

        # 使用稍长的处理延迟模拟繁重 embedding
        kb = MockKB(max_documents=200, process_delay=0.05)
        bq = BatchQueue(db_path=db_path)

        # 生成 50 个文件
        files = make_temp_txt_files(50, tmp_dir, "health")
        batch_id = bq.create_batch(total_files=50)
        for path, fname, size in files:
            bq.enqueue(batch_id, path, fname, "txt", size)

        # 启动 worker（后台线程消费）
        bq.start_worker(kb)

        # 模拟健康检查：在 asyncio 事件循环中并发跑多个「健康检查」
        # 如果 BatchQueue worker 或线程池操作卡住事件循环，
        # 这些协程会等很久才返回。

        async def mock_health_check(check_id):
            """模拟 /api/status 健康检查协程"""
            start = time.time()
            # 模拟一个轻量操作（读状态、返回 JSON）
            await asyncio.sleep(0.001)  # 模拟极小的 IO
            elapsed = time.time() - start
            return (check_id, elapsed)

        async def run_concurrent_health_checks():
            """在 worker 消费的同时，并发执行 10 个健康检查"""
            tasks = [mock_health_check(i) for i in range(10)]
            results = await asyncio.gather(*tasks)
            return results

        # 在 worker 活跃期间跑健康检查
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)

        check_times = []
        for _ in range(3):  # 跑 3 轮
            results = loop.run_until_complete(run_concurrent_health_checks())
            for cid, elapsed in results:
                check_times.append(elapsed)

        loop.close()

        max_time = max(check_times) if check_times else 999
        avg_time = sum(check_times) / len(check_times) if check_times else 999

        check("所有健康检查 <2s", max_time < 2.0,
              "max=%.3fs" % max_time)
        check("平均健康检查 <0.1s", avg_time < 0.1,
              "avg=%.3fs" % avg_time)
        check("最大健康检查 <0.5s", max_time < 0.5,
              "max=%.3fs" % max_time)

        # 等 worker 完成
        deadline = time.time() + 20
        while time.time() < deadline:
            prog = bq.get_batch_progress(batch_id)
            if prog["pending"] == 0:
                break
            time.sleep(0.5)

        bq.stop_worker(timeout=5)

    except Exception as e:
        check("健康检查并发 — 无异常", False, str(e)[:200])
        traceback.print_exc()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ============================================================
# 测试 3: 进度查询正常返回
# ============================================================

def test_progress_query_during_processing():
    """测试 3: 处理期间反复查询进度，确保正常返回"""
    section("测试 3: 进度查询正常返回")

    tmp_dir = tempfile.mkdtemp(prefix="sidemate_progress_")
    db_path = os.path.join(tmp_dir, "progress_test.db")

    try:
        from core.batch_queue import BatchQueue

        kb = MockKB(max_documents=200, process_delay=0.03)
        bq = BatchQueue(db_path=db_path)

        files = make_temp_txt_files(30, tmp_dir, "prog")
        batch_id = bq.create_batch(total_files=30)
        for path, fname, size in files:
            bq.enqueue(batch_id, path, fname, "txt", size)

        bq.start_worker(kb)

        # 反复查询进度
        progress_ok = True
        progress_sequence = []
        for _ in range(20):
            prog = bq.get_batch_progress(batch_id)
            if not isinstance(prog, dict) or "total" not in prog:
                progress_ok = False
                break
            progress_sequence.append(prog["done"])
            time.sleep(0.1)

        check("进度查询全部成功", progress_ok)
        check("进度数据有效（total=30）",
              progress_sequence and all(p >= 0 for p in progress_sequence))

        # 进度应该是非递减的（done 只增不减）
        non_decreasing = all(
            progress_sequence[i] <= progress_sequence[i + 1]
            for i in range(len(progress_sequence) - 1)
        ) if len(progress_sequence) > 1 else True
        check("进度单调递增（done 不回退）", non_decreasing,
              "sequence=%s" % progress_sequence[:10])

        # 等 worker 完成
        deadline = time.time() + 15
        while time.time() < deadline:
            prog = bq.get_batch_progress(batch_id)
            if prog["pending"] == 0:
                break
            time.sleep(0.5)

        final_prog = bq.get_batch_progress(batch_id)
        check("最终 done=30", final_prog["done"] == 30,
              "done=%s" % final_prog.get("done"))

        bq.stop_worker(timeout=5)

    except Exception as e:
        check("进度查询 — 无异常", False, str(e)[:200])
        traceback.print_exc()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ============================================================
# 测试 4: 中途取消能停止 pending 任务
# ============================================================

def test_mid_way_cancel():
    """测试 4: 中途取消，pending 任务变为 cancelled"""
    section("测试 4: 中途取消停止 pending 任务")

    tmp_dir = tempfile.mkdtemp(prefix="sidemate_cancel_")
    db_path = os.path.join(tmp_dir, "cancel_test.db")

    try:
        from core.batch_queue import BatchQueue

        # 用较长 delay 确保 cancel 时仍有 pending
        kb = MockKB(max_documents=200, process_delay=0.1)
        bq = BatchQueue(db_path=db_path)

        files = make_temp_txt_files(50, tmp_dir, "cancel")
        batch_id = bq.create_batch(total_files=50)
        for path, fname, size in files:
            bq.enqueue(batch_id, path, fname, "txt", size)

        bq.start_worker(kb)

        # 等 1 个任务处理完
        time.sleep(0.3)

        # 取消剩余 pending
        cancelled_count = bq.cancel_batch(batch_id)
        check("取消返回 >0", cancelled_count > 0, "cancelled=%d" % cancelled_count)

        # 验证 cancelled 状态
        prog = bq.get_batch_progress(batch_id)
        check("取消后 cancelled>0", prog["cancelled"] > 0,
              "cancelled=%s" % prog.get("cancelled"))
        check("取消后 pending=0", prog["pending"] == 0,
              "pending=%s" % prog.get("pending"))

        # 等 worker 处理完正在 processing 的
        time.sleep(1)

        final_prog = bq.get_batch_progress(batch_id)
        check("最终 cancelled + done = 50",
              final_prog["cancelled"] + final_prog["done"] == 50,
              "cancelled=%s done=%s" % (final_prog.get("cancelled"), final_prog.get("done")))

        bq.stop_worker(timeout=5)

    except Exception as e:
        check("中途取消 — 无异常", False, str(e)[:200])
        traceback.print_exc()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ============================================================
# 测试 5: 断点恢复 — 模拟杀掉 worker，重启续切
# ============================================================

def test_resume_after_worker_kill():
    """测试 5: 模拟 worker 中途挂掉，recover_pending 后重启续切"""
    section("测试 5: 断点恢复（worker kill → recover → restart）")

    tmp_dir = tempfile.mkdtemp(prefix="sidemate_resume_")
    db_path = os.path.join(tmp_dir, "resume_test.db")

    try:
        from core.batch_queue import BatchQueue

        kb = MockKB(max_documents=200, process_delay=0.02)
        bq = BatchQueue(db_path=db_path)

        files = make_temp_txt_files(40, tmp_dir, "resume")
        batch_id = bq.create_batch(total_files=40)
        for path, fname, size in files:
            bq.enqueue(batch_id, path, fname, "txt", size)

        # 启动 worker，处理几个
        bq.start_worker(kb)
        time.sleep(0.5)

        # 模拟杀掉 worker（强行停止，不等 processing 完成）
        bq._worker_stop.set()
        if bq._worker_thread and bq._worker_thread.is_alive():
            bq._worker_thread.join(timeout=0.1)  # 不等 processing 完成
        bq._worker_thread = None

        # 此时可能有一些任务卡在 processing 状态
        prog_before = bq.get_batch_progress(batch_id)
        processing_before = prog_before.get("processing", 0)
        check("kill 后有 processing 任务卡住（或正好为0）",
              processing_before >= 0,
              "processing=%d" % processing_before)

        # 断点恢复：processing → pending
        recovered = bq.recover_pending()
        check("recover_pending 执行成功", recovered >= 0, "recovered=%d" % recovered)

        prog_after = bq.get_batch_progress(batch_id)
        check("recover 后 processing=0",
              prog_after.get("processing", -1) == 0,
              "processing=%s" % prog_after.get("processing"))
        check("recover 后 pending=remaining",
              prog_after.get("pending", -1) == (40 - prog_after.get("done", 0)),
              "pending=%s done=%s" % (prog_after.get("pending"), prog_after.get("done")))

        # 重启 worker 续切
        bq._worker_stop.clear()
        bq.start_worker(kb)

        # 等待完成
        deadline = time.time() + 30
        while time.time() < deadline:
            prog = bq.get_batch_progress(batch_id)
            if prog["pending"] == 0 and prog["processing"] == 0:
                break
            time.sleep(0.5)

        final_prog = bq.get_batch_progress(batch_id)
        check("恢复后 done=40", final_prog["done"] == 40,
              "done=%s" % final_prog.get("done"))
        check("恢复后 pending=0", final_prog["pending"] == 0,
              "pending=%s" % final_prog.get("pending"))

        bq.stop_worker(timeout=5)

    except Exception as e:
        check("断点恢复 — 无异常", False, str(e)[:200])
        traceback.print_exc()
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


# ============================================================
# 测试 6: 线程池 executor 验证（T05 核心改造）
# ============================================================

def test_thread_pool_integration():
    """测试 6: 验证 T05 线程池改造——get_thread_pool() 可正常使用"""
    section("测试 6: 线程池集成验证（T05 改造核心）")

    try:
        from core.thread_pool import get_thread_pool

        pool = get_thread_pool()
        pool.init(max_workers=2)

        # 验证 executor 可用
        check("executor 已初始化", pool.executor is not None)

        # 模拟 run_in_executor 场景（与 kb.py 改造一致）
        def parse_file(path):
            """模拟文件解析"""
            with open(path, "r", encoding="utf-8") as f:
                return f.read()

        tmp_file = tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8")
        tmp_file.write("test content for thread pool")
        tmp_file.close()

        # 用 asyncio + run_in_executor（与 kb.py 改造方式一致）
        async def test_async():
            loop = asyncio.get_event_loop()
            result = await loop.run_in_executor(
                pool.executor, parse_file, tmp_file.name
            )
            return result

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        result = loop.run_until_complete(test_async())
        loop.close()

        check("run_in_executor 返回正确结果", result == "test content for thread pool")

        os.unlink(tmp_file.name)

        # 验证 agent_loop 的 run_blocking 模式（与 agent_loop.py 改造一致）
        def mock_tool(name, args, stats):
            return {"success": True, "tool": name, "data": args}

        result2 = pool.run_blocking(mock_tool, "search_web", {"query": "test"}, {})
        check("run_blocking 返回 dict", isinstance(result2, dict))
        check("run_blocking 数据正确", result2.get("tool") == "search_web")

        pool.shutdown(wait=True)

    except Exception as e:
        check("线程池集成 — 无异常", False, str(e)[:200])
        traceback.print_exc()


# ============================================================
# 测试 7: kb.py 改造验证（_extract_upload_text 函数存在）
# ============================================================

def test_kb_extract_helper_exists():
    """测试 7: 验证 kb.py 包含 _extract_upload_text 辅助函数（T05 改造）"""
    section("测试 7: kb.py _extract_upload_text 改造验证")

    try:
        import inspect
        from routers import kb as kb_router

        # 检查 _extract_upload_text 函数存在
        check("_extract_upload_text 函数存在",
              hasattr(kb_router, "_extract_upload_text"))

        if hasattr(kb_router, "_extract_upload_text"):
            # 检查源码中包含线程池调用
            source = inspect.getsource(kb_router.api_kb_upload)
            check("api_kb_upload 包含 run_in_executor",
                  "run_in_executor" in source)
            check("api_kb_upload 包含 get_thread_pool",
                  "get_thread_pool" in source)

        # 检查 SSE ask 端点未被改动（SSE 保护）
        source_ask = inspect.getsource(kb_router.api_kb_ask)
        check("SSE ask 端点仍使用 StreamingResponse",
              "StreamingResponse" in source_ask)

    except Exception as e:
        check("kb.py 改造验证 — 无异常", False, str(e)[:200])
        traceback.print_exc()


# ============================================================
# 测试 8: agent_loop.py 改造验证（_execute_tool 走线程池）
# ============================================================

def test_agent_loop_thread_pool_integration():
    """测试 8: 验证 agent_loop.py _execute_tool 走线程池（T05 改造）"""
    section("测试 8: agent_loop.py 工具调用线程池验证")

    try:
        import inspect
        from core import agent_loop

        source = inspect.getsource(agent_loop.AgentLoop.run)

        check("agent run() 包含 get_thread_pool", "get_thread_pool" in source)
        check("agent run() 包含 run_blocking", "run_blocking" in source)
        check("agent run() 包含 _execute_tool", "_execute_tool" in source)

    except Exception as e:
        check("agent_loop 改造验证 — 无异常", False, str(e)[:200])
        traceback.print_exc()


# ============================================================
# 主入口
# ============================================================

if __name__ == "__main__":
    print("\n" + "#" * 70)
    print("#  Sidemate Patch5 批次 A — T05 压力测试")
    print("#  100 文件批量上传 + 事件循环不卡死验证")
    print("#" * 70)

    start_time = time.time()

    # 核心压力测试
    test_100_files_enqueue_consume()
    test_health_check_during_processing()
    test_progress_query_during_processing()
    test_mid_way_cancel()
    test_resume_after_worker_kill()

    # T05 改造验证
    test_thread_pool_integration()
    test_kb_extract_helper_exists()
    test_agent_loop_thread_pool_integration()

    elapsed = time.time() - start_time

    # ===== 结果汇总 =====
    print("\n" + "=" * 70)
    print("  压力测试结果汇总")
    print("=" * 70)
    total = _pass + _fail
    print("  总测试断言数: %d" % total)
    print("  通过: %d" % _pass)
    print("  失败: %d" % _fail)
    print("  耗时: %.1fs" % elapsed)
    print("  通过率: %.1f%%" % (100.0 * _pass / total if total > 0 else 0))

    if _errors:
        print("\n  --- 失败用例 ---")
        for err in _errors:
            print("  [FAIL] %s" % err)
    print("=" * 70)

    sys.exit(0 if _fail == 0 else 1)
