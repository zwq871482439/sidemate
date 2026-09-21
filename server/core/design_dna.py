# -*- coding: utf-8 -*-
"""
core/design_dna.py — 产物设计 DNA 卡注册表（0.10 M1-5b）
=========================================================

9 段式 schema（学 open-design DESIGN.md，全原创零版权风险）：
    id / name / voice / palette / typography / grid / components /
    anti_patterns / demo

三张原创卡：
    DNA-01 深蓝金（正式汇报，PPT 默认——沿用 0.10.1 版）
    DNA-02 素白极简（冷静文档风，docx 默认）
    DNA-03 暖砂杂志（人文叙事风）

产物选卡：create_ppt / create_docx 的 prompt 按「产物类型 → 用户意图」选卡，
用户可点名换卡（"用暖色风格做"→ DNA-03）。
"""

DNA_CARDS = {
    "DNA-01": {
        "name": "深蓝金",
        "voice": "正式、权威、汇报感——适合工作汇报、方案评审、对外演示",
        "palette": {"bg": "#0F2B46", "primary": "#0F2B46", "accent": "#E8B54D",
                     "text": "#FFFFFF", "muted": "#B8C4D4"},
        "typography": {"family": "Microsoft YaHei",
                        "title": 72, "subtitle": 34, "body": 26, "aux": 19, "caption": 18},
        "grid": "8px 网格，四周留白 ≥60px，每页一个核心观点",
        "components": "纯几何装饰（矩形/圆角矩形/圆/线），金色细分隔线、角标、右下页码",
        "anti_patterns": "禁堆砌段落（>4 行拆页）；禁花哨渐变与照片；禁 emoji",
        "demo": None,  # 0.10.2 配 demo.html 参考页
    },
    "DNA-02": {
        "name": "素白极简",
        "voice": "冷静、克制、文档感——适合技术文档、发布说明、操作手册",
        "palette": {"bg": "#FFFFFF", "primary": "#1A1A1A", "accent": "#2563EB",
                     "text": "#1A1A1A", "muted": "#6B7280"},
        "typography": {"family": "Microsoft YaHei",
                        "title": 64, "subtitle": 32, "body": 26, "aux": 19, "caption": 18},
        "grid": "12 列栅格，大留白（两侧 ≥80px），信息密度低",
        "components": "细线分隔（#E5E7EB）、编号圆点、右上图示区，无底色块",
        "anti_patterns": "禁深色底；禁大面积色块；禁超过两种强调色",
        "demo": None,
    },
    "DNA-03": {
        "name": "暖砂杂志",
        "voice": "温和、人文、叙事感——适合文化介绍、品牌故事、知识科普",
        "palette": {"bg": "#FAF6F0", "primary": "#3D2E24", "accent": "#C0763B",
                     "text": "#3D2E24", "muted": "#8C7B6B"},
        "typography": {"family": "Microsoft YaHei",
                        "title": 68, "subtitle": 33, "body": 25, "aux": 19, "caption": 18},
        "grid": "杂志式不对称布局：左 2/3 正文 + 右 1/3 侧栏，页脚引言条",
        "components": "衬线大标题、暖色下划线强调、引言块（左侧竖线+斜体）、圆形序号章",
        "anti_patterns": "禁冷色蓝绿主调；禁科技感网格线；禁密集数据表（改叙述）",
        "demo": None,
    },
}

# 产物类型默认卡
DEFAULT_BY_KIND = {"ppt": "DNA-01", "docx": "DNA-02"}


def pick_card(kind: str, user_hint: str = "") -> str:
    """按产物类型 + 用户意图提示选卡 id（点名优先，关键词匹配次之，默认兜底）。"""
    hint = (user_hint or "").lower()
    # 点名
    for cid in DNA_CARDS:
        if cid.lower() in hint or DNA_CARDS[cid]["name"] in (user_hint or ""):
            return cid
    # 关键词
    if any(k in hint for k in ("暖", "杂志", "人文", "文化", "故事")):
        return "DNA-03"
    if any(k in hint for k in ("极简", "白底", "冷静", "技术", "手册")):
        return "DNA-02"
    if any(k in hint for k in ("深蓝", "正式", "汇报", "评审")):
        return "DNA-01"
    return DEFAULT_BY_KIND.get(kind, "DNA-01")


def card_prompt_block(kind: str, user_hint: str = "") -> str:
    """生成注入 prompt 的选卡说明块（未点名时告知可选卡列表）。"""
    cid = pick_card(kind, user_hint)
    c = DNA_CARDS[cid]
    others = [("%s %s" % (k, v["name"])) for k, v in DNA_CARDS.items() if k != cid]
    return (
        "设计规则（%s %s）——用户未点名时用此卡，点名可换（可选：%s）：\n"
        "   - 语气场景：%s\n"
        "   - 色板：底 %s / 主 %s / 强调 %s / 正文 %s / 次要 %s\n"
        "   - 字号档（%s）：标题 %d / 副标题 %d / 正文 %d / 辅助 %d / 脚注 %d\n"
        "   - 网格：%s\n"
        "   - 组件：%s\n"
        "   - 反模式（禁止）：%s\n"
        % (cid, c["name"], "、".join(others), c["voice"],
           c["palette"]["bg"], c["palette"]["primary"], c["palette"]["accent"],
           c["palette"]["text"], c["palette"]["muted"],
           c["typography"]["family"], c["typography"]["title"], c["typography"]["subtitle"],
           c["typography"]["body"], c["typography"]["aux"], c["typography"]["caption"],
           c["grid"], c["components"], c["anti_patterns"])
    )
