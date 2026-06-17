# Patch3 架构设计与任务分解

> 架构师：高见远
> 基于：设计方案 v6 + Patch2 源码分析
> 日期：2026-06-08
> 状态：详细设计

---

## 一、实现方案（按批次技术实现策略）

### 1.1 第一批：基础设施（共享）

本批是所有后续批次的前置依赖，改动集中在现有文件的小幅修改。

#### 三源融合 Agent Prompt（A+C方案）

**现状**：`agent_tools.py` 的 `_AGENT_BASE_PROMPT` 是单段固定提示，`get_tools_and_prompt()` 根据是否安装 KB 扩展来决定注册哪些工具。

**改动策略**：
1. 将 `_AGENT_BASE_PROMPT` 替换为 A 段（三渠道说明 + search_kb 优先提示）
2. `get_tools_and_prompt()` 新增参数 `kb_permission: str`，根据值动态拼接 C 段：
   - `full`：调用 `knowledge_base.get_all_tags()` 获取聚合标签，注入 `"知识库标签：合同(12) 季度报告(5)..."`
   - `search-only`：不注入标签，但注册 `search_kb` 工具
   - `disabled`：不注入任何 KB 相关内容，不注册 `search_kb` 工具
3. 从 `TOOL_REGISTRY` 中移除 `list_kb_docs` 条目
4. `search_kb` 的返回值新增 `hint` 字段

**config.py 改动**：在 `DEFAULTS` 中新增 `kb_permission` 键，默认值 `"full"`（离线默认 full，在线默认 search-only，这个逻辑在读取配置时根据 `ai_mode` 调整）。

#### KB 权限三档

**数据流**：前端设置页 → `config.py` 存储 → `chat.py` 路由读取 → 传给 `get_tools_and_prompt(kb_permission=...)`

**前端改动**：设置页"数据发送策略"区域新增下拉选项，三个值对应三个权限。

#### Token 计数器 — 数据采集

**现状**：
- `cloud_engine.py`：SSE 流逐 chunk 解析，最后 `done:true` chunk 包含 `usage` 字段，当前未提取
- `stream_engine.py`：Ollama `/api/chat` 最终帧包含 `prompt_eval_count` + `eval_count`，当前未提取
- `agent_loop.py`：遍历 agent 循环，不关注 token 统计

**改动策略**：
1. `cloud_engine.py` 的 `run()` 和 `run_with_tools()`：解析最后一个 SSE chunk 的 `usage` 字段，在 yield 最终结果时附带 `token_stats` dict
2. `stream_engine.py` 的 `run()`：解析 `done:true` 帧的 `prompt_eval_count` + `eval_count`，在 yield 最终 `(phase, content)` 时附带（可能需要扩展 tuple 或用 EngineResult）
3. `agent_loop.py`：透传 cloud_engine 返回的 `token_stats`，作为新的 SSE phase（如 `"token_stats"`）
4. `_base.py` 的 `EngineResult` 新增 `token_stats: dict | None` 字段
5. `local_pipeline.py` 和 `cloud_pipeline.py`：在保存消息时将 `token_stats` 写入 assistant message
6. `chat_store.py`：assistant message schema 新增可选的 `token_stats` 字段
7. `chat.py`（router）：`_calc_context_usage()` 使用真实 token 数据（而非 chars/1.5 估算）

#### KB 自动启动

**现状**：`server.py` 启动时不自动初始化 KB。前端有手动"加载"/"退出"按钮。

**改动策略**：
1. `server.py` 的 startup 事件中：检测 KB 扩展是否安装（调用 `extensions/registry.py`），若安装则自动调用 `knowledge_base.init()` 启动嵌入+精排
2. `routers/kb.py`：移除 `/api/kb/load` 和 `/api/kb/unload` 两个手动加载/卸载端点
3. 前端 KB 页面：移除"文库已加载 占用 339 MB"显示行和手动按钮，只检查 LLM 预热状态

#### 状态锁改动

**现状**：状态锁同时锁定 KB 整个 Tab（左侧文档管理 + 右侧对话区）。

**改动策略**：
- 前端：状态锁只禁用右侧对话区（输入框 + 发送按钮），左侧文档管理始终可用
- 后端无需改动，纯前端逻辑

#### 移除 Chat Tab KB Action 按钮

**现状**：`chat-actions.js` 中 `BUILTIN_ACTIONS` 包含 `kb` action，在线模式 Agent 模式下显示。

**改动策略**：
- 从 `BUILTIN_ACTIONS` 中移除 `kb` 条目，或在渲染逻辑中过滤掉

---

### 1.2 第二批：轨道A — 本地能力增强

本批在第一批基础上，为离线和在线模式的 KB 功能增加打标、标签展示、Reformulation、自适应记忆等能力。

#### TaggingScheduler（异步打标队列）

**新文件**：`server/core/tagging_scheduler.py`

**设计**：
```python
class TaggingScheduler:
    """异步文档打标调度器，P2 优先级，FIFO"""
    
    def __init__(self, kb: KnowledgeBase, stream_engine: StreamEngine):
        self._queue: asyncio.Queue  # FIFO 队列，元素为 doc_id
        self._running = False
        self._task: asyncio.Task | None = None
    
    async def enqueue(self, doc_id: str):
        """文档上传后调用，加入打标队列"""
    
    async def _worker(self):
        """后台循环：取任务 → 调用 StreamEngine 打标 → 写回 KB 元数据"""
    
    async def start(self):
        """启动后台 worker"""
    
    async def stop(self):
        """停止 worker"""
    
    def get_status(self, doc_id: str) -> str:
        """返回 'pending' / 'done' / 'not_found'"""
```

**关键点**：
- 调用 `StreamEngine.run()` 本地模型生成 tags+summary（单次 LLM 调用，~300 tokens in / 100 out）
- 打标 Prompt 使用 `TAGGING_PROMPT`（在 `prompts.py` 中定义）
- 长文档输入策略：≤3000字用全文，>3000字用 `extract_title_and_first_paragraphs()` 提取标题层级+各段首句
- 打标结果写回 `knowledge_base.py` 的 `KBDocument.tags` 和 `KBDocument.summary`
- 被 P0 抢占时不做复杂断点续传，标记 pending 等 LLM 空闲后重跑

#### 打标 API + 状态查询

**`routers/kb.py` 新增**：
- `GET /api/kb/tagging-status?doc_id=xxx`：返回打标状态
- 文档上传 endpoint 中，上传成功后调用 `tagging_scheduler.enqueue(doc_id)`

#### knowledge_base.py 数据结构改动

**`KBDocument` dataclass 新增字段**：
```python
tags: list[str] = field(default_factory=list)
tag_status: str = "pending"  # "pending" / "done"
```

**新增方法**：
- `get_all_tags() -> dict[str, int]`：聚合所有文档的 tags，按频次降序排序
- `extract_title_and_first_paragraphs(text: str, max_chars: int = 3000) -> str`：方案γ零LLM提取

#### 标签展示 UI

前端 KB 页面"查看文档"按钮：
- `tag_status == "done"` → 展示标签 pills + 摘要文本
- `tag_status == "pending"` → 显示"AI标签完成后显示"

#### System Prompt 标签注入

**`agent_tools.py` 的 `get_tools_and_prompt()` 中**：
```python
if kb_permission == "full":
    tag_counts = knowledge_base.get_all_tags()
    if tag_counts:
        tag_str = " ".join(f"{tag}({count})" for tag, count in tag_counts.items())
        c_segment = f"知识库标签：{tag_str}"
```

MAX_TAGS 上限 = `KB_DOC_LIMIT * 5`（切片时取 top N）。

#### Reformulation 模块

**新文件**：`server/core/reformulate.py`（或整合进 `local_pipeline.py`）

**设计**：
```python
async def reformulate_query(
    query: str,
    history: list[dict],
    stream_engine: StreamEngine,
) -> str:
    """有历史时 reformulate，无历史原样返回"""
    if not history:
        return query
    # 拼接 REFORMULATE_PROMPT，调用 StreamEngine
    # 成本：~100 tokens in / 50 out
```

**触发条件**：KB 对话 Round 2+（有历史时始终做，不区分追问/新问题）

#### 自适应记忆裁剪

**`local_pipeline.py` 改动**：
- 移除固定 0/1/2 记忆级别逻辑
- 新增 `HISTORY_TOKEN_BUDGET = 3000`（在 `config.py` 中可配）
- 从最旧消息开始裁剪，直到历史 token 数 ≤ 预算
- Token 估算：使用 `token_stats.input_tokens`（如有）或 chars/1.5 回退

**`config.py` 新增**：`DEFAULTS["history_token_budget"] = 3000`

#### 上下文指示器（文库 Tab）

复用 Chat Tab 的环形进度组件，但在文库 Tab 对话区顶部显示：
- `[📚 记忆: ████░░░░ 45%]`
- 80% 时变红 + 提示建议新建对话

#### 会话管理

**后端新增**（`routers/kb.py`）：
- `POST /api/kb/session/export`：导出当前对话为 txt
- `POST /api/kb/session/clear`：清空历史，新建对话

**前端**：文库 Tab 对话区新增两个按钮（下载 txt + 新建对话）。

---

### 1.3 第三批：统一调度器 + 轨道B — 私密融合

本批是 Patch3 最复杂的部分，包含调度器统一、Compare Pipeline、双列 UI。

#### LLMScheduler 统一调度

**现状**：`generate_queue.py` 的 `GenerateQueue` 只有 HIGH/LOW 两级，主要用于 Chat。

**改造策略**：
- 重命名/重构为 `LLMScheduler`
- 优先级：P0（Chat/KB对话/纪要）、P2（KB打标）
- P0 之间 FIFO 排队，不互相抢占
- P0 可抢占 P2（P2 当前任务完成后让出）
- 新增排队 UI 反馈：SSE 推送排队状态 + 取消按钮

**关键接口**：
```python
class LLMScheduler:
    async def submit(self, priority: int, task: Callable) -> Ticket:
        """提交任务，返回 Ticket（含排队状态查询）"""
    
    async def cancel(self, ticket_id: str) -> bool:
        """取消排队中的任务"""
    
    def get_queue_status(self) -> list[QueueItem]:
        """获取当前队列状态"""
```

**Ollama 中断机制调研**：需要验证 Ollama 是否支持 cancel API 或断开 SSE 后自动释放资源，决定是否实现真正的抢占。

#### Compare Pipeline

**新文件**：`server/pipelines/compare_pipeline.py`

**核心流程**：
```
用户在文库 Tab 提问 (在线模式 + 对比开关开启)
  ↓
Step0: Reformulation（Round 2+ 有历史时）
  query → reformulate_query() → query'
  ↓
Step1: 并行 asyncio.gather
  ├─ 本地（走 LLMScheduler P0）:
  │   search_kb(query') → rerank → StreamEngine 本地总结
  └─ 云端（独立HTTP，不走调度器）:
      CloudEngine.run(question=query, system=简短system) → 直接回答
  ↓
Step2: 两者 done → LLMScheduler P0
  └─ StreamEngine 本地融合（本地总结 + 云端回答 → 综合分析）
  使用 MERGE_FUSION_PROMPT
  ↓
完成
```

**SSE 多通道**：
```python
yield sse_event("status", {"channel": "local", "phase": "search", "status": "done", "count": 3})
yield sse_event("stream", {"channel": "local", "content": "根据KB..."})
yield sse_event("stream", {"channel": "cloud", "content": "根据公开..."})
yield sse_event("stream", {"channel": "merge", "content": "综合分析..."})
yield sse_event("done", {"channel": "merge"})
```

**双线记忆**：
```python
memory_local = [...]   # 存储融合结果 F（信息最全，本地安全）
memory_cloud = [...]   # 存储云端回答 C（纯云端输出，零泄露）

# Round N 的上下文：
local_context = memory_local  # 融合结果
cloud_context = memory_cloud  # 只有云端自己说过的话
```

#### 管道路由

**`pipelines/__init__.py` 改动**：
```python
def create_pipeline(ctx: StreamContext):
    if ctx.is_kb_compare:  # 新增：文库对比模式
        return run_compare_pipeline(ctx)
    elif ctx.ai_mode == "cloud":
        return run_cloud_pipeline(ctx)
    else:
        return run_local_pipeline(ctx)
```

**`routers/chat.py` 改动**：文库 Tab 对话请求需携带 `kb_compare=True` 标志。

#### 前端双列 UI + 三气泡

**文库 Tab 对话区改动**（大工程）：
- 气泡1：用户提问（现有样式）
- 气泡2：分左右两列
  - 左列 `🔒 本地知识库 · 数据不离开本机`
  - 右列 `🌐 云端AI · 无法访问您的文档`
  - 各自独立的流式展示区
- 气泡3：融合总结 `🔄 综合分析（由本地模型安全融合）`

**前端根据 SSE `channel` 字段分发**：
- `local` → 左列
- `cloud` → 右列
- `merge` → 底部融合气泡

#### 隐私感知 UI（四层防护）

1. 开关说明文字
2. 双列顶部标签（🔒/🌐）
3. 首次弹窗（半持久化开关每次开启时弹出）
4. 融合气泡标注

#### 排队 UI

离线模式 / 极端情况下的 P0 排队：
- SSE 推送 `{"phase": "queued", "position": 2, "message": "文库正在生成中..."}`
- 前端展示排队信息 + 取消按钮
- 取消 → `POST /api/scheduler/cancel` → 从队列移除

---

### 1.4 第四批：收尾打磨

#### 纪要断点续传

**现状**：纪要模块（minutes）生成过程中断后需重头开始。

**改动**：batch 级别断点续传，记录已完成的 batch index，中断后从断点继续。

#### Tooltip 明细展示

Chat Tab 环形计数器 hover 时展示：
```
在线：输入 12.5K | 输出 2.1K | 推理 5.8K | 总消耗 20.4K
离线：输入 6.0K / 8K | 输出 2.1K | 输入满 8K 需新建会话
```

#### MODEL_CAPABILITIES context 字段

**`cloud_engine.py`** 的 `MODEL_CAPABILITIES` 字典已有 `context_window` 字段，确认/补全每个模型的值。

#### 全局联调测试

端到端测试所有批次的功能，确保：
- 离线/在线切换正常
- KB 权限三档正确生效
- Token 计数器数据准确
- Compare Pipeline 双列流式正常
- 调度器抢占逻辑正确
- 中文 Windows 环境无编码问题

---

## 二、文件列表（新增/修改）

### 新增文件

| 文件路径 | 用途 | 批次 |
|---------|------|------|
| `server/core/tagging_scheduler.py` | 异步文档打标队列（P2 优先级，FIFO） | 第二批 |
| `server/core/reformulate.py` | 追问查询补全模块 | 第二批 |
| `server/pipelines/compare_pipeline.py` | 云端AI知识对比管道（并行编排 + SSE 多通道 + 双线记忆） | 第三批 |
| `server/core/llm_scheduler.py` | LLM 统一调度器（P0/P2，重构自 GenerateQueue） | 第三批 |

### 修改文件

| 文件路径 | 改动概述 | 批次 |
|---------|---------|------|
| `server/config.py` | 新增 `kb_permission`、`kb_compare_enabled`、`kb_compare_privacy_read`、`history_token_budget` 配置项 | 第一批 |
| `server/core/agent_tools.py` | 三源融合 Prompt(A+C)、移除 list_kb_docs、search_kb hint、kb_permission 参数 | 第一批 |
| `server/core/cloud_engine.py` | 提取 SSE 最后 chunk 的 usage 字段（prompt_tokens/completion_tokens/reasoning_tokens） | 第一批 |
| `server/core/stream_engine.py` | 提取 Ollama 最终帧 prompt_eval_count + eval_count | 第一批 |
| `server/core/agent_loop.py` | 透传 token_stats phase，search_kb 返回新增 hint | 第一批 |
| `server/pipelines/_base.py` | EngineResult 新增 token_stats 字段 | 第一批 |
| `server/pipelines/local_pipeline.py` | 保存 token_stats、自适应记忆裁剪（砍掉固定 0/1/2） | 第二批 |
| `server/pipelines/cloud_pipeline.py` | 保存 token_stats | 第一批 |
| `server/pipelines/__init__.py` | 新增 compare 管道路由 | 第三批 |
| `server/routers/chat.py` | 写入 token_stats 到 chat.json、更新 `/api/context/usage`、文库对比路由区分 | 第一批+第三批 |
| `server/routers/kb.py` | 新增打标状态 API、会话导出/清空、移除手动加载/卸载 | 第一批+第二批 |
| `server/knowledge_base.py` | KBDocument 新增 tags/tag_status 字段、get_all_tags()、extract_title_and_first_paragraphs() | 第二批 |
| `server/session/chat_store.py` | assistant message schema 新增 token_stats | 第一批 |
| `server/core/generate_queue.py` | 重构/扩展为 LLMScheduler（P0/P2） | 第三批 |
| `server/prompts.py` | 新增 TAGGING_PROMPT、REFORMULATE_PROMPT、MERGE_FUSION_PROMPT | 第二批+第三批 |
| `server/server.py` | KB 自动初始化、tagging_scheduler 启动/停止 | 第一批+第二批 |
| `server/static/js/chat.js` | 环形计数器增强（真实 token 数据 + tooltip 明细） | 第一批+第四批 |
| `server/static/js/chat-actions.js` | 移除 KB Action 按钮 | 第一批 |
| 前端 KB 页面 | 标签展示、双列 UI、三气泡、隐私弹窗、上下文指示器、会话管理、开关 UI、排队 UI | 第一~三批 |
| 前端设置页 | KB 权限三档下拉选项、云端AI知识对比开关 | 第一批+第三批 |

---

## 三、数据结构

### 3.1 新增配置项（config.py DEFAULTS）

```python
DEFAULTS = {
    # ... 现有配置 ...
    
    # 第一批新增
    "kb_permission": "full",           # "full" / "search-only" / "disabled"
    
    # 第二批新增
    "history_token_budget": 3000,      # KB 对话历史 token 预算上限
    
    # 第三批新增
    "kb_compare_enabled": False,       # 云端AI知识对比开关（半持久化）
    "kb_compare_privacy_read": False,  # 隐私弹窗已读标记
}
```

### 3.2 数据模型改动

#### KBDocument（knowledge_base.py）

```python
@dataclass
class KBDocument:
    # ... 现有字段 ...
    doc_id: str
    filename: str
    file_path: str
    file_size: int
    import_time: str
    chunk_count: int
    summary: str = ""          # 改造：从200字预览 → LLM生成~100字摘要
    
    # 新增字段
    tags: list[str] = field(default_factory=list)  # 3-5 个关键词标签
    tag_status: str = "pending"                     # "pending" / "done"
```

#### Chat Message（chat_store.py）

```python
# assistant message 新增可选字段
{
    "role": "assistant",
    "content": "...",
    "timestamp": "2026-06-08T10:00:00",
    "token_stats": {                    # 新增，可选
        "input_tokens": 8523,
        "output_tokens": 421,
        "reasoning_tokens": 3200        # 仅在线模式有值
    }
}
```

#### EngineResult（_base.py）

```python
@dataclass
class EngineResult:
    content: str
    finish_reason: str = "stop"
    token_stats: dict | None = None     # 新增
    # token_stats = {
    #     "input_tokens": int,
    #     "output_tokens": int,
    #     "reasoning_tokens": int | None
    # }
```

### 3.3 SSE 事件格式扩展

#### Compare Pipeline SSE 事件

```python
# 现有事件格式保持不变
data: {"phase": "stream", "content": "..."}

# 新增 channel 字段（仅 compare pipeline）
data: {"channel": "local", "phase": "search", "status": "done", "count": 3}
data: {"channel": "local", "phase": "stream", "content": "根据KB..."}
data: {"channel": "cloud", "phase": "stream", "content": "根据公开..."}
data: {"channel": "merge", "phase": "stream", "content": "综合分析..."}
data: {"channel": "merge", "phase": "done"}

# 排队事件
data: {"phase": "queued", "position": 2, "message": "文库正在生成中，您的请求正在排队"}
```

### 3.4 KB 会话数据结构

```python
# 内存中的 KB 会话（现有结构扩展）
_kb_sessions: dict[str, dict] = {
    "session_id": {
        "turns": [...],                    # 现有
        "memory_local": [...],             # 新增：融合结果历史
        "memory_cloud": [...],             # 新增：云端回答历史
        "mode": "local" | "compare",       # 新增：当前模式
    }
}
```

---

## 四、任务列表（函数级别，按依赖排序）

### 第一批：基础设施

| 任务ID | 任务 | 文件 | 函数/类 | 改动类型 | 依赖 |
|--------|------|------|---------|---------|------|
| 1.1.1 | config.py 新增 kb_permission 配置 | `server/config.py` | `DEFAULTS` | 修改 | 无 |
| 1.1.2 | 三源融合 A 段 Prompt 替换 | `server/core/agent_tools.py` | `_AGENT_BASE_PROMPT` | 修改 | 无 |
| 1.1.3 | get_tools_and_prompt 新增 kb_permission 参数 | `server/core/agent_tools.py` | `get_tools_and_prompt()` | 修改 | 1.1.1, 1.1.2 |
| 1.1.4 | 从 TOOL_REGISTRY 移除 list_kb_docs | `server/core/agent_tools.py` | `TOOL_REGISTRY` | 修改 | 无 |
| 1.1.5 | search_kb 返回值新增 hint 字段 | `server/core/agent_tools.py` | `search_kb()` 工具实现 | 修改 | 无 |
| 1.2.1 | EngineResult 新增 token_stats 字段 | `server/pipelines/_base.py` | `EngineResult` dataclass | 修改 | 无 |
| 1.2.2 | cloud_engine 提取 usage | `server/core/cloud_engine.py` | `run()`, `run_with_tools()` | 修改 | 1.2.1 |
| 1.2.3 | stream_engine 提取 prompt_eval_count + eval_count | `server/core/stream_engine.py` | `run()` | 修改 | 1.2.1 |
| 1.2.4 | agent_loop 透传 token_stats | `server/core/agent_loop.py` | `_run_agent_loop()` | 修改 | 1.2.2 |
| 1.2.5 | chat_store message schema 新增 token_stats | `server/session/chat_store.py` | `_save_message()` | 修改 | 无 |
| 1.2.6 | local_pipeline 保存 token_stats | `server/pipelines/local_pipeline.py` | `_save_and_done()` 或等效函数 | 修改 | 1.2.3, 1.2.5 |
| 1.2.7 | cloud_pipeline 保存 token_stats | `server/pipelines/cloud_pipeline.py` | `_save_and_done()` | 修改 | 1.2.2, 1.2.5 |
| 1.2.8 | chat.py 使用真实 token 数据 | `server/routers/chat.py` | `_calc_context_usage()` | 修改 | 1.2.6, 1.2.7 |
| 1.3.1 | 前端设置页新增 KB 权限三档 | 前端设置页 | 设置 UI | 新增 | 1.1.1 |
| 1.3.2 | 前端环形计数器增强（真实 token） | `server/static/js/chat.js` | `updateContextRing()` | 修改 | 1.2.8 |
| 1.4.1 | server.py KB 自动初始化 | `server/server.py` | startup 事件 | 修改 | 无 |
| 1.4.2 | 移除手动加载/卸载 API | `server/routers/kb.py` | `/api/kb/load`, `/api/kb/unload` | 删除 | 1.4.1 |
| 1.4.3 | 前端 KB 页面移除手动按钮 | 前端 KB 页面 | 加载/卸载 UI | 删除 | 1.4.2 |
| 1.5.1 | 状态锁改为只锁右侧对话区 | 前端 KB 页面 | 状态锁 UI 逻辑 | 修改 | 无 |
| 1.6.1 | 移除 Chat Tab KB Action 按钮 | `server/static/js/chat-actions.js` | `BUILTIN_ACTIONS` | 修改 | 无 |

### 第二批：轨道A — 本地能力增强

| 任务ID | 任务 | 文件 | 函数/类 | 改动类型 | 依赖 |
|--------|------|------|---------|---------|------|
| 2.1.1 | KBDocument 新增 tags/tag_status 字段 | `server/knowledge_base.py` | `KBDocument` | 修改 | 无 |
| 2.1.2 | 新增 normalize_tag() 基础归一化 | `server/knowledge_base.py` | 新函数 | 新增 | 无 |
| 2.1.3 | 新增 get_all_tags() 聚合方法 | `server/knowledge_base.py` | 新方法 | 新增 | 2.1.1 |
| 2.1.4 | 新增 extract_title_and_first_paragraphs() | `server/knowledge_base.py` | 新函数 | 新增 | 无 |
| 2.1.5 | prompts.py 新增 TAGGING_PROMPT | `server/prompts.py` | 新常量 | 新增 | 无 |
| 2.1.6 | TaggingScheduler 实现 | `server/core/tagging_scheduler.py` | `TaggingScheduler` 类 | 新文件 | 2.1.1, 2.1.4, 2.1.5 |
| 2.1.7 | server.py 启动/停止 tagging_scheduler | `server/server.py` | startup/shutdown | 修改 | 2.1.6 |
| 2.1.8 | kb.py 上传后 enqueue 打标 | `server/routers/kb.py` | 上传 endpoint | 修改 | 2.1.6 |
| 2.1.9 | kb.py 新增打标状态查询 API | `server/routers/kb.py` | `GET /api/kb/tagging-status` | 新增 | 2.1.6 |
| 2.2.1 | 前端标签展示 UI（done/pending） | 前端 KB 页面 | 文档详情 UI | 新增 | 2.1.9 |
| 2.3.1 | System Prompt 标签全量注入 | `server/core/agent_tools.py` | `get_tools_and_prompt()` | 修改 | 2.1.3, 1.1.3 |
| 2.4.1 | prompts.py 新增 REFORMULATE_PROMPT | `server/prompts.py` | 新常量 | 新增 | 无 |
| 2.4.2 | Reformulation 模块实现 | `server/core/reformulate.py` | `reformulate_query()` | 新文件 | 2.4.1 |
| 2.5.1 | config.py 新增 history_token_budget | `server/config.py` | `DEFAULTS` | 修改 | 无 |
| 2.5.2 | local_pipeline 自适应记忆裁剪 | `server/pipelines/local_pipeline.py` | 记忆管理逻辑 | 修改 | 2.5.1, 1.2.3 |
| 2.6.1 | 上下文指示器（文库 Tab） | 前端 KB 页面 | 复用环形组件 | 新增 | 1.3.2 |
| 2.7.1 | 会话管理 — 导出 txt | `server/routers/kb.py` | `POST /api/kb/session/export` | 新增 | 无 |
| 2.7.2 | 会话管理 — 新建对话（清空） | `server/routers/kb.py` | `POST /api/kb/session/clear` | 新增 | 无 |
| 2.7.3 | 前端会话管理按钮 | 前端 KB 页面 | 下载/新建按钮 | 新增 | 2.7.1, 2.7.2 |

### 第三批：统一调度器 + 轨道B — 私密融合

| 任务ID | 任务 | 文件 | 函数/类 | 改动类型 | 依赖 |
|--------|------|------|---------|---------|------|
| 3.1.1 | Ollama 中断机制调研 | 调研 | N/A | 调研 | 无 |
| 3.1.2 | LLMScheduler 实现 | `server/core/llm_scheduler.py` | `LLMScheduler` 类 | 新文件/重构 | 3.1.1 |
| 3.1.3 | 全局替换 GenerateQueue → LLMScheduler | `server/server.py`, `server/routers/chat.py` | 引用替换 | 修改 | 3.1.2 |
| 3.1.4 | 排队状态 SSE 推送 | 管道文件 | 排队事件 | 新增 | 3.1.2 |
| 3.1.5 | 排队取消 API | `server/routers/chat.py` | `POST /api/scheduler/cancel` | 新增 | 3.1.2 |
| 3.2.1 | prompts.py 新增 MERGE_FUSION_PROMPT | `server/prompts.py` | 新常量 | 新增 | 无 |
| 3.2.2 | config.py 新增 kb_compare 配置 | `server/config.py` | `DEFAULTS` | 修改 | 无 |
| 3.2.3 | compare_pipeline 实现 | `server/pipelines/compare_pipeline.py` | `run_compare_pipeline()` | 新文件 | 3.2.1, 2.4.2, 3.1.2 |
| 3.2.4 | pipelines/__init__.py 新增 compare 路由 | `server/pipelines/__init__.py` | `create_pipeline()` | 修改 | 3.2.3 |
| 3.2.5 | chat.py 文库对比路由区分 | `server/routers/chat.py` | SSE endpoint | 修改 | 3.2.4, 3.2.2 |
| 3.3.1 | 前端 KB 对比开关 UI | 前端 KB 页面 | 开关组件 | 新增 | 3.2.2 |
| 3.3.2 | 前端隐私弹窗（首次） | 前端 KB 页面 | 弹窗组件 | 新增 | 3.3.1 |
| 3.3.3 | 前端双列 UI + SSE channel 分发 | 前端 KB 页面 | 对话气泡渲染 | 新增 | 3.2.3 |
| 3.3.4 | 前端融合气泡展示 | 前端 KB 页面 | 融合气泡组件 | 新增 | 3.3.3 |
| 3.3.5 | 前端排队 UI + 取消按钮 | 前端 KB 页面 | 排队提示 | 新增 | 3.1.4, 3.1.5 |
| 3.3.6 | 前端设置页 — 对比开关说明文字 | 前端设置页 | 设置 UI | 新增 | 3.2.2 |

### 第四批：收尾打磨

| 任务ID | 任务 | 文件 | 函数/类 | 改动类型 | 依赖 |
|--------|------|------|---------|---------|------|
| 4.1.1 | 纪要断点续传 | 纪要模块 | batch 级续传 | 修改 | 第三批全部 |
| 4.2.1 | Tooltip 明细展示 | `server/static/js/chat.js` | tooltip 渲染 | 修改 | 1.3.2 |
| 4.3.1 | MODEL_CAPABILITIES context 字段补全 | `server/core/cloud_engine.py` | `MODEL_CAPABILITIES` | 修改 | 无 |
| 4.4.1 | 全局联调测试 | 全部 | N/A | 测试 | 所有 |

---

## 五、跨文件约定

### 5.1 变量命名

```python
# KB 权限相关
kb_permission: str           # "full" | "search-only" | "disabled"
KB_PERMISSION_VALUES = ("full", "search-only", "disabled")

# Token 统计
token_stats: dict            # {"input_tokens": int, "output_tokens": int, "reasoning_tokens": int|None}
prompt_tokens: int           # 输入 token
completion_tokens: int       # 输出 token
reasoning_tokens: int | None # 推理 token（仅在线模式）

# 调度器
P0 = 0                       # 最高优先级（Chat/KB对话/纪要）
P2 = 2                       # 低优先级（KB打标）

# KB 文档打标
TAG_STATUS_PENDING = "pending"
TAG_STATUS_DONE = "done"
MAX_TAGS_PER_DOC = 5         # 每个文档最多5个标签
TAG_SUMMARY_MAX_CHARS = 100  # 摘要最大字符数

# SSE 通道
CHANNEL_LOCAL = "local"
CHANNEL_CLOUD = "cloud"
CHANNEL_MERGE = "merge"

# 记忆
HISTORY_TOKEN_BUDGET = 3000  # 默认值，可配置
```

### 5.2 函数签名约定

```python
# agent_tools.py
def get_tools_and_prompt(
    ai_mode: str,
    kb_installed: bool,
    kb_permission: str = "full",       # 新增参数
    tag_overview: str | None = None,   # 新增参数（外部传入标签概览字符串）
) -> tuple[list[dict], str]:
    """返回 (工具列表, system_prompt)"""

# cloud_engine.py — 返回值扩展
# run() 和 run_with_tools() 现有签名不变
# 但 yield 的最后一个事件附带 token_stats
# 使用 EngineResult 包装

# stream_engine.py — 返回值扩展
# run() 现有签名不变
# yield 的最后一个 (phase, content) 附带 token_stats
# 使用 EngineResult 包装

# tagging_scheduler.py
async def enqueue(doc_id: str) -> None: ...
def get_status(doc_id: str) -> str: ...  # "pending" | "done" | "not_found"

# reformulate.py
async def reformulate_query(
    query: str,
    history: list[dict],
    stream_engine: "StreamEngine",
) -> str: ...

# compare_pipeline.py
async def run_compare_pipeline(ctx: "StreamContext") -> AsyncGenerator[str, None]: ...

# llm_scheduler.py
async def submit(priority: int, task: Callable, cancel_event: asyncio.Event) -> "Ticket": ...
async def cancel(ticket_id: str) -> bool: ...
```

### 5.3 SSE 事件格式约定

```python
# _base.py 的 sse_event() 保持现有格式
# 新增约定：compare pipeline 的事件包含 channel 字段

# 普通管道（local/cloud）：不包含 channel
data: {"phase": "stream", "content": "..."}

# Compare 管道：包含 channel
data: {"channel": "local", "phase": "stream", "content": "..."}
data: {"channel": "cloud", "phase": "stream", "content": "..."}
data: {"channel": "merge", "phase": "stream", "content": "..."}

# 排队事件
data: {"phase": "queued", "position": int, "message": str}

# 前端判断逻辑：
# if event.channel → compare pipeline 分发
# else → 普通展示
```

### 5.4 配置读取约定

```python
# config.py 新增配置项的读取方式（与现有模式一致）：
from server.config import get, set_value

kb_permission = get("kb_permission")           # → "full" / "search-only" / "disabled"
history_budget = get("history_token_budget")    # → 3000
compare_enabled = get("kb_compare_enabled")     # → False
privacy_read = get("kb_compare_privacy_read")   # → False
```

### 5.5 前端模块导入约定

```html
<!-- 前端使用 <script> 标签导入，非 ES modules -->
<script src="/static/js/chat.js"></script>
<script src="/static/js/chat-actions.js"></script>
<!-- 新增文件同样使用 <script> 标签 -->
```

---

## 六、风险点和注意事项

### 6.1 技术风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| Ollama 不支持中断 API | P2 无法被真正抢占，只能等当前推理完成 | 调研确认；若不支持则 P0 排队等 P2 自然完成，或限制单次打标输入长度缩短等待 |
| 4B 模型打标质量不稳定 | 标签可能不准确或格式不规范 | 使用确定性较高的 prompt（简单关键词提取）；限制输出长度；基础规则后处理 |
| SSE 多通道前端解析复杂 | 前端代码膨胀，channel 分发逻辑出错 | 抽取独立的 SSE channel dispatcher 函数，单元测试 |
| Compare Pipeline 并行超时 | 本地 LLM 繁忙时本地列等待过久 | 设置合理超时（如 30s），超时后只展示云端列 + 提示本地超时 |
| 双线记忆一致性 | 两套记忆可能出现上下文不对齐 | memory_local 存融合结果（含双路信息），memory_cloud 只存云端回答，各自独立裁剪 |
| 中文 Windows 编码问题 | subprocess 输出乱码 | 所有 subprocess 调用加 `encoding="utf-8"`，已在 server.py 中设置 `PYTHONNOUSERSITE=1` |
| Ollama 模型名格式 | 模型名不带 `:latest` 导致找不到 | 所有 Ollama 模型名使用 `name:latest` 格式 |

### 6.2 兼容性注意事项

1. **数据迁移**：现有 `KBDocument` 无 `tags`/`tag_status` 字段，需要处理旧数据加载（字段缺失时默认值为空列表和 "pending"，dataclass `field(default_factory=list)` 已覆盖）
2. **chat.json 向后兼容**：`token_stats` 为可选字段，旧消息无此字段不影响加载
3. **配置迁移**：`kb_permission` 等新配置项有默认值，旧 config.json 无这些键不影响启动
4. **前端 `<script>` 限制**：不使用 ES modules，新增 JS 文件需在 HTML 中用 `<script src>` 引入，全局函数/变量需注意命名冲突
5. **Vulkan fallback**：离线模式依赖 Vulkan GPU 推理，需保持 Vulkan fallback 策略不变

### 6.3 架构约束

1. **双轨依赖**：轨道 B（Compare Pipeline）依赖轨道 A 的全部能力（Reformulation、自适应记忆、打标），必须按序实施
2. **调度器全局唯一**：LLMScheduler 全局单例，所有本地 LLM 消费者必须通过它调度，不可绕过
3. **云端不走调度器**：CloudEngine 的 HTTP 调用独立于本地调度器，不参与排队
4. **文库 Tab 永远走本地**：不管在线/离线，文库 Tab 的 LLM 推理（KB总结、融合）永远走本地模型
5. **隐私铁律**：云端模型永远不能看到本地 KB 任何内容。Compare Pipeline 中云端列的上下文只包含云端自己的回答

### 6.4 性能关注点

1. **标签聚合查询**：`get_all_tags()` 需遍历所有文档，文档数多时可能有延迟。建议在内存中维护 tag_counts 缓存，文档打标完成后增量更新
2. **System Prompt 长度**：100 文档 ≈ 500 tag ≈ 2K tokens，在大模型 200K 上下文中是零头，但离线 8K 模式下需要关注，必要时截断标签
3. **Compare Pipeline 并行**：本地列和云端列使用 `asyncio.gather()` 并行，但本地列走调度器可能有排队延迟
4. **Reformulation 额外延迟**：每次追问多 ~2 秒（本地 LLM 调用），但提升了搜索质量
5. **Token 统计的存储开销**：每条 assistant message 多存 ~50 bytes 的 token_stats dict，对 chat.json 文件大小影响可忽略

### 6.5 测试要点

1. **三源融合 Prompt**：验证 kb_permission 三档分别正确注入/不注入/不注册工具
2. **Token 计数器**：在线/离线模式分别验证 input_tokens 数值准确，环形进度百分比正确
3. **打标流程**：上传 → pending → 异步打标 → done → 前端展示标签
4. **Compare Pipeline**：SSE 多通道正确分发，双列独立流式展示，融合气泡正确
5. **双线记忆**：追问时验证本地上下文含融合结果、云端上下文只含云端回答
6. **调度器抢占**：P0（Chat）排队时 P2（打标）被正确暂停
7. **KB 自动启动**：安装/未安装扩展时启动行为正确
8. **离线模式**：所有功能在离线模式下正确工作（无云端列、无对比开关）
