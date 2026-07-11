# Sidemate Patch2 — Cloud Agent Loop 架构重设计方案

> 版本：v2.1 | 日期：2026-06-07 | 状态：✅ 已确认，准备实施

---

## 一、背景与问题

### 现状（Patch2 当前版本）

当前在线模式（cloud mode）的 `cloud_pipeline.py` 仍沿用本地模式的"代码驱动"思维：

```
代码决定搜什么 → 代码决定调哪个 action → 把结果丢给模型 → 模型输出文本
```

**核心问题**：大模型被当成"最后一段文本生成器"，没有自主决策权。所有工具使用（搜索、抓取、KB 检索）都由代码预先决定，大模型无法根据中间结果灵活调整策略。

**具体症状**：
1. `<SEARCH:keyword>` 标记泄露给用户（research_action.py 的 tag 未过滤）
2. 搜索/抓取过程前端展示粗糙，用户看不到 Agent 的决策过程
3. 在线模式和本地模式用同一套 pipeline 逻辑，大模型能力被浪费
4. 扩展新工具需要硬编码新的 pipeline 分支，不可扩展

### 目标

将在线模式从**固定 Pipeline** 重构为 **Agent Loop（ReAct 模式）**：

```
大模型 = 指挥官，工具 = 手脚
思考 → 选择工具 → 执行 → 观察结果 → 再思考 → ... → 最终回答
```

**关键架构决策**：在线模式完全独立于本地模式。本地模式是 Pipeline（小模型 = 打工人），在线模式是 Agent（大模型 = 指挥官）。两者共享的只有底层工具实现（python-docx 输出层等），流程控制层完全分离。

---

## 二、架构设计

### 2.1 本地模式 vs 在线模式的本质区别

| 维度 | 本地模式（Pipeline） | 在线模式（Agent） |
|------|----------------------|-------------------|
| 指挥者 | 代码 | 大模型 |
| 工人 | 小模型（只生成文本） | 工具（search/fetch/KB/doc） |
| 流程 | 固定流水线 | 动态 ReAct 循环 |
| 适用原因 | 小模型无 tool-calling 能力 | 大模型有 FC 能力 |
| 用户选择 | 3 个按钮（聊天/文库/文档） | 2 个按钮（智能对话/文档生成） |
| 流程控制 | `local_pipeline.py` + `doc_action.py` | `cloud_pipeline.py` → `agent_loop.py` |

### 2.2 三层架构

```
┌─────────────────────────────────────────────────────┐
│  CloudPipeline (入口层)                              │
│  职责：上下文组装、工具注册、入口路由                 │
│  文件：pipelines/cloud_pipeline.py                   │
│                                                     │
│  用户消息 → 动态组装 tools + prompt                  │
│    ├─ 智能对话 → AgentLoop.run()                    │
│    └─ 文档生成 → AgentLoop.run(doc_tools)           │
│         ↑ 不是"文档工具链"，而是 Agent 拿着文档      │
│           工具自主决定怎么写                          │
├─────────────────────────────────────────────────────┤
│  AgentLoop (循环控制层)                              │
│  职责：ReAct 循环、工具调度、轮次管理、统计          │
│  文件：core/agent_loop.py                            │
│                                                     │
│  while round < MAX_ROUNDS:                           │
│    调用 CloudEngine.chat_with_tools()                │
│    解析 tool_calls → 执行工具 → 结果追加             │
│    yield agent_status (实时状态)                     │
│    无 tool_calls → 输出最终回答                      │
├─────────────────────────────────────────────────────┤
│  CloudEngine (API 连接层)                            │
│  职责：OpenAI SDK 连接、SSE 流式解析、推理模型兼容   │
│  文件：core/cloud_engine.py                          │
│                                                     │
│  chat_with_tools(messages, tools)                    │
│    → yield ("tool_call", {...})                      │
│    → yield ("think", token)                          │
│    → yield ("text", token)                           │
└─────────────────────────────────────────────────────┘
```

### 2.3 在线模式 UI：2 个按钮

| 按钮 | action_mode | 后端行为 | 输入框提示 |
|------|-------------|---------|-----------|
| **智能对话** 💬 | `agent` | Agent Loop，大模型自主决策用哪些工具（search_web / fetch_url / search_kb） | "问任何问题，AI 会自动搜索、阅读、回答..." |
| **文档生成** 📄 | `doc` | Agent Loop + 文档工具（parse_template / search_kb / search_web / compile_docx），大模型自主决定文档结构、写作策略 | "输入文档主题，可选上传模板或参考资料..." |

**本地模式保持 3 个按钮不变**：聊天 / 文库问答 / 文档生成

**核心变化**：
- 在线模式不存在"文库问答"和"在线搜索"独立按钮——Agent 自己判断要不要搜 KB 或搜网
- 文档生成不是"屈才的工具链"——Agent 拿着全部工具（包括搜索、KB、模板解析）自主决定怎么写文档
- 用户点"文档生成"只是**告诉 Agent 意图**，不是限制它的能力

### 2.4 工具注册表（动态组装）

```python
# core/agent_tools.py

TOOL_REGISTRY = {
    # ─── 通用工具（智能对话 + 文档生成 都可用）───
    "search_web": {
        "schema": {
            "type": "function",
            "function": {
                "name": "search_web",
                "description": "搜索互联网，返回相关网页结果。当你需要查找最新信息、事实、或自己不确定的知识时使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词，用简洁准确的中文或英文"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        "handler": "search_engine.search",
        "require": None  # cloud 模式一定有网
    },
    "fetch_url": {
        "schema": {
            "type": "function",
            "function": {
                "name": "fetch_url",
                "description": "抓取指定网页的正文内容。当搜索结果中有值得深入阅读的页面时使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "要抓取的网页 URL"
                        }
                    },
                    "required": ["url"]
                }
            }
        },
        "handler": "search_engine.fetch",
        "require": None
    },
    "search_kb": {
        "schema": {
            "type": "function",
            "function": {
                "name": "search_kb",
                "description": "搜索用户本地知识库中的文档。当用户的问题可能涉及已导入的文档、笔记、资料时使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索查询，使用与用户问题相关的关键词"
                        }
                    },
                    "required": ["query"]
                }
            }
        },
        "handler": "kb_manager.search",
        "require": "kb"  # 条件：KB 扩展已安装
    },

    # ─── 文档专用工具 ──────────────────────────
    "parse_template": {
        "schema": {
            "type": "function",
            "function": {
                "name": "parse_template",
                "description": "解析用户上传的 docx 模板文件，提取其结构（标题层级、段落风格、表格结构等）。仅在用户要求按特定格式生成文档时使用。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "file_url": {
                            "type": "string",
                            "description": "用户上传的模板文件路径或 URL"
                        }
                    },
                    "required": ["file_url"]
                }
            }
        },
        "handler": "template_parser.parse",
        "require": "doc_mode"
    },
    "compile_docx": {
        "schema": {
            "type": "function",
            "function": {
                "name": "compile_docx",
                "description": "将大纲和内容编译为 docx 文档并生成下载链接。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string", "description": "文档标题"},
                        "sections": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "properties": {
                                    "heading": {"type": "string", "description": "章节标题"},
                                    "level": {"type": "integer", "description": "标题层级（1=一级标题，2=二级标题）"},
                                    "content": {"type": "string", "description": "章节正文内容"}
                                },
                                "required": ["heading", "level", "content"]
                            },
                            "description": "文档章节列表"
                        },
                        "template_id": {
                            "type": "string",
                            "description": "（可选）之前解析的模板 ID，用于套用样式"
                        }
                    },
                    "required": ["title", "sections"]
                }
            }
        },
        "handler": "doc_compiler.compile",
        "require": "doc_mode"
    },
}
```

### 2.5 动态组装逻辑

```python
def build_tools_and_prompt(context: dict) -> tuple[list, str]:
    """
    根据当前环境动态组装工具列表 + system prompt

    context 包含:
      - kb_available: bool  (KB 扩展是否已安装)
      - doc_mode: bool      (是否是文档生成模式)
      - user_references: list (用户提供的参考资料)
      - user_template: str  (用户上传的模板路径)
    """
    available_tools = []
    tool_descriptions = []

    for name, tool in TOOL_REGISTRY.items():
        req = tool["require"]
        if req is None:
            # cloud 模式一定有网，通用工具直接注册
            available_tools.append(tool["schema"])
            tool_descriptions.append(tool["schema"]["function"]["description"])
        elif req == "kb" and context.get("kb_available"):
            available_tools.append(tool["schema"])
            tool_descriptions.append(tool["schema"]["function"]["description"])
        elif req == "doc_mode" and context.get("doc_mode"):
            # 文档模式额外注册文档工具
            available_tools.append(tool["schema"])
            tool_descriptions.append(tool["schema"]["function"]["description"])

    # 组装 system prompt
    system = BASE_SYSTEM_PROMPT

    if context.get("doc_mode"):
        system += DOC_MODE_PROMPT_EXTENSION
    else:
        system += "\n\n你可以使用以下工具来帮助回答问题。请在需要时主动使用，不必每条消息都使用。\n"
        for desc in tool_descriptions:
            system += f"- {desc}\n"

    if context.get("user_references"):
        system += "\n\n用户提供了以下参考资料：\n"
        for ref in context["user_references"]:
            system += f"---\n{ref}\n---\n"

    if context.get("user_template"):
        system += f"\n\n用户上传了文档模板，请先用 parse_template 工具解析模板结构，然后按照模板格式生成文档。"

    return available_tools, system
```

---

## 三、核心模块设计

### 3.1 CloudEngine 扩展（cloud_engine.py）

**新增方法**：`chat_with_tools()`

```python
async def chat_with_tools(
    self,
    messages: list,
    tools: list,
    model: str = None,
) -> AsyncGenerator:
    """
    带工具调用的流式对话。

    yield 事件类型:
      ("tool_call", {"index": int, "id": str, "name": str, "arguments_delta": str})
      ("think", str)   — 推理模型的思考内容
      ("text", str)    — 正常文本 token
      ("done", None)   — 流结束
    """
    model = model or self.default_model
    stream = await self.client.chat.completions.create(
        model=model,
        messages=messages,
        tools=tools,
        stream=True,
    )

    async for chunk in stream:
        choice = chunk.choices[0]
        delta = choice.delta

        # 工具调用（增量拼接）
        if delta.tool_calls:
            for tc in delta.tool_calls:
                yield ("tool_call", {
                    "index": tc.index,
                    "id": tc.id or "",
                    "name": (tc.function.name or "") if tc.function else "",
                    "arguments_delta": (tc.function.arguments or "") if tc.function else "",
                })

        # 推理内容
        if hasattr(delta, 'reasoning_content') and delta.reasoning_content:
            yield ("think", delta.reasoning_content)

        # 正常文本
        if delta.content:
            yield ("text", delta.content)

        # 流结束
        if choice.finish_reason:
            yield ("done", None)
```

### 3.2 AgentLoop（agent_loop.py）

```python
MAX_ROUNDS = 10
MAX_TOOL_HISTORY_TOKENS = 40000  # 工具历史 token 上限（约 3 万字）

class AgentLoop:
    def __init__(self, cloud_engine, tool_registry):
        self.engine = cloud_engine
        self.registry = tool_registry

    async def run(
        self,
        messages: list,
        tools: list,
        on_event=None,
    ) -> AsyncGenerator:
        """
        ReAct 循环。

        yield 事件类型:
          ("agent_status", {"status": str, ...})  — 实时状态更新
          ("agent_summary", {"searches": N, ...})  — 最终统计摘要
          ("text", str)  — 最终回答的文本 token
        """
        stats = {"searches": 0, "fetches": 0, "kb_hits": 0, "docs": 0}
        start_time = time.time()

        for round_num in range(MAX_ROUNDS):
            # Token 预算检查
            if self._should_compress(messages):
                self._compress_tool_history(messages)
            if self._is_over_budget(messages):
                yield ("agent_status", {"status": "budget_exceeded"})
                break

            # 发送"思考中"状态
            yield ("agent_status", {"status": "thinking"})

            # 收集本轮模型输出
            tool_call_buffers = {}  # index → {id, name, arguments}
            text_collector = []
            has_tool_calls = False

            async for event in self.engine.chat_with_tools(messages, tools):
                if event[0] == "tool_call":
                    has_tool_calls = True
                    tc = event[1]
                    idx = tc["index"]
                    if idx not in tool_call_buffers:
                        tool_call_buffers[idx] = {
                            "id": tc["id"],
                            "name": tc["name"],
                            "arguments": ""
                        }
                    tool_call_buffers[idx]["arguments"] += tc["arguments_delta"]

                elif event[0] == "text":
                    text_collector.append(event[1])

                elif event[0] == "done":
                    pass  # 流结束标记

            if not has_tool_calls:
                # 模型没调工具 = 最终回答
                break

            # 执行所有工具调用
            assistant_content = []
            for idx in sorted(tool_call_buffers.keys()):
                tc = tool_call_buffers[idx]
                try:
                    args = json.loads(tc["arguments"])
                except json.JSONDecodeError:
                    args = {}

                # 发送工具状态（前端实时显示）
                yield self._make_status_event(tc["name"], args)

                # 执行工具
                result = await self._execute_tool(tc["name"], args)

                # 发送完成状态
                yield self._make_done_event(tc["name"], result)

                # 更新统计
                if tc["name"] == "search_web":
                    stats["searches"] += 1
                elif tc["name"] == "fetch_url":
                    stats["fetches"] += 1
                elif tc["name"] == "search_kb":
                    stats["kb_hits"] += 1
                elif tc["name"] in ("parse_template", "compile_docx"):
                    stats["docs"] += 1

                # 追加到 messages（OpenAI FC 格式）
                assistant_content.append({
                    "type": "function",
                    "id": tc["id"],
                    "function": {
                        "name": tc["name"],
                        "arguments": tc["arguments"]
                    }
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc["id"],
                    "content": json.dumps(result, ensure_ascii=False)
                })

            # 追加 assistant message（含 tool_calls）
            messages.append({
                "role": "assistant",
                "content": None,
                "tool_calls": assistant_content
            })

        # 统计摘要
        elapsed = int(time.time() - start_time)
        has_stats = any(v > 0 for v in stats.values())
        if has_stats:
            yield ("agent_summary", {**stats, "elapsed": elapsed})

        # 最终回答（流式）
        async for event in self.engine.chat_with_tools(messages, tools=[]):
            if event[0] == "text":
                yield event
            elif event[0] == "done":
                break

    def _make_status_event(self, tool_name: str, args: dict) -> tuple:
        """根据工具类型生成前端状态事件"""
        if tool_name == "search_web":
            return ("agent_status", {"status": "searching", "query": args.get("query", "")})
        elif tool_name == "fetch_url":
            url = args.get("url", "")
            domain = url.split("/")[2] if "/" in url else url
            return ("agent_status", {"status": "fetching", "url": domain})
        elif tool_name == "search_kb":
            return ("agent_status", {"status": "kb_searching", "query": args.get("query", "")})
        elif tool_name == "parse_template":
            return ("agent_status", {"status": "parsing_template"})
        elif tool_name == "compile_docx":
            return ("agent_status", {"status": "compiling_doc"})
        return ("agent_status", {"status": "processing"})

    def _make_done_event(self, tool_name: str, result: dict) -> tuple:
        """根据工具类型生成完成状态事件"""
        if not result.get("success"):
            return ("agent_status", {"status": "error", "tool": tool_name})
        data = result.get("data", {})
        if tool_name == "search_web":
            count = len(data.get("results", [])) if isinstance(data, dict) else 0
            return ("agent_status", {"status": "search_done", "count": count})
        elif tool_name == "fetch_url":
            length = data.get("length", 0) if isinstance(data, dict) else 0
            return ("agent_status", {"status": "fetch_done", "length": length})
        elif tool_name == "search_kb":
            count = len(data) if isinstance(data, list) else 0
            return ("agent_status", {"status": "kb_done", "count": count})
        return ("agent_status", {"status": "tool_done", "tool": tool_name})

    async def _execute_tool(self, name: str, args: dict) -> dict:
        """执行单个工具，返回结构化结果"""
        tool_def = self.registry.get(name)
        if not tool_def:
            return {"success": False, "error": f"未知工具: {name}"}

        handler = self._resolve_handler(tool_def["handler"])
        try:
            result = await handler(**args)
            return {"success": True, "data": result}
        except asyncio.TimeoutError:
            return {
                "success": False,
                "error": "timeout",
                "message": f"工具 {name} 执行超时（15秒），可以尝试其他方法或直接回答。"
            }
        except Exception as e:
            return {
                "success": False,
                "error": str(e),
                "message": f"工具 {name} 执行失败：{e}。可以尝试其他方法。"
            }

    def _should_compress(self, messages: list) -> bool:
        """检查工具历史是否需要压缩"""
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        total_chars = sum(len(m.get("content", "")) for m in tool_msgs)
        return (total_chars / 1.5) > MAX_TOOL_HISTORY_TOKENS

    def _compress_tool_history(self, messages: list):
        """压缩旧的工具历史：保留最近 2 轮完整结果，之前的只保留摘要"""
        tool_indices = [i for i, m in enumerate(messages) if m.get("role") == "tool"]
        if len(tool_indices) <= 4:
            return
        for idx in tool_indices[:-4]:
            content = messages[idx].get("content", "")
            summary = _make_tool_summary(content)
            messages[idx]["content"] = json.dumps({
                "success": True,
                "_compressed": True,
                "summary": summary
            })

    def _is_over_budget(self, messages: list) -> bool:
        """Token 是否严重超限（压缩后仍超）"""
        tool_msgs = [m for m in messages if m.get("role") == "tool"]
        total_chars = sum(len(m.get("content", "")) for m in tool_msgs)
        return (total_chars / 1.5) > MAX_TOOL_HISTORY_TOKENS * 1.5
```

### 3.3 CloudPipeline 精简版（cloud_pipeline.py）

```python
async def handle_cloud_chat(self, user_msg, history, context):
    """在线模式入口"""
    # 1. 动态组装工具 + prompt
    tools, system_prompt = build_tools_and_prompt(context)

    # 2. 组装 messages
    messages = [{"role": "system", "content": system_prompt}]
    messages.extend(history[-context.get("history_limit", 20):])
    messages.append({"role": "user", "content": user_msg})

    # 3. 运行 Agent Loop（所有模式统一入口）
    loop = AgentLoop(self.cloud_engine, TOOL_REGISTRY)
    async for event in loop.run(messages, tools):
        yield event  # 直接透传：agent_status / agent_summary / text

    # 4. 保存对话
    await self._save_conversation(user_msg, ...)
```

---

## 四、SearchEngine 升级（curl_cffi）

### 4.1 变更内容

将 `core/search_engine.py` 的 HTTP 客户端从 `httpx` 替换为 `curl_cffi`，获得 TLS 指纹伪装能力。

### 4.2 核心变更

```python
# 旧: import httpx
# 新:
from curl_cffi.requests import AsyncSession

class SearchEngine:
    async def search(self, query: str, count: int = 8) -> list:
        """Bing 搜索"""
        url = f"https://www.bing.com/search?q={quote(query)}"
        headers = self._build_stealth_headers()

        async with AsyncSession(impersonate="chrome") as session:
            resp = await session.get(url, headers=headers, timeout=15)
            # ... Bing HTML 正则解析不变 ...

    async def fetch(self, url: str) -> dict:
        """抓取网页正文"""
        headers = self._build_stealth_headers()

        async with AsyncSession(impersonate="chrome") as session:
            resp = await session.get(url, headers=headers, timeout=15)
            # ... readability-lxml 内容提取不变 ...

    def _build_stealth_headers(self) -> dict:
        """参考 Scrapling 的隐身头策略"""
        return {
            "User-Agent": self._random_ua(),  # 或 browserforge 生成
            "Accept": "text/html,application/xhtml+xml",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Referer": "https://www.google.com/",  # Scrapling 策略
            "DNT": "1",
        }
```

### 4.3 curl_cffi fallback

```python
# 兼容性：嵌入式 Python 可能编译失败
try:
    from curl_cffi.requests import AsyncSession
    _USE_CURL_CFFI = True
except ImportError:
    import httpx
    _USE_CURL_CFFI = False
```

### 4.4 新增依赖

| 包 | 版本 | 体积 | 用途 |
|----|------|------|------|
| `curl_cffi` | ≥0.15.0 | ~5MB wheel | TLS 指纹伪装 + HTTP 请求 |
| `browserforge`（可选） | latest | ~1MB | 真实浏览器 UA/头生成 |

---

## 五、前端改动

### 5.1 SSE 事件设计

**新增事件（3 个）**：

| 事件 | 数据 | 说明 |
|------|------|------|
| `agent_status` | `{status: string, query?: string, url?: string, count?: int, length?: int}` | 实时状态更新 |
| `agent_summary` | `{searches, fetches, kb_hits, docs, elapsed}` | 最终统计摘要 |
| `agent_think` | `string` | 推理模型思考 token（可折叠展示） |

**旧事件处理**：

| 事件 | 处理方式 | 理由 |
|------|---------|------|
| `agent_start` | 保留代码不删 | 不会被触发，留作兼容 |
| `agent_action` | 保留代码不删 | 被 `agent_status` 替代 |
| `agent_result` | 保留代码不删 | 被 `agent_status` 替代 |
| `agent_done` | 保留代码不删 | 被 `agent_summary` 替代 |

**agent_status 的 status 值**：

| status | 显示 | 说明 |
|--------|------|------|
| `thinking` | 🔄 思考中... | 模型在生成 |
| `searching` | 🔍 搜索「query」... | 正在搜索 |
| `search_done` | ✅ 搜索完成 — N 条结果 | 搜索完成 |
| `fetching` | 🔗 正在阅读 domain... | 正在抓取网页 |
| `fetch_done` | ✅ 获取 N 字内容 | 抓取完成 |
| `kb_searching` | 📚 检索知识库「query」... | 正在搜索 KB |
| `kb_done` | ✅ 找到 N 篇相关文档 | KB 搜索完成 |
| `parsing_template` | 📄 解析文档模板... | 模板解析中 |
| `compiling_doc` | 📝 生成文档... | docx 编译中 |
| `budget_exceeded` | ⚠️ 工具调用已达上限 | 触发 token 预算限制 |
| `error` | ❌ 工具执行失败 | 工具异常 |

### 5.2 chat.js 渲染逻辑

```javascript
// === 新增全局变量 ===
var _agentStatusLine = null;  // 当前状态行 DOM 元素

// === SSE 事件处理 ===

case "agent_status":
    _handleAgentStatus(event.data);
    break;

case "agent_summary":
    _handleAgentSummary(event.data);
    break;

case "agent_think":
    _handleAgentThink(event.data);
    break;

// === 状态指示器（方案 C：滚动状态栏）===

function _handleAgentStatus(data) {
    if (!_agentStatusLine) {
        _agentStatusLine = document.createElement("div");
        _agentStatusLine.className = "agent-status";
        // 插入到流式容器最前面
        var stream = document.getElementById("stream-container");
        if (stream) stream.prepend(_agentStatusLine);
    }

    var html = "";
    switch (data.status) {
        case "thinking":
            html = '<span class="agent-spin">🔄</span> 思考中...';
            break;
        case "searching":
            html = '<span class="agent-spin">🔍</span> 搜索「' + _esc(data.query) + '」...';
            break;
        case "search_done":
            html = '✅ 搜索完成 — ' + data.count + ' 条结果';
            break;
        case "fetching":
            html = '<span class="agent-spin">🔗</span> 正在阅读 ' + _esc(data.url) + '...';
            break;
        case "fetch_done":
            html = '✅ 获取 ' + data.length + ' 字内容';
            break;
        case "kb_searching":
            html = '<span class="agent-spin">📚</span> 检索知识库「' + _esc(data.query) + '」...';
            break;
        case "kb_done":
            html = '✅ 找到 ' + data.count + ' 篇相关文档';
            break;
        case "parsing_template":
            html = '<span class="agent-spin">📄</span> 解析文档模板...';
            break;
        case "compiling_doc":
            html = '<span class="agent-spin">📝</span> 生成文档...';
            break;
        case "budget_exceeded":
            html = '⚠️ 工具调用已达上限，正在整理回答...';
            break;
        default:
            html = '<span class="agent-spin">⏳</span> 处理中...';
    }
    _agentStatusLine.innerHTML = html;
}

function _handleAgentSummary(data) {
    // 从动态状态 → 固化摘要
    var parts = [];
    if (data.searches) parts.push('搜索了 ' + data.searches + ' 次');
    if (data.fetches) parts.push('抓取了 ' + data.fetches + ' 个网页');
    if (data.kb_hits) parts.push('检索了 ' + data.kb_hits + ' 篇文档');
    if (data.docs) parts.push('生成了 ' + data.docs + ' 个文档');
    if (data.elapsed) parts.push('用时 ' + data.elapsed + ' 秒');

    if (!parts.length) return;

    if (_agentStatusLine) {
        _agentStatusLine.className = "agent-summary";
        _agentStatusLine.innerHTML = '[' + parts.join(' · ') + ']';
        _agentStatusLine = null;  // 释放引用
    } else {
        var div = document.createElement("div");
        div.className = "agent-summary";
        div.textContent = '[' + parts.join(' · ') + ']';
        var stream = document.getElementById("stream-container");
        if (stream) stream.prepend(div);
    }
}

function _handleAgentThink(token) {
    // 推理思考内容，用可折叠区展示
    var thinkBlock = document.getElementById("agent-think-block");
    if (!thinkBlock) {
        thinkBlock = document.createElement("details");
        thinkBlock.id = "agent-think-block";
        thinkBlock.className = "agent-think";
        thinkBlock.innerHTML = '<summary>💭 思考过程</summary><div class="think-content"></div>';
        var stream = document.getElementById("stream-container");
        if (stream) stream.prepend(thinkBlock);
    }
    thinkBlock.querySelector(".think-content").textContent += token;
}

function _esc(str) {
    // 简单 HTML 转义
    var d = document.createElement("div");
    d.textContent = str || "";
    return d.innerHTML;
}
```

### 5.3 Action 按钮变化（chat-actions.js）

```javascript
// refreshActionBar() 修改
if (isCloudMode) {
    // 在线模式只显示 2 个按钮
    renderActionButtons([
        {id: "agent", label: "智能对话", icon: "💬", active: currentActionMode === "agent"},
        {id: "doc", label: "文档生成", icon: "📄", active: currentActionMode === "doc"},
    ]);
} else {
    // 本地模式保持 3 个按钮
    renderActionButtons([
        {id: "chat", label: "聊天", icon: "💬", active: currentActionMode === "chat"},
        {id: "kb", label: "文库问答", icon: "📚", active: currentActionMode === "kb"},
        {id: "doc", label: "文档生成", icon: "📄", active: currentActionMode === "doc"},
    ]);
}
```

### 5.4 CSS

```css
/* Agent 状态指示器 */
.agent-status {
    font-size: 0.85em;
    color: var(--text-secondary);
    margin-bottom: 8px;
    padding: 6px 10px;
    border-radius: 6px;
    background: var(--bg-secondary);
    display: inline-block;
    min-height: 1.4em;
}

/* Agent 统计摘要（固化后） */
.agent-summary {
    font-size: 0.85em;
    color: var(--text-secondary);
    margin-bottom: 8px;
    padding: 4px 10px;
    border-radius: 6px;
    background: var(--bg-secondary);
    display: inline-block;
}

/* 旋转动画 */
.agent-spin {
    display: inline-block;
    animation: agent-spin-anim 1s linear infinite;
}
@keyframes agent-spin-anim {
    to { transform: rotate(360deg); }
}

/* 思考过程折叠区 */
.agent-think {
    margin-bottom: 8px;
    font-size: 0.85em;
    color: var(--text-secondary);
    background: var(--bg-secondary);
    border-radius: 6px;
    padding: 4px 10px;
}
.agent-think summary {
    cursor: pointer;
    user-select: none;
}
.agent-think .think-content {
    max-height: 200px;
    overflow-y: auto;
    padding: 4px 0;
    white-space: pre-wrap;
}
```

---

## 六、文档生成：在线模式设计

### 6.1 核心理念

**在线模式的文档生成不是"工具链"，是 Agent 拿着全部工具自主写作。**

```
本地模式 doc_action.py:
  固定流程：主题 → 小模型大纲 → 用户确认 → 小模型逐段 → docx
  模板硬编码，参考资料无，小模型一次只做一步

在线模式 Agent:
  用户意图（"写个报告"）+ 可选参考资料 + 可选模板
    → Agent 自主决定：
       1. 要不要搜 KB 找参考资料？（用 search_kb 工具）
       2. 要不要搜网补充信息？（用 search_web / fetch_url 工具）
       3. 用户给了模板？→ 先解析模板结构（用 parse_template 工具）
       4. 规划大纲 → 展示给用户确认
       5. 按大纲写内容（模型直接在文本输出中写）
       6. 编译 docx（用 compile_docx 工具）
    → 模型有能力的话可能一次搞定，也可能分几步
    → 我们不限制它，让它自己决定最优策略
```

**复用的部分**：`python-docx` 的 `compile_docx` 底层实现
**不复用的部分**：所有流程控制（doc_action.py 的两阶段逻辑、大纲确认 UI 等）

### 6.2 对比

| 维度 | 本地模式 | 在线模式 |
|------|---------|---------|
| 流程 | 固定：主题→大纲→确认→逐段→docx | 灵活：Agent 自主决定步骤 |
| 模板 | 硬编码或简单预设 | 用户上传 docx → parse_template → 套用 |
| 参考资料 | 无 | KB 检索 + 用户上传 + 网络搜索 |
| 大纲 | 小模型生成，结构简单 | 大模型生成，可含复杂结构 |
| 用户交互 | 必须确认大纲 | 可确认可跳过（Agent 自主判断） |
| 复用 | — | 仅复用 python-docx 输出层 |

### 6.3 模板解析（template_parser.py，新增）

```python
class TemplateParser:
    def parse(self, docx_path: str) -> dict:
        """
        解析 docx 模板结构

        返回:
        {
            "sections": [
                {"type": "cover", "title": "模板标题"},
                {"type": "heading", "level": 1, "text": "一、概述"},
                {"type": "paragraph"},
                {"type": "table", "cols": 4, "headers": ["项目","状态","风险","措施"]},
                ...
            ],
            "styles": {
                "heading1": {"font": "...", "size": ..., "bold": true},
                "body": {"font": "...", "size": ...},
            },
            "template_id": "tmpl_xxx"  # 缓存 ID
        }
        """
        # 使用 python-docx 解析
        # 提取标题层级、段落样式、表格结构
        # 缓存解析结果，避免重复解析
```

### 6.4 用户体验流程

```
用户: "帮我写一份Q2安全报告"
  （可选: 上传 template.docx → "照这个格式写"）
  （可选: 勾选 KB 里的参考文档）

Agent:
  📚 检索知识库「Q2 安全事件」...
  ✅ 找到 3 篇相关文档
  🔍 搜索「2026 Q2 网络安全趋势」...
  ✅ 搜索完成 — 5 条结果
  🔗 正在阅读 securityweek.com...
  ✅ 获取 2800 字内容

  📋 以下是我规划的文档大纲：

     一、概述
     二、Q2 安全事件统计（含表格）
     三、风险评估分析
     四、改进措施建议
     五、下季度安全计划

  请确认大纲，或告诉我需要修改的地方。

  [确认] [修改]              ← 用户交互点

  (用户确认后)
  📝 生成文档...
  ✅ 文档已生成 [用时 35 秒 · 检索了知识库 · 搜索了 1 次 · 抓取了 1 个网页]
  📄 Q2安全报告.docx [下载]
```

---

## 七、会话存储升级

### 7.1 从单 JSON 文件 → 会话文件夹

**现状**：
```
server/data/chats/
  ├── 2026-06-05_001.json    ← 一个 JSON = 一个会话（消息+缓存+元数据全塞一起）
  └── 2026-06-06_001.json
```

**新方案**：
```
server/data/chats/
  ├── 2026-06-05_001/
  │   ├── meta.json           ← 会话元数据（侧边栏只读这个）
  │   ├── messages.json       ← 消息历史（核心）
  │   ├── context_cache.json  ← 上下文压缩缓存（独立）
  │   ├── tool_history.json   ← Agent 工具调用历史（可选，在线模式才有）
  │   └── assets/             ← 会话产物
  │       ├── Q2安全报告.docx
  │       └── template_abc.docx
  └── 2026-06-06_001/
      ├── meta.json
      └── messages.json
```

### 7.2 各文件内容

**meta.json**（轻量，侧边栏列表只读这个）：
```json
{
    "id": "2026-06-06_001",
    "title": "草船借箭相关讨论",
    "created_at": "2026-06-06 20:30:00",
    "updated_at": "2026-06-06 21:15:00",
    "message_count": 12,
    "mode": "cloud",
    "has_doc": true,
    "tags": []
}
```

**messages.json**（核心消息历史，version 3 新增 agent_summary 和 tool_history_ref）：
```json
{
    "version": 3,
    "messages": [
        {
            "role": "user",
            "content": "帮我搜一下草船借箭",
            "ts": "20:30:00"
        },
        {
            "role": "assistant",
            "content": "草船借箭是...",
            "ts": "20:30:15",
            "model": "glm-5.1",
            "task_type": "agent",
            "action_mode": "agent",
            "agent_summary": {"searches": 1, "fetches": 1, "elapsed": 12},
            "tool_history_ref": "tool_history.json"
        }
    ]
}
```

**tool_history.json**（可选，Agent 模式才有，用于调试和历史回溯）：
```json
[
    {
        "round": 1,
        "tool": "search_web",
        "args": {"query": "草船借箭"},
        "result_summary": "找到 8 条结果",
        "timestamp": "20:30:05"
    }
]
```

### 7.3 优势

| 对比 | 现在（单 JSON） | 新方案（文件夹） |
|------|----------------|----------------|
| 侧边栏列表 | 读整个 JSON | 只读 meta.json（几 KB） |
| 加载聊天 | 读整个 JSON | 只读 messages.json |
| Agent 历史 | 塞在 messages 里，越来越大 | 独立 tool_history.json，可压缩 |
| 产物管理 | docx 散落 /data/docs/ | 每个会话的 assets/，删会话 = 删产物 |
| 删除 | 删一个 JSON | 删一个文件夹（`shutil.rmtree`） |
| 本地/在线 | 同一结构 | 统一结构 |

### 7.4 迁移策略

启动时自动检测旧格式并迁移：

```python
def migrate_chats():
    chat_dir = Path(CHAT_DIR)
    for json_file in chat_dir.glob("*.json"):
        old_data = json.loads(json_file.read_text(encoding="utf-8"))
        folder = chat_dir / json_file.stem
        folder.mkdir(exist_ok=True)

        # 写 meta.json
        meta = {
            "id": json_file.stem,
            "title": json_file.stem,
            "created_at": old_data.get("updated_at", ""),
            "updated_at": old_data.get("updated_at", ""),
            "message_count": len(old_data.get("messages", [])),
            "mode": "local",
        }
        (folder / "meta.json").write_text(json.dumps(meta, ensure_ascii=False))

        # 写 messages.json（升级到 version 3）
        msgs = {"version": 3, "messages": old_data.get("messages", [])}
        (folder / "messages.json").write_text(json.dumps(msgs, ensure_ascii=False))

        # 处理 context_cache
        if old_data.get("context_cache"):
            (folder / "context_cache.json").write_text(
                json.dumps(old_data["context_cache"], ensure_ascii=False)
            )

        json_file.unlink()  # 删旧文件
```

### 7.5 chat_store.py 改动

| 函数 | 改动 |
|------|------|
| `new_chat_file()` | 创建文件夹 + meta.json + messages.json |
| `save_chat()` | 写 messages.json（原子写入策略不变） |
| `load_chat()` | 读 messages.json |
| `load_chat_cache()` | 读 context_cache.json |
| `list_chats()` | 读各文件夹的 meta.json |
| `rename_chat()` | 更新 meta.json 的 title |

---

## 八、Token 预算管理

### 8.1 策略

| 维度 | 限制 | 说明 |
|------|------|------|
| 轮次上限 | `MAX_ROUNDS = 10` | 硬限制，最多 10 轮工具调用 |
| 工具历史 token | `MAX_TOOL_HISTORY_TOKENS = 40000` | 超过后自动压缩 |
| 压缩策略 | 保留最近 2 轮完整结果，旧记录压缩为摘要 | 避免模型丢失近期上下文 |
| 超限处理 | 压缩后仍超限 → 停止工具调用，模型基于已有信息回答 | 防止 token 消耗失控 |

### 8.2 错误处理（模型自修复）

工具返回格式包含错误信息和建议，模型可以自主调整策略：

```json
// 成功
{"success": true, "data": {"results": [...], "count": 8}}

// 超时
{
    "success": false,
    "error": "timeout",
    "message": "请求超时（15秒），目标站点未响应。可以尝试其他链接或直接基于已有知识回答。"
}

// 空结果
{
    "success": true,
    "data": {"results": [], "count": 0},
    "message": "未找到相关结果，建议换关键词或直接回答。"
}

// 被拦截
{
    "success": false,
    "error": "blocked",
    "message": "目标网站拒绝访问（403），可以尝试其他来源。"
}
```

---

## 九、文件变更清单

### 9.1 后端

| 文件 | 操作 | 规模 | 说明 |
|------|------|------|------|
| `core/agent_loop.py` | **新增** | ~200 行 | ReAct 循环 + 工具调度 + 状态事件 + Token 管理 |
| `core/agent_tools.py` | **新增** | ~130 行 | 工具注册表 + 动态组装 |
| `core/template_parser.py` | **新增** | ~100 行 | docx 模板结构解析 |
| `core/cloud_engine.py` | **修改** | +60 行 | 新增 `chat_with_tools()` + tool_calls SSE |
| `core/search_engine.py` | **修改** | ~40 行 | httpx → curl_cffi + 隐身头 + fallback |
| `pipelines/cloud_pipeline.py` | **重写** | -300/+80 行 | 从固定 pipeline → 调用 agent_loop |
| `session/chat_store.py` | **修改** | ~60 行 | JSON 文件 → 文件夹 + 迁移 |
| `intelligence/action_registry.py` | **修改** | ~20 行 | 在线模式注册 agent/doc 两个 action |
| `actions/research_action.py` | **废弃** | -207 行 | 被 Agent Loop 吸收 |
| `actions/doc_action.py` | **修改** | ~30 行 | 在线分支删除，全部走 Agent |
| `core/config.py` | **小改** | +10 行 | 新增 agent / 会话存储配置 |

### 9.2 前端

| 文件 | 操作 | 规模 | 说明 |
|------|------|------|------|
| `static/js/chat.js` | **修改** | +60 行 | agent_status / agent_summary / agent_think 事件处理 |
| `static/js/chat-actions.js` | **修改** | +15 行 | 在线模式 2 个按钮 / 本地 3 个按钮 |
| `static/css/chat.css` | **小改** | +30 行 | agent-status / agent-summary / agent-think 样式 |

### 9.3 依赖变更

| 包 | 操作 | 说明 |
|----|------|------|
| `curl_cffi` | **新增** | TLS 指纹伪装，替换 httpx（有 fallback） |
| `browserforge` | **新增（可选）** | 真实浏览器 UA 生成 |

### 9.4 废弃

| 文件 | 原因 |
|------|------|
| `actions/research_action.py` | `<SEARCH:>` / `<FETCH:>` 标记逻辑被 Agent Loop + FC 协议替代 |

---

## 十、实施计划

### Phase 1：基础设施（无前端改动）

1. 新增 `core/agent_tools.py` — 工具注册表
2. 扩展 `core/cloud_engine.py` — `chat_with_tools()` + tool_calls 解析
3. 新增 `core/agent_loop.py` — ReAct 循环骨架
4. 升级 `core/search_engine.py` — httpx → curl_cffi（含 fallback）

### Phase 2：Pipeline + 存储

5. 重写 `pipelines/cloud_pipeline.py` — 调用 AgentLoop
6. 升级 `session/chat_store.py` — 文件夹存储 + 迁移
7. 修改 `intelligence/action_registry.py` — 在线 2 按钮
8. 适配 `actions/doc_action.py` — 在线分支删除

### Phase 3：前端

9. `chat.js` — agent_status / agent_summary / agent_think 事件
10. `chat-actions.js` — 在线 2 按钮 / 本地 3 按钮
11. `chat.css` — 状态指示器 + 摘要 + 思考样式

### Phase 4：文档增强

12. 新增 `core/template_parser.py` — docx 模板解析
13. 文档工具联调（parse_template → compile_docx）
14. 文档生成 system prompt 调优

### Phase 5：清理

15. 废弃 `actions/research_action.py`
16. 更新 `config.py` + `deps_check.py`
17. 端到端测试

---

## 十一、风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| `curl_cffi` 在嵌入式 Python 编译失败 | SearchEngine 无法升级 | 保留 httpx fallback，`try: curl_cffi except: httpx` |
| 模型不支持 FC（tool_calls） | Agent Loop 无法工作 | 检测 finish_reason，不支持则降级为现有 pipeline |
| tool_calls 流式拼接 JSON 碎片丢失 | 参数解析失败 | 加 JSON 修复逻辑（补全引号/括号） |
| Agent 循环超 10 轮不停止 | Token 消耗过大 | 硬限制 MAX_ROUNDS + token 预算压缩 |
| `browserforge` 体积过大 | 打包体积增加 | 标记为可选，fallback 到硬编码 UA 列表 |
| 会话迁移中断（启动时 crash） | 旧格式丢失 | 迁移前先备份，失败回滚 |
| 文档生成 Agent 写的太差 | 用户体验差 | 文档 system prompt 精心调优，给足够的写作指导 |

---

## 十二、讨论记录

本方案基于 2026-06-06 ~ 06-07 的架构讨论，核心决策：

1. ✅ 在线模式从 Pipeline → Agent Loop（ReAct）
2. ✅ 工具调用协议用 OpenAI Function Calling JSON
3. ✅ System Prompt 动态组装（按 KB/文档模式/参考资料条件）
4. ✅ CloudEngine 扩展（非绕过），三层架构
5. ✅ curl_cffi 替换 httpx（TLS 伪装，有 fallback）
6. ✅ 前端实时状态指示器（agent_status 事件 + 旋转动画）
7. ✅ 前端最终统计摘要（agent_summary 事件）
8. ✅ 文档生成：Agent 拿着全部工具自主写作，不是固定工具链
9. ✅ 参考 Scrapling 的隐身头策略，不引入 Scrapling 本体
10. ✅ 在线模式永远有网（不需要 network 条件判断）
11. ✅ Agent Loop 最多 10 轮工具调用 + Token 预算管理（40000 token）
12. ✅ 会话存储从 JSON 文件 → 文件夹（meta.json + messages.json + assets/），启动自动迁移
13. ✅ 在线模式 UI 2 个按钮：智能对话 + 文档生成；本地模式保持 3 个按钮
14. ✅ 文档生成完全不复用本地模式的流程控制，仅复用 python-docx 输出层
15. ✅ SSE 事件精简为 3 个：agent_think / agent_status / agent_summary
16. ✅ 不做用户可配置的工具系统——内部 TOOL_REGISTRY 足够灵活，不暴露给用户
17. ✅ 在线模式完全独立于本地模式——两者只共享底层工具实现
18. ✅ FC 兼容性：运行时错误捕获 fallback（不预判模型能力），tool_calls 解析失败 → 纯文本输出
19. ✅ 实施顺序：Phase 1-5 一次性全部实施，最后统一回归测试
20. ✅ curl_cffi 作为最后优化项，不影响 Agent Loop 核心功能，装不上就用 httpx
