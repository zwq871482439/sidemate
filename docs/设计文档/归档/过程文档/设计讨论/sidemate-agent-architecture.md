# Sidemate Patch2 Cloud Agent Loop — 技术架构文档

> 作者：高见远（Gao），软件架构师 | 版本：1.0 | 日期：2026-06-07
> 基于 PRD v1.0 + 现有代码库分析

---

## 一、现有代码分析

### 1.1 后端模块清单

| 文件路径 | 职责 |
|---------|------|
| `server/server.py` | FastAPI 应用入口，注册路由、中间件 |
| `server/config.py` | 全局配置中心，`get()/set_value()` 访问 `settings.json` |
| `server/prompts.py` | 系统提示词管理，`SYSTEM_PROMPT_V2`、场景 prompt、策略配置 |
| `server/core/cloud_engine.py` | 云端 AI 引擎（OpenAI SDK），流式 `yield (phase, content)` |
| `server/core/stream_engine.py` | 本地 AI 引擎（Ollama 原生 API），流式 `yield (phase, content)` |
| `server/core/search_engine.py` | 搜索引擎（httpx → Bing HTML 解析），`search()/fetch()` |
| `server/core/prompt_builder.py` | Prompt 组装（history 裁剪、KB 注入） |
| `server/core/model_manager.py` | 模型管理器（加载/卸载/生成队列/stats） |
| `server/core/think_processor.py` | 思考标签清理（`<think/>` 等） |
| `server/core/generate_queue.py` | 生成请求队列（并发控制） |
| `server/core/ollama_manager.py` | Ollama 进程管理（启动/健康检查） |
| `server/core/deps_check.py` | 依赖检查 |
| `server/core/log_cleanup.py` | 日志清理 |
| `server/pipelines/__init__.py` | 管道路由：`create_pipeline(ctx)` → cloud/local |
| `server/pipelines/_base.py` | 管道共享：`StreamContext`、`sse_event()`、`save_conversation()` |
| `server/pipelines/cloud_pipeline.py` | 云端管道（当前：直通 CloudEngine） |
| `server/pipelines/local_pipeline.py` | 本地管道（完整防护栏：drift/continuation/filter 等） |
| `server/actions/research_action.py` | 联网研究（半自动标记解析循环） |
| `server/actions/doc_action.py` | 文档生成（两阶段：提纲 → 正文 + docx 输出） |
| `server/intelligence/action_router.py` | `/xx` 斜杠指令解析 |
| `server/intelligence/task_classifier.py` | 任务分类（strategy 路由 + 温度调参） |
| `server/intelligence/response_filter.py` | 语义重复截断 |
| `server/intelligence/stall_detector.py` | 停滞检测 |
| `server/session/chat_store.py` | 会话持久化（JSON 文件读写、线程安全） |
| `server/session/context_cache.py` | 上下文压缩缓存 |
| `server/session/continuation.py` | 输出续写 |
| `server/routers/chat.py` | Chat Router：SSE 流式对话 + 会话 CRUD |
| `server/routers/settings.py` | 设置 Router |
| `server/routers/kb.py` | 知识库 Router |
| `server/routers/files.py` | 文件 Router |
| `server/routers/recorder.py` | 录音纪要 Router |
| `server/files/doc_reader.py` | 文档读取 |
| `server/files/doc_writer.py` | 文档写入 |
| `server/files/file_extractor.py` | 文件提取 |
| `server/files/file_reader.py` | 文件读取器 |
| `server/knowledge/` | 知识库模块（chunker/embedding/reranker/memory） |
| `server/validators/` | 校验器 |
| `server/common/` | 公共工具（cancellation/context_compressor/text_utils） |
| `server/extensions/` | 扩展注册 |

### 1.2 前端文件清单

| 文件路径 | 职责 |
|---------|------|
| `server/index.html` | 主 HTML 页面（77KB，含内联模板） |
| `server/static/js/chat.js` | 对话核心：消息发送、SSE 流式消费、渲染 |
| `server/static/js/chat-actions.js` | Action 按钮管理（chat/kb/doc/research 切换） |
| `server/static/js/chat-ui.js` | 对话 UI 组件 |
| `server/static/js/chat-session.js` | 会话管理 |
| `server/static/js/chat-files.js` | 文件上传/引用 |
| `server/static/js/chat-export.js` | 对话导出 |
| `server/static/js/core/api.js` | API 工具 |
| `server/static/js/core/utils.js` | 通用工具 |
| `server/static/js/core/errors.js` | 错误处理 |
| `server/static/js/settings.js` | 设置页 |
| `server/static/js/qa.js` | 问答 Tab |
| `server/static/js/minutes.js` | 纪要 Tab |
| `server/static/js/skills.js` | 技能 Tab |
| `server/static/css/main.css` | 主样式（CSS 变量主题） |
| `server/static/vendor/` | 第三方库（marked/katex/highlight） |

### 1.3 现有 Cloud 模式工作流程

```
前端 sendMessage()
  │
  ├─ POST /api/chat/stream { message, history, action_mode, ... }
  │
  ▼
routers/chat.py: api_chat_stream()
  ├─ 构建 StreamContext(ctx)
  ├─ create_pipeline(ctx) → 路由到 cloud/local
  │
  ▼
pipelines/cloud_pipeline.py: run_cloud_pipeline(ctx)
  ├─ Step 1: 云端上下文 >75% 自动压缩
  ├─ Step 2: action_router 解析 /xx 指令
  ├─ Step 3: KB 检索（如果 action=kb）
  ├─ Step 4a: research_action 分支（半自动搜索标记循环）
  ├─ Step 4b: doc_action 分支（两阶段提纲→正文）
  ├─ Step 5: CloudEngine 直出（chat 模式）
  ├─ Step 6: 保存对话
  └─ yield SSE 事件流
```

**CloudEngine 当前接口**：
```python
cloud_engine.run(message, history=..., context_cache=..., kb_mode=...)
# yield (phase, content)
# phase: "task_type" | "text" | "raw" | "think_start" | "think_token" | "think_end" | "fold"
```

**关键限制**：CloudEngine 目前是"直通管道"——接收 prompt，调用 OpenAI API 流式输出，没有 Agent 循环、没有 FC 工具调用。Research Action 用的是标记解析（`<SEARCH:xxx>`），不是标准 FC。

### 1.4 现有 SSE 事件格式

当前前端消费的 SSE 事件（`data: {"type": "xxx", ...}\n\n`）：

| 事件 type | 数据 | 触发场景 |
|-----------|------|---------|
| `task_type` | `{task_type, confidence}` | 任务分类 |
| `token` | `{content}` | 正文/思考 token |
| `think_start` | `{}` | 云端推理模型开始思考 |
| `think_token` | `{content}` | 云端推理 token |
| `think_end` | `{think_len}` | 云端推理结束 |
| `fold` | `{think_len}` | 本地思考折叠 |
| `done` | `{model, chars, think_chars, time, speed, task_type}` | 完成 |
| `error` | `{content}` | 错误 |
| `mode_hint` | `{message}` | 模式提示 |
| `compress` | `{phase, before, after}` | 上下文压缩 |
| `truncate` | `{content}` | 截断 |
| `model_reload` | `{model}` | 模型重载 |
| `filter` | `{warnings, corrections}` | 内容过滤 |
| `topic_drift` | `{reason, msg_count, ...}` | 漂移检测 |
| `search` / `fetch` | `{query/url, ...}` | Research 搜索/抓取 |
| `research_done` | `{stats}` | Research 完成 |
| `doc_outline` | `{outline}` | 文档提纲 |
| `doc_ready` | `{url, filename}` | 文档下载就绪 |
| `doc_error` | `{message}` | 文档生成失败 |
| `kb_sources` | `{sources}` | KB 检索来源 |
| `slash_hint` | `{message}` | /xx 指令提示 |
| `agent_start` / `agent_think` / `agent_action` / `agent_result` / `agent_done` | `{...}` | 本地 Agent 模式 |
| `chunk_*` | `{...}` | 长文本分段处理 |

前端用 `fetch()` + `ReadableStream` 手动解析 SSE（非 EventSource）。

---

## 二、目标架构

### 2.1 三层架构：CloudPipeline → AgentLoop → CloudEngine

```
┌─────────────────────────────────────────────────────────────┐
│                    CloudPipeline                            │
│  (pipelines/cloud_pipeline.py — 重构)                       │
│                                                             │
│  职责：                                                      │
│  - 上下文压缩                                                │
│  - 构建 StreamContext                                       │
│  - 根据 action_mode 选择 Agent 工具集                        │
│  - 会话保存                                                  │
│  - SSE 事件封装                                              │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    AgentLoop (新增)                          │
│  (core/agent_loop.py)                                       │
│                                                             │
│  职责：                                                      │
│  - 组装动态 System Prompt + FC tools JSON                   │
│  - ReAct 循环：调用 CloudEngine → 解析 FC → 执行工具 → 回环  │
│  - 最大 15 轮循环限制                                        │
│  - 统计收集（搜索次数、抓取次数、耗时）                        │
│  - yield (phase, content) — 新增 agent 专用 phase            │
│  - FC fallback（捕获异常 → 降级普通对话）                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│                    CloudEngine (已有，微调)                   │
│  (core/cloud_engine.py)                                     │
│                                                             │
│  变更：                                                      │
│  - run() 新增 tools 参数（FC tools JSON）                    │
│  - 返回 FC tool_calls 时 yield 新 phase                      │
│  - 其余保持不变（流式输出、reasoning_content 处理）           │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 AgentLoop 核心循环伪代码

```python
# core/agent_loop.py

class AgentLoop:
    """ReAct Agent 循环 — 云端模式核心"""

    def __init__(self, cloud_engine, search_engine, kb=None):
        self.cloud_engine = cloud_engine
        self.search_engine = search_engine
        self.kb = kb
        self.stats = {"tool_calls": 0, "searches": 0, "fetches": 0,
                      "kb_searches": 0, "pages_read": 0}
        self.max_rounds = 15

    def run(self, message, mode="chat", history=None,
            context_cache=None, kb_mode=False):
        """主循环 — yield (phase, content)

        mode:
          "chat" — 智能对话（搜索+KB工具）
          "doc"  — 文档生成（搜索+KB+write_section+search_and_summarize）
        """
        # 1. 动态组装 System Prompt + tools
        system_prompt, tools = self._build_prompt_and_tools(mode, message)

        # 2. 构建 messages
        messages = [{"role": "system", "content": system_prompt}]
        if history:
            for h in history:
                if h.get("role") in ("user", "assistant") and h.get("content"):
                    messages.append({"role": h["role"], "content": h["content"]})
        messages.append({"role": "user", "content": message})

        t0 = time.time()

        # 3. ReAct 循环
        for round_idx in range(self.max_rounds):
            # 3a. 调用 CloudEngine（带 tools 参数）
            fc_calls = None
            full_response = ""
            has_reasoning = False

            yield ("agent_status", {"status": "thinking",
                    "detail": "正在思考..."})

            for phase, content in self.cloud_engine.run_with_tools(
                messages=messages,
                tools=tools,
            ):
                if phase == "text":
                    full_response += content
                    yield ("text", content)
                elif phase == "think_start":
                    has_reasoning = True
                    yield ("agent_think", {"content": ""})
                elif phase == "think_token":
                    yield ("agent_think", {"content": content})
                elif phase == "think_end":
                    yield ("agent_think", {"content": ""})  # 结束标记
                elif phase == "tool_calls":
                    fc_calls = content  # list of tool_call dicts

            if not fc_calls:
                # 模型返回纯文本 → 循环结束
                break

            # 3b. 执行工具调用
            for tc in fc_calls:
                tool_name = tc["function"]["name"]
                tool_args = json.loads(tc["function"]["arguments"])
                self.stats["tool_calls"] += 1

                yield ("agent_status", {"status": _status_for_tool(tool_name),
                        "detail": _detail_for_tool(tool_name, tool_args)})

                result = self._execute_tool(tool_name, tool_args)

                # 将工具结果追加到 messages（OpenAI FC 协议）
                messages.append({"role": "assistant",
                                 "tool_calls": [tc]})
                messages.append({"role": "tool",
                                 "tool_call_id": tc["id"],
                                 "content": json.dumps(result, ensure_ascii=False)})

        # 4. 输出统计摘要
        elapsed = time.time() - t0
        self.stats["time"] = round(elapsed, 1)
        yield ("agent_summary", self.stats)

    def _execute_tool(self, name, args):
        """执行单个工具调用"""
        if name == "web_search":
            self.stats["searches"] += 1
            results = self.search_engine.search(args["query"])
            return {"results": results[:5]}
        elif name == "web_fetch":
            self.stats["fetches"] += 1
            self.stats["pages_read"] += 1
            page = self.search_engine.fetch(args["url"])
            return {"title": page["title"], "text": page["text"][:4000]}
        elif name == "kb_search":
            self.stats["kb_searches"] += 1
            results = self.kb.query(args["query"], top_k=5)
            return {"results": results.get("results", [])[:5]}
        elif name == "write_section":
            # 文档模式：累积章节内容
            return {"ok": True, "section": args["title"]}
        elif name == "search_and_summarize":
            self.stats["searches"] += 1
            results = self.search_engine.search(args["query"])
            # 可选：抓取 top 结果并总结
            return {"results": results[:3]}
        else:
            return {"error": "未知工具: %s" % name}
```

### 2.3 工具注册表设计（动态 System Prompt + FC tools JSON）

```python
# core/agent_tools.py

# ===== 智能对话模式工具集 =====
CHAT_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "搜索互联网获取最新信息。当需要查找实时数据、新闻、技术文档时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词"}
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_fetch",
            "description": "抓取指定网页的正文内容。当搜索结果中有需要深入了解的页面时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {"type": "string", "description": "要抓取的网页 URL"}
                },
                "required": ["url"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "kb_search",
            "description": "搜索用户的知识库文档。当问题可能涉及用户已上传的文档内容时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词"}
                },
                "required": ["query"]
            }
        }
    },
]

# ===== 文档生成模式工具集（继承全部 + 新增） =====
DOC_TOOLS = CHAT_TOOLS + [
    {
        "type": "function",
        "function": {
            "name": "write_section",
            "description": "写入文档的一个章节。文档生成时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "章节标题"},
                    "content": {"type": "string", "description": "章节正文内容"}
                },
                "required": ["title", "content"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_and_summarize",
            "description": "搜索互联网并总结结果。当需要快速了解某个主题时使用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "搜索关键词"}
                },
                "required": ["query"]
            }
        }
    },
]

# ===== 动态 System Prompt =====
AGENT_SYSTEM_PROMPT_CHAT = """你是桌伴(Sidemate)的智能对话 Agent。你可以通过工具搜索互联网、抓取网页、检索知识库来帮助用户。

规则：
1. 不确定的信息先用 web_search 查证
2. 每次只调用必要的工具，避免冗余
3. 工具返回的信息要综合分析后再回答
4. 引用来源时标注 URL 或文档名
5. 中文直接回答，不寒暄
"""

AGENT_SYSTEM_PROMPT_DOC = """你是桌伴(Sidemate)的文档生成 Agent。你可以搜索互联网、抓取网页、检索知识库、写入文档章节来帮用户生成高质量文档。

规则：
1. 先理解用户需求，规划文档结构
2. 用 web_search / search_and_summarize 收集资料
3. 用 write_section 逐章节写入内容
4. 每个章节内容充实，2-3段正文
5. 全中文输出，结构清晰，重点用**加粗**
6. 引用来源标注出处
"""

def get_tools_and_prompt(mode: str, kb_available: bool = False):
    """根据模式和 KB 状态动态返回工具集和 system prompt

    Args:
        mode: "chat" | "doc"
        kb_available: 知识库是否有文档

    Returns:
        (system_prompt, tools_list)
    """
    if mode == "doc":
        tools = list(DOC_TOOLS)
        prompt = AGENT_SYSTEM_PROMPT_DOC
    else:
        tools = list(CHAT_TOOLS)
        prompt = AGENT_SYSTEM_PROMPT_CHAT

    # 无 KB 文档时移除 kb_search 工具
    if not kb_available:
        tools = [t for t in tools if t["function"]["name"] != "kb_search"]

    return prompt, tools
```

### 2.4 SSE 事件协议（新增 3 个核心事件）

**保留所有现有事件**，新增：

| 事件 | 触发时机 | 数据格式 | 前端行为 |
|------|---------|---------|---------|
| `agent_think` | Agent 推理过程（reasoning_content） | `{"content": "..."}` | 折叠区域实时显示思考 |
| `agent_status` | Agent 调用工具/状态变化 | `{"status": "searching", "detail": "搜索 Rust 异步..."}` | 旋转动画 + 状态文字 |
| `agent_summary` | 任务完成后 | `{"tool_calls": 3, "searches": 2, "pages_read": 1, "time": 12.5}` | 统计卡片 |

**映射关系**：
- `agent_think` ← CloudEngine 的 `reasoning_content`（AgentLoop 转发）
- `agent_status` ← AgentLoop 工具执行前后发出
- `agent_summary` ← AgentLoop 循环结束后发出

**事件优先级**：agent_think / agent_status / agent_summary 三个事件与现有 token/fold/done 事件兼容共存。前端通过 `d.type` 分发，不冲突。

### 2.5 会话存储新格式

```
data/chats/
  my-chat/                    # 文件夹（新格式）
    meta.json                 # 会话元信息
    messages.json             # 消息历史（含 agent 工具调用记录）
    assets/                   # 附件（生成的文档、图片等）
      doc_20260607_143022.docx
```

**meta.json 结构**：
```json
{
  "version": 3,
  "created_at": "2026-06-07 14:30:00",
  "updated_at": "2026-06-07 14:35:00",
  "model": "gpt-4o-mini",
  "mode": "cloud",
  "summaries": []
}
```

**messages.json 结构**（与现有兼容，新增 agent 字段）：
```json
[
  {"version": 2, "messages": [
    {"role": "user", "content": "...", "ts": "14:30:00"},
    {"role": "assistant", "content": "...", "ts": "14:30:15",
     "agent_summary": {"tool_calls": 3, "searches": 2, "time": 12.5}}
  ]}
]
```

**迁移策略**：启动时 `chat_store.py` 扫描 `CHAT_DIR` 下 `.json` 文件，自动转为文件夹格式（原子操作：先创建文件夹 → 迁移数据 → 删除旧文件；失败时保留原文件）。

---

## 三、模块变更清单

### 3.1 新增文件

| 文件名 | 职责 |
|-------|------|
| `server/core/agent_loop.py` | AgentLoop 核心循环：ReAct 循环 + FC 调用 + 工具执行 |
| `server/core/agent_tools.py` | 工具注册表：动态 System Prompt + FC tools JSON 定义 |
| `server/core/session_migrator.py` | 会话迁移器：`.json` → 文件夹格式，原子操作 |

### 3.2 修改文件

| 文件名 | 改什么 |
|-------|--------|
| `server/core/cloud_engine.py` | 1. `run()` 新增 `tools` 参数<br>2. 新增 `run_with_tools()` 方法（支持 FC 工具调用）<br>3. 新增 `"tool_calls"` phase（返回 FC 解析结果）<br>4. 保持 `run()` 向后兼容 |
| `server/pipelines/cloud_pipeline.py` | 1. 重构：用 AgentLoop 替换现有的 research/doc 分支<br>2. chat 模式走 AgentLoop<br>3. doc 模式走 AgentLoop + docx 输出层<br>4. 移除直接调用 `run_research_action` 的代码<br>5. 处理 agent_think/agent_status/agent_summary → SSE 事件 |
| `server/session/chat_store.py` | 1. `save_chat()` 支持文件夹格式<br>2. `load_chat()` 支持文件夹格式<br>3. `list_chats()` 兼容两种格式<br>4. `new_chat_file()` 创建文件夹格式<br>5. 启动时触发迁移 |
| `server/prompts.py` | 1. 新增 `AGENT_SYSTEM_PROMPT_CHAT` 和 `AGENT_SYSTEM_PROMPT_DOC`<br>2. 保留所有现有 prompt 不变 |
| `server/config.py` | 1. 新增 `agent_max_rounds: 15`（可配置）<br>2. 新增 `agent_tool_timeout: 20`（工具调用超时）<br>3. 新增 `agent_total_timeout: 300`（总任务超时） |
| `server/routers/chat.py` | 1. `api_chat_stream()` 中 `action_mode` 路由逻辑更新<br>2. 移除 research 独立分支（由 AgentLoop 统一处理）<br>3. `api_chats_switch()` 兼容文件夹格式 |
| `server/static/js/chat.js` | 1. SSE 事件消费新增 `agent_think` / `agent_status` / `agent_summary` 处理<br>2. 新增状态指示器渲染（旋转动画 + 状态文字）<br>3. 新增统计摘要卡片渲染 |
| `server/static/js/chat-actions.js` | 1. 云端模式按钮改为 2 个：智能对话 + 文档生成<br>2. 移除 research 独立按钮<br>3. 保留本地模式 3 个按钮不变 |

### 3.3 删除文件

| 文件名 | 原因 |
|-------|------|
| （无） | `actions/research_action.py` 保留但不再被云端模式调用，仅本地模式可保留为参考 |

### 3.4 前端变更清单

**chat-actions.js**：
- `refreshActionBar()` 中云端模式只渲染 2 个按钮（智能对话、文档生成）
- 本地模式保持 3 个按钮（智能对话、知识库问答、文档生成）
- 移除云端 research 独立按钮的硬编码

**chat.js**：
- SSE 消费循环新增 `agent_think` 事件处理 → 实时显示思考过程（复用现有 `_renderCloudThink` 模式）
- SSE 消费循环新增 `agent_status` 事件处理 → 显示状态指示器（"正在搜索..." 等）
- SSE 消费循环新增 `agent_summary` 事件处理 → 显示统计摘要卡片
- 状态指示器：在 `stream-msg` 区域上方显示旋转动画 + 状态文字

---

## 四、数据流图

### 4.1 智能对话模式（在线）

```
┌──────────┐    POST /api/chat/stream     ┌──────────────────┐
│  前端     │ ──────────────────────────→  │ routers/chat.py  │
│  chat.js  │    {action_mode: "chat"}     │ api_chat_stream()│
│           │                              └────────┬─────────┘
│           │                                       │
│           │                              create_pipeline(ctx)
│           │                                       │
│           │                              ┌────────▼─────────┐
│           │                              │ cloud_pipeline.py│
│           │                              │                  │
│           │                              │ 1. 上下文压缩    │
│           │                              │ 2. AgentLoop.run │
│           │                              │    mode="chat"   │
│           │                              └────────┬─────────┘
│           │                                       │
│           │                              ┌────────▼─────────┐
│           │                              │  AgentLoop       │
│           │                              │                  │
│           │                              │ get_tools_and_   │
│           │                              │   prompt("chat") │
│           │                              │                  │
│           │                              │ ┌──────────────┐ │
│           │                              │ │ ReAct Loop   │ │
│           │                              │ │              │ │
│           │                              │ │ CloudEngine  │ │
│           │                              │ │ .run_with_   │ │
│           │                              │ │  tools()     │ │
│           │                              │ │    │         │ │
│           │                              │ │    ▼         │ │
│           │                              │ │ FC response? │ │
│           │                              │ │ ├─ Yes →     │ │
│           │                              │ │ │  execute    │ │
│           │                              │ │ │  tool →     │ │
│           │                              │ │ │  append msg │ │
│           │                              │ │ │  → loop     │ │
│           │                              │ │ └─ No →      │ │
│           │                              │ │    break     │ │
│           │                              │ └──────────────┘ │
│           │                              │                  │
│           │                              │ yield:           │
│           │                              │  agent_think     │
│           │                              │  agent_status    │
│           │                              │  text            │
│           │                              │  agent_summary   │
│           │                              └──────────────────┘
│           │                                       │
│  SSE ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← ← │
│           │
│  前端渲染：
│  - agent_think → 思考折叠区
│  - agent_status → 状态指示器（旋转动画）
│  - token/text → 正文流式渲染
│  - agent_summary → 统计卡片
│  - done → 最终保存
└──────────┘
```

### 4.2 文档生成模式（在线）

```
┌──────────┐    POST /api/chat/stream     ┌──────────────────┐
│  前端     │ ──────────────────────────→  │ routers/chat.py  │
│  chat.js  │    {action_mode: "doc"}      │ api_chat_stream()│
└──────────┘                              └────────┬─────────┘
                                                   │
                                          create_pipeline(ctx)
                                                   │
                                          ┌────────▼─────────┐
                                          │ cloud_pipeline.py│
                                          │                  │
                                          │ AgentLoop.run    │
                                          │   mode="doc"     │
                                          │                  │
                                          │ 工具集：          │
                                          │  web_search      │
                                          │  web_fetch       │
                                          │  kb_search       │
                                          │  write_section   │
                                          │  search_and_     │
                                          │   summarize      │
                                          └────────┬─────────┘
                                                   │
                                          Agent 自主规划：
                                          1. 理解需求 → 搜索资料
                                          2. 整理要点 → write_section
                                          3. 逐章节输出 → write_section
                                          4. 输出完成 → 纯文本回复
                                                   │
                                          ┌────────▼─────────┐
                                          │ Pipeline 后处理   │
                                          │                  │
                                          │ 收集 write_section│
                                          │ 的章节内容        │
                                          │ → generate_docx()│
                                          │ → yield doc_ready │
                                          └──────────────────┘
```

---

## 五、API 变更

### 5.1 新增/修改的 REST API 端点

**无新增端点**。所有变更在现有端点内完成：

| 端点 | 变更 |
|------|------|
| `POST /api/chat/stream` | `action_mode` 参数值调整：云端模式下 "chat" 和 "doc" 走 AgentLoop，"research" 和 "kb" 合并到 "chat"（Agent 自主决定是否查 KB） |
| `GET /api/chats` | 返回格式兼容文件夹会话 |
| `POST /api/chats/switch` | 兼容文件夹路径 |
| `DELETE /api/chats/{name}` | 兼容文件夹删除 |

### 5.2 SSE 事件格式变更

**新增事件**：

```
data: {"type": "agent_think", "content": "思考内容..."}

data: {"type": "agent_status", "status": "searching", "detail": "搜索 Rust 异步..."}

data: {"type": "agent_summary", "tool_calls": 3, "searches": 2, "pages_read": 1, "kb_searches": 0, "time": 12.5}
```

**状态枚举**（`agent_status.status`）：
- `"thinking"` — Agent 正在推理
- `"searching"` — 搜索中
- `"fetching"` — 抓取网页中
- `"kb_searching"` — 检索知识库中
- `"writing"` — 写入文档章节中

**现有事件不受影响** — `token`、`done`、`error` 等事件照常发出。

---

## 六、关键接口定义

### 6.1 AgentLoop 类签名

```python
class AgentLoop:
    """ReAct Agent 循环"""

    def __init__(self,
                 cloud_engine: CloudEngine,
                 search_engine: SearchEngine,
                 kb: object = None):
        """
        Args:
            cloud_engine: CloudEngine 实例
            search_engine: SearchEngine 实例
            kb: KnowledgeBase 实例（可选）
        """

    def run(self,
            message: str,
            mode: str = "chat",           # "chat" | "doc"
            history: list = None,
            context_cache: str = None,
            max_rounds: int = None) -> Generator[tuple, None, None]:
        """主循环

        Yields:
            (phase, content) 元组
            phase:
              "text"           — 正文 token 流（str）
              "agent_think"    — 推理内容（str）
              "agent_status"   — 状态变化（dict: {status, detail}）
              "agent_summary"  — 任务统计（dict）
              "task_type"      — 任务分类（tuple: (type, confidence)）
              "error"          — 错误（str）
        """

    def _build_prompt_and_tools(self, mode: str, kb_available: bool) -> tuple:
        """返回 (system_prompt: str, tools: list[dict])"""

    def _execute_tool(self, name: str, args: dict) -> dict:
        """执行工具，返回结果字典"""
```

### 6.2 工具注册表接口

```python
# core/agent_tools.py

def get_tools_and_prompt(mode: str, kb_available: bool = False) -> tuple:
    """根据模式和 KB 状态返回 (system_prompt, tools)

    Args:
        mode: "chat" | "doc"
        kb_available: 知识库是否有文档

    Returns:
        (system_prompt: str, tools: list[dict])
    """
```

### 6.3 CloudEngine 变更

```python
class CloudEngine:
    # 已有 run() 方法保持不变

    def run_with_tools(self,
                       messages: list,
                       tools: list = None,
                       model: str = None,
                       max_tokens: int = None,
                       temperature: float = 0.7) -> Generator[tuple, None, None]:
        """带 FC 工具的流式调用

        与 run() 的区别：
        1. 接收 messages 数组而非 message 字符串（AgentLoop 自行管理 history）
        2. 传入 tools 参数（FC tools JSON）
        3. 新增 "tool_calls" phase：当模型返回 FC 调用时，content 为 tool_calls 列表

        Yields:
            (phase, content):
              "text"        — 正文 token 流
              "think_start" — 推理开始
              "think_token" — 推理 token
              "think_end"   — 推理结束
              "tool_calls"  — FC 工具调用（list[dict]，每个含 id/function/arguments）
              "raw"         — 错误信息
        """
```

### 6.4 SessionMigrator 接口

```python
# core/session_migrator.py

def migrate_all():
    """扫描 CHAT_DIR，将旧格式 .json 文件迁移为文件夹格式

    - 原子操作：先创建文件夹 → 写入文件 → 删除旧文件
    - 失败时保留原文件，记日志
    - 静默失败，不抛异常
    """

def migrate_single(json_path: str) -> str:
    """迁移单个会话文件

    Returns:
        新文件夹路径（成功）或原路径（失败）
    """
```

---

## 七、实施顺序建议

### Phase 1: 基础设施（AgentLoop 核心 + FC 协议）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 1.1 | `server/core/agent_tools.py` | **新建**。定义工具 JSON、System Prompt、`get_tools_and_prompt()` |
| 1.2 | `server/core/cloud_engine.py` | **修改**。新增 `run_with_tools()` 方法，支持 FC `tools` 参数，新增 `"tool_calls"` phase |
| 1.3 | `server/core/agent_loop.py` | **新建**。实现 `AgentLoop` 类，核心 ReAct 循环 |
| 1.4 | 测试 | 手动测试：AgentLoop 端到端循环（用 mock CloudEngine 验证 FC 解析 + 工具执行） |

### Phase 2: 工具实现（搜索/KB/文档工具注册与执行）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 2.1 | `server/core/agent_loop.py` | 完善 `_execute_tool()`：web_search、web_fetch、kb_search |
| 2.2 | `server/core/agent_loop.py` | 文档工具：write_section（收集章节）、search_and_summarize |
| 2.3 | `server/core/agent_loop.py` | FC fallback：捕获 FC 异常 → 降级普通对话 |
| 2.4 | `server/config.py` | 新增 `agent_max_rounds`、`agent_tool_timeout`、`agent_total_timeout` 配置项 |
| 2.5 | 测试 | 端到端测试：真实 API 调用 + 搜索 + KB |

### Phase 3: 前端适配（状态指示器 + 按钮调整 + SSE 消费）

| 步骤 | 文件 | 内容 |
|------|------|------|
| 3.1 | `server/pipelines/cloud_pipeline.py` | **重构**。用 AgentLoop 替换 research/doc 分支，处理 agent_* SSE 事件 |
| 3.2 | `server/static/js/chat-actions.js` | 云端模式 2 按钮，本地模式 3 按钮 |
| 3.3 | `server/static/js/chat.js` | 新增 `agent_think`/`agent_status`/`agent_summary` SSE 事件处理 |
| 3.4 | `server/static/js/chat.js` | 状态指示器 UI（旋转动画 + 状态文字） |
| 3.5 | `server/static/js/chat.js` | 统计摘要卡片 UI |
| 3.6 | `server/static/css/main.css` | 新增 agent 相关 CSS（使用 CSS 变量） |

### Phase 4: 会话存储升级 + 自动迁移

| 步骤 | 文件 | 内容 |
|------|------|------|
| 4.1 | `server/core/session_migrator.py` | **新建**。实现 `migrate_all()` 和 `migrate_single()` |
| 4.2 | `server/session/chat_store.py` | 支持文件夹格式读写，启动时触发迁移 |
| 4.3 | `server/routers/chat.py` | 兼容文件夹路径的 CRUD 操作 |
| 4.4 | 测试 | 迁移测试：旧格式 → 新格式 → 数据完整性验证 |

### Phase 5: SearchEngine curl_cffi 升级

| 步骤 | 文件 | 内容 |
|------|------|------|
| 5.1 | `server/core/search_engine.py` | 将 httpx 替换为 curl_cffi，保留 httpx 作为 fallback |
| 5.2 | 测试 | 搜索/抓取功能测试，curl_cffi 不可用时 fallback 验证 |

### 回归测试

| 范围 | 内容 |
|------|------|
| 本地模式全功能 | 智能对话 / KB 问答 / 文档生成 / 漂移检测 / 续写 / 过滤 |
| 云端智能对话 | Agent 多步任务 / 搜索 / KB 检索 / 状态指示器 / 统计摘要 |
| 云端文档生成 | Agent 自主写作 / write_section / docx 输出 |
| 会话迁移 | 旧格式 → 新格式 / 迁移失败回退 |
| FC fallback | 模拟 FC 错误 → 降级普通对话 |
| SSE 兼容 | 前端正确消费所有事件 / 无崩溃 |

---

## 八、风险与缓解

### 8.1 技术风险

| 风险 | 影响 | 概率 | 缓解 |
|------|------|------|------|
| **模型 FC 能力参差不齐** | 部分 API 提供商（如 GLM、DeepSeek）的 FC 实现有 bug，可能返回格式错误的 tool_calls | 高 | 1. `run_with_tools()` 中 try/catch 包裹 FC 解析<br>2. 解析失败 → fallback 到普通对话模式<br>3. 日志记录 FC 原始响应用于调试 |
| **Agent Loop token 消耗大** | 15 轮循环 × 每轮工具结果追加 → context 爆炸 | 中 | 1. 每轮工具结果截断（web_fetch 限 4000 字）<br>2. 累积 context 超过阈值时压缩<br>3. `agent_summary` 显示消耗统计 |
| **SSE 事件格式变化导致前端异常** | 新增事件前端未处理 → JS 报错 | 低 | 1. 前端 SSE 消费用 `if/else if` 链，未识别事件静默忽略<br>2. 新增事件在已有链末尾追加，不影响现有分支 |
| **会话迁移数据丢失** | 迁移过程中断 → 用户历史对话丢失 | 低 | 1. 原子操作：先创建新文件夹，成功后才删旧文件<br>2. 迁移失败 → 保留原文件 + 记日志<br>3. 不提示用户（静默失败） |
| **write_section 工具累积问题** | Agent 生成文档时，章节内容需要在 AgentLoop 中累积，最终组合输出 | 中 | 1. AgentLoop 内部维护 `_doc_sections` 列表<br>2. 每次执行 write_section 追加<br>3. 循环结束后由 Pipeline 组合输出 + generate_docx |

### 8.2 对本地模式的影响分析

| 变更点 | 对本地模式影响 | 分析 |
|-------|---------------|------|
| `cloud_engine.py` 新增 `run_with_tools()` | **零影响** | 新方法独立，不修改 `run()` |
| `cloud_pipeline.py` 重构 | **零影响** | 云端管道独立文件，本地用 `local_pipeline.py` |
| `agent_loop.py` / `agent_tools.py` | **零影响** | 全新文件，本地模式不引用 |
| `config.py` 新增配置项 | **零影响** | 新增 key，不影响现有 key |
| `prompts.py` 新增 Agent prompt | **零影响** | 新增常量，不改现有内容 |
| `chat.js` 前端 SSE 消费 | **零影响** | 新增 `else if` 分支，不影响现有分支 |
| `chat-actions.js` 按钮调整 | **零影响** | 通过 `_currentMode` 判断，云端/本地独立渲染 |
| `chat_store.py` 文件夹格式 | **需验证** | `save_chat()`/`load_chat()` 需同时兼容 JSON 文件和文件夹 |
| `research_action.py` 不再被云端调用 | **零影响** | 本地模式仍可通过 Pipeline 调用（如需要） |

**结论**：本地模式功能**完全不受影响**。所有变更要么是新增文件、要么是云端管道内部重构、要么是前端条件分支。唯一需要注意的是 `chat_store.py` 的兼容性。

### 8.3 FC 兼容性策略

```
CloudEngine.run_with_tools()
  │
  ├─ 正常路径：模型返回 tool_calls → AgentLoop 执行工具 → 循环
  │
  ├─ FC 格式错误：try/catch 捕获 JSON 解析失败
  │   └─ fallback：将模型响应当作普通文本返回
  │
  ├─ 模型不支持 FC：API 返回 400 或无 tool_calls
  │   └─ fallback：将模型响应当作普通文本返回
  │
  └─ 超时/网络错误：和现有 run() 一致处理
      └─ yield ("raw", "[ERROR] ...")
```

**Fallback 触发条件**：
1. `tools` 参数传入但模型返回无 `tool_calls`（模型不支持）
2. `tool_calls` JSON 解析失败（模型 bug）
3. `tool_calls` 中 `function.arguments` 不是合法 JSON
4. 工具执行超时或异常

**Fallback 行为**：
- 记录 warning 日志（含原始 FC 响应）
- 将已收集的正文直接返回
- 不再循环，直接结束

---

## 附录 A：文件依赖关系图

```
agent_tools.py ←──── agent_loop.py ←──── cloud_pipeline.py ←──── chat.py (router)
                         │                        │
                         └──→ cloud_engine.py      └──→ _base.py (sse_event)
                         └──→ search_engine.py
                         └──→ knowledge_base.py

session_migrator.py ──→ chat_store.py ←──── chat.py (router)
```

## 附录 B：OpenAI FC 协议参考

**请求格式**：
```json
{
  "model": "gpt-4o",
  "messages": [...],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "web_search",
        "description": "搜索互联网",
        "parameters": {
          "type": "object",
          "properties": {
            "query": {"type": "string", "description": "搜索关键词"}
          },
          "required": ["query"]
        }
      }
    }
  ],
  "stream": true
}
```

**流式 FC 响应**（需要累积 delta）：
```json
// chunk 1
{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xxx","type":"function","function":{"name":"web_search","arguments":""}}]}}]}

// chunk 2
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"qu"}}]}}]}

// chunk N
{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\": \"Rust async\"}"}}],"finish_reason":"tool_calls"}]}
```

**工具结果追加**：
```json
{"role": "assistant", "tool_calls": [{"id": "call_xxx", "type": "function", "function": {"name": "web_search", "arguments": "{\"query\": \"Rust async\"}"}}]}
{"role": "tool", "tool_call_id": "call_xxx", "content": "{\"results\": [...]}"}
```

> **注意**：流式 FC 响应需要累积 `tool_calls[].function.arguments` delta，拼接后 JSON parse。这是实现 `run_with_tools()` 的核心难点。
