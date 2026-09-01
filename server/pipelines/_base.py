# -*- coding: utf-8 -*-
"""
pipelines/_base.py — SSE 管道共享基础设施（精简版）

P7-4 架构清理：删除了 7 个零调用的死代码函数（yield_engine_tokens /
handle_action_router / handle_kb_retrieval / handle_doc_action /
save_conversation / save_on_stop / EngineResult），它们是早期设计的
"公共抽象层"，但重构时每个 pipeline 都 inline 了自己的版本，导致
这些函数无人调用却留着误导维护者。

现在只保留三个真正被所有 pipeline 共享的符号：
  - StreamContext：请求上下文数据类
  - sse_event()：SSE 事件格式化
  - _sanitize_output()：输出清洗

三个 pipeline 各自独立维护自己的 KB 引用 / 保存对话 / action 路由逻辑，
不依赖本文件的任何高层抽象。
"""

import re
import json
import logging
from dataclasses import dataclass, field
from typing import Optional, List

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
    # 0.10.1 M1-B 后端单写：stream 入口开局落盘的 user 消息
    user_msg_id: str = ""        # 开局落盘的 user 消息 id（空=未落盘，走 legacy 重建）
    user_msg_saved: bool = False  # user 消息是否已在开局落盘


# ============================================================
#  单写持久化（0.10.1 M1-B：后端为消息唯一写入源）
# ============================================================

def persist_abort(ctx, content, think="", model_choice="", task_type="text",
                  elapsed=0.0, action_mode="chat", fallback_content="[思考已中断]",
                  speed=None, extra=None):
    """中断兜底落盘（0.10.1 M1-C：三管道 finally 的统一入口）。

    - content/think 为已接收的部分输出（会做 strip_think + _sanitize_output + think 清洗）
    - 中断原因自动判定：stop 标志 → user_stop，否则 network_error
    - 无有效内容（正文与思考都空）不落盘，返回 False
    - extra：附加字段（如 parallel 的 parallel_texts/kb_sources）

    Returns:
        bool — 是否已落盘
    """
    import time as _t
    try:
        from session.context_cache import clean_think_content_wrapped as _clean_think
        actual = content or ""
        if ctx.mgr is not None:
            actual = ctx.mgr.strip_think(actual)
        actual = _sanitize_output(actual)
        clean_think = _clean_think(think) if think and len(think.strip()) >= 20 else ""
        if not actual.strip() and not clean_think:
            return False
        if actual.strip().startswith("[ERROR]"):
            return False
        _mgr = ctx.mgr
        stopped = bool(_mgr and (getattr(_mgr, "stop_requested", False) or
                                 getattr(_mgr, "_stop_generation", False)))
        msg = {
            "role": "assistant",
            "content": actual or fallback_content,
            "ts": _t.strftime("%H:%M:%S"),
            "think": clean_think,
            "model": model_choice or ctx.model_choice,
            "chars": len(actual),
            "time": elapsed,
            "task_type": task_type,
            "action_mode": action_mode,
            "_aborted": True,
            "_abort_reason": "user_stop" if stopped else "network_error",
        }
        msg.setdefault("engine", ctx.ai_mode or "")
        if speed is not None:
            msg["speed"] = speed
        if extra:
            msg.update(extra)
        persist_turn(ctx, msg)
        log.info("[SAVE] 中断兜底落盘 %d 字 + think %d 字 (reason=%s)",
                 len(actual), len(clean_think), msg["_abort_reason"])
        return True
    except Exception as e:
        log.warning("[SAVE] 中断兜底落盘失败: %s", str(e)[:100])
        return False


def persist_turn(ctx, assistant_msg, context_cache=None):
    """回合落盘：读盘 → 追加 assistant 消息 → 保存。

    单写路径（新）：stream 入口已把 user 消息开局落盘（ctx.user_msg_saved），
    这里从磁盘读出现状（含 user 消息的 _file_tag/发送时刻 ts，不再重建），
    追加 assistant 消息后整体保存——chat_store 的 ts/内容两级匹配合并对
    新消息不再触发（user 消息自始至终只有一条，无人覆写它）。

    Legacy 回退（旧会话/旧前端/开局未落盘）：按历史行为重建
    history_raw + [user, assistant]，save_chat 的两级匹配继续兜底 _file_tag。

    Args:
        ctx: StreamContext
        assistant_msg: assistant 消息 dict；为 None 表示只保 user（空回复场景）
        context_cache: update_session_cache 的产物（None=不动缓存文件）

    Returns:
        (messages, mode) — mode: "append"（单写）/ "legacy"（回退重建）
    """
    from session.chat_store import save_chat, load_chat, _next_msg_id

    # 引擎标记（0.10.1：修复"云端模型显示成离线 AI"——footer 的离线/在线前缀
    # 此前靠 action_mode=='agent' 猜，云 agent 路径 action_mode='chat' 必猜错。
    # 由管道统一打 engine=local/cloud/parallel，前端直读不再猜）
    if assistant_msg is not None:
        assistant_msg.setdefault("engine", ctx.ai_mode or "")

    if ctx.user_msg_saved and ctx.user_msg_id:
        try:
            disk = load_chat(ctx.chat_file) or []
            if disk and disk[-1].get("role") == "user" and disk[-1].get("id") == ctx.user_msg_id:
                if assistant_msg is not None and not assistant_msg.get("id"):
                    assistant_msg["id"] = _next_msg_id(disk)
                if assistant_msg is not None:
                    disk = disk + [assistant_msg]
                save_chat(ctx.chat_file, disk, context_cache=context_cache)
                return disk, "append"
            # 磁盘末条不是本回合的 user 消息（并发写/外部改动）：不回退重建，
            # 直接基于磁盘追加，宁可保住别人的写入也不整表覆写
            if disk:
                if assistant_msg is not None and not assistant_msg.get("id"):
                    assistant_msg["id"] = _next_msg_id(disk)
                if assistant_msg is not None:
                    disk = disk + [assistant_msg]
                save_chat(ctx.chat_file, disk, context_cache=context_cache)
                log.warning("[PERSIST] 磁盘末条非本回合 user（期望 %s），已按磁盘现状追加",
                            ctx.user_msg_id)
                return disk, "append"
        except Exception as e:
            log.warning("[PERSIST] 单写路径异常，回退 legacy: %s", str(e)[:100])

    # legacy 回退：历史行为重建整表（无条件补 user 消息，与旧 pipeline 行为一致；
    # doc_continue 等空 content 场景旧版也照存，这里不擅自改语义）
    messages = list(ctx.history_raw or [])
    new_tail = []
    if not ctx.user_msg_saved:
        import time as _t
        _um = {"role": "user", "content": ctx.message,
               "ts": ctx.body.get("user_ts") or _t.strftime("%H:%M:%S")}
        _ft = ctx.body.get("_file_tag")
        if _ft:
            _um["_file_tag"] = _ft
        new_tail.append(_um)
    if assistant_msg is not None:
        new_tail.append(assistant_msg)
    # 新消息按序分配 id（旧消息无 id 不回填）
    for _m in new_tail:
        if not _m.get("id"):
            _m["id"] = _next_msg_id(messages)
            messages.append(_m)
        else:
            messages.append(_m)
    save_chat(ctx.chat_file, messages, context_cache=context_cache)
    return messages, "legacy"


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
