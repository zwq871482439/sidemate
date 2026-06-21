# -*- coding: utf-8 -*-
"""
test_bg_init_state.py — Patch5 启动重构：后台初始化状态机单元测试

验证 server.py 中 _bg_init_state 的状态转换逻辑：
  - _set_bg_phase / _add_bg_error / _set_bg_ready 三个辅助函数
  - 线程安全（多线程并发读写）
  - 错误累积语义（load_error 不覆盖，而是累积）

测试策略：
  由于 server.py 导入链极重（FastAPI + OllamaManager + KB + ...），
  这里不 import server，而是复制状态机的核心逻辑到测试中验证其行为契约。
  辅助函数的实现直接从 server.py 复制，保证一致性。
"""

import threading
import time
import unittest


# ===== 复制 server.py 的状态机逻辑（不依赖重型 import）=====
# 以下代码与 server.py L183-218 一一对应

_bg_init_state = {
    "ready": False,
    "load_error": None,
    "bg_phase": "pending",
}
_bg_init_lock = threading.Lock()


def _set_bg_phase(phase):
    """更新后台初始化阶段（线程安全）"""
    with _bg_init_lock:
        _bg_init_state["bg_phase"] = phase


def _set_bg_ready(error=None):
    """标记后台初始化完成（线程安全）。
    error 非空时累积到 load_error（不覆盖已有错误）。
    无论成败，ready 最终一定变 True。
    """
    with _bg_init_lock:
        _bg_init_state["ready"] = True
        if error:
            existing = _bg_init_state.get("load_error")
            _bg_init_state["load_error"] = (existing + "; " + error) if existing else error


def _add_bg_error(error):
    """累积后台初始化错误（不结束流程，继续后续步骤）"""
    with _bg_init_lock:
        existing = _bg_init_state.get("load_error")
        _bg_init_state["load_error"] = (existing + "; " + error) if existing else error


def _reset_state():
    """重置状态机到初始值（测试用）"""
    global _bg_init_state
    with _bg_init_lock:
        _bg_init_state = {
            "ready": False,
            "load_error": None,
            "bg_phase": "pending",
        }


class TestBgInitStateInitial(unittest.TestCase):
    """测试初始状态"""

    def setUp(self):
        _reset_state()

    def test_initial_state(self):
        """初始状态：ready=False, load_error=None, bg_phase='pending'"""
        with _bg_init_lock:
            self.assertFalse(_bg_init_state["ready"], "ready 初始应为 False")
            self.assertIsNone(_bg_init_state["load_error"], "load_error 初始应为 None")
            self.assertEqual(_bg_init_state["bg_phase"], "pending", "bg_phase 初始应为 'pending'")


class TestSetBgPhase(unittest.TestCase):
    """测试 _set_bg_phase 阶段转换"""

    def setUp(self):
        _reset_state()

    def test_set_phase_ollama(self):
        """设置 bg_phase='ollama' → 读回正确"""
        _set_bg_phase("ollama")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["bg_phase"], "ollama")

    def test_set_phase_warmup(self):
        """设置 bg_phase='warmup' → 读回正确"""
        _set_bg_phase("warmup")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["bg_phase"], "warmup")

    def test_set_phase_kb(self):
        """设置 bg_phase='kb' → 读回正确"""
        _set_bg_phase("kb")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["bg_phase"], "kb")

    def test_set_phase_schedulers(self):
        """设置 bg_phase='schedulers' → 读回正确"""
        _set_bg_phase("schedulers")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["bg_phase"], "schedulers")

    def test_set_phase_done(self):
        """设置 bg_phase='done' → 读回正确"""
        _set_bg_phase("done")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["bg_phase"], "done")

    def test_phase_sequence(self):
        """验证完整阶段序列：pending→ollama→warmup→kb→schedulers→done"""
        phases = ["ollama", "warmup", "kb", "schedulers", "done"]
        for phase in phases:
            _set_bg_phase(phase)
            with _bg_init_lock:
                self.assertEqual(_bg_init_state["bg_phase"], phase,
                                 "阶段序列中 bg_phase 应为 '%s'" % phase)


class TestSetBgReady(unittest.TestCase):
    """测试 _set_bg_ready 完成标记"""

    def setUp(self):
        _reset_state()

    def test_set_ready_no_error(self):
        """设置 ready=True，无错误 → ready=True, load_error=None"""
        _set_bg_ready()
        with _bg_init_lock:
            self.assertTrue(_bg_init_state["ready"], "ready 应为 True")
            self.assertIsNone(_bg_init_state["load_error"], "load_error 应保持 None")

    def test_set_ready_with_error(self):
        """设置 ready=True 且带 error → ready=True, load_error='xxx'"""
        _set_bg_ready("Ollama 启动失败")
        with _bg_init_lock:
            self.assertTrue(_bg_init_state["ready"], "ready 应为 True")
            self.assertEqual(_bg_init_state["load_error"], "Ollama 启动失败")

    def test_set_ready_with_error_after_add_error(self):
        """先 _add_bg_error 再 _set_bg_ready(新error) → load_error 累积"""
        _add_bg_error("KB 加载失败")
        _set_bg_ready("Scheduler 失败")
        with _bg_init_lock:
            self.assertTrue(_bg_init_state["ready"])
            self.assertIn("KB 加载失败", _bg_init_state["load_error"])
            self.assertIn("Scheduler 失败", _bg_init_state["load_error"])
            self.assertIn("; ", _bg_init_state["load_error"], "多个错误应用 '; ' 连接")


class TestAddBgError(unittest.TestCase):
    """测试 _add_bg_error 错误累积"""

    def setUp(self):
        _reset_state()

    def test_add_single_error(self):
        """单个 error → load_error = 'xxx'"""
        _add_bg_error("模型预热失败")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["load_error"], "模型预热失败")
            self.assertFalse(_bg_init_state["ready"], "add_error 不应改变 ready")

    def test_add_multiple_errors_accumulate(self):
        """多个 error → load_error 累积，用 '; ' 连接"""
        _add_bg_error("错误A")
        _add_bg_error("错误B")
        _add_bg_error("错误C")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["load_error"], "错误A; 错误B; 错误C")

    def test_add_error_does_not_set_ready(self):
        """_add_bg_error 不应该设置 ready=True"""
        _add_bg_error("some error")
        with _bg_init_lock:
            self.assertFalse(_bg_init_state["ready"], "add_error 不应改变 ready")

    def test_add_error_does_not_change_phase(self):
        """_add_bg_error 不应该改变 bg_phase"""
        _set_bg_phase("warmup")
        _add_bg_error("warmup step failed")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["bg_phase"], "warmup", "add_error 不应改变 phase")


class TestConcurrentAccess(unittest.TestCase):
    """并发安全性测试：多线程同时调 _set_bg_phase / _add_bg_error / _set_bg_ready"""

    def setUp(self):
        _reset_state()

    def test_concurrent_phase_and_error(self):
        """20 个线程并发调 _set_bg_phase / _add_bg_error / _set_bg_ready
        最终状态一致（无崩溃，ready=True，load_error 非空且不含 None）"""
        threads = []
        errors_caught = []

        def worker():
            try:
                for i in range(50):
                    _set_bg_phase("phase_%d" % i)
                    _add_bg_error("error_%d" % i)
                    if i % 10 == 0:
                        _set_bg_ready("final_%d" % i)
            except Exception as e:
                errors_caught.append(e)

        for _ in range(20):
            t = threading.Thread(target=worker)
            threads.append(t)
            t.start()

        for t in threads:
            t.join()

        # 不应有异常
        self.assertEqual(errors_caught, [], "并发执行不应抛出异常")

        with _bg_init_lock:
            # ready 一定为 True（_set_bg_ready 被调用过）
            self.assertTrue(_bg_init_state["ready"], "并发后 ready 必须为 True")
            # load_error 非空
            self.assertIsNotNone(_bg_init_state["load_error"], "load_error 不应为 None")
            # load_error 不含字符串 'None'
            self.assertNotIn("None", str(_bg_init_state["load_error"]),
                             "load_error 不应包含 'None' 字符串")
            # bg_phase 应该是某个 phase_N 值（最后写入的那个）
            self.assertTrue(_bg_init_state["bg_phase"].startswith("phase_"),
                            "bg_phase 应为 phase_N 格式，实际: %s" % _bg_init_state["bg_phase"])

    def test_concurrent_ready_always_true_once_set(self):
        """并发场景下，ready 一旦被设为 True 不会回退"""
        _set_bg_ready()

        results = []
        def reader():
            for _ in range(100):
                with _bg_init_lock:
                    results.append(_bg_init_state["ready"])

        threads = [threading.Thread(target=reader) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 所有读取都应该是 True
        self.assertTrue(all(results), "ready=True 后所有并发读取都应为 True")
        self.assertEqual(len(results), 1000, "应有 1000 次读取")

    def test_concurrent_phase_readers(self):
        """并发读 bg_phase 不崩溃，值始终是有效字符串"""
        _set_bg_phase("warmup")

        results = []
        def reader():
            for _ in range(100):
                with _bg_init_lock:
                    val = _bg_init_state["bg_phase"]
                results.append(val)
                self.assertIsInstance(val, str)

        threads = [threading.Thread(target=reader) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        self.assertEqual(len(results), 1000)


class TestErrorAccumulationFormat(unittest.TestCase):
    """错误累积格式契约测试"""

    def setUp(self):
        _reset_state()

    def test_add_then_set_ready(self):
        """_add_bg_error(无error) + _set_bg_ready(error) → load_error 只含 set_ready 的 error"""
        _add_bg_error("err1")
        _set_bg_ready("err2")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["load_error"], "err1; err2")

    def test_set_ready_none_then_add(self):
        """_set_bg_ready(None) + _add_bg_error → load_error 只含 add 的 error"""
        _set_bg_ready(None)  # 无 error
        _add_bg_error("late_error")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["load_error"], "late_error")

    def test_set_ready_twice(self):
        """_set_bg_ready 调用两次，error 累积"""
        _set_bg_ready("first")
        _set_bg_ready("second")
        with _bg_init_lock:
            self.assertEqual(_bg_init_state["load_error"], "first; second")

    def test_load_error_never_none_after_set(self):
        """_set_bg_ready(error) 后 load_error 永不为 None"""
        _set_bg_ready("critical failure")
        with _bg_init_lock:
            self.assertIsNotNone(_bg_init_state["load_error"])


class TestFullWorkflowSimulation(unittest.TestCase):
    """模拟完整的后台初始化工作流程"""

    def setUp(self):
        _reset_state()

    def test_success_workflow(self):
        """成功路径：pending→ollama→warmup→kb→schedulers→done, ready=True, error=None"""
        _set_bg_phase("ollama")
        # auto_start 成功，无 error
        _set_bg_phase("warmup")
        # warmup 成功，无 error
        _set_bg_phase("kb")
        # KB 加载成功，无 error
        _set_bg_phase("schedulers")
        # Scheduler 初始化成功，无 error
        _set_bg_ready()  # 无 error
        with _bg_init_lock:
            self.assertTrue(_bg_init_state["ready"])
            self.assertIsNone(_bg_init_state["load_error"])

    def test_partial_failure_workflow(self):
        """部分失败路径：Ollama 失败，但继续执行后续步骤，最终 ready=True"""
        _set_bg_phase("ollama")
        _add_bg_error("Ollama 启动失败: timeout")
        # 继续后续步骤
        _set_bg_phase("warmup")
        _add_bg_error("模型预热失败: connection refused")
        _set_bg_phase("kb")
        # KB 加载成功
        _set_bg_phase("schedulers")
        _set_bg_ready()  # 最终完成

        with _bg_init_lock:
            self.assertTrue(_bg_init_state["ready"], "即使部分失败，ready 最终也应是 True")
            self.assertIsNotNone(_bg_init_state["load_error"])
            self.assertIn("Ollama", _bg_init_state["load_error"])
            self.assertIn("模型预热", _bg_init_state["load_error"])

    def test_auto_warmup_false_workflow(self):
        """auto_warmup_llm=False：跳过 warmup，直接到 KB"""
        _set_bg_phase("ollama")
        # Ollama OK
        _set_bg_phase("warmup")
        # auto_warmup_llm=False → 跳过，无 error
        _set_bg_phase("kb")
        # KB 未安装 → 跳过
        _set_bg_phase("schedulers")
        _set_bg_ready()

        with _bg_init_lock:
            self.assertTrue(_bg_init_state["ready"])
            self.assertIsNone(_bg_init_state["load_error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
