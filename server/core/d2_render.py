# -*- coding: utf-8 -*-
"""
core/d2_render.py — D2 图表服务端渲染（0.10：d2lang 支持；0.11.1：DNA 换装）
======================================================================
用本地 d2.exe（lib/d2/d2.exe，官方 v0.9.0）把 D2 源码编译成独立 SVG，
落盘到会话工作区。供 Agent 的 render_d2 工具调用：
  - 聊天/报告：SVG 文件可直接在视窗预览或被 read_workspace 内联
  - PPT：create_ppt(action='page', svg_file='xx.svg') 直接吃渲染产物

前端另有 D2.js WASM 懒加载渲染 ```d2 块（聊天内嵌图不走本模块）。

0.11.1 统一图片流（PLAN-0111 A1）：render_svg 成功后过 apply_dna_theme()
换装 pass——D2 Neutral Default 色值 → DNA-01 深蓝金，内嵌拉丁字体 →
雅黑/Consolas 本地栈。映射表单一真源 static/dna/d2_theme.json，前端
hydrateD2 共用同一份（聊天内联图与落盘产物观感一致）。
"""
import json
import os
import re
import subprocess
import tempfile
import logging

log = logging.getLogger(__name__)

_THEME_CACHE = None
_THEME_CANDIDATES = [
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static", "dna", "d2_theme.json"),
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "static", "dna", "d2_theme.json"),
]

# 内嵌字体族引用（CSS 与属性两种形态）：d2-<前缀>-font-<变体>
_FONT_CSS_RE = re.compile(r'font-family:\s*"(d2-[^"]+-font-([a-z]+))"')
_FONT_ATTR_RE = re.compile(r'font-family="(d2-[^"]+-font-([a-z]+))"')


def _load_theme():
    """读换装映射表（缓存）。缺文件返回 None——pass 静默跳过，输出不劣于现状。"""
    global _THEME_CACHE
    if _THEME_CACHE is not None:
        return _THEME_CACHE
    for p in _THEME_CANDIDATES:
        try:
            if os.path.isfile(p):
                with open(p, "r", encoding="utf-8") as f:
                    _THEME_CACHE = json.load(f)
                return _THEME_CACHE
        except Exception as e:
            log.warning("[D2] 换装映射表读取失败 %s: %s", p, str(e)[:80])
    _THEME_CACHE = {}
    return _THEME_CACHE


def apply_dna_theme(svg: str) -> str:
    """D2 输出 → DNA-01 深蓝金（确定性字符串替换，不动图形几何）。

    1. 色值重映射：命中的 hex 全文替换（style 块 + 内联属性，marker/序列图
       的内联色一并覆盖）；未列出 hex 原样保留。
    2. 字体栈替换：内嵌 d2-xxx-font-* → 雅黑/Consolas（mono 变体走等宽栈）。
       粗体原本由内嵌字体承载（规则里无 font-weight），文末追加补偿规则。
    """
    theme = _load_theme()
    if not theme or "<svg" not in svg:
        return svg
    for src, dst in (theme.get("colors") or {}).items():
        if src == dst:
            continue
        svg = svg.replace(src, dst)
        svg = svg.replace(src.lower(), dst)
    fonts = theme.get("fonts") or {}
    sans, mono = fonts.get("sans"), fonts.get("mono")

    def _sub(m):
        variant = m.group(2)
        fam = mono if variant == "mono" and mono else sans
        if not fam:
            return m.group(0)
        sep = ':' if m.group(0).startswith('font-family:') else '='
        return 'font-family%s%s' % (sep, fam)

    if sans or mono:
        svg = _FONT_CSS_RE.sub(_sub, svg)
        svg = _FONT_ATTR_RE.sub(_sub, svg)
    rules = theme.get("append_rules")
    if rules and "</svg>" in svg:
        svg = svg.replace("</svg>", '<style type="text/css">%s</style></svg>' % rules, 1)
    return svg


_EXE_CANDIDATES = [
    # 仓库/运行时布局：server/../lib/d2/d2.exe 与 server/../../lib/d2/d2.exe
    # （前者=源码树 lib 在 server 旁，后者=rt 打包布局 lib 在 server 上两级；对齐 llama-server 惯例）
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "lib", "d2", "d2.exe"),
    os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "lib", "d2", "d2.exe"),
    # server/lib 兜底 + PATH（开发者本机装过 d2 的场景）
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "lib", "d2", "d2.exe"),
    "d2",
    "d2.exe",
]

_exe_cache = None


def find_d2_exe():
    """定位 d2 可执行文件（结果缓存）。找不到返回 None（工具侧报友好错误）。"""
    global _exe_cache
    if _exe_cache is not None:
        return _exe_cache
    for cand in _EXE_CANDIDATES:
        if cand in ("d2", "d2.exe"):
            # PATH 查找：where/which 交给 subprocess，直接试探
            try:
                r = subprocess.run([cand, "--version"], capture_output=True, timeout=10)
                if r.returncode == 0:
                    _exe_cache = cand
                    return cand
            except Exception:
                continue
        elif os.path.isfile(cand):
            _exe_cache = cand
            return cand
    return None


def render_svg(source: str) -> dict:
    """编译 D2 源码 → SVG 文本。

    Returns:
        {"ok": True, "svg": str} 或 {"ok": False, "error": str}（错误含行列号，
        直接回传给模型自修——A/B 实测 d2 报错可定位性好）
    """
    exe = find_d2_exe()
    if not exe:
        return {"ok": False,
                "error": "未找到 d2 渲染器（lib/d2/d2.exe）。请改用 mermaid 输出图表。"}
    try:
        with tempfile.TemporaryDirectory() as td:
            src = os.path.join(td, "a.d2")
            with open(src, "w", encoding="utf-8") as f:
                f.write(source)
            out = os.path.join(td, "a.svg")
            r = subprocess.run([exe, src, out], capture_output=True, timeout=30, cwd=td)
            if r.returncode != 0 or not os.path.isfile(out):
                err = (r.stderr or r.stdout or b"").decode("utf-8", "replace").strip()
                # 去掉临时路径噪音，保留行列号与原因
                err = err.replace(src, "a.d2")
                return {"ok": False, "error": err[:300] or "d2 编译失败（未知原因）"}
            with open(out, "r", encoding="utf-8") as f:
                svg = f.read()
            # 0.11.1 A1：DNA 换装（未命中映射的色值原样保留，观感不劣于现状）
            try:
                svg = apply_dna_theme(svg)
            except Exception as e:
                log.warning("[D2] 换装 pass 异常（原样输出）: %s", str(e)[:80])
            return {"ok": True, "svg": svg}
    except subprocess.TimeoutExpired:
        return {"ok": False, "error": "d2 编译超时（30s）——图可能过于庞大"}
    except Exception as e:
        return {"ok": False, "error": "d2 渲染异常: %s" % str(e)[:120]}


def render_to_workspace(chat_id: str, name: str, source: str) -> dict:
    """渲染并写入会话工作区，返回给 Agent 的结果。"""
    import re as _re
    from core.doc_session import write_workspace_file

    r = render_svg(source)
    if not r.get("ok"):
        return {"ok": False,
                "error": r.get("error", ""),
                "message": "D2 编译失败：%s\n请修正语法后重试，或改用 mermaid。" % r.get("error", "")[:200]}

    # 文件名：默认 d2-图N.svg；允许模型传名（去危险字符，强制 .svg 后缀）
    fname = (name or "").strip()
    if not fname:
        fname = "d2-%d.svg" % int(__import__("time").time() % 100000)
    fname = _re.sub(r'[\\/:*?"<>|]+', "_", fname)
    if not fname.lower().endswith(".svg"):
        fname += ".svg"

    try:
        w = write_workspace_file(chat_id, fname, r["svg"])
    except ValueError as e:
        return {"ok": False, "error": "bad_path", "message": "文件名不合法: %s" % str(e)[:80]}

    log.info("[D2] 渲染成功: %s (%d chars) → workspace/%s", chat_id, len(r["svg"]), w.get("name"))
    # 0.11.1 A3：svg_lint 质量门（warning 不阻断，随结果回传模型）
    try:
        from core.svg_lint import lint_svg
        issues = lint_svg(r["svg"])
    except Exception:
        issues = []
    msg = "D2 图已渲染为 %s（视窗-文件可见；PPT 页可用 create_ppt(action='page', svg_file='%s') 直接引用）" \
        % (w.get("name"), w.get("name"))
    if issues:
        msg += "；质量提示：%s" % "；".join(issues)
    return {
        "ok": True,
        "file": w.get("name"),
        "svg_chars": len(r["svg"]),
        "warnings": issues,
        "message": msg,
    }
