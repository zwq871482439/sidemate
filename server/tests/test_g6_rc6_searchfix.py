# -*- coding: utf-8 -*-
"""#89 联网搜索垃圾结果（PM 复查）：Bing 反爬异常页的导航链接被当结果返回。

先红后绿：垃圾判定 / 噪音表纳入 / Bing 解析最少条数闸门 / Baidu 同过滤。
真实网络行为已人工复现：同查询 Bing 解析出 wap.baidu.com 等首页（10 条），
百度兜底 7 条全切题——修后 Bing 异常页返回空，正确落到兜底。
"""
import os
import sys
import unittest

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

import pytest

from core.search_engine import SearchEngine, _is_junk_result


class TestJunkResultDetection(unittest.TestCase):
    def test_engine_nav_homepages_are_junk(self):
        for u in ("https://wap.baidu.com/", "https://www.baidu.com",
                  "https://map.baidu.com/", "https://cn.bing.com/",
                  "http://talent.zhipu.ai/login/", "https://x.com/signin"):
            self.assertTrue(_is_junk_result(u), u)

    def test_normal_results_not_junk(self):
        for u in ("https://www.baidu.com/link?url=abc123",
                  "https://baike.baidu.com/item/%E5%88%AE%E4%BA%94%E6%8C%87",
                  "https://www.example.com/article/123",
                  "https://dict.example.com/word" ):
            self.assertFalse(_is_junk_result(u), u)

    def test_empty_url_is_junk(self):
        self.assertTrue(_is_junk_result(""))
        self.assertTrue(_is_junk_result(None))


class TestNoiseIncludesJunk(unittest.TestCase):
    def test_is_noise_catches_junk(self):
        se = SearchEngine.__new__(SearchEngine)
        self.assertTrue(se._is_noise({"url": "https://wap.baidu.com/", "title": "百度一下"}))
        self.assertTrue(se._is_noise({"url": "http://x.com/login/", "title": "登录"}))
        self.assertFalse(se._is_noise({"url": "https://www.a.com/p/1", "title": "刮五指手法"}))


class TestParserGuards(unittest.TestCase):
    def test_bing_parser_has_junk_filter_and_min_gate(self):
        src = open(os.path.join(_SERVER_DIR, "core", "search_engine.py"), encoding="utf-8").read()
        i = src.index("def _bing_search")
        seg = src[i:i + 3600]
        self.assertIn("if _is_junk_result(link):", seg)
        self.assertIn("return results if len(results) >= 3 else []", seg,
                      "解析少于 3 条必须返回空触发兜底")

    def test_baidu_parser_has_junk_filter(self):
        src = open(os.path.join(_SERVER_DIR, "core", "search_engine.py"), encoding="utf-8").read()
        i = src.index("def _baidu_search")
        seg = src[i:i + 3000]
        self.assertIn("if _is_junk_result(link):", seg)




class TestQueryRelevanceGate(unittest.TestCase):
    """#89 核心：与查询零相关的「伪 SERP」必须被丢弃并降级"""

    def test_nav_pages_irrelevant(self):
        se = SearchEngine.__new__(SearchEngine)
        junk = [
            {"title": "百度一下", "url": "https://wap.baidu.com/", "snippet": "全球最大的中文搜索引擎"},
            {"title": "微信网页版", "url": "https://wx.qq.com/", "snippet": "WeChat for Web"},
            {"title": "百度地图", "url": "https://map.baidu.com/", "snippet": "浏览地图查询线路"},
        ]
        self.assertFalse(se._results_match_query("中医 刮五指 手法 怎么做", junk))

    def test_real_serp_relevant(self):
        se = SearchEngine.__new__(SearchEngine)
        good = [
            {"title": "中医教你刮五指，疏通五脏", "url": "https://a.com/1", "snippet": "刮五指手法：从指根到指尖"},
            {"title": "手指刮痧的顺序图", "url": "https://b.com/2", "snippet": "刮五指对应经络"},
        ]
        self.assertTrue(se._results_match_query("中医 刮五指 手法 从指根到指尖", good))

    def test_empty_query_passes(self):
        se = SearchEngine.__new__(SearchEngine)
        self.assertTrue(se._results_match_query("", [{"title": "x", "url": "https://a.com", "snippet": ""}]))

    def test_chain_has_gates_at_all_levels(self):
        src = open(os.path.join(_SERVER_DIR, "core", "search_engine.py"), encoding="utf-8").read()
        self.assertGreaterEqual(src.count("_results_match_query"), 4,
                                "三级链（Bing/改写/百度）都要过相关性闸门（含定义）")
        self.assertIn("百度兜底结果与查询无关", src)

if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
