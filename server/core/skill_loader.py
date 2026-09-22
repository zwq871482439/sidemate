# -*- coding: utf-8 -*-
"""
core/skill_loader.py — SKILL.md 文件解析与注册（0.10 M4-4）
=============================================================

兼容行业格式 SKILL.md（Claude Code / ZCode / 社区生态通用）。

格式（YAML frontmatter + markdown 正文）：
    ---
    name: 写作-商务报告
    description: 商务报告写作技巧与模板
    pipeline_types: [docx, report]   # 可选：挂载的产物管线
    priority: 20                     # 可选：越小越先注入
    ---

    # 正文 = prompt_fragment（注入产物管线/对话上下文的文本）

用户 skill 目录：data/skills/（每 skill 一个 .md 文件或子目录含 SKILL.md）
"""

from __future__ import annotations

import logging
import os
import re
from typing import List, Optional

log = logging.getLogger(__name__)

SKILLS_DIR_NAME = "skills"


def _skills_dir() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, SKILLS_DIR_NAME)


def parse_skill_md(filepath: str) -> Optional[dict]:
    """解析一个 SKILL.md 文件，返回 skill dict 或 None（格式不合法）。"""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return None

    # YAML frontmatter（--- ... ---）
    meta = {}
    body = content
    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if fm_match:
        # 简易 YAML 解析（不引入 yaml 依赖）
        for line in fm_match.group(1).split("\n"):
            m = re.match(r"^(\w+):\s*(.+)$", line.strip())
            if m:
                key, val = m.group(1), m.group(2).strip()
                # 列表解析 [a, b] → ["a", "b"]
                list_m = re.match(r"^\[(.*)\]$", val)
                if list_m:
                    val = [v.strip().strip("'\"") for v in list_m.group(1).split(",") if v.strip()]
                meta[key] = val
        body = content[fm_match.end():]
    else:
        # 无 frontmatter：从文件名取 name
        meta["name"] = os.path.splitext(os.path.basename(filepath))[0]

    if not meta.get("name"):
        return None

    return {
        "name": str(meta.get("name", "")),
        "description": str(meta.get("description", "")),
        "pipeline_types": meta.get("pipeline_types", []),
        "priority": int(meta.get("priority", 50)),
        "prompt_fragment": body.strip(),
        "source_file": filepath,
    }


def discover_skills() -> List[dict]:
    """扫描 skills 目录，解析所有 SKILL.md。"""
    skills = []
    root = _skills_dir()
    if not os.path.isdir(root):
        return skills

    for entry in os.listdir(root):
        path = os.path.join(root, entry)
        if entry.endswith(".md"):
            sk = parse_skill_md(path)
            if sk:
                skills.append(sk)
        elif os.path.isdir(path):
            # 子目录形式：dir/SKILL.md
            sm = os.path.join(path, "SKILL.md")
            if os.path.isfile(sm):
                sk = parse_skill_md(sm)
                if sk:
                    skills.append(sk)
    return skills


def register_user_skills():
    """把用户 skill 注册进 pipeline_skills（有 pipeline_types 的才挂管线）。"""
    from core.pipeline_skills import register_skill
    skills = discover_skills()
    registered = 0
    for sk in skills:
        types = sk["pipeline_types"]
        if isinstance(types, str):
            types = [types]
        if types and sk["prompt_fragment"]:
            register_skill(
                name=sk["name"],
                pipeline_types=types,
                prompt_fragment=sk["prompt_fragment"],
                priority=sk["priority"],
            )
            registered += 1
            log.info("[SKILL] 已注册: %s → %s", sk["name"], types)
    if registered:
        log.info("[SKILL] 用户 skill 加载完成: %d 个", registered)
    return registered


def list_user_skills() -> List[dict]:
    """列出用户 skill（设置页展示用）。"""
    return discover_skills()
