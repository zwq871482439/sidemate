# -*- coding: utf-8 -*-
"""
pipelines/compare_pipeline.py — 云端AI知识对比管道（Patch 3 轨道B）

核心流程：
  Step0: Reformulation（Round 2+ 有历史时，仅服务本地列）
  Step1: 并行 — 本地（KB检索+LLM总结）+ 云端（CloudEngine多轮对话）
    → 双线程各自实时通过 Queue 推送 SSE token 事件
    → 主线程从 Queue 读取并立即 yield（真正实时流式）
  Step2: 融合 — 本地模型综合两路信息，实时流式输出
  SSE 多通道输出：local / cloud / merge + progress 进度步骤

设计要点：
  - SSE 事件包含 channel 字段（local/cloud/merge/progress）
  - 双线记忆：memory_local=融合结果F, memory_cloud=云端回答C
  - 错误处理：任何一列出错时另一列继续
  - 超时：本地60s，云端30s
  - 双线程实时流式：两个线程各自通过 Queue 实时推送 token
  - 云端列：独立多轮对话（原始question + memory_cloud完整历史拼接）
"""

import os
import json
import time
import logging
import threading
import queue
from typing import Generator
from concurrent.futures import ThreadPoolExecutor, wait, ALL_COMPLETED

log = logging.getLogger(__name__)


def _sse_channel_event(channel: str, event_type: str, data: dict = None) -> str:
    """构造带 channel 的 SSE 事件字符串"""
    payload = {"type": event_type, "channel": channel}
    if data:
        payload.update(data)
    return 'data: %s\n\n' % json.dumps(payload, ensure_ascii=False)


def _sse_progress(step_id: str, status: str) -> str:
    """构造进度步骤事件"""
    return _sse_channel_event("progress", "step", {"step": step_id, "status": status})


def _run_local_column(ctx, query: str, q: queue.Queue, local_model: str = None, kb_history: list = None):
    """本地列：KB检索 + LLM总结，实时推送 SSE token 到队列

    队列事件格式：
      ("token", content_str) — 正文 token
      ("sources", sources_list) — 来源信息
      ("mode_hint", message_str) — 模式提示
      ("step", step_name) — 步骤变化: "searching", "organizing", "generating"
      ("step_done", step_name) — 步骤完成: "search", "organize", "generate"
      ("error", error_str) — 错误
      ("done", None) — 列完成
    """
    mgr = ctx.mgr
    kb = ctx.kb
    if not local_model:
        local_model = mgr._get_default_llm() or "qwen"

    try:
        # 阶段开始
        q.put(("phase_started", None))

        # 步骤0: Reformulation（在本地线程内做，不阻塞云端）
        if kb_history:
            try:
                # 告诉前端正在补全追问
                q.put(("step", "reformulating"))
                from core.reformulate import reformulate_query
                reformulated = reformulate_query(query, kb_history, mgr)
                if reformulated and reformulated != query:
                    log.info("[COMPARE-LOCAL] Reformulated: '%s' -> '%s'", query[:30], reformulated[:30])
                    query = reformulated
            except Exception as e:
                log.warning("[COMPARE-LOCAL] Reformulate failed: %s", str(e)[:60])

        # 步骤1: 检索文库
        q.put(("step", "searching"))
        budget = mgr.calc_kb_context_budget()
        safe_chars = budget["safe_chars"]
        # Patch4 v3.1：对比模式默认用 local 参数（KB 主要服务本地管线）
        kb_context, kb_sources = kb.get_context(query, max_chars=safe_chars, ai_mode='local',
                                                  actor="local", access_type="agent_read")

        if not kb_context:
            q.put(("step_done", "search"))
            q.put(("mode_hint", "文库中未找到与问题相关的内容"))
            q.put(("done", None))
            return

        q.put(("step_done", "search"))
        q.put(("sources", kb_sources))

        # 步骤2: 整理结果
        q.put(("step", "organizing"))
        from prompts import KB_USER_PROMPT_TEMPLATE
        kb_prompt = KB_USER_PROMPT_TEMPLATE.format(context=kb_context, question=query)
        q.put(("step_done", "organize"))

        # 步骤3: 生成回答 — 逐 token 推送（强制本地 StreamEngine）
        q.put(("step", "generating"))
        log.info("[COMPARE-LOCAL] 开始LLM生成: model=%s, prompt_len=%d", local_model, len(kb_prompt))
        try:
            # 强制使用本地 StreamEngine（本地列始终用本地模型，不走 CloudEngine）
            se = mgr._stream_engine
            # 动态预留：KB 模式预留 1500
            _kb_reserved = mgr.calc_output_reservation(kb_mode=True, history_chars=0)
            for phase, content in se.run(
                kb_prompt,
                model=local_model,
                max_tokens=_kb_reserved,
                history=None,
                context_cache=None,
                override_task_type="text",
                kb_mode=True,
            ):
                if phase in ("text", "raw") and content:
                    q.put(("token", content))
                elif phase == "error":
                    log.warning("[COMPARE-LOCAL] stream error phase: %s", str(content)[:100])
        except Exception as stream_err:
            log.warning("[COMPARE-LOCAL] stream 异常: %s", str(stream_err)[:100])

        q.put(("step_done", "generate"))
        log.info("[COMPARE-LOCAL] LLM生成完成")

    except Exception as e:
        log.warning("[COMPARE-LOCAL] 本地列出错: %s", str(e)[:100])
        q.put(("error", str(e)[:100]))

    q.put(("done", None))


def _run_cloud_column(ctx, question: str, cloud_history: list, q: queue.Queue):
    """云端列：CloudEngine 独立多轮对话，实时推送 SSE token 到队列

    队列事件格式：
      ("token", content_str) — 正文 token
      ("status", status_name) — 状态变化: "understanding", "thinking", "generating"
      ("error", error_str) — 错误
      ("done", None) — 列完成
    """
    mgr = ctx.mgr

    try:
        # 阶段开始
        q.put(("phase_started", None))

        if not hasattr(mgr, '_cloud_engine'):
            from core.cloud_engine import CloudEngine
            mgr._cloud_engine = CloudEngine(mgr)
        cloud_engine = mgr._cloud_engine

        # 状态1: 正在理解问题（虚假等待，等第一个有效数据）
        q.put(("status", "understanding"))

        for phase, content in cloud_engine.run(
            question,
            history=cloud_history,
            context_cache=None,
            override_task_type="text",
            _skip_queue=True,  # 云端API不占本地GPU队列，与本地列并行不阻塞
            _cloud_kb_mode=True,  # KB 对比模式：用大模型专用 prompt
        ):
            if phase == "task_type":
                # 任务分类完成，仍处于理解阶段
                pass
            elif phase == "think_start":
                # 收到推理开始 → 状态2: 正在思考
                q.put(("status", "thinking"))
            elif phase == "think_token":
                # 推理 token，忽略（不展示云端思考内容）
                pass
            elif phase == "think_end":
                # 推理结束，即将开始正文
                q.put(("status", "generating"))
            elif phase == "text" and content:
                # 首个 text token → 状态3: 生成中（如果还没切换）
                q.put(("status", "generating"))
                q.put(("token", content))
            elif phase == "error":
                if isinstance(content, dict):
                    q.put(("error", content.get("user_msg", "云端请求失败")))
                else:
                    q.put(("error", str(content)[:100]))
                break
            elif phase == "raw" and isinstance(content, str) and content.startswith("[ERROR]"):
                q.put(("error", content))
                break

    except Exception as e:
        log.warning("[COMPARE-CLOUD] 云端列出错: %s", str(e)[:100])
        q.put(("error", str(e)[:100]))

    q.put(("done", None))


def _build_cloud_history(kb_history: list) -> list:
    """从双线记忆的 kb_history 中提取云端列的对话历史

    kb_history 中的 assistant 消息带有 memory_cloud 字段，
    提取这些构建 cloud 专用的多轮历史。

    返回格式: [{"role":"user","content":"Q1"}, {"role":"assistant","content":"A1_cloud"}, ...]
    """
    cloud_hist = []
    for msg in kb_history:
        role = msg.get("role", "")
        if role == "user":
            cloud_hist.append({"role": "user", "content": msg.get("content", "")})
        elif role == "assistant":
            # 优先用 memory_cloud，fallback 到 content
            cloud_content = msg.get("memory_cloud", "") or msg.get("content", "")
            if cloud_content:
                cloud_hist.append({"role": "assistant", "content": cloud_content})
    return cloud_hist


def run_compare_pipeline(ctx) -> Generator[str, None, None]:
    """云端AI知识对比管道 — 实时双线程流式

    Args:
        ctx: StreamContext 数据类（来自 _base.py）

    Yields:
        str — SSE 事件字符串
    """
    from pipelines._base import sse_event

    mgr = ctx.mgr
    kb = ctx.kb
    message = ctx.message
    chat_file = ctx.chat_file
    history_raw = ctx.history_raw or []
    action_mode = ctx.action_mode or "chat"
    model_choice = ctx.model_choice

    from config import get as _cfg_get

    t0 = time.time()
    _saved = False

    # 本地列/融合必须用本地默认 LLM，不能传云端模型名
    local_model = mgr._get_default_llm() or "qwen"

    # KB 会话数据（从 routers/kb.py 的 _kb_sessions 读取/写入）
    body = ctx.body or {}
    session_id = body.get("kb_session_id", "default")
    try:
        from routers.kb import _kb_sessions, _kb_sessions_lock, _KB_SESSION_MAX_TURNS
    except ImportError:
        _kb_sessions = {}
        _kb_sessions_lock = threading.Lock()
        _KB_SESSION_MAX_TURNS = 4

    kb_history = _kb_sessions.get(session_id, [])

    # ====== 准备云端列的历史 ======
    cloud_history = _build_cloud_history(kb_history)
    # 云端列用原始 question，不走 Reformulation

    # ====== Step1: 并行实时流式 — 本地+云端 ======
    # Reformulation 移入本地列线程，云端列立即开始
    # 用 Queue 接收两个线程的实时 token
    local_queue = queue.Queue()
    cloud_queue = queue.Queue()

    local_answer_parts = []
    cloud_answer_parts = []
    local_sources = []
    local_done = False
    cloud_done = False
    local_error = None
    cloud_error = None
    _local_done_t = 0   # 本地列完成时刻（用于算各自耗时，供前端统计展示）
    _cloud_done_t = 0   # 云端列完成时刻

    with ThreadPoolExecutor(max_workers=2) as executor:
        local_future = executor.submit(_run_local_column, ctx, message, local_queue, local_model, kb_history)
        cloud_future = executor.submit(_run_cloud_column, ctx, message, cloud_history, cloud_queue)

        # 主循环：交替从两个队列读取事件，实时 yield
        while not (local_done and cloud_done):
            # 读取本地列事件（非阻塞，最多读 10 个）
            if not local_done:
                for _ in range(10):
                    try:
                        evt_type, evt_data = local_queue.get_nowait()
                    except queue.Empty:
                        break

                    if evt_type == "token":
                        local_answer_parts.append(evt_data)
                        yield _sse_channel_event("local", "stream", {"content": evt_data})
                    elif evt_type == "step":
                        yield _sse_channel_event("local", "step", {"step": evt_data})
                    elif evt_type == "step_done":
                        yield _sse_channel_event("local", "step_done", {"step": evt_data})
                    elif evt_type == "sources":
                        local_sources = evt_data
                        yield _sse_channel_event("local", "sources", {
                            "sources": [
                                {"label": s.get("source_label", "?"),
                                 "snippet": s.get("text_snippet", "")[:100]}
                                for s in evt_data[:5]
                            ]
                        })
                    elif evt_type == "mode_hint":
                        yield _sse_channel_event("local", "mode_hint", {
                            "message": evt_data
                        })
                    elif evt_type == "error":
                        local_error = evt_data
                    elif evt_type == "phase_started":
                        yield _sse_channel_event("local", "phase", {"phase": "started"})
                    elif evt_type == "done":
                        local_done = True
                        _local_done_t = time.time()
                        break

            # 读取云端列事件（非阻塞，最多读 10 个）
            if not cloud_done:
                for _ in range(10):
                    try:
                        evt_type, evt_data = cloud_queue.get_nowait()
                    except queue.Empty:
                        break

                    if evt_type == "token":
                        cloud_answer_parts.append(evt_data)
                        yield _sse_channel_event("cloud", "stream", {"content": evt_data})
                    elif evt_type == "status":
                        yield _sse_channel_event("cloud", "status", {"status": evt_data})
                    elif evt_type == "error":
                        cloud_error = evt_data
                    elif evt_type == "phase_started":
                        yield _sse_channel_event("cloud", "phase", {"phase": "started"})
                    elif evt_type == "done":
                        cloud_done = True
                        _cloud_done_t = time.time()
                        break

            # 如果两列都没数据且都没完成，短暂等待避免空转
            if not local_done and not cloud_done:
                time.sleep(0.02)  # 20ms

        # 收尾：确保队列中的剩余事件被读取
        for _ in range(100):
            try:
                evt_type, evt_data = local_queue.get_nowait()
                if evt_type == "token":
                    local_answer_parts.append(evt_data)
                    yield _sse_channel_event("local", "stream", {"content": evt_data})
                elif evt_type == "step":
                    yield _sse_channel_event("local", "step", {"step": evt_data})
                elif evt_type == "step_done":
                    yield _sse_channel_event("local", "step_done", {"step": evt_data})
                elif evt_type == "error":
                    local_error = evt_data
            except queue.Empty:
                break

        for _ in range(100):
            try:
                evt_type, evt_data = cloud_queue.get_nowait()
                if evt_type == "token":
                    cloud_answer_parts.append(evt_data)
                    yield _sse_channel_event("cloud", "stream", {"content": evt_data})
                elif evt_type == "status":
                    yield _sse_channel_event("cloud", "status", {"status": evt_data})
                elif evt_type == "error":
                    cloud_error = evt_data
            except queue.Empty:
                break

    # 本地列完成事件
    local_answer = "".join(local_answer_parts).strip()
    if local_error and not local_answer:
        yield _sse_channel_event("local", "stream", {
            "content": "暂时不可用（%s）" % local_error[:50]
        })
    elif not local_answer:
        yield _sse_channel_event("local", "stream", {
            "content": "文库中未找到相关内容"
        })
    yield _sse_channel_event("local", "phase", {"phase": "done"})
    yield _sse_progress("local", "done")

    # 云端列完成事件
    cloud_answer = "".join(cloud_answer_parts).strip()
    if cloud_error and not cloud_answer:
        yield _sse_channel_event("cloud", "stream", {
            "content": "暂时不可用（%s）" % cloud_error[:50]
        })
    elif not cloud_answer:
        yield _sse_channel_event("cloud", "stream", {
            "content": "云端未返回结果"
        })
    yield _sse_channel_event("cloud", "phase", {"phase": "done"})
    yield _sse_progress("cloud", "done")

    # ====== Step2: 融合 — 实时流式 ======
    yield _sse_progress("merge", "doing")
    yield _sse_channel_event("merge", "phase", {"phase": "started"})

    merge_text = ""
    local_has = bool(local_answer.strip())
    cloud_has = bool(cloud_answer.strip())

    if local_has and cloud_has:
        # 两列都有结果 → 完整融合，实时流式输出 + 同时收集文本
        try:
            from prompts import MERGE_FUSION_PROMPT
            merge_prompt = MERGE_FUSION_PROMPT.format(
                local_answer=local_answer,
                cloud_answer=cloud_answer,
            )

            merge_parts = []
            # 强制使用本地 StreamEngine（融合始终用本地模型安全处理）
            se = mgr._stream_engine
            # 融合列非 KB，预留 2048
            _merge_reserved = mgr.calc_output_reservation(kb_mode=False, history_chars=0)
            for phase, content in se.run(
                merge_prompt,
                model=local_model,
                max_tokens=_merge_reserved,
                history=None,
                context_cache=None,
                override_task_type="text",
                kb_mode=False,
            ):
                if phase in ("text", "raw") and content:
                    merge_parts.append(content)
                    yield _sse_channel_event("merge", "stream", {"content": content})

            merge_text = "".join(merge_parts).strip()

        except Exception as e:
            log.warning("[COMPARE-MERGE] 融合失败: %s", str(e)[:100])
            merge_text = "融合分析暂时不可用"
    elif not local_has and cloud_has:
        # 本地无 + 云端有 → 直接展示云端 + 提示
        merge_text = cloud_answer
        yield _sse_channel_event("merge", "mode_hint", {
            "message": "文库无匹配，以上为云端AI参考回答"
        })
    elif local_has and not cloud_has:
        # 本地有 + 云端无
        merge_text = local_answer
        yield _sse_channel_event("merge", "mode_hint", {
            "message": "云端暂不可用，展示本地知识库结果"
        })
    else:
        merge_text = "两个来源均未返回有效结果"

    yield _sse_progress("merge", "done")
    yield _sse_channel_event("merge", "phase", {"phase": "done"})

    # ====== 双线记忆更新 + 磁盘持久化 ======
    # 先保存 round 文件（answer + merge_result）
    try:
        from routers.kb import _kb_save_round, _kb_get_next_round, _kb_load_rounds, _kb_rounds_to_history
        round_num = _kb_get_next_round(session_id)
        _kb_save_round(session_id, round_num,
                       question=message,
                       answer=local_answer or "（无本地回答）",
                       merge_result=merge_text)
    except Exception as e:
        log.warning("[COMPARE] 保存 round 文件失败: %s", str(e)[:80])

    # 更新内存 history（从 round 重建，确保 answer+merge 双注入格式）
    with _kb_sessions_lock:
        try:
            from routers.kb import _kb_load_rounds, _kb_rounds_to_history
            updated_rounds = _kb_load_rounds(session_id)
            kb_history_new = _kb_rounds_to_history(updated_rounds)
            _kb_sessions[session_id] = kb_history_new
        except Exception as e:
            log.warning("[COMPARE] 重建 history 失败: %s", str(e)[:80])
            # 回退到旧逻辑
            kb_history.append({"role": "user", "content": message})
            content = "【本地回答】" + (local_answer or "") + "\n【综合分析】" + (merge_text or "")
            kb_history.append({"role": "assistant", "content": content,
                               "memory_local": merge_text, "memory_cloud": cloud_answer})
            _kb_sessions[session_id] = kb_history

    # ====== 保存对话 ======
    elapsed = time.time() - t0
    final_response = merge_text or local_answer or cloud_answer or "无有效回答"

    try:
        from session.chat_store import save_chat
        ts = time.strftime("%H:%M:%S")
        messages = history_raw + [
            {"role": "user", "content": message, "ts": ts},
            {"role": "assistant",
             "content": final_response,
             "ts": time.strftime("%H:%M:%S"),
             "model": model_choice,
             "chars": len(final_response),
             "time": elapsed,
             "task_type": "kb_compare"},
        ]
        save_chat(chat_file, messages)
        _saved = True
    except Exception as e:
        log.warning("[COMPARE] 保存对话失败: %s", str(e)[:80])

    # done 事件
    # 补本地/云端各自统计(chars + 耗时)，与 parallel_pipeline 对齐，
    # 供前端 footer 显示双列统计（修 #知识对比footer无云端统计）。
    _local_elapsed = int(((_local_done_t or time.time()) - t0) * 1000)
    _cloud_elapsed = int(((_cloud_done_t or time.time()) - t0) * 1000)
    yield sse_event("done", {
        "model": model_choice,
        "chars": len(final_response),
        "think_chars": 0,
        "time": elapsed,
        "speed": len(final_response) / elapsed if elapsed > 0 else 0,
        "task_type": "kb_compare",
        "local_stats": {"chars": len(local_answer), "elapsed_ms": _local_elapsed},
        "cloud_stats": {"chars": len(cloud_answer), "elapsed_ms": _cloud_elapsed},
    })
    log.info("[COMPARE] === 完成 === model=%s chars=%d %.1fs",
             model_choice, len(final_response), elapsed)
    yield 'data: [DONE]\n\n'
