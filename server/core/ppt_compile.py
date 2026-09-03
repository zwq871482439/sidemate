# -*- coding: utf-8 -*-
"""
core/ppt_compile.py — create_ppt 工具的 deck 管理与 SVG→PPTX 编译服务
======================================================================

设计来源：PLAN-099-010 三章 1（create_ppt：SVG 单一中间表示 + 设计 DNA）。

存储布局（会话 workspace 内，遵循 ppt-master 工程结构）：
    <会话>/workspace/ppt/<deck>/spec_lock.md       执行锁（画布/语言/结构=flat）
    <会话>/workspace/ppt/<deck>/svg_output/P01.svg 逐页手写 SVG（预览与编译同源）
    <会话>/workspace/ppt/<deck>/validation/        编译报告（postflight）

编译链：vendor/ppt_master/（ppt-master v6.1.0 抽取，MIT，署名见该目录）。
    显式 -o 输出路径 → 不做 backup 搬迁，svg_output 原地保留（预览可继续用）。

M1 边界：AI 产物只进会话 workspace，不进项目 .sidemate
（.sidemate 写入保留给用户显式「存产物」动作）。
"""

from __future__ import annotations

import json
import logging
import os
import re
from xml.etree import ElementTree as ET

log = logging.getLogger(__name__)

_VENDOR_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                           "vendor", "ppt_master")

CANVAS_VIEWBOX = "0 0 1280 720"  # 16:9，PoC 验证基线
MAX_PAGES = 30                   # 单次 deck 页数硬上限（轮次预算保护）
MAX_SVG_BYTES = 512 * 1024       # 单页 SVG 上限 512KB（防失控输出）

# spec_lock forbidden 清单（与 PoC spec_lock.md 一致；文本实体允许 XML 五种保留转义）
_FORBIDDEN_TAGS = ("mask", "style", "foreignObject", "textPath", "set",
                   "script", "iframe", "animate", "animateTransform", "animateMotion")
_ALLOWED_ENTITIES = ("&amp;", "&lt;", "&gt;", "&quot;", "&apos;")

_SPEC_LOCK_TEMPLATE = """<!-- ppt-master-schema: spec-lock/v1 -->
# Execution Lock

## canvas
- viewBox: 0 0 1280 720
- format: ppt169

## communication
- primary_language: zh-CN
- audience: 桌伴用户
- objective: {title}
- core_message: {title}
- consumption_mode: screen

## mode
- mode: free design

## visual_style
- visual_style: DNA-01 深蓝金

## colors
- bg: #0F2B46
- primary: #0F2B46
- accent: #E8B54D
- text: #FFFFFF

## typography
- font_family: Microsoft YaHei
- title_family: Microsoft YaHei
- body_family: Microsoft YaHei
- title: 72
- subtitle: 34
- body: 26
- aux: 19
- caption: 18

## icons
- library: none
- inventory: none

## pptx_structure
- mode: flat

## forbidden
- `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<set>`, `<script>` / event attributes, `<iframe>`
- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters
"""


def _workspace_root(chat_id):
    from core.doc_session import _workspace_root as _ws
    return _ws(chat_id)


def _deck_dir(chat_id, deck):
    return os.path.join(_workspace_root(chat_id), "ppt", deck)


def _safe_deck_id(title):
    """从标题生成目录安全 deck id（保留中英文数字，其余折叠为 -）。"""
    s = re.sub(r"[^\w一-鿿-]+", "-", (title or "").strip()).strip("-").lower()
    return (s[:40] or "deck")


def _safe_filename(name):
    s = re.sub(r'[\\/:*?"<>|]+', "_", (name or "").strip())
    return s[:60] or "presentation"


def list_decks(chat_id):
    """列出会话 workspace 里的全部 deck（供视窗预览 tab 回放）。

    Returns:
        list[dict]: [{deck, title, pages: [1, 2, ...], built: bool, pptx: str|None}]
    """
    base = os.path.join(_workspace_root(chat_id), "ppt")
    if not os.path.isdir(base):
        return []
    decks = []
    for deck in sorted(os.listdir(base)):
        d = os.path.join(base, deck)
        svg_dir = os.path.join(d, "svg_output")
        if not os.path.isdir(svg_dir):
            continue
        pages = []
        for fn in sorted(os.listdir(svg_dir)):
            m = re.fullmatch(r"P(\d+)\.svg", fn, re.IGNORECASE)
            if m:
                pages.append(int(m.group(1)))
        title = deck
        try:
            lock = open(os.path.join(d, "spec_lock.md"), encoding="utf-8").read()
            m = re.search(r"^- objective: (.+)$", lock, re.MULTILINE)
            if m:
                title = m.group(1).strip()
        except OSError:
            pass
        built = None
        ws = _workspace_root(chat_id)
        for fn in os.listdir(ws):
            if fn.endswith(".pptx") and _safe_deck_id(fn[:-5]) == deck:
                built = fn
                break
        decks.append({"deck": deck, "title": title, "pages": pages, "pptx": built})
    return decks


def begin_deck(chat_id, title):
    """开新 deck：建目录 + 写 spec_lock.md（DNA-01 深蓝金默认）。

    Returns:
        dict: {ok, deck, title, canvas, max_pages, next}
    """
    if not (title or "").strip():
        return {"ok": False, "error": "missing_title",
                "message": "缺少 title（演示文稿主题）"}
    deck = _safe_deck_id(title)
    d = _deck_dir(chat_id, deck)
    os.makedirs(os.path.join(d, "svg_output"), exist_ok=True)
    lock_path = os.path.join(d, "spec_lock.md")
    if not os.path.exists(lock_path):
        with open(lock_path, "w", encoding="utf-8") as f:
            f.write(_SPEC_LOCK_TEMPLATE.format(title=title.strip()))
    existing = list_decks(chat_id)
    pages = []
    for dd in existing:
        if dd["deck"] == deck:
            pages = dd["pages"]
            break
    return {
        "ok": True, "deck": deck, "title": title.strip(),
        "canvas": CANVAS_VIEWBOX, "max_pages": MAX_PAGES,
        "existing_pages": pages,
        "next": "用 create_ppt(action='page', page=1, svg=...) 逐页提交；"
                "全部完成后 create_ppt(action='build') 编译下载",
    }


def validate_svg(svg_text):
    """单页 SVG 质量门（对齐 spec_lock forbidden + PoC 教训）。

    Returns:
        list[str]: 问题清单（空=通过）
    """
    issues = []
    if not svg_text or not svg_text.strip():
        return ["SVG 内容为空"]
    if len(svg_text.encode("utf-8")) > MAX_SVG_BYTES:
        issues.append("SVG 超过 %dKB 上限" % (MAX_SVG_BYTES // 1024))
    try:
        root = ET.fromstring(svg_text)
    except ET.ParseError as e:
        return ["XML 解析失败：%s（常见原因：& 未转义为 &amp;）" % str(e)]
    tag = root.tag.rsplit("}", 1)[-1]
    if tag != "svg":
        issues.append("根元素必须是 <svg>，实际 <%s>" % tag)
    vb = root.get("viewBox", "").strip()
    if vb != CANVAS_VIEWBOX:
        issues.append('viewBox 必须是 "%s"，实际 "%s"' % (CANVAS_VIEWBOX, vb or "(缺失)"))
    # forbidden 标签（遍历全部元素，去命名空间）
    found = set()
    for el in root.iter():
        t = el.tag.rsplit("}", 1)[-1]
        if t in _FORBIDDEN_TAGS:
            found.add(t)
        for attr in el.attrib:
            if attr.startswith("on"):
                found.add("event:" + attr)
            if attr == "class":
                found.add("class")
    for t in sorted(found):
        issues.append("禁用特性：%s" % t)
    # 样式表与字体
    if "<style" in svg_text:
        issues.append("禁用特性：<style>（样式一律写内联属性）")
    if "@font-face" in svg_text:
        issues.append("禁用特性：@font-face")
    # HTML 命名实体（XML 只认五种保留转义）
    for m in re.finditer(r"&[a-zA-Z][a-zA-Z0-9]+;", svg_text):
        ent = m.group(0)
        if ent not in _ALLOWED_ENTITIES:
            issues.append("HTML 命名实体 %s 不允许，文本请写原始 Unicode 字符" % ent)
            break
    return issues


def add_page(chat_id, deck, page, svg_text):
    """写一页 SVG（先过质量门，有 issue 也落盘但明确报告，便于模型修复重发）。

    Returns:
        dict: {ok, deck, page, issues, pages, path}
    """
    deck = _safe_deck_id(deck)
    d = _deck_dir(chat_id, deck)
    lock_path = os.path.join(d, "spec_lock.md")
    if not os.path.exists(lock_path):
        return {"ok": False, "error": "deck_not_found",
                "message": "deck「%s」不存在，先调 create_ppt(action='begin', title=...)" % deck}
    try:
        page = int(page)
    except (TypeError, ValueError):
        return {"ok": False, "error": "bad_page", "message": "page 必须是整数（1 起）"}
    if page < 1 or page > MAX_PAGES:
        return {"ok": False, "error": "bad_page",
                "message": "page 须在 1~%d 之间" % MAX_PAGES}
    issues = validate_svg(svg_text or "")
    if issues:
        # 质量门未过不落盘——svg_output 保持永远可编译，模型修复后重发同页
        return {"ok": False, "deck": deck, "page": page, "issues": issues,
                "message": "第 %d 页质量门未过（未保存）：%s——请修复后用相同 page 重发"
                           % (page, "；".join(issues))}
    fn = "P%02d.svg" % page
    path = os.path.join(d, "svg_output", fn)
    with open(path, "w", encoding="utf-8") as f:
        f.write(svg_text or "")
    pages = []
    for dd in list_decks(chat_id):
        if dd["deck"] == deck:
            pages = dd["pages"]
            break
    return {
        "ok": True, "deck": deck, "page": page, "issues": [],
        "pages": pages,
        "rel_path": "ppt/%s/svg_output/%s" % (deck, fn),
        "message": "第 %d 页已接收" % page,
    }


def build_deck(chat_id, deck, out_name=None):
    """编译 deck 全部 svg_output/P*.svg → workspace 根下 .pptx。

    Returns:
        dict: {ok, pptx_name, pptx_path, pages, status, warnings, message}
    """
    deck = _safe_deck_id(deck)
    d = _deck_dir(chat_id, deck)
    svg_dir = os.path.join(d, "svg_output")
    if not os.path.isdir(svg_dir):
        return {"ok": False, "error": "deck_not_found",
                "message": "deck「%s」不存在或没有页面，先 begin 再逐页 page" % deck}
    pages = sorted(fn for fn in os.listdir(svg_dir) if re.fullmatch(r"P\d+\.svg", fn, re.IGNORECASE))
    if not pages:
        return {"ok": False, "error": "no_pages",
                "message": "deck「%s」还没有任何页面（svg_output 为空）" % deck}

    base = _safe_filename(out_name or deck)
    pptx_name = base + ".pptx"
    out_path = os.path.join(_workspace_root(chat_id), pptx_name)

    if _VENDOR_DIR not in os.sys.path:
        os.sys.path.insert(0, _VENDOR_DIR)
    os.makedirs(os.path.join(d, "validation"), exist_ok=True)

    # 1) 终检：svg_quality_checker --stage final（编译链要求 matched 质量报告才放行）
    try:
        import sys as _sys
        from svg_quality.cli import main as _qc_main
        _old_argv, _old_out, _old_err = _sys.argv, _sys.stdout, _sys.stderr
        _sys.argv = ["svg_quality_checker.py", d, "--stage", "final", "--json"]
        with open(os.path.join(d, "validation", "qc.log"), "w", encoding="utf-8") as lf:
            _sys.stdout, _sys.stderr = lf, lf
            try:
                _qc_main()
            except SystemExit:
                pass
            finally:
                _sys.stdout, _sys.stderr = _old_out, _old_err
                _sys.argv = _old_argv
    except Exception as e:
        log.warning("[PPT] 质量检查异常 deck=%s: %s", deck, str(e)[:120])

    qc_errors = []
    try:
        qc = json.load(open(os.path.join(d, "validation", "svg_quality_report.json"),
                            encoding="utf-8"))
        if (qc.get("summary") or {}).get("errors", 0) > 0:
            for f in qc.get("files", []) or []:
                for iss in (f.get("issues") or [])[:3]:
                    qc_errors.append("%s: %s" % (f.get("file", "?"), str(iss)[:100]))
    except (OSError, ValueError):
        pass
    if qc_errors:
        return {"ok": False, "error": "quality_gate",
                "message": "终检发现 %d 处错误，请修复对应页后重发再 build：%s"
                           % (len(qc_errors), "；".join(qc_errors[:5])),
                "issues": qc_errors[:10]}

    # 2) 编译：svg_to_pptx（显式 -o，不做 backup 搬迁）
    log_file = os.path.join(d, "validation", "build.log")
    try:
        from svg_to_pptx import main as _svg2pptx_main
        with open(log_file, "w", encoding="utf-8") as lf:
            _old_out, _old_err = os.sys.stdout, os.sys.stderr
            os.sys.stdout, os.sys.stderr = lf, lf
            try:
                rc = _svg2pptx_main([d, "-o", out_path, "-q"])
            except SystemExit as e:
                rc = e.code if isinstance(e.code, int) else 78
            finally:
                os.sys.stdout, os.sys.stderr = _old_out, _old_err
    except Exception as e:
        log.exception("[PPT] 编译异常 deck=%s", deck)
        return {"ok": False, "error": "compile_error",
                "message": "编译失败：%s" % str(e)[:200]}

    if rc != 0 or not os.path.exists(out_path):
        tail = ""
        try:
            tail = open(log_file, encoding="utf-8").read()[-400:]
        except OSError:
            pass
        return {"ok": False, "error": "compile_failed",
                "message": "编译未通过（rc=%s）。%s" % (rc, tail[-200:])}

    # 读 postflight 报告（validation/<基名>.report.json）
    status, warnings = "unknown", []
    report_path = os.path.join(d, "validation", base + ".report.json")
    try:
        report = json.load(open(report_path, encoding="utf-8"))
        status = report.get("status", "unknown")
        checks = report.get("checks") or {}
        if isinstance(checks, dict):
            for name, val in checks.items():
                v = str(val).lower()
                if "fail" in v or "error" in v or "warn" in v:
                    warnings.append("%s: %s" % (name, val))
        for w in report.get("warnings") or []:
            warnings.append(str(w)[:120])
    except (OSError, ValueError):
        pass

    log.info("[PPT] 编译完成 deck=%s pages=%d status=%s out=%s",
             deck, len(pages), status, pptx_name)
    return {
        "ok": True, "deck": deck, "pptx_name": pptx_name,
        "pages": len(pages), "status": status, "warnings": warnings[:10],
        "message": "PPT 已生成：%s（%d 页，%s）%s" % (
            pptx_name, len(pages), status,
            ("；注意：" + "；".join(warnings[:3])) if warnings else ""),
    }
