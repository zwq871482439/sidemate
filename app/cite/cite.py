#!/usr/bin/env python3
"""切块打标和机械核。壳做，不经模型。

从 R2b 的 cite.py 搬来。没有数字也没有人名时，去掉标点和空白后要有连续 6 个字
落在那一块原文里，不足 6 个字就整段都要在。核不上的不写批注。
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

from docx import Document
from docx.opc.oxml import serialize_part_xml
from docx.oxml.parser import parse_xml
from docx.text.paragraph import Paragraph
from docx.text.run import Run
from lxml import etree
from openpyxl import load_workbook
from pypdf import PdfReader

import fonts
import tables

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"
PDF_FAIL = "这份文档转不成按页切的样子"
SUFFIXES = {".docx", ".pdf", ".xlsx", ".pptx", ".csv", ".md", ".txt"}
MARK = re.compile(r"〔S\d+·[^〕]+〕")
NAME_RE = re.compile(r"(?:负责人|联系人)\s*[:：]\s*([\u4e00-\u9fff]{2,4})")
PUNCT = " \t\r\n，。、；;：:！!？?（）()【】[]《》〈〉「」\"'“”‘’·—\\-…,.．"
OVERLAP = 6

def norm(text: str) -> str:
    return re.sub(r"\s+", "", text or "")

def meaningful(text: str) -> bool:
    return bool(text.translate(str.maketrans("", "", PUNCT)).strip())

def squash(text: str) -> str:
    return norm(text).translate(str.maketrans("", "", PUNCT))

def read_text(path: Path) -> str:
    data = path.read_bytes()
    for enc in ("utf-8-sig", "utf-8", "gb18030"):
        try:
            return data.decode(enc)
        except UnicodeDecodeError:
            continue
    raise RuntimeError(f"读不了《{path.name}》")

def paragraph_pieces(elm) -> list[tuple]:
    pieces: list[tuple] = []
    buf: list[str] = []

    def flush() -> None:
        pieces.append(("t", "".join(buf)))
        buf.clear()

    for node in elm.iter():
        tag = node.tag
        if tag == f"{W}t":
            buf.append(node.text or "")
        elif tag == f"{W}tab":
            buf.append("\t")
        elif tag == f"{W}cr":
            buf.append("\n")
        elif tag == f"{W}br":
            if node.get(f"{W}type") == "page":
                flush()
                pieces.append(("b",))
            else:
                buf.append("\n")
        elif tag == f"{W}lastRenderedPageBreak":
            flush()
            pieces.append(("b",))
    flush()
    return pieces

def container_pieces(elm) -> list[tuple]:
    pieces: list[tuple] = []
    for child in elm.iterchildren():
        tag = child.tag
        if tag == f"{W}p":
            pieces.extend(paragraph_pieces(child))
            pieces.append(("t", "\n"))
        elif tag == f"{W}tbl":
            for para in child.iter(f"{W}p"):
                pieces.extend(paragraph_pieces(para))
                pieces.append(("t", "\n"))
        elif tag == f"{W}sdt":
            content = child.find(f"{W}sdtContent")
            if content is not None:
                pieces.extend(container_pieces(content))
    return pieces

def pages_of(pieces: list[tuple]) -> list[str]:
    pages = [""]
    for kind, *rest in pieces:
        if kind == "b":
            if pages[-1].strip():
                pages.append("")
        else:
            pages[-1] += rest[0]
    while len(pages) > 1 and not pages[-1].strip():
        pages.pop()
    return pages or [""]

def docx_pages_breaks(path: Path) -> list[str]:
    doc = Document(path)
    return pages_of(container_pieces(doc.element.body))

def has_page_break(path: Path) -> bool:
    doc = Document(path)
    return any(kind == "b" for kind, *_rest in container_pieces(doc.element.body))

def pdf_pages(path: Path) -> list[str]:
    reader = PdfReader(str(path))
    if reader.is_encrypted:
        raise RuntimeError(f"打不开《{path.name}》")
    return [(page.extract_text() or "") for page in reader.pages] or [""]

def fail_note(detail: str, message: str = PDF_FAIL) -> None:
    # 给人看的是一句中文。转换器的原文只进日志。
    fonts.log_line(detail)
    raise RuntimeError(message)

def pdf_timeout() -> int:
    raw = os.environ.get("SIDEMATE_PDF_TIMEOUT", "")
    return int(raw) if raw.isdigit() and int(raw) > 0 else 180

def pipe_text(value) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8", "replace")
    return "" if value is None else str(value)

def docx_pages_pdf(path: Path, tmp: Path, dsoffice: str, node: str) -> list[str]:
    dest = tmp / f"{path.stem}-{path.stat().st_mtime_ns}.pdf"
    if not dest.exists():
        node_path = Path(node) if node else None
        office_path = Path(dsoffice) if dsoffice else None
        if node_path is None or not node_path.is_file() or office_path is None or not office_path.is_file():
            raise RuntimeError("还不能把文档转成按页切的样子")
        try:
            proc = subprocess.run(
                [str(node_path), str(office_path), "convert", "--input", str(path.resolve()), "--output", str(dest.resolve())],
                capture_output=True,
                text=True,
                timeout=pdf_timeout(),
            )
        except subprocess.TimeoutExpired as exc:
            fail_note(pipe_text(exc.stderr) or pipe_text(exc.stdout) or "timeout")
        if proc.returncode != 0 or not dest.exists():
            fail_note(pipe_text(proc.stderr) or pipe_text(proc.stdout) or "转 PDF 没有成功")
    return pdf_pages(dest)

def sheet_text(ws) -> str:
    lines = []
    for row in ws.iter_rows(values_only=True):
        cells = ["" if value is None else str(value) for value in row]
        if any(cell.strip() for cell in cells):
            lines.append("\t".join(cells))
    return "\n".join(lines)

def pptx_pages(path: Path) -> list[str]:
    from pptx import Presentation

    def text_of(shape) -> str:
        parts = [shape.text_frame.text] if shape.has_text_frame else []
        if getattr(shape, "has_table", False):
            parts.append("\n".join("\t".join(c.text for c in r.cells) for r in shape.table.rows))
        if hasattr(shape, "shapes"):
            parts.extend(text_of(sub) for sub in shape.shapes)
        return "\n".join(part for part in parts if part.strip())

    deck = Presentation(str(path))
    return ["\n".join(filter(None, (text_of(s) for s in slide.shapes))) for slide in deck.slides] or [""]

def make_marker(index: int, kind: str, locator: str) -> str:
    body = f"p{locator}" if kind == "page" else locator
    return f"〔S{index:02d}·{body}〕"

def chunk_file(path: Path, index: int, tmp: Path, dsoffice: str, node: str) -> list[dict]:
    suffix = path.suffix.lower()
    if suffix == ".docx":
        pages = docx_pages_breaks(path) if has_page_break(path) else docx_pages_pdf(path, tmp, dsoffice, node)
        units = [("page", str(i), text) for i, text in enumerate(pages, 1)]
    elif suffix == ".pdf":
        units = [("page", str(i), text) for i, text in enumerate(pdf_pages(path), 1)]
    elif suffix == ".xlsx":
        book = load_workbook(path, data_only=True)
        try:
            units = [("sheet", ws.title, sheet_text(ws)) for ws in book.worksheets]
        finally:
            book.close()
    elif suffix == ".pptx":
        units = [("page", str(i), text) for i, text in enumerate(pptx_pages(path), 1)]
    elif suffix in SUFFIXES:
        units = [("page", "1", read_text(path))]
    else:
        raise RuntimeError(f"这种材料还不能切块：{path.name}")
    chunks = []
    for kind, locator, text in units:
        chunk = {
            "index": index,
            "marker": make_marker(index, kind, locator),
            "file": path.name,
            "kind": kind,
            "locator": locator,
            "text": text,
        }
        chunk["comment"] = cite_of(chunk)
        chunks.append(chunk)
    return chunks

def write_tagged(chunks: list[dict], dest: Path) -> None:
    if dest.exists():
        dest.chmod(0o755)
        for child in list(dest.iterdir()):
            if not child.is_file():
                continue
            child.chmod(0o644)
            child.unlink()
    dest.mkdir(parents=True, exist_ok=True)
    grouped: dict[str, list[dict]] = {}
    order: list[str] = []
    for chunk in chunks:
        if chunk["file"] not in grouped:
            order.append(chunk["file"])
            grouped[chunk["file"]] = []
        grouped[chunk["file"]].append(chunk)
    for name in order:
        block = grouped[name]
        lines = [f"来源文件：{name}", ""]
        for chunk in block:
            lines.append(chunk["marker"])
            lines.append(chunk["text"].strip())
            lines.append("")
        path = dest / f"S{block[0]['index']:02d}-{name}.txt"
        path.write_text("\n".join(lines), encoding="utf-8")
        path.chmod(0o444)

def build_prompt(utterance: str, template: str, single: bool = False) -> str:
    lines = []
    if utterance.strip():
        lines.append(utterance.strip())
        lines.append("")
    if template:
        lines.append(f"范本：{template}")
    if single:
        # 材料恰好一份文档：这就是让改用户自己那一份稿。不切块、不打标，句末也不用留标记
        lines.append("这是用户自己的一份稿子：在它原来的格式、字体和写法上改，正文里不要加出处标记。")
    else:
        lines.append("材料的带标副本在 tagged/。")
        lines.append("每句来自材料的话，句末原样保留它用到的标记。")
        lines.append("自己归纳、判断的句子（没有材料里的数字、人名或原话）不要留标记。")
        lines.append("表格的每一行也要在行末留标记。")
        lines.append("表格的标记写在这一行最后一格文字的后面，不要为标记单独加一列。")
        lines.append("照正常文章分段，带标和不带标的句子可以在同一段；不要为了放标记一句一段。")
        lines.append("文件里不要解释标记，不要提 tagged，回话里也不要提。")
    lines.append("扩写或改写时新加的承诺（人员安排、时限、考核、保密、生效条款这类原文没有的）不要悄悄写进正文；要写就在回话里单列出来，让用户确认。")
    lines.append("字体：用户话里指定了就照用户的，有范本就照范本的；都没有就正文和标题都用 Noto Sans SC。")
    lines.append("不要用 Courier、日文字体（明朝、ゴシック），也不要用 Linux 字体（Liberation、文泉驿、DejaVu）。")
    return "\n".join(lines) + "\n"

def build_gazetteer(chunks: list[dict]) -> list[str]:
    names: set[str] = set()
    for chunk in chunks:
        names.update(NAME_RE.findall(chunk["text"]))
    return sorted(names, key=len, reverse=True)

def names_in(text: str, gazetteer: list[str]) -> list[str]:
    found = []
    masked = text
    for name in gazetteer:
        if name in masked:
            found.append(name)
            masked = masked.replace(name, "\u3000")
    return found

def number_in(chunk: str, number: str) -> bool:
    return re.search(rf"(?<!\d){re.escape(number)}(?!\d)", norm(chunk)) is not None

def cite_of(chunk: dict) -> str:
    if chunk["kind"] == "sheet":
        return f"来自《{chunk['file']}》工作表「{chunk['locator']}」"
    return f"来自《{chunk['file']}》第 {chunk['locator']} 页"

def literal_overlap(segment: str, chunk: str) -> bool:
    left = squash(segment)
    right = squash(chunk)
    if not left:
        return False
    if len(left) <= OVERLAP:
        return left in right
    return any(left[i:i + OVERLAP] in right for i in range(0, len(left) - OVERLAP + 1))

def judge_marks(segment: str, markers: list[str], by_marker: dict, gazetteer: list[str]) -> list[tuple[bool, str, str]]:
    # 一段字挂几个标记：数字、人名只要在其中一份里找得到；每个标记自己对上这段的一处。
    chunks = [by_marker.get(marker) for marker in markers]
    if not meaningful(segment):
        return [(False, "", "missing") for _ in markers]
    numbers = re.findall(r"\d+(?:\.\d+)?", segment)
    names = names_in(segment, gazetteer)
    texts = [chunk["text"] for chunk in chunks if chunk is not None]
    reason = ""
    for number in numbers:
        if not any(number_in(text, number) for text in texts):
            reason = "number"
            break
    if not reason:
        for name in names:
            if not any(norm(name) in norm(text) for text in texts):
                reason = "name"
                break
    results: list[tuple[bool, str, str]] = []
    for chunk in chunks:
        if chunk is None:
            results.append((False, "", "missing"))
            continue
        if reason:
            results.append((False, "", reason))
            continue
        text = chunk["text"]
        hit = (any(number_in(text, number) for number in numbers)
               or any(norm(name) in norm(text) for name in names)
               or literal_overlap(segment, text))
        if hit:
            results.append((True, cite_of(chunk), ""))
        elif numbers:
            results.append((False, "", "number"))
        elif names:
            results.append((False, "", "name"))
        else:
            results.append((False, "", "overlap"))
    return results

def bind_markers(text: str) -> list[tuple[str, list[str]]]:
    # 一段字后面连着的几个标记都算这段字的出处；前面没字的标记挂给后面那段。
    tokens: list[tuple[str, str]] = []
    pos = 0
    for match in MARK.finditer(text):
        if match.start() > pos:
            tokens.append(("t", text[pos:match.start()]))
        tokens.append(("m", match.group(0)))
        pos = match.end()
    if pos < len(text):
        tokens.append(("t", text[pos:]))
    owned: dict[int, list[str]] = {}
    loose: list[str] = []
    index = 0
    while index < len(tokens):
        if tokens[index][0] != "m":
            index += 1
            continue
        start = index
        while index < len(tokens) and tokens[index][0] == "m":
            index += 1
        run = [tokens[spot][1] for spot in range(start, index)]
        back = start - 1
        if back >= 0 and tokens[back][0] == "t" and meaningful(tokens[back][1]):
            owned.setdefault(back, []).extend(run)
        elif index < len(tokens) and tokens[index][0] == "t" and meaningful(tokens[index][1]):
            owned.setdefault(index, []).extend(run)
        else:
            loose.extend(run)
    parts: list[tuple[str, list[str]]] = []
    for index, (kind, value) in enumerate(tokens):
        if kind == "t":
            parts.append((value, owned.get(index, [])))
    for marker in loose:
        parts.append(("", [marker]))
    return parts or [("", [])]

def marker_map(chunks: list[dict]) -> dict:
    found = {}
    for chunk in chunks:
        if chunk["marker"] in found:
            raise RuntimeError(f"标记重复 {chunk['marker']}")
        found[chunk["marker"]] = chunk
    return found

def in_fallback(elm) -> bool:
    node = elm
    while node is not None and node.tag != f"{MC}Fallback":
        node = node.getparent()
    return node is not None

def own_tagged(elm, tag):
    # 文本框里另算一段。超链接、修订、域里的字算这一段。
    found = []
    def walk(node) -> None:
        for child in node:
            if child.tag == f"{W}p":
                continue
            if child.tag == tag:
                found.append(child)
            else:
                walk(child)
    walk(elm)
    return found

def own_text(elm) -> str:
    return "".join(node.text or "" for node in own_tagged(elm, f"{W}t"))

def xml_value(node, attr):
    # 段落和 run 的 .text 是拼出来的，写进去会把整段冲掉。这里只动 XML 原文。
    return getattr(etree._Element, attr).__get__(node, None) or ""

def delete_marks(pieces) -> int:
    raw = "".join(xml_value(node, attr) for node, attr in pieces)
    found = list(MARK.finditer(raw))
    if not found:
        return 0
    drop = [False] * len(raw)
    for item in found:
        drop[item.start():item.end()] = [True] * (item.end() - item.start())
    cursor = 0
    for node, attr in pieces:
        text = xml_value(node, attr)
        updated = "".join(char for index, char in enumerate(text) if not drop[cursor + index])
        cursor += len(text)
        if updated == text:
            continue
        getattr(etree._Element, attr).__set__(node, updated or None)
        if updated[:1].isspace() or updated[-1:].isspace():
            node.set(XML_SPACE, "preserve")
    return len(found)

def run_blank(run) -> bool:
    for child in run:
        if child.tag != f"{W}rPr" and not (child.tag == f"{W}t" and not (child.text or "")):
            return False
    return True

def drop_blank(elm) -> None:
    for run in own_tagged(elm, f"{W}r"):
        for child in list(run):
            if child.tag == f"{W}t" and not (child.text or ""):
                run.remove(child)
        if run_blank(run) and run.getparent() is not None:
            run.getparent().remove(run)

def remember(parts, node) -> None:
    while node is not None:
        for item in parts:
            if item["elm"] is node:
                item["dirty"] = True
                return
        node = node.getparent()

def strip_markers(elm, parts) -> bool:
    if not delete_marks([(node, "text") for node in own_tagged(elm, f"{W}t")]):
        return False
    drop_blank(elm)
    remember(parts, elm)
    return True

def score_text(raw, by_marker, gazetteer, unverified=False):
    # 按句子计：一句挂几个标记算一句，有一个标记核上就算这句核上。
    checked = failed = overlap = 0
    notes = []
    for segment, markers in bind_markers(raw):
        if not markers:
            continue
        checked += 1
        hit = False
        loose_overlap = False
        for marker, (ok, note, reason) in zip(markers, judge_marks(segment, markers, by_marker, gazetteer)):
            if ok:
                hit = True
                notes.append(note)
            elif unverified and by_marker.get(marker) is not None:
                # 核不上但标记本身合法：也写批注，让人自己翻。
                notes.append(f"模型说{cite_of(by_marker[marker]).replace('来自', '出自', 1)}，没能逐字核上，请自己翻一下")
            if reason == "overlap":
                loose_overlap = True
        if hit:
            continue
        failed += 1
        overlap += loose_overlap
    return checked, failed, overlap, notes

def hang(doc, paragraphs, notes) -> None:
    if not notes or not paragraphs:
        return
    host, owner = None, paragraphs[-1]
    for paragraph in paragraphs:
        found = None
        for run in own_tagged(paragraph._p, f"{W}r"):
            if run_blank(run):
                continue
            found = run
            if any(child.tag == f"{W}t" and (child.text or "") for child in run):
                break
        if found is not None:
            host, owner = found, paragraph
    if host is None:
        target = owner.add_run("\u200b")
    else:
        # 批注挂整段：这一段里第一个和最后一个有字的 run，中间那些一起盖住
        texts = [
            run for run in own_tagged(owner._p, f"{W}r")
            if not run_blank(run) and any(child.tag == f"{W}t" and (child.text or "") for child in run)
        ]
        target = [Run(texts[0], owner), Run(texts[-1], owner)] if texts else Run(host, owner)
    for note in notes:
        fonts.mark_comment(doc.add_comment(target, text=note, author="桌伴", initials="桌"))

def row_paragraphs(tr, doc):
    # 格子可能包在 w:sdt 里。只认这一行，不拿 row.cells 补出来的格子。
    cells = []
    for child in tr:
        if child.tag == f"{W}tc":
            cells.append(child)
        elif child.tag == f"{W}sdt":
            content = child.find(f"{W}sdtContent")
            if content is not None:
                cells.extend(item for item in content if item.tag == f"{W}tc")
    return [Paragraph(item, doc) for tc in cells for item in tc.findall(f"{W}p")]

def judge_paragraphs(doc, paragraphs, raw, by_marker, gazetteer, parts, fallback=False, unverified=False):
    changed, active = False, []
    for paragraph in paragraphs:
        if fallback or in_fallback(paragraph._p):
            changed = strip_markers(paragraph._p, parts) or changed
        else:
            active.append(paragraph)
    if fallback or not active:
        return 0, 0, 0, changed
    body = raw if raw is not None else "\n".join(own_text(paragraph._p) for paragraph in active)
    if "〔S" not in body:
        return 0, 0, 0, changed
    checked, failed, overlap, notes = score_text(body, by_marker, gazetteer, unverified)
    for paragraph in active:
        changed = strip_markers(paragraph._p, parts) or changed
    hang(doc, active, notes)
    return checked, failed, overlap, changed or bool(notes)

def story_roots(doc: Document, parts) -> list:
    # 没有自己的页眉页脚时 is_linked_to_previous 为真，不读 ._element，避免新建空部件。
    roots, seen = [], set()
    def add(elm) -> None:
        if elm is not None and id(elm) not in seen:
            seen.add(id(elm))
            roots.append(elm)
    add(doc.element.body)
    names = (
        "header", "first_page_header", "even_page_header",
        "footer", "first_page_footer", "even_page_footer",
    )
    for section in doc.sections:
        for name in names:
            piece = getattr(section, name)
            if not piece.is_linked_to_previous:
                add(piece._element)
    for item in parts:
        if str(item["part"].partname).lower().endswith(("footnotes.xml", "endnotes.xml")):
            add(item["elm"])
    return roots

def xml_parts(doc: Document) -> list:
    found = []
    for part in doc.part.package.iter_parts():
        live = getattr(part, "_element", None)
        if live is not None:
            found.append({"part": part, "elm": live, "live": True, "dirty": False})
            continue
        blob = part.blob or b""
        if not blob.lstrip().startswith((b"<?xml", b"<")):
            continue
        try:
            elm = parse_xml(blob)
        except Exception:
            continue
        found.append({"part": part, "elm": elm, "live": False, "dirty": False})
    return found

def sweep_parts(parts) -> int:
    removed = 0
    for item in parts:
        for node in item["elm"].iter():
            hits = delete_marks([(node, "text")]) + delete_marks([(node, "tail")])
            for key, value in list(node.attrib.items()):
                found = MARK.findall(value or "")
                if not found:
                    continue
                hits += len(found)
                node.attrib[key] = MARK.sub("", value)
            if hits:
                removed += hits
                item["dirty"] = True
    return removed

def flush_parts(parts) -> None:
    for item in parts:
        if not item["live"] and item["dirty"]:
            item["part"]._blob = serialize_part_xml(item["elm"])

def tally(total, one):
    return (total[0] + one[0], total[1] + one[1], total[2] + one[2], total[3] or one[3])

def verify_docx(path: Path, by_marker: dict, gazetteer: list[str]) -> dict:
    doc = Document(path)
    parts = xml_parts(doc)
    stats = (0, 0, 0, False)
    roots = story_roots(doc, parts)
    pre = tables.tidy_document(roots)
    for root in roots:
        for tr in root.iter(f"{W}tr"):
            stats = tally(stats, judge_paragraphs(
                doc, row_paragraphs(tr, doc), None, by_marker, gazetteer, parts, in_fallback(tr), unverified=True,
            ))
        for elm in root.iter(f"{W}p"):
            # 格子里的段落由这一行来核。文本框挂在格子里时，父节点不是格子。
            parent = elm.getparent()
            if parent is not None and parent.tag == f"{W}tc":
                continue
            stats = tally(stats, judge_paragraphs(
                doc, [Paragraph(elm, doc)], own_text(elm), by_marker, gazetteer, parts, unverified=True,
            ))
    removed = sweep_parts(parts)
    checked, failed, overlap, dirty = stats
    if removed:
        checked += removed
        failed += removed
        dirty = True
    dirty = dirty or pre
    if dirty:
        flush_parts(parts)
        doc.save(path)
    return {"checked": checked, "failed": failed, "overlapMissed": overlap}

def verify_xlsx(path: Path, by_marker: dict, gazetteer: list[str]) -> dict:
    book = load_workbook(path)
    checked = failed = overlap = 0
    try:
        for ws in book.worksheets:
            max_col = 0
            notes: dict[int, list[str]] = {}
            for row in list(ws.iter_rows()):
                texts = []
                marked = []
                for cell in row:
                    if cell.value not in (None, ""):
                        max_col = max(max_col, cell.column)
                    if isinstance(cell.value, str):
                        texts.append(cell.value)
                        if "〔S" in cell.value:
                            marked.append(cell)
                    elif cell.value is not None:
                        texts.append(str(cell.value))
                if not marked:
                    continue
                one_checked, one_failed, one_overlap, row_notes = score_text(
                    "\n".join(texts), by_marker, gazetteer,
                )
                checked += one_checked
                failed += one_failed
                overlap += one_overlap
                for cell in marked:
                    cell.value = MARK.sub("", cell.value)
                if row_notes:
                    notes.setdefault(marked[-1].row, []).extend(row_notes)
            if notes:
                column = max_col + 1
                if 1 not in notes:
                    ws.cell(1, column, "出处")
                for row_index, row_notes in notes.items():
                    ws.cell(row_index, column, "；".join(row_notes))
        if checked:
            book.save(path)
    finally:
        book.close()
    return {"checked": checked, "failed": failed, "overlapMissed": overlap}

def markdown_to_docx(src: Path, dest: Path) -> None:
    """模型交了 md/txt 时，壳收成 docx，后面才能写批注。"""
    doc = Document()
    paragraph: list[str] = []
    table_rows: list[list[str]] = []

    def flush_paragraph() -> None:
        if paragraph:
            doc.add_paragraph("\n".join(paragraph))
            paragraph.clear()

    def flush_table() -> None:
        if not table_rows:
            return
        width = max(len(row) for row in table_rows)
        table = doc.add_table(rows=len(table_rows), cols=width)
        for index, row in enumerate(table_rows):
            for column in range(width):
                table.rows[index].cells[column].text = row[column] if column < len(row) else ""
        table_rows.clear()

    for line in read_text(src).splitlines():
        stripped = line.strip()
        if stripped.startswith("|") and stripped.endswith("|"):
            flush_paragraph()
            cells = [cell.strip() for cell in stripped.strip("|").split("|")]
            if cells and all(cell and set(cell) <= set("-: ") for cell in cells):
                continue
            table_rows.append(cells)
            continue
        flush_table()
        if stripped:
            paragraph.append(stripped)
        else:
            flush_paragraph()
    flush_paragraph()
    flush_table()
    doc.save(dest)

def verify(path: Path, chunks: list[dict]) -> dict:
    gazetteer = build_gazetteer(chunks)
    by_marker = marker_map(chunks)
    suffix = path.suffix.lower()
    if suffix == ".docx":
        stats = verify_docx(path, by_marker, gazetteer)
    elif suffix == ".xlsx":
        stats = verify_xlsx(path, by_marker, gazetteer)
    else:
        raise RuntimeError(f"不能核这个后缀 {path.suffix}")
    missed = stats["failed"]
    return {
        "verified": stats["checked"] - missed,
        "missed": missed,
        "overlapMissed": stats["overlapMissed"],
        "message": f"有 {missed} 处没核上" if missed else "",
        "docx": str(path),
    }

def prepare(req: dict) -> dict:
    workspace = Path(req["workspace"])
    if not workspace.is_dir():
        raise RuntimeError("还没有工作区")
    dsoffice = req.get("dsoffice") or ""
    node = req.get("node") or ""
    # single：材料恰好一份文档、没给别的范本。不切块、不打标，交稿后也不核出处
    single = bool(req.get("single"))
    with tempfile.TemporaryDirectory(prefix="sidemate-cite-") as tmp:
        chunks: list[dict] = []
        if not single:
            for index, raw in enumerate(req.get("materials") or [], 1):
                try:
                    chunks.extend(chunk_file(Path(raw), index, Path(tmp), dsoffice, node))
                except RuntimeError:
                    raise
                except Exception as exc:
                    fail_note(f"{type(exc).__name__}: {exc}", f"打不开《{Path(raw).name}》，可能坏了或者加了密码")
            write_tagged(chunks, workspace / "tagged")
    return {"prompt": build_prompt(req.get("utterance") or "", req.get("template") or "", single), "chunks": chunks}

def strip_docx(path: Path) -> dict:
    """把正文里的出处标记剥掉，不核、不写批注。核对没成时用这个。"""
    doc = Document(path)
    parts = xml_parts(doc)
    removed = 0
    for root in story_roots(doc, parts):
        for elm in root.iter(f"{W}p"):
            if strip_markers(elm, parts):
                removed += 1
    removed += sweep_parts(parts)
    if removed:
        flush_parts(parts)
        doc.save(path)
    return {"docx": str(path), "stripped": removed}


def strip_xlsx(path: Path) -> dict:
    book = load_workbook(path)
    removed = 0
    try:
        for ws in book.worksheets:
            for row in ws.iter_rows():
                for cell in row:
                    if not isinstance(cell.value, str) or "〔S" not in cell.value:
                        continue
                    removed += len(MARK.findall(cell.value))
                    cell.value = MARK.sub("", cell.value)
        if removed:
            book.save(path)
    finally:
        book.close()
    return {"docx": str(path), "stripped": removed}


def strip_file(path: Path) -> dict:
    """按后缀剥标记：docx/xlsx 走库，md/txt/csv 直接改文字。"""
    suffix = path.suffix.lower()
    if suffix == ".docx":
        return strip_docx(path)
    if suffix == ".xlsx":
        return strip_xlsx(path)
    if suffix in {".md", ".txt", ".csv"}:
        # 读写都按原样来：不认行尾转换，剥完标记的稿子行尾不变
        try:
            with path.open("r", encoding="utf-8", newline="") as handle:
                text = handle.read()
        except OSError:
            return {"docx": str(path), "stripped": 0}
        removed = len(MARK.findall(text))
        if removed:
            with path.open("w", encoding="utf-8", newline="") as handle:
                handle.write(MARK.sub("", text))
        return {"docx": str(path), "stripped": removed}
    return {"docx": str(path), "stripped": 0}


def fresh_docx(path: Path) -> Path:
    dest = path.with_suffix(".docx")
    number = 2
    while dest.exists():
        dest = path.with_name(f"{path.stem}-{number}.docx")
        number += 1
    return dest

def review(req: dict) -> dict:
    path = Path(req["docx"])
    if path.suffix.lower() in {".md", ".txt"}:
        dest = fresh_docx(path)
        markdown_to_docx(path, dest)
        path = dest
    try:
        # 所有 .docx 产出都要过一遍字体整理；失败只记日志，不拦核对。
        fonts.tidy_docx(path, req.get("utterance") or "", bool(req.get("hasTemplate")))
    except Exception as exc:
        fonts.log_line(f"字体整理没成：{path.name} {type(exc).__name__}: {exc}")
    return verify(path, req.get("chunks") or [])

def main() -> int:
    try:
        req = json.loads(sys.stdin.read() or "{}")
        cmd = req.get("cmd")
        if cmd == "prepare":
            result = prepare(req)
        elif cmd == "review":
            result = review(req)
        elif cmd == "tidy":
            path = Path(req["docx"])
            result = fonts.tidy_docx(path, req.get("utterance") or "", bool(req.get("hasTemplate")))
            # 顺手把标记剥干净：没有材料也不会带着〔S…·p…〕交出去
            result.update(strip_file(path))
        elif cmd == "strip":
            result = strip_file(Path(req["docx"]))
        else:
            raise RuntimeError("未知命令")
        json.dump(result, sys.stdout, ensure_ascii=False)
        sys.stdout.write("\n")
    except Exception as exc:
        sys.stderr.write(f"{exc}\n")
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
