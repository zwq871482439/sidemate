"""读取 DOCX / PDF / XLSX，向标准输出写 UTF-8 JSON；不落中间文件。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.oxml.table import CT_Tbl
from docx.oxml.text.paragraph import CT_P
from docx.table import Table
from docx.text.paragraph import Paragraph
from openpyxl import load_workbook
from pypdf import PdfReader


def heading_level(style_name):
    match = re.search(r"(?:heading|标题)\s*(\d+)", (style_name or "").lower())
    return max(1, min(int(match.group(1)), 6)) if match else None


def markdown_cell(value):
    return str(value).replace("\r\n", "<br>").replace("\n", "<br>").replace("|", "\\|").strip()


def table_markdown(table):
    lines = []
    for row_index, row in enumerate(table.rows):
        cells = [markdown_cell(cell.text or "") for cell in row.cells]
        lines.append("| " + " | ".join(cells) + " |")
        if row_index == 0:
            lines.append("| " + " | ".join(["---"] * len(cells)) + " |")
    return lines


def document_blocks(doc):
    """按正文原顺序遍历段落与表格，而非把表格统一追加到末尾。"""
    for child in doc.element.body.iterchildren():
        if isinstance(child, CT_P):
            yield Paragraph(child, doc)
        elif isinstance(child, CT_Tbl):
            yield Table(child, doc)


def read_docx(path):
    """移植早期 _read_docx，补充正文与表格混排及纯文本输出。"""
    doc = Document(path)
    text_lines = []
    markdown_lines = []
    for block in document_blocks(doc):
        if isinstance(block, Table):
            rows = [[cell.text.strip() for cell in row.cells] for row in block.rows]
            text_lines.extend("\t".join(row) for row in rows)
            markdown_lines.extend(table_markdown(block))
            markdown_lines.append("")
            continue
        text = block.text.strip()
        if not text:
            continue
        text_lines.append(text)
        style = block.style.name if block.style else ""
        level = heading_level(style)
        if level is not None:
            markdown_lines.append("#" * level + " " + text)
        elif style.lower() == "list bullet" or style.lower().startswith("list"):
            markdown_lines.append("- " + text)
        else:
            markdown_lines.append(text)
        markdown_lines.append("")
    return {
        "format": "docx",
        "text": "\n".join(text_lines),
        "markdown": "\n".join(markdown_lines).strip(),
        "paragraphs": len(doc.paragraphs),
        "tables": len(doc.tables),
    }


def read_pdf(path):
    """移植早期的 pypdf 回退路径；随包没有 pdfplumber，直接只用 pypdf。"""
    reader = PdfReader(path)
    pages = [(page.extract_text() or "").strip() for page in reader.pages]
    text = "\n\n".join(pages).strip()
    return {"format": "pdf", "text": text, "markdown": text, "pages": len(pages)}


def sheet_values(sheet, max_rows):
    rows = []
    truncated = False
    for index, row in enumerate(sheet.iter_rows(values_only=True)):
        if index >= max_rows:
            truncated = True
            break
        rows.append(["" if value is None else str(value) for value in row])
    width = max((len(row) for row in rows), default=0)
    for row in rows:
        row.extend([""] * (width - len(row)))
    return rows, width, truncated


def sheet_markdown(rows, width):
    if not rows:
        return ["(空表格)"]
    lines = []
    for index, row in enumerate(rows):
        lines.append("| " + " | ".join(markdown_cell(value) for value in row) + " |")
        if index == 0:
            lines.append("| " + " | ".join(["---"] * width) + " |")
    return lines


def read_xlsx(path, max_rows):
    """移植早期 read_xlsx 的 Markdown 表生成，扩展为逐表读取。"""
    workbook = load_workbook(path, read_only=True, data_only=True)
    text_parts = []
    markdown_parts = []
    sheets = []
    try:
        for name in workbook.sheetnames:
            rows, width, truncated = sheet_values(workbook[name], max_rows)
            sheets.append({"name": name, "rows": len(rows), "cols": width, "truncated": truncated})
            text_parts.append("\n".join("\t".join(row) for row in rows))
            markdown_parts.append(f"## {name}\n\n" + "\n".join(sheet_markdown(rows, width)))
    finally:
        workbook.close()
    return {
        "format": "xlsx",
        "text": "\n\n".join(text_parts).strip(),
        "markdown": "\n\n".join(markdown_parts).strip(),
        "sheets": sheets,
    }


def read_material(file_path, max_rows=200):
    path = Path(file_path)
    if not path.is_file():
        raise ValueError(f"文件不存在：{path}")
    suffix = path.suffix.lower()
    if suffix == ".docx":
        result = read_docx(path)
    elif suffix == ".pdf":
        result = read_pdf(path)
    elif suffix == ".xlsx":
        result = read_xlsx(path, max_rows)
    else:
        raise ValueError("只支持 .docx、.pdf、.xlsx 文件")
    return {"ok": True, "path": str(path.resolve()), **result}


def emit(value):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description="读取 DOCX、PDF 或 XLSX 的文字和 Markdown 表")
    parser.add_argument("material", help="要读取的材料路径")
    parser.add_argument("--max-rows", type=int, default=200, help="XLSX 每个工作表最多读取的行数，默认 200")
    args = parser.parse_args(argv)
    try:
        if args.max_rows < 1:
            raise ValueError("--max-rows 必须大于 0")
        emit(read_material(args.material, args.max_rows))
        return 0
    except Exception as exc:
        emit({"ok": False, "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
