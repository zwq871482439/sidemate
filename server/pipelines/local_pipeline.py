# -*- coding: utf-8 -*-
"""
pipelines/local_pipeline.py — 本地 SSE 管道

保留 sse_gen() 中 local 模式的全部防护栏：
  1. drift detect → 话题漂移检测（Jaccard bigram）
  2. context guard → 上下文 >85% 警告 / >95% 新建
  3. action_router 解析 /xx 指令
  4. strategy + task_classify → 策略路由 + 温度/采样调参
  5. KB 检索（如果 action=kb）
  6. Research/Doc action 分支
  7. StreamEngine → Ollama /api/chat, think:false
  8. 正文缺失续写（think 占满输出时二次生成）
  9. auto_continue（输出不完整续写）
  10. response_filter（语义重复截断）
  11. 保存对话

纯函数生成器，无闭包/nonlocal。
"""

import os
import re
import json
import time
import logging
from typing import Generator

log = logging.getLogger(__name__)


def _trim_history_by_token_budget(history: list) -> list:
    """按 token 预算自适应裁剪历史（从最旧消息开始）

    Args:
        history: 消息列表 [{"role": "...", "content": "..."}, ...]

    Returns:
        裁剪后的消息列表
    """
    try:
        from config import get as _cfg
        budget = _cfg("history_token_budget", 3000)
    except Exception:
        budget = 3000

    if not history:
        return history

    # 从最旧消息开始累加 token 数
    total_tokens = 0
    cutoff_idx = 0
    for i, msg in enumerate(history):
        content = msg.get("content", "")
        # Token 估算：优先用 token_stats，否则用 chars/1.5
        ts = msg.get("token_stats", None)
        if ts and isinstance(ts, dict):
            msg_tokens = ts.get("input_tokens", 0) + ts.get("output_tokens", 0)
        else:
            msg_tokens = len(content) / 1.5 if content else 0

        if total_tokens + msg_tokens > budget:
            break
        total_tokens += msg_tokens
        cutoff_idx = i + 1

    trimmed = history[cutoff_idx:]
    if cutoff_idx > 0:
        log.info("[LOCAL] 历史裁剪: %d条→%d条 (budget=%d tokens, used=%.0f)",
                 len(history), len(trimmed), budget, total_tokens)
    return trimmed


def run_local_pipeline(ctx) -> Generator[str, None, None]:
    """本地 SSE 管道 — 保留全部防护栏

    Args:
        ctx: StreamContext 数据类（来自 _base.py）

    Yields:
        str — SSE 事件字符串 'data: {...}\n\n'
    """
    # 延迟导入 _base 共享函数（避免循环导入）
    from pipelines._base import sse_event, save_conversation

    # 从上下文提取参数
    mgr = ctx.mgr
    kb = ctx.kb
    message = ctx.message
    model_name = ctx.model_name
    max_tokens = ctx.max_tokens
    chat_file = ctx.chat_file
    history_raw = ctx.history_raw or []
    action_mode = ctx.action_mode or "chat"
    file_path = ctx.file_path
    prompt = ctx.prompt or message
    llm_history = ctx.llm_history
    context_cache = ctx.context_cache
    model_choice = ctx.model_choice

    # ====== 初始化状态变量 ======
    raw_text = ""
    think_content = ""
    response_text = ""
    body_text = ""
    think_folded = False
    saved_task_type = ""
    _saved = False
    _doc_outline_only = False
    _kb_mode = False
    _token_stats = None  # token 统计数据
    model_history = llm_history if llm_history else None

    # 从 config 获取 ai_mode（本地管道里永远是 local，但保持一致）
    from config import get as _cfg_get
    _ai_mode = _cfg_get("ai_mode", "local")

    t0 = time.time()

    # ====== 步骤 2: context guard → 上下文 >85% 警告 / >95% 新建 ======
    try:
        from routers.chat import _calc_context_usage
        ctx_usage = _calc_context_usage(chat_file)
        ctx_pct = ctx_usage["percentage"]

        if ctx_pct > 95:
            from session.chat_store import new_chat_file as _new_chat_file
            from routers.deps import set_current_chat
            new_file = _new_chat_file()
            new_name = os.path.basename(new_file).replace(".json", "")
            log.info("[CTX] 离线上下文 >95%% (%.1f%%)，自动新建会话: %s", ctx_pct, new_name)
            yield sse_event("context_force_new", {
                "percentage": ctx_pct,
                "new_chat_file": new_name,
            })
            set_current_chat(new_file)
            # 更新闭包内变量（通过局部赋值覆盖）
            chat_file = new_file
            model_history = None
            history_raw = []
            llm_history = None
        elif ctx_pct > 85:
            log.info("[CTX] 离线上下文 >85%% (%.1f%%)，发送警告", ctx_pct)
            yield sse_event("context_warning", {
                "percentage": ctx_pct,
                "level": "critical",
            })
    except Exception as ctx_err:
        log.warning("[CTX] 上下文检测失败: %s", str(ctx_err)[:80])

    # ====== 外层 try/finally：保护中途停止时的保存逻辑 ======
    try:
        try:
            # ====== 步骤 3: action_router 解析 /xx 指令 ======
            strategy_override = None
            from intelligence.action_router import resolve_action
            action_result = resolve_action(prompt, current_action=action_mode)
            action_mode = action_result["action"]
            strategy_override = action_result["strategy_override"]
            if action_result["clean_message"] != prompt:
                prompt = action_result["clean_message"]
            if action_result["slash_hint"]:
                yield sse_event("slash_hint", {
                    "message": action_result["slash_hint"],
                })

            # ====== 步骤 4: strategy + task_classify → 策略路由 ======
            from intelligence.task_classifier import resolve_strategy
            strategy = resolve_strategy(prompt, strategy_override=strategy_override)
            log.info("[LOCAL] 策略: %s (action=%s)", strategy["type"], action_mode)

            # ====== 步骤 5: KB 检索（恢复离线 KB 问答 pipeline） ======
            # 阶段2 重构：8 处散乱 yield → 2 个 Step 对象(reformulate/search)，事件走 step_model
            if action_mode == "kb":
                log.info("[LOCAL] KB 模式：检索文库")
                from core.step_model import (Step, StepOutput, TransformData,
                                              step_to_sse, step_output_to_sse)

                # 5a. Reformulate: 始终执行，有历史时补全上下文，无历史时提取搜索关键词
                s_reformulate = Step(id="reformulate", label="分析问题")
                yield step_to_sse(s_reformulate, "start")
                s_reformulate.mark_running()
                search_query = prompt
                reformulate_changed = False
                try:
                    from core.reformulate import reformulate_query
                    reformulated = reformulate_query(prompt, history_raw or [], mgr)
                    if reformulated and reformulated != prompt:
                        reformulate_changed = True
                        search_query = reformulated
                        log.info("[LOCAL-KB] Reformulated: '%s' -> '%s'", prompt[:30], reformulated[:30])
                    s_reformulate.output = StepOutput("transform", TransformData(
                        original=prompt,
                        result=reformulated or prompt,
                        changed=reformulate_changed,
                    ))
                except Exception as e:
                    log.warning("[LOCAL-KB] Reformulate failed: %s", str(e)[:60])
                    s_reformulate.output = StepOutput("transform", TransformData(
                        original=prompt, result=prompt, changed=False,
                    ))
                    s_reformulate.error = str(e)[:60]
                s_reformulate.output_elapsed_ms = int((time.time() - s_reformulate._start_ts) * 1000)
                s_reformulate.mark_done()
                yield step_to_sse(s_reformulate, "done")
                yield step_output_to_sse(s_reformulate)

                # 5b. 检索文库
                s_search = Step(id="search", label="检索文库")
                yield step_to_sse(s_search, "start")
                s_search.mark_running()
                budget = mgr.calc_kb_context_budget()
                safe_chars = budget["safe_chars"]
                kb_context, kb_sources_raw = kb.get_context(search_query, max_chars=safe_chars, ai_mode='local')
                # 规范化字段：统一为 label/snippet/score（和 compare/parallel pipeline 一致）
                kb_sources = [
                    {"label": s.get("source_label", "?"), "snippet": s.get("text_snippet", "")[:100],
                     "reranker_score": s.get("reranker_score") or s.get("score", 0)}
                    for s in kb_sources_raw
                ]
                s_search.output = StepOutput("sources", kb_sources)
                s_search.mark_done()
                yield step_to_sse(s_search, "done")
                if not kb_context:
                    yield sse_event("mode_hint", {"hint": "文库中未找到与问题相关的内容，将作为普通对话处理"})
                    action_mode = "chat"
                else:
                    yield step_output_to_sse(s_search)
                    from prompts import KB_USER_PROMPT_TEMPLATE
                    kb_prompt = KB_USER_PROMPT_TEMPLATE.format(context=kb_context, question=prompt)
                    prompt = kb_prompt
                    _kb_mode = True
                    ctx.kb_sources = kb_sources

            _doc_mode = (action_mode == "doc")
            _research_mode = (action_mode == "research")

            # ====== 步骤 6a: Research Action 已废弃，降级为 chat ======
            if _research_mode:
                log.warning("[LOCAL] action_mode=research 已废弃（由 AgentLoop 替代），降级为 chat 模式")

            # ====== 步骤 6b: Doc Action 分支 ======
            elif _doc_mode:
                from pipelines.doc_action import run_doc_action
                # 从 body 获取 doc_continue（通过 ctx 扩展字段）
                doc_continue_text = getattr(ctx, 'doc_continue', '') or ""
                # 提取用户引用的 KB 文档全文
                _kb_doc_content = ""
                if file_path:
                    kb_doc_ref = kb.get_document(file_path)
                    if kb_doc_ref and kb_doc_ref.status == "ready":
                        _doc_texts = []
                        for chunk in kb.chunks.values():
                            if chunk.doc_id == file_path and chunk.text:
                                _doc_texts.append(chunk.text)
                        if _doc_texts:
                            from knowledge.file_extractor import calc_file_budget, smart_extract
                            _full_text = "\n\n".join(_doc_texts)
                            _hist_chars = sum(
                                len(m.get("content", "")) for m in history_raw
                            ) if history_raw else 0
                            _budget = calc_file_budget(_hist_chars)
                            if len(_full_text) > _budget:
                                _full_text = smart_extract(_full_text, message or "", _budget)
                            _kb_doc_content = _full_text
                            log.info("[LOCAL] doc_action KB引用提取: %s (%d字)",
                                     kb_doc_ref.filename, len(_kb_doc_content))
                            # 模块5a：发 doc_loaded 事件，让明盒显示"已加载文档"
                            yield sse_event("doc_loaded", {
                                "filename": kb_doc_ref.filename,
                                "tokens": int(len(_kb_doc_content) / 1.5),
                                "count": 1,
                            })

                for phase, content in run_doc_action(
                    message=message,
                    mgr=mgr,
                    model_name=model_choice,
                    max_tokens=max_tokens,
                    history=model_history,
                    kb=kb,
                    context_cache=context_cache,
                    strategy_enhancement=strategy.get("system_enhancement", ""),
                    doc_continue=doc_continue_text,
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

            # ====== 步骤 7: StreamEngine → Ollama /api/chat ======
            else:
                log.info("[LOCAL] >> 进入 chat_stream model=%s", model_choice)

                # Patch5 修复：chat 模式下也读取 KB 文档引用
                # 原先只有 doc_mode 才读 file_path，导致 chat 模式引用 KB 文档时 AI 看不到内容
                _chat_kb_context = ""
                if file_path and not _doc_mode:
                    log.info("[LOCAL] chat 模式收到 file_path=%s, 尝试提取 KB 文档内容", file_path)
                    try:
                        kb_doc_ref = kb.get_document(file_path)
                        if not kb_doc_ref:
                            log.warning("[LOCAL] file_path=%s 在 KB 中未找到（documents=%d）",
                                        file_path, len(kb.documents))
                        elif kb_doc_ref.status != "ready":
                            log.warning("[LOCAL] file_path=%s 状态=%s，不是 ready", file_path, kb_doc_ref.status)
                        if kb_doc_ref and kb_doc_ref.status == "ready":
                            _doc_texts = []
                            for chunk in kb.chunks.values():
                                if chunk.doc_id == file_path and chunk.text:
                                    _doc_texts.append(chunk.text)
                            if _doc_texts:
                                from knowledge.file_extractor import calc_file_budget, smart_extract
                                _full_text = "\n\n".join(_doc_texts)
                                _hist_chars = sum(
                                    len(m.get("content", "")) for m in history_raw
                                ) if history_raw else 0
                                _budget = calc_file_budget(_hist_chars)
                                if len(_full_text) > _budget:
                                    _full_text = smart_extract(_full_text, message or "", _budget)
                                _chat_kb_context = _full_text
                                log.info("[LOCAL] chat 模式 KB 引用提取: %s (%d字)",
                                         kb_doc_ref.filename, len(_chat_kb_context))
                    except Exception as _e:
                        log.warning("[LOCAL] chat 模式 KB 引用提取失败: %s", str(_e)[:100])

                # 如果有 KB 文档内容，注入到 prompt
                if _chat_kb_context:
                    prompt = "【用户引用的文档内容】\n\n" + _chat_kb_context + "\n\n【用户问题】\n" + (message or prompt)
                    # 模块5a：发 doc_loaded 事件，让明盒显示"已加载文档"
                    _doc_names = []
                    for _fp in (file_path or "").split(","):
                        _fp = _fp.strip()
                        if _fp:
                            _ref = kb.get_doc_ref(_fp) if hasattr(kb, 'get_doc_ref') else None
                            _doc_names.append(_ref.filename if _ref else _fp)
                    yield sse_event("doc_loaded", {
                        "filename": "、".join(_doc_names) if _doc_names else "文档",
                        "tokens": int(len(_chat_kb_context) / 1.5),
                        "count": len(_doc_names),
                    })

                for phase, content in mgr.chat_stream(
                    prompt, model_choice, max_tokens, model_history,
                    context_cache=context_cache,
                    strategy_enhancement=strategy.get("system_enhancement", ""),
                    kb_mode=_kb_mode,
                ):
                    if phase == "task_type":
                        tt, conf = content
                        saved_task_type = tt
                        yield sse_event("task_type", {"task_type": tt, "confidence": conf})
                    elif phase == "mode_hint":
                        yield sse_event("mode_hint", {"message": content})
                    elif phase == "raw":
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
                    elif phase == "reload":
                        yield sse_event("model_reload", {"model": content})
                    elif phase == "token_stats":
                        _token_stats = content

        except Exception as e:
            yield sse_event("error", {"content": str(e)[:200]})
            yield 'data: [DONE]\n\n'
            _saved = True
            return

        # ====== 步骤 8: 正文缺失续写（think 占满输出时二次生成） ======
        current_response = response_text or raw_text
        if think_folded and not response_text.strip() and think_content:
            log.debug("[CONTINUE] Think occupied all output (%d chars), body empty. Generating body...",
                      len(think_content))
            yield sse_event("token", {"content": "\n\n"})

            body_history = []
            if model_history:
                body_history = list(model_history)
            body_history.append({"role": "user", "content": prompt})

            if saved_task_type == "reasoning":
                body_sys_msg = "请直接给出最终回答，分步写公式和结果，纯文本格式。"
                body_user_msg = "请直接给出最终回答，分步写公式和结果，纯文本格式。"
                body_override_type = "reasoning"
            else:
                body_sys_msg = "请直接给出最终回答，不要重复推理过程。"
                body_user_msg = "请直接给出最终回答，不要重复推理过程。"
                body_override_type = "text"

            body_history.append({"role": "system", "content": body_sys_msg})

            try:
                profile = mgr._get_profile(model_choice)
                body_max_tokens = max(
                    max_tokens or profile["default_max_tokens"],
                    profile["default_max_tokens"],
                )
            except Exception:
                body_max_tokens = max_tokens or 2048

            body_text = ""
            try:
                for phase, content in mgr.chat_stream(
                    body_user_msg, model_choice, body_max_tokens, body_history,
                    context_cache=context_cache,
                    override_task_type=body_override_type,
                    kb_mode=_kb_mode,
                ):
                    if phase == "raw":
                        body_text += content
                        yield sse_event("token", {"content": content})
                    elif phase == "fold":
                        think_content += "\n---\n" + content
                        yield sse_event("fold", {"think_len": len(think_content)})
                    elif phase == "text":
                        body_text += content
                        response_text += content
                        yield sse_event("token", {"content": content})
            except Exception as e:
                log.warning("[CONTINUE BODY ERROR] %s", str(e))

            if body_text:
                log.debug("[CONTINUE] Body generation completed, %d chars", len(body_text))

        # ====== 步骤 9: auto_continue（输出不完整续写，最多 1 轮） ======
        from session.continuation import is_output_incomplete
        current_response = response_text or raw_text
        if is_output_incomplete(current_response):
            log.info("[CONTINUE] 检测到输出不完整，自动续写 (response=%d字)", len(current_response))
            fence_count = current_response.count("```")
            continuation_prefix = ""
            if fence_count % 2 == 1:
                continuation_prefix = "\n```\n"
                response_text += continuation_prefix
                yield sse_event("token", {"content": continuation_prefix})

            sep = "\n\n"
            response_text += sep
            yield sse_event("token", {"content": sep})

            cont_history = list(model_history or [])
            cont_history.append({"role": "user", "content": prompt})
            cont_history.append({"role": "assistant", "content": current_response})
            cont_history.append({"role": "user", "content": "继续输出刚才未完成的部分。直接接上输出，不要重新开始。"})

            cont_text = ""
            try:
                for phase, content in mgr.chat_stream(
                    "继续输出刚才未完成的部分。直接接上输出，不要重新开始。",
                    model_choice, max_tokens, cont_history,
                    context_cache=context_cache,
                    kb_mode=_kb_mode,
                ):
                    if phase == "raw":
                        cont_text += content
                        yield sse_event("token", {"content": content})
                    elif phase == "fold":
                        think_content += ("\n---\n" + content if think_folded else content)
                        if not think_folded:
                            think_folded = True
                        yield sse_event("fold", {"think_len": len(think_content)})
                    elif phase == "text":
                        cont_text += content
                        response_text += content
                        yield sse_event("token", {"content": content})
            except Exception as e:
                log.warning("[CONTINUE ERROR] %s", str(e))

            if cont_text:
                log.info("[CONTINUE] 续写完成，新增 %d 字", len(cont_text))

        # ====== 步骤 10: response_filter（语义重复截断） ======
        elapsed = time.time() - t0
        response_chars = len(response_text.strip()) if response_text else 0
        think_chars = len(think_content.strip()) if (think_folded and think_content) else 0
        if response_chars == 0 and raw_text:
            from core.think_processor import ThinkProcessor
            cleaned = ThinkProcessor().strip_think(raw_text).strip()
            response_chars = len(cleaned)
        total_chars = response_chars + think_chars
        speed = total_chars / elapsed if elapsed > 0 and total_chars > 0 else 0

        final_text = response_text or raw_text
        filter_warnings = []
        filter_corrections = []
        try:
            from intelligence.response_filter import filter_response
            filter_result = filter_response(final_text, user_msg=message)
            filter_warnings = filter_result.get("warnings", [])
            filter_corrections = filter_result.get("corrections", [])
            # P6: 前缀累积警告不暴露给用户（仅日志内部使用），文本已在 cleaned 字段处理
            filter_warnings = [w for w in filter_warnings if '前缀累积' not in w and '4-gram' not in w]
            # P6: 如果 cleaned 文本不同，说明前缀累积已被清理，使用清理后的文本
            cleaned_text = filter_result.get("cleaned", "")
            if cleaned_text and cleaned_text != final_text:
                response_text = cleaned_text
                final_text = cleaned_text
            if filter_warnings:
                _filter_yielded = False
                for w in filter_warnings:
                    m = re.match(r'检测到 (\d+) 个语义重复的句子', w)
                    if m and int(m.group(1)) >= 10:
                        log.info("[FILTER] 语义重复严重 (%s句)，自动截断回复", m.group(1))
                        sentences = re.split(r'[。！？\n]', final_text)
                        sentences = [s.strip() for s in sentences if s.strip()]
                        if len(sentences) > 3:
                            def _trigrams(s):
                                return set(s[i:i+3] for i in range(len(s)-2))

                            cut_idx = len(sentences)
                            seen_sents = {}
                            for idx, s in enumerate(sentences):
                                if len(s) < 15:
                                    continue
                                tg = _trigrams(s)
                                if not tg:
                                    continue
                                for prev_s, prev_tg in seen_sents.items():
                                    overlap = len(tg & prev_tg)
                                    union = len(tg | prev_tg)
                                    if union > 0 and overlap / union > 0.6:
                                        cut_idx = idx
                                        break
                                if cut_idx < len(sentences):
                                    break
                                seen_sents[s] = tg

                            truncated = '。'.join(sentences[:cut_idx])
                            if truncated and not truncated.endswith(('。', '！', '？', '\n')):
                                truncated += '。'
                            if len(truncated) > 20:
                                log.info("[FILTER] 截断: %d字 → %d字", len(final_text), len(truncated))
                                response_text = truncated
                                raw_text = truncated
                                final_text = truncated
                                response_chars = len(truncated.strip())
                                speed = (response_chars + think_chars) / elapsed if elapsed > 0 else 0
                                _filter_yielded = True
                                yield sse_event("filter", {
                                    "warnings": ["回复已自动精简（检测到重复内容）"],
                                    "corrections": [],
                                    "truncated": True,
                                })
                                # Bug2 修复：同步截断后的正文到前端
                                # 复用现有 truncate 事件通道（chat.js:1385 已支持），让前端 fullText
                                # 从"完整车轱辘话"替换为"截断后正文"，与聊天记录三态一致。
                                yield sse_event("truncate", {"content": truncated})
                                break

                # 只 yield 一次 filter 事件
                if not _filter_yielded:
                    yield sse_event("filter", {
                        "warnings": filter_warnings,
                        "corrections": filter_corrections,
                    })
        except ImportError:
            pass
        except Exception as e:
            log.warning("[FILTER] 过滤器异常: %s", str(e)[:100])

        # ====== 步骤 11: 保存对话 ======
        from session.context_cache import (
            clean_think_content_wrapped as _clean_think,
            update_session_cache,
        )
        from session.chat_store import save_chat
        from pipelines._base import _sanitize_output

        final_response = response_text or raw_text
        final_response = mgr.strip_think(final_response)

        # body_text 恢复
        if not final_response.strip() and body_text and body_text.strip():
            final_response = mgr.strip_think(body_text)
            if final_response.strip():
                response_text = body_text
                log.info("[SAVE] Recovered body from body_text (%d chars)", len(final_response))

        # 空回复保护
        if not final_response.strip():
            _raw_len = len((response_text or "") + (raw_text or ""))
            if _raw_len > 0:
                log.warning("[SAVE] full_output had %d chars but all consumed by think tags (raw=%s)",
                            _raw_len, repr((raw_text or "")[:80]))
            final_response = "抱歉，我暂时无法回答这个问题，请稍后再试。"
            response_chars = len(final_response)
            response_text = final_response
            yield sse_event("truncate", {"content": final_response})
            log.info("[SAVE] 空回复已替换为默认提示 (%d chars)", len(final_response))

        # 轻量排版清理
        final_response = _sanitize_output(final_response)
        response_chars = len(final_response)

        is_error_response = final_response.strip().startswith("[ERROR]")
        messages = None
        new_cache = None
        if final_response.strip() and not is_error_response:
            ts = time.strftime("%H:%M:%S")
            messages = history_raw + [
                {"role": "user", "content": message, "ts": ts},
                {"role": "assistant", "content": final_response,
                 "ts": time.strftime("%H:%M:%S"),
                 "think": (_clean_think(think_content) if think_folded and len(think_content.strip()) >= 20 else ""),
                 "model": model_choice,
                 "chars": response_chars, "think_chars": think_chars,
                 "time": elapsed, "speed": speed,
                 "task_type": saved_task_type,
                 "token_stats": _token_stats},
            ]
            new_cache, did_compress = update_session_cache(chat_file, messages, model_choice)
            if did_compress:
                yield sse_event("compress", {"msg": "正在压缩旧对话..."})
            save_chat(chat_file, messages, context_cache=new_cache)
            _saved = True
        else:
            ts = time.strftime("%H:%M:%S")
            error_note = final_response.strip() if is_error_response else ""
            save_messages = history_raw + [
                {"role": "user", "content": message, "ts": ts},
            ]
            if error_note:
                save_messages.append({
                    "role": "assistant", "content": "[生成失败，已保留用户消息]",
                    "ts": time.strftime("%H:%M:%S"), "model": model_choice,
                    "chars": 0, "time": elapsed, "task_type": saved_task_type,
                })
            save_chat(chat_file, save_messages)
            _saved = True
            if is_error_response:
                log.warning("[LOCAL] Model error (user msg saved): %s", error_note[:100])
            else:
                log.warning("[LOCAL] 空回复，用户消息已保存 (model=%s, elapsed=%.1fs)",
                            model_choice, elapsed)

        # 文档模式 Phase 2: 生成 .docx 下载
        _doc_mode = (action_mode == "doc")
        if _doc_mode and not _doc_outline_only and final_response.strip():
            try:
                from pipelines.doc_action import generate_docx
                doc_filename = "doc_%s.docx" % time.strftime("%Y%m%d_%H%M%S")
                from config import DOCS_DIR
                doc_path = os.path.join(DOCS_DIR, doc_filename)
                generate_docx(final_response, doc_path,
                              title=message[:50] if message else "文档")
                download_url = "/api/doc/download/%s" % doc_filename
                yield sse_event("doc_ready", {
                    "url": download_url,
                    "filename": doc_filename,
                })
                log.info("[LOCAL] DOC 生成完成: %s", doc_filename)
                # 回写 doc_url 到已保存的消息
                if _saved and messages:
                    messages[-1]["doc_url"] = download_url
                    messages[-1]["doc_filename"] = doc_filename
                    save_chat(chat_file, messages, context_cache=new_cache)
            except Exception as e:
                log.error("[LOCAL] DOC 生成失败: %s", str(e)[:100])
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
        if _token_stats:
            done_payload["token_stats"] = _token_stats
        yield sse_event("done", done_payload)
        log.info("[LOCAL] === 完成 === model=%s type=%s chars=%d think=%d %.1fs",
                 model_choice, saved_task_type, response_chars, think_chars, elapsed)
        yield 'data: [DONE]\n\n'

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
                    _speed = int(len(actual) / _elapsed) if _elapsed > 0 else 0
                    save_msgs = history_raw + [
                        {"role": "user", "content": message, "ts": _ts},
                        {"role": "assistant",
                         "content": actual or "[思考已中断]",
                         "ts": time.strftime("%H:%M:%S"),
                         "think": _clean_think_text,
                         "model": model_choice,
                         "chars": len(actual),
                         "time": _elapsed,
                         "speed": _speed,
                         "task_type": saved_task_type or "text",
                         "action_mode": ctx.action_mode or "chat",
                         # P6 修复: 服务端终止保存必须带 _aborted 标记,否则前端重渲染丢失终止提示
                         "_aborted": True,
                         "_abort_reason": "user_stop"},
                    ]
                    _save_chat_final(chat_file, save_msgs)
                    log.info("[SAVE] 中途停止，已保存 %d 字 + think %d 字",
                             len(actual), len(_clean_think_text))
            except Exception as e:
                log.warning("[SAVE] 中途保存失败: %s", str(e)[:100])
