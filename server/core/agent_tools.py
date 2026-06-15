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
    "- 注意：知识库是AI自动检索的，不要说「您上传的文档」，要说「检索到…」「从知识库找到…」\n\n"
    "## Patch4：文档生成能力（chat 模式同样可用）\n"
    "你具备完整的文档生成能力。\n"
    "当用户要求\"写文档/总结一份/生成报告\"时，请直接调用 write_section 工具逐章写入，\n"
    "完成后调用 set_doc_status(\"completed\")。前端会自动展示文档进度面板。\n"
    "你有工作区（workspace）可用于存放大纲、草稿等辅助文件。\n"
)

_DOC_BASE_PROMPT = (
    "你是桌伴的智能文档助手。用户选择了\"文档生成\"模式，明确想要一份文档产物。\n\n"
    "## 文档生成流程\n"
    "1. 【检索】先 search_kb 查知识库，再 search_web 补充（每个最多用2-3次）\n"
    "2. 【阅读】对最相关的1-2条搜索结果，用 fetch_url 读取正文\n"
    "3. 【大纲】可以先用 write_workspace 写到大纲文件\n"
    "4. 【写作】逐章节调用 write_section，每章节至少2-3段实质内容\n"
    "5. 【完成】所有章节写完后，调用 set_doc_status(\"completed\")\n\n"
    "## 工具调用预算\n"
    "- 总计最多 20 轮工具调用\n"
    "- 搜索类（search_kb + search_web）：建议 3-5 轮\n"
    "- 阅读类（fetch_url）：建议 1-3 轮\n"
    "- 写作类（write_section）：剩余轮次全部用于写作\n"
    "- 注意剩余轮次：剩 5 轮时必须开始收尾\n\n"
    "## 注意事项\n"
    "- 你能看到[会话上下文]，包括之前搜过的关键词——不要重复搜索\n"
    "- 如果看到有 ongoing 状态的文档，且用户意图是继续，请从下一章节接着写\n"
    "- 禁止只搜索不阅读（fetch_url）就开始写作\n"
    "- 你有工作区（workspace），可以写大纲、草稿、笔记等辅助文件\n"
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
                "description": "搜索互联网，返回相关网页结果。用于查找最新信息、事实核查、或知识库中找不到的话题。如果第一次结果不够，可以换关键词再搜。搜索结果只是摘要，要获取完整内容必须接着调用 fetch_url。",
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
                "description": "写入文档的一个章节。逐章节构建完整文档。每次调用会立即落盘，可以多轮调用续写。",
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
        "condition": None,  # Patch4: 双模式都可用（chat 模式也能写文档）
    },
    # ===== Patch4 修复 1：set_doc_status + workspace 工具集（双模式可用）=====
    "set_doc_status": {
        "schema": {
            "type": "function",
            "function": {
                "name": "set_doc_status",
                "description": "更新当前文档状态。所有章节写完后调用 status='completed'，告知系统文档已完结。如果文档还在进行中，保持 status='ongoing'。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "status": {
                            "type": "string",
                            "enum": ["ongoing", "completed"],
                            "description": "文档状态：ongoing=写作中，completed=已完成"
                        }
                    },
                    "required": ["status"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "doc_status_updating",
            "done": "doc_status_done",
        },
        "condition": None,
    },
    "list_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "list_workspace",
                "description": "列出你的工作区（workspace）中的所有文件（大纲、草稿、笔记、参考资料等）。返回文件名和大小，不含内容。",
                "parameters": {
                    "type": "object",
                    "properties": {},
                    "required": []
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_listing",
            "done": "workspace_listed",
        },
        "condition": None,
    },
    "read_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "read_workspace",
                "description": "读取你工作区的某个文件内容。path 是相对工作区根目录的相对路径（如 'outline.md'）。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径（禁止绝对路径和 ../）"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_reading",
            "done": "workspace_read_done",
        },
        "condition": None,
    },
    "write_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "write_workspace",
                "description": "写入文件到你的工作区（大纲、草稿、笔记、参考资料等）。可用于规划写作大纲、保存中间草稿。path 是相对工作区根目录的相对路径。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径（禁止绝对路径和 ../）"
                        },
                        "content": {
                            "type": "string",
                            "description": "文件内容（文本）"
                        }
                    },
                    "required": ["path", "content"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_writing",
            "done": "workspace_write_done",
        },
        "condition": None,
    },
    "delete_workspace": {
        "schema": {
            "type": "function",
            "function": {
                "name": "delete_workspace",
                "description": "删除你工作区的某个文件。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "path": {
                            "type": "string",
                            "description": "相对工作区根目录的文件路径（禁止绝对路径和 ../）"
                        }
                    },
                    "required": ["path"]
                }
            }
        },
        "handler": None,
        "status_map": {
            "start": "workspace_deleting",
            "done": "workspace_deleted",
        },
        "condition": None,
    },
}


def get_tools_and_prompt(mode="chat", kb=None, template=None, kb_permission="full", chat_id=None, history=None):
    """根据当前环境动态组装工具列表 + system prompt

    Args:
        mode: "chat" 或 "doc"
        kb: KB 管理器实例（如果可用）
        template: 模板 dict（parse_template() 的返回值，可选）
        kb_permission: "full" | "search-only" | "disabled" — 知识库权限控制
        chat_id: 会话 ID（文件夹名）—— Patch4 修复 2：用于会话上下文注入
        history: 对话历史（list[dict]）—— Patch4 修复 2：用于提取工具调用历史

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

    # KB 标签注入（full 权限时）—— 保留现有逻辑，作为 [KB 标签概览] 的一部分
    tag_str = ""
    if kb_available and kb_permission == "full":
        try:
            tag_counts = kb.get_all_tags()
            if tag_counts:
                tag_str = " ".join("%s(%d)" % (tag, count) for tag, count in list(tag_counts.items())[:50])
        except Exception:
            pass

    # 注入模板（如果有）
    if template and doc_mode:
        from core.template_parser import template_to_prompt
        template_prompt = template_to_prompt(template)
        if template_prompt:
            base += template_prompt

    # ===== Patch4 修复 2：会话上下文注入（token 预算 5000）=====
    base = _inject_session_context(
        chat_id=chat_id,
        kb=kb if kb_available else None,
        base_prompt=base,
        kb_tag_str=tag_str,
        history=history,
    )

    log.info("[AGENT_TOOLS] mode=%s, tools=%s, kb=%s, kb_perm=%s, template=%s, chat_id=%s",
             mode, [t["function"]["name"] for t in tools], kb_available,
             kb_permission, bool(template), chat_id)

    return tools, base


# ============================================================
#  会话上下文注入（Patch4 修复 2）
# ============================================================

# ⚠️ 注入云端的 system prompt 只能包含：
#   1. 用户主动上传的文件清单（文件名+类型，不含内容）
#   2. 云端自己生成的产物（文档列表）
#   3. 云端自己的工具调用历史
#   4. KB 标签概览（粗粒度，帮模型判断要不要检索）
#   5. workspace 文件清单（文件名+大小，不含内容）
# 绝不能注入：KB 文档清单、KB 文档摘要、KB 文档正文
# KB 信息只能通过 search_kb 工具按需获取

# token 预算：会话上下文总量上限 5000 token（约 20000 字符，按中文 1字≈2.5token 估）
_SESSION_CONTEXT_TOKEN_BUDGET = 5000
# 字符上限（粗略换算：中文 1 字 ≈ 2.5 token，留余量）
_SESSION_CONTEXT_CHAR_BUDGET = 18000

# 裁剪优先级（从低到高，超限时先丢）：KB 标签 > workspace 清单 > 文件清单 > 文档列表 > 工具历史
# （工具历史最有价值，最后裁剪）


def _inject_session_context(chat_id, kb, base_prompt, kb_tag_str="", history=None):
    """在 system prompt 末尾追加会话上下文。

    注入内容（5 类，超 token 预算按优先级裁剪）：
      1. 上传文件清单（assets/）
      2. 已生成文档列表（docs/）
      3. 工具调用历史（从 history 提取）
      4. KB 标签概览（kb_tag_str）
      5. workspace 文件清单

    Args:
        chat_id: 会话 ID（文件夹名）
        kb: KB 管理器（用于判断是否注入 KB 标签；不为 None 时注入）
        base_prompt: 基础 system prompt
        kb_tag_str: KB 标签概览字符串（已由调用方组装）
        history: 对话历史（list[dict]）

    Returns:
        str: 拼接后的完整 system prompt
    """
    if not chat_id:
        # 没有 chat_id（如单元测试），跳过注入
        return base_prompt

    try:
        import os as _os
        import json as _json
        from core.doc_session import _chat_root, _workspace_root, _docs_root
        from config import CHAT_DIR

        chat_path = _chat_root(chat_id)
        if not _os.path.isdir(chat_path):
            return base_prompt

        # ===== 收集 5 类信息 =====

        # 1) 上传文件清单（assets/）
        files_block = _collect_assets_block(chat_path)

        # 2) 已生成文档列表（docs/）
        docs_block = _collect_docs_block(chat_id)

        # 3) 工具调用历史（从 history 的 agent_timeline 提取）
        tools_block = _collect_tool_history_block(history)

        # 4) KB 标签概览
        kb_block = ""
        if kb is not None and kb_tag_str:
            kb_block = "📚 KB 标签概览：" + kb_tag_str

        # 5) workspace 文件清单
        workspace_block = _collect_workspace_block(chat_id)

        # ===== 拼接 + token 预算裁剪 =====
        # 优先级（裁剪顺序，先丢优先级低的）：
        # KB 标签 → workspace 清单 → 文件清单 → 文档列表 → 工具历史
        blocks = [
            ("kb", kb_block),
            ("workspace", workspace_block),
            ("files", files_block),
            ("docs", docs_block),
            ("tools", tools_block),
        ]

        # 先拼完整版本，超限则按优先级从低到高丢弃
        header = "\n\n[会话上下文]"
        assembled = _assemble_context(blocks)

        if len(assembled) <= _SESSION_CONTEXT_CHAR_BUDGET:
            body = assembled
        else:
            # 按优先级（列表顺序）从前往后丢，直到不超限
            body = assembled
            for i in range(len(blocks)):
                if len(body) <= _SESSION_CONTEXT_CHAR_BUDGET:
                    break
                # 丢掉第 i 个非空 block
                reduced = [b for j, b in enumerate(blocks) if j != i]
                body = _assemble_context(reduced)

        if not body.strip():
            return base_prompt

        return base_prompt + header + "\n" + body

    except Exception as e:
        log.warning("[AGENT_TOOLS] 会话上下文注入失败 chat_id=%s: %s", chat_id, str(e)[:100])
        return base_prompt


def _assemble_context(blocks):
    """把非空的 block 用换行拼接。"""
    parts = [b[1] for b in blocks if b[1]]
    return "\n".join(parts)


def _collect_assets_block(chat_path):
    """收集 assets/ 下的上传文件清单（文件名+大小）。"""
    import os as _os
    assets_dir = _os.path.join(chat_path, "assets")
    if not _os.path.isdir(assets_dir):
        return ""

    items = []
    for fname in _os.listdir(assets_dir):
        fp = _os.path.join(assets_dir, fname)
        if not _os.path.isfile(fp):
            continue
        try:
            size = _os.path.getsize(fp)
        except OSError:
            size = 0
        items.append("- %s（%s）" % (fname, _format_size(size)))

    if not items:
        return ""

    return "📎 上传文件：\n" + "\n".join(items)


def _collect_docs_block(chat_id):
    """收集 docs/ 下的文档列表（标题+章节数+状态）。"""
    from core.doc_session import list_docs_in_chat
    try:
        docs = list_docs_in_chat(chat_id)
    except Exception:
        return ""

    if not docs:
        return ""

    lines = []
    for d in docs:
        topic = d.get("topic") or "未命名文档"
        sections = d.get("sections", 0)
        status = d.get("status", "ongoing")
        status_label = "已完成" if status == "completed" else "写作中"
        lines.append("- 《%s》（%d章，%s）" % (topic, sections, status_label))

    return "📄 文档状态：\n" + "\n".join(lines)


def _collect_tool_history_block(history):
    """从对话历史的 agent_timeline 提取工具调用历史。

    格式示例：
    🔍 本次会话工具调用历史：
    - search_web: "兵棋推演"(10条), "wargaming"(8条)
    - fetch_url: rand.org/...(2.3s)
    - search_kb: "兵棋推演"(无结果)
    """
    if not history or not isinstance(history, (list, tuple)):
        return ""

    # 聚合：tool_name → list[摘要]
    search_web_queries = []
    fetch_summaries = []
    search_kb_queries = []
    has_writing = False

    for msg in history:
        if not isinstance(msg, dict):
            continue
        timeline = msg.get("agent_timeline")
        if not timeline or not isinstance(timeline, list):
            continue
        for item in timeline:
            if not isinstance(item, dict):
                continue
            status = item.get("status", "")
            if status == "searching":
                q = item.get("query", "")
                if q:
                    search_web_queries.append(q)
            elif status == "fetch_done":
                # 没有耗时字段，记 length
                length = item.get("length") or 0
                fetch_summaries.append("获取%d字" % length if length else "已抓取")
            elif status == "kb_searching":
                q = item.get("query", "")
                if q:
                    search_kb_queries.append(q)
            elif status == "writing":
                has_writing = True

    if not (search_web_queries or fetch_summaries or search_kb_queries or has_writing):
        return ""

    lines = []
    if search_web_queries:
        # 去重保序，最多 5 个
        seen = set()
        uniq = []
        for q in search_web_queries:
            if q not in seen:
                seen.add(q)
                uniq.append(q)
        kw = ", ".join('"%s"' % q for q in uniq[:5])
        lines.append("- search_web: %s（%d次）" % (kw, len(search_web_queries)))
    if fetch_summaries:
        lines.append("- fetch_url: %d 次" % len(fetch_summaries))
    if search_kb_queries:
        seen = set()
        uniq = []
        for q in search_kb_queries:
            if q not in seen:
                seen.add(q)
                uniq.append(q)
        kw = ", ".join('"%s"' % q for q in uniq[:5])
        lines.append("- search_kb: %s（%d次）" % (kw, len(search_kb_queries)))
    if has_writing:
        lines.append("- write_section: 已有章节写入")

    if not lines:
        return ""

    return "🔍 工具调用历史：\n" + "\n".join(lines)


def _collect_workspace_block(chat_id):
    """收集 workspace/ 下的文件清单（文件名+大小，不含内容）。"""
    from core.doc_session import list_workspace_files
    try:
        files = list_workspace_files(chat_id)
    except Exception:
        return ""

    if not files:
        return ""

    lines = []
    for f in files[:20]:  # 最多 20 个
        name = f.get("name", "")
        size = f.get("size", 0)
        lines.append("- %s（%s）" % (name, _format_size(size)))

    return "🧰 工作区文件：\n" + "\n".join(lines)


def _format_size(n):
    """字节数转人类可读。"""
    if n < 1024:
        return "%dB" % n
    elif n < 1024 * 1024:
        return "%.1fKB" % (n / 1024)
    else:
        return "%.1fMB" % (n / (1024 * 1024))


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
