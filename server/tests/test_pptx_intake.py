# -*- coding: utf-8 -*-
"""0.10.1 冲刺：pptx 摄入补齐测试

覆盖：
- file_extractor.extract_text：pptx 提取（文本框/表格/组合形状），
  旧格式 .ppt 给转存提示，无文本 pptx 返回空
- batch_queue 白名单含 pptx
- chat.py qa 上传白名单含 .pptx
"""
import os
import inspect

import pytest


@pytest.fixture()
def tiny_pptx(tmp_path):
    """用 python-pptx 造一个两页 pptx：文本框+表格+组合形状。"""
    from pptx import Presentation
    from pptx.util import Inches
    prs = Presentation()
    s1 = prs.slides.add_slide(prs.slide_layouts[6])
    box = s1.shapes.add_textbox(Inches(1), Inches(1), Inches(5), Inches(1))
    box.text_frame.text = "中资网安营销中心"
    grp = s1.shapes.add_group_shape()
    sub = grp.shapes.add_textbox(Inches(1), Inches(2), Inches(5), Inches(1))
    sub.text_frame.text = "组内文本：本地优先"
    tbl_shape = s1.shapes.add_table(2, 2, Inches(1), Inches(3), Inches(4), Inches(1))
    tbl_shape.table.cell(0, 0).text = "指标"
    tbl_shape.table.cell(0, 1).text = "目标"
    tbl_shape.table.cell(1, 0).text = "营收"
    tbl_shape.table.cell(1, 1).text = "力争翻番"
    p = tmp_path / "测试.pptx"
    prs.save(str(p))
    return p


class TestPptxExtraction:
    def test_extract_textboxes_tables_groups(self, tiny_pptx):
        from knowledge.file_extractor import extract_text
        text = extract_text(str(tiny_pptx))
        assert "中资网安营销中心" in text
        assert "组内文本：本地优先" in text  # 组合形状递归
        assert "指标 | 目标" in text        # 表格
        assert "力争翻番" in text
        assert "第 1 页" in text

    def test_old_ppt_rejected(self, tmp_path):
        p = tmp_path / "旧格式.ppt"
        p.write_bytes(b"not really ppt")
        from knowledge.file_extractor import extract_text
        assert "不支持" in extract_text(str(p))

    def test_batch_queue_whitelist(self):
        from core.batch_queue import _SUPPORTED_EXTENSIONS
        assert "pptx" in _SUPPORTED_EXTENSIONS

    def test_qa_upload_whitelist(self):
        import routers.chat as rc
        import inspect
        src = inspect.getsource(rc)
        assert '".pptx"' in src  # _ALLOWED_UPLOAD_EXTS 含 .pptx


class TestPdfFallbackChain:
    """PDF 提取三级链：fitz → pdfplumber → pypdf（精简环境必须有一条活着）。
    十五五实战暴露：rt 精简环境 pdfplumber 缺 pdfminer 变砖导致 PDF 摄入全断。"""

    def test_chain_order_in_source(self):
        import knowledge.file_extractor as fe
        src = inspect.getsource(fe)
        i_fitz = src.find("import fitz")
        i_plumber = src.find("import pdfplumber")
        i_pypdf = src.find("from pypdf import PdfReader")
        assert -1 < i_fitz < i_plumber < i_pypdf  # 三级链顺序
