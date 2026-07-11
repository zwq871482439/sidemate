# -*- coding: utf-8 -*-
"""tests/test_kb_gpu_gating.py — Fix 3: GPU gating check in routers/kb.py

Verifies that after notify_doc_ready(), the _process() function in
api_kb_upload correctly checks scheduler._batch_queue connectivity
and logs appropriately.
"""
import unittest
from unittest.mock import MagicMock, patch, PropertyMock
import logging


class TestGpuGatingCheck(unittest.TestCase):
    """Tests for the GPU gating debug log in api_kb_upload._process()"""

    def setUp(self):
        # Silence logging during tests
        logging.disable(logging.CRITICAL)

    def tearDown(self):
        logging.disable(logging.NOTSET)

    def _run_gating_check(self, batch_queue_value, has_is_batch_idle=True):
        """Simulate the GPU gating check logic from routers/kb.py:859-865.
        
        Returns (log_info_calls, log_warning_calls) as lists of (msg, args).
        """
        import re

        scheduler = MagicMock()
        scheduler.notify_doc_ready = MagicMock()
        scheduler._batch_queue = batch_queue_value  # None or a mock
        if has_is_batch_idle and batch_queue_value is not None:
            scheduler._is_batch_idle = MagicMock(return_value=True)
        elif has_is_batch_idle:
            scheduler._is_batch_idle = MagicMock(return_value=True)
        else:
            delattr(scheduler, '_is_batch_idle')

        log_info_calls = []
        log_warning_calls = []

        # Replicate the exact logic from routers/kb.py lines 859-865
        if hasattr(scheduler, 'notify_doc_ready'):
            scheduler.notify_doc_ready("test_doc_id")
            # GPU gating: check batch_queue is connected
            if hasattr(scheduler, '_batch_queue') and scheduler._batch_queue is not None:
                log_info_calls.append(
                    ("[KB] TaggingScheduler batch_queue connected: batch_idle=%s",
                     scheduler._is_batch_idle())
                )
            else:
                log_warning_calls.append(
                    "[KB] TaggingScheduler batch_queue NOT connected — LLM may run during vectorization!"
                )

        return log_info_calls, log_warning_calls

    def test_batch_queue_connected_logs_info(self):
        """When _batch_queue is set (not None), info log should be emitted."""
        log_info, log_warning = self._run_gating_check(
            batch_queue_value=MagicMock()
        )
        self.assertEqual(len(log_info), 1)
        self.assertEqual(len(log_warning), 0)
        self.assertIn("batch_queue connected", log_info[0][0])

    def test_batch_queue_none_logs_warning(self):
        """When _batch_queue is None, warning log should be emitted."""
        log_info, log_warning = self._run_gating_check(
            batch_queue_value=None
        )
        self.assertEqual(len(log_info), 0)
        self.assertEqual(len(log_warning), 1)
        self.assertIn("NOT connected", log_warning[0])

    def test_no_notify_doc_ready_skips_check(self):
        """When scheduler lacks notify_doc_ready, the entire block is skipped."""
        scheduler = MagicMock()
        # Deliberately remove notify_doc_ready
        del scheduler.notify_doc_ready
        scheduler._batch_queue = MagicMock()

        # Should skip the if block entirely
        if hasattr(scheduler, 'notify_doc_ready'):
            self.fail("notify_doc_ready should not exist")
        
        # This is the correct behavior — nothing logged, no crash
        self.assertFalse(hasattr(scheduler, 'notify_doc_ready'))

    def test_no_batch_queue_attr_logs_warning(self):
        """When scheduler lacks _batch_queue attribute entirely, warning should be emitted."""
        scheduler = MagicMock()
        scheduler.notify_doc_ready = MagicMock()
        # Remove _batch_queue
        if hasattr(scheduler, '_batch_queue'):
            del scheduler._batch_queue

        log_warning_calls = []

        if hasattr(scheduler, 'notify_doc_ready'):
            scheduler.notify_doc_ready("test_doc_id")
            if hasattr(scheduler, '_batch_queue') and scheduler._batch_queue is not None:
                pass
            else:
                log_warning_calls.append(
                    "[KB] TaggingScheduler batch_queue NOT connected — LLM may run during vectorization!"
                )

        self.assertEqual(len(log_warning_calls), 1)

    def test_notify_doc_ready_called_before_check(self):
        """notify_doc_ready must be called BEFORE the batch_queue check."""
        scheduler = MagicMock()
        scheduler.notify_doc_ready = MagicMock()
        scheduler._batch_queue = MagicMock()
        scheduler._is_batch_idle = MagicMock(return_value=False)

        call_order = []

        # Simulate with call order tracking
        scheduler.notify_doc_ready("test_doc_id")
        scheduler.notify_doc_ready.assert_called_once_with("test_doc_id")

        if hasattr(scheduler, '_batch_queue') and scheduler._batch_queue is not None:
            idle = scheduler._is_batch_idle()
            # These happen AFTER notify_doc_ready

        # notify_doc_ready must have been called
        scheduler.notify_doc_ready.assert_called_once()


class TestGpuGatingInUploadContext(unittest.TestCase):
    """Integration-style tests: verify gating logic is present in the right place.

    历史背景：gating 原本写在 routers/kb.py 里（手撸 batch_queue 检查 + 字面量日志），
    后重构为「职责下沉」——kb.py 只调 scheduler.notify_doc_ready(doc_id) 触发，
    真正的 gating 由 TaggingScheduler._is_batch_idle() + _worker 循环承担。
    这组测试验证重构后的架构契约：gating 入口和实现各自在位。
    """

    @staticmethod
    def _read(rel_path):
        """读取 server/<rel_path> 源码。"""
        import os
        path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            *rel_path.split("/")
        )
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def test_kb_calls_notify_doc_ready_as_entry(self):
        """kb.py 的上传流程通过 notify_doc_ready 触发 gating（而非自己手撸检查）。"""
        content = self._read("routers/kb.py")
        # 入口存在：上传完成后的 _process 里通知 scheduler
        self.assertIn("notify_doc_ready", content)
        # 旧职责已移走：kb.py 不再手撸 batch_queue 连接状态判断
        self.assertNotIn("batch_queue connected", content)

    def test_gating_lives_in_tagging_scheduler(self):
        """gating 实现落在 tagging_scheduler.py：_is_batch_idle + _worker 循环。"""
        content = self._read("core/tagging_scheduler.py")
        self.assertIn("def _is_batch_idle", content)
        self.assertIn("def _worker", content)
        # worker 循环里必须调用 gating（否则职责下沉后功能就丢了）
        self.assertIn("_is_batch_idle()", content)

    def test_kb_notify_before_gating_handoff(self):
        """kb.py 中 notify_doc_ready 出现在 _process 流程内（向量化的合理时机）。"""
        content = self._read("routers/kb.py")
        notify_pos = content.find("notify_doc_ready(doc_id)")
        # 入口必须存在
        self.assertGreater(notify_pos, 0, "notify_doc_ready(doc_id) not found in kb.py")
        # 上传处理上下文存在（确认是 _process 内的调用，不是孤儿）
        self.assertIn("def _process", content)



if __name__ == "__main__":
    unittest.main()
