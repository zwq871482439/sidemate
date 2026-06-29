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


# HTML 报告 CSS：基础排版 + 双风格组件库（商务/现代）+ mermaid 交互容器 + 打印优化
# LLM 可按需用这些预设 class，也可自己写 <style> 覆盖
_HTML_REPORT_CSS = """
* { box-sizing: border-box; }
:root {
  --c-primary: #3b82f6; --c-text: #1F2937; --c-muted: #6b7280;
  --c-border: #e5e7eb; --c-bg: #ffffff; --c-bg-soft: #f9fafb; --c-bg-card: #ffffff;
  --radius: 8px; --shadow: 0 1px 3px rgba(0,0,0,.08);
}
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Roboto, sans-serif;
  max-width: 820px; margin: 0 auto; padding: 40px 28px 80px;
  color: var(--c-text); line-height: 1.78; font-size: 15px; background: var(--c-bg);
}
h1 { font-size: 28px; font-weight: 700; margin: 0 0 8px; letter-spacing: -.3px; }
h2 { font-size: 22px; margin: 36px 0 12px; padding-bottom: 8px; border-bottom: 2px solid var(--c-border); }
h3 { font-size: 17px; margin: 24px 0 8px; color: #111827; }
h4 { font-size: 15px; margin: 18px 0 6px; color: #374151; }
p { margin: 10px 0; }
a { color: var(--c-primary); text-decoration: none; }
a:hover { text-decoration: underline; }
hr { border: none; border-top: 1px solid var(--c-border); margin: 28px 0; }

/* 表格 */
table { border-collapse: collapse; width: 100%; margin: 16px 0; font-size: 14px; }
th, td { border: 1px solid var(--c-border); padding: 9px 13px; text-align: left; }
th { background: var(--c-bg-soft); font-weight: 600; color: #374151; }
tr:nth-child(even) { background: #fafbfc; }

/* 代码 */
code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: "Cascadia Code", Consolas, monospace; font-size: 13px; color: #be185d; }
pre { background: #0f172a; color: #e2e8f0; padding: 16px 20px; border-radius: var(--radius); overflow-x: auto; line-height: 1.5; }
pre code { background: transparent; color: inherit; padding: 0; font-size: 13px; }
ul, ol { padding-left: 24px; } li { margin: 5px 0; }
img { max-width: 100%; border-radius: var(--radius); }
blockquote { border-left: 4px solid var(--c-primary); margin: 16px 0; padding: 10px 18px; background: #eff6ff; color: #374151; border-radius: 0 var(--radius) var(--radius) 0; }

/* ===== 预设组件库（LLM 可直接用 class）===== */
/* 提示框：note/tip/warning/danger/success */
.note, .tip, .warning, .danger, .success {
  padding: 12px 16px; margin: 14px 0; border-radius: var(--radius);
  border-left: 4px solid; font-size: 14px;
}
.note { background: #eff6ff; border-color: #3b82f6; color: #1e40af; }
.tip { background: #ecfdf5; border-color: #10b981; color: #065f46; }
.warning { background: #fffbeb; border-color: #f59e0b; color: #92400e; }
.danger { background: #fef2f2; border-color: #ef4444; color: #991b1b; }
.success { background: #f0fdf4; border-color: #22c55e; color: #166534; }

/* 卡片 */
.card { background: var(--c-bg-card); border: 1px solid var(--c-border); border-radius: var(--radius); padding: 18px 20px; margin: 16px 0; box-shadow: var(--shadow); }
.card-title { font-weight: 600; font-size: 16px; margin-bottom: 8px; color: #111827; }

/* 网格布局 */
.grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin: 16px 0; }
.grid-3 { display: grid; grid-template-columns: repeat(3,1fr); gap: 14px; margin: 16px 0; }
@media (max-width: 640px) { .grid-2, .grid-3 { grid-template-columns: 1fr; } }

/* 统计数字块 */
.stats { display: flex; gap: 18px; flex-wrap: wrap; margin: 18px 0; }
.stat { flex: 1; min-width: 120px; background: var(--c-bg-soft); border-radius: var(--radius); padding: 14px 16px; text-align: center; }
.stat-num { font-size: 26px; font-weight: 700; color: var(--c-primary); line-height: 1.2; }
.stat-label { font-size: 12px; color: var(--c-muted); margin-top: 4px; }

/* 标签/徽章 */
.badge { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 12px; font-weight: 500; background: #eff6ff; color: #1e40af; }
.badge.green { background: #ecfdf5; color: #065f46; }
.badge.orange { background: #fffbeb; color: #92400e; }
.badge.red { background: #fef2f2; color: #991b1b; }
.badge.gray { background: #f3f4f6; color: #4b5563; }

/* 进度条 */
.progress { background: var(--c-border); border-radius: 999px; height: 8px; overflow: hidden; margin: 8px 0; }
.progress-bar { background: var(--c-primary); height: 100%; border-radius: 999px; }

/* 时间线 */
.timeline { border-left: 2px solid var(--c-border); padding-left: 20px; margin: 16px 0; }
.timeline-item { margin: 12px 0; position: relative; }
.timeline-item::before { content: ''; position: absolute; left: -26px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--c-primary); }

/* 高亮文本 */
.highlight { background: linear-gradient(transparent 60%, #fde68a 60%); padding: 0 2px; }

/* 现代风格（LLM 在 body 加 class=vibrant 启用） */
body.vibrant {
  background: linear-gradient(135deg, #f0f4ff 0%, #fdf4ff 100%);
  max-width: 900px;
}
body.vibrant h1 { background: linear-gradient(135deg, #3b82f6, #8b5cf6); -webkit-background-clip: text; background-clip: text; color: transparent; }
body.vibrant h2 { border-bottom-color: #c4b5fd; }
body.vibrant .card { border: none; box-shadow: 0 4px 14px rgba(99,102,241,.1); }
body.vibrant .stat { background: rgba(255,255,255,.7); backdrop-filter: blur(4px); }
body.vibrant blockquote { background: linear-gradient(135deg, #eff6ff, #fdf4ff); border-color: #8b5cf6; }

/* ===== mermaid 图表交互容器 ===== */
.chart-frame { border: 1px solid var(--c-border); border-radius: var(--radius); overflow: hidden; margin: 18px 0; position: relative; background: var(--c-bg-soft); }
.cf-hint { position: absolute; top: 6px; right: 8px; font-size: 11px; color: var(--c-muted); background: rgba(255,255,255,.85); padding: 2px 8px; border-radius: 4px; z-index: 5; pointer-events: none; }
.chart-stage { overflow: hidden; cursor: grab; padding: 16px 8px; min-height: 80px; text-align: center; }
.chart-stage:active { cursor: grabbing; }
.chart-stage svg { max-width: none !important; height: auto !important; transition: none; display: inline-block; }
.chart-toolbar { position: absolute; bottom: 6px; right: 6px; display: flex; gap: 2px; align-items: center; background: rgba(255,255,255,.9); border: 1px solid var(--c-border); border-radius: 6px; padding: 2px 4px; font-size: 11px; z-index: 5; opacity: 0; transition: opacity .15s; }
.chart-frame:hover .chart-toolbar { opacity: 1; }
.chart-toolbar button { border: none; background: transparent; cursor: pointer; width: 22px; height: 22px; font-size: 14px; border-radius: 4px; color: var(--c-text); line-height: 1; }
.chart-toolbar button:hover { background: var(--c-border); }
.chart-toolbar .zoom-val { min-width: 36px; text-align: center; color: var(--c-muted); font-variant-numeric: tabular-nums; }

/* ===== 顶部提示条（可关闭）===== */
.report-tipbar { position: sticky; top: 0; z-index: 50; background: linear-gradient(135deg, #3b82f6, #6366f1); color: #fff; padding: 8px 20px; font-size: 13px; display: flex; align-items: center; justify-content: center; gap: 6px; margin: -40px -28px 24px; }
.report-tipbar .tipbar-close { position: absolute; right: 14px; top: 50%; transform: translateY(-50%); cursor: pointer; opacity: .8; font-size: 16px; }
.report-tipbar .tipbar-close:hover { opacity: 1; }

/* 打印优化 */
@media print {
  body { max-width: none; margin: 0; padding: 12mm; font-size: 12pt; background: #fff; }
  .report-tipbar, .chart-toolbar { display: none !important; }
  .chart-stage { overflow: visible !important; }
  .chart-stage svg { transform: none !important; }
  pre, .chart-frame, .card, table { page-break-inside: avoid; }
  h1, h2, h3 { page-break-after: avoid; }
}
"""


def generate_html_report(content: str, output_path: str, title: str = "报告"):
    """生成自包含的 HTML 可视化报告（内联 mermaid.js + 交互，单文件可独立打开）

    - ```mermaid``` 围栏自动转成可缩放/拖拽的交互容器
    - 内联 mermaid.min.js + 交互增强脚本
    - 顶部提示条（滚轮缩放/Ctrl+P 转 PDF，可关闭）
    - 预设 CSS 组件库（note/card/grid/stats/badge 等），LLM 可直接用 class

    Args:
        content: LLM 写的 HTML body 内容（可含 ```mermaid``` 围栏代码块）
        output_path: 输出 .html 文件路径
        title: 报告标题
    """
    os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)

    mermaid_js = _load_mermaid_js()

    # 把 ```mermaid ... ``` 围栏转成空占位 div，源码收集进 JS 数组注入。
    # 不在 DOM 放任何 mermaid 文本/class/data（mermaid.min.js 的 MutationObserver
    # 会扫描并移除它认得的元素），源码全靠 JS 注入。
    import json as _json
    _mermaid_codes = []
    _frame_counter = [0]

    def _fence_to_frame(m):
        code = m.group(1).strip()
        idx = _frame_counter[0]
        _frame_counter[0] += 1
        _mermaid_codes.append(code)
        return (
            '<div class="chart-frame">'
            '<div class="cf-hint">滚轮缩放 · 拖拽移动 · 双击复位</div>'
            '<div class="chart-stage" data-stage>'
            '<div class="chart-slot" data-idx="%d"></div>' % idx +
            '</div>'
            '<div class="chart-toolbar">'
            '<button type="button" data-act="out" title="缩小">−</button>'
            '<span class="zoom-val">100%</span>'
            '<button type="button" data-act="in" title="放大">+</button>'
            '<button type="button" data-act="reset" title="复位">⟲</button>'
            '</div>'
            '</div>'
        )

    processed_content = re.sub(
        r"```mermaid\s*\n(.*?)```",
        _fence_to_frame,
        content,
        flags=re.DOTALL,
    )
    # 源码数组（JSON 序列化，安全转义）
    _codes_json = _json.dumps(_mermaid_codes, ensure_ascii=False)

    # 顶部提示条
    tipbar = (
        '<div class="report-tipbar" id="reportTipbar">'
        '💡 图表支持滚轮缩放/拖拽。需要 PDF/打印？按 <b>Ctrl+P</b> 另存'
        '<span class="tipbar-close" onclick="var t=document.getElementById(\'reportTipbar\');'
        'if(t)t.style.display=\'none\';try{localStorage.setItem(\'reportTipHidden\',\'1\')}catch(e){}">×</span>'
        '</div>'
    )

    # 交互增强脚本（原生 JS，不依赖任何库；验证过的稳定方案）
    # mermaid 源码从注入的 JS 数组读取（不在 DOM 暴露 mermaid 文本）
    interact_js = """
<script>
var _MERMAID_CODES = %s;  // 由 Python 注入的源码数组
function initReportMermaid(){
  if(typeof mermaid==='undefined'){setTimeout(initReportMermaid,50);return;}
  mermaid.initialize({startOnLoad:false,theme:'default',securityLevel:'loose',
    flowchart:{useMaxWidth:false,padding:12}});
  var slots=document.querySelectorAll('.chart-slot[data-idx]');
  slots.forEach(function(slot){
    var idx=parseInt(slot.getAttribute('data-idx')||'0',10);
    var code=_MERMAID_CODES[idx];
    if(!code){enhanceMermaidStage(slot.closest('[data-stage]'));return;}
    var id='m'+idx+'-'+Math.random().toString(36).slice(2,6);
    mermaid.render(id,code).then(function(res){
      slot.innerHTML=res.svg;
      slot.className='chart-rendered';
      enhanceMermaidStage(slot.closest('[data-stage]'));
    }).catch(function(e){
      slot.innerHTML='<pre style="color:#dc2626;font-size:12px">图表渲染失败: '+String(e.message||e).slice(0,150)+'</pre>';
      enhanceMermaidStage(slot.closest('[data-stage]'));
    });
  });
  try{if(localStorage.getItem('reportTipHidden')==='1'){var t=document.getElementById('reportTipbar');if(t)t.style.display='none';}}catch(e){}
}
function enhanceMermaidStage(stage){
  if(!stage||stage._enhanced)return;
  stage._enhanced=true;
  var svg=stage.querySelector('svg');if(!svg)return;
  var frame=stage.closest('.chart-frame');
  var zoomVal=frame?frame.querySelector('.zoom-val'):null;
  var toolbar=frame?frame.querySelector('.chart-toolbar'):null;
  var scale=1,tx=0,ty=0,MIN=0.3,MAX=3;
  function apply(){svg.style.transform='translate('+tx+'px,'+ty+'px) scale('+scale+')';svg.style.transformOrigin='center center';if(zoomVal)zoomVal.textContent=Math.round(scale*100)+'%%';}
  function reset(){scale=1;tx=0;ty=0;apply();}
  stage.addEventListener('wheel',function(e){e.preventDefault();var d=e.deltaY<0?0.1:-0.1;scale=Math.max(MIN,Math.min(MAX,scale+d));apply();},{passive:false});
  var drag=false,sx,sy,ox,oy;
  stage.addEventListener('mousedown',function(e){drag=true;sx=e.clientX;sy=e.clientY;ox=tx;oy=ty;e.preventDefault();});
  document.addEventListener('mousemove',function(e){if(!drag)return;tx=ox+(e.clientX-sx);ty=oy+(e.clientY-sy);apply();});
  document.addEventListener('mouseup',function(){drag=false;});
  stage.addEventListener('dblclick',reset);
  if(toolbar){toolbar.addEventListener('click',function(e){var b=e.target.closest('button');if(!b)return;var a=b.getAttribute('data-act');if(a==='in'){scale=Math.min(MAX,scale+0.2);apply();}else if(a==='out'){scale=Math.max(MIN,scale-0.2);apply();}else if(a==='reset'){reset();}});}
}
initReportMermaid();
</script>
""" % _codes_json

    html = (
        '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
        '<meta charset="utf-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1">\n'
        '<title>' + title.replace("<", "&lt;").replace(">", "&gt;") + '</title>\n'
        '<style>' + _HTML_REPORT_CSS + '</style>\n'
        '</head>\n<body>\n'
    )
    html += tipbar + '\n'
    html += processed_content
    # mermaid.min.js 放 body 末尾（content 之后）：
    # 若放 head，mermaid 库会在解析到 .mermaid 元素时自动移除它们（即使 startOnLoad:false）
    # 放 body 末尾 + initReportMermaid 紧随其后，元素先存在再被我们手动渲染
    if mermaid_js:
        html += '\n<script>' + mermaid_js + '</script>\n'
    html += '\n' + (interact_js if mermaid_js else "") + '\n'
    html += '</body>\n</html>\n'

    with open(output_path, "w", encoding="utf-8") as f:
        f.write(html)

    file_size = os.path.getsize(output_path)
    log.info("[DOC] .html 报告生成完成: %s (%d bytes, mermaid=%s, frames=%d)",
             os.path.basename(output_path), file_size, "yes" if mermaid_js else "no", _frame_counter[0])


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
