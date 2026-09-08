# -*- coding: utf-8 -*-
"""回归：幽灵 import 断头路（十五五实战 MiniMax 暴露，2026-09-08）

背景：cloud_pipeline/agent_loop 曾 import 一个不存在的
pipelines.doc_action.read_document_text——静默 ImportError 后兜底裸读，
把 docx 的 PK 压缩字节当正文灌进模型上下文。
本测试把「不许再出现这个幽灵引用」钉死在 CI 里。
"""
import inspect


class TestPhantomImportRegression:
    def test_no_phantom_read_document_text(self):
        import pipelines.cloud_pipeline as cp
        import core.agent_loop as al
        # 幽灵引用的真实形态是 import 语句（注释里提到名字不算）
        phantom = "from pipelines.doc_action import read_document_text"
        for mod in (cp, al):
            src = inspect.getsource(mod)
            assert phantom not in src, \
                "%s 又出现了幽灵引用 read_document_text" % mod.__name__

    def test_upload_paths_use_file_extractor(self):
        """上传文件预注入必须走统一提取器（docx/pptx/pdf 全格式）。"""
        import pipelines.cloud_pipeline as cp
        src = inspect.getsource(cp)
        assert "knowledge.file_extractor" in src and "extract_text" in src
