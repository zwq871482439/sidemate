# -*- coding: utf-8 -*-
"""P0 #52 六轮场景验收缺口的四项修复（先红后绿）。"""
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core.file_converter import convert, READABLE, WRITABLE


class TestCalculatorErrorPath(unittest.TestCase):
    def test_error_message_template_no_double_crash(self):
        """calculator 求值失败时错误消息模板不得被 %-格式化二次炸掉。"""
        src = Path(__file__).parents[1].joinpath("core", "agent_loop.py").read_text(encoding="utf-8")
        self.assertIn("仅支持 + - * / %% 和括号", src,
                      "错误模板的字面 % 未转义为 %%（二次崩溃回归）")


class TestThinkOnlyRescue(unittest.TestCase):
    def test_rescue_logic_present(self):
        """think-only（思考非空+正文空）必须先续跑一轮再落兜底文案。"""
        src = Path(__file__).parents[1].joinpath("pipelines", "cloud_pipeline.py").read_text(encoding="utf-8")
        self.assertIn("think-only 续跑成功", src, "缺 think-only 续跑逻辑")
        i_rescue = src.find("think-only 续跑成功")
        i_fallback = src.find("抱歉，Agent 未能生成有效回复")
        self.assertTrue(0 < i_rescue < i_fallback, "续跑必须先于兜底文案")

    def test_render_d2_hint_present(self):
        """工具提示必须引导「用户要图表→render_d2」（六轮实测两轮未触发）。"""
        src = Path(__file__).parents[1].joinpath("core", "agent_tools.py").read_text(encoding="utf-8")
        self.assertIn("必须用 render_d2", src)


class TestHtmlToPdf(unittest.TestCase):
    """html→pdf 直通道（Edge 无头打印，Windows 10+ 自带）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="p0pdf_")
        html = ("<!doctype html><html><head><meta charset='utf-8'></head>"
                "<body><h1>客户人效分析</h1><p>PDF 转换验证：折线图占位。</p></body></html>")
        self.src = os.path.join(self.tmp, "报告.html")
        with open(self.src, "w", encoding="utf-8") as f:
            f.write(html)
        self.dst = os.path.join(self.tmp, "报告.pdf")

    def test_formats_registered(self):
        self.assertIn("html", READABLE)
        self.assertIn("pdf", WRITABLE)

    def test_html_to_pdf_real_conversion(self):
        r = convert(self.src, self.dst)
        self.assertTrue(r.get("ok"), "转换失败: %s" % r.get("error"))
        self.assertTrue(os.path.exists(self.dst) and os.path.getsize(self.dst) > 500,
                        "PDF 未生成或过小")

    def test_md_to_pdf(self):
        dst = os.path.join(self.tmp, "note.pdf")
        src = os.path.join(self.tmp, "note.md")
        with open(src, "w", encoding="utf-8") as f:
            f.write("# 标题\n\n正文内容第一段。")
        r = convert(src, dst)
        self.assertTrue(r.get("ok"), r.get("error"))


if __name__ == "__main__":
    unittest.main(verbosity=2)
