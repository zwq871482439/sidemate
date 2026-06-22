# -*- coding: utf-8 -*-
"""
doc_action.py — 文档生成 Action（Patch1 V2 — 两阶段）
=====================================================
两阶段流程：
  Phase 1（提纲）：KB搜索 → 生成提纲 → yield doc_outline → 结束
  Phase 2（正文）：前端带 doc_continue 参数 → 基于提纲生成完整文档 → yield 正文

用户确认流程由前端控制：
  - Phase 1 结束后前端展示提纲 + 确认/取消按钮
  - 用户点确认 → 前端发新请求带 doc_continue=<outline>
  - 用户点取消 → 前端不做任何操作

调用方式：chat.py 的 doc 分支 for 循环 yield run_doc_action() 的产出
"""

import os
import re
import time
import logging
import threading

log = logging.getLogger(__name__)


# 全局 KB 上下文缓存（Phase 1 → Phase 2 传递）
_kb_context_cache = {}
_kb_cache_lock = threading.Lock()


def run_doc_action(
    message: str,
    mgr,           # ModelManager
    model_name: str,
    max_tokens: int = None,
    history: list = None,
    kb=None,       # KnowledgeBase 实例
    context_cache: dict = None,
    strategy_enhancement: str = "",
    doc_continue: str = "",  # Phase 2: 用户确认的提纲内容
    kb_doc_content: str = "",  # 用户引用的 KB 文档全文
):
    """
    执行文档生成 Action（两阶段）。

    Phase 1 (doc_continue 为空):
      1. KB 搜索
      2. 模型生成提纲
      3. yield ("doc_outline", outline_text) → 结束

    Phase 2 (doc_continue 不为空):
      1. 基于提纲 + KB 上下文生成完整文档
      2. yield 正文 token 流

    Yields:
        (phase, content) — 兼容 chat_stream 接口
    """
    # ====== Phase 2: 基于已确认提纲生成完整文档 ======
    if doc_continue:
        yield from _run_phase2(
            message, mgr, model_name, max_tokens, history,
            context_cache, strategy_enhancement, doc_continue,
            kb_doc_content=kb_doc_content
        )
        return

    # ====== Phase 1: 生成提纲 ======
    yield from _run_phase1(
        message, mgr, model_name, max_tokens, history,
        kb, context_cache, strategy_enhancement,
        kb_doc_content=kb_doc_content
    )


def _run_phase1(
    message, mgr, model_name, max_tokens, history,
    kb, context_cache, strategy_enhancement,
    kb_doc_content=""
):
    """Phase 1: KB搜索 → 生成提纲 → yield doc_outline"""

    # Step 1: KB 自动搜索
    kb_context = ""
    kb_refs = []
    if kb:
        try:
            kb_loaded = getattr(kb, '_embedder_loaded', False)
            if kb_loaded:
                yield ("mode_hint", " 正在搜索文库...")
                kb_result = kb.query(message, top_k=3)
                if kb_result and kb_result.get("results"):
                    kb_refs = kb_result["results"]
                    kb_context_parts = []
                    for i, ref in enumerate(kb_refs[:3]):
                        kb_context_parts.append("[参考资料%d] %s" % (i + 1, ref.get("content", "")[:500]))
                    kb_context = "\n\n".join(kb_context_parts)
                    log.info("[DOC_ACTION] KB 搜索到 %d 条参考资料" % len(kb_refs))
                else:
                    yield ("mode_hint", "文库中未找到相关内容，将直接生成文档。")
        except Exception as e:
            log.warning("[DOC_ACTION] KB 搜索失败: %s" % str(e)[:100])

    # 缓存 KB 上下文（Phase 2 会用到）
    with _kb_cache_lock:
        _kb_context_cache["last"] = kb_context
        _kb_context_cache["refs_count"] = len(kb_refs)

    # Step 2: 生成提纲
    yield ("mode_hint", " 正在生成文档提纲...")

    from prompts import DOC_OUTLINE_PROMPT
    outline_prompt = DOC_OUTLINE_PROMPT.format(user_request=message)

    # 注入用户引用的 KB 文档全文（最高优先级，放在 prompt 开头）
    if kb_doc_content:
        outline_prompt = "[用户引用了文库文档，内容如下：]\n%s\n\n%s" % (kb_doc_content, outline_prompt)
        log.info("[DOC_ACTION] 用户引用 KB 文档注入 Phase1: %d 字" % len(kb_doc_content))

    if kb_context:
        outline_prompt = "%s\n\n[以下是文库检索到的参考资料：]\n%s\n\n请结合以上参考资料生成提纲。" % (
            outline_prompt, kb_context)

    # 收集提纲文本
    outline_text = ""
    for phase, content in mgr.chat_stream(
        outline_prompt, model_name, max_tokens or 1024, history,
        context_cache=context_cache,
        strategy_enhancement=strategy_enhancement,
    ):
        if phase == "text":
            outline_text += content
            yield ("text", content)  # 流式展示提纲
        elif phase == "raw":
            outline_text += content
            yield ("text", content)
        elif phase == "fold":
            yield ("fold", content)
        elif phase == "task_type":
            yield (phase, content)

    if not outline_text.strip():
        yield ("mode_hint", "提纲生成失败，请重试。")
        return

    # Step 3: yield 提纲确认事件（前端会展示确认/取消按钮）
    log.info("[DOC_ACTION] 提纲生成完成 (%d 字)" % len(outline_text))
    yield ("doc_outline", outline_text.strip())


def _run_phase2(
    message, mgr, model_name, max_tokens, history,
    context_cache, strategy_enhancement, outline,
    kb_doc_content=""
):
    """Phase 2: 基于已确认的提纲生成完整文档"""

    yield ("mode_hint", " 正在基于提纲生成完整文档...")

    from prompts import DOC_FULL_PROMPT

    # 获取 Phase 1 缓存的 KB 上下文
    with _kb_cache_lock:
        kb_context = _kb_context_cache.pop("last", "")

    full_prompt = DOC_FULL_PROMPT.format(user_request=message, outline=outline)

    # 注入用户引用的 KB 文档全文（Phase 2 也需要）
    if kb_doc_content:
        full_prompt = "[用户引用了文库文档，内容如下：]\n%s\n\n%s" % (kb_doc_content, full_prompt)
        log.info("[DOC_ACTION] 用户引用 KB 文档注入 Phase2: %d 字" % len(kb_doc_content))

    if kb_context:
        full_prompt = "%s\n\n[以下是可参考的文库资料：]\n%s" % (full_prompt, kb_context)

    # 流式生成正文
    for phase, content in mgr.chat_stream(
        full_prompt, model_name, max_tokens, history,
        context_cache=context_cache,
        strategy_enhancement=strategy_enhancement,
    ):
        yield (phase, content)

    log.info("[DOC_ACTION] 完整文档生成完成")


def cancel_doc_action():
    """取消当前文档生成 Action（兼容旧调用）"""
    log.info("[DOC_ACTION] 收到取消请求")


# ============================================================
#  Markdown → .docx 转换
# ============================================================

def _parse_markdown_to_sections(md_text: str):
    """将 Markdown 文本解析为 (title, sections) 结构

    Returns:
        (title, [(heading, body), ...])
    """
    lines = md_text.strip().split('\n')
    title = "文档"
    sections = []
    current_heading = None
    current_body_lines = []

    for line in lines:
        if line.startswith('# ') and not line.startswith('## '):
            title = line.lstrip('# ').strip()
            continue
        if line.startswith('## '):
            if current_heading is not None or current_body_lines:
                sections.append((current_heading or "概述", '\n'.join(current_body_lines).strip()))
            current_heading = line.lstrip('# ').strip()
            current_body_lines = []
            continue
        current_body_lines.append(line)

    if current_heading is not None or current_body_lines:
        body = '\n'.join(current_body_lines).strip()
        if body:
            # Patch5 修复：没标题就留空，不强加"总结"
            # 让模型自己决定要不要加标题
            sections.append((current_heading or "", body))

    if not sections and md_text.strip():
        # 兜底：纯文本无标题，整个作为正文
        sections.append(("", md_text.strip()))

    return title, sections


def generate_docx(content: str, output_path: str, title: str = "文档"):
    """将 AI 生成的 Markdown 内容转换为 .docx 文件"""
    from docx import Document
    from docx.shared import Pt
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    doc_title, sections = _parse_markdown_to_sections(content)
    doc = Document()

    # Patch4：统一字体（正文和标题都用同一套）
    _FONT_CN = '等线'
    _FONT_EN = 'Calibri'
    _FONT_SIZE = Pt(11)

    # Patch4 v3.1 BUG#16 根治：覆盖 docDefaults 的 theme 字体
    # Word 默认 docDefaults 用 minorEastAsia 主题（映射到 MS Gothic 等日文字体）
    # 必须直接改 docDefaults，否则没显式设字体的段落（如 Title）会用默认日文字体
    from lxml import etree
    _W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
    _doc_defaults = doc.styles.element.find('{%s}docDefaults' % _W_NS)
    if _doc_defaults is not None:
        _rpr_default = _doc_defaults.find('{%s}rPrDefault' % _W_NS)
        if _rpr_default is None:
            _rpr_default = etree.SubElement(_doc_defaults, '{%s}rPrDefault' % _W_NS)
        _rpr = _rpr_default.find('{%s}rPr' % _W_NS)
        if _rpr is None:
            _rpr = etree.SubElement(_rpr_default, '{%s}rPr' % _W_NS)
        _rfonts = _rpr.find('{%s}rFonts' % _W_NS)
        if _rfonts is None:
            _rfonts = etree.SubElement(_rpr, '{%s}rFonts' % _W_NS)
        # 覆盖 theme 引用为显式字体名
        _rfonts.set('{%s}ascii' % _W_NS, _FONT_EN)
        _rfonts.set('{%s}hAnsi' % _W_NS, _FONT_EN)
        _rfonts.set('{%s}eastAsia' % _W_NS, _FONT_CN)
        _rfonts.set('{%s}cs' % _W_NS, _FONT_EN)
        # 删除 theme 属性
        for _attr in ['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme']:
            _full = '{%s}%s' % (_W_NS, _attr)
            if _full in _rfonts.attrib:
                del _rfonts.attrib[_full]

    # 设置 Normal 样式
    style = doc.styles['Normal']
    style.font.name = _FONT_EN
    style.font.size = _FONT_SIZE
    style.element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
    # Patch4 v3.1 BUG#16：Title 样式也设字体（否则标题用 Word 默认字体，不统一）
    _title_style = doc.styles['Title']
    _title_style.font.name = _FONT_EN
    _title_style.element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
    # 设置 Heading 样式
    for level in range(1, 5):
        hstyle = doc.styles['Heading %d' % level]
        hstyle.font.name = _FONT_EN
        hstyle.element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)

    title_para = doc.add_heading(doc_title or title, level=0)
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER

    for heading, body in sections:
        if heading:
            doc.add_heading(heading, level=1)
        if not body:
            continue
        paragraphs = re.split(r'\n{2,}', body)
        for para_text in paragraphs:
            para_text = para_text.strip()
            if not para_text:
                continue
            list_items = []
            for line in para_text.split('\n'):
                line = line.strip()
                if not line:
                    continue
                if re.match(r'^\d+[.、．)\s]', line):
                    list_items.append(re.sub(r'^\d+[.、．)\s]+', '', line))
                elif re.match(r'^[-*•]\s', line):
                    list_items.append(re.sub(r'^[-*•]\s+', '', line))
                else:
                    list_items.append(line)
            for item in list_items:
                p = doc.add_paragraph()
                parts = re.split(r'(\*\*[^*]+\*\*)', item)
                for part in parts:
                    if part.startswith('**') and part.endswith('**'):
                        run = p.add_run(part[2:-2])
                        run.bold = True
                        run.font.size = Pt(11)
                        run.font.name = _FONT_EN
                        run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
                    elif part:
                        run = p.add_run(part)
                        run.font.size = Pt(11)
                        run.font.name = _FONT_EN
                        run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)

    doc.save(output_path)
    file_size = os.path.getsize(output_path)
    log.info("[DOC] .docx 生成完成: %s (%d bytes, %d 章节)" % (
        os.path.basename(output_path), file_size, len(sections)))
