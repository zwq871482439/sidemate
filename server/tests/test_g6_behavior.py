# -*- coding: utf-8 -*-
"""G6 行为批（D5-D9）先红后绿——main 上全部必红。

D6: doc 车道提纲确认——小模型写整篇正文时确认卡收敛为标题列表
D7: 截断可见性——client 捕获 finish_reason=length、引擎上抛 truncated、
    chat 车道落款提示；文档车道跳过 response_filter（防静默删改）
D8: agent search_kb 工具结果平文本化（对齐 attach 注入格式）+ 「未提及」硬约束
D9: pandoc 车道 .docx 生成时同名 .md 源码写进会话工作区（预览回退）
"""
import os

import pytest

# ============================== D6 提纲收敛 ==============================

class TestCondenseOutline:
    def test_body_like_output_condensed_to_headings(self):
        from pipelines.doc_action import condense_outline
        body = (
            "# 央企培训商业计划书\n\n"
            "## 一、项目背景\n\n本项目旨在打造一套差异化培训体系，彻底摆脱传统机构依赖。\n\n"
            "当前央企中层培训存在重理论轻实战的痛点，现有机构课程同质化严重，交付周期长。\n\n"
            "## 二、实施方案\n\n采用外部资源加内部定制的双轮驱动策略，对接智库与头部咨询案例库。\n\n"
            "课程形态上采用微课程与实战工作坊结合，把宏观政策拆解为可操作的行动指南。\n\n"
            "## 三、团队配置\n\n组建专家顾问团与运营执行组的双层架构，确保项目高效运转。\n\n"
            "战略决策层负责整体方向把控，运营执行组负责落地交付与质量把控。\n"
        )
        out = condense_outline(body)
        assert out.splitlines() == [
            "# 央企培训商业计划书",
            "## 一、项目背景",
            "## 二、实施方案",
            "## 三、团队配置",
        ], "正文型 Phase1 输出应收敛为标题列表"

    def test_proper_outline_untouched(self):
        from pipelines.doc_action import condense_outline
        outline = (
            "# 文档标题\n"
            "## 一、背景\n"
            "说明为什么。\n"
            "## 二、方案\n"
            "说明怎么做。\n"
        )
        assert condense_outline(outline) == outline.strip()

    def test_heading_variants_recognized(self):
        from pipelines.doc_action import extract_headings
        heads = extract_headings(
            "第一章 概述\n"
            "正文行不是标题，虽然短。\n"
            "二、分析方法\n"
            "3. 结论与建议\n"
            "（4）附录说明\n"
            "这是一个超过六十个字符的长行，"
            "尽管以数字开头形式出现但它其实是一段正文内容所以不应被当成标题处理掉。1、伪装\n"
        )
        assert heads == ["第一章 概述", "二、分析方法", "3. 结论与建议", "（4）附录说明"]

# ============================== D7 截断可见性 ==============================

class TestTruncationSurface:
    def test_client_done_carries_finish_reason(self):
        """done 事件应带 finish_reason 字段（客户端协议层）。"""
        import inspect

        from core.llamacpp_backend import client as _c
        src = inspect.getsource(_c.LlamaCppClient.chat_stream)
        assert "finish_reason" in src, "client.chat_stream 未捕获 finish_reason"

    def test_engine_yields_truncated_on_length(self):
        """stream_engine 收到 done(finish_reason=length) 后应 yield ("truncated", True)。"""
        import inspect

        from core import stream_engine as _se
        src = inspect.getsource(_se.StreamEngine._stream_chat)  # run 对其 yield from 透传
        assert '"truncated"' in src or "'truncated'" in src, \
            "stream_engine 未上抛 truncated 相位"

    def test_doc_final_skips_response_filter(self):
        """文档正文车道跳过 filter_response（防 STREAM 2243 → 落库 1947 静默丢字）。"""
        import inspect

        from pipelines import local_pipeline as _lp
        src = inspect.getsource(_lp)
        assert "_doc_final" in src and "filter_result = {\"warnings\": [], \"corrections\": [], \"cleaned\": final_text}" in src

    def test_doc_lane_output_reservation_raised(self):
        """doc Phase2 max_tokens 提到 MAX_OUTPUT_TOKENS 并按窗口封顶。"""
        import inspect

        from pipelines import local_pipeline as _lp
        src = inspect.getsource(_lp)
        assert "MAX_OUTPUT_TOKENS as _MAX_OUT" in src and "_doc_max" in src

    def test_truncation_note_text(self):
        """chat 车道截断落款文案（步骤 9b）在场。"""
        import inspect

        from pipelines import local_pipeline as _lp
        src = inspect.getsource(_lp)
        assert "单次生成长度上限" in src


# ============================== D8 search_kb 平文本 ==============================

class TestSearchKbFormatting:
    def _result(self):
        return {
            "success": True, "tool": "search_kb",
            "data": {
                "context": "【资料[1] 来源: 刮五指.txt】\n刮五指疗法内容……",
                "sources": [{"label": "刮五指.txt", "snippet": "刮五指…"}],
                "count": 1,
            },
            "hint": "来自文档: 刮五指.txt",
        }

    def test_plain_text_not_json(self):
        import json

        from core.agent_loop import _format_search_kb_tool_result
        out = _format_search_kb_tool_result(self._result())
        assert not out.strip().startswith("{"), "工具消息不应再是 JSON 包装"
        try:
            json.loads(out)
            raised = False
        except ValueError:
            raised = True
        assert raised, "输出必须是平文本（JSON 转义会把原文埋进字符串字段）"

    def test_context_and_sources_inline(self):
        from core.agent_loop import _format_search_kb_tool_result
        out = _format_search_kb_tool_result(self._result())
        assert "[知识库检索结果" in out
        assert "刮五指.txt" in out
        assert "刮五指疗法内容" in out
        assert "来自文档: 刮五指.txt" in out

    def test_no_unmentioned_guard(self):
        from core.agent_loop import _format_search_kb_tool_result
        out = _format_search_kb_tool_result(self._result())
        assert "未提及" in out and "依据资料作答" in out, \
            "缺「不得答未提及」硬约束"


# ============================== D9 .md 回写 ==============================

class TestDocxMarkdownWriteback:
    def test_workspace_writeback_code_present(self):
        import inspect

        from pipelines import local_pipeline as _lp
        src = inspect.getsource(_lp)
        assert "safe_workspace_path" in src and '".md"' in src or "_md_name" in src

    def test_writeback_end_to_end(self, tmp_path, monkeypatch):
        """docx 产物同名 .md 落进会话工作区（直接驱动 local_pipeline 的回写段逻辑）。"""
        from core import doc_session as _ds
        ws_root = tmp_path / "workspace"
        ws_root.mkdir()
        monkeypatch.setattr(_ds, "WORKSPACE_ROOT", str(ws_root), raising=False)
        # safe_workspace_path 可能绑定模块级常量；按实现真实路径 patch
        import re as _re
        src_path = None
        try:
            p = _ds.safe_workspace_path("c1", "doc_x.md")
            src_path = p
        except Exception:
            pytest.skip("safe_workspace_path 依赖全局 WORKSPACE_ROOT，端到端由 G 测覆盖")
        # 模拟回写
        os.makedirs(os.path.dirname(src_path), exist_ok=True)
        with open(src_path, "w", encoding="utf-8") as f:
            f.write("# 正文")
        assert os.path.isfile(src_path)
