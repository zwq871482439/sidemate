#!/usr/bin/env python3
"""核对之前的两道兜底：拆掉表里塞标记的那一列、删掉解释标记的说明段。壳做，不经模型。

模型爱在表里单加一列「标记」，删掉标记后那列就全空了；这里把每格的标记挪到同一行
左边最近一个有字的格子的文字末尾，再连表头一起删掉这一列。碰到合并单元格（gridSpan /
vMerge）落到这一列的表不动，只记一行日志。
"""
from __future__ import annotations

import re

from fonts import W, log_line

MARK = re.compile(r"〔S\d+·[^〕]+〕")
XML_SPACE = "{http://www.w3.org/XML/1998/namespace}space"


def text_nodes(tc) -> list:
    # 格子自己的字，不算套在里面的表。
    found = []
    for node in tc.iter(f"{W}t"):
        skip = False
        up = node.getparent()
        while up is not None and up is not tc:
            if up.tag == f"{W}tbl":
                skip = True
                break
            up = up.getparent()
        if not skip:
            found.append(node)
    return found


def cell_text(tc) -> str:
    return "".join(node.text or "" for node in text_nodes(tc))


def cell_plain(tc) -> str:
    # 去掉标记和空白后还剩不剩字
    return re.sub(r"\s+", "", MARK.sub("", cell_text(tc)))


def strip_marks(nodes) -> list[str]:
    # 把这些节点里的标记删干净，返回删掉的标记
    raw = "".join(node.text or "" for node in nodes)
    found = list(MARK.finditer(raw))
    if not found:
        return []
    drop = [False] * len(raw)
    for item in found:
        drop[item.start():item.end()] = [True] * (item.end() - item.start())
    cursor = 0
    for node in nodes:
        text = node.text or ""
        updated = "".join(char for index, char in enumerate(text) if not drop[cursor + index])
        cursor += len(text)
        node.text = updated or None
        if updated[:1].isspace() or updated[-1:].isspace():
            node.set(XML_SPACE, "preserve")
    return [item.group(0) for item in found]


def append_text(tc, text: str) -> None:
    nodes = text_nodes(tc)
    if nodes:
        nodes[-1].text = (nodes[-1].text or "") + text
        return
    para = tc.find(f"{W}p")
    if para is None:
        return
    run = para.makeelement(f"{W}r", {})
    piece = para.makeelement(f"{W}t", {})
    piece.text = text
    run.append(piece)
    para.append(run)


def row_cells(tr) -> list:
    # 格子可能包在 w:sdt 里
    cells = []
    for child in tr:
        if child.tag == f"{W}tc":
            cells.append(child)
        elif child.tag == f"{W}sdt":
            content = child.find(f"{W}sdtContent")
            if content is not None:
                cells.extend(item for item in content if item.tag == f"{W}tc")
    return cells


def row_grid(tr) -> list[tuple]:
    grid = []
    col = 0
    for tc in row_cells(tr):
        span = 1
        tcpr = tc.find(f"{W}tcPr")
        if tcpr is not None:
            holder = tcpr.find(f"{W}gridSpan")
            value = holder.get(f"{W}val") if holder is not None else ""
            if value.isdigit():
                span = max(1, int(value))
        grid.append((tc, col, span))
        col += span
    return grid


def merged_at(grid, col: int) -> bool:
    for tc, start, span in grid:
        if start <= col < start + span:
            if span > 1:
                return True
            tcpr = tc.find(f"{W}tcPr")
            if tcpr is not None and tcpr.find(f"{W}vMerge") is not None:
                return True
    return False


def table_rows(tbl) -> list:
    rows = []
    for child in tbl.iterchildren():
        if child.tag == f"{W}tr":
            rows.append(child)
        elif child.tag == f"{W}sdt":
            content = child.find(f"{W}sdtContent")
            if content is not None:
                rows.extend(item for item in content if item.tag == f"{W}tr")
    return rows


def marker_column(tbl) -> int | None:
    # 除表头外每格去掉标记和空白后都是空的、且至少一格有标记的那一列
    rows = table_rows(tbl)
    if len(rows) < 2:
        return None
    grids = [row_grid(tr) for tr in rows]
    grid_elm = tbl.find(f"{W}tblGrid")
    cols = grid_elm.findall(f"{W}gridCol") if grid_elm is not None else []
    ncols = len(cols) or max((item[1] + item[2] for g in grids for item in g), default=0)
    if ncols < 2 or (cols and len(cols) != ncols):
        return None
    for col in range(ncols):
        marked = False
        empty = True
        for grid in grids[1:]:
            for tc, start, span in grid:
                if not start <= col < start + span:
                    continue
                if MARK.search(cell_text(tc)):
                    marked = True
                if cell_plain(tc):
                    empty = False
        if not (marked and empty):
            continue
        if any(merged_at(grid, col) for grid in grids):
            log_line(f"标记列碰到合并单元格，这张表不动：第 {col + 1} 列")
            continue
        return col
    return None


def drop_column(tbl, col: int) -> None:
    for tr in table_rows(tbl):
        for tc, start, span in row_grid(tr):
            if start <= col < start + span:
                parent = tc.getparent()
                if parent is not None:
                    parent.remove(tc)
    grid_elm = tbl.find(f"{W}tblGrid")
    if grid_elm is not None:
        cols = grid_elm.findall(f"{W}gridCol")
        if len(cols) > col:
            grid_elm.remove(cols[col])


def strip_marker_columns(tbl) -> bool:
    changed = False
    for _round in range(8):
        col = marker_column(tbl)
        if col is None:
            break
        for tr in table_rows(tbl):
            left = None
            grid = row_grid(tr)
            for tc, start, span in grid:
                if start + span <= col and cell_text(tc).strip():
                    left = tc
            for tc, start, span in grid:
                if not start <= col < start + span:
                    continue
                markers = strip_marks(text_nodes(tc))
                if markers and left is not None:
                    append_text(left, "".join(markers))
                elif markers:
                    cells = row_cells(tr)
                    if cells:
                        append_text(cells[0], "".join(markers))
        drop_column(tbl, col)
        changed = True
    return changed


def note_paragraph(elm) -> bool:
    # 整段在讲标记的说明段：字面占位 S0x / pN，或同一段里又有 tagged 又有标记。
    # 「肿瘤标记物」这种普通段落不沾边。
    parent = elm.getparent()
    if parent is None or parent.tag == f"{W}tc":
        return False
    ppr = elm.find(f"{W}pPr")
    if ppr is not None and ppr.find(f"{W}sectPr") is not None:
        return False
    text = "".join(node.text or "" for node in elm.iter(f"{W}t"))
    if "S0x" in text or "pN" in text:
        return True
    return "标记" in text and "tagged" in text.lower()


def tidy_document(roots) -> bool:
    changed = False
    seen_tbl = set()
    for root in roots:
        for tbl in root.iter(f"{W}tbl"):
            if id(tbl) in seen_tbl:
                continue
            seen_tbl.add(id(tbl))
            if strip_marker_columns(tbl):
                changed = True
        for elm in list(root.iter(f"{W}p")):
            if note_paragraph(elm):
                parent = elm.getparent()
                parent.remove(elm)
                changed = True
    return changed
