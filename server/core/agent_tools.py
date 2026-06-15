# -*- coding: utf-8 -*-
"""
core/agent_tools.py — Agent 工具注册表 + 动态 System Prompt 组装
================================================================

为 AgentLoop 提供标准化的工具定义（OpenAI FC JSON 格式），
并根据当前环境（KB 可用性、文档模式）动态组装工具列表和 system prompt。

设计原则：
  - 在线模式永远有网，不需要 network 条件判断
  - 工具注册表是 dict，开发者加一个工具只需加一条
  - 不做用户可配置的工具系统
"""

import json
import logging

log = logging.getLogger(__name__)


# ===== 基础 System Prompt — Chat Agent（赋能本地）=====
_AGENT_BASE_PROMPT = (
    "你是桌伴(Sidemate)，本地AI办公助手。\n"
    "风格：像一位经验丰富的顾问，回答深入、有洞见、有实例。\n\n"
    "规则：\n"
    "1. 不寒暄不重复，直接给有价值的回答\n"
    "2. 不确定就说不确定，可以给分析但标注「推测」\n"
    "3. 超过3句编号分点，重点用**加粗**\n\n"
    "信息获取策略：\n"
    "- 你自身已有丰富的知识储备，能直接回答的问题不必调用工具\n"
    "- 用户的知识库（search_kb）包含用户上传的专业文档，涉及用户特定领域时优先查看\n"
    "- 互联网搜索（search_web）用于获取最新信息或你不了解的领域\n"
    "- 需要深入某个网页时用 fetch_url\n"
    "- 自己判断要不要用工具、用几次\n\n"
    "回答时自然地提及信息来源，比如「根据知识库检索结果…」「公开资料显示…」\n"
    "- 注意：知识库是AI自动检索的，不要说「您上传的文档」，要说「检索到…」「从知识库找到…」"
)

_DOC_BASE_PROMPT = (
    "你是桌伴(Sidemate)的智能文档助手，擅长撰写高质量的专业文档。\n"
    "风格：专业、充实、有深度。像一位资深撰稿人。\n"
    "规则：\n"
    "1. 使用 Markdown 格式，结构清晰（一级标题为主题，后续为章节）\n"
    "2. 内容充实——每个章节至少2-3段实质内容，禁止空洞套话\n"
    "3. 你可以搜索互联网查找最新资料来丰富文档\n"
    "4. 你可以检索知识库获取内部资料\n"
    "5. 综合搜索和知识库的信息，撰写有深度的文档\n"
    "6. 如果用户上传了参考文档，按照其结构和风格来撰写\n"
)


# ===== 工具注册表 =====

TOOL_REGISTRY = {
    "search_kb": {
        "schema": {
            "type": "function",
            "function": {
                "name": "search_kb",
                "description": "【优先使用】搜索本地知识库。知识库包含用户上传的专业文档，信息质量通常高于互联网搜索。回答用户问题时应先查知识库，找不到再搜互联网。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        "handler": "kb.search",
        "status_map": {
            "start": "kb_searching",
            "done": "kb_done",
        },
        "stat_key": "kb_hits",
        "condition": "kb_available",
    },
    "search_web": {
        "schema": {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "搜索互联网，返回相关网页结果。用于查找最新信息、事实核查、或知识库中找不到的话题。如果第一次结果不够，可以换关键词再搜。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        "handler": "search_engine.search",
        "status_map": {
            "start": "searching",
            "done": "search_done",
        },
        "stat_key": "searches",
    },
    "fetch_url": {
        "schema": {
            "type": "function",
            "function": {
                "name": "fetch_url",
                "description": "抓取指定 URL 的网页正文内容。用于深入阅读搜索结果中的某个网页，获取详细信息。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "要抓取的网页 URL"
                        }
                    },
                    "required": ["url"]
                }
            }
        },
        "handler": "search_engine.fetch",
        "status_map": {
            "start": "fetching",
            "done": "fetch_done",
        },
        "stat_key": "fetches",
    },
    "write_section": {
        "schema": {
            "type": "function",
            "function": {
                "name": "write_section",
                "description": "写入文档的一个章节。用于文档生成模式，逐章节构建完整文档。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "heading": {
                            "type": "string",
                            "description": "章节标题"
                        },
                        "content": {
                            "type": "string",
                            "description": "章节正文内容（Markdown 格式）"
                        }
                    },
                    "required": ["heading", "content"]
                }
            }
        },
        "handler": None,  # 不需要外部执行器，AgentLoop 内部处理
        "status_map": {
            "start": "writing",
            "done": "writing_done",
        },
        "stat_key": "docs",
        "condition": "doc_mode",
    },
}


def get_tools_and_prompt(mode="chat", kb=None, template=None, kb_permission="full"):
    """根据当前环境动态组装工具列表 + system prompt

    Args:
        mode: "chat" 或 "doc"
        kb: KB 管理器实例（如果可用）
        template: 模板 dict（parse_template() 的返回值，可选）
        kb_permission: "full" | "search-only" | "disabled" — 知识库权限控制

    Returns:
        (tools, system_prompt):
            tools: OpenAI FC 格式的工具列表（传给 cloud_engine.run_with_tools()）
            system_prompt: 动态组装的 system prompt 字符串
    """
    tools = []

    # 判断环境
    kb_available = kb is not None and kb_permission != "disabled"
    doc_mode = mode == "doc"

    for name, tool_def in TOOL_REGISTRY.items():
        # 条件检查
        condition = tool_def.get("condition")
        if condition == "kb_available" and not kb_available:
            continue
        if condition == "doc_mode" and not doc_mode:
            continue

        tools.append(tool_def["schema"])

    # 组装 system prompt
    if doc_mode:
        base = _DOC_BASE_PROMPT
    else:
        base = _AGENT_BASE_PROMPT

    # KB 标签注入（full 权限时）
    if kb_available and kb_permission == "full":
        try:
            tag_counts = kb.get_all_tags()
            if tag_counts:
                tag_str = " ".join("%s(%d)" % (tag, count) for tag, count in list(tag_counts.items())[:50])
                base += "\n\n知识库标签概览：" + tag_str
        except Exception:
            pass

    # 注入模板（如果有）
    if template and doc_mode:
        from core.template_parser import template_to_prompt
        template_prompt = template_to_prompt(template)
        if template_prompt:
            base += template_prompt

    log.info("[AGENT_TOOLS] mode=%s, tools=%s, kb=%s, kb_perm=%s, template=%s",
             mode, [t["function"]["name"] for t in tools], kb_available,
             kb_permission, bool(template))

    return tools, base


def get_tool_def(name):
    """获取指定工具的完整定义"""
    return TOOL_REGISTRY.get(name)


def get_status_event(tool_name, phase, **kwargs):
    """生成 agent_status 事件数据

    Args:
        tool_name: 工具名
        phase: "start" 或 "done"
        **kwargs: 附加参数（query, url, count, length 等）

    Returns:
        dict: agent_status 事件数据
    """
    tool_def = TOOL_REGISTRY.get(tool_name)
    if not tool_def:
        return {"status": phase, **kwargs}

    status_map = tool_def.get("status_map", {})
    status = status_map.get(phase, phase)

    return {"status": status, **kwargs}
