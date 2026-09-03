# -*- coding: utf-8 -*-
"""M2 harness 三机制测试：run_plan（PTC 调用计划）+ spawn_reader（并行深读）

覆盖：
- run_plan：白名单内工具递归执行并合并结果；写操作/嵌套/未知工具逐个拒绝；
  超 5 步截断并说明；空 steps 报错；单步异常不拖垮整批
- spawn_reader：并发读取合并、按问题关键词窗口截取、坏 URL 不拖垮批次、
  参数校验
- _keyword_excerpt：命中窗口截取 / 零命中回退开头 / 短文原样返回

注意：_execute_tool 递归走 search_engine/kb 的地方全部 stub，不发真请求。
"""
import core.agent_loop as al
from collections import defaultdict


def _stats():
    return defaultdict(int)  # 生产侧 stats 各键预初始化；测试用 defaultdict 等价


class _FakeSearchEngine:
    def search(self, query):
        return [{"title": "结果-" + query, "url": "http://x/" + query, "snippet": "s"}]

    def fetch(self, url):
        if "bad" in url:
            raise RuntimeError("连接失败")
        return {
            "title": "标题-" + url[-1],
            "text": ("开头段落。\n" + "无关内容行。\n" * 20
                     + "桌伴的核心功能是本地优先与隐私保护。\n" + "填充行。\n" * 20),
            "length": 900,
        }


def _loop():
    return al.AgentLoop(cloud_engine=None, search_engine=_FakeSearchEngine(),
                        kb=None, chat_id=None, history=None)


class TestRunPlan:
    def test_empty_plan_rejected(self):
        r = _loop()._execute_tool("run_plan", {"steps": []}, _stats())
        assert r["success"] is False and r["error"] == "empty_plan"

    def test_allowed_tools_executed(self):
        r = _loop()._execute_tool("run_plan", {
            "steps": [
                {"tool": "search_web", "args": {"query": "桌伴"}},
                {"tool": "get_current_time", "args": {}},
            ]}, _stats())
        assert r["success"] is True
        d = r["data"]
        assert d["total"] == 2 and d["ok_count"] == 2
        assert d["results"][0]["data"]["count"] == 1  # search_web 结果数

    def test_write_and_nesting_rejected(self):
        r = _loop()._execute_tool("run_plan", {
            "steps": [
                {"tool": "write_workspace", "args": {"path": "a.md", "content": "x"}},
                {"tool": "run_plan", "args": {"steps": []}},
                {"tool": "search_web", "args": {"query": "ok"}},
            ]}, _stats())
        d = r["data"]
        assert d["results"][0]["error"] == "not_allowed"
        assert d["results"][1]["error"] == "not_allowed"
        assert d["results"][2]["ok"] is True  # 坏步骤不拖垮好步骤

    def test_over_five_steps_truncated(self):
        steps = [{"tool": "get_current_time", "args": {}}] * 7
        r = _loop()._execute_tool("run_plan", {"steps": steps}, _stats())
        d = r["data"]
        assert d["total"] == 6  # 5 执行 + 1 条超限说明
        assert d["results"][-1]["error"] == "over_limit"

    def test_step_exception_isolated(self):
        r = _loop()._execute_tool("run_plan", {
            "steps": [
                {"tool": "fetch_url", "args": {"url": "http://bad/x"}},
                {"tool": "search_web", "args": {"query": "ok"}},
            ]}, _stats())
        d = r["data"]
        assert d["results"][0]["ok"] is False
        assert d["results"][1]["ok"] is True


class TestSpawnReader:
    def test_bad_args(self):
        assert _loop()._execute_tool("spawn_reader", {"question": "", "urls": ["http://a"]}, _stats())["success"] is False
        assert _loop()._execute_tool("spawn_reader", {"question": "q", "urls": []}, _stats())["success"] is False

    def test_parallel_read_and_excerpt(self, monkeypatch):
        # fetch_url 分支带 SSRF 校验——测试 URL 是假域名，stub 掉分类放行
        import core.search_engine as _se
        monkeypatch.setattr(_se, "classify_url", lambda url: ("public", ""))
        r = _loop()._execute_tool("spawn_reader", {
            "question": "桌伴的本地优先隐私保护",
            "urls": ["http://x/1", "http://x/2", "http://bad/3"]}, _stats())
        d = r["data"]
        assert r["success"] is True
        assert d["total"] == 3 and d["ok_count"] == 2  # bad URL 不拖垮批次
        first = d["readers"][0]
        assert first["ok"] and "本地优先" in first["excerpt"]  # 关键词窗口命中

    def test_urls_capped_at_five(self):
        r = _loop()._execute_tool("spawn_reader", {
            "question": "桌伴", "urls": ["http://x/%d" % i for i in range(8)]}, _stats())
        assert r["data"]["total"] == 5


class TestKeywordExcerpt:
    def test_hit_window(self):
        text = "无关。\n" * 50 + "桌伴本地优先是核心卖点。\n" + "填充。\n" * 50
        out = al._keyword_excerpt(text, "桌伴本地优先", width=300)
        assert "本地优先" in out

    def test_no_hit_falls_back_to_head(self):
        text = "甲乙丙丁。\n" * 100
        out = al._keyword_excerpt(text, "完全无关的词", width=100)
        assert out == text[:100]

    def test_short_text_passthrough(self):
        assert al._keyword_excerpt("短文本", "任何", width=300) == "短文本"
