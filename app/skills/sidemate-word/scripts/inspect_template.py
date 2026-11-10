"""读取 DOCX 范本，向标准输出写 UTF-8 JSON；不改范本。"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn


def heading_level(style_name: str) -> int | None:
    """由 Heading 2 / 标题 2 等样式名取得层级；Title 为 0。"""
    name = (style_name or "").strip().lower()
    if name in {"title", "subtitle", "标题", "副标题"}:
        return 0
    match = re.search(r"(?:heading|标题)\s*(\d+)", name)
    return min(int(match.group(1)), 6) if match else None


def points(value):
    return round(value.pt, 2) if value is not None else None


def inherited(style, category, attribute):
    """python-docx 的 None 表示继承，沿 base_style 找实际值。"""
    current = style
    while current is not None:
        value = getattr(getattr(current, category), attribute)
        if value is not None:
            return value
        current = current.base_style
    return None


def east_asia_font(style):
    current = style
    while current is not None:
        rpr = current.element.rPr
        if rpr is not None and rpr.rFonts is not None:
            value = rpr.rFonts.get(qn("w:eastAsia"))
            if value:
                return value
        current = current.base_style
    return None


def spacing_value(style):
    value = inherited(style, "paragraph_format", "line_spacing")
    if value is None:
        return None
    if hasattr(value, "pt"):
        return {"value": round(value.pt, 2), "unit": "pt"}
    return {"value": value, "unit": "multiple"}


def style_json(style, level=None):
    """样式 DNA：字体、字号、行距、段距与首行缩进。"""
    result = {
        "style_name": style.name,
        "font_name": inherited(style, "font", "name"),
        "east_asia_font": east_asia_font(style),
        "font_size_pt": points(inherited(style, "font", "size")),
        "bold": inherited(style, "font", "bold"),
        "line_spacing": spacing_value(style),
        "space_before_pt": points(inherited(style, "paragraph_format", "space_before")),
        "space_after_pt": points(inherited(style, "paragraph_format", "space_after")),
        "first_line_indent_pt": points(inherited(style, "paragraph_format", "first_line_indent")),
    }
    if level is not None:
        result["level"] = level
    return result


def parse_template(file_path: str) -> dict:
    """移植早期 parse_template 的大纲提取，并补齐排版样式。"""
    path = Path(file_path)
    if not path.is_file():
        raise ValueError(f"文件不存在：{path}")
    if path.suffix.lower() != ".docx":
        raise ValueError("范本必须是 .docx 文件")

    doc = Document(path)
    sections = []
    title = ""
    total_chars = 0
    used_levels = set()
    for index, paragraph in enumerate(doc.paragraphs):
        text = paragraph.text.strip()
        if not text:
            continue
        total_chars += len(text)
        style_name = paragraph.style.name if paragraph.style else ""
        level = heading_level(style_name)
        if level is None:
            if sections and not sections[-1]["has_content"]:
                sections[-1]["has_content"] = True
                sections[-1]["content_hint"] = text[:50]
            continue
        if level == 0:
            title = title or text[:200]
            continue
        used_levels.add(level)
        if not title and level == 1:
            title = text[:200]
        sections.append({
            "heading": text[:200],
            "level": level,
            "paragraph_index": index,
            "has_content": False,
            "content_hint": "",
        })

    headings = {}
    for level in sorted(used_levels):
        for style in doc.styles:
            if heading_level(style.name) == level:
                headings[str(level)] = style_json(style, level)
                break
    return {
        "status": "ok",
        "title": title or path.stem,
        "styles": {"body": style_json(doc.styles["Normal"]), "headings": headings},
        "sections": sections,
        "total_sections": len(sections),
        "total_chars": total_chars,
    }


def emit(value):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    print(json.dumps(value, ensure_ascii=False, indent=2))


def main(argv=None):
    parser = argparse.ArgumentParser(description="读取 DOCX 范本的标题结构与排版样式")
    parser.add_argument("template", help="范本 .docx 路径")
    args = parser.parse_args(argv)
    try:
        emit(parse_template(args.template))
        return 0
    except Exception as exc:
        emit({"status": "error", "error": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
