# -*- coding: utf-8 -*-
"""
core/pipeline_skills.py — 产物管线 skill 挂载位（0.10 M3-1）
=============================================================

通用平台原则的机制化：任何 skill 可挂任何产物管线（PPT/docx/报告/海报），
设计只是第一批预装内容（0.11 全量 skill 系统的试验田）。

skill 格式（Python dict，M4 升级为 SKILL.md 文件解析）：
    {
        "name": "设计-DNA选卡",           # 唯一名
        "pipeline_types": ["ppt", "docx"], # 挂载的管线类型
        "priority": 10,                    # 越小越先注入
        "prompt_fragment": "...",          # 注入 prompt 的文本块
        "matcher": lambda hint: bool,     # 可选：用户意图匹配器（None=恒适用）
    }

用法：
    from core.pipeline_skills import get_skill_prompts
    prompts = get_skill_prompts("ppt", user_hint="用暖色做")
    # → 返回按 priority 排序的 prompt_fragment 列表

预装 skill（全部挂 ppt/docx/report/poster 四管线，除文体适配仅 docx/report）：
    1. 设计-DNA选卡：从 design_dna 选卡并注入版式/色板/字号规则（prompt 动态生成）
    2. 写作-文体适配：按产物类型注入文体建议（不绑定具体文风——通用平台原则）
    3. 内容-结构引导：通用内容组织提示
"""
from __future__ import annotations

from typing import Callable, List, Optional

# ---------------------------------------------------------------------------
# 注册表
# ---------------------------------------------------------------------------

_SKILLS: List[dict] = []


def register_skill(name: str, pipeline_types: List[str], prompt_fragment: str,
                   priority: int = 50,
                   matcher: Optional[Callable[[str], bool]] = None,
                   description: str = ""):
    """注册一个管线 skill。description：技能卡说明（通用机制性描述，
    不掺领域偏好——skill 内容通用化原则，防模型偏离）。"""
    _SKILLS.append({
        "name": name,
        "pipeline_types": pipeline_types,
        "priority": priority,
        "prompt_fragment": prompt_fragment,
        "matcher": matcher,
        "description": description,
    })


def get_skill_prompts(pipeline_type: str, user_hint: str = "") -> List[str]:
    """获取适用于某管线的所有 skill prompt 片段（按 priority 排序）。"""
    applicable = []
    for sk in _SKILLS:
        if pipeline_type not in sk["pipeline_types"]:
            continue
        if sk["matcher"] and not sk["matcher"](user_hint):
            continue
        applicable.append(sk)
    applicable.sort(key=lambda x: x["priority"])
    return [sk["prompt_fragment"] for sk in applicable]


# ---------------------------------------------------------------------------
# 预装 skill：设计-DNA选卡（从 design_dna 桥接）
# ---------------------------------------------------------------------------

def _install_default_skills():
    """预装 skill（import 时执行一次）。"""

    # 1. 设计-DNA选卡（所有产物管线都适用）
    from core.design_dna import card_prompt_block

    def _dna_matcher(hint: str) -> bool:
        return True  # DNA 选卡恒适用（选哪张卡由 pick_card 内部决定）

    register_skill(
        name="设计-DNA选卡",
        pipeline_types=["ppt", "docx", "report", "poster"],
        priority=10,
        prompt_fragment="",  # 动态生成——由 _dna_prompt 代理
        matcher=_dna_matcher,
        description="按用户意图从设计 DNA 卡库选一张版式方案（色板/字号/网格），"
                    "注入产物生成管线。机制性挂载：不预设风格偏好，选卡由意图匹配决定。",
    )
    # DNA 的 prompt 是动态的（按用户意图选卡），需要特殊处理
    # 改为注册一个动态 skill
    _SKILLS[-1]["dynamic_prompt"] = True

    # 2. 写作-文体适配（docx/report 管线）
    register_skill(
        name="写作-文体适配",
        pipeline_types=["docx", "report"],
        priority=20,
        description="按文档类型与受众提示合适的文体选择，不绑定具体文风模板。",
        prompt_fragment=(
            "写作风格建议：根据文档类型和受众选择恰当文体——技术文档用简洁说明文、"
            "商业方案用结构化论证、文化介绍用叙事性散文。不绑定特定文风模板；"
            "保持专业性和可读性的平衡。"
        ),
    )

    # 3. 内容-结构引导（所有管线）
    register_skill(
        name="内容-结构引导",
        pipeline_types=["ppt", "docx", "report", "poster"],
        priority=30,
        description="通用的内容组织提示：逻辑清晰、每节聚焦一个观点、结论有依据。",
        prompt_fragment=(
            "内容结构：确保逻辑清晰（总分总/递进/并列）；每章/页聚焦一个核心观点；"
            "开篇点题+结尾收束；数据有来源、结论有依据。"
        ),
    )


# 动态 prompt 解析：DNA skill 的 prompt 由 card_prompt_block 实时生成
def _resolve_dynamic_prompt(skill: dict, pipeline_type: str, user_hint: str) -> str:
    if skill.get("dynamic_prompt") and skill["name"] == "设计-DNA选卡":
        from core.design_dna import card_prompt_block
        return card_prompt_block(pipeline_type, user_hint)
    return skill["prompt_fragment"]


# 重写 get_skill_prompts 以支持动态 prompt
def get_skill_prompts(pipeline_type: str, user_hint: str = "") -> List[str]:
    """获取适用于某管线的所有 skill prompt 片段（按 priority 排序，支持动态生成）。"""
    applicable = []
    for sk in _SKILLS:
        if pipeline_type not in sk["pipeline_types"]:
            continue
        if sk["matcher"] and not sk["matcher"](user_hint):
            continue
        applicable.append(sk)
    applicable.sort(key=lambda x: x["priority"])
    return [_resolve_dynamic_prompt(sk, pipeline_type, user_hint) for sk in applicable]


# 初始化
_install_default_skills()
