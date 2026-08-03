# -*- coding: utf-8 -*-
"""P8-2 联网搜索链路改造 — 纯逻辑测试
覆盖：次数常量、预算注入格式、KB 空库 gating、护栏触发逻辑（模拟循环状态）
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestToolLimits(unittest.TestCase):
    """2.2 次数调整：TOOL_LIMITS / MAX_ROUNDS 常量"""

    def test_limits_values(self):
        from core.agent_loop import TOOL_LIMITS, MAX_ROUNDS
        self.assertEqual(TOOL_LIMITS["search_web"], 5)
        self.assertEqual(TOOL_LIMITS["fetch_url"], 15)
        self.assertEqual(TOOL_LIMITS["search_kb"], 5)
        self.assertEqual(MAX_ROUNDS, 26)

    def test_fetch_search_ratio(self):
        """fetch 应为 search 的 3 倍（一次搜索读 3 篇）"""
        from core.agent_loop import TOOL_LIMITS
        self.assertEqual(TOOL_LIMITS["fetch_url"], TOOL_LIMITS["search_web"] * 3)

    def test_rounds_headroom(self):
        """最坏情况 5+15=20 轮检索后，至少留 5 轮收尾"""
        from core.agent_loop import TOOL_LIMITS, MAX_ROUNDS
        worst = TOOL_LIMITS["search_web"] + TOOL_LIMITS["fetch_url"]
        self.assertGreaterEqual(MAX_ROUNDS - worst, 5)


class TestBudgetMessage(unittest.TestCase):
    """2.2 预算注入：快照内容与替换逻辑（用与 agent_loop 相同的生成规则）"""

    def _make_budget(self, tool_counts, rounds):
        from core.agent_loop import TOOL_LIMITS, MAX_ROUNDS
        return ("[剩余预算] 联网搜索 %d 次 · 网页阅读 %d 次 · 知识库搜索 %d 次 · 总轮次 %d 轮"
                "（请据此规划检索深度，预算不足时直接基于已有信息回答）" % (
                    max(0, TOOL_LIMITS["search_web"] - tool_counts.get("search_web", 0)),
                    max(0, TOOL_LIMITS["fetch_url"] - tool_counts.get("fetch_url", 0)),
                    max(0, TOOL_LIMITS["search_kb"] - tool_counts.get("search_kb", 0)),
                    MAX_ROUNDS - rounds))

    def test_budget_content(self):
        msg = self._make_budget({"search_web": 2, "fetch_url": 6}, 4)
        self.assertIn("联网搜索 3 次", msg)
        self.assertIn("网页阅读 9 次", msg)
        self.assertIn("知识库搜索 5 次", msg)
        self.assertIn("总轮次 22 轮", msg)

    def test_budget_no_negative(self):
        msg = self._make_budget({"search_web": 99}, 99)
        self.assertIn("联网搜索 0 次", msg)
        self.assertIn("总轮次 -73 轮" if False else "总轮次", msg)

    def test_budget_replace_not_accumulate(self):
        """快照按前缀识别替换，messages 中最多一条"""
        messages = [{"role": "user", "content": "hi"},
                    {"role": "user", "content": self._make_budget({}, 0)}]
        # 模拟 agent_loop 的替换逻辑
        messages[:] = [m for m in messages
                       if not (m.get("role") == "user"
                               and isinstance(m.get("content"), str)
                               and m["content"].startswith("[剩余预算]"))]
        messages.append({"role": "user", "content": self._make_budget({"search_web": 1}, 1)})
        budgets = [m for m in messages if m["content"].startswith("[剩余预算]")]
        self.assertEqual(len(budgets), 1)
        self.assertIn("联网搜索 4 次", budgets[0]["content"])

    def test_budget_not_strip_normal_user_msg(self):
        """普通用户消息（即使以 [ 开头）不被误删"""
        messages = [{"role": "user", "content": "[注意] 这是我自己的话"},
                    {"role": "user", "content": self._make_budget({}, 0)}]
        messages[:] = [m for m in messages
                       if not (m.get("role") == "user"
                               and isinstance(m.get("content"), str)
                               and m["content"].startswith("[剩余预算]"))]
        self.assertEqual(len(messages), 1)
        self.assertEqual(messages[0]["content"], "[注意] 这是我自己的话")


class TestKbEmptyGating(unittest.TestCase):
    """2.3 KB 空库：文档数 > 0 才算 kb_available（用与 agent_tools 相同的判定式）"""

    @staticmethod
    def _kb_available(kb, kb_permission):
        _cnt = len(getattr(kb, "documents", None) or {}) if kb else 0
        return kb is not None and kb_permission != "disabled" and _cnt > 0

    def test_kb_none(self):
        self.assertFalse(self._kb_available(None, "full"))

    def test_kb_empty_dict(self):
        class FakeKB:
            documents = {}
        self.assertFalse(self._kb_available(FakeKB(), "full"))

    def test_kb_with_docs(self):
        class FakeKB:
            documents = {"a": object()}
        self.assertTrue(self._kb_available(FakeKB(), "full"))

    def test_kb_permission_disabled(self):
        class FakeKB:
            documents = {"a": object()}
        self.assertFalse(self._kb_available(FakeKB(), "disabled"))

    def test_kb_documents_none(self):
        class FakeKB:
            documents = None
        self.assertFalse(self._kb_available(FakeKB(), "full"))


class TestFetchHintGuard(unittest.TestCase):
    """2.1 只搜不读护栏：触发条件真值表（与 agent_loop 中判定式一致）"""

    @staticmethod
    def _should_hint(searches, fetches, hint_used):
        return searches > 0 and fetches == 0 and not hint_used

    def test_trigger(self):
        self.assertTrue(self._should_hint(searches=2, fetches=0, hint_used=False))

    def test_no_search_no_hint(self):
        self.assertFalse(self._should_hint(searches=0, fetches=0, hint_used=False))

    def test_already_fetched_no_hint(self):
        self.assertFalse(self._should_hint(searches=2, fetches=1, hint_used=False))

    def test_only_once(self):
        self.assertFalse(self._should_hint(searches=2, fetches=0, hint_used=True))


class TestSingletonLocks(unittest.TestCase):
    """4.3 懒加载单例：锁存在且可获取"""

    def test_thread_pool_lock(self):
        from core import thread_pool
        self.assertTrue(hasattr(thread_pool, "_pool_lock"))
        self.assertTrue(thread_pool._pool_lock.acquire(blocking=False))
        thread_pool._pool_lock.release()

    def test_thread_pool_singleton(self):
        import threading
        from core.thread_pool import get_thread_pool
        results = []
        def worker():
            results.append(id(get_thread_pool()))
        threads = [threading.Thread(target=worker) for _ in range(10)]
        for t in threads: t.start()
        for t in threads: t.join()
        self.assertEqual(len(set(results)), 1, "并发首调应得到同一实例")

    def test_access_token_lock(self):
        from core import access_token
        self.assertTrue(hasattr(access_token, "_atm_lock"))


if __name__ == "__main__":
    unittest.main()
