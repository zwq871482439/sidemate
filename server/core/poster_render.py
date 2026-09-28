# -*- coding: utf-8 -*-
"""
core/poster_render.py — 确定性海报渲染（0.11 A3）
================================================

三套模板（与场景卡子卡一一对应）：
  typo  文字排版海报：大字层级 + 金色点睛（金句/宣言/活动通知）
  image 图文海报：左图区（几何装饰）+ 右文区（产品/人物/课程）
  data  数据海报：大数字 + 条形对比（战报/榜单/成绩）

设计约束（DNA-01，docs/DNA-01-DESIGN.md）：
  - 色板取自 design_dna.DNA_CARDS（deep=DNA-01 深蓝金 / light=DNA-02 素白）
  - 纯几何装饰（矩形/线），禁照片/emoji/跨色相渐变；金色只做点睛
  - 确定性：同参数同输出（无随机、无时间戳），可哈希验收

用法（create_poster 工具）：
    html = render_poster(style="data", title="Q3 战报", items=["GMV +58%", ...],
                         size="1080x1440", tone="deep")
"""

from __future__ import annotations

import html as _html
import re
from typing import List, Optional

# 尺寸预设（create_poster schema 的 enum 保持一致）
_SIZE_RE = re.compile(r"^(\d{3,4})x(\d{3,4})$")
_MAX_ITEMS = 5
_MAX_TITLE = 30
_MAX_LINE = 40


def _palette(tone: str) -> dict:
    from core.design_dna import DNA_CARDS
    card = DNA_CARDS["DNA-01"] if tone != "light" else DNA_CARDS["DNA-02"]
    p = card["palette"]
    return {
        "bg": p["bg"], "fg": p["text"], "muted": p["muted"],
        "accent": p["accent"], "primary": p["primary"],
        # light 底上金色对比不足，点睛用 primary；deep 底用金
        "gold": p["accent"] if tone != "light" else p["primary"],
    }


def _esc(s) -> str:
    return _html.escape(str(s or ""), quote=True)


def _clean_items(items) -> List[str]:
    out = []
    for it in (items or [])[:_MAX_ITEMS]:
        t = str(it or "").strip()[:_MAX_LINE]
        if t:
            out.append(t)
    return out


def _parse_size(size: str) -> tuple:
    m = _SIZE_RE.match(str(size or "").strip())
    if not m:
        raise ValueError("size 格式应为 WxH（如 1080x1440），收到：%r" % size)
    w, h = int(m.group(1)), int(m.group(2))
    if not (300 <= w <= 2400 and 300 <= h <= 2400):
        raise ValueError("尺寸超出范围（300-2400px）")
    return w, h


def _title_sizes(w: int, h: int, title: str) -> dict:
    """按画布宽与标题长度自适应字号（确定性：只依赖入参）。"""
    base = w * (0.085 if h >= w else 0.075)      # 竖版字更大
    if len(title) > 16:
        base *= 0.82
    elif len(title) > 10:
        base *= 0.92
    return {
        "title": round(base),
        "subtitle": round(base * 0.36),
        "kicker": round(base * 0.26),
        "item": round(base * 0.30),
        "footer": round(base * 0.22),
        "num": round(base * 0.62),
    }


def _shell(w: int, h: int, bg: str, body: str, fg: str) -> str:
    return (
        '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n'
        '<meta name="viewport" content="width=device-width, initial-scale=1.0">\n'
        '<title>海报</title>\n</head>\n<body style="margin:0;padding:0;background:#EEF3F8;">\n'
        '<div style="width:%dpx;height:%dpx;background:%s;color:%s;'
        'font-family:\'Microsoft YaHei\',\'PingFang SC\',sans-serif;'
        'box-sizing:border-box;overflow:hidden;margin:0 auto;">\n%s\n</div>\n</body>\n</html>\n'
        % (w, h, bg, fg, body)
    )


def render_poster(style: str, title: str, subtitle: str = "", items: Optional[List[str]] = None,
                  size: str = "1080x1440", tone: str = "deep", footer: str = "") -> str:
    """渲染一张海报，返回自包含 HTML 字符串（确定性）。"""
    style = (style or "typo").strip().lower()
    if style not in ("typo", "image", "data"):
        raise ValueError("style 只支持 typo / image / data，收到：%r" % style)
    tone = (tone or "deep").strip().lower()
    if tone not in ("deep", "light"):
        raise ValueError("tone 只支持 deep / light，收到：%r" % tone)
    title = str(title or "").strip()
    if not title:
        raise ValueError("title 不能为空")
    title = title[:_MAX_TITLE]
    w, h = _parse_size(size)
    pal = _palette(tone)
    fs = _title_sizes(w, h, title)
    items = _clean_items(items)

    if style == "typo":
        body = _tpl_typo(w, h, pal, fs, title, subtitle, items, footer)
    elif style == "image":
        body = _tpl_image(w, h, pal, fs, title, subtitle, items, footer)
    else:
        body = _tpl_data(w, h, pal, fs, title, subtitle, items, footer)
    return _shell(w, h, pal["bg"], body, pal["fg"])


# ============================================================
#  模板 1：文字排版（大字层级 + 金色点睛）
# ============================================================

def _tpl_typo(w, h, pal, fs, title, subtitle, items, footer):
    pad = round(w * 0.10)
    kicker = '<div style="font-size:%(kicker)spx;color:%(gold)s;letter-spacing:6px;'
    kicker += 'margin-bottom:%(gap)dpx;">SIDEMATE</div>'
    parts = [kicker % dict(fs, gold=pal["gold"], gap=round(fs["title"] * 0.35))]
    parts.append(
        '<div style="font-size:%dpx;font-weight:700;line-height:1.18;margin:0;">%s</div>'
        % (fs["title"], _esc(title)))
    if subtitle:
        parts.append(
            '<div style="width:%dpx;height:4px;background:%s;border-radius:2px;'
            'margin:%dpx 0;"></div><div style="font-size:%dpx;color:%s;line-height:1.6;">%s</div>'
            % (round(fs["title"] * 1.6), pal["gold"], round(fs["title"] * 0.4),
               fs["subtitle"], pal["muted"], _esc(subtitle)))
    if items:
        rows = []
        for i, it in enumerate(items, 1):
            rows.append(
                '<div style="display:flex;align-items:baseline;gap:14px;margin-top:%dpx;">'
                '<span style="font-family:Consolas,monospace;font-size:%dpx;color:%s;">%02d</span>'
                '<span style="font-size:%dpx;line-height:1.5;">%s</span></div>'
                % (round(fs["item"] * 0.55), round(fs["item"] * 0.8), pal["gold"], i,
                   fs["item"], _esc(it)))
        parts.append('<div style="margin-top:%dpx;">%s</div>'
                     % (round(fs["title"] * 0.55), "".join(rows)))
    if footer:
        parts.append(
            '<div style="position:absolute;left:%dpx;right:%dpx;bottom:%dpx;'
            'display:flex;justify-content:space-between;font-size:%dpx;color:%s;letter-spacing:2px;">'
            '<span>%s</span><span style="color:%s;">●</span></div>'
            % (pad, pad, round(h * 0.06), fs["footer"], pal["muted"], _esc(footer), pal["gold"]))
    inner = "".join(parts)
    return ('<div style="position:relative;width:100%%;height:100%%;padding:%dpx;'
            'display:flex;flex-direction:column;justify-content:center;">%s</div>' % (pad, inner))


# ============================================================
#  模板 2：图文（左几何图区 + 右文区）
# ============================================================

def _tpl_image(w, h, pal, fs, title, subtitle, items, footer):
    pad = round(w * 0.07)
    # 左侧图区：纯几何装饰（同心圆 + 金色角块），确定性
    deco = (
        '<div style="position:relative;width:100%%;height:100%%;background:%(primary)s;">'
        '<div style="position:absolute;left:50%%;top:50%%;transform:translate(-50%%,-50%%);'
        'width:%(c1)dpx;height:%(c1)dpx;border-radius:50%%;border:2px solid %(muted)s;opacity:.35;"></div>'
        '<div style="position:absolute;left:50%%;top:50%%;transform:translate(-50%%,-50%%);'
        'width:%(c2)dpx;height:%(c2)dpx;border-radius:50%%;border:2px solid %(gold)s;opacity:.8;"></div>'
        '<div style="position:absolute;left:50%%;top:50%%;transform:translate(-50%%,-50%%);'
        'width:%(c3)dpx;height:%(c3)dpx;border-radius:50%%;background:%(gold)s;"></div>'
        '<div style="position:absolute;right:0;bottom:0;width:%(bar)dpx;height:%(bar2)dpx;'
        'background:%(gold)s;opacity:.9;"></div></div>'
        % dict(primary=pal["primary"], gold=pal["gold"], muted=pal["muted"],
               c1=round(h * 0.42), c2=round(h * 0.28), c3=round(h * 0.13),
               bar=round(w * 0.20), bar2=round(w * 0.05))
    )
    right = [
        '<div style="font-size:%dpx;font-weight:700;line-height:1.22;margin:0;">%s</div>'
        % (fs["title"], _esc(title))]
    if subtitle:
        right.append(
            '<div style="width:%dpx;height:3px;background:%s;border-radius:2px;margin:%dpx 0;"></div>'
            '<div style="font-size:%dpx;color:%s;line-height:1.6;">%s</div>'
            % (round(fs["title"] * 1.5), pal["gold"], round(fs["title"] * 0.4),
               fs["subtitle"], pal["muted"], _esc(subtitle)))
    for i, it in enumerate(items, 1):
        right.append(
            '<div style="display:flex;align-items:baseline;gap:12px;margin-top:%dpx;">'
            '<span style="width:8px;height:8px;border-radius:50%%;background:%s;flex-shrink:0;'
            'transform:translateY(-1px);"></span>'
            '<span style="font-size:%dpx;line-height:1.5;">%s</span></div>'
            % (round(fs["item"] * 0.5), pal["gold"], fs["item"], _esc(it)))
    if footer:
        right.append(
            '<div style="margin-top:auto;font-size:%dpx;color:%s;letter-spacing:2px;">%s</div>'
            % (fs["footer"], pal["muted"], _esc(footer)))
    return (
        '<div style="display:flex;width:100%%;height:100%%;box-sizing:border-box;">'
        '<div style="width:42%%;height:100%%;padding:0;">%s</div>'
        '<div style="width:58%%;height:100%%;padding:%dpx;display:flex;flex-direction:column;'
        'justify-content:center;box-sizing:border-box;">%s</div></div>'
        % (deco, pad, "".join(right))
    )


# ============================================================
#  模板 3：数据（大数字焦点 + 条形对比）
# ============================================================

_NUM_RE = re.compile(r"(-?\d+(?:\.\d+)?)\s*%?")

def _tpl_data(w, h, pal, fs, title, subtitle, items, footer):
    pad = round(w * 0.09)
    # 首个含数字的条目作焦点大数字；无数字用第一条
    hero = None
    hero_raw = ""
    nums = []
    for it in items:
        m = _NUM_RE.search(it)
        if m:
            nums.append(float(m.group(1)))
        if hero is None and m:
            hero, hero_raw = m.group(0), it
    if hero is None and items:
        hero, hero_raw = "", items[0]

    head = [
        '<div style="font-size:%dpx;font-weight:700;line-height:1.2;margin:0;">%s</div>'
        % (fs["title"], _esc(title))]
    if subtitle:
        head.append('<div style="font-size:%dpx;color:%s;margin-top:%dpx;">%s</div>'
                    % (fs["subtitle"], pal["muted"], round(fs["title"] * 0.3), _esc(subtitle)))
    if hero is not None:
        label = hero_raw.replace(hero, "").strip(" ：:，,+-") or "核心指标"
        head.append(
            '<div style="margin:%dpx 0 %dpx;">'
            '<span style="font-family:Consolas,\'JetBrains Mono\',monospace;font-size:%dpx;'
            'font-weight:700;color:%s;">%s</span>'
            '<span style="font-size:%dpx;color:%s;margin-left:12px;">%s</span></div>'
            % (round(fs["num"] * 0.25), round(fs["num"] * 0.25), fs["num"], pal["gold"],
               _esc(hero), fs["item"], pal["muted"], _esc(label[:_MAX_LINE])))

    bars = []
    if items:
        mx = max(nums) if nums and max(nums) > 0 else float(len(items))
        for it in items:
            m = _NUM_RE.search(it)
            v = float(m.group(1)) if m else 0
            ratio = max(0.12, min(1.0, (v / mx if mx > 0 else 0.5)))
            is_hero = (it == hero_raw)
            color = pal["gold"] if is_hero else pal["primary"]
            bars.append(
                '<div style="display:flex;align-items:center;gap:12px;margin-top:%dpx;">'
                '<div style="width:%d%%;height:%dpx;background:%s;border-radius:3px;'
                'flex-shrink:0;"></div>'
                '<span style="font-size:%dpx;line-height:1.35;">%s</span></div>'
                % (round(fs["item"] * 0.45), round(ratio * 52), round(fs["item"] * 0.62),
                   color, fs["item"], _esc(it)))
    foot = ""
    if footer:
        foot = ('<div style="position:absolute;left:%dpx;right:%dpx;bottom:%dpx;'
                'font-size:%dpx;color:%s;letter-spacing:2px;">%s</div>'
                % (pad, pad, round(h * 0.055), fs["footer"], pal["muted"], _esc(footer)))
    return (
        '<div style="position:relative;width:100%%;height:100%%;padding:%dpx;display:flex;'
        'flex-direction:column;justify-content:center;box-sizing:border-box;">%s%s</div>'
        % (pad, "".join(head + bars), foot)
    )
