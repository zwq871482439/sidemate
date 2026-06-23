# -*- coding: utf-8 -*-
"""
pipelines/parallel_pipeline.py — 并行模式管道（P6）

核心流程：
  Step1: 并行 — 本地（KB检索+LLM总结）+ 云端（CloudEngine多轮对话）
    → 双线程各自实时通过 Queue 推送 SSE token 事件
    → 主线程从 Queue 读取并立即 yield（真正实时流式）
  Step2: 融合 — 本地模型综合两路信息，实时流式输出
  SSE 多通道输出：local / cloud / merge + agent_timeline 进度事件

与 compare_pipeline 的区别：
  - 使用 Chat Tab 的 history_raw（memory_local / memory_cloud 字段）管理历史
  - 不使用 _kb_sessions
  - 本地列注入 memory_local 历史（不再 hardcode history=None）
  - 支持 parallel_options.allow_cloud_keywords 云端关键词提取
  - 发射 AgentTimeline SSE 事件供前端渲染

设计要点：
  - SSE 事件包含 channel 字段（local/cloud/merge/progress）
  - 双线记忆：memory_local=本地原始回答摘要(≤200字), memory_cloud=云端原始回答C
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
from typing import Generator, List
from concurrent.futures import ThreadPoolExecutor

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


def _build_local_history(history_raw: list) -> list:
    """从 Chat Tab 的 history_raw 中提取本地列的对话历史

    history_raw 中的 assistant 消息带有 memory_local 字段，
    提取这些构建本地列专用的多轮历史。

    返回格式: [{"role":"user","content":"Q1"}, {"role":"assistant","content":"A1_local"}, ...]
    """
    local_hist = []
    for msg in (history_raw or []):
        role = msg.get("role", "")
        if role == "user":
            local_hist.append({"role": "user", "content": msg.get("content", "")})
        elif role == "assistant":
            # 优先用 memory_local，fallback 到 content
            local_content = msg.get("memory_local", "") or msg.get("content", "")
            if local_content:
                local_hist.append({"role": "assistant", "content": local_content})
    return local_hist


def _build_cloud_history(history_raw: list) -> list:
    """从 Chat Tab 的 history_raw 中提取云端列的对话历史

    history_raw 中的 assistant 消息带有 memory_cloud 字段，
    提取这些构建 cloud 专用的多轮历史。

    返回格式: [{"role":"user","content":"Q1"}, {"role":"assistant","content":"A1_cloud"}, ...]
    """
    cloud_hist = []
    for msg in (history_raw or []):
        role = msg.get("role", "")
        if role == "user":
            cloud_hist.append({"role": "user", "content": msg.get("content", "")})
        elif role == "assistant":
            # 优先用 memory_cloud，fallback 到 content
            cloud_content = msg.get("memory_cloud", "") or msg.get("content", "")
            if cloud_content:
                cloud_hist.append({"role": "assistant", "content": cloud_content})
    return cloud_hist


def _summarize_local_answer(local_answer: str, user_msg: str, mgr, max_chars: int = 300) -> str:
    """把本地列原始回答摘要化（≤300字），用于存入 memory_local。

    背景：8K 窗口下，本地原始回答全文（1500-3000字）撑不过 1-2 轮。决策（澄清1方案d）：
    下一轮本地列看"自己原始回答的摘要"，不看全文，也不看融合结果（保持双线隔离 +
    本地独立性）。摘要只用于下一轮上下文注入，不影响展示用的 content（融合结果）。

    实现：包装 offline_compress_with_model，把 [user_msg, local_answer] 喂进去做摘要。
    该函数 prompt 写"不超过200字"，比 max_chars 更保守，更省 token，符合"摘要"语义。

    Args:
        local_answer: 本地列原始回答全文
        user_msg: 当轮用户提问（让模型有上下文，否则不知摘要对象）
        mgr: ModelManager 实例
        max_chars: 截断兜底的上限（摘要失败时用）

    Returns:
        str — 摘要文本。任何失败都 fallback 到截断 local_answer[:max_chars]，保证总有输出。
    """
    if not local_answer or len(local_answer) <= max_chars:
        return local_answer or ""
    try:
        from common.context_compressor import offline_compress_with_model
        messages = [
            {"role": "user", "content": user_msg},
            {"role": "assistant", "content": local_answer},
        ]
        summary = offline_compress_with_model(messages, model_manager=mgr)
        if summary and len(summary) >= 10:
            return summary
        # 模型输出太短或失败，fallback 截断
        return local_answer[:max_chars]
    except Exception as e:
        log.warning("[PARALLEL] memory_local 摘要失败, fallback 截断: %s", str(e)[:80])
        return local_answer[:max_chars]


def _run_local_column(ctx, query: str, q: queue.Queue, local_model: str = None, local_history: list = None):
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
        # 步骤0: Reformulation（在本地线程内做，不阻塞云端）
        if local_history:
            try:
                q.put(("step", "reformulating"))
                from core.reformulate import reformulate_query
                reformulated = reformulate_query(query, local_history, mgr)
                if reformulated and reformulated != query:
                    log.info("[PARALLEL-LOCAL] Reformulated: '%s' -> '%s'", query[:30], reformulated[:30])
                    query = reformulated
            except Exception as e:
                log.warning("[PARALLEL-LOCAL] Reformulate failed: %s", str(e)[:60])

        # 步骤1: 检索文库
        q.put(("step", "searching"))
        budget = mgr.calc_kb_context_budget()
        safe_chars = budget["safe_chars"]
        kb_context, kb_sources = kb.get_context(query, max_chars=safe_chars, ai_mode='local')

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
        log.info("[PARALLEL-LOCAL] 开始LLM生成: model=%s, prompt_len=%d, history_len=%d",
                 local_model, len(kb_prompt), len(local_history or []))
        try:
            se = mgr._stream_engine
            # 动态预留替代固定 MAX_OUTPUT_TOKENS：本地列是 KB 模式，预留 1500 释放空间给历史
            _hist_chars = sum(len(m.get("content", "")) for m in (local_history or []))
            _local_reserved = mgr.calc_output_reservation(kb_mode=True, history_chars=_hist_chars)
            for phase, content in se.run(
                kb_prompt,
                model=local_model,
                max_tokens=_local_reserved,
                history=local_history,  # P6: 注入 memory_local 历史（不再 hardcode None）
                context_cache=None,
                override_task_type="text",
                kb_mode=True,
            ):
                if phase in ("text", "raw") and content:
                    q.put(("token", content))
                elif phase == "error":
                    log.warning("[PARALLEL-LOCAL] stream error phase: %s", str(content)[:100])
        except Exception as stream_err:
            log.warning("[PARALLEL-LOCAL] stream 异常: %s", str(stream_err)[:100])

        q.put(("step_done", "generate"))
        log.info("[PARALLEL-LOCAL] LLM生成完成")

    except Exception as e:
        log.warning("[PARALLEL-LOCAL] 本地列出错: %s", str(e)[:100])
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
        if not hasattr(mgr, '_cloud_engine'):
            from core.cloud_engine import CloudEngine
            mgr._cloud_engine = CloudEngine(mgr)
        cloud_engine = mgr._cloud_engine

        # 状态1: 正在理解问题
        q.put(("status", "understanding"))

        for phase, content in cloud_engine.run(
            question,
            history=cloud_history,
            context_cache=None,
            override_task_type="text",
            _skip_queue=True,
            _cloud_kb_mode=True,
        ):
            if phase == "task_type":
                pass
            elif phase == "think_start":
                q.put(("status", "thinking"))
            elif phase == "think_token":
                pass
            elif phase == "think_end":
                q.put(("status", "generating"))
            elif phase == "text" and content:
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
        log.warning("[PARALLEL-CLOUD] 云端列出错: %s", str(e)[:100])
        q.put(("error", str(e)[:100]))

    q.put(("done", None))


def _extract_cloud_keywords(ctx, question: str) -> str:
    """云端关键词提取（非流式，只取输出）

    当 parallel_options.allow_cloud_keywords 开启时，
    调用云端 API 将问题拆解为 3-5 个关键词，用于增强本地 KB 检索。
    返回关键词字符串，失败时返回原始 question。
    """
    mgr = ctx.mgr
    try:
        if not hasattr(mgr, '_cloud_engine'):
            from core.cloud_engine import CloudEngine
            mgr._cloud_engine = CloudEngine(mgr)
        cloud_engine = mgr._cloud_engine

        keyword_prompt = (
            "将以下问题拆解为3-5个独立关键词，用逗号分隔，不要解释：\n\n"
            "问题：%s\n\n关键词：" % question
        )

        keywords_parts = []
        for phase, content in cloud_engine.run(
            keyword_prompt,
            history=[],
            context_cache=None,
            override_task_type="text",
            _skip_queue=True,
            _cloud_kb_mode=False,
        ):
            if phase == "text" and content:
                keywords_parts.append(content)
            elif phase == "error":
                log.warning("[PARALLEL-KW] 关键词提取失败，使用原始问题")
                return question

        keywords = "".join(keywords_parts).strip()
        if keywords and len(keywords) > 2:
            log.info("[PARALLEL-KW] 云端关键词: '%s' -> '%s'", question[:30], keywords[:60])
            return keywords
        return question
    except Exception as e:
        log.warning("[PARALLEL-KW] 关键词提取异常: %s", str(e)[:80])
        return question


def run_parallel_pipeline(ctx) -> Generator[str, None, None]:
    """并行模式管道 — 实时双线程流式

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

    # P6: 读取 parallel_options
    parallel_options = getattr(ctx, 'parallel_options', None) or {}
    allow_cloud_keywords = parallel_options.get("allow_cloud_keywords", False)

    from config import get as _cfg_get

    t0 = time.time()
    _saved = False

    # 本地列/融合必须用本地默认 LLM
    local_model = mgr._get_default_llm() or "qwen"

    # ====== 准备双线历史 ======
    local_history = _build_local_history(history_raw)
    cloud_history = _build_cloud_history(history_raw)

    log.info("[PARALLEL] local_history=%d rounds, cloud_history=%d rounds",
             len(local_history), len(cloud_history))

    # ====== 云端关键词提取（如果开关开启）======
    local_query = message
    if allow_cloud_keywords:
        log.info("[PARALLEL] 云端关键词提取已启用")
        local_query = _extract_cloud_keywords(ctx, message)

    # ====== Step1: 并行实时流式 — 本地+云端 ======
    local_queue = queue.Queue()
    cloud_queue = queue.Queue()

    local_answer_parts = []
    cloud_answer_parts = []
    local_sources = []
    local_done = False
    cloud_done = False
    local_error = None
    cloud_error = None

    # AgentTimeline 步骤计时（阶段2重构：6 个计时变量 → 4 个 Step 对象）
    # group 标记并发：retrieve/local_gen/cloud_gen = phase_1 并发，merge = phase_2 串行
    from core.step_model import Step, StepOutput, step_to_sse, step_output_to_sse, steps_to_timeline
    step_retrieve = Step(id="retrieve", label="本地知识库检索", group="phase_1")
    step_local_gen = Step(id="local_gen", label="本地AI生成回答", group="phase_1")
    step_cloud_gen = Step(id="cloud_gen", label="云端AI补充", group="phase_1")
    step_merge = Step(id="merge", label="本地自动融合优化", group="phase_2")
    _local_retrieve_done = False  # retrieve 是否已完成（sources/step_done 触发）
    _local_gen_started = False    # local_gen 是否已开始（首个 token 触发）
    _cloud_gen_started = False    # cloud_gen 是否已开始（首个 token 触发）

    # 发射 AgentTimeline 初始事件（retrieve 立即开始，local_gen/cloud_gen 待首个 token 才 mark_running）
    step_retrieve.mark_running()
    yield step_to_sse(step_retrieve, "start")
    yield step_to_sse(step_local_gen, "start")
    yield step_to_sse(step_cloud_gen, "start")

    with ThreadPoolExecutor(max_workers=2) as executor:
        local_future = executor.submit(_run_local_column, ctx, local_query, local_queue, local_model, local_history)
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
                        # 首个 token 标记本地生成开始（Step 化：mark_running 自动记 _start_ts）
                        if not _local_gen_started:
                            _local_gen_started = True
                            step_local_gen.mark_running()
                        yield _sse_channel_event("local", "stream", {"content": evt_data})
                    elif evt_type == "step":
                        yield _sse_channel_event("local", "step", {"step": evt_data})
                    elif evt_type == "step_done":
                        # search 的 step_done 只标记 retrieve 完成（不发 done 事件，等 sources 一起发）
                        if evt_data == "search" and not _local_retrieve_done:
                            _local_retrieve_done = True
                        yield _sse_channel_event("local", "step_done", {"step": evt_data})
                    elif evt_type == "sources":
                        local_sources = evt_data
                        if not _local_retrieve_done:
                            step_retrieve.output = StepOutput("sources", [
                                {"label": s.get("source_label", "?"),
                                 "snippet": s.get("text_snippet", "")[:100]}
                                for s in evt_data[:5]
                            ])
                            step_retrieve.mark_done()
                            _local_retrieve_done = True
                            yield step_to_sse(step_retrieve, "done")
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
                    elif evt_type == "done":
                        local_done = True
                        # 如果检索步骤还没标记完成，现在标记（done 兜底）
                        if not _local_retrieve_done:
                            step_retrieve.mark_done()
                            yield step_to_sse(step_retrieve, "done")
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
                        if not _cloud_gen_started:
                            _cloud_gen_started = True
                            step_cloud_gen.mark_running()
                        yield _sse_channel_event("cloud", "stream", {"content": evt_data})
                    elif evt_type == "status":
                        yield _sse_channel_event("cloud", "status", {"status": evt_data})
                    elif evt_type == "error":
                        cloud_error = evt_data
                    elif evt_type == "done":
                        cloud_done = True
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
                    if not _local_gen_started:
                        _local_gen_started = True
                        step_local_gen.mark_running()
                    yield _sse_channel_event("local", "stream", {"content": evt_data})
                elif evt_type == "step":
                    yield _sse_channel_event("local", "step", {"step": evt_data})
                elif evt_type == "step_done":
                    if evt_data == "search" and not _local_retrieve_done:
                        _local_retrieve_done = True
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
                    if not _cloud_gen_started:
                        _cloud_gen_started = True
                        step_cloud_gen.mark_running()
                    yield _sse_channel_event("cloud", "stream", {"content": evt_data})
                elif evt_type == "status":
                    yield _sse_channel_event("cloud", "status", {"status": evt_data})
                elif evt_type == "error":
                    cloud_error = evt_data
            except queue.Empty:
                break

    # 本地列完成事件（Step 化：mark_done 自动算 elapsed_ms）
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
    step_local_gen.mark_done()
    yield step_to_sse(step_local_gen, "done")

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
    step_cloud_gen.mark_done()
    yield step_to_sse(step_cloud_gen, "done")

    # ====== Step2: 融合 — 实时流式 ======
    step_merge.mark_running()
    yield step_to_sse(step_merge, "start")
    yield _sse_progress("merge", "doing")
    yield _sse_channel_event("merge", "phase", {"phase": "started"})

    merge_text = ""
    local_has = bool(local_answer.strip())
    cloud_has = bool(cloud_answer.strip())

    if local_has and cloud_has:
        # 两列都有结果 → 完整融合，实时流式输出
        try:
            from prompts import MERGE_FUSION_PROMPT
            merge_prompt = MERGE_FUSION_PROMPT.format(
                local_answer=local_answer,
                cloud_answer=cloud_answer,
            )

            merge_parts = []
            se = mgr._stream_engine
            # 融合列非 KB 模式（无 history），预留 2048
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
            log.warning("[PARALLEL-MERGE] 融合失败: %s", str(e)[:100])
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

    # 融合 done（Step 化）
    step_merge.mark_done()
    yield step_to_sse(step_merge, "done")
    yield _sse_progress("merge", "done")
    yield _sse_channel_event("merge", "phase", {"phase": "done"})

    # ====== 保存对话到 Chat Tab（带双线记忆）======
    elapsed = time.time() - t0
    final_response = merge_text or local_answer or cloud_answer or "无有效回答"

    # 构建 agent_timeline 数据（Step 化：steps_to_timeline 自动生成，双写 id/step 兼容前端）
    agent_timeline = steps_to_timeline([step_retrieve, step_local_gen, step_cloud_gen, step_merge])

    try:
        from session.chat_store import save_chat
        from session.context_cache import update_session_cache
        ts = time.strftime("%H:%M:%S")
        # 子任务C: memory_local 摘要化（澄清1方案d）。下一轮本地列看摘要而非全文，
        # 释放 8K 窗口空间。保留 memory_local_full 全文供调试。
        _memory_local_summary = _summarize_local_answer(local_answer, message, mgr)
        messages = history_raw + [
            {"role": "user", "content": message, "ts": ts},
            {"role": "assistant",
             "content": final_response,
             "ts": time.strftime("%H:%M:%S"),
             "model": model_choice,
             "chars": len(final_response),
             "time": elapsed,
             "task_type": "parallel",
             # P6 审计修复 C6：memory_local 存本地原始回答（非融合结果）防止下一轮混淆。
             # 重构阶段1-C：改为存摘要(≤200字)释放窗口空间。全文存 memory_local_full。
             "memory_local": _memory_local_summary,
             "memory_local_full": (local_answer or "") if _memory_local_summary != (local_answer or "") else None,
             "memory_cloud": cloud_answer or "",
             "agent_timeline": agent_timeline,
             },
        ]
        # 子任务C: 接入 session 压缩（复刻 local_pipeline/_base 范式）。
        # 原并行模式根本没调 update_session_cache，历史无限堆积。
        new_cache, did_compress = update_session_cache(chat_file, messages, model_choice)
        if did_compress:
            yield sse_event("compress", {"msg": "正在压缩旧对话..."})
        save_chat(chat_file, messages, context_cache=new_cache)
        _saved = True
    except Exception as e:
        log.warning("[PARALLEL] 保存对话失败: %s", str(e)[:80])

    # done 事件
    yield sse_event("done", {
        "model": model_choice,
        "chars": len(final_response),
        "think_chars": 0,
        "time": elapsed,
        "speed": len(final_response) / elapsed if elapsed > 0 else 0,
        "task_type": "parallel",
        "agent_timeline": agent_timeline,
    })
    log.info("[PARALLEL] === 完成 === model=%s chars=%d %.1fs local=%d cloud=%d merge=%d",
             model_choice, len(final_response), elapsed,
             len(local_answer), len(cloud_answer), len(merge_text))
    yield 'data: [DONE]\n\n'
