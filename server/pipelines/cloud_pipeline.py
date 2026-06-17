# -*- coding: utf-8 -*-
"""
pipelines/cloud_pipeline.py — 云端 SSE 管道（Agent Loop 版）

重构后流程：
  1. 云端上下文 >75% 自动压缩
  2. action_router 解析 /xx 指令
  3. KB 检索（仅本地模式的 KB action 走这里，在线模式由 Agent 自主决定）
  4. 本地模式 doc action 分支（本地模式保留原逻辑）
  5. 在线模式：AgentLoop.run() — ReAct 循环
  6. 保存对话
"""

import os
import json
import time
import logging
from typing import Generator

log = logging.getLogger(__name__)


def run_cloud_pipeline(ctx) -> Generator[str, None, None]:
    """云端 SSE 管道 — Agent Loop 版

    Args:
        ctx: StreamContext 数据类（来自 _base.py）

    Yields:
        str — SSE 事件字符串 'data: {...}\n\n'
    """
    from pipelines._base import sse_event

    # 从上下文提取参数
    mgr = ctx.mgr
    kb = ctx.kb
    message = ctx.message
    chat_file = ctx.chat_file
    history_raw = ctx.history_raw or []
    action_mode = ctx.action_mode or "chat"
    context_cache = ctx.context_cache
    model_choice = ctx.model_choice
    prompt = ctx.prompt or message
    model_history = ctx.llm_history

    from config import get as _cfg_get

    # ====== 初始化状态变量 ======
    raw_text = ""
    think_content = ""
    response_text = ""
    think_folded = False
    saved_task_type = ""
    _saved = False
    _doc_outline_only = False
    _token_stats = None  # token 统计数据

    t0 = time.time()

    # 判断在线/本地模式
    _ai_mode = getattr(ctx, 'ai_mode', 'cloud')

    # 外层 try/finally：保护中途停止时的保存
    try:
        try:
            # ====== 步骤 1: 云端上下文 >75% 自动压缩 ======
            try:
                from routers.chat import _calc_context_usage, _compress_cloud_history
                ctx_usage = _calc_context_usage(chat_file)
                ctx_pct = ctx_usage["percentage"]

                if ctx_pct > 75:
                    log.info("[CLOUD] 云端上下文 >75%% (%.1f%%)，开始自动压缩", ctx_pct)
                    yield sse_event("compress", {
                        "phase": "preparing",
                        "before": ctx_pct,
                    })
                    try:
                        compressed = _compress_cloud_history(mgr, history_raw, chat_file)
                        if compressed:
                            after_pct = _calc_context_usage(chat_file)["percentage"]
                            yield sse_event("compress", {
                                "phase": "done",
                                "before": ctx_pct,
                                "after": after_pct,
                            })
                    except Exception as comp_err:
                        log.warning("[CLOUD] 云端压缩失败: %s", str(comp_err)[:100])
            except Exception as ctx_err:
                log.warning("[CLOUD] 上下文检测失败: %s", str(ctx_err)[:80])

            # ====== 步骤 2: action_router 解析 /xx 指令 ======
            from intelligence.action_router import resolve_action
            action_result = resolve_action(prompt, current_action=action_mode)
            action_mode = action_result["action"]
            if action_result["clean_message"] != prompt:
                prompt = action_result["clean_message"]
            if action_result["slash_hint"]:
                yield sse_event("slash_hint", {
                    "message": action_result["slash_hint"],
                })

            # ====== 路由：在线模式 vs 本地模式 ======
            _doc_mode = (action_mode == "doc")

            # ====== KB action 已移除（Patch3），防御性 fallback ======
            if action_mode == "kb":
                log.warning("[CLOUD] action_mode=kb 已废弃，降级为 chat")
                action_mode = "chat"

            # ====== Research action 已废弃，降级为 chat ======
            if action_mode == "research":
                log.warning("[CLOUD] action_mode=research 已废弃（由 AgentLoop 替代），降级为 chat")
                action_mode = "chat"

            # ====== 在线模式：Agent Loop ======
            if _ai_mode == "cloud":
                yield from _run_agent_loop(
                    ctx, message, prompt, model_history, model_choice,
                    chat_file, history_raw, context_cache, action_mode, mgr, kb,
                    t0=t0,
                    # 收集输出的变量（通过 dict 引用传递）
                    _collect={
                        "raw_text": "", "think_content": "", "response_text": "",
                        "think_folded": False, "saved_task_type": "",
                    }
                )
                # _run_agent_loop 内部已处理保存和 done 事件
                _saved = True
                return

            # ====== 本地模式 Doc Action 分支 ======
            if _doc_mode and _ai_mode != "cloud":
                from pipelines.doc_action import run_doc_action
                doc_continue_text = getattr(ctx, 'doc_continue', '') or ""
                _kb_doc_content = ""
                file_path = ctx.file_path
                if file_path:
                    kb_doc_ref = kb.get_document(file_path)
                    if kb_doc_ref and kb_doc_ref.status == "ready":
                        _doc_texts = []
                        for chunk in kb.chunks.values():
                            if chunk.doc_id == file_path and chunk.text:
                                _doc_texts.append(chunk.text)
                        if _doc_texts:
                            from files.file_extractor import calc_file_budget, smart_extract
                            _full_text = "\n\n".join(_doc_texts)
                            _hist_chars = sum(
                                len(m.get("content", "")) for m in history_raw
                            ) if history_raw else 0
                            _budget = calc_file_budget(_hist_chars)
                            if len(_full_text) > _budget:
                                _full_text = smart_extract(_full_text, message or "", _budget)
                            _kb_doc_content = _full_text

                for phase, content in run_doc_action(
                    message=message, mgr=mgr, model_name=model_choice,
                    max_tokens=ctx.max_tokens, history=model_history,
                    kb=kb, context_cache=context_cache, drift_hint="",
                    strategy_enhancement="", doc_continue=doc_continue_text,
                    kb_doc_content=_kb_doc_content,
                ):
                    if phase == "mode_hint":
                        yield sse_event("mode_hint", {"message": content})
                    elif phase == "doc_outline":
                        _doc_outline_only = True
                        yield sse_event("doc_outline", {"outline": content})
                        break
                    elif phase == "task_type":
                        tt, conf = content
                        saved_task_type = tt
                        yield sse_event("task_type", {"task_type": tt, "confidence": conf})
                    elif phase == "raw":
                        raw_text += content
                        yield sse_event("token", {"content": content})
                    elif phase == "fold":
                        think_content = content
                        think_folded = True
                        yield sse_event("fold", {"think_len": len(think_content)})
                    elif phase == "text":
                        response_text += content
                        yield sse_event("token", {"content": content})
                    elif phase == "reload":
                        yield sse_event("model_reload", {"model": content})

            # ====== CloudEngine 直出（非 doc/research 的本地模式 KB 等）======
            elif not _doc_mode:
                log.info("[CLOUD] >> chat_stream model=%s", model_choice)
                try:
                    if not hasattr(mgr, '_cloud_engine'):
                        from core.cloud_engine import CloudEngine
                        mgr._cloud_engine = CloudEngine(mgr)
                    cloud_engine = mgr._cloud_engine
                except Exception as e:
                    yield sse_event("error", {"content": "云端引擎不可用: %s" % str(e)[:100]})
                    yield 'data: [DONE]\n\n'
                    _saved = True
                    return

                for phase, content in cloud_engine.run(
                    prompt, history=model_history, context_cache=context_cache,
                ):
                    if phase == "task_type":
                        tt, conf = content
                        saved_task_type = tt
                        yield sse_event("task_type", {"task_type": tt, "confidence": conf})
                    elif phase == "mode_hint":
                        yield sse_event("mode_hint", {"message": content})
                    elif phase == "error":
                        # 结构化错误（新版 CloudEngine）
                        if isinstance(content, dict):
                            yield sse_event("error", {
                                "content": content.get("user_msg", "未知错误"),
                                "error_type": content.get("error_type", "unknown"),
                                "detail": content.get("detail", ""),
                            })
                        else:
                            yield sse_event("error", {"content": str(content)})
                    elif phase == "raw":
                        # 兼容旧的 raw 格式
                        raw_text += content
                        yield sse_event("token", {"content": content})
                    elif phase == "think_start":
                        think_folded = False
                        yield sse_event("think_start", {})
                    elif phase == "think_token":
                        think_content += content
                        yield sse_event("think_token", {"content": content})
                    elif phase == "think_end":
                        think_folded = True
                        yield sse_event("think_end", {"think_len": len(think_content)})
                    elif phase == "fold":
                        think_content = content
                        think_folded = True
                        yield sse_event("fold", {"think_len": len(think_content)})
                    elif phase == "text":
                        response_text += content
                        yield sse_event("token", {"content": content})
                    elif phase == "token_stats":
                        _token_stats = content

        except Exception as e:
            yield sse_event("error", {
                "content": "⚠️ 处理过程中出错，请重试。",
                "error_type": "pipeline_error",
                "detail": str(e)[:200],
            })
            yield sse_event("done", {
                "model": model_choice,
                "chars": 0,
                "think_chars": 0,
                "time": time.time() - t0,
                "speed": 0,
                "task_type": "error",
            })
            yield 'data: [DONE]\n\n'
            _saved = True
            return

        # ====== 步骤 6: 保存对话（非 Agent Loop 路径）======
        if not _saved:
            yield from _save_and_done(
                ctx, response_text, raw_text, think_content, think_folded,
                saved_task_type, _doc_mode, _doc_outline_only, t0,
                message, chat_file, history_raw, model_choice, context_cache, mgr,
                token_stats=_token_stats,
            )
            _saved = True

    finally:
        # 中途停止时保存已接收内容
        if not _saved and (response_text or raw_text or think_content):
            try:
                from session.context_cache import (
                    clean_think_content_wrapped as _clean_think_final,
                )
                from session.chat_store import save_chat as _save_chat_final
                from pipelines._base import _sanitize_output as _sanitize_final

                actual = response_text or raw_text
                actual = mgr.strip_think(actual)
                actual = _sanitize_final(actual)
                _clean_think_text = (
                    _clean_think_final(think_content)
                    if think_content and len(think_content.strip()) >= 20
                    else ""
                )
                if (actual.strip() or _clean_think_text) and not actual.strip().startswith("[ERROR]"):
                    _elapsed = time.time() - t0
                    _ts = time.strftime("%H:%M:%S")
                    save_msgs = history_raw + [
                        {"role": "user", "content": message, "ts": _ts},
                        {"role": "assistant",
                         "content": actual or "[思考已中断]",
                         "ts": time.strftime("%H:%M:%S"),
                         "think": _clean_think_text,
                         "model": model_choice,
                         "chars": len(actual),
                         "time": _elapsed,
                         "task_type": saved_task_type or "text"},
                    ]
                    _save_chat_final(chat_file, save_msgs)
                    log.info("[SAVE] 中途停止，已保存 %d 字 + think %d 字",
                             len(actual), len(_clean_think_text))
            except Exception as e:
                log.warning("[SAVE] 中途保存失败: %s" % str(e)[:100])


def _run_agent_loop(ctx, message, prompt, model_history, model_choice,
                    chat_file, history_raw, context_cache, action_mode,
                    mgr, kb, t0, _collect):
    """在线模式 Agent Loop 入口 — yield SSE 事件

    内部处理：AgentLoop → SSE 事件转换 → 保存 → done
    """
    from pipelines._base import sse_event

    # 获取 CloudEngine
    try:
        if not hasattr(mgr, '_cloud_engine'):
            from core.cloud_engine import CloudEngine
            mgr._cloud_engine = CloudEngine(mgr)
        cloud_engine = mgr._cloud_engine
    except Exception as e:
        yield sse_event("error", {"content": "云端引擎不可用: %s" % str(e)[:100]})
        yield 'data: [DONE]\n\n'
        return

    # 获取 SearchEngine
    try:
        from core.search_engine import SearchEngine
        search_engine = SearchEngine()
    except Exception as e:
        yield sse_event("error", {"content": "搜索引擎不可用: %s" % str(e)[:100]})
        yield 'data: [DONE]\n\n'
        return

    # 创建并运行 AgentLoop
    from core.agent_loop import AgentLoop
    # Patch4 修复 1：从 chat_file 推导 chat_id（用于 workspace + 文档状态化）
    _chat_id = ""
    if chat_file:
        from core.doc_session import chat_id_from_path
        _chat_id = chat_id_from_path(chat_file)
    agent = AgentLoop(cloud_engine, search_engine, kb=kb, chat_id=_chat_id)

    # 决定模式
    agent_mode = "doc" if action_mode == "doc" else "chat"

    # 解析模板（doc 模式 + 有上传文件时）
    template = None
    if agent_mode == "doc" and hasattr(ctx, 'file_path') and ctx.file_path:
        try:
            from core.template_parser import parse_template
            template = parse_template(ctx.file_path)
            if template.get("status") != "ok":
                log.warning("[CLOUD-AGENT] 模板解析失败: %s", template.get("error", ""))
                template = None
            else:
                log.info("[CLOUD-AGENT] 模板加载: %s, %d 章节",
                         template.get("title", "")[:30], template.get("total_sections", 0))
        except Exception as e:
            log.warning("[CLOUD-AGENT] 模板解析异常: %s", str(e)[:100])
            template = None

    full_text = ""
    think_text = ""
    think_len = 0
    agent_summary = None
    _agent_timeline_buf = []  # Patch4 v3.1 BUG#7：收集 agent_status 用于持久化到 messages.json

    # Patch4 v3：UI 状态机 + 进度可视化（精简版）
    # 不再有 doc_started / section_done / docx 兜底生成。
    # doc_complete 事件由 set_doc_status 工具执行后派生（status=="doc_status_done" 时）。
    # 关键状态串（来自 agent_tools.TOOL_REGISTRY 的 status_map）：
    #   set_doc_status:  doc_status_updating → doc_status_done（completed → 派生 doc_complete）
    #   list_docs:       docs_listing → docs_listed
    _doc_complete_sent = False
    _pipeline_start_ts = t0  # 用于 elapsed_ms 计算
    _STATUS_DONE_SUFFIXES = ("_done", "_listed", "_deleted", "_read_done", "_write_done")

    def _status_phase(s):
        """从 status 字符串推断 phase（start/done）"""
        if not s:
            return "start"
        # 已知的 "完成" 状态
        if s in ("doc_status_done", "workspace_listed", "workspace_read_done",
                 "workspace_write_done", "workspace_deleted",
                 "workspace_appended", "workspace_edited",
                 "docs_listed"):
            return "done"
        # thinking 是 start 类
        if s in ("thinking", "searching", "fetching", "kb_searching",
                 "doc_status_updating", "workspace_listing",
                 "workspace_reading", "workspace_writing", "workspace_deleting",
                 "workspace_appending", "workspace_editing",
                 "docs_listing"):
            return "start"
        # 后缀匹配
        if any(s.endswith(suffix) for suffix in _STATUS_DONE_SUFFIXES):
            return "done"
        # 其它像 search_done / fetch_done / kb_done / budget_exceeded / error 等
        if s.endswith("_done") or s in ("budget_exceeded", "tool_limited"):
            return "done"
        return "start"

    try:
        for phase, content in agent.run(
            message=message,
            mode=agent_mode,
            history=model_history,
            context_cache=context_cache,
            template=template,
        ):
            if phase == "text":
                full_text += content
                yield sse_event("token", {"content": content})

            elif phase == "agent_think":
                # Agent 推理思考
                token = content.get("content", "")
                if token == "":
                    # 开始/结束标记，跳过
                    pass
                else:
                    think_text += token
                    think_len = len(think_text)

            elif phase == "agent_status":
                # Patch4 v3：在 status=="doc_status_done" 时派生 doc_complete 事件
                # （set_doc_status 工具执行后触发，docx 已由 agent_loop 生成）
                status_val = content.get("status", "") if isinstance(content, dict) else ""
                now_ts = int(time.time() * 1000)
                elapsed_ms = now_ts - int(_pipeline_start_ts * 1000)

                if isinstance(content, dict):
                    # 派生 doc_complete：set_doc_status completed 完成
                    if status_val == "doc_status_done" and not _doc_complete_sent:
                        doc_st = content.get("status", "")
                        # agent_loop 的 _make_done_status 会带 filename / docx_path / status
                        _filename = content.get("filename", "")
                        _docx_path = content.get("docx_path", "")
                        _doc_st = doc_st or "completed"
                        if _doc_st == "completed" and _filename and _docx_path:
                            _doc_complete_sent = True
                            # 拼 doc_url（与 routers/files.py 的下载路由对齐）
                            _docx_basename = _docx_path
                            # 去掉路径前缀和 .docx 扩展名，作为 download 路由的 key
                            if "/" in _docx_basename:
                                _docx_basename = _docx_basename.rsplit("/", 1)[-1]
                            _doc_key = _docx_basename[:-5] if _docx_basename.endswith(".docx") else _docx_basename
                            _doc_url = "/api/chat/%s/doc/%s/download" % (_chat_id, _doc_key)
                            yield sse_event("doc_complete", {
                                "filename": _docx_path,
                                "doc_url": _doc_url,
                                "md_filename": _filename,
                                "total_time": max(0.0, time.time() - _pipeline_start_ts),
                                "ts": now_ts,
                            })

                    # 给转发出去的 agent_status 追加 phase / ts / elapsed_ms
                    enriched = dict(content)
                    enriched.setdefault("phase", _status_phase(status_val))
                    enriched.setdefault("ts", now_ts)
                    if enriched.get("phase") == "done":
                        enriched.setdefault("elapsed_ms", elapsed_ms)
                    # Patch4 v3.1 BUG#7：收集 done 状态到 timeline 缓冲（用于持久化到 messages.json）
                    if enriched.get("phase") == "done" and status_val not in ("thinking",):
                        _agent_timeline_buf.append({
                            "status": status_val,
                            "name": enriched.get("name") or enriched.get("filename") or "",
                            "query": enriched.get("query") or "",
                            "url": enriched.get("url") or "",
                            "count": enriched.get("count") or 0,
                            "length": enriched.get("length") or 0,
                            "elapsed_ms": enriched.get("elapsed_ms") or 0,
                            "ts": now_ts,
                        })
                    yield sse_event("agent_status", enriched)
                else:
                    yield sse_event("agent_status", content)

            elif phase == "agent_summary":
                # 统计摘要
                agent_summary = content
                yield sse_event("agent_summary", content)

            elif phase == "task_type":
                tt, conf = content
                _collect["saved_task_type"] = tt
                yield sse_event("task_type", {"task_type": tt, "confidence": conf})

            elif phase == "error":
                # 结构化错误：{"user_msg", "error_type", "detail"}
                if isinstance(content, dict):
                    yield sse_event("error", {
                        "content": content.get("user_msg", "未知错误"),
                        "error_type": content.get("error_type", "unknown"),
                        "detail": content.get("detail", ""),
                    })
                else:
                    yield sse_event("error", {"content": str(content)})
                # 关键：error 后必须发 done + [DONE]，否则前端永远卡在 loading
                yield sse_event("done", {
                    "model": model_choice,
                    "chars": 0,
                    "think_chars": 0,
                    "time": time.time() - t0,
                    "speed": 0,
                    "task_type": "error",
                })
                yield 'data: [DONE]\n\n'
                return

            elif phase == "token_stats":
                _collect["token_stats"] = content

    except Exception as e:
        log.error("[CLOUD-AGENT] Agent Loop 异常: %s", str(e)[:200])
        # FC fallback：将已有文本作为正常回复
        if not full_text:
            yield sse_event("error", {
                "content": "⚠️ Agent 调用异常，请稍后重试。",
                "error_type": "agent_error",
                "detail": str(e)[:100],
            })
            # 必须发 done 事件，否则前端永远卡在 loading
            yield sse_event("done", {
                "model": model_choice,
                "chars": 0,
                "think_chars": 0,
                "time": time.time() - t0,
                "speed": 0,
                "task_type": "error",
            })
            yield 'data: [DONE]\n\n'
            return

    # Patch4 v3：不再在 pipeline 末尾生成 docx。
    # docx 由 agent_loop 的 set_doc_status 工具执行分支生成，
    # doc_complete 事件由 set_doc_status 完成时派生（见上面 agent_status 处理）。
    doc_url = None
    doc_filename = None

    # ====== 保存对话 ======
    elapsed = time.time() - ctx.__dict__.get('_t0', time.time())
    # 重新计算 elapsed（用模块级 t0）
    # 由于 _run_agent_loop 不直接有 t0，我们用 time.time() 近似
    _elapsed = time.time() - (ctx.__dict__.get('_pipeline_t0') or time.time())

    response_chars = len(full_text)
    think_chars = think_len
    speed = (response_chars + think_chars) / max(_elapsed, 0.001) if (response_chars + think_chars) > 0 else 0

    # 空回复保护
    if not full_text.strip():
        full_text = "抱歉，Agent 未能生成有效回复，请重试。"
        response_chars = len(full_text)

    saved_task_type = _collect.get("saved_task_type", "agent")

    from session.context_cache import (
        clean_think_content_wrapped as _clean_think,
        update_session_cache,
    )
    from session.chat_store import save_chat
    from pipelines._base import _sanitize_output

    final_response = _sanitize_output(full_text)
    response_chars = len(final_response)

    is_error_response = final_response.strip().startswith("[ERROR]")
    new_cache = None
    messages = None

    if final_response.strip() and not is_error_response:
        ts = time.strftime("%H:%M:%S")
        assistant_msg = {
            "role": "assistant",
            "content": final_response,
            "ts": time.strftime("%H:%M:%S"),
            "think": (_clean_think(think_text) if think_len >= 20 else ""),
            "model": model_choice,
            "chars": response_chars,
            "think_chars": think_chars,
            "time": _elapsed,
            "speed": speed,
            "task_type": saved_task_type,
            "action_mode": action_mode,
        }
        if agent_summary:
            assistant_msg["agent_summary"] = agent_summary
        # Patch4 v3.1 BUG#7：保存工具调用时间线到 messages.json（刷新页面后历史可见）
        if _agent_timeline_buf:
            assistant_msg["agent_timeline"] = _agent_timeline_buf
        if _collect.get("token_stats"):
            assistant_msg["token_stats"] = _collect["token_stats"]
        if doc_url:
            assistant_msg["doc_url"] = doc_url
            assistant_msg["doc_filename"] = doc_filename

        messages = history_raw + [
            {"role": "user", "content": message, "ts": ts},
            assistant_msg,
        ]
        new_cache, did_compress = update_session_cache(chat_file, messages, model_choice)
        if did_compress:
            yield sse_event("compress", {"msg": "正在压缩旧对话..."})
        save_chat(chat_file, messages, context_cache=new_cache)

    # done 事件
    done_payload = {
        "model": model_choice,
        "chars": response_chars,
        "think_chars": think_chars,
        "time": _elapsed,
        "speed": speed,
        "task_type": saved_task_type,
    }
    if _collect.get("token_stats"):
        done_payload["token_stats"] = _collect["token_stats"]
    yield sse_event("done", done_payload)
    log.info("[CLOUD-AGENT] === 完成 === model=%s type=%s chars=%d think=%d %.1fs",
             model_choice, saved_task_type, response_chars, think_chars, _elapsed)
    yield 'data: [DONE]\n\n'


def _save_and_done(ctx, response_text, raw_text, think_content, think_folded,
                   saved_task_type, _doc_mode, _doc_outline_only, t0,
                   message, chat_file, history_raw, model_choice, context_cache, mgr,
                   token_stats=None):
    """保存对话并发射 done 事件（非 Agent Loop 路径）"""
    from pipelines._base import sse_event, _sanitize_output
    from session.context_cache import (
        clean_think_content_wrapped as _clean_think,
        update_session_cache,
    )
    from session.chat_store import save_chat

    elapsed = time.time() - t0
    final_response = response_text or raw_text
    final_response = mgr.strip_think(final_response)
    final_response = _sanitize_output(final_response)

    response_chars = len(final_response)
    think_chars = len(think_content.strip()) if (think_folded and think_content) else 0
    speed = (response_chars + think_chars) / elapsed if elapsed > 0 and (response_chars + think_chars) > 0 else 0

    if not final_response.strip():
        final_response = "抱歉，我暂时无法回答这个问题，请稍后再试。"
        response_chars = len(final_response)
        yield sse_event("truncate", {"content": final_response})

    is_error_response = final_response.strip().startswith("[ERROR]")
    messages = None
    new_cache = None
    if final_response.strip() and not is_error_response:
        ts = time.strftime("%H:%M:%S")
        messages = history_raw + [
            {"role": "user", "content": message, "ts": ts},
            {"role": "assistant",
             "content": final_response,
             "ts": time.strftime("%H:%M:%S"),
             "think": (_clean_think(think_content) if think_folded and len(think_content.strip()) >= 20 else ""),
             "model": model_choice,
             "chars": response_chars, "think_chars": think_chars,
             "time": elapsed, "speed": speed,
             "task_type": saved_task_type,
             "token_stats": token_stats},
        ]
        new_cache, did_compress = update_session_cache(chat_file, messages, model_choice)
        if did_compress:
            yield sse_event("compress", {"msg": "正在压缩旧对话..."})
        save_chat(chat_file, messages, context_cache=new_cache)
    else:
        ts = time.strftime("%H:%M:%S")
        save_messages = history_raw + [
            {"role": "user", "content": message, "ts": ts},
        ]
        if is_error_response:
            save_messages.append({
                "role": "assistant", "content": "[生成失败，已保留用户消息]",
                "ts": time.strftime("%H:%M:%S"), "model": model_choice,
                "chars": 0, "time": elapsed, "task_type": saved_task_type,
            })
        save_chat(chat_file, save_messages)

    # 文档模式 docx 生成（fallback 分支：非 AgentLoop 的旧路径）
    if _doc_mode and not _doc_outline_only and final_response.strip():
        try:
            from pipelines.doc_action import generate_docx
            doc_filename = "doc_%s.docx" % time.strftime("%Y%m%d_%H%M%S")
            # Patch4：优先跟 chat 走
            _fb_chat_id = _chat_id or ""
            if _fb_chat_id:
                from core.doc_session import _docs_root
                _fb_docs_dir = _docs_root(_fb_chat_id)
                os.makedirs(_fb_docs_dir, exist_ok=True)
                doc_path = os.path.join(_fb_docs_dir, doc_filename)
                download_url = "/api/chat/%s/doc/%s/download" % (_fb_chat_id, doc_filename[:-5])
            else:
                from config import DOCS_DIR
                doc_path = os.path.join(DOCS_DIR, doc_filename)
                download_url = "/api/doc/download/%s" % doc_filename
            generate_docx(final_response, doc_path,
                          title=message[:50] if message else "文档")
            yield sse_event("doc_ready", {
                "url": download_url,
                "filename": doc_filename,
            })
            log.info("[CLOUD] DOC 生成完成: %s", doc_filename)
            if messages:
                messages[-1]["doc_url"] = download_url
                messages[-1]["doc_filename"] = doc_filename
                save_chat(chat_file, messages, context_cache=new_cache)
        except Exception as e:
            log.error("[CLOUD] DOC 生成失败: %s", str(e)[:100])
            yield sse_event("doc_error", {"message": "文档生成失败: %s" % str(e)[:80]})

    # done 事件
    done_payload = {
        "model": model_choice,
        "chars": response_chars,
        "think_chars": think_chars,
        "time": elapsed,
        "speed": speed,
        "task_type": saved_task_type,
    }
    if token_stats:
        done_payload["token_stats"] = token_stats
    yield sse_event("done", done_payload)
    log.info("[CLOUD] === 完成 === model=%s type=%s chars=%d think=%d %.1fs",
             model_choice, saved_task_type, response_chars, think_chars, elapsed)
    yield 'data: [DONE]\n\n'
