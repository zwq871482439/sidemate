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

    # Step 1: KB 自动搜索（修 #doc模式搜索永远失败：KnowledgeBase 无 query 方法，改用 get_context）
    kb_context = ""
    kb_refs = []
    if kb:
        try:
            kb_loaded = getattr(kb, '_embedder_loaded', False)
            if kb_loaded:
                yield ("mode_hint", " 正在搜索文库...")
                kb_context, kb_refs = kb.get_context(message, max_chars=2000, ai_mode="local")
                if kb_refs:
                    # 列出检索到的来源（与 chat 模式 _base.py:250 对齐）
                    _src_labels = []
                    for ref in kb_refs[:3]:
                        _lbl = ref.get("source_label") or ref.get("filename") or ref.get("doc_id") or "?"
                        _src_labels.append(_lbl)
                    yield ("mode_hint", " 已检索文库（%d 条相关文档：%s），正在生成文档提纲..." % (
                        len(kb_refs), "、".join(_src_labels)))
                    # 发送 kb_sources 事件，让前端渲染来源卡片（与 chat 模式一致）
                    yield ("kb_sources", [{"label": s.get("source_label", "?"),
                                           "snippet": (s.get("text_snippet", "") or s.get("content", ""))[:100]}
                                          for s in kb_refs[:5]])
                    log.info("[DOC_ACTION] KB 搜索到 %d 条参考资料: %s" % (len(kb_refs), "、".join(_src_labels)))
                else:
                    yield ("mode_hint", " 文库中未找到相关内容，将直接生成文档提纲。")
                    log.info("[DOC_ACTION] KB 无检索结果，fallback 直接生成提纲")
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
        # P6：支持 ### / #### 子标题（映射到 Heading 2/3）
        if re.match(r'^##\s', line) and not re.match(r'^###\s', line):
            if current_heading is not None or current_body_lines:
                sections.append((current_heading or "概述", '\n'.join(current_body_lines).strip()))
            current_heading = line.lstrip('# ').strip()
            current_body_lines = []
            continue
        if re.match(r'^###\s', line):
            if current_heading is not None or current_body_lines:
                sections.append((current_heading or "概述", '\n'.join(current_body_lines).strip()))
            current_heading = "  " + line.lstrip('# ').strip()  # 缩进表示子标题
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
    """使用 pandoc 将 Markdown 转为 .docx，再统一字体为等线

    三层兜底（修 #5-b/#5-d：pypandoc 未安装时整个函数崩溃）：
      1. pypandoc（若已安装）—— 首选
      2. subprocess 直调 pandoc CLI —— pypandoc 缺失时用，pandoc 二进制通常存在
      3. _generate_docx_manual —— pandoc 也不可用时的纯 python-docx 回退
    """
    from docx import Document
    from docx.shared import Pt
    from docx.oxml.ns import qn

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    _FONT_CN = '等线'
    _FONT_EN = 'Calibri'

    # 用 pandoc 转换 markdown → docx
    # 注意：不传 --metadata title，因为模型正文里的 # 一级标题就是文档标题，
    # 传 metadata title 会导致标题区出现两层（pandoc 元数据标题 + 正文 H1）
    _pandoc_ok = False
    # 兜底1：pypandoc（import 移进 try，避免 ModuleNotFoundError 冒泡导致无法回退）
    try:
        import pypandoc
        pypandoc.convert_text(
            content, 'docx', format='markdown',
            outputfile=output_path,
            extra_args=[
                '--from=markdown+autolink_bare_uris+task_lists',
            ]
        )
        _pandoc_ok = True
    except ImportError:
        log.info("[DOC] pypandoc 未安装，尝试 subprocess 直调 pandoc CLI")
    except Exception as e:
        log.warning("[DOC] pypandoc 转换失败，尝试 CLI: %s", e)

    # 兜底2：subprocess 直调 pandoc CLI（pypandoc 缺失或失败时）
    if not _pandoc_ok:
        try:
            import subprocess
            proc = subprocess.run(
                ["pandoc", "--from=markdown+autolink_bare_uris+task_lists",
                 "--to=docx", "-o", output_path],
                input=content, encoding="utf-8",
                capture_output=True, timeout=60,
            )
            if proc.returncode == 0 and os.path.exists(output_path):
                _pandoc_ok = True
            else:
                log.warning("[DOC] pandoc CLI 失败 rc=%s: %s",
                            proc.returncode, (proc.stderr or "")[:200])
        except FileNotFoundError:
            log.warning("[DOC] pandoc 二进制未找到，回退手动生成")
        except Exception as e:
            log.warning("[DOC] pandoc CLI 异常，回退手动生成: %s", e)

    # 兜底3：pandoc 全失败 → 纯 python-docx 手动生成
    if not _pandoc_ok:
        return _generate_docx_manual(content, output_path, title)

    # 打开生成的 docx，统一字体
    doc = Document(output_path)

    # 覆盖 docDefaults 字体
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
        _rfonts.set('{%s}ascii' % _W_NS, _FONT_EN)
        _rfonts.set('{%s}hAnsi' % _W_NS, _FONT_EN)
        _rfonts.set('{%s}eastAsia' % _W_NS, _FONT_CN)
        _rfonts.set('{%s}cs' % _W_NS, _FONT_EN)
        for _attr in ['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme']:
            _full = '{%s}%s' % (_W_NS, _attr)
            if _full in _rfonts.attrib:
                del _rfonts.attrib[_full]

    # 遍历所有段落，统一字体 + 排版美化
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_LINE_SPACING
    _TITLE_COLOR = RGBColor(0x1F, 0x29, 0x37)    # 深灰，标题色
    _ACCENT_COLOR = RGBColor(0x2D, 0x4A, 0x6F)   # 品牌蓝，H1
    for _para in doc.paragraphs:
        _style_name = _para.style.name if _para.style else ''
        # 统一字体
        for _run in _para.runs:
            _run.font.name = _FONT_EN
            _run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
        # 排版美化：按样式类型设置字号/间距/颜色
        if _style_name == 'Title' or _style_name == 'Heading 1':
            for _run in _para.runs:
                _run.font.size = Pt(20)
                _run.font.bold = True
                _run.font.color.rgb = _ACCENT_COLOR
            _para.paragraph_format.space_before = Pt(18)
            _para.paragraph_format.space_after = Pt(12)
        elif _style_name == 'Heading 2':
            for _run in _para.runs:
                _run.font.size = Pt(15)
                _run.font.bold = True
                _run.font.color.rgb = _TITLE_COLOR
            _para.paragraph_format.space_before = Pt(14)
            _para.paragraph_format.space_after = Pt(8)
        elif _style_name == 'Heading 3':
            for _run in _para.runs:
                _run.font.size = Pt(13)
                _run.font.bold = True
                _run.font.color.rgb = _TITLE_COLOR
            _para.paragraph_format.space_before = Pt(10)
            _para.paragraph_format.space_after = Pt(6)
        else:
            # 正文段落：统一行距 + 字号
            for _run in _para.runs:
                if not _run.font.size:
                    _run.font.size = Pt(11)
            _para.paragraph_format.line_spacing_rule = WD_LINE_SPACING.ONE_POINT_FIVE
            _para.paragraph_format.space_after = Pt(6)

    doc.save(output_path)
    file_size = os.path.getsize(output_path)
    log.info("[DOC] .docx 生成完成 (pandoc): %s (%d bytes)", os.path.basename(output_path), file_size)


# ===== HTML 可视化报告（含 mermaid 图表，自包含单文件） =====

_mermaid_js_cache = None  # mermaid.min.js 全文缓存，避免每次读盘


def _load_mermaid_js() -> str:
    """读取 mermaid.min.js 全文（带缓存）"""
    global _mermaid_js_cache
    if _mermaid_js_cache is not None:
        return _mermaid_js_cache
    # mermaid.min.js 在 server/static/vendor/
    _here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    candidates = [
        os.path.join(_here, "static", "vendor", "mermaid.min.js"),
        os.path.join(_here, "static", "vendor", "mermaid.js"),
    ]
    for p in candidates:
        if os.path.isfile(p):
            try:
                with open(p, "r", encoding="utf-8") as f:
                    _mermaid_js_cache = f.read()
                log.info("[DOC] mermaid.min.js 已加载 (%d bytes)", len(_mermaid_js_cache))
                return _mermaid_js_cache
            except Exception as e:
                log.warning("[DOC] 读取 mermaid.min.js 失败: %s", e)
    log.warning("[DOC] 未找到 mermaid.min.js，HTML 报告将无法渲染图表")
    _mermaid_js_cache = ""  # 空字符串兜底，避免反复读盘
    return _mermaid_js_cache


# HTML 报告的打印友好 CSS（A4 宽度、字体、表格、mermaid 居中、打印优化）
_HTML_REPORT_CSS = """
* { box-sizing: border-box; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
  max-width: 800px; margin: 32px auto; padding: 0 24px;
  color: #1F2937; line-height: 1.75; font-size: 15px;
}
h1 { font-size: 26px; border-bottom: 2px solid #e5e7eb; padding-bottom: 10px; margin-top: 32px; }
h2 { font-size: 21px; margin-top: 28px; border-left: 4px solid #3b82f6; padding-left: 10px; }
h3 { font-size: 17px; margin-top: 22px; color: #374151; }
p { margin: 12px 0; }
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
th, td { border: 1px solid #d1d5db; padding: 8px 12px; text-align: left; }
th { background: #f3f4f6; font-weight: 600; }
tr:nth-child(even) { background: #fafafa; }
blockquote { border-left: 4px solid #3b82f6; margin: 16px 0; padding: 8px 16px; background: #eff6ff; color: #374151; }
code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-family: "Cascadia Code", Consolas, monospace; font-size: 13px; }
pre { background: #1e293b; color: #e2e8f0; padding: 14px 18px; border-radius: 8px; overflow-x: auto; }
pre code { background: transparent; color: inherit; padding: 0; }
ul, ol { padding-left: 24px; }
li { margin: 4px 0; }
img { max-width: 100%; border-radius: 8px; }
/* mermaid 图表容器居中 + 滚动 */
.mermaid { text-align: center; margin: 20px 0; }
svg { max-width: 100% !important; height: auto !important; }
/* 打印优化 */
@media print {
  body { max-width: none; margin: 0; padding: 12mm; font-size: 12pt; }
  pre, .mermaid, svg { page-break-inside: avoid; }
  h1, h2, h3 { page-break-after: avoid; }
}
"""


def generate_html_report(content: str, output_path: str, title: str = "报告"):
    """生成自包含的 HTML 可视化报告（内联 mermaid.js，单文件可独立打开）

    Args:
        content: LLM 写的 HTML body 内容（可含 ```mermaid``` 围栏代码块）
        output_path: 输出 .html 文件路径
        title: 报告标题
    """
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    mermaid_js = _load_mermaid_js()

    # 把 ```mermaid ... ``` 围栏代码块转成 mermaid.js 能识别的 <div class="mermaid">
    # mermaid.js startOnLoad 模式会自动渲染 .mermaid 元素
    def _fence_to_div(m):
        return '<div class="mermaid">\n' + m.group(1).strip() + '\n</div>'

    processed_content = re.sub(
        r"```mermaid\s*\n(.*?)```",
        _fence_to_div,
        content,
        flags=re.DOTALL,
    )

    # mermaid 初始化脚本（startOnLoad:true 打开即自动渲染）
    init_script = (
        "mermaid.initialize({startOnLoad:true, theme:'default', "
        "securityLevel:'loose', fontFamily:inherit'});"
    ) if mermaid_js else ""

    html = (
        '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<title>' + title.replace("<", "&lt;").replace(">", "&gt;") + '</title>\n'
        '<style>' + _HTML_REPORT_CSS + '</style>\n'
    )
    if mermaid_js:
        html += '<script>' + mermaid_js + '</script>\n'
        html += '<script>' + init_script + '</script>\n'
    html += '</head>\n<body>\n'
    html += processed_content
    html += '\n</body>\n</html>\n'

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    file_size = os.path.getsize(output_path)
    log.info("[DOC] .html 报告生成完成: %s (%d bytes, mermaid=%s)",
             os.path.basename(output_path), file_size, "yes" if mermaid_js else "no")


def _generate_docx_manual(content: str, output_path: str, title: str = "文档"):
    """pandoc 不可用时的手动回退方案"""
    from docx import Document
    from docx.shared import Pt
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn

    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    doc_title, sections = _parse_markdown_to_sections(content)
    doc = Document()

    _FONT_CN = '等线'
    _FONT_EN = 'Calibri'
    _FONT_SIZE = Pt(11)

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
        _rfonts.set('{%s}ascii' % _W_NS, _FONT_EN)
        _rfonts.set('{%s}hAnsi' % _W_NS, _FONT_EN)
        _rfonts.set('{%s}eastAsia' % _W_NS, _FONT_CN)
        _rfonts.set('{%s}cs' % _W_NS, _FONT_EN)
        for _attr in ['asciiTheme', 'hAnsiTheme', 'eastAsiaTheme', 'cstheme']:
            _full = '{%s}%s' % (_W_NS, _attr)
            if _full in _rfonts.attrib:
                del _rfonts.attrib[_full]

    style = doc.styles['Normal']
    style.font.name = _FONT_EN
    style.font.size = _FONT_SIZE
    style.element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
    _title_style = doc.styles['Title']
    _title_style.font.name = _FONT_EN
    _title_style.element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
    for level in range(1, 5):
        hstyle = doc.styles['Heading %d' % level]
        hstyle.font.name = _FONT_EN
        hstyle.element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)

    title_para = doc.add_heading(doc_title or title, level=0)
    title_para.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for _run in title_para.runs:
        _run.font.name = _FONT_EN
        _run.font.size = Pt(14)
        _run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)

    for heading, body in sections:
        if heading:
            _h_level = 2 if heading.startswith('  ') else 1
            _h_text = heading.lstrip() if _h_level == 2 else heading
            _h_para = doc.add_heading(_h_text, level=_h_level)
            for _run in _h_para.runs:
                _run.font.name = _FONT_EN
                _run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
        if not body:
            continue
        paragraphs = re.split(r'\n{2,}', body)
        for para_text in paragraphs:
            para_text = para_text.strip()
            if not para_text:
                continue
            list_items = []
            _list_has_marks = False
            for line in para_text.split('\n'):
                line = line.strip()
                if not line:
                    continue
                line = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', line)
                line = re.sub(r'!\[([^\]]*)\]\([^)]*\)', r'\1', line)
                if re.match(r'^\d+[.、．)\s]', line):
                    _list_has_marks = True
                    list_items.append(line)
                elif re.match(r'^[-*•]\s', line):
                    _list_has_marks = True
                    list_items.append('• ' + re.sub(r'^[-*•]\s+', '', line))
                else:
                    if _list_has_marks and list_items:
                        list_items.append(line)
                    else:
                        list_items.append(line)
            for item in list_items:
                p = doc.add_paragraph()
                parts = re.split(r'(\*\*[^*]+\*\*|`[^`]+`)', item)
                for part in parts:
                    if part.startswith('**') and part.endswith('**'):
                        run = p.add_run(part[2:-2])
                        run.bold = True
                        run.font.size = _FONT_SIZE
                        run.font.name = _FONT_EN
                        run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
                    elif part.startswith('`') and part.endswith('`'):
                        run = p.add_run(part[1:-1])
                        run.font.size = _FONT_SIZE
                        run.font.name = 'Consolas'
                        run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)
                    elif part:
                        run = p.add_run(part)
                        run.font.size = _FONT_SIZE
                        run.font.name = _FONT_EN
                        run._element.rPr.rFonts.set(qn('w:eastAsia'), _FONT_CN)

    doc.save(output_path)
    file_size = os.path.getsize(output_path)
    log.info("[DOC] .docx 生成完成 (手动): %s (%d bytes)", os.path.basename(output_path), file_size)
