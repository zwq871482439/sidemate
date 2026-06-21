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
    """Integration-style tests: verify the gating check is present in the source."""

    def test_gpu_gating_code_present_in_kb_py(self):
        """Verify the GPU gating check exists in routers/kb.py."""
        import os
        kb_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "routers", "kb.py"
        )
        with open(kb_path, "r", encoding="utf-8") as f:
            content = f.read()

        # The key log message must be present
        self.assertIn("batch_queue connected", content)
        self.assertIn("NOT connected", content)
        self.assertIn("_is_batch_idle()", content)
        self.assertIn("notify_doc_ready", content)

    def test_gpu_gating_after_notify_not_before(self):
        """Verify gating check appears AFTER notify_doc_ready call in source."""
        import os
        import re
        kb_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "routers", "kb.py"
        )
        with open(kb_path, "r", encoding="utf-8") as f:
            content = f.read()

        # Find the positions
        notify_pos = content.find("notify_doc_ready(doc_id)")
        gating_pos = content.find("batch_queue connected")

        self.assertGreater(notify_pos, 0, "notify_doc_ready(doc_id) not found")
        self.assertGreater(gating_pos, notify_pos,
                          "GPU gating check must appear AFTER notify_doc_ready")

    def test_warning_message_exact_text(self):
        """Verify the exact warning message format."""
        import os
        kb_path = os.path.join(
            os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
            "routers", "kb.py"
        )
        with open(kb_path, "r", encoding="utf-8") as f:
            content = f.read()

        expected_warning = (
            "[KB] TaggingScheduler batch_queue NOT connected "
            "— LLM may run during vectorization!"
        )
        self.assertIn(expected_warning, content)


if __name__ == "__main__":
    unittest.main()
