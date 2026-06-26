# -*- coding: utf-8 -*-
"""
pipelines/_base.py — SSE 管道共享基础设施

包含：
  - StreamContext 数据类：封装所有请求参数，避免闭包 nonlocal
  - EngineResult 数据类：收集引擎输出的中间结果
  - sse_event()：构造标准 SSE 事件字符串
  - yield_engine_tokens()：通用引擎 token 转换器
  - _sanitize_output()：轻量排版清理
  - save_conversation()：保存对话（normal path + finally path + docx 生成）
  - handle_action_router()：Action Router 解析 /xx 指令
  - handle_kb_retrieval()：KB 文库检索注入
  - handle_doc_action()：Doc Action SSE 转换
"""

import os
import re
import json
import time
import logging
from dataclasses import dataclass, field
from typing import Optional, List, Generator

log = logging.getLogger(__name__)


# ============================================================
#  数据类
# ============================================================

@dataclass
class StreamContext:
    """管道上下文 — 封装所有请求参数，避免闭包 nonlocal"""
    # 请求参数
    message: str
    model_name: str
    max_tokens: Optional[int]
    chat_file: str
    history_raw: List[dict]
    action_mode: str  # "chat"|"doc"|"research"
    file_path: Optional[str]
    ai_mode: str  # "local"|"cloud"

    # 注入的依赖
    mgr: object  # ModelManager
    kb: object   # KnowledgeBase

    # 预处理的中间状态
    prompt: str = ""
    llm_history: Optional[List[dict]] = None
    context_cache: Optional[str] = None
    strategy: dict = field(default_factory=dict)
    model_choice: str = ""
    doc_continue: str = ""  # Doc action Phase 2: 用户确认的提纲内容
    body: dict = field(default_factory=dict)  # 原始请求 body（供扩展字段）
    is_kb_compare: bool = False  # Patch3: 是否启用文库对比模式
    memory_local: List[dict] = field(default_factory=list)  # P6: Chat Tab 本地列历史
    parallel_options: dict = field(default_factory=dict)  # P6: 并行模式选项（allow_cloud_keywords 等）


@dataclass
class EngineResult:
    """引擎输出收集器 — 传入 yield_engine_tokens，循环结束后读取结果"""
    raw_text: str = ""
    response_text: str = ""
    think_content: str = ""
    think_folded: bool = False
    saved_task_type: str = ""
    token_stats: dict = None  # {"input_tokens": int, "output_tokens": int, "reasoning_tokens": int|None}


# ============================================================
#  SSE 工具函数
# ============================================================

def sse_event(event_type: str, data: dict = None) -> str:
    """构造标准 SSE 事件字符串

    Args:
        event_type: 事件类型（对应前端 data.type）
        data: 额外数据字段（会被合并到顶层 JSON）

    Returns:
        str — 'data: {"type":"xxx",...}\n\n'
    """
    payload = {"type": event_type}
    if data:
        payload.update(data)
    return 'data: %s\n\n' % json.dumps(payload, ensure_ascii=False)


def yield_engine_tokens(engine_gen, result: EngineResult) -> Generator[str, None, None]:
    """消费引擎生成器，yield SSE 事件字符串，结果写入 result

    消费 mgr.chat_stream() 或类似接口的 (phase, content) yield，
    输出标准 SSE 事件字符串。

    Args:
        engine_gen: 引擎生成器，yield (phase, content)
        result: EngineResult 实例，用于收集中间状态

    Yields:
        str — SSE 事件字符串
    """
    for phase, content in engine_gen:
        if phase == "task_type":
            tt, conf = content
            result.saved_task_type = tt
            yield 'data: {"type": "task_type", "task_type": "%s", "confidence": %.2f}\n\n' % (tt, conf)
        elif phase == "mode_hint":
            yield 'data: {"type": "mode_hint", "message": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "raw":
            result.raw_text += content
            yield 'data: {"type": "token", "content": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "think_start":
            result.think_folded = False
            yield 'data: {"type": "think_start"}\n\n'
        elif phase == "think_token":
            result.think_content += content
            yield 'data: {"type": "think_token", "content": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "think_end":
            result.think_folded = True
            yield 'data: {"type": "think_end", "think_len": %d}\n\n' % len(result.think_content)
        elif phase == "fold":
            result.think_content = content
            result.think_folded = True
            yield 'data: {"type": "fold", "think_len": %d}\n\n' % len(result.think_content)
        elif phase == "text":
            result.response_text += content
            yield 'data: {"type": "token", "content": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "reload":
            yield 'data: {"type": "model_reload", "model": "%s"}\n\n' % content


# ============================================================
#  轻量排版清理
# ============================================================

def _sanitize_output(text: str) -> str:
    """轻量排版清理（不删正文内容，只做格式修整）

    处理项：
    1. 连续空格压缩（4+ 空格 → 1 空格）—— 代码块内除外（保留缩进）
    2. 连续空行限制（最多保留 2 个空行）
    3. 末尾残缺标签清理（<think, <thinking 等）
    4. 首字修正：截掉开头的标点（逗号/顿号/分号/冒号）
    5. 首尾空白清理
    """
    if not text or not text.strip():
        return text

    # 代码块保护：用占位符替换 ``` 围栏内的内容，避免后续空格压缩破坏缩进
    _code_blocks = []
    def _stash_code(m):
        _code_blocks.append(m.group(0))
        return '\x00CODEBLOCK%d\x00' % (len(_code_blocks) - 1)
    text = re.sub(r'```.*?```', _stash_code, text, flags=re.DOTALL)

    # 1. 连续空格压缩（仅作用于代码块外的普通文本）
    text = re.sub(r' {4,}', ' ', text)

    # 2. 连续空行限制
    text = re.sub(r'\n{4,}', '\n\n\n', text)

    # 3. 末尾残缺标签清理
    text = re.sub(r'<+<?\s*(think|thinking|reason|reasoning|thought)\s*[^\w]*$', '', text)

    # 4. 首字修正：截掉开头的标点（幻觉续写兜底）
    text = re.sub(r'^[，、；：]\s*', '', text)

    # 还原代码块
    for i, block in enumerate(_code_blocks):
        text = text.replace('\x00CODEBLOCK%d\x00' % i, block)

    # 5. 首尾空白
    text = text.strip()

    return text


# ============================================================
#  Action Router 共享函数
# ============================================================

def handle_action_router(ctx: StreamContext) -> Generator[str, None, None]:
    """Action Router：解析 /xx 指令

    解析用户消息中的斜杠指令，更新 ctx.action_mode 和 ctx.prompt。

    Args:
        ctx: StreamContext 实例（会被原地修改）

    Yields:
        str — SSE 事件字符串
    """
    from intelligence.action_router import resolve_action

    action_result = resolve_action(ctx.prompt, current_action=ctx.action_mode)
    ctx.action_mode = action_result["action"]
    strategy_override = action_result["strategy_override"]
    if action_result["clean_message"] != ctx.prompt:
        ctx.prompt = action_result["clean_message"]
    if action_result["slash_hint"]:
        yield 'data: {"type": "slash_hint", "message": %s}\n\n' % json.dumps(
            action_result["slash_hint"], ensure_ascii=False)

    # 策略路由（云端管道也可以调用，但云端不一定使用结果）
    try:
        from intelligence.task_classifier import resolve_strategy
        ctx.strategy = resolve_strategy(ctx.prompt, strategy_override=strategy_override)
    except Exception as e:
        log.warning("[ACTION_ROUTER] 策略路由失败: %s" % str(e)[:80])
        ctx.strategy = {}


# ============================================================
#  KB 检索共享函数
# ============================================================

def handle_kb_retrieval(ctx: StreamContext) -> Generator[str, None, None]:
    """KB 文库检索注入

    当 ctx.action_mode == "kb" 时，检索知识库并将结果注入 prompt。

    Args:
        ctx: StreamContext 实例（会被原地修改）

    Yields:
        str — SSE 事件字符串
    """
    mgr = ctx.mgr
    kb = ctx.kb

    budget = mgr.calc_kb_context_budget()
    safe_chars = budget["safe_chars"]
    # Patch4 v3.1：传 ai_mode 给 get_context，让其按模式动态调整 top_k
    _ai_mode = getattr(ctx, 'ai_mode', None) or 'local'
    log.info("[KB] context 预算: safe_chars=%d, ai_mode=%s", safe_chars, _ai_mode)

    kb_context, kb_sources = kb.get_context(ctx.prompt, max_chars=safe_chars, ai_mode=_ai_mode)
    if not kb_context:
        yield 'data: {"type": "mode_hint", "message": "文库中未找到与问题相关的内容，将使用模型直接回答。"}\n\n'
        log.info("[KB] 无检索结果, fallback 普通对话")
    else:
        from prompts import KB_USER_PROMPT_TEMPLATE
        kb_prompt = KB_USER_PROMPT_TEMPLATE.format(context=kb_context, question=ctx.prompt)
        ctx.prompt = kb_prompt
        log.info("[KB] 检索完成: %d条来源, %d字" % (len(kb_sources), len(kb_context)))
        yield 'data: {"type": "mode_hint", "message": " 已检索文库（%d条相关文档），正在生成回答..."}\n\n' % len(kb_sources)
        if kb_sources:
            yield 'data: {"type": "kb_sources", "sources": %s}\n\n' % json.dumps(
                [{"label": s.get("source_label", "?"), "snippet": s.get("text_snippet", "")[:100]}
                 for s in kb_sources[:5]], ensure_ascii=False)


# ============================================================
#  Doc Action SSE 转换
# ============================================================

def handle_doc_action(ctx: StreamContext) -> Generator[str, None, None]:
    """Doc Action SSE 转换

    调用 run_doc_action 两阶段流程，将 (phase, content) 转为 SSE 事件字符串。

    Args:
        ctx: StreamContext 实例

    Yields:
        str — SSE 事件字符串

    Returns:
        dict — 包含 "doc_outline_only" 标记（Phase 1 时为 True）
    """
    mgr = ctx.mgr
    kb = ctx.kb

    from pipelines.doc_action import run_doc_action
    doc_continue_text = ctx.body.get("doc_continue", "")

    # 提取用户引用的 KB 文档全文（供 doc_action 注入 prompt）
    _kb_doc_content = ""
    if ctx.file_path:
        kb_doc_ref = kb.get_document(ctx.file_path)
        if kb_doc_ref and kb_doc_ref.status == "ready":
            _doc_texts = []
            for chunk in kb.chunks.values():
                if chunk.doc_id == ctx.file_path and chunk.text:
                    _doc_texts.append(chunk.text)
            if _doc_texts:
                from knowledge.file_extractor import calc_file_budget, smart_extract
                _full_text = "\n\n".join(_doc_texts)
                _hist_chars = sum(len(m.get("content", "")) for m in ctx.history_raw) if ctx.history_raw else 0
                _budget = calc_file_budget(_hist_chars)
                if len(_full_text) > _budget:
                    _full_text = smart_extract(_full_text, ctx.message or "", _budget)
                _kb_doc_content = _full_text
                log.info("[DOC] KB引用提取: %s (%d字)" % (kb_doc_ref.filename, len(_kb_doc_content)))

    raw_text = ""
    think_content = ""
    response_text = ""
    think_folded = False
    saved_task_type = ""
    _doc_outline_only = False

    for phase, content in run_doc_action(
        message=ctx.message,
        mgr=mgr,
        model_name=ctx.model_choice,
        max_tokens=ctx.max_tokens,
        history=ctx.llm_history,
        kb=kb,
        context_cache=ctx.context_cache,
        strategy_enhancement=ctx.strategy.get("system_enhancement", ""),
        doc_continue=doc_continue_text,
        kb_doc_content=_kb_doc_content,
    ):
        if phase == "mode_hint":
            yield 'data: {"type": "mode_hint", "message": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "doc_outline":
            _doc_outline_only = True
            yield 'data: {"type": "doc_outline", "outline": %s}\n\n' % json.dumps(content, ensure_ascii=False)
            break
        elif phase == "task_type":
            tt, conf = content
            saved_task_type = tt
            yield 'data: {"type": "task_type", "task_type": "%s", "confidence": %.2f}\n\n' % (tt, conf)
        elif phase == "raw":
            raw_text += content
            yield 'data: {"type": "token", "content": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "fold":
            think_content = content
            think_folded = True
            yield 'data: {"type": "fold", "think_len": %d}\n\n' % len(think_content)
        elif phase == "text":
            response_text += content
            yield 'data: {"type": "token", "content": %s}\n\n' % json.dumps(content, ensure_ascii=False)
        elif phase == "reload":
            yield 'data: {"type": "model_reload", "model": "%s"}\n\n' % content

    # 将 doc action 的收集结果写回 ctx，供 save_conversation 使用
    # 注意：这里直接修改 ctx 不太优雅，但为了兼容现有 save_conversation 接口
    # 我们将结果通过一个返回字典传递给调用方
    # 调用方需要自行处理这个返回值
    # 由于生成器不能 return（会被忽略），我们通过修改 ctx.body 来传递标记
    ctx.body["_doc_outline_only"] = _doc_outline_only
    ctx.body["_doc_raw_text"] = raw_text
    ctx.body["_doc_think_content"] = think_content
    ctx.body["_doc_response_text"] = response_text
    ctx.body["_doc_think_folded"] = think_folded
    ctx.body["_doc_saved_task_type"] = saved_task_type


# ============================================================
#  保存对话共享函数
# ============================================================

def save_conversation(ctx: StreamContext, result: EngineResult, t0: float) -> Generator[str, None, None]:
    """保存对话 — normal path + done 事件 + [DONE]

    包含：
    - 计算 elapsed/response_chars/think_chars/speed
    - 空回复保护（P0-79）
    - 轻量排版清理
    - 保存对话（normal path）
    - Doc 模式 docx 生成
    - done 事件 + [DONE]

    Args:
        ctx: StreamContext 实例
        result: EngineResult 实例（来自 yield_engine_tokens）
        t0: 开始时间戳

    Yields:
        str — SSE 事件字符串
    """
    from session.chat_store import save_chat
    from session.context_cache import (
        clean_think_content_wrapped as clean_think_content,
        update_session_cache,
    )

    mgr = ctx.mgr
    message = ctx.message
    chat_file = ctx.chat_file
    history_raw = ctx.history_raw or []
    model_choice = ctx.model_choice

    raw_text = result.raw_text
    response_text = result.response_text
    think_content = result.think_content
    think_folded = result.think_folded
    saved_task_type = result.saved_task_type

    elapsed = time.time() - t0
    response_chars = len(response_text.strip()) if response_text else 0
    think_chars = len(think_content.strip()) if (think_folded and think_content) else 0
    if response_chars == 0 and raw_text:
        try:
            from core.think_processor import ThinkProcessor
            cleaned = ThinkProcessor().strip_think(raw_text).strip()
            response_chars = len(cleaned)
        except Exception:
            pass
    total_chars = response_chars + think_chars
    speed = total_chars / elapsed if elapsed > 0 and total_chars > 0 else 0

    # 组装最终回复
    final_response = response_text or raw_text
    final_response = mgr.strip_think(final_response)

    # P0-79: 空回复保护
    if not final_response.strip():
        _raw_len = len((response_text or "") + (raw_text or ""))
        if _raw_len > 0:
            log.warning("[SAVE] full_output had %d chars but all consumed by think tags", _raw_len)
        final_response = "抱歉，我暂时无法回答这个问题，请稍后再试。"
        response_chars = len(final_response)
        response_text = final_response
        yield 'data: {"type": "truncate", "content": %s}\n\n' % json.dumps(final_response, ensure_ascii=False)
        log.info("[SAVE] 空回复已替换为默认提示 (%d chars)", len(final_response))

    # 轻量排版清理
    final_response = _sanitize_output(final_response)
    response_chars = len(final_response)

    # 保存对话
    is_error_response = final_response.strip().startswith("[ERROR]")
    if final_response.strip() and not is_error_response:
        ts = time.strftime("%H:%M:%S")
        messages = history_raw + [
            {"role": "user", "content": message, "ts": ts},
            {"role": "assistant", "content": final_response, "ts": time.strftime("%H:%M:%S"),
             "think": (clean_think_content(think_content) if think_folded and len(think_content.strip()) >= 20 else ""),
             "model": model_choice,
             "chars": response_chars, "think_chars": think_chars, "time": elapsed, "speed": speed,
             "task_type": saved_task_type}
        ]
        new_cache, did_compress = update_session_cache(chat_file, messages, model_choice)
        if did_compress:
            yield 'data: {"type": "compress", "msg": "正在压缩旧对话..."}\n\n'
        save_chat(chat_file, messages, context_cache=new_cache)
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
                "chars": 0, "time": elapsed, "task_type": saved_task_type})
        save_chat(chat_file, save_messages)
        if is_error_response:
            log.warning("[SAVE] Model error (user msg saved): %s", error_note[:100])
        else:
            log.warning("[SAVE] 空回复，用户消息已保存 (model=%s, elapsed=%.1fs)", model_choice, elapsed)

    # Doc 模式 docx 生成
    _doc_outline_only = ctx.body.get("_doc_outline_only", False)
    _doc_mode = (ctx.action_mode == "doc")
    if _doc_mode and not _doc_outline_only and final_response.strip():
        try:
            from pipelines.doc_action import generate_docx
            doc_filename = "doc_%s.docx" % time.strftime("%Y%m%d_%H%M%S")
            from config import DOCS_DIR
            doc_path = os.path.join(DOCS_DIR, doc_filename)
            generate_docx(final_response, doc_path, title=message[:50] if message else "文档")
            download_url = "/api/doc/download/%s" % doc_filename
            yield 'data: {"type": "doc_ready", "url": "%s", "filename": "%s"}\n\n' % (download_url, doc_filename)
            log.info("[DOC] 生成完成: %s", doc_filename)
        except Exception as e:
            log.error("[DOC] 生成失败: %s", str(e)[:100])
            yield 'data: {"type": "doc_error", "message": "文档生成失败: %s"}\n\n' % str(e)[:80]

    # done 事件 + [DONE]
    yield 'data: {"type": "done", "model": "%s", "chars": %d, "think_chars": %d, "time": %.1f, "speed": %.0f, "task_type": "%s"}\n\n' % (
        model_choice, response_chars, think_chars, elapsed, speed, saved_task_type
    )
    log.info("[SAVE] 完成 model=%s type=%s chars=%d think=%d %.1fs" % (
        model_choice, saved_task_type, response_chars, think_chars, elapsed))
    yield 'data: [DONE]\n\n'


# ============================================================
#  中途停止保存（finally path）
# ============================================================

def save_on_stop(ctx: StreamContext, result: EngineResult, t0: float):
    """中途停止时保存已接收内容（finally path）

    Args:
        ctx: StreamContext 实例
        result: EngineResult 实例
        t0: 开始时间戳
    """
    from session.chat_store import save_chat
    from session.context_cache import clean_think_content_wrapped as clean_think_content

    mgr = ctx.mgr
    message = ctx.message
    chat_file = ctx.chat_file
    history_raw = ctx.history_raw or []
    model_choice = ctx.model_choice

    raw_text = result.raw_text
    response_text = result.response_text
    think_content = result.think_content
    saved_task_type = result.saved_task_type

    actual = response_text or raw_text
    actual = mgr.strip_think(actual)
    actual = _sanitize_output(actual)

    _clean_think = clean_think_content(think_content) if think_content and len(think_content.strip()) >= 20 else ""
    if (actual.strip() or _clean_think) and not actual.strip().startswith("[ERROR]"):
        _elapsed = time.time() - t0
        _ts = time.strftime("%H:%M:%S")
        _speed = int(len(actual) / _elapsed) if _elapsed > 0 else 0
        save_msgs = history_raw + [
            {"role": "user", "content": message, "ts": _ts},
            {"role": "assistant", "content": actual or "[思考已中断]", "ts": time.strftime("%H:%M:%S"),
             "think": _clean_think,
             "model": model_choice, "chars": len(actual),
             "time": _elapsed, "speed": _speed,
             "task_type": saved_task_type or "text",
             "action_mode": ctx.action_mode or "chat",
             # P6 修复: 服务端终止保存必须带 _aborted 标记
             "_aborted": True, "_abort_reason": "user_stop"}
        ]
        save_chat(chat_file, save_msgs)
        log.info("[SAVE] 中途停止，已保存 %d 字 + think %d 字" % (len(actual), len(_clean_think)))
