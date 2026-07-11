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
