# -*- coding: utf-8 -*-
"""
core/d2_render.py — D2 图表服务端渲染（0.10：d2lang 支持）
======================================================================
用本地 d2.exe（lib/d2/d2.exe，官方 v0.9.0）把 D2 源码编译成独立 SVG，
落盘到会话工作区。供 Agent 的 render_d2 工具调用：
  - 聊天/报告：SVG 文件可直接在视窗预览或被 read_workspace 内联
  - PPT：create_ppt(action='page', svg_file='xx.svg') 直接吃渲染产物

前端另有 D2.js WASM 懒加载渲染 ```d2 块（聊天内嵌图不走本模块）。
"""
import os
import subprocess
import tempfile
import logging

log = logging.getLogger(__name__)

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
                return {"ok": True, "svg": f.read()}
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
    return {
        "ok": True,
        "file": w.get("name"),
        "svg_chars": len(r["svg"]),
        "message": "D2 图已渲染为 %s（视窗-文件可见；PPT 页可用 create_ppt(action='page', svg_file='%s') 直接引用）"
                   % (w.get("name"), w.get("name")),
    }
