# -*- coding: utf-8 -*-
"""
core/agent_loop.py — ReAct Agent 循环
======================================

在线模式的核心：大模型 = 指挥官，工具 = 手脚。

循环流程：
  1. 构建 messages（system prompt + 工具定义 + 历史 + 用户消息）
  2. 调用 CloudEngine.run_with_tools() 流式输出
  3. 如果模型返回 tool_calls → 执行工具 → 结果追加到 messages → 回到 2
  4. 如果模型返回纯文本 → 最终回答 → 结束

硬限：
  - 最多 10 轮工具调用
  - 工具历史 token 上限 40000（超限自动压缩）

Yield 格式（与 cloud_pipeline 消费者对齐）：
  ("text", str)            — 正文 token
  ("agent_think", dict)    — 推理思考 {"content": token}
  ("agent_status", dict)   — 实时状态 {"status": "searching", "query": "..."}
  ("agent_summary", dict)  — 最终统计 {"searches": N, "fetches": N, ...}
  ("task_type", tuple)     — 任务分类 ("agent", 0.95)
  ("error", str)           — 错误信息
"""

import os
import json
import time
import ast
import logging

log = logging.getLogger(__name__)

# ===== 安全计算器（calculator 工具用）=====
# 白名单：允许的 AST 节点 + 允许的函数名。其余一律拒绝（防止任意代码执行）。
_SAFE_MATH_NODES = tuple(
    n for n in (
        ast.Expression,          # 顶层
        ast.BinOp,               # 二元运算 a + b
        ast.UnaryOp,             # 一元运算 -a
        getattr(ast, "Num", None),       # 数字（Python <3.8，3.12+ 已移除）
        getattr(ast, "Str", None),       # 字符串（同上，仅用于兼容旧版）
        ast.Constant,            # 数字/常量（Python >=3.8）
        ast.Call,                # 函数调用（仅白名单函数）
        ast.Name,                # 标识符（仅白名单）
        ast.Load,                # Name 的 ctx 节点
    ) if n is not None
)
_SAFE_MATH_BINOPS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod, ast.Pow, ast.USub, ast.UAdd)
_SAFE_MATH_FUNCS = {
    "min": min, "max": max, "round": round, "abs": abs,
    "sum": sum, "pow": pow,
}
# 二元/一元运算符 → Python 运算的映射表（供 _safe_math_eval 的纯 AST 求值器使用）
import operator as _op
_BINOP_TABLE = {
    ast.Add: _op.add, ast.Sub: _op.sub, ast.Mult: _op.mul,
    ast.Div: _op.truediv, ast.Mod: _op.mod, ast.Pow: _op.pow,
}
_UNARYOP_TABLE = {
    ast.USub: _op.neg, ast.UAdd: _op.pos,
}

# BUG-6：幂运算指数上限，防止 `9**9**9` 之类巨整数算力/内存 DoS。
# 表达式自底向上求值，每个 ** 的指数都会被检查，嵌套幂同样受限。
_MAX_POW_EXPONENT = 1000


def _check_pow_exponent(exp):
    """校验幂运算指数规模，超限抛 ValueError。"""
    try:
        if abs(exp) > _MAX_POW_EXPONENT:
            raise ValueError("指数过大（绝对值上限 %d）" % _MAX_POW_EXPONENT)
    except TypeError:
        raise ValueError("非法指数")


def _safe_math_eval(expression: str):
    """安全计算数学表达式。仅允许数字 + 四则运算 + 白名单函数，拒绝任何代码/属性访问。

    Returns: 计算结果（int/float）
    Raises: ValueError 表达式非法或包含禁止内容
    """
    # 1. 字符级白名单：先过滤掉明显危险的字符（双下划线、引号、赋值、分号等）
    import re
    if re.search(r'__|["\']|;|=|import|exec|eval|open|os\.|sys\.', expression):
        raise ValueError("表达式包含禁止字符")

    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError:
        raise ValueError("表达式语法错误")

    def _check(node):
        if isinstance(node, ast.Expression):
            _check(node.body)
            return
        if isinstance(node, ast.BinOp):
            if not isinstance(node.op, _SAFE_MATH_BINOPS):
                raise ValueError("不允许的运算符: %s" % type(node.op).__name__)
            _check(node.left)
            _check(node.right)
            return
        if isinstance(node, ast.UnaryOp):
            if not isinstance(node.op, _SAFE_MATH_BINOPS):  # USub/UAdd 也在白名单
                raise ValueError("不允许的一元运算符: %s" % type(node.op).__name__)
            _check(node.operand)
            return
        if isinstance(node, ast.Constant):
            if not isinstance(node.value, (int, float)):
                raise ValueError("不允许的常量类型")
            return
        # Python <3.8 的 ast.Num（3.12+ 已并入 ast.Constant，跳过此分支）
        _NumType = getattr(ast, "Num", None)
        if _NumType and isinstance(node, _NumType):
            return
        if isinstance(node, ast.Call):
            if not isinstance(node.func, ast.Name) or node.func.id not in _SAFE_MATH_FUNCS:
                raise ValueError("不允许的函数调用")
            for a in node.args:
                _check(a)
            return
        if isinstance(node, ast.Name):
            if node.id not in _SAFE_MATH_FUNCS:
                raise ValueError("不允许的标识符: %s" % node.id)
            return
        if isinstance(node, ast.Load):
            return
        raise ValueError("不允许的语法: %s" % type(node).__name__)

    _check(tree)
    # 纯 AST 递归求值（不再使用 eval，彻底杜绝代码注入）
    # 白名单检查 _check 已确保只有 BinOp/UnaryOp/Constant/Call/Name 五种节点
    def _eval(node):
        if isinstance(node, ast.Expression):
            return _eval(node.body)
        if isinstance(node, ast.BinOp):
            left = _eval(node.left)
            right = _eval(node.right)
            if isinstance(node.op, ast.Pow):
                _check_pow_exponent(right)
            return _BINOP_TABLE[type(node.op)](left, right)
        if isinstance(node, ast.UnaryOp):
            operand = _eval(node.operand)
            return _UNARYOP_TABLE[type(node.op)](operand)
        if isinstance(node, ast.Constant):
            return node.value
        if isinstance(node, ast.Call):
            func = _SAFE_MATH_FUNCS[node.func.id]
            args = [_eval(a) for a in node.args]
            if node.func.id == "pow" and len(args) >= 2:
                _check_pow_exponent(args[1])
            return func(*args)
        # Name 仅在 Call.func 上下文出现（_check 已保证），不直接求值为值
        raise ValueError("不可求值的节点: %s" % type(node).__name__)

    return _eval(tree)


# ===== 常量 =====
# Patch4 修复 3：MAX_ROUNDS 从 10 提到 20，支持长文档（>10 章）
# P8-2：20→26（search 5 + fetch 15 最坏情况占 20，留 6 轮收尾）
# 0.10.1 起用户可调（设置页 → 在线 AI → 轮次预算，PLAN 四章）：config.agent_max_rounds，
# 默认 26，范围 8~100，非法/留空回落默认
MAX_ROUNDS = 26


def get_max_rounds():
    try:
        from config import get as _cfg_get
        v = _cfg_get("agent_max_rounds", MAX_ROUNDS)
        v = int(v)
        if 8 <= v <= 100:
            return v
    except Exception:
        pass
    return MAX_ROUNDS
MAX_TOOL_HISTORY_CHARS = 60000  # 工具历史最大字符数（约 40000 token）

# Cheap 工具：本地、不消耗 token 预算，**不计入 MAX_ROUNDS**（Patch4 v3.1 BUG#28 修复）
# 理由：read_workspace/list_workspace 是 1-2s 本地操作，1 轮里调 10 次也不"贵"
#      之前计入导致 LLM 反复读同一文件 19 次就触发 20 轮上限
CHEEP_TOOLS = {
    "read_workspace", "read_workspace_chunk",
    "list_workspace", "list_docs",
    "summarize_history",  # 上下文压缩，本地不调模型
    "get_current_time",   # 本地时间
    "calculator",          # 本地算术
    "format_convert",      # 本地文件读取转换
    "table_ops",           # 本地表格读写
}

# Patch4 修复 3：子类硬限制（防死循环 + 防 token 爆炸）
# 未列出的工具（set_doc_status / list_docs / workspace 工具）不限制
# P8-2：search_web 3→5、fetch_url 5→15（与 search 保持 1:3，一次搜索读 3 篇）
TOOL_LIMITS = {
    "search_web": 5,   # 互联网搜索最多 5 次
    "search_kb": 5,    # 知识库搜索最多 5 次（Patch4 v3.1：2→5，KB 本地检索便宜，实测需要多角度查）
    "fetch_url": 15,   # 网页阅读最多 15 次
}

# 剩余轮次预警阈值（剩 N 轮时开始注入 hint 促收尾）
LOW_ROUNDS_WARN = 5


def _extract_md_title(md_content):
    """从 Markdown 内容提取第一个 # 一级标题作为文档标题。

    Returns:
        str: 标题文本（不含 #）。找不到返回空字符串。
    """
    if not md_content:
        return ""
    for line in md_content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# ") and not stripped.startswith("## "):
            return stripped[2:].strip()
    return ""


def _keyword_excerpt(text, question, width=1200):
    """按问题关键词从长文截取相关片段（M2 spawn_reader 用）。

    策略：问题分词（中文二元组+英文词），统计每段的命中数，
    取命中最高的段落窗口拼接；全文零命中时返回开头 width 字符。
    """
    if not text:
        return ""
    if len(text) <= width:
        return text
    import re as _re
    # 问题分词：英文/数字词 + 中文连续段（长度≥2 按二元组切）
    words = _re.findall(r"[A-Za-z0-9_]{2,}", question)
    for seg in _re.findall(r"[一-鿿]{2,}", question):
        words.append(seg)
        if len(seg) > 2:
            words.extend(seg[i:i + 2] for i in range(len(seg) - 1))
    words = [w for w in dict.fromkeys(words) if len(w) >= 2][:12]
    if not words:
        return text[:width]
    # 分段评分（按行聚合到 ~300 字的块）
    lines = text.splitlines()
    blocks, cur = [], ""
    for ln in lines:
        cur += ln + "\n"
        if len(cur) >= 300:
            blocks.append(cur)
            cur = ""
    if cur:
        blocks.append(cur)
    scored = []
    for i, b in enumerate(blocks):
        hit = sum(b.count(w) for w in words)
        scored.append((hit, i, b))
    if not any(h for h, _, _ in scored):
        return text[:width]
    # 取命中最高的块按原文顺序拼到 width
    picked = sorted((s for s in scored if s[0] > 0), key=lambda x: -x[0])
    chosen, total = [], 0
    for hit, i, b in picked:
        if total >= width:
            break
        chosen.append((i, b))
        total += len(b)
    chosen.sort()
    return "\n…\n".join(b for _, b in chosen)[:width + 100]


class AgentLoop:
    """ReAct Agent 循环 — 在线模式专用"""

    def __init__(self, cloud_engine, search_engine, kb=None, chat_id=None, history=None):
        """
        Args:
            cloud_engine: CloudEngine 实例
            search_engine: SearchEngine 实例
            kb: KB 管理器实例（可选）
            chat_id: 会话 ID（文件夹名）— Patch4 v3：workspace 文件操作 + completed 标记
            history: 当前轮次的历史消息列表（Patch5 G：summarize_history 工具用）
        """
        self.cloud_engine = cloud_engine
        self.search_engine = search_engine
        self.kb = kb
        self.chat_id = chat_id or ""
        self._history_snapshot = history or []  # Patch5 G.一致性：用于 summarize_history

    def _workspace_error(self, tool_name, err):
        """workspace 工具的通用错误返回。"""
        log.error("[AGENT] %s 执行失败: %s", tool_name, str(err)[:120])
        return {
            "success": False,
            "tool": tool_name,
            "error": "execution_error",
            "message": "工作区操作失败: %s" % str(err)[:100],
        }

    def run(self, message, mode="chat", history=None, context_cache=None, template=None):
        """Agent 主循环 — yield (phase, content)

        Args:
            message: 用户消息
            mode: "chat" 或 "doc"
            history: 对话历史（list[dict]）
            context_cache: 上下文缓存字符串
            template: 模板 dict（parse_template() 的返回值，可选，doc 模式用）

        Yields:
            (phase, content) 元组
        """
        from core.agent_tools import get_tools_and_prompt, get_status_event, get_tool_def

        # Patch4 v3：不再有 DocSession / doc_sections 状态（文档 = workspace 里的 .md 文件）

        # ===== 读取 KB 权限配置 =====
        kb_permission = "full"
        try:
            from config import get as _cfg
            kb_permission = _cfg("kb_permission", "full")
        except Exception:
            pass

        # ===== 1. 动态组装工具 + system prompt =====
        # Patch4 修复 2：传入 chat_id 和 history 用于会话上下文注入
        tools, system_prompt = get_tools_and_prompt(
            mode=mode, kb=self.kb, template=template, kb_permission=kb_permission,
            chat_id=self.chat_id, history=history,
        )

        # ===== 2. 构建 messages =====
        messages = self._build_messages(message, system_prompt, history, context_cache)

        # ===== 3. 发送 task_type =====
        yield ("task_type", ("agent", 0.95))

        # ===== 4. ReAct 循环 =====
        stats = {
            "searches": 0,
            "fetches": 0,
            "kb_hits": 0,
            "docs": 0,
            "start_time": time.time(),
        }

        has_tools = len(tools) > 0
        final_text = ""
        rounds = 0
        # Patch4 修复 3：累计每种工具的调用次数（用于子类硬限制）
        tool_counts = {}
        # P6 #7: 记录已发过"达上限"友好提示的工具，避免每轮重复报 limit_exceeded
        _limit_notified = set()
        # P8-2: 只搜不读护栏——本任务内是否已注入过补读提示（只介入一次）
        _fetch_hint_used = False

        if not has_tools:
            # 无工具可用（不应该发生，在线模式有网），直接纯对话
            log.warning("[AGENT] 无工具可用，fallback 纯对话")
            yield from self._pure_chat(messages)
            return

        while rounds < get_max_rounds():
            # 注意：rounds 不在这里 +=1。改为：本轮工具是 expensive 才 +1，cheap 不计
            # 这样 read_workspace 连读 19 次也不会触发 20 轮上限
            _round_incremented = False
            log.info("[AGENT] === 第 %d 轮 === tools=%d", rounds + 1, len(messages))

            # P6 #6: 检测用户终止。cloud/agent 路径原来不响应 /api/stop，
            # 用户点终止后后端继续跑完，空回复触发"Agent未能生成回复"兜底。
            # 这里主动检测 mgr._stop_generation，终止时立即跳出循环。
            try:
                if getattr(self.cloud_engine._mm, '_stop_generation', False):
                    log.info("[AGENT] 检测到用户终止，停止迭代 (已完成 %d 轮)", rounds - 1)
                    yield ("agent_status", {"status": "user_stopped"})
                    break
            except Exception:
                pass

            # Patch4 修复 3：子类硬限制——每轮调用前移除已达上限的工具
            # （硬移除：不是 prompt 建议，模型这一轮直接看不到该工具）
            if tool_counts:
                removed = []
                new_tools = []
                for t in tools:
                    tname = t.get("function", {}).get("name", "")
                    limit = TOOL_LIMITS.get(tname)
                    if limit is not None and tool_counts.get(tname, 0) >= limit:
                        removed.append(tname)
                        continue  # 跳过，不加入 new_tools
                    new_tools.append(t)
                if removed:
                    tools = new_tools
                    log.info("[AGENT] 子类超限，移除工具: %s", removed)
                    yield ("agent_status", {
                        "status": "tool_limited",
                        "removed": removed,
                        "rounds_left": get_max_rounds() - rounds,
                    })
                # 如果所有工具都被移除（极端情况），提前结束循环
                if not tools:
                    log.warning("[AGENT] 所有可限制工具已达上限且无其他工具可用，结束循环")
                    yield ("agent_status", {"status": "budget_exceeded"})
                    break

            # P8-2 预算注入：每轮在 messages 末尾刷新一条预算快照
            # （替换旧快照不累积；用内容前缀识别，不加自定义字段——
            #  部分服务商对 message 里的未知字段会 400）
            messages[:] = [m for m in messages
                           if not (m.get("role") == "user"
                                   and isinstance(m.get("content"), str)
                                   and m["content"].startswith("[剩余预算]"))]
            messages.append({
                "role": "user",
                "content": ("[剩余预算] 联网搜索 %d 次 · 网页阅读 %d 次 · 知识库搜索 %d 次 · 总轮次 %d 轮"
                            "（请据此规划检索深度，预算不足时直接基于已有信息回答）" % (
                                max(0, TOOL_LIMITS["search_web"] - tool_counts.get("search_web", 0)),
                                max(0, TOOL_LIMITS["fetch_url"] - tool_counts.get("fetch_url", 0)),
                                max(0, TOOL_LIMITS["search_kb"] - tool_counts.get("search_kb", 0)),
                                get_max_rounds() - rounds)),
            })

            # 发送思考状态
            yield ("agent_status", {"status": "thinking"})

            # 调用 CloudEngine（带工具）
            tool_calls = []
            text_output = ""
            think_started = False

            try:
                for phase, content in self.cloud_engine.run_with_tools(
                    messages, tools=tools,
                ):
                    if phase == "tool_calls":
                        # 模型调用了工具
                        tool_calls = content  # list[dict]
                    elif phase == "text":
                        # 逐 token 立即转发，保证打字机效果
                        text_output += content
                        yield ("text", content)
                    elif phase == "think_start":
                        think_started = True
                    elif phase == "think_token":
                        yield ("agent_think", {"content": content})
                    elif phase == "think_end":
                        think_started = False
                        yield ("agent_think", {"content": ""})  # 结束标记
                    elif phase == "token_stats":
                        # 透传 token_stats
                        yield ("token_stats", content)
                    elif phase == "error":
                        # CloudEngine 返回的结构化错误 {"user_msg", "error_type", "detail"}
                        yield ("error", content)
                        return
                    elif phase == "raw":
                        # 兼容旧的 raw 错误格式
                        yield ("error", {"user_msg": content, "error_type": "unknown", "detail": content})
                        return

            except Exception as e:
                err = str(e)[:200]
                log.error("[AGENT] CloudEngine 异常: %s", err)
                # FC fallback：尝试解析已有文本
                if text_output:
                    yield ("text", text_output)
                else:
                    yield ("error", {
                        "user_msg": "⚠️ Agent 调用失败，请稍后重试。",
                        "error_type": "agent_error",
                        "detail": err,
                    })
                return

            # 模型没调工具 = 回答完毕
            if not tool_calls:
                # P8-2 只搜不读护栏：搜索过但从未 fetch 读原文 →
                # 注入一次提示（user 角色，兼容性最好），给一次补读机会。
                # 只介入一次：模型坚持不读则放行（简单事实问题可接受）。
                if (stats["searches"] > 0 and stats["fetches"] == 0
                        and not _fetch_hint_used):
                    _fetch_hint_used = True
                    log.info("[AGENT] 只搜不读护栏触发：search=%d fetch=0，注入补读提示", stats["searches"])
                    messages.append({
                        "role": "user",
                        "content": ("[系统提示] 你刚才的回答仅基于搜索结果摘要，摘要可能过时、片面或不准确。"
                                    "请先调用 fetch_url 阅读最相关的 1-2 个来源的正文，再给出最终答案。"
                                    "回答中的来源编号 [1] 只能标注你实际读过的页面。"),
                    })
                    yield ("agent_status", {"status": "fetch_hint"})
                    continue
                if text_output:
                    final_text += text_output
                    # text 已在循环内逐 token yield，这里不重复
                break

            # 模型同时输出文本和工具调用（某些模型行为），保留文本
            if text_output:
                final_text += text_output
                # text 已在循环内逐 token yield，这里不重复

            # ===== 执行工具调用 =====
            # 追加 assistant 消息（包含 tool_calls）
            messages.append({
                "role": "assistant",
                "content": text_output if text_output else None,
                "tool_calls": tool_calls,
            })

            for tc in tool_calls:
                tc_id = tc.get("id", "")
                func = tc.get("function", {})
                tool_name = func.get("name", "")
                args_str = func.get("arguments", "{}")

                # 解析参数
                try:
                    args = json.loads(args_str) if args_str else {}
                except json.JSONDecodeError:
                    args = {}

                # Patch4 v3.1 BUG#28：工具超限后拒绝执行（之前只从 tools 表移除，
                # 但模型仍可能基于 history 调用，导致"部分工具已达上限"后还在调）
                _limit = TOOL_LIMITS.get(tool_name)
                _current_count = tool_counts.get(tool_name, 0)
                if _limit is not None and _current_count >= _limit:
                    log.warning("[AGENT] 工具 %s 已达上限 %d/%d，拒绝执行", tool_name, _current_count, _limit)
                    # P6 #7/#4-c: 首次达上限发友好提示(中文)，之后静默拒绝，不再每轮报 limit_exceeded
                    if tool_name not in _limit_notified:
                        _limit_notified.add(tool_name)
                        _tool_label = {"search_web": "联网搜索", "search_kb": "知识库搜索",
                                       "fetch_url": "网页阅读"}.get(tool_name, tool_name)
                        yield ("agent_status", {
                            "status": "tool_limit_reached",
                            "tool": tool_name,
                            "label": _tool_label,
                            "limit": _limit,
                            "message": "已%s%d次，基于已获取信息继续回答" % (_tool_label, _limit),
                        })
                    # 给模型返回一个明确的错误，让它自己收手
                    # 注意：limit 是"本轮对话"的计数（每次 agent loop 重置），不是"本日"
                    # 文案必须明确写"本轮"，否则模型会在回答里编造"本日已达上限"误导用户
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc_id,
                        "name": tool_name,
                        "content": json.dumps({
                            "error": "limit_exceeded",
                            "message": "本轮对话中此工具已调用 %d 次，达到本轮上限。请基于已获取的信息继续回答，不要再调用 %s（下一条消息可重新使用）" % (_limit, tool_name),
                        }, ensure_ascii=False),
                    })
                    continue

                log.info("[AGENT] 工具调用: %s(%s)", tool_name, args_str[:100])

                # 发送开始状态
                status_data = self._make_start_status(tool_name, args)
                yield ("agent_status", status_data)

                # 执行工具
                # Patch5 T05: 工具调用（search_web/search_kb/fetch_url 等）可能涉及
                # CPU 密集或 IO 阻塞操作（KB 检索的 embedding 计算、网页抓取），
                # 包装到线程池执行，避免阻塞事件循环。
                from core.thread_pool import get_thread_pool
                # P5 审计修复 P0-5: 捕获线程池工具执行异常
                try:
                    result = get_thread_pool().run_blocking(
                        self._execute_tool, tool_name, args, stats
                    )
                except Exception as e:
                    log.error("[AGENT] 工具执行异常 %s: %s", tool_name, str(e)[:200])
                    result = {"error": "工具执行失败: " + str(e)[:200], "tool": tool_name,
                              "success": False}

                # Patch4 修复 3：累计工具调用次数（用于子类硬限制）
                tool_counts[tool_name] = tool_counts.get(tool_name, 0) + 1

                # Patch4 v3.1 BUG#28 修复：cheap 工具不计 MAX_ROUNDS 预算
                # 多个 cheap 工具在同一轮只计 1 次（避免一次返回里调 5 个 read 算 5 轮）
                if not _round_incremented and tool_name not in CHEEP_TOOLS:
                    rounds += 1
                    _round_incremented = True
                elif tool_name in CHEEP_TOOLS:
                    log.info("[AGENT] cheap 工具 %s 不计轮数 (当前轮数 %d)", tool_name, rounds)

                # Patch4 修复 3：剩 N 轮时注入预警 hint
                # （通过 result 的 hint 字段附加到 tool_result 消息内容）
                rounds_left = get_max_rounds() - rounds
                if rounds_left <= LOW_ROUNDS_WARN:
                    warn_hint = (
                        "⚠️ 你还剩 %d 轮预算，请尽快完成剩余写作或调用 "
                        "set_doc_status(\"文件名.md\", \"completed\")。" % rounds_left
                    )
                    if isinstance(result, dict):
                        existing_hint = result.get("hint", "")
                        result["hint"] = (existing_hint + "\n" + warn_hint).strip() \
                            if existing_hint else warn_hint

                # 发送完成状态
                done_status = self._make_done_status(tool_name, result, args)
                yield ("agent_status", done_status)

                # 追加 tool 结果到 messages
                result_str = json.dumps(result, ensure_ascii=False)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc_id,
                    "content": result_str,
                })

            # Token 预算检查
            if self._should_compress(messages):
                self._compress_tool_history(messages)
                yield ("agent_status", {"status": "budget_exceeded"})

        # ===== 5. 轮次用完 → 强制收尾 =====
        # Patch4 v3.1 BUG#28 修复：达 MAX_ROUNDS 后不再静默退出，
        # 注入"必须直接回答"指令后追加一轮纯对话调用（不带 tools），让 LLM 总结
        _max_rounds = get_max_rounds()
        if rounds >= _max_rounds:
            log.warning("[AGENT] 达到最大轮次 %d，强制收尾生成总结", _max_rounds)
            yield ("agent_status", {"status": "budget_exceeded"})
            # 仅当用户没收到任何回答时才调 LLM 收尾（避免重复）
            if not final_text.strip():
                try:
                    messages.append({
                        "role": "system",
                        "content": (
                            "你已用完工具调用预算。**禁止再调用任何工具**。"
                            "请基于已有信息直接给用户完整回答（不要再读文档、不要再搜）。"
                            "如果信息不足，明确告诉用户缺什么、建议如何继续。"
                        ),
                    })
                    _final_text = ""
                    # 不传 tools，CloudEngine 走纯对话分支（不触发 FC）
                    for phase, content in self.cloud_engine.run_with_tools(
                        messages, tools=None,
                    ):
                        if phase == "text":
                            _final_text += content
                            yield ("text", content)
                        elif phase == "think_token":
                            yield ("agent_think", {"content": content})
                        elif phase == "think_end":
                            yield ("agent_think", {"content": ""})
                        elif phase == "error":
                            # API 拒绝时（tool_calls 历史的兼容性问题），降级为"已尽力"
                            log.warning("[AGENT] 收尾调用失败: %s", str(content)[:200])
                            break
                    if _final_text:
                        final_text += _final_text
                    else:
                        # 收尾失败时的兜底文案（避免用户看到空消息）
                        yield ("text", "\n\n⚠️ 工具调用已用完预算（%d 轮），无法继续。\n\n"
                                       "建议：\n- 在新消息里直接问你想知道的\n"
                                       "- 或切换到「文档模式」生成完整报告" % _max_rounds)
                except Exception as e:
                    log.error("[AGENT] 收尾生成失败: %s", str(e)[:200])
                    yield ("text", "\n\n⚠️ 达到最大轮次 %d，生成结束。" % get_max_rounds())

        # ===== 6. 发送统计摘要 =====
        elapsed = int(time.time() - stats["start_time"])
        # P7: 统计真实 messages 总字符数（含工具历史/system prompt），推给前端更新上下文指示器
        _total_chars = sum(len(str(m.get("content", ""))) for m in messages)
        yield ("agent_summary", {
            "searches": stats["searches"],
            "fetches": stats["fetches"],
            "kb_hits": stats["kb_hits"],
            "docs": stats["docs"],
            "time_queries": stats.get("time_queries", 0),
            "calculations": stats.get("calculations", 0),
            "conversions": stats.get("conversions", 0),
            "table_ops": stats.get("table_ops_count", 0),
            "elapsed": elapsed,
            "total_chars": _total_chars,  # P7: 真实上下文字符数（前端据此更新指示器）
        })

        log.info("[AGENT] 完成: %d轮, searches=%d, fetches=%d, kb=%d, docs=%d, time=%d, calc=%d, conv=%d, tbl=%d, %.1fs",
                 rounds, stats["searches"], stats["fetches"],
                 stats["kb_hits"], stats["docs"],
                 stats.get("time_queries", 0), stats.get("calculations", 0),
                 stats.get("conversions", 0), stats.get("table_ops_count", 0), elapsed)

    def _build_messages(self, message, system_prompt, history, context_cache):
        """构建 OpenAI 格式的 messages 数组"""
        messages = [{"role": "system", "content": system_prompt}]

        # 添加上下文缓存（兼容字符串和字典两种格式）
        if context_cache:
            if isinstance(context_cache, dict):
                # P6: 字典格式——提取预注入的 KB 文档内容
                kb_ctx = context_cache.get('kb_context', '')
                if kb_ctx:
                    messages[0]["content"] += "\n\n[用户选定的参考文档]\n" + kb_ctx + "\n\n注意：以上文档内容已直接提供，无需再调用 search_kb 检索这些文档。"
                # 其他上下文字段（摘要等）
                summary = context_cache.get('summary', '')
                if summary:
                    messages[0]["content"] += "\n\n[上下文摘要]\n" + summary
            elif isinstance(context_cache, str):
                messages[0]["content"] += "\n\n[上下文摘要]\n" + context_cache

        # 添加历史（只保留 user/assistant 角色，过滤 tool 消息保持简洁）
        # P7 修复上下文爆炸：从最新往回加，超 token 预算就停（不再无脑取 20 条）
        # 用户场景：第一轮写了超长 HTML 报告，第二轮对话时整篇报告进 messages → 400
        HISTORY_TOKEN_BUDGET = 120000  # 历史最多 ~12 万 token（约 18 万字符）
        if history:
            recent = []
            used_chars = 0
            # 从最新往回取，超预算就停
            for item in reversed(history):
                role = item.get("role", "")
                content = item.get("content", "")
                if role not in ("user", "assistant") or not content:
                    continue
                item_chars = len(content)
                if used_chars + item_chars > HISTORY_TOKEN_BUDGET * 3:  # ×3: token≈字符/3 粗估
                    # 这条太长，如果是很久以前的就跳过；如果是最近的就截断保留头部
                    if not recent:
                        # 最近一条就超预算（第一轮回答极长），截断保留
                        truncated = content[:HISTORY_TOKEN_BUDGET * 3]
                        recent.insert(0, {"role": role, "content": truncated + "\n...(内容过长已截断)"})
                        used_chars += len(truncated)
                    break
                recent.insert(0, {"role": role, "content": content})
                used_chars += item_chars
                if len(recent) >= 20:  # 最多 20 条
                    break
            messages.extend(recent)
            if used_chars > HISTORY_TOKEN_BUDGET * 2:
                log.info("[AGENT] 历史压缩: 保留 %d 条, %d 字符(预算 %d)", len(recent), used_chars, HISTORY_TOKEN_BUDGET * 3)

        # 当前用户消息
        messages.append({"role": "user", "content": message})

        return messages

    def _review_mermaid_blocks(self, content: str) -> tuple:
        """P8-8 交付前查错：提取 ```mermaid``` 围栏代码，让模型校验语法并修复。

        只在含 mermaid 块时多花一次小 LLM 调用；任何失败都返回原文，不阻塞交付
        （报告内的渲染失败兜底提示仍然兜底）。

        Returns:
            (content, fixed_count): 修复后的内容 + 修复段数
        """
        import re as _re
        import json as _json

        blocks = list(_re.finditer(r"```mermaid\s*\n(.*?)```", content, flags=_re.DOTALL))
        if not blocks:
            return content, 0

        codes = [b.group(1).strip() for b in blocks]
        listing = "\n\n".join("【图表 %d】\n%s" % (i, c) for i, c in enumerate(codes))
        prompt = (
            "以下是一份 HTML 报告里的 %d 段 mermaid 图表代码，将被原样渲染。\n"
            "请逐一做语法检查。常见错误：xychart-beta 的数值不是纯数字或缺 x-axis；"
            "节点文字含括号/特殊符号未加英文引号；混入中文标点；箭头或关键字拼写错误；"
            "pie 条目格式错误；subgraph 未闭合。\n"
            "只返回 JSON 数组，不要任何其他文字：\n"
            '[{"index": 0, "ok": true}, {"index": 1, "ok": false, "fixed": "修正后的完整 mermaid 代码"}]\n'
            "没问题的图表直接 ok=true（不带 fixed）。\n\n" % len(codes) + listing
        )

        try:
            text = ""
            for phase, chunk in self.cloud_engine.run(prompt, override_task_type="text"):
                if phase == "text":
                    text += chunk
                elif phase == "error":
                    log.warning("[DOC] mermaid 审查调用失败: %s",
                                (chunk.get("user_msg", "") if isinstance(chunk, dict) else str(chunk))[:80])
                    return content, 0
            m = _re.search(r"\[.*\]", text, flags=_re.DOTALL)
            if not m:
                return content, 0
            reviews = _json.loads(m.group(0))
            fixes = []
            for rv in reviews:
                idx = rv.get("index")
                if (isinstance(idx, int) and 0 <= idx < len(blocks)
                        and not rv.get("ok", True) and rv.get("fixed")):
                    fixes.append((idx, rv["fixed"].strip()))
            # 从后往前替换，避免 span 偏移
            for idx, fixed in sorted(fixes, reverse=True):
                span = blocks[idx].span(1)
                content = content[:span[0]] + "\n" + fixed + "\n" + content[span[1]:]
            if fixes:
                log.info("[DOC] mermaid 交付前查错：修复 %d/%d 段", len(fixes), len(codes))
            return content, len(fixes)
        except Exception as e:
            log.warning("[DOC] mermaid 审查异常（按原文交付）: %s", str(e)[:80])
            return content, 0

    def _execute_tool(self, tool_name, args, stats):
        """执行单个工具调用

        Returns:
            dict: 工具执行结果（成功或失败）
        """
        try:
            if tool_name == "search_web":
                query = args.get("query", "")
                results = self.search_engine.search(query)
                stats["searches"] += 1
                return {
                    "success": True,
                    "tool": "search_web",
                    "data": {
                        "results": results,
                        "count": len(results),
                    },
                }

            elif tool_name == "fetch_url":
                url = args.get("url", "")
                # 异常 URL 日志检测（不阻断，仅记录可疑外泄尝试）
                try:
                    from urllib.parse import urlparse, parse_qs
                    _parsed = urlparse(url)
                    _query = parse_qs(_parsed.query)
                    _suspicious = False
                    _reason = ""
                    if len(url) > 2048:
                        _suspicious = True
                        _reason = "URL 过长（%d 字符）" % len(url)
                    else:
                        for _k, _v_list in _query.items():
                            for _v in _v_list:
                                # 疑似 base64 / 高熵长字符串参数
                                if len(_v) > 256 and any(c in _v for c in "+/="):
                                    _suspicious = True
                                    _reason = "参数 %s 疑似编码数据（长度 %d）" % (_k, len(_v))
                                    break
                            if _suspicious:
                                break
                    if _suspicious:
                        log.warning("[AGENT] fetch_url 可疑 URL: %s（%s）", url[:200], _reason)
                except Exception:
                    pass

                # SSRF 防护：抓取前校验目标地址分类
                from core.search_engine import classify_url
                from config import get as _cfg
                category, detail = classify_url(url)
                if category == "blocked":
                    # 链路本地/非法协议/解析失败 —— 硬拒绝
                    log.warning("[AGENT] fetch_url 被拒绝（%s）: %s", detail, url[:80])
                    return {
                        "success": False, "tool": "fetch_url",
                        "error": "url_blocked",
                        "message": "该地址被禁止访问（%s）。" % detail,
                    }
                if category == "private":
                    # 内网/回环 —— 读 confirm_external_read 决策
                    # True（谨慎模式/默认）= 拒绝并提示；False（完全信任）= 放行
                    if _cfg("confirm_external_read", True):
                        log.warning("[AGENT] fetch_url 内网地址受保护，已拒绝: %s", url[:80])
                        return {
                            "success": False, "tool": "fetch_url",
                            "error": "private_network_blocked",
                            "message": "局域网地址受保护（%s）。如需访问，请在设置→安全中选择「完全信任」权限预设。" % detail,
                        }
                    log.info("[AGENT] fetch_url 内网地址已放行（完全信任模式）: %s", url[:80])

                result = self.search_engine.fetch(url)
                stats["fetches"] += 1
                return {
                    "success": True,
                    "tool": "fetch_url",
                    "data": {
                        "title": result.get("title", ""),
                        "text": result.get("text", ""),
                        "url": result.get("url", url),
                        "length": len(result.get("text", "")),
                    },
                }

            elif tool_name == "search_kb":
                query = args.get("query", "")
                if self.kb is None:
                    return {
                        "success": False,
                        "tool": "search_kb",
                        "error": "知识库不可用",
                        "message": "当前没有知识库，请使用 search_web 搜索互联网。",
                    }

                # 云端 Agent 访问知识库：过滤掉私密文档（单文档粒度权限）
                # 私密文档只对本地可见，云端 Agent 的 search_kb 结果不含私密文档
                _accessible_doc_ids = None
                try:
                    _all_doc_ids = list(self.kb.documents.keys())
                    _accessible_doc_ids = set(
                        doc_id for doc_id in _all_doc_ids
                        if not getattr(self.kb.documents.get(doc_id), 'is_private', False)
                    )
                except Exception as e:
                    log.warning("[AGENT] search_kb 私密文档过滤失败: %s", str(e)[:80])
                # 使用 KB 的 get_context 方法
                kb_context, kb_sources = self.kb.get_context(
                    query, max_chars=4000, accessible_doc_ids=_accessible_doc_ids,
                    actor="cloud", access_type="agent_read")
                stats["kb_hits"] += 1
                # 构建 hint 字段
                hint = ""
                if kb_sources:
                    source_labels = [s.get("source_label", "?") for s in kb_sources[:3]]
                    hint = "来自文档: " + ", ".join(source_labels)
                return {
                    "success": True,
                    "tool": "search_kb",
                    "data": {
                        "context": kb_context,
                        "sources": [
                            {
                                "label": s.get("source_label", "?"),
                                "snippet": s.get("text_snippet", "")[:200],
                            }
                            for s in (kb_sources or [])[:5]
                        ],
                        "count": len(kb_sources or []),
                    },
                    "hint": hint,
                }

            elif tool_name == "summarize_history":
                # Patch5 G.一致性：调用云端模型压缩历史
                focus = args.get("focus", "")
                # BUG-3 修复：summarizes 未在 stats 初始化，原 += 1 会 KeyError 导致工具必失败
                stats["summarizes"] = stats.get("summarizes", 0) + 1
                try:
                    summary = self._summarize_history(focus)
                    if summary:
                        return {
                            "success": True,
                            "tool": "summarize_history",
                            "data": {
                                "summary": summary,
                                "length": len(summary),
                                "hint": "历史已压缩，后续可以基于此摘要继续对话",
                            },
                            "hint": "历史压缩完成",
                        }
                    else:
                        return {
                            "success": False,
                            "tool": "summarize_history",
                            "error": "empty_history",
                            "message": "没有可压缩的历史（可能是首轮对话）",
                        }
                except Exception as e:
                    log.warning("[AGENT] summarize_history 失败: %s", str(e)[:100])
                    return {
                        "success": False,
                        "tool": "summarize_history",
                        "error": "summarize_failed",
                        "message": "压缩失败: %s" % str(e)[:100],
                    }

            elif tool_name == "get_current_time":
                # 时间感知：返回当前日期时间 + 星期 + 农历（如有）
                stats["time_queries"] = stats.get("time_queries", 0) + 1
                try:
                    from datetime import datetime
                    now = datetime.now()
                    weekday_cn = "星期" + "一二三四五六日"[now.weekday()]
                    # 农历：优先用 lunardate/borax，不可用则跳过（不阻断）
                    lunar_str = ""
                    try:
                        import lunardate
                        ld = lunardate.LunarDate.fromSolarDate(
                            now.year, now.month, now.day)
                        lunar_str = " 农历%d年%s月%s" % (
                            ld.year, ["正","二","三","四","五","六","七","八","九","十","冬","腊"][ld.month-1] if 1 <= ld.month <= 12 else str(ld.month),
                            {1:"初一",2:"初二",3:"初三",4:"初四",5:"初五",6:"初六",7:"初七",8:"初八",9:"初九",10:"初十"}.get(ld.day, "%d日" % ld.day))
                    except ImportError:
                        pass  # 无农历库，跳过（不阻断主功能）
                    time_str = now.strftime("%Y年%m月%d日 %H:%M") + " " + weekday_cn + lunar_str
                    return {
                        "success": True,
                        "tool": "get_current_time",
                        "data": {
                            "datetime": time_str,
                            "iso": now.strftime("%Y-%m-%d %H:%M:%S"),
                            "weekday": weekday_cn,
                            "timestamp": int(now.timestamp()),
                        },
                    }
                except Exception as e:
                    log.warning("[AGENT] get_current_time 失败: %s", str(e)[:100])
                    return {
                        "success": False,
                        "tool": "get_current_time",
                        "error": "time_failed",
                        "message": "获取时间失败: %s" % str(e)[:100],
                    }

            elif tool_name == "calculator":
                # 安全计算器：仅允许数学表达式，禁任意代码（替代 code_exec）
                stats["calculations"] = stats.get("calculations", 0) + 1
                expression = (args.get("expression") or "").strip()
                if not expression:
                    return {"success": False, "tool": "calculator", "error": "缺少 expression",
                            "message": "请提供数学表达式"}
                try:
                    result = _safe_math_eval(expression)
                    return {
                        "success": True,
                        "tool": "calculator",
                        "data": {
                            "expression": expression,
                            "result": result,
                        },
                    }
                except Exception as e:
                    return {
                        "success": False,
                        "tool": "calculator",
                        "error": "calc_failed",
                        "message": "计算失败（%s）。仅支持 + - * / % 和括号，以及 min/max/round/abs。" % str(e)[:60],
                    }

            elif tool_name == "format_convert":
                # 格式转换：工作区内文件互转（md/docx/txt + pdf提取）
                stats["conversions"] = stats.get("conversions", 0) + 1
                src_name = args.get("source", "")
                dst_name = args.get("target", "")
                if not src_name or not dst_name:
                    return {"success": False, "tool": "format_convert", "error": "缺少参数",
                            "message": "需要 source 和 target 两个文件名"}
                try:
                    from config import WORKSPACE_DIR
                    from core.doc_session import safe_workspace_path
                    from core.file_converter import convert
                    src_path = safe_workspace_path(self.chat_id, src_name)
                    dst_path = safe_workspace_path(self.chat_id, dst_name)
                    result = convert(src_path, dst_path)
                    if result.get("ok"):
                        return {
                            "success": True,
                            "tool": "format_convert",
                            "data": {
                                "source": src_name,
                                "target": result.get("dst_name", dst_name),
                                "src_format": result.get("src_format"),
                                "dst_format": result.get("dst_format"),
                                "chars": result.get("chars", 0),
                                "hint": "已将 %s 转为 %s（%s→%s）" % (
                                    src_name, result.get("dst_name"), result.get("src_format"), result.get("dst_format")),
                            },
                        }
                    else:
                        return {"success": False, "tool": "format_convert", "error": "convert_failed",
                                "message": result.get("error", "转换失败")}
                except ValueError as e:
                    return {"success": False, "tool": "format_convert", "error": "path_violation",
                            "message": str(e)[:120]}
                except Exception as e:
                    return {"success": False, "tool": "format_convert", "error": "convert_failed",
                            "message": "转换失败: %s" % str(e)[:120]}

            elif tool_name == "table_ops":
                # 表格处理：读写 xlsx
                stats["table_ops_count"] = stats.get("table_ops_count", 0) + 1
                action = args.get("action", "")
                filename = args.get("filename", "")
                if not action or not filename:
                    return {"success": False, "tool": "table_ops", "error": "缺少参数",
                            "message": "需要 action（read/write）和 filename"}
                try:
                    from config import WORKSPACE_DIR
                    from core.doc_session import safe_workspace_path
                    from core import table_ops as table_mod
                    file_path = safe_workspace_path(self.chat_id, filename)
                    if action == "read":
                        result = table_mod.read_xlsx(file_path)
                        if result.get("ok"):
                            _hint = "读取 %s（%d行×%d列）" % (filename, result.get("rows", 0), result.get("cols", 0))
                            if result.get("truncated"):
                                _hint += "，已截断（仅显示前50行）"
                            return {
                                "success": True,
                                "tool": "table_ops",
                                "data": {
                                    "markdown": result.get("markdown", ""),
                                    "rows": result.get("rows", 0),
                                    "cols": result.get("cols", 0),
                                    "sheets": result.get("sheets", []),
                                    "truncated": result.get("truncated", False),
                                    "hint": _hint,
                                },
                            }
                        else:
                            return {"success": False, "tool": "table_ops", "error": "read_failed",
                                    "message": result.get("error", "读取失败")}
                    elif action == "write":
                        data = args.get("data", "")
                        if not data:
                            return {"success": False, "tool": "table_ops", "error": "缺少 data",
                                    "message": "write 模式需要 data（markdown 表格或 CSV）"}
                        result = table_mod.write_xlsx(file_path, data)
                        if result.get("ok"):
                            return {
                                "success": True,
                                "tool": "table_ops",
                                "data": {
                                    "name": result.get("name", filename),
                                    "rows": result.get("rows", 0),
                                    "cols": result.get("cols", 0),
                                    "hint": "已生成 %s（%d行×%d列）" % (result.get("name", filename), result.get("rows", 0), result.get("cols", 0)),
                                },
                            }
                        else:
                            return {"success": False, "tool": "table_ops", "error": "write_failed",
                                    "message": result.get("error", "写入失败")}
                    else:
                        return {"success": False, "tool": "table_ops", "error": "invalid_action",
                                "message": "action 只能是 read 或 write"}
                except ValueError as e:
                    return {"success": False, "tool": "table_ops", "error": "path_violation",
                            "message": str(e)[:120]}
                except Exception as e:
                    return {"success": False, "tool": "table_ops", "error": "table_failed",
                            "message": "操作失败: %s" % str(e)[:120]}

            elif tool_name == "deep_read":
                # P6: 深度阅读工具——读取文档并做结构化分析
                filename = args.get("filename", "")
                focus = args.get("focus", "")
                if not filename:
                    return {"success": False, "tool": "deep_read", "error": "缺少 filename"}

                # 读取工作区文件（走安全边界校验，与 read_workspace/table_ops 一致）
                from core.doc_session import safe_workspace_path
                try:
                    _file_path = safe_workspace_path(self.chat_id, filename)
                except ValueError as e:
                    return {"success": False, "tool": "deep_read", "error": "path_violation",
                            "message": str(e)[:120]}
                if not os.path.exists(_file_path):
                    return {"success": False, "tool": "deep_read", "error": "文件不存在: %s" % filename}

                try:
                    from pipelines.doc_action import read_document_text
                    _raw_text = read_document_text(_file_path)
                except Exception:
                    try:
                        with open(_file_path, 'r', encoding='utf-8', errors='ignore') as _f:
                            _raw_text = _f.read()
                    except Exception as e:
                        return {"success": False, "tool": "deep_read", "error": str(e)[:100]}

                if not _raw_text or len(_raw_text) < 50:
                    return {"success": False, "tool": "deep_read", "error": "文档内容为空或过短"}

                # 按章节/段落拆分
                import re
                _sections = re.split(r'\n#{1,3}\s|\n\n(?=[一二三四五六七八九十\d]+[、.．])', _raw_text)
                _sections = [s.strip() for s in _sections if s.strip() and len(s.strip()) > 20]

                # 构建结构化分析
                _analysis_parts = []
                _analysis_parts.append("【文档深度分析：%s】" % filename)
                _analysis_parts.append("文档总长：%d 字符，拆分为 %d 个章节/段落" % (len(_raw_text), len(_sections)))
                if focus:
                    _analysis_parts.append("分析重点：%s" % focus)
                _analysis_parts.append("")

                for _i, _sec in enumerate(_sections[:30]):  # 最多30段
                    _first_line = _sec.split('\n')[0][:60]
                    _analysis_parts.append("【第%d段】%s" % (_i + 1, _first_line))
                    _analysis_parts.append(_sec[:2000])  # 每段最多2000字
                    _analysis_parts.append("")

                _analysis = "\n".join(_analysis_parts)
                # 截断到最大长度
                if len(_analysis) > 15000:
                    _analysis = _analysis[:15000] + "\n\n[分析结果已截断，文档较长建议分段处理]"

                return {
                    "success": True,
                    "tool": "deep_read",
                    "data": {
                        "filename": filename,
                        "total_chars": len(_raw_text),
                        "sections": len(_sections),
                        "analysis": _analysis,
                    },
                    "message": "已完成对《%s》的深度分析：%d字，%d个章节" % (filename, len(_raw_text), len(_sections)),
                }

            elif tool_name == "set_doc_status":
                # Patch4 v3：模型标记某个 .md 文档为 completed → 读 .md + 生成 docx + 标记完成
                filename = args.get("filename", "")
                status = args.get("status", "")
                if not filename:
                    return {
                        "success": False,
                        "tool": "set_doc_status",
                        "error": "missing_filename",
                        "message": "缺少 filename 参数（workspace 里的 .md 文件名）",
                    }
                if status != "completed":
                    return {
                        "success": False,
                        "tool": "set_doc_status",
                        "error": "invalid_status",
                        "message": "status 目前只支持 'completed'",
                    }
                # 必须是 .md 或 .html 文件
                if not filename.endswith((".md", ".html")):
                    return {
                        "success": False,
                        "tool": "set_doc_status",
                        "error": "invalid_filename",
                        "message": "filename 必须是 .md（生成 docx）或 .html（生成可视化报告）文件",
                    }
                stats["docs"] += 1
                try:
                    from core.doc_session import (
                        read_workspace_file, mark_doc_completed, _docs_root,
                        _workspace_root,
                    )
                    # 1. 读 workspace/{filename}
                    try:
                        f = read_workspace_file(self.chat_id, filename)
                    except FileNotFoundError:
                        return {
                            "success": False,
                            "tool": "set_doc_status",
                            "error": "not_found",
                            "message": "workspace 里找不到文件: %s" % filename,
                        }
                    md_content = f["content"]

                    # P8-8: 交付前查错——.html 报告的 mermaid 图表先经模型校验/修复，
                    # 再打包推送下载（实测：xychart 语法错误导致用户下载到开天窗的报告）
                    _mermaid_fixed = 0
                    if filename.endswith(".html"):
                        md_content, _mermaid_fixed = self._review_mermaid_blocks(md_content)

                    # 2. 生成产物（输出到 workspace/，模型可见）
                    docs_dir = _workspace_root(self.chat_id)
                    os.makedirs(docs_dir, exist_ok=True)

                    if filename.endswith(".ppt.html"):
                        # PPT 演示文稿：内联 reveal.js + mermaid.js 自包含
                        from pipelines.doc_action import generate_ppt_html
                        out_filename = filename
                        out_path = os.path.join(docs_dir, out_filename)
                        title = _extract_md_title(md_content) or filename[:-9]
                        generate_ppt_html(md_content, out_path, title=title)
                    elif filename.endswith(".html"):
                        # HTML 可视化报告：内联 mermaid.js 自包含
                        from pipelines.doc_action import generate_html_report
                        out_filename = filename  # .html 直接用原名
                        out_path = os.path.join(docs_dir, out_filename)
                        title = _extract_md_title(md_content) or filename[:-5]
                        generate_html_report(md_content, out_path, title=title)
                    else:
                        # Word 文档：.md → .docx（pandoc）
                        from pipelines.doc_action import generate_docx
                        out_filename = filename[:-3] + ".docx"  # 去掉 .md 加 .docx
                        out_path = os.path.join(docs_dir, out_filename)
                        title = _extract_md_title(md_content) or filename[:-3]
                        generate_docx(md_content, out_path, title=title)
                    docx_filename = out_filename  # 保持原变量名兼容下游 doc_complete 派生

                    # 3. 标记完成
                    mark_doc_completed(self.chat_id, filename)

                    log.info("[AGENT] set_doc_status completed: file=%s → %s",
                             filename, out_filename)
                    _msg = None
                    if _mermaid_fixed:
                        _msg = "已生成可下载产物；交付前已自动校验并修复 %d 处图表语法" % _mermaid_fixed
                    return {
                        "success": True,
                        "tool": "set_doc_status",
                        "data": {
                            "filename": filename,
                            "status": "completed",
                            "docx_path": out_filename,
                            "title": title,
                            "mermaid_fixed": _mermaid_fixed,
                        },
                        **({"message": _msg} if _msg else {}),
                    }
                except Exception as e:
                    import logging as _log_mod
                    _log_mod.getLogger("agent_loop").error(
                        "[AGENT] set_doc_status 执行异常: %s (filename=%s, chat_id=%s)",
                        str(e)[:200], filename, self.chat_id, exc_info=True)
                    return {
                        "success": False,
                        "tool": "set_doc_status",
                        "error": "execution_error",
                        "message": "生成 docx 失败: %s" % str(e)[:100],
                    }

            elif tool_name == "spawn_reader":
                # M2：并行深读子任务——并发 fetch（继承 SSRF 防护与截断），
                # 按 question 关键词窗口截取相关片段汇总回填
                question = (args.get("question") or "").strip()
                urls = [u.strip() for u in (args.get("urls") or [])
                        if isinstance(u, str) and u.strip()][:5]
                if not question or not urls:
                    return {
                        "success": False, "tool": "spawn_reader",
                        "error": "bad_args",
                        "message": "需要 question（深读问题）和 urls（1-5 个网页）",
                    }
                from concurrent.futures import ThreadPoolExecutor

                def _read_one(u):
                    try:
                        r = self._execute_tool("fetch_url", {"url": u}, stats)
                        if not r.get("success"):
                            return {"url": u, "ok": False,
                                    "error": r.get("error", "failed"),
                                    "message": r.get("message", "")}
                        d = r.get("data", {})
                        return {"url": u, "ok": True,
                                "title": d.get("title", ""),
                                "chars": d.get("length", 0),
                                "excerpt": _keyword_excerpt(d.get("text", ""), question)}
                    except Exception as e:
                        return {"url": u, "ok": False, "error": "exception",
                                "message": str(e)[:120]}

                with ThreadPoolExecutor(max_workers=4) as _ex:
                    readers = list(_ex.map(_read_one, urls))
                ok_n = sum(1 for r in readers if r.get("ok"))
                stats["reader_batches"] = stats.get("reader_batches", 0) + 1
                return {
                    "success": ok_n > 0,
                    "tool": "spawn_reader",
                    "data": {
                        "question": question, "total": len(readers),
                        "ok_count": ok_n, "readers": readers,
                    },
                    "message": "深读 %d 篇，成功 %d 篇" % (len(readers), ok_n),
                }

            elif tool_name == "run_plan":
                # M2：PTC 调用计划——一批相互独立的信息获取类调用一次执行
                # （省 LLM 轮次；顺序执行，写操作/嵌套/超限步骤逐个跳过并说明）
                _PLAN_ALLOWED = {
                    "search_web", "fetch_url", "search_kb", "get_current_time",
                    "calculator", "read_workspace", "read_workspace_chunk",
                    "list_workspace", "list_docs", "deep_read",
                }
                steps = args.get("steps") or []
                if not isinstance(steps, list) or not steps:
                    return {
                        "success": False, "tool": "run_plan",
                        "error": "empty_plan",
                        "message": "steps 不能为空——给出 1-5 个相互独立的工具调用",
                    }
                results = []
                for i, step in enumerate(steps[:5]):
                    s_tool = (step or {}).get("tool", "")
                    s_args = (step or {}).get("args") or {}
                    if s_tool not in _PLAN_ALLOWED:
                        results.append({"tool": s_tool or "?", "ok": False,
                                        "error": "not_allowed",
                                        "message": "run_plan 只支持信息获取类工具，%s 不允许" % s_tool})
                        continue
                    try:
                        r = self._execute_tool(s_tool, s_args, stats)
                        ok = bool(r.get("success"))
                        item = {"tool": s_tool, "ok": ok}
                        if ok:
                            item["data"] = r.get("data", {})
                            if r.get("message"):
                                item["message"] = r["message"]
                        else:
                            item["error"] = r.get("error", "failed")
                            item["message"] = r.get("message", "")
                        results.append(item)
                    except Exception as e:
                        results.append({"tool": s_tool, "ok": False,
                                        "error": "exception", "message": str(e)[:120]})
                skipped = len(steps) - len(steps[:5])
                if skipped:
                    results.append({"tool": "-", "ok": False, "error": "over_limit",
                                    "message": "超出 5 步上限，%d 步未执行" % skipped})
                ok_count = sum(1 for r in results if r.get("ok"))
                stats["plan_calls"] = stats.get("plan_calls", 0) + 1
                return {
                    "success": ok_count > 0,
                    "tool": "run_plan",
                    "data": {
                        "note": args.get("note", ""),
                        "total": len(results), "ok_count": ok_count,
                        "results": results,
                    },
                    "message": "编排执行 %d 步，成功 %d 步" % (len(results), ok_count),
                }

            elif tool_name == "create_ppt":
                # 0.10.1 M1-E：真 PPT（LLM 逐页手写 SVG → 编译 native PPTX）
                # begin/page/build 三动作，实现在 core/ppt_compile.py
                from core import ppt_compile as _pptc
                action = args.get("action", "")
                if action == "begin":
                    r = _pptc.begin_deck(self.chat_id, args.get("title", ""))
                elif action == "page":
                    r = _pptc.add_page(self.chat_id, args.get("deck", ""),
                                       args.get("page"), args.get("svg", ""))
                elif action == "build":
                    r = _pptc.build_deck(self.chat_id, args.get("deck", ""),
                                         args.get("filename"))
                else:
                    return {
                        "success": False, "tool": "create_ppt",
                        "error": "bad_action",
                        "message": "action 必须是 begin/page/build 之一",
                    }
                if r.get("ok"):
                    stats["ppt_actions"] = stats.get("ppt_actions", 0) + 1
                    return {"success": True, "tool": "create_ppt", "data": r}
                return {
                    "success": False, "tool": "create_ppt",
                    "error": r.get("error", "ppt_error"),
                    "message": r.get("message", "create_ppt 执行失败"),
                    "data": r,
                }

            elif tool_name == "list_docs":
                # Patch4 v3：列出 workspace 里的 .md 文档 + completed 标记
                from core.doc_session import list_workspace_files, list_completed_docs
                try:
                    files = list_workspace_files(self.chat_id)
                    completed = list_completed_docs(self.chat_id)
                    md_docs = []
                    for f in files:
                        name = f.get("name", "")
                        if not name.endswith(".md"):
                            continue
                        md_docs.append({
                            "filename": name,
                            "size": f.get("size", 0),
                            "completed": name in completed,
                        })
                    return {
                        "success": True,
                        "tool": "list_docs",
                        "data": {
                            "docs": md_docs,
                            "count": len(md_docs),
                        },
                    }
                except Exception as e:
                    return self._workspace_error("list_docs", e)

            elif tool_name == "list_workspace":
                # Patch4 修复 1：列出 workspace 文件
                from core.doc_session import list_workspace_files
                try:
                    files = list_workspace_files(self.chat_id)
                    return {
                        "success": True,
                        "tool": "list_workspace",
                        "data": {
                            "files": files,
                            "count": len(files),
                        },
                    }
                except Exception as e:
                    return self._workspace_error("list_workspace", e)

            elif tool_name == "read_workspace":
                # Patch4 修复 1：读取 workspace 文件
                from core.doc_session import read_workspace_file
                path = args.get("path", "")
                try:
                    f = read_workspace_file(self.chat_id, path)
                    return {
                        "success": True,
                        "tool": "read_workspace",
                        "data": {
                            "name": f["name"],
                            "content": f["content"],
                            "size": f["size"],
                        },
                    }
                except ValueError as e:
                    # 路径越界
                    return {
                        "success": False,
                        "tool": "read_workspace",
                        "error": "path_violation",
                        "message": str(e)[:120],
                    }
                except FileNotFoundError as e:
                    return {
                        "success": False,
                        "tool": "read_workspace",
                        "error": "not_found",
                        "message": str(e)[:120],
                    }
                except Exception as e:
                    return self._workspace_error("read_workspace", e)

            elif tool_name == "read_workspace_chunk":
                # P7: 分段读取长文件（避免一次性读全文爆上下文）
                from core.doc_session import read_workspace_file
                path = args.get("path", "")
                offset = int(args.get("offset", 0))
                chunk_size = int(args.get("chunk_size", 3000))
                try:
                    f = read_workspace_file(self.chat_id, path)
                    full = f["content"]
                    total = len(full)
                    chunk = full[offset:offset + chunk_size]
                    has_more = (offset + chunk_size) < total
                    next_offset = offset + chunk_size if has_more else None
                    return {
                        "success": True,
                        "tool": "read_workspace_chunk",
                        "data": {
                            "name": f["name"],
                            "chunk": chunk,
                            "offset": offset,
                            "chunk_size": len(chunk),
                            "total_size": total,
                            "has_more": has_more,
                            "next_offset": next_offset,
                        },
                    }
                except ValueError as e:
                    return {
                        "success": False, "tool": "read_workspace_chunk",
                        "error": "path_violation", "message": str(e)[:120],
                    }
                except FileNotFoundError as e:
                    return {
                        "success": False, "tool": "read_workspace_chunk",
                        "error": "not_found", "message": str(e)[:120],
                    }
                except Exception as e:
                    return self._workspace_error("read_workspace_chunk", e)

            elif tool_name == "write_workspace":
                # Patch4 修复 1：写入 workspace 文件
                from core.doc_session import write_workspace_file
                path = args.get("path", "")
                content = args.get("content", "")
                try:
                    f = write_workspace_file(self.chat_id, path, content)
                    return {
                        "success": True,
                        "tool": "write_workspace",
                        "data": {
                            "name": f["name"],
                            "size": f["size"],
                        },
                    }
                except ValueError as e:
                    return {
                        "success": False,
                        "tool": "write_workspace",
                        "error": "path_violation",
                        "message": str(e)[:120],
                    }
                except Exception as e:
                    return self._workspace_error("write_workspace", e)

            elif tool_name == "delete_workspace":
                # Patch4 修复 1：删除 workspace 文件
                from core.doc_session import delete_workspace_file
                path = args.get("path", "")
                try:
                    f = delete_workspace_file(self.chat_id, path)
                    return {
                        "success": True,
                        "tool": "delete_workspace",
                        "data": {
                            "name": f["name"],
                            "deleted": True,
                        },
                    }
                except ValueError as e:
                    return {
                        "success": False,
                        "tool": "delete_workspace",
                        "error": "path_violation",
                        "message": str(e)[:120],
                    }
                except FileNotFoundError as e:
                    return {
                        "success": False,
                        "tool": "delete_workspace",
                        "error": "not_found",
                        "message": str(e)[:120],
                    }
                except Exception as e:
                    return self._workspace_error("delete_workspace", e)

            elif tool_name == "append_workspace":
                # Patch4 v3.1：追加内容到 workspace 文件（不覆盖）
                from core.doc_session import append_workspace_file
                path = args.get("path", "")
                content = args.get("content", "")
                try:
                    f = append_workspace_file(self.chat_id, path, content)
                    return {
                        "success": True,
                        "tool": "append_workspace",
                        "data": {
                            "name": f["name"],
                            "size": f["size"],
                            "appended": f["appended"],
                        },
                    }
                except ValueError as e:
                    return {
                        "success": False,
                        "tool": "append_workspace",
                        "error": "path_violation",
                        "message": str(e)[:120],
                    }
                except Exception as e:
                    return self._workspace_error("append_workspace", e)

            elif tool_name == "edit_workspace":
                # Patch4 v3.1：精准替换 workspace 文件内容
                from core.doc_session import edit_workspace_file
                path = args.get("path", "")
                old_text = args.get("old_text", "")
                new_text = args.get("new_text", "")
                try:
                    f = edit_workspace_file(self.chat_id, path, old_text, new_text)
                    return {
                        "success": True,
                        "tool": "edit_workspace",
                        "data": {
                            "name": f["name"],
                            "size": f["size"],
                            "replaced": f["replaced"],
                        },
                    }
                except ValueError as e:
                    err_msg = str(e)[:120]
                    return {
                        "success": False,
                        "tool": "edit_workspace",
                        "error": "not_found" if "未找到" in err_msg else "path_violation",
                        "message": err_msg,
                    }
                except Exception as e:
                    return self._workspace_error("edit_workspace", e)

            else:
                return {
                    "success": False,
                    "tool": tool_name,
                    "error": "unknown_tool",
                    "message": "未知工具: %s" % tool_name,
                }

        except Exception as e:
            err = str(e)[:200]
            err_lower = err.lower()
            log.error("[AGENT] 工具 %s 执行失败: %s", tool_name, err)

            # 友好错误翻译
            if "getaddrinfo" in err_lower or "enotfound" in err_lower:
                friendly = "网络连接失败，无法解析服务器地址。请检查网络连接。"
            elif "timed out" in err_lower or "timeout" in err_lower:
                friendly = "网络请求超时，请检查网络或稍后重试。"
            elif "connection" in err_lower and ("refused" in err_lower or "reset" in err_lower):
                friendly = "网络连接被拒绝或重置，请检查网络连接。"
            else:
                friendly = "工具执行失败: %s" % err[:80]

            return {
                "success": False,
                "tool": tool_name,
                "error": "execution_error",
                "message": friendly,
            }

    def _make_start_status(self, tool_name, args):
        """生成工具开始执行的状态事件"""
        from core.agent_tools import get_status_event
        if tool_name == "search_web":
            return get_status_event(tool_name, "start", query=args.get("query", ""))
        elif tool_name == "fetch_url":
            url = args.get("url", "")
            # 简化 URL 显示
            try:
                from urllib.parse import urlparse
                parsed = urlparse(url)
                display_url = parsed.netloc or url[:50]
            except Exception:
                display_url = url[:50]
            return get_status_event(tool_name, "start", url=display_url)
        elif tool_name == "search_kb":
            return get_status_event(tool_name, "start", query=args.get("query", ""))
        elif tool_name == "set_doc_status":
            return get_status_event(tool_name, "start",
                                    filename=args.get("filename", "")[:50],
                                    status=args.get("status", ""))
        elif tool_name == "list_docs":
            return get_status_event(tool_name, "start")
        elif tool_name in ("list_workspace", "read_workspace", "read_workspace_chunk", "write_workspace", "delete_workspace",
                           "append_workspace", "edit_workspace"):
            path = args.get("path", "")
            return get_status_event(tool_name, "start", path=path[:50] if path else "")
        elif tool_name == "get_current_time":
            return get_status_event(tool_name, "start")
        elif tool_name == "calculator":
            return get_status_event(tool_name, "start", expression=(args.get("expression", "") or "")[:60])
        elif tool_name == "format_convert":
            return get_status_event(tool_name, "start",
                                    source=(args.get("source", "") or "")[:50],
                                    target=(args.get("target", "") or "")[:50])
        elif tool_name == "table_ops":
            return get_status_event(tool_name, "start",
                                    action=args.get("action", ""),
                                    filename=(args.get("filename") or "")[:50])
        elif tool_name == "create_ppt":
            return get_status_event(tool_name, "start",
                                    action=args.get("action", ""),
                                    page=args.get("page") or 0,
                                    title=(args.get("title") or "")[:40])
        elif tool_name == "run_plan":
            _steps = args.get("steps") or []
            return get_status_event(tool_name, "start",
                                    count=len(_steps),
                                    detail="、".join((s or {}).get("tool", "?") for s in _steps[:5]))
        elif tool_name == "spawn_reader":
            return get_status_event(tool_name, "start",
                                    count=len(args.get("urls") or []),
                                    query=(args.get("question") or "")[:40])
        else:
            return {"status": "thinking"}

    def _make_done_status(self, tool_name, result, args=None):
        """生成工具执行完成的状态事件"""
        args = args or {}
        from core.agent_tools import get_status_event
        if not result.get("success"):
            # 把 result 里的具体错误原因透传给前端（之前一律显示"操作异常"）
            _reason = result.get("error") or result.get("message") or ""
            return {"status": "error", "tool": tool_name, "reason": _reason, "filename": args.get("filename") or args.get("path") or ""}

        data = result.get("data", {})
        if tool_name == "search_web":
            # P6 #4-a: 补传完整搜索结果列表(标题+url+摘要截断),供前端展开查看
            _raw_results = data.get("results", [])
            _results_for_ui = [{"title": r.get("title", "")[:80],
                                "url": r.get("url", ""),
                                "snippet": (r.get("snippet", "") or "")[:120]}
                               for r in _raw_results[:8]]  # 最多8条,每条摘要120字
            return get_status_event(tool_name, "done", count=data.get("count", 0),
                                    results=_results_for_ui)
        elif tool_name == "fetch_url":
            # P6 #4-b: 补传正文摘要(前200字),供前端展开查看(而非只显示标题)
            _text = data.get("text", "")
            _summary = _text[:200].replace("\n", " ").strip() if _text else ""
            return get_status_event(tool_name, "done", length=data.get("length", 0),
                                    title=data.get("title", ""),
                                    detail=data.get("title", ""),
                                    summary=_summary)
        elif tool_name == "search_kb":
            # P7: 带完整检索结果列表（来源标题+摘要），供前端展开查看
            _sources = data.get("sources", [])
            _detail = ""
            if _sources:
                _detail = "\n".join(["· " + (s.get("label", "?")[:40]) for s in _sources[:5]])
            _sources_for_ui = [{"title": s.get("label", "?")[:80],
                                "snippet": (s.get("snippet", "") or "")[:120]}
                               for s in _sources[:5]]
            return get_status_event(tool_name, "done", count=data.get("count", 0),
                                    detail=_detail, results=_sources_for_ui)
        elif tool_name == "set_doc_status":
            # Patch4 v3：携带 filename / docx_path（pipeline 据此派生 doc_complete 事件）
            return get_status_event(tool_name, "done",
                                    filename=data.get("filename", ""),
                                    docx_path=data.get("docx_path", ""),
                                    status=data.get("status", ""))
        elif tool_name == "list_docs":
            return get_status_event(tool_name, "done", count=data.get("count", 0))
        elif tool_name == "list_workspace":
            return get_status_event(tool_name, "done", count=data.get("count", 0))
        elif tool_name in ("read_workspace", "read_workspace_chunk", "delete_workspace"):
            return get_status_event(tool_name, "done", name=data.get("name", ""))
        elif tool_name == "write_workspace":
            # Patch4 v3：write_workspace done 带 size（字节）、words（字数）、lines（行数）
            _content = args.get("content", "") or ""
            _size = data.get("size", 0)
            _words = len(_content)
            _lines = _content.count("\n") + 1 if _content else 0
            _preview = _content[:200]
            return get_status_event(tool_name, "done",
                                    name=data.get("name", ""),
                                    size=_size,
                                    words=_words,
                                    lines=_lines,
                                    detail=_preview)
        elif tool_name == "append_workspace":
            # Patch4 v3.1：append done 带总 size + 本次追加字节数
            _words = len(args.get("content", "")) if args.get("content") else 0
            return get_status_event(tool_name, "done",
                                    name=data.get("name", ""),
                                    size=data.get("size", 0),
                                    appended=data.get("appended", 0),
                                    words=_words)
        elif tool_name == "edit_workspace":
            # Patch4 v3.1：edit done 带替换次数
            return get_status_event(tool_name, "done",
                                    name=data.get("name", ""),
                                    replaced=data.get("replaced", 0),
                                    size=data.get("size", 0))
        elif tool_name == "get_current_time":
            return get_status_event(tool_name, "done", datetime=data.get("datetime", ""))
        elif tool_name == "calculator":
            return get_status_event(tool_name, "done", expression=data.get("expression", ""),
                                    result=data.get("result", ""))
        elif tool_name == "format_convert":
            return get_status_event(tool_name, "done",
                                    source=data.get("source", ""),
                                    target=data.get("target", ""),
                                    chars=data.get("chars", 0))
        elif tool_name == "table_ops":
            return get_status_event(tool_name, "done",
                                    name=data.get("name", ""),
                                    rows=data.get("rows", 0),
                                    cols=data.get("cols", 0))
        elif tool_name == "create_ppt":
            # M1-E：page 完成带 deck/page（pipeline 据此派生 ppt_page 预览事件）；
            # build 完成带 pptx_name（pipeline 派生产物下载）。注意不透传 svg 正文
            _d = {"action": data.get("action") or args.get("action", ""),
                  "deck": data.get("deck", ""),
                  "page": data.get("page", 0),
                  "pages": data.get("pages") if isinstance(data.get("pages"), list) else data.get("pages", 0),
                  "pptx_name": data.get("pptx_name", ""),
                  "title": data.get("title", "")}
            return get_status_event(tool_name, "done", **_d)
        elif tool_name == "run_plan":
            return get_status_event(tool_name, "done",
                                    count=data.get("total", 0),
                                    ok_count=data.get("ok_count", 0),
                                    detail="、".join("%s%s" % (r.get("tool", "?"), "✓" if r.get("ok") else "✗")
                                                     for r in (data.get("results") or [])[:5]))
        elif tool_name == "spawn_reader":
            return get_status_event(tool_name, "done",
                                    count=data.get("total", 0),
                                    ok_count=data.get("ok_count", 0),
                                    query=(data.get("question") or "")[:40])
        else:
            return {"status": "done"}

    def _pure_chat(self, messages):
        """纯对话 fallback（无工具调用）"""
        for phase, content in self.cloud_engine.run_with_tools(messages, tools=None):
            if phase == "text":
                yield ("text", content)
            elif phase == "think_token":
                yield ("agent_think", {"content": content})
            elif phase == "think_start":
                pass
            elif phase == "think_end":
                yield ("agent_think", {"content": ""})
            elif phase == "error":
                # 透传结构化错误
                yield ("error", content)
                return
            elif phase == "raw":
                # 兼容旧格式
                yield ("error", {"user_msg": content, "error_type": "unknown", "detail": content})
                return

    def _should_compress(self, messages):
        """检查是否需要压缩工具历史"""
        total_chars = 0
        for m in messages:
            if m.get("role") == "tool":
                total_chars += len(m.get("content", ""))
        return total_chars > MAX_TOOL_HISTORY_CHARS

    def _compress_tool_history(self, messages):
        """压缩旧的工具历史：保留最近 2 轮，之前的替换为摘要"""
        tool_indices = [i for i, m in enumerate(messages) if m.get("role") == "tool"]

        if len(tool_indices) <= 4:
            return  # 最近 2 轮（每轮最多 2 个工具调用），不需要压缩

        # 保留最近 4 条 tool 消息，之前的压缩
        for idx in tool_indices[:-4]:
            original = messages[idx].get("content", "")
            try:
                data = json.loads(original)
                summary = self._summarize_tool_result(data)
            except Exception:
                summary = original[:100] + "..."

            messages[idx]["content"] = json.dumps({
                "success": True,
                "_compressed": True,
                "summary": summary,
            }, ensure_ascii=False)

        log.info("[AGENT] 压缩了 %d 条旧工具历史", len(tool_indices) - 4)

    @staticmethod
    def _summarize_tool_result(data):
        """将工具结果压缩为一行摘要"""
        tool = data.get("tool", "")
        if tool == "search_web":
            count = data.get("data", {}).get("count", 0)
            return "搜索了互联网，找到 %d 条结果" % count
        elif tool == "fetch_url":
            length = data.get("data", {}).get("length", 0)
            return "抓取了网页，获取 %d 字内容" % length
        elif tool == "search_kb":
            count = data.get("data", {}).get("count", 0)
            return "检索了知识库，找到 %d 篇文档" % count
        elif tool == "write_workspace":
            name = data.get("data", {}).get("name", "")
            return "写入了工作区文件: %s" % name
        elif tool == "read_workspace_chunk":
            data2 = data.get("data", {})
            return "分段读取了 %s（offset=%s，%d字符）" % (data2.get("name",""), data2.get("offset",""), data2.get("chunk_size",0))
        elif tool == "append_workspace":
            # Patch4 v3.1 BUG#1 修复
            name = data.get("data", {}).get("name", "")
            appended = data.get("data", {}).get("appended", 0)
            return "追加了 %s（+%d 字节）" % (name, appended)
        elif tool == "edit_workspace":
            # Patch4 v3.1 BUG#1 修复
            name = data.get("data", {}).get("name", "")
            replaced = data.get("data", {}).get("replaced", 0)
            return "编辑了 %s（替换 %d 处）" % (name, replaced)
        elif tool == "set_doc_status":
            fname = data.get("data", {}).get("filename", "")
            return "标记文档完成: %s" % fname
        elif tool == "summarize_history":
            return "历史已压缩 (%d 字摘要)" % data.get("data", {}).get("length", 0)
        else:
            return "工具 %s 已执行" % tool

    # ===== Patch5 G.一致性：summarize_history 实现 =====

    def _summarize_history(self, focus: str = "") -> str:
        """调用云端模型压缩历史消息。

        Args:
            focus: 模型可选传入的关注主题

        Returns:
            str: 压缩后的摘要文本。空字符串表示没有可压缩的历史。
        """
        if not self._history_snapshot:
            return ""

        # 拼装待压缩的历史文本（仅保留 user/assistant 的内容）
        lines = []
        for m in self._history_snapshot[-30:]:  # 最多取最近 30 条
            role = m.get("role", "")
            content = m.get("content", "")
            if not content or role not in ("user", "assistant"):
                continue
            tag = "用户" if role == "user" else "助手"
            # 截断过长内容（避免把整个文档原文塞进去）
            if len(content) > 800:
                content = content[:800] + "..."
            lines.append("%s：%s" % (tag, content))
        if not lines:
            return ""
        full_text = "\n".join(lines)

        # 构造压缩 prompt
        sys_prompt = (
            "你是对话历史压缩助手。请把以下多轮对话总结成简洁摘要，"
            "保留：用户意图、已确认的关键事实、未解决的问题。"
            "目标：让后续对话能基于此摘要继续，无需重读全部历史。"
        )
        if focus:
            sys_prompt += " 重点关注：%s。" % focus
        sys_prompt += " 输出 300-500 字的中文摘要，不要分点编号，自然段落即可。"

        messages = [
            {"role": "system", "content": sys_prompt},
            {"role": "user", "content": full_text},
        ]

        # 用 CloudEngine 单轮非流式调用
        summary_text = ""
        try:
            for phase, content in self.cloud_engine.run_with_tools(messages, tools=None):
                if phase == "text":
                    summary_text += content
                elif phase == "raw":
                    summary_text += content
                elif phase == "error":
                    log.warning("[AGENT] summarize_history 引擎错误: %s",
                                str(content)[:100])
                    return ""
        except Exception as e:
            log.warning("[AGENT] summarize_history 引擎异常: %s", str(e)[:100])
            return ""

        return summary_text.strip()
