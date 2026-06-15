# -*- coding: utf-8 -*-
"""
core/template_parser.py — 文档模板解析器
==========================================

解析上传的 .docx 文件，提取标题层级结构，生成模板 JSON。
用于在线文档生成模式：Agent 拿到模板后按结构逐节写作。

使用方式：
  1. parse_template(file_path) → 返回模板 JSON
  2. template_to_prompt(template) → 生成给 Agent 的 system prompt 片段
  3. Agent 使用 write_section 工具按模板逐节写入

依赖：python-docx（已预装）
"""

import os
import re
import json
import logging
from typing import Optional

log = logging.getLogger(__name__)

# 标题样式关键词
_HEADING_KEYWORDS = ("Heading", "Title", "heading", "title", "TOC")

# 最大模板文件大小（10MB）
_MAX_TEMPLATE_SIZE = 10 * 1024 * 1024


def parse_template(file_path: str) -> dict:
    """解析 docx 文件，提取标题层级结构

    Args:
        file_path: .docx 文件的绝对路径

    Returns:
        dict: {
            "status": "ok" | "error",
            "title": "文档标题",
            "sections": [
                {
                    "heading": "章节标题",
                    "level": 1-4,
                    "index": 段落索引,
                    "has_content": bool（原始是否有正文内容）,
                    "content_hint": "原始内容前50字"（可选）,
                },
                ...
            ],
            "total_sections": int,
            "total_chars": int,
        }
    """
    # 文件检查
    if not os.path.exists(file_path):
        return {"status": "error", "error": "文件不存在: %s" % file_path}

    if not file_path.lower().endswith(".docx"):
        return {"status": "error", "error": "只支持 .docx 文件"}

    file_size = os.path.getsize(file_path)
    if file_size > _MAX_TEMPLATE_SIZE:
        return {"status": "error", "error": "模板文件过大（超过10MB）"}

    try:
        from docx import Document
        doc = Document(file_path)
    except ImportError:
        return {"status": "error", "error": "缺少依赖 python-docx"}
    except Exception as e:
        return {"status": "error", "error": "文件读取失败: %s" % str(e)[:100]}

    # 提取标题层级
    sections = []
    title = ""
    total_chars = 0

    for i, para in enumerate(doc.paragraphs):
        text = para.text.strip()
        if not text:
            continue

        total_chars += len(text)
        style_name = para.style.name if para.style else ""
        is_heading = any(kw in style_name for kw in _HEADING_KEYWORDS)

        if is_heading:
            level = _get_level(style_name)
            # 第一个 level 1 或 Title 作为文档标题
            if not title and level <= 1:
                title = text[:200]
                continue  # 标题不作为章节

            # 限制 level 范围 1-4
            level = min(max(level, 1), 4)

            sections.append({
                "heading": text[:200],
                "level": level,
                "index": i,
                "has_content": False,
                "content_hint": "",
            })
        else:
            # 非标题段落 → 标记上一个章节有内容
            if sections and not sections[-1]["has_content"]:
                sections[-1]["has_content"] = True
                sections[-1]["content_hint"] = text[:50]

    # 如果没有提取到任何标题，把第一个段落作为标题
    if not title and sections:
        title = sections[0]["heading"]
    elif not title:
        # 兜底：用文件名
        title = os.path.splitext(os.path.basename(file_path))[0]

    result = {
        "status": "ok",
        "title": title,
        "sections": sections,
        "total_sections": len(sections),
        "total_chars": total_chars,
    }

    log.info("[TEMPLATE] 解析完成: title=%s, sections=%d, chars=%d",
             title[:30], len(sections), total_chars)

    return result


def template_to_prompt(template: dict) -> str:
    """将模板 JSON 转为 Agent system prompt 片段

    Args:
        template: parse_template() 的返回值

    Returns:
        str: 注入到 system prompt 的模板描述
    """
    if template.get("status") != "ok":
        return ""

    sections = template.get("sections", [])
    title = template.get("title", "文档")

    if not sections:
        return ""

    # 构建模板大纲
    outline_parts = ["文档标题: %s" % title, "", "文档结构大纲："]
    for sec in sections:
        indent = "  " * (sec["level"] - 1)
        marker = "#" * sec["level"]
        hint = ""
        if sec.get("content_hint"):
            hint = " （参考: %s...）" % sec["content_hint"]
        outline_parts.append("%s%s %s%s" % (indent, marker, sec["heading"], hint))

    outline = "\n".join(outline_parts)

    prompt = (
        "\n\n## 文档模板\n"
        "用户上传了一份文档模板，请严格按照以下结构生成文档内容：\n\n"
        "%s\n\n"
        "要求：\n"
        "1. 使用 write_section 工具逐章节写入内容\n"
        "2. 每个章节的内容要充实、专业，不要空洞套话\n"
        "3. 保持模板的标题层级结构（一级标题、二级标题等）\n"
        "4. 可以使用搜索工具和知识库查找资料来丰富内容\n"
        "5. 所有章节写完后，用文字告知用户文档已生成完毕\n"
    ) % outline

    return prompt


def _get_level(style_name: str) -> int:
    """从样式名提取标题级别"""
    m = re.search(r'(\d+)', style_name)
    if m:
        return min(int(m.group(1)), 6)
    if "Title" in style_name:
        return 0
    return 1


def template_to_outline_json(template: dict) -> str:
    """将模板转为紧凑的 JSON 大纲（用于前端展示）

    Returns:
        str: JSON 格式的标题列表
    """
    if template.get("status") != "ok":
        return "[]"

    sections = template.get("sections", [])
    outline = []
    for sec in sections:
        outline.append({
            "h": sec["heading"],
            "l": sec["level"],
        })
    return json.dumps(outline, ensure_ascii=False)
