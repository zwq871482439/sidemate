# -*- coding: utf-8 -*-
"""
core/svg_lint.py — SVG 图表质量门（0.11.1 A3，PLAN-0111）
======================================================
方法论借自 diagram-design verify-geometry.py（ADR-0005：只存在于散文的规则
必然产出坏例子——规则必须程序化校验）。v1 范围克制，只查确定性可判的项：

  - viewBox 缺失（无法自适应缩放）
  - <title>/<desc> 缺失（无障碍契约；diagram-design Accessible SVG Contract）
  - 字号 < 8px 的文本（不可读）
  - 矩形节点数 > 12（复杂度预算超限提示——预算 ≤9 节点，12 为硬提示线）

返回 issues 列表（中文，可直接展示）；空列表 = 通过。全部为 warning 语义：
不阻断落盘/渲染，只提示（PLAN-0111 §三 A3）。
"""
import re

_FONT_SIZE_RE = re.compile(r'font-size[:=]\s*["\']?([\d.]+)')
_RECT_RE = re.compile(r'<rect\b')

MIN_FONT = 8.0
NODE_BUDGET_HINT = 12


def lint_svg(svg: str) -> list:
    """对 SVG 文本做质量检查，返回问题列表（空=通过）。非 SVG 输入返回单条错误。"""
    if not svg or "<svg" not in svg:
        return ["不是 SVG 文档（缺 <svg> 根）"]
    issues = []
    if "viewBox" not in svg:
        issues.append("缺 viewBox（图无法自适应缩放）")
    if "<title" not in svg:
        issues.append("缺 <title>（无障碍标题，读屏不可用）")
    if "<desc" not in svg:
        issues.append("缺 <desc>（无障碍描述）")
    sizes = [float(m) for m in _FONT_SIZE_RE.findall(svg) if m]
    small = [s for s in sizes if 0 < s < MIN_FONT]
    if small:
        issues.append("存在 %d 处字号 <%.0fpx（过小不可读）" % (len(small), MIN_FONT))
    rects = len(_RECT_RE.findall(svg))
    if rects > NODE_BUDGET_HINT:
        issues.append("节点数偏多（%d 个矩形，建议拆分为总览+详图）" % rects)
    return issues
