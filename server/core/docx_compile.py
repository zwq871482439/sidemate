# -*- coding: utf-8 -*-
"""
core/docx_compile.py — create_docx 工具的文档管理与 markdown→DOCX 精排版编译
=============================================================================

设计来源：PLAN-010-011 M1-4（create_ppt 姊妹件——样式 DNA 卡 + python-docx，
正式文档级版式；版式是排版质量，不绑定公文体裁，写作风格交给 skill 生态）。

存储布局（会话 workspace 内，与 ppt 同级）：
    <会话>/workspace/docx/<doc>/doc.json   章节累积（begin/section 的真相源）

三动作协议（与 create_ppt 同构）：
    begin(title)                       开题，返回版式规则要点
    section(deck, section, content)    逐章提交 markdown 正文（可预览）
    build(deck, filename)              编译为精排版 .docx

版式 DNA（正式文档级 DOCX-01）：
    封面：主标题 22pt 加粗居中 + 副标题 14pt + 日期，独立分页
    标题层级：H1 18pt 加粗 / H2 15pt 加粗 / H3 13pt 加粗
    正文：11pt（小四），1.5 倍行距，首行缩进 2 字符
    页眉：文档标题（细线分隔）；页脚：页码居中
    支持：粗体/斜体行内、无序有序列表、表格、引用块
"""

from __future__ import annotations

import json
import logging
import os
import re

log = logging.getLogger(__name__)

MAX_SECTIONS = 40            # 单文档章节数上限（轮次预算保护）
MAX_SECTION_CHARS = 30000    # 单章正文上限


def _workspace_root(chat_id):
    from core.doc_session import _workspace_root as _root
    return _root(chat_id)


def _doc_dir(chat_id, doc):
    base = _safe_deck_id(doc) or "doc"
    return os.path.join(_workspace_root(chat_id), "docx", base)


def _safe_deck_id(title):
    keep = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", (title or "").strip())
    return keep.strip("-")[:40] or "doc"


def _safe_filename(name):
    keep = re.sub(r"[\\/:*?\"<>|]+", "-", (name or "").strip())
    return keep.strip(". ")[:60]


# ---------------------------------------------------------------------------
# 动作实现
# ---------------------------------------------------------------------------

def begin_doc(chat_id, title, user_hint=""):
    """开题：建 doc.json，返回版式规则要点（拼进工具结果给模型；选卡注入语气）。"""
    from core.design_dna import pick_card
    d = _doc_dir(chat_id, title)
    os.makedirs(d, exist_ok=True)
    meta = {"deck": _safe_deck_id(title), "title": (title or "").strip(),
            "sections": [], "created_at": _now(), "dna": pick_card("docx", user_hint or "")}
    with open(os.path.join(d, "doc.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    return {"ok": True, "deck": meta["deck"], "dna": meta["dna"],
            "rules": "正式文档级版式已锁定：封面（22pt 标题+副标题+日期）/"
                     "H1 18pt·H2 15pt·H3 13pt 加粗/正文 11pt·1.5 倍行距·首行缩进 2 字符/"
                     "页眉标题·页脚页码/支持列表与表格。语气参照 %s 卡。逐章用 section 提交 markdown 正文。"
                     % meta["dna"]}, meta


def add_section(chat_id, deck, section, content):
    """逐章提交：section=章节标题，content=markdown 正文。"""
    d = _doc_dir(chat_id, deck)
    meta_path = os.path.join(d, "doc.json")
    if not os.path.isfile(meta_path):
        return {"ok": False, "error": "not_found",
                "message": "文档不存在，先 create_docx(action=\"begin\") 开题"}
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    content = (content or "").strip()
    if not content or len(content) < 20:
        return {"ok": False, "error": "empty_section",
                "message": "章节正文过短（至少 20 字）——正文必须实质内容，不接受提纲"}
    if len(content) > MAX_SECTION_CHARS:
        content = content[:MAX_SECTION_CHARS] + "\n\n[本章过长，已截断]"
    if len(meta["sections"]) >= MAX_SECTIONS:
        return {"ok": False, "error": "too_many_sections",
                "message": "章节数已达上限 %d" % MAX_SECTIONS}
    n = len(meta["sections"]) + 1
    meta["sections"].append({"n": n, "section": (section or "第%d章" % n).strip(),
                             "content": content})
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)
    return {"ok": True, "n": n, "total_sections": len(meta["sections"])}, meta


def build_doc(chat_id, deck, filename=None):
    """编译：doc.json 章节 → 精排版 .docx（python-docx）。"""
    d = _doc_dir(chat_id, deck)
    meta_path = os.path.join(d, "doc.json")
    if not os.path.isfile(meta_path):
        return {"ok": False, "error": "not_found",
                "message": "文档不存在，先 begin"}
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)
    if not meta["sections"]:
        return {"ok": False, "error": "no_sections",
                "message": "还没有章节——先逐章 section 提交正文再 build"}

    try:
        from docx import Document
        from docx.shared import Pt, Cm, RGBColor
        from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
        from docx.enum.table import WD_TABLE_ALIGNMENT
        from docx.oxml.ns import qn
    except ImportError:
        return {"ok": False, "error": "python-docx 不可用（pip install python-pptx 同链路）",
                "message": "python-docx 未安装"}

    doc = Document()
    _setup_page(doc)
    _setup_styles(doc)

    # ---- 封面 ----
    for _ in range(6):
        doc.add_paragraph()
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    r = p.add_run(meta["title"]); r.font.size = Pt(22); r.bold = True
    r.font.name = "Microsoft YaHei"; r._element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")
    p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    import datetime
    r = p.add_run(datetime.date.today().strftime("%Y 年 %m 月 %d 日"))
    r.font.size = Pt(14); r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    doc.add_page_break()

    # ---- 页眉页脚 ----
    sec = doc.sections[0]
    hp = sec.header.paragraphs[0]
    hp.text = meta["title"]
    hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for r in hp.runs:
        r.font.size = Pt(9); r.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    fp = sec.footer.paragraphs[0]
    fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    _add_page_number(fp)

    # ---- 正文 ----
    for s in meta["sections"]:
        _render_markdown_block(doc, "# " + s["section"])
        _render_markdown_block(doc, s["content"])

    out_name = _safe_filename(filename or meta["title"]) or meta["deck"]
    out = os.path.join(_workspace_root(chat_id), out_name + ".docx")
    doc.save(out)

    total_chars = sum(len(s["content"]) for s in meta["sections"])
    log.info("[DOCX] 编译完成: %s（%d 章 %d 字）", out, len(meta["sections"]), total_chars)
    return {"ok": True, "path": out, "filename": os.path.basename(out),
            "sections": len(meta["sections"]), "chars": total_chars,
            "size": os.path.getsize(out)}, meta


def list_docs(chat_id):
    """列出会话的 docx 文档（预览 tab 回放用）。"""
    root = os.path.join(_workspace_root(chat_id), "docx")
    out = []
    if not os.path.isdir(root):
        return out
    for entry in os.listdir(root):
        mp = os.path.join(root, entry, "doc.json")
        if os.path.isfile(mp):
            try:
                with open(mp, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                out.append({"deck": meta.get("deck") or entry,
                            "title": meta.get("title", entry),
                            "sections": len(meta.get("sections", [])),
                            "section_list": [
                                {"n": s["n"], "section": s["section"],
                                 "content": s["content"],
                                 "chars": len(s["content"])}
                                for s in meta.get("sections", [])]})
            except Exception:
                continue
    return out


# ---------------------------------------------------------------------------
# 版式细节
# ---------------------------------------------------------------------------

def _now():
    import time
    return time.strftime("%Y-%m-%d %H:%M:%S")


def _setup_page(doc):
    from docx.shared import Cm
    sec = doc.sections[0]
    sec.page_width, sec.page_height = Cm(21.0), Cm(29.7)   # A4
    sec.top_margin = sec.bottom_margin = Cm(2.54)
    sec.left_margin = sec.right_margin = Cm(3.17)          # 标准公文边距


def _setup_styles(doc):
    """Normal 样式：小四 11pt / 1.5 行距 / 首行缩进 2 字符（中文字符宽度单位）。"""
    from docx.shared import Pt
    from docx.oxml.ns import qn
    st = doc.styles["Normal"]
    st.font.name = "Microsoft YaHei"
    st.font.size = Pt(11)
    st._element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")
    pf = st.paragraph_format
    pf.line_spacing = 1.5
    pf.first_line_indent = Pt(22)   # ≈ 2 个 11pt 中文字符


def _add_page_number(paragraph):
    """页脚页码：PAGE 字段（python-docx 无直接 API，走 XML）。"""
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement
    run = paragraph.add_run()
    for el, attrs, text in (
        ("w:fldChar", {"w:fldCharType": "begin"}, None),
        ("w:instrText", {"xml:space": "preserve"}, " PAGE "),
        ("w:fldChar", {"w:fldCharType": "end"}, None),
    ):
        e = OxmlElement(el)
        for k, v in attrs.items():
            e.set(qn(k), v)
        if text:
            e.text = text
        run._r.append(e)


def _render_markdown_block(doc, md):
    """markdown → docx 段落（标题/列表/表格/引用/行内粗斜体；简化版，覆盖报告写作常用语法）。"""
    from docx.shared import Pt, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn

    lines = (md or "").split("\n")
    i = 0
    while i < len(lines):
        ln = lines[i].rstrip()
        if not ln.strip():
            i += 1; continue
        # 表格（|a|b| 行 + |---| 分隔）
        if ln.lstrip().startswith("|") and i + 1 < len(lines) and \
           re.match(r"^\s*\|[\s:|-]+\|\s*$", lines[i + 1]):
            rows = [ln]
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith("|"):
                rows.append(lines[j]); j += 1
            _render_table(doc, rows)
            i = j; continue
        m = re.match(r"^(#{1,4})\s+(.*)$", ln)
        if m:
            level = len(m.group(1))
            size = {1: 18, 2: 15, 3: 13, 4: 12}.get(level, 12)
            p = doc.add_paragraph()
            p.paragraph_format.first_line_indent = Pt(0)
            r = p.add_run(m.group(2)); r.bold = True; r.font.size = Pt(size)
            r.font.name = "Microsoft YaHei"
            r._element.rPr.rFonts.set(qn("w:eastAsia"), "微软雅黑")
            if level == 1:
                p.paragraph_format.space_before = Pt(18)
                p.paragraph_format.space_after = Pt(8)
            i += 1; continue
        if re.match(r"^\s*[-*]\s+", ln):
            p = doc.add_paragraph(style="List Bullet")
            p.paragraph_format.first_line_indent = Pt(0)
            _add_inline(p, re.sub(r"^\s*[-*]\s+", "", ln))
            i += 1; continue
        if re.match(r"^\s*\d+[.、)]\s+", ln):
            p = doc.add_paragraph(style="List Number")
            p.paragraph_format.first_line_indent = Pt(0)
            _add_inline(p, re.sub(r"^\s*\d+[.、)]\s+", "", ln))
            i += 1; continue
        if ln.lstrip().startswith(">"):
            p = doc.add_paragraph()
            p.paragraph_format.left_indent = Pt(24)
            p.paragraph_format.first_line_indent = Pt(0)
            _add_inline(p, ln.lstrip()[1:].strip())
            for r in p.runs:
                r.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
            i += 1; continue
        # 普通段落
        p = doc.add_paragraph()
        _add_inline(p, ln)
        i += 1


def _add_inline(paragraph, text):
    """行内 **粗体** / *斜体* 拆分追加。"""
    parts = re.split(r"(\*\*[^*]+\*\*|\*[^*]+\*)", text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            r = paragraph.add_run(part[2:-2]); r.bold = True
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            r = paragraph.add_run(part[1:-1]); r.italic = True
        else:
            paragraph.add_run(part)


def _render_table(doc, rows):
    """markdown 表格行 → docx 表格（首行表头加粗）。"""
    cells = [[c.strip() for c in r.strip().strip("|").split("|")] for r in rows]
    if not cells:
        return
    cols = max(len(r) for r in cells)
    t = doc.add_table(rows=len(cells), cols=cols)
    t.style = "Table Grid"
    for ri, row in enumerate(cells):
        for ci in range(cols):
            txt = row[ci] if ci < len(row) else ""
            cell = t.cell(ri, ci)
            cell.text = ""
            p = cell.paragraphs[0]
            p.paragraph_format.first_line_indent = None
            r = p.add_run(txt)
            if ri == 0:
                r.bold = True
