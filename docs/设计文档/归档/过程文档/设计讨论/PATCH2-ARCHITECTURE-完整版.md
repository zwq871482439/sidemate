# Sidemate Patch2 — SSE 管道拆分架构

> 作者：高见远（Gao） | 日期：2026-06-06 | 状态：设计稿

## 1. 问题分析

### 1.1 现状

`chat.py` 的 `sse_gen()` 是一个 ~580 行的闭包生成器，不管 `ai_mode` 是 local 还是 cloud，所有请求都走同一条管道。

**管道内对云端无用的本地防护栏：**

| 防护栏 | 位置（sse_gen 行号） | 云端是否需要 |
|--------|----------------------|-------------|
| drift detect (Jaccard 重叠度) | L275-296 | 不需要 — 大模型上下文窗口 128K+ |
| context guard (>85% 警告, >95% 新建) | L381-418 | 不需要 — 应走压缩而非新建 |
| action_router (/xx 指令) | L424-432 | **需要** — 两种模式共用 |
| strategy + task_classify | L434-437 | 不需要 — 云模型不需要采样参数 |
| response_filter (语义重复截断) | L728-786 | 不需要 — 大模型不会语义重复 |
| auto_continue (输出不完整续写) | L679-715 | 不需要 — 大模型输出完整 |
| think:false (强制关闭思考) | StreamEngine 内 | 不需要 — 云模型有 reasoning_content |

### 1.2 SSE 流不工作

当前 `StreamingResponse` 在第一个 yield 后停止消费。根本原因可能是：

1. 生成器闭包内 `nonlocal` 变量与 `StreamingResponse` 的异步消费冲突
2. 闭包嵌套层级过深（`sse_gen()` 是在 `api_chat_stream()` 内部定义的闭包）
3. `_gen_done`/`generate_queue` 的同步 Event/Lock 阻塞了 ASGI 事件循环

**解决方案**：将 `sse_gen()` 从闭包改为**接收参数的纯函数生成器**，避免 `nonlocal`。同时将同步阻塞操作移到线程池。

## 2. 文件结构

### 2.1 新增文件

```
server/
  pipelines/
    __init__.py              # 管道注册 + 路由
    _base.py                 # SSEPipeline 基类 + 共享工具函数
    cloud_pipeline.py        # 云端管道（干净直通）
    local_pipeline.py        # 本地管道（保留全部防护栏）
```

### 2.2 修改文件

| 文件 | 修改内容 | 理由 |
|------|---------|------|
| `routers/chat.py` | 替换 `sse_gen()` 为调用 `pipelines` 模块 | 解耦路由层与管道逻辑 |
| `core/cloud_engine.py` | 无修改 | CloudEngine.run() 输出协议不变 |
| `core/stream_engine.py` | 无修改 | StreamEngine.run() 输出协议不变 |
| `session/chat_store.py` | 无修改 | save_chat/load_chat 不变 |
| `session/context_cache.py` | 无修改 | 共享函数不变 |

### 2.3 不动的文件

- `core/model_manager.py` — `chat_stream()` 路由逻辑不变
- `core/prompt_builder.py` — 本地管道继续使用
- `intelligence/*` — 全部保留，本地管道继续使用
- `actions/*` — Research/Doc action 逻辑不变
- `prompts.py` — 不变

## 3. 函数签名

### 3.1 `pipelines/_base.py` — 共享工具

```python
from dataclasses import dataclass, field
from typing import Generator, Optional, List


@dataclass
class StreamContext:
    """管道上下文 — 封装所有请求参数，避免闭包 nonlocal"""
    # 请求参数
    message: str
    model_name: str
    max_tokens: Optional[int]
    chat_file: str
    history_raw: List[dict]
    action_mode: str  # "chat"|"kb"|"doc"|"research"
    file_path: Optional[str]
    ai_mode: str  # "local"|"cloud"

    # 注入的依赖
    mgr: object  # ModelManager
    kb: object   # KnowledgeBase

    # 处理后的中间状态
    prompt: str = ""
    llm_history: Optional[List[dict]] = None
    context_cache: Optional[str] = None
    drift_hint: str = ""
    drift_result: dict = field(default_factory=dict)
    strategy: dict = field(default_factory=dict)
    model_choice: str = ""


def sse_event(event_type: str, data: dict) -> str:
    """构造标准 SSE 事件字符串

    格式: 'data: {"type":"xxx",...}\n\n'
    前端通过 JSON.parse(event.data) 消费
    """
    ...


def yield_engine_tokens(
    engine_gen,  # mgr.chat_stream() 的生成器
    ctx: StreamContext,
) -> Generator[tuple, None, None]:
    """通用引擎 token → SSE 事件转换

    消费 engine yield 的 (phase, content)，输出:
      ("sse", sse_event_string)
      ("think_start", None)
      ("think_token", content)
      ("think_end", think_len)
      ("task_type", (type, conf))
      ("raw_text", content)
      ("response_text", content)

    返回值统一，上层管道只需要循环 yield
    """
    ...


def save_conversation(
    ctx: StreamContext,
    message: str,
    response_text: str,
    raw_text: str,
    think_content: str,
    think_folded: bool,
    model_choice: str,
    elapsed: float,
    saved_task_type: str,
) -> Generator[str, None, None]:
    """保存对话 — 生成 SSE 事件

    两种模式共用。输出:
      sse_event("compress", ...)
      sse_event("done", ...)
      sse_event("truncate", ...)
      'data: [DONE]\n\n'
    """
    ...
```

### 3.2 `pipelines/cloud_pipeline.py` — 云端管道

```python
def run_cloud_pipeline(ctx: StreamContext) -> Generator[str, None, None]:
    """云端 SSE 管道 — 干净直通

    步骤：
      1. 上下文 >75% 自动压缩（云端特有）
      2. action_router 解析 /xx 指令（共享）
      3. KB 检索（如果 action=kb，共享）
      4. Research/Doc action 分支（共享）
      5. CloudEngine → OpenAI SDK stream
      6. 保存对话（共享）

    Yields:
      str — SSE 事件字符串 'data: {...}\n\n'
    """
    ...
```

### 3.3 `pipelines/local_pipeline.py` — 本地管道

```python
def run_local_pipeline(ctx: StreamContext) -> Generator[str, None, None]:
    """本地 SSE 管道 — 保留全部防护栏

    步骤：
      1. drift detect → 话题漂移检测
      2. context guard → 上下文 >85% 警告 / >95% 新建
      3. action_router 解析 /xx 指令
      4. strategy + task_classify → 策略路由 + 温度/采样调参
      5. KB 检索（如果 action=kb）
      6. StreamEngine → Ollama /api/chat, think:false
      7. response_filter → 语义重复截断
      8. auto_continue → 输出不完整续写
      9. 保存对话

    Yields:
      str — SSE 事件字符串 'data: {...}\n\n'
    """
    ...
```

### 3.4 `pipelines/__init__.py` — 管道路由

```python
def create_pipeline(ctx: StreamContext) -> Generator[str, None, None]:
    """根据 ctx.ai_mode 路由到对应管道

    Returns:
      Generator[str, None, None] — yield SSE 事件字符串
    """
    if ctx.ai_mode == "cloud":
        from pipelines.cloud_pipeline import run_cloud_pipeline
        return run_cloud_pipeline(ctx)
    else:
        from pipelines.local_pipeline import run_local_pipeline
        return run_local_pipeline(ctx)
```

### 3.5 `routers/chat.py` — 入口点改造

```python
@router.post("/api/chat/stream")
async def api_chat_stream(request: Request):
    """SSE 流式对话 — 管道拆分版"""
    # ... 参数解析、验证、文件处理（不变） ...

    # 构建 StreamContext
    ctx = StreamContext(
        message=message,
        model_name=model_name,
        max_tokens=max_tokens,
        chat_file=chat_file,
        history_raw=history_raw,
        action_mode=action_mode,
        file_path=file_path,
        ai_mode=_ai_mode,
        mgr=mgr,
        kb=kb,
        prompt=prompt,
        llm_history=llm_history,
        context_cache=context_cache,
        drift_result=drift_result,
        model_choice=model_choice,
    )

    from pipelines import create_pipeline
    return StreamingResponse(
        create_pipeline(ctx),
        media_type="text/event-stream",
    )
```

## 4. 数据流

### 4.1 云端管道数据流

```
Request → api_chat_stream()
  │
  ├─ 1. 解析参数、验证（chat.py，不变）
  ├─ 2. 文件处理（prompt 拼接，chat.py，不变）
  ├─ 3. 构建 StreamContext（chat.py）
  │
  └─ 4. StreamingResponse(create_pipeline(ctx))
       │
       └─ run_cloud_pipeline(ctx)
            │
            ├─ A. 云端上下文压缩 (>75%)
            │     └─ yield SSE: {"type":"compress", ...}
            │
            ├─ B. action_router (/xx 指令)
            │     └─ 共享逻辑
            │
            ├─ C. 分支判断
            │     ├─ action=research → run_research_action()
            │     ├─ action=doc → run_doc_action()
            │     └─ action=chat|kb → 继续下方
            │
            ├─ D. KB 检索（如果 action=kb）
            │     └─ yield SSE: {"type":"mode_hint", ...}
            │     └─ yield SSE: {"type":"kb_sources", ...}
            │
            ├─ E. CloudEngine.run() → OpenAI SDK stream
            │     └─ yield_engine_tokens() 转换
            │         ├─ yield SSE: {"type":"task_type", ...}
            │         ├─ yield SSE: {"type":"think_start"}
            │         ├─ yield SSE: {"type":"think_token", ...}
            │         ├─ yield SSE: {"type":"think_end", ...}
            │         └─ yield SSE: {"type":"token", ...}
            │
            ├─ F. 保存对话
            │     └─ save_conversation() 共享函数
            │         ├─ yield SSE: {"type":"done", ...}
            │         └─ yield 'data: [DONE]\n\n'
            │
            └─ finally: 中途停止保存
```

### 4.2 本地管道数据流

```
Request → api_chat_stream()
  │
  ├─ 1-3. 同上
  │
  └─ 4. StreamingResponse(create_pipeline(ctx))
       │
       └─ run_local_pipeline(ctx)
            │
            ├─ A. drift detect
            │     └─ yield SSE: {"type":"topic_drift", ...}
            │
            ├─ B. context guard
            │     ├─ >95% → yield SSE: {"type":"context_force_new", ...}
            │     └─ >85% → yield SSE: {"type":"context_warning", ...}
            │
            ├─ C. action_router (/xx 指令)
            │     └─ 共享逻辑
            │
            ├─ D. strategy + task_classify
            │     └─ 采样参数调参（温度、top_p、repeat_penalty）
            │
            ├─ E. KB 检索（如果 action=kb）
            │
            ├─ F. StreamEngine.run() → Ollama /api/chat
            │     └─ yield_engine_tokens() 转换
            │         ├─ yield SSE: {"type":"task_type", ...}
            │         ├─ yield SSE: {"type":"mode_hint", ...}
            │         ├─ yield SSE: {"type":"token", ...}
            │         ├─ yield SSE: {"type":"fold", ...}
            │         └─ yield SSE: {"type":"reload", ...}
            │
            ├─ G. 正文缺失续写（think 占满输出时）
            │     └─ 二次 chat_stream → yield SSE: {"type":"token", ...}
            │
            ├─ H. auto_continue（输出不完整时）
            │     └─ 三次 chat_stream → yield SSE: {"type":"token", ...}
            │
            ├─ I. response_filter
            │     └─ yield SSE: {"type":"filter", ...}
            │
            ├─ J. 保存对话
            │     └─ save_conversation() 共享函数
            │
            └─ finally: 中途停止保存
```

## 5. 共享逻辑提取

### 5.1 提取到 `_base.py` 的共享函数

| 函数 | 来源 | 说明 |
|------|------|------|
| `sse_event()` | chat.py 内联 | SSE 事件构造（`'data: {...}\n\n'`） |
| `yield_engine_tokens()` | chat.py L596-625 | 引擎 (phase,content) → SSE 转换 |
| `save_conversation()` | chat.py L717-897 | 对话保存 + done 事件 |
| `handle_kb_retrieval()` | chat.py L441-460 | KB 检索 + mode_hint 事件 |
| `handle_file_upload()` | chat.py L227-264 | 文件/KB doc_id 引用处理 |
| `handle_action_router()` | chat.py L424-432 | /xx 指令解析 |
| `handle_research_action()` | chat.py L469-528 | Research 分支 |
| `handle_doc_action()` | chat.py L530-588 | Doc 分支 |

### 5.2 保留在 chat.py 的逻辑

- 参数解析、验证（ChatRequest 构造）
- 错误处理（早期返回 StreamingResponse）
- 无模型防护
- KB 忙碌检查

### 5.3 不提取、各自实现的逻辑

| 逻辑 | 云端管道 | 本地管道 |
|------|---------|---------|
| 上下文处理 | >75% 自动压缩 | >85% 警告, >95% 新建 |
| 策略路由 | 不做 | resolve_strategy + 采样调参 |
| response_filter | 不做 | filter_response + 语义截断 |
| auto_continue | 不做 | is_output_incomplete + 续写 |
| 正文缺失续写 | 不做 | think 占满时二次生成 |

## 6. 关键设计决策

### 6.1 StreamContext 数据类替代闭包

**决策**：用 `@dataclass` 的 `StreamContext` 传递所有参数，彻底消除 `nonlocal`。

**理由**：
- 当前 `sse_gen()` 闭包通过 `nonlocal` 引用外层 `api_chat_stream()` 的 ~20 个局部变量
- 闭包变量在生成器暂停/恢复时行为不可预测，可能与 StreamingResponse 消费冲突
- 数据类使数据流显式化，方便调试和测试

### 6.2 生成器函数而非类方法

**决策**：管道是**顶层生成器函数**，不是类方法。

```python
# 采用
def run_cloud_pipeline(ctx: StreamContext) -> Generator[str, None, None]:
    yield sse_event("token", {"content": "..."})

# 不采用
class CloudPipeline:
    def run(self, ctx: StreamContext) -> Generator[str, None, None]:
        yield ...
```

**理由**：
- 生成器函数天然支持 `yield`，类方法需要额外的 `__iter__` 协议
- FastAPI 的 `StreamingResponse` 直接消费生成器
- 减少样板代码

### 6.3 SSE 事件格式严格兼容前端

**决策**：所有管道输出的 SSE 事件格式完全一致：

```
data: {"type":"token","content":"..."}\n\n
data: {"type":"done","model":"...","chars":123,"think_chars":0,"time":1.5,"speed":82.0,"task_type":"text"}\n\n
data: [DONE]\n\n
```

**前端消费的事件类型清单**（不可改变）：

| type | 用途 | 两种管道都必须输出 |
|------|------|-------------------|
| `token` | 流式 token | 是 |
| `done` | 生成完成 | 是 |
| `[DONE]` | 流结束标记 | 是 |
| `error` | 错误 | 是 |
| `task_type` | 任务分类 | 是 |
| `topic_drift` | 话题漂移 | 仅本地 |
| `context_warning` | 上下文警告 | 仅本地 |
| `context_force_new` | 强制新建 | 仅本地 |
| `compress` | 压缩 | 仅云端 |
| `fold` | 思考折叠 | 两种 |
| `think_start` | 思考开始 | 两种 |
| `think_token` | 思考 token | 两种 |
| `think_end` | 思考结束 | 两种 |
| `mode_hint` | 模式提示 | 两种 |
| `kb_sources` | KB 来源 | 两种 |
| `slash_hint` | /xx 提示 | 两种 |
| `filter` | 过滤结果 | 仅本地 |
| `truncate` | 空回复替换 | 两种 |
| `model_reload` | 模型重载 | 仅本地 |
| `doc_outline` | 文档提纲 | 两种(doc) |
| `doc_ready` | 文档下载 | 两种(doc) |
| `doc_error` | 文档错误 | 两种(doc) |
| `debug` | 调试 | 可选 |

### 6.4 漂移检测移到本地管道

**决策**：`check_topic_drift()` 只在本地管道执行。

**理由**：
- 云端模型上下文窗口 128K-1M tokens，不会因为话题切换而"溢出"
- 漂移检测依赖 Jaccard 关键词重叠度，对云端大模型无意义
- 如果需要，云端用自动压缩替代漂移检测

### 6.5 策略路由本地保留、云端跳过

**决策**：
- 本地管道：完整 `resolve_strategy()` + `STRATEGY_CONFIG_V2` 采样参数调参
- 云端管道：跳过策略路由，使用 `temperature=0.7` 固定值

**理由**：
- 本地 4B 小模型需要温度/采样参数调整来防止循环和重复
- 云端大模型自带良好的采样行为，覆盖参数反而可能降低质量
- CloudEngine.run() 已经在内部设置了 `temperature=0.7`

### 6.6 Research/Doc 分支在两种管道中共享

**决策**：`run_research_action()` 和 `run_doc_action()` 在两种管道中都通过相同的 `for phase, content in run_xxx_action()` 循环调用。

**理由**：
- 这些 action 已经是独立模块，输入/输出协议清晰
- Research 只在云端可用（已有限制检查）
- Doc 两种模式共用（已确认）

## 7. 实现任务列表

### Phase 1: 基础设施（无功能变化）

| # | 任务 | 依赖 | 预估 |
|---|------|------|------|
| 1.1 | 创建 `pipelines/__init__.py` + `_base.py` 骨架 | 无 | 10min |
| 1.2 | 实现 `StreamContext` 数据类 | 1.1 | 5min |
| 1.3 | 实现 `sse_event()` 工具函数 | 1.1 | 5min |
| 1.4 | 实现 `yield_engine_tokens()` 通用转换器 | 1.2, 1.3 | 15min |
| 1.5 | 实现 `save_conversation()` 共享函数 | 1.2, 1.3 | 20min |
| 1.6 | 实现 `handle_kb_retrieval()` | 1.2, 1.3 | 10min |
| 1.7 | 实现 `handle_action_router()` | 1.2, 1.3 | 5min |
| 1.8 | 实现 `handle_file_upload()` | 1.2 | 10min |
| 1.9 | 实现 `handle_research_action()` SSE 转换 | 1.3 | 10min |
| 1.10 | 实现 `handle_doc_action()` SSE 转换 | 1.3 | 10min |

### Phase 2: 管道实现

| # | 任务 | 依赖 | 预估 |
|---|------|------|------|
| 2.1 | 实现 `cloud_pipeline.py` — 完整云端管道 | 1.* | 30min |
| 2.2 | 实现 `local_pipeline.py` — 完整本地管道 | 1.* | 30min |
| 2.3 | 实现 `pipelines/__init__.py` 路由函数 | 2.1, 2.2 | 5min |

### Phase 3: 接入 + 验证

| # | 任务 | 依赖 | 预估 |
|---|------|------|------|
| 3.1 | 改造 `routers/chat.py` — 替换 sse_gen() | 2.3 | 20min |
| 3.2 | 删除 `sse_gen()` 旧代码 | 3.1 | 5min |
| 3.3 | 端到端测试 — 云端管道 SSE 流正常 | 3.1 | 15min |
| 3.4 | 端到端测试 — 本地管道 SSE 流正常 | 3.1 | 15min |
| 3.5 | 测试 Research/Doc action 在两种模式下正常 | 3.3, 3.4 | 10min |
| 3.6 | 删除 `chat.py` 中不再需要的兼容别名 | 3.2 | 5min |

### 依赖关系图

```
Phase 1 (1.1-1.10) ─→ Phase 2 (2.1-2.3) ─→ Phase 3 (3.1-3.6)
  └─ 并行实现共享函数              └─ 可并行开发两条管道    └─ 顺序执行
```

## 8. SSE 流不工作问题的额外诊断

### 8.1 可能根因分析

当前 `sse_gen()` 闭包内存在以下同步阻塞操作：

1. **L336-340**: `mgr._gen_done.wait(timeout=10.0)` — 同步 Event.wait 阻塞 ASGI 事件循环
2. **L344-346**: `time.sleep(0.3)` 循环等待 — 同步 sleep 阻塞
3. **L591**: `mgr.chat_stream()` 内部的 `_gen_done.clear()` 和 `generate_queue.submit()` — 同步操作

FastAPI 的 `StreamingResponse` 在 ASGI 中消费生成器时，如果生成器内执行了同步阻塞操作，会阻塞整个事件循环，导致后续 yield 无法被消费。

### 8.2 修复策略

**短期（管道拆分时一起修复）**：
- 将 `sse_gen()` 改为纯函数生成器（无闭包、无 nonlocal）
- 在 `api_chat_stream()` 中预计算所有同步操作（drift detect、文件处理、context_cache），生成器内不再阻塞
- 生成器内的 `chat_stream()` 已经是异步友好的（yield 每个立即返回）

**长期（可选）**：
- 用 `async for` + `anyio.from_thread.run()` 包装同步引擎调用
- 或将引擎改为原生 async

### 8.3 管道拆分后的生成器结构

```python
def run_cloud_pipeline(ctx: StreamContext) -> Generator[str, None, None]:
    # 无同步阻塞 — 所有预处理在 api_chat_stream() 中完成
    # 生成器只做: yield sse_event(...)

    # 唯一的"阻塞"是 for phase, content in engine_gen:
    # 但每个 yield 立即返回一个 token，不会长时间阻塞
    for phase, content in mgr.chat_stream(...):
        yield sse_event("token", {"content": content})
```

## 9. 代码量估算

| 文件 | 预估行数 |
|------|---------|
| `pipelines/__init__.py` | ~15 |
| `pipelines/_base.py` | ~250 |
| `pipelines/cloud_pipeline.py` | ~120 |
| `pipelines/local_pipeline.py` | ~280 |
| `routers/chat.py`（改造后） | ~320（减少 ~580 行） |
| **总计** | ~985（净增 ~100 行，但逻辑清晰度大幅提升） |

## 10. 风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| SSE 事件格式不一致导致前端崩溃 | 高 | 端到端测试 + 事件类型清单对照 |
| 生成器内同步阻塞导致流停止 | 高 | 预计算所有同步操作，生成器只做 yield |
| save_chat 竞态条件 | 中 | 保持现有 _chat_save_lock |
| 管道拆分后 cloud 模式缺少必要逻辑 | 中 | 仔细审查云端管道，确保 research/doc 正常 |
| 本地管道遗漏防护栏 | 低 | 完整保留所有现有逻辑，只做提取不改行为 |
