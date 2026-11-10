"""把 UTF-8 Markdown 编译成 DOCX；只写当前工作区内的输出文件。"""

from __future__ import annotations

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor


def setup_page(doc):
    section = doc.sections[0]
    section.page_width, section.page_height = Cm(21.0), Cm(29.7)
    section.top_margin = section.bottom_margin = Cm(2.54)
    section.left_margin = section.right_margin = Cm(3.17)


def set_font(style, size):
    style.font.name = "Microsoft YaHei"
    style.font.size = Pt(size)
    style.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "微软雅黑")


def setup_styles(doc):
    """沿用早期的默认版式：正文小四、1.5 倍行距、首行缩进两字符。"""
    normal = doc.styles["Normal"]
    set_font(normal, 11)
    normal.paragraph_format.line_spacing = 1.5
    normal.paragraph_format.first_line_indent = Pt(22)
    normal.paragraph_format.space_after = Pt(6)
    for level, size in ((1, 18), (2, 15), (3, 13)):
        style = doc.styles[f"Heading {level}"]
        set_font(style, size)
        style.font.bold = True
        style.font.color.rgb = RGBColor(0, 0, 0)
        style.paragraph_format.first_line_indent = Pt(0)
        style.paragraph_format.space_before = Pt(18 if level == 1 else 12)
        style.paragraph_format.space_after = Pt(8)


def clear_template_body(doc):
    """保留范本的样式和节属性，仅移除示例正文。"""
    body = doc.element.body
    for child in list(body):
        if child.tag != qn("w:sectPr"):
            body.remove(child)


def add_page_number(paragraph):
    """移植早期的 PAGE 域；页码由 Word 打开时计算。"""
    run = paragraph.add_run()
    for tag, attrs, text in (
        ("w:fldChar", {"w:fldCharType": "begin"}, None),
        ("w:instrText", {"xml:space": "preserve"}, " PAGE "),
        ("w:fldChar", {"w:fldCharType": "end"}, None),
    ):
        element = OxmlElement(tag)
        for key, value in attrs.items():
            element.set(qn(key), value)
        if text:
            element.text = text
        run._r.append(element)


def add_inline(paragraph, text):
    """移植早期的行内粗斜体；出处标记不属于标记语法，原样写入。"""
    parts = re.split(r"(\*\*[^*]+\*\*|\*[^*]+\*)", text)
    for part in parts:
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        elif part.startswith("*") and part.endswith("*") and len(part) > 2:
            run = paragraph.add_run(part[1:-1])
            run.italic = True
        else:
            paragraph.add_run(part)


def table_cells(line):
    cells = re.split(r"(?<!\\)\|", line.strip().strip("|"))
    return [cell.strip().replace("\\|", "|") for cell in cells]


def render_table(doc, rows):
    """移植早期的表格渲染；最后一格里的出处标记不拆分、不改写。"""
    cells = [table_cells(row) for row in rows]
    columns = max(len(row) for row in cells)
    table = doc.add_table(rows=len(cells), cols=columns)
    table.style = "Table Grid"
    for row_index, row in enumerate(cells):
        for column in range(columns):
            paragraph = table.cell(row_index, column).paragraphs[0]
            paragraph.paragraph_format.first_line_indent = Pt(0)
            text = row[column] if column < len(row) else ""
            add_inline(paragraph, text)
            if row_index == 0:
                for run in paragraph.runs:
                    run.bold = True


def render_markdown(doc, markdown, template=False):
    """移植早期的 Markdown 块渲染，支持三级标题、列表、引用和表格。"""
    lines = (markdown or "").replace("\r\n", "\n").replace("\r", "\n").split("\n")
    index = 0
    while index < len(lines):
        line = lines[index].rstrip()
        if not line.strip():
            index += 1
            continue
        if line.lstrip().startswith("|") and index + 1 < len(lines) and re.match(
            r"^\s*\|[\s:|\-]+\|\s*$", lines[index + 1]
        ):
            rows = [line]
            index += 2
            while index < len(lines) and lines[index].lstrip().startswith("|"):
                rows.append(lines[index])
                index += 1
            render_table(doc, rows)
            continue
        match = re.match(r"^(#{1,3})\s+(.*)$", line)
        if match:
            level = len(match.group(1))
            paragraph = doc.add_paragraph(style=f"Heading {level}")
            paragraph.paragraph_format.first_line_indent = Pt(0)
            add_inline(paragraph, match.group(2))
            if not template:
                for run in paragraph.runs:
                    run.font.size = Pt({1: 18, 2: 15, 3: 13}[level])
            index += 1
            continue
        if re.match(r"^\s*[-*+]\s+", line):
            paragraph = doc.add_paragraph(style="List Bullet")
            paragraph.paragraph_format.first_line_indent = Pt(0)
            add_inline(paragraph, re.sub(r"^\s*[-*+]\s+", "", line))
        elif re.match(r"^\s*\d+[.、)]\s+", line):
            paragraph = doc.add_paragraph(style="List Number")
            paragraph.paragraph_format.first_line_indent = Pt(0)
            add_inline(paragraph, re.sub(r"^\s*\d+[.、)]\s+", "", line))
        elif line.lstrip().startswith(">"):
            paragraph = doc.add_paragraph()
            paragraph.paragraph_format.left_indent = Pt(24)
            paragraph.paragraph_format.first_line_indent = Pt(0)
            add_inline(paragraph, line.lstrip()[1:].strip())
            for run in paragraph.runs:
                run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
        else:
            paragraph = doc.add_paragraph(style="Normal")
            add_inline(paragraph, line)
        index += 1


def add_cover(doc, title):
    for _ in range(6):
        doc.add_paragraph()
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run(title)
    run.bold = True
    run.font.size = Pt(22)
    run.font.name = "Microsoft YaHei"
    run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "微软雅黑")
    paragraph = doc.add_paragraph()
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run(datetime.date.today().strftime("%Y 年 %m 月 %d 日"))
    run.font.size = Pt(14)
    run.font.color.rgb = RGBColor(0x66, 0x66, 0x66)
    doc.add_page_break()


def output_path(raw):
    root = Path.cwd().resolve()
    path = Path(raw)
    result = (root / path).resolve() if not path.is_absolute() else path.resolve()
    try:
        result.relative_to(root)
    except ValueError as exc:
        raise ValueError("输出文件必须位于当前工作区内") from exc
    if result.suffix.lower() != ".docx":
        raise ValueError("输出文件必须使用 .docx 扩展名")
    return result


def compile_docx(markdown_path, destination, template_path=None, title=None, cover=False):
    source = Path(markdown_path)
    markdown = source.read_text(encoding="utf-8-sig")
    output = output_path(destination)
    doc = Document(template_path) if template_path else Document()
    if template_path:
        clear_template_body(doc)
    else:
        setup_page(doc)
        setup_styles(doc)
    heading = re.search(r"^#\s+(.+)$", markdown, flags=re.MULTILINE)
    doc_title = title or (heading.group(1).strip() if heading else output.stem)
    if cover:
        add_cover(doc, doc_title)
    section = doc.sections[0]
    header = section.header.paragraphs[0]
    header.text = doc_title
    header.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for run in header.runs:
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor(0x99, 0x99, 0x99)
    footer = section.footer.paragraphs[0]
    footer.clear()
    footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
    add_page_number(footer)
    render_markdown(doc, markdown, template=bool(template_path))
    output.parent.mkdir(parents=True, exist_ok=True)
    doc.save(output)
    return {"ok": True, "path": str(output), "title": doc_title, "chars": len(markdown), "size": output.stat().st_size}


def emit(value):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description="把 Markdown 编译为排版好的 DOCX")
    parser.add_argument("markdown", help="UTF-8 Markdown 输入文件")
    parser.add_argument("output", help="工作区内的 .docx 输出路径")
    parser.add_argument("--template", help="可选 .docx 范本，沿用其样式")
    parser.add_argument("--title", help="页眉和封面标题；默认取首个一级标题")
    parser.add_argument("--cover", action="store_true", help="添加标题和日期封面")
    args = parser.parse_args(argv)
    try:
        emit(compile_docx(args.markdown, args.output, args.template, args.title, args.cover))
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
