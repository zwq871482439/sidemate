# -*- coding: utf-8 -*-
"""
core/step_model.py — 统一步骤流数据模型（Step Flow Model）

设计：
  一条 AI 消息 = steps 数组（扁平，每个 step 有 group 字段标记并发）
              + 独立 content 字段（最终正文）

  Step.status: pending / running / done / error
  Step.output: StepOutput {type, data}
    type ∈ {text, thinking, sources, transform, tool}
      text     — 流式文本（生成正文）
      thinking — 流式文本（思考）
      sources  — [{label, snippet, tokens}] 检索来源
      transform— {original, result}（reformulate / 关键词提取）
      tool     — {tool, input, result} 工具调用
  Step.group: 相同 group = 并发（如 parallel 的 phase_1）
  Step.thinking: 生成类步骤的思考内容（属性，渲染时与正文隔离）

本模型替代（阶段2 各 pipeline 往此靠拢）：
  - local_pipeline 的 agent_timeline(step=reformulate/search) + kb_reformulate + kb_sources
  - parallel_pipeline 的 agent_timeline(step=retrieve/local_gen/cloud_gen/merge)
  （cloud_pipeline 的 agent_status 工具时间线 → tool 类 output，后续阶段接入）

阶段1 只定义模型与适配函数，不改任何 pipeline。step_to_sse() 产出的事件
逐字节兼容现有前端 _handleAgentTimelineSSE 协议，所以"定义但不用"不破坏行为。

不依赖 SSE 协议；SSE 适配通过 step_to_sse() 薄适配层完成（延迟 import
pipelines._base.sse_event，避免循环——项目既有模式，见 local_pipeline.py:83）。
"""

import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

# ============================================================
#  类型常量（用字符串字面量，便于 to_dict 序列化）
# ============================================================

# Step.status 合法取值
STEP_STATUSES = ("pending", "running", "done", "error")
# StepOutput.type 合法取值
STEP_OUTPUT_TYPES = ("text", "thinking", "sources", "transform", "tool")


# ============================================================
#  output 子结构（对应每种 type 的 data 形态）
# ============================================================

@dataclass
class SourcesItem:
    """sources output 的单个来源项（检索命中的文档）"""
    label: str                                  # 文档名/标题
    snippet: str = ""                           # 命中片段
    tokens: Optional[int] = None                # 该来源消耗的 token 数（可选，KB 检索可填）

    def to_dict(self) -> dict:
        d: Dict[str, Any] = {"label": self.label, "snippet": self.snippet}
        if self.tokens is not None:
            d["tokens"] = self.tokens
        return d


@dataclass
class TransformData:
    """transform output 的 data（reformulate / 关键词提取）

    兼容现有 kb_reformulate 事件的 {original, reformulated, changed}，
    统一为 {original, result}（result = reformulated / 关键词串）。
    """
    original: str                               # 原始输入
    result: str                                 # 转换后结果
    changed: bool = False                       # result 是否与 original 不同

    def to_dict(self) -> dict:
        return {"original": self.original, "result": self.result, "changed": self.changed}


@dataclass
class ToolData:
    """tool output 的 data（工具调用）

    兼容 cloud_pipeline 的 agent_status 工具时间线，统一为 {tool, input, result}。
    input/result 为任意结构，按工具类型自定（search 的 query/count、fetch 的 url/length 等）。
    """
    tool: str                                   # 工具标识（search_web/fetch_url/search_kb/...）
    input: Dict[str, Any]                       # 输入参数（query/url/...）
    result: Dict[str, Any]                      # 输出结果（count/snippets/length/...）

    def to_dict(self) -> dict:
        return {"tool": self.tool, "input": self.input, "result": self.result}


# ============================================================
#  StepOutput —— output 容器 {type, data}
# ============================================================

@dataclass
class StepOutput:
    """步骤输出。data 的结构由 type 决定。

    流式类型（text/thinking）的 data 是字符串；
    快照类型（sources/transform/tool）的 data 是对应 dataclass 或 dict。
    """
    type: str                                   # STEP_OUTPUT_TYPES 之一
    data: Any                                   # str | List[dict] | dict | dataclass

    def to_dict(self) -> dict:
        # dataclass 子结构统一转 dict；纯 str/list/dict 原样保留
        if hasattr(self.data, "to_dict"):
            return {"type": self.type, "data": self.data.to_dict()}
        return {"type": self.type, "data": self.data}


# ============================================================
#  Step —— 单个步骤
# ============================================================

@dataclass
class Step:
    """单个步骤（扁平 steps 数组的一项）。

    生命周期：pending → running → done | error
    并发关系：相同 group 的 step 视为并发（如 parallel 的 phase_1:
              retrieve + local_gen + cloud_gen 同时推进）。

    用法：
        s = Step(id="search", label="检索文库")
        yield step_to_sse(s, "start")          # 发 agent_timeline start
        s.mark_running()
        result = kb.search(...)
        s.output = StepOutput("sources", [SourcesItem(label, snippet) ...])
        s.mark_done()
        yield step_to_sse(s, "done")           # 发 agent_timeline done（含 count）
        yield step_output_to_sse(s)            # 发 kb_sources 内容事件
    """
    id: str                                     # 唯一标识（retrieve/local_gen/reformulate/...）
    label: str                                  # 步骤中文名（前端直接渲染）
    status: str = "pending"                     # STEP_STATUSES 之一
    group: Optional[str] = None                 # 并发分组（None = 串行/独立）
    output: Optional[StepOutput] = None         # 步骤输出（None = 纯进度步骤）
    elapsed_ms: Optional[int] = None            # 耗时（毫秒，done 时填）
    thinking: Optional[str] = None              # 生成类步骤的思考内容（text/thinking 共用）
    error: Optional[str] = None                 # error 时填的错误文本
    # output 专属耗时（毫秒）。transform 类 output（如 reformulate）有自己的耗时，
    # 透传给前端的 kb_reformulate 事件（前端 chat.js:280 读 d.elapsed 渲染"X.Xs"）。
    output_elapsed_ms: Optional[int] = None

    # 内部计时锚点（不序列化）
    _start_ts: Optional[float] = field(default=None, repr=False, compare=False)

    # ---- 生命周期方法 ----

    def mark_running(self) -> None:
        """标记为运行中，并记录开始时间（用于自动算 elapsed_ms）"""
        self.status = "running"
        if self._start_ts is None:
            self._start_ts = time.time()

    def mark_done(self, elapsed_ms: Optional[int] = None) -> None:
        """标记为完成。elapsed_ms 不传则自动由开始时间计算。"""
        self.status = "done"
        if elapsed_ms is not None:
            self.elapsed_ms = int(elapsed_ms)
        elif self._start_ts is not None:
            self.elapsed_ms = int((time.time() - self._start_ts) * 1000)

    def mark_error(self, error: str, elapsed_ms: Optional[int] = None) -> None:
        """标记为失败，记录错误文本。"""
        self.status = "error"
        self.error = error
        if elapsed_ms is not None:
            self.elapsed_ms = int(elapsed_ms)
        elif self._start_ts is not None:
            self.elapsed_ms = int((time.time() - self._start_ts) * 1000)

    # ---- 序列化 ----

    def to_dict(self) -> dict:
        """转 dict（持久化到 messages.json 的 steps 字段用）。"""
        d: Dict[str, Any] = {
            "id": self.id,
            "label": self.label,
            "status": self.status,
        }
        if self.group is not None:
            d["group"] = self.group
        if self.output is not None:
            d["output"] = self.output.to_dict()
        if self.elapsed_ms is not None:
            d["elapsed_ms"] = self.elapsed_ms
        if self.output_elapsed_ms is not None:
            d["output_elapsed_ms"] = self.output_elapsed_ms
        if self.thinking:
            d["thinking"] = self.thinking
        if self.error:
            d["error"] = self.error
        return d


# ============================================================
#  反序列化（从历史 messages.json 重建）
# ============================================================

def step_from_dict(d: dict) -> Step:
    """从 dict 重建 Step（读取历史消息时用）。

    兼容旧 agent_timeline 的 step 字段：若没有 id 则用 step 兜底。
    """
    output = None
    o = d.get("output")
    if o and isinstance(o, dict):
        output = StepOutput(type=o.get("type", "text"), data=o.get("data"))
    return Step(
        id=d.get("id") or d.get("step", ""),    # 兼容旧 agent_timeline 的 step 字段
        label=d.get("label") or d.get("step", ""),
        status=d.get("status", "done"),
        group=d.get("group"),
        output=output,
        elapsed_ms=d.get("elapsed_ms"),
        output_elapsed_ms=d.get("output_elapsed_ms"),
        thinking=d.get("thinking"),
        error=d.get("error"),
    )


# ============================================================
#  SSE 适配层
# ============================================================

def step_to_sse(step: Step, phase: str = "start") -> str:
    """把 Step 的生命周期事件转成 SSE 事件字符串。

    兼容前端现有 _handleAgentTimelineSSE 协议：
      phase="start" → {type:agent_timeline, phase:start, step:<id>, label:<label>}
      phase="done"  → {type:agent_timeline, phase:done,  step:<id>, label:<label>,
                        elapsed_ms:<int>, count?:<int>}

    Args:
        step: Step 实例
        phase: "start" | "done"（前端目前只认这两个）

    Returns:
        str — 'data: {...}\\n\\n'
    """
    # 延迟 import 避免循环依赖（项目既有模式）
    from pipelines._base import sse_event

    payload: Dict[str, Any] = {
        "step": step.id,                        # 前端协议字段名是 step，对齐 step.id
        "phase": phase,
        "label": step.label,
    }
    if phase == "done":
        if step.elapsed_ms is not None:
            payload["elapsed_ms"] = step.elapsed_ms
        # sources 类 output 自动抽 count（兼容前端 _handleAgentTimelineSSE 读 count）
        if step.output and step.output.type == "sources" and isinstance(step.output.data, list):
            payload["count"] = len(step.output.data)
    return sse_event("agent_timeline", payload)


def step_output_to_sse(step: Step) -> Optional[str]:
    """把 Step 的 output 内容转成对应的 SSE 内容事件（与 agent_timeline 平行发射）。

    映射（兼容现有前端事件名）：
      text      → sse_event("token", {content})
      thinking  → sse_event("think_token", {content})
      sources   → sse_event("kb_sources", {sources})
      transform → sse_event("kb_reformulate", {original, reformulated, changed})
      tool      → sse_event("agent_status", {...工具字段})

    Returns:
        str | None — SSE 事件字符串；无 output 或不支持返回 None
    """
    from pipelines._base import sse_event

    if not step.output:
        return None
    o = step.output
    # 统一把 dataclass 子结构归一成 dict（transform/tool 可能传 TransformData/ToolData 对象）
    raw = o.data.to_dict() if hasattr(o.data, "to_dict") else o.data
    if o.type == "text" and isinstance(raw, str):
        return sse_event("token", {"content": raw})
    if o.type == "thinking" and isinstance(raw, str):
        return sse_event("think_token", {"content": raw})
    if o.type == "sources" and isinstance(raw, list):
        return sse_event("kb_sources", {"sources": raw})
    if o.type == "transform" and isinstance(raw, dict):
        # 兼容现有 kb_reformulate 字段名（reformulated 而非 result）
        payload = {
            "original": raw.get("original", ""),
            "reformulated": raw.get("result", ""),
            "changed": raw.get("changed", False),
        }
        # 透传 output 耗时（前端 chat.js:280 读 d.elapsed 渲染"X.Xs"）
        if step.output_elapsed_ms is not None:
            payload["elapsed"] = round(step.output_elapsed_ms / 1000, 1)
        return sse_event("kb_reformulate", payload)
    if o.type == "tool" and isinstance(raw, dict):
        return sse_event("agent_status", raw)
    return None


def steps_to_timeline(steps: List[Step]) -> List[dict]:
    """把 steps 数组转成持久化用的 timeline 快照（存 messages.json）。

    与前端 _buildAgentTimelineHtml 兼容：双写 id 和 step 字段
    （旧前端读 item.step，新前端读 item.id），保证过渡期两边都能用。
    """
    timeline: List[dict] = []
    for s in steps:
        item = s.to_dict()
        item["step"] = s.id                     # 兼容旧前端
        timeline.append(item)
    return timeline
