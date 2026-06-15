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

import json
import time
import logging

log = logging.getLogger(__name__)

# ===== 常量 =====
MAX_ROUNDS = 10
MAX_TOOL_HISTORY_CHARS = 60000  # 工具历史最大字符数（约 40000 token）


class AgentLoop:
    """ReAct Agent 循环 — 在线模式专用"""

    def __init__(self, cloud_engine, search_engine, kb=None):
        """
        Args:
            cloud_engine: CloudEngine 实例
            search_engine: SearchEngine 实例
            kb: KB 管理器实例（可选）
        """
        self.cloud_engine = cloud_engine
        self.search_engine = search_engine
        self.kb = kb
        self._doc_sections = []  # 文档模式的章节收集器

    def get_doc_sections(self):
        """获取文档模式收集的章节列表"""
        return self._doc_sections

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

        self._doc_sections = []

        # ===== 读取 KB 权限配置 =====
        kb_permission = "full"
        try:
            from config import get as _cfg
            kb_permission = _cfg("kb_permission", "full")
        except Exception:
            pass

        # ===== 1. 动态组装工具 + system prompt =====
        tools, system_prompt = get_tools_and_prompt(
            mode=mode, kb=self.kb, template=template, kb_permission=kb_permission
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

        if not has_tools:
            # 无工具可用（不应该发生，在线模式有网），直接纯对话
            log.warning("[AGENT] 无工具可用，fallback 纯对话")
            yield from self._pure_chat(messages)
            return

        while rounds < MAX_ROUNDS:
            rounds += 1
            log.info("[AGENT] === 第 %d 轮 === tools=%d", rounds, len(messages))

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

                log.info("[AGENT] 工具调用: %s(%s)", tool_name, args_str[:100])

                # 发送开始状态
                status_data = self._make_start_status(tool_name, args)
                yield ("agent_status", status_data)

                # 执行工具
                result = self._execute_tool(tool_name, args, stats)

                # 发送完成状态
                done_status = self._make_done_status(tool_name, result)
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

        # ===== 5. 轮次用完 =====
        if rounds >= MAX_ROUNDS:
            log.warning("[AGENT] 达到最大轮次 %d", MAX_ROUNDS)
            yield ("agent_status", {"status": "budget_exceeded"})

        # ===== 6. 发送统计摘要 =====
        elapsed = int(time.time() - stats["start_time"])
        yield ("agent_summary", {
            "searches": stats["searches"],
            "fetches": stats["fetches"],
            "kb_hits": stats["kb_hits"],
            "docs": stats["docs"],
            "elapsed": elapsed,
        })

        log.info("[AGENT] 完成: %d轮, searches=%d, fetches=%d, kb=%d, docs=%d, %.1fs",
                 rounds, stats["searches"], stats["fetches"],
                 stats["kb_hits"], stats["docs"], elapsed)

    def _build_messages(self, message, system_prompt, history, context_cache):
        """构建 OpenAI 格式的 messages 数组"""
        messages = [{"role": "system", "content": system_prompt}]

        # 添加上下文缓存
        if context_cache:
            messages[0]["content"] += "\n\n[上下文摘要]\n" + context_cache

        # 添加历史（只保留 user/assistant 角色，过滤 tool 消息保持简洁）
        if history:
            for item in history[-20:]:  # 最多 20 条历史
                role = item.get("role", "")
                content = item.get("content", "")
                if role in ("user", "assistant") and content:
                    messages.append({"role": role, "content": content})

        # 当前用户消息
        messages.append({"role": "user", "content": message})

        return messages

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
                # 使用 KB 的 get_context 方法
                kb_context, kb_sources = self.kb.get_context(query, max_chars=4000)
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

            elif tool_name == "write_section":
                heading = args.get("heading", "")
                content = args.get("content", "")
                self._doc_sections.append({
                    "heading": heading,
                    "content": content,
                })
                stats["docs"] += 1
                return {
                    "success": True,
                    "tool": "write_section",
                    "data": {
                        "heading": heading,
                        "length": len(content),
                        "total_sections": len(self._doc_sections),
                    },
                }

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
        elif tool_name == "write_section":
            return get_status_event(tool_name, "start")
        else:
            return {"status": "thinking"}

    def _make_done_status(self, tool_name, result):
        """生成工具执行完成的状态事件"""
        from core.agent_tools import get_status_event
        if not result.get("success"):
            return {"status": "error", "tool": tool_name}

        data = result.get("data", {})
        if tool_name == "search_web":
            return get_status_event(tool_name, "done", count=data.get("count", 0))
        elif tool_name == "fetch_url":
            return get_status_event(tool_name, "done", length=data.get("length", 0))
        elif tool_name == "search_kb":
            return get_status_event(tool_name, "done", count=data.get("count", 0))
        elif tool_name == "write_section":
            return get_status_event(tool_name, "done",
                                    count=data.get("total_sections", 0))
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
        elif tool == "write_section":
            heading = data.get("data", {}).get("heading", "")
            return "写了章节: %s" % heading
        else:
            return "工具 %s 已执行" % tool
