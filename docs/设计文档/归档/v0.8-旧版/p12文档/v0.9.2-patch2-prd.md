# 桌伴 Sidemate v0.9.2 Patch2 — 产品需求文档 (PRD)

> **版本**：v0.9.2 Patch2
> **日期**：2026-06-05
> **作者**：许清楚（产品经理）
> **技术栈**：FastAPI 后端 + 原生 JS 前端（`<script>` 引入）+ Ollama 本地模型 + OpenAI 兼容云端 API

---

## 目录

1. [项目概述](#1-项目概述)
2. [现有系统概览](#2-现有系统概览)
3. [任务总览与依赖关系](#3-任务总览与依赖关系)
4. [P0 后端任务](#4-p0-后端任务)
5. [P0 前端任务](#5-p0-前端任务)
6. [P1 后端任务](#6-p1-后端任务)
7. [P1 前端任务](#7-p1-前端任务)
8. [架构级任务](#8-架构级任务)
9. [新增依赖汇总](#9-新增依赖汇总)

---

## 1. 项目概述

### 1.1 目标

在 v0.9 Patch1 基础上，Patch2 版本主要实现：
- **云端 AI 模式**：支持切换本地 Ollama / 云端 OpenAI 兼容 API
- **Research Action 联网研究**：在线模式专属的半自动多轮搜索增强对话
- 完善会话管理、数据备份恢复、前端代码质量等基础能力

### 1.2 前后端拆分原则

| 维度 | 后端（内部团队） | 前端（外部团队） |
|------|-----------------|-----------------|
| 交付物 | API 端点 + 数据结构 | UI 交互 + API 对接 |
| 文档粒度 | 文件路径 + 接口签名 | 每个功能的 API 对接表 + UI 流程 |
| 协作方式 | 先完成后端 API | 依据 PRD 中的 API 表对接 |

### 1.3 约定

- API 前缀：`/api/`
- 数据格式：JSON（除非特别说明）
- 错误响应统一格式：`{"error": "错误描述"}`
- 成功响应统一格式：`{"ok": true, ...}` 或 `{"status": "ok", ...}`
- 流式响应：SSE（`text/event-stream`），`data:` 前缀

---

## 2. 现有系统概览

### 2.1 前端文件结构

```
server/
├── index.html              # 主 HTML（含 Tab 导航、全局状态变量、内联脚本）
├── static/
│   ├── css/main.css        # 全局样式（亮/暗主题 CSS 变量）
│   └── js/
│       ├── core/api.js     # API 工具函数
│       ├── core/utils.js   # 通用工具函数
│       ├── core/errors.js  # 错误处理
│       ├── chat.js         # 对话模块（1435行，需拆分）
│       ├── qa.js           # 文库问答模块
│       ├── settings.js     # 设置模块
│       ├── minutes.js      # 纪要模块
│       └── skills.js       # 技能模块
```

### 2.2 现有 API 端点（后端已实现）

| 端点 | Method | 说明 |
|------|--------|------|
| `/api/status` | GET | 模型状态 |
| `/api/health` | GET | 健康检查 |
| `/api/models` | GET | 可用模型列表 + 当前状态 |
| `/api/chat/stream` | POST | 流式对话（核心 SSE） |
| `/api/chat` | POST | 非流式对话 |
| `/api/chats` | GET | 会话列表 |
| `/api/chats/new` | POST | 新建会话 |
| `/api/chats/switch` | POST | 切换会话 |
| `/api/chats/{name}/messages` | GET | 获取消息历史 |
| `/api/chats/{name}` | DELETE | 删除会话 |
| `/api/config` | GET/POST | 配置读写 |
| `/api/info` | GET | 版本信息 |
| `/api/token-budget` | GET | Token 预算 |
| `/api/warmup` | POST | 模型预热 |
| `/api/stop` | POST | 停止生成 |

### 2.3 现有前端关键状态变量（index.html 内）

```javascript
let currentMessages = [];       // 当前对话消息列表
let currentChatFile = null;     // 当前会话文件名
let generating = false;         // 是否正在生成
let abortCtrl = null;           // AbortController（用于中断请求）
let currentActionMode = 'chat'; // 当前 Action: chat|kb|doc
let _refFilePath = null;        // 引用文件路径
let _maxPromptTokens = 0;       // 当前模型的 prompt token 上限
const API = '';                 // API 前缀（空字符串，走同源）
```

---

## 3. 任务总览与依赖关系

### 3.1 任务列表

| 编号 | 任务 | 优先级 | 前后端 | 估计工作量 | 依赖 |
|------|------|--------|--------|-----------|------|
| **A1** | num_ctx 修复 | 架构 | 后端 | 小 | 无 |
| **A2** | 云端 AI 模式 — 后端 | P0 | 后端 | 大 | 无 |
| **A3** | 云端 AI 模式 — 前端 | P0 | 前端 | 大 | A2 |
| **A4** | Research Action — 后端 | P0 | 后端 | 大 | A2 |
| **A5** | Research Action — 前端 | P0 | 前端 | 大 | A3, A4 |
| **A6** | 上下文圆环指示器 — 后端 | 架构 | 后端 | 中 | A2 |
| **A7** | 上下文圆环指示器 — 前端 | 架构 | 前端 | 中 | A3, A6 |
| **A8** | 离线上下文满了强制新建 — 后端 | 架构 | 后端 | 中 | A1 |
| **A9** | 离线上下文满了强制新建 — 前端 | 架构 | 前端 | 中 | A7, A8 |
| **A10** | 在线云端自动压缩 — 后端 | 架构 | 后端 | 中 | A2 |
| **A11** | 在线云端自动压缩 — 前端 | 架构 | 前端 | 中 | A7, A10 |
| **B1** | 会话管理增强 — 后端 | P0 | 后端 | 小 | 无 |
| **B2** | 会话管理增强 — 前端 | P0 | 前端 | 小 | B1 |
| **C1** | 数据备份/恢复 — 后端 | P0 | 后端 | 中 | 无 |
| **C2** | 数据备份/恢复 — 前端 | P0 | 前端 | 中 | C1 |
| **D1** | 前端代码拆分 | P0 | 前端 | 中 | 无（可最先开始） |
| **E1** | 日志清理机制 | P0 | 后端 | 小 | 无 |
| **J1** | 启动画面（Splash Screen） | P0 | 后端(Go) | 中 | 无 |
| **F1** | Ollama 崩溃自动重启 | P1 | 后端 | 小 | 无 |
| **G1** | 前端响应式优化 | P1 | 前端 | 小 | 无 |
| **H1** | 设置持久化优化 | P1 | 后端 | 小 | 无 |
| **I1** | Markdown 实时预览增强 | P1 | 前端 | 中 | 无 |

### 3.2 依赖图

```
无依赖（可立即开始）：
  A1(num_ctx修复) ──────────────────────────────────────────────────────┐
  A2(云端AI后端) ─────────┬──────────────────────┬─────────────────────│
  B1(会话重命名后端)       │                      │                     │
  C1(备份恢复后端)         │                      │                     │
  D1(前端代码拆分)         │                      │                     │
  E1(日志清理)             │                      │                     │
  J1(启动画面)             │                      │                     │
  F1(Ollama自动重启)       │                      │                     │
  G1(响应式优化)           │                      │                     │
  H1(设置持久化)           │                      │                     │
  I1(Markdown增强)         │                      │                     │
                          ▼                      ▼                     ▼
  依赖 A2：          A3(云端AI前端)       A4(Research后端)       A6(圆环后端)  A10(压缩后端)  A8(强制新建后端)
                          │                      │                     │              │
                          │◄─────────────────────┘                     │              │
                          ▼                      ▼                     ▼              ▼
  依赖 A3+A4：       A5(Research前端)                          A7(圆环前端)   A11(压缩前端)
  依赖 A7+A8：                                                        A9(强制新建前端)
  依赖 B1：          B2(会话重命名前端)
  依赖 C1：          C2(备份恢复前端)
```

### 3.3 并行策略

| 并行组 | 可同时进行的任务 |
|--------|----------------|
| **第一波** | A1, A2, B1, C1, D1, E1, J1, F1, G1, H1, I1（全部独立启动） |
| **第二波** | A3, A4, A6, A8, A10（等 A2 完成） |
| **第三波** | A5, A7, B2, C2（等各自前置完成） |
| **第四波** | A9, A11（等圆环前端完成） |

---

## 4. P0 后端任务

### 4.1 A1 — num_ctx 修复

**问题**：`stream_engine.py` 构建 Ollama payload 时只传了 `num_predict`，没传 `num_ctx`，Ollama 默认只有 2048-4096 tokens KV cache。

**修改文件**：`core/stream_engine.py`

**修改内容**：

```python
# stream_engine.py payload 构建（约第 80-100 行区域）
# 原来的 options 只有 num_predict，需新增 num_ctx

"options": {
    "num_predict": max_tokens,
    "num_ctx": 16000,  # 新增：显式设置 KV cache 大小
}
```

**配套调整**：`core/model_manager.py` 中 4B profile 的参数需同步：

| 参数 | 修复前 | 修复后 |
|------|--------|--------|
| `num_ctx` | 未传（默认 2K-4K） | 16000 |
| `max_history_chars` (4B) | 5000 | 12000 |
| `context_window` (4B) | 32000（假值） | 16000 |

---

### 4.2 A2 — 云端 AI 模式（后端）

#### 4.2.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `core/cloud_engine.py` | 云端引擎，封装 openai SDK 调用 |

#### 4.2.2 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `core/model_manager.py` | 新增模式路由（local/cloud），模式切换时动态更新上下文限制 |
| `routers/settings.py` | 新增云端配置 API 端点 |
| `core/deps_check.py` | 新增 openai 依赖检查 |

#### 4.2.3 新增 API 端点

##### `GET /api/mode`

获取当前 AI 模式。

**Response**：

```json
{
  "mode": "local",
  "available": ["local", "cloud"],
  "cloud_configured": false,
  "context_window": 16000,
  "max_history_chars": 12000
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `mode` | string | 当前模式：`"local"` 或 `"cloud"` |
| `available` | string[] | 可用模式列表 |
| `cloud_configured` | boolean | 云端是否已配置 |
| `context_window` | number | 当前上下文窗口（tokens） |
| `max_history_chars` | number | 最大历史字符数 |

---

##### `POST /api/mode/switch`

切换 AI 模式。

**Request**：

```json
{
  "mode": "cloud"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mode` | string | 是 | `"local"` 或 `"cloud"` |

**Response（成功）**：

```json
{
  "ok": true,
  "mode": "cloud",
  "context_window": 128000,
  "max_history_chars": 150000,
  "max_output_tokens": 16384
}
```

**Response（失败 — 未配置）**：

```json
{
  "ok": false,
  "error": "云端 AI 模型未配置，请先在设置中配置 API Key 和模型"
}
```

**Response（失败 — 测试连接失败）**：

```json
{
  "ok": false,
  "error": "云端 AI 连接失败: Connection refused"
}
```

---

##### `GET /api/cloud/config`

获取云端 AI 配置（API Key 脱敏）。

**Response**：

```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key_set": true,
  "api_key_preview": "sk-***...***abc",
  "model": "gpt-4o-mini",
  "context_window": 128000,
  "max_output_tokens": 16384,
  "context_policy": "full",
  "slim_history_rounds": 6
}
```

---

##### `POST /api/cloud/config`

保存云端 AI 配置。

**Request**：

```json
{
  "base_url": "https://api.openai.com/v1",
  "api_key": "sk-xxxxxxxxxxxx",
  "model": "gpt-4o-mini",
  "context_policy": "full",
  "slim_history_rounds": 6
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `base_url` | string | 否 | API 地址，默认 `https://api.openai.com/v1` |
| `api_key` | string | 否 | API Key（base64 编码存储） |
| `model` | string | 否 | 模型名称，默认 `gpt-4o-mini` |
| `context_policy` | string | 否 | 数据发送策略：`"full"`（默认，完整发送）/ `"current_only"`（仅当前消息）/ `"slim_history"`（精简历史） |
| `slim_history_rounds` | number | 否 | 精简历史模式下保留的最近轮数，默认 `6`，仅 `context_policy` 为 `slim_history` 时生效 |

**Response**：

```json
{
  "ok": true,
  "context_window": 128000,
  "max_output_tokens": 16384
}
```

---

##### `POST /api/cloud/test`

测试云端 AI 连接。

**Request**：无（使用已保存的配置）

**Response（成功）**：

```json
{
  "ok": true,
  "model": "gpt-4o-mini",
  "latency_ms": 523
}
```

**Response（失败）**：

```json
{
  "ok": false,
  "error": "Authentication failed: Invalid API Key"
}
```

---

#### 4.2.4 数据结构变更

**`settings.json` 新增字段**：

```json
{
  "ai_mode": "local",
  "cloud": {
    "base_url": "https://api.openai.com/v1",
    "api_key": "base64_encoded_key",
    "model": "gpt-4o-mini",
    "context_policy": "full",
    "slim_history_rounds": 6
  }
}
```

**`context_policy` 值说明**：

| 值 | 含义 | 发送给云端的内容 |
|----|------|-----------------|
| `"full"` | 完整发送（默认） | 当前消息 + 完整历史上下文 |
| `"current_only"` | 仅当前消息 | 只发用户当前输入，不带任何历史 |
| `"slim_history"` | 精简历史 | 当前消息 + 最近 N 轮对话（N 由 `slim_history_rounds` 控制，默认 6） |

#### 4.2.5 核心设计：双引擎抽象层

```
ModelManager（公共接口层）
    │
    ├── Engine Router ──── 根据 ai_mode 选择引擎
    │       │
    │       ├── OllamaEngine（现有 stream_engine.py 逻辑）
    │       │       └── httpx → Ollama 本地
    │       │
    │       └── CloudEngine（新增 cloud_engine.py）
    │               └── openai SDK → OpenAI API 兼容服务
    │
    ├── chat_stream()  ── 所有上层调用统一走此接口
    └── chat()         ── 非流式同理
```

**核心原则**：所有 20 个调用点仍然通过 `ModelManager.chat_stream()` / `ModelManager.chat()` 走统一接口，内部根据 `ai_mode` 路由到对应引擎。上层代码无需修改。

**在线模式行为**：
- 所有推理调用走云端（含纪要纠错、KB chunking、上下文压缩等后台任务）
- 模型管理类 API（卸载/删除/列表/内存查询/预热）仍走本地 Ollama

**CloudEngine 上下文裁剪逻辑**（`cloud_engine.py` 内部）：

CloudEngine 在拼装 `messages` 数组时，根据 `settings.json` 中的 `context_policy` 决定发送内容：

| context_policy | 裁剪行为 | 伪代码 |
|---|---|---|
| `"full"` | 不裁剪，完整发送 | `messages = full_history + [current_msg]` |
| `"current_only"` | 丢弃所有历史，只发当前消息 | `messages = [system_prompt, current_msg]` |
| `"slim_history"` | 保留系统 prompt + 最近 N 轮 + 当前消息 | `messages = [system_prompt] + history[-N*2:] + [current_msg]` |

**KB 文档内容不受裁剪影响**：用户主动引用的文库文档 chunks 始终随 prompt 发送，因为用户引用文档就是要 AI 基于其内容回答。

#### 4.2.6 新增依赖

| 包 | 版本 | 用途 |
|---|------|------|
| `openai` | >=1.30 | OpenAI 兼容 API 客户端 |

---

### 4.3 A4 — Research Action 联网研究（后端）

#### 4.3.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `actions/research_action.py` | Research Action 主逻辑（半自动循环 + 标记解析） |
| `core/search_engine.py` | 搜索引擎封装（Bing 搜索 + 网页正文抓取） |

#### 4.3.2 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `routers/chat.py` | 新增 `action_mode == "research"` 分支路由 |
| `routers/settings.py` | 新增搜索 API 配置读写端点 |
| `core/cloud_engine.py` | 新增 `MODEL_CAPABILITIES` 映射表 |

#### 4.3.3 新增 API 端点

##### `GET /api/search/config`

获取搜索配置。

**Response**：

```json
{
  "search_source": "bing",
  "api_key_set": true,
  "api_key_preview": "***...***abc"
}
```

---

##### `POST /api/search/config`

保存搜索配置。

**Request**：

```json
{
  "search_source": "bing",
  "api_key": "your-bing-api-key"
}
```

---

##### `POST /api/search/test`

测试搜索连接。

**Response（成功）**：

```json
{
  "ok": true,
  "results_count": 8,
  "latency_ms": 342
}
```

---

#### 4.3.4 SSE 事件流（核心 — chat/stream 复用）

当 `action_mode == "research"` 时，`/api/chat/stream` 返回的 SSE 事件新增以下类型：

| event | data 格式 | 说明 |
|-------|----------|------|
| `token` | `{"content": "..."}` | 正常流式文本输出 |
| `search` | `{"query": "关键词", "results_count": 8}` | 搜索状态提示 |
| `fetch` | `{"url": "https://...", "title": "网页标题"}` | 网页抓取状态提示 |
| `compress` | `{"phase": "...", "progress": 30, "msg": "..."}` | 上下文压缩进度 |
| `done` | `{"stats": {"search_count": 3, "fetch_count": 2}}` | 研究完成 |
| `error` | `{"error": "..."}` | 错误 |

**SSE 事件示例**：

```
event: search
data: {"query": "Python 异步编程", "results_count": 8}

event: token
data: {"content": "根据搜索结果，"}

event: token
data: {"content": "Python 异步编程..."}

event: fetch
data: {"url": "https://docs.python.org/3/library/asyncio.html", "title": "asyncio — Async IO"}

event: token
data: {"content": "\n\n进一步阅读官方文档后..."}

event: done
data: {"stats": {"search_count": 2, "fetch_count": 1}}
```

#### 4.3.5 半自动循环逻辑

```
1. 接收用户消息 + 历史上下文
2. 构建 research prompt（含搜索工具说明）
3. 调用 CloudEngine 流式生成
4. 解析模型输出中的特殊标记：
   <SEARCH:关键词> → 调用 search_engine.search() → 发 SSE search 事件
   <FETCH:URL>     → 调用 search_engine.fetch()  → 发 SSE fetch 事件
5. 将搜索/抓取结果追加到上下文，继续生成
6. 重复 3-5（最多 10 轮搜索 + 10 次抓取）
7. 模型不再输出搜索标记 → 输出最终回答
8. 发 SSE done 事件
```

#### 4.3.6 新增依赖

| 包 | 版本 | 用途 |
|---|------|------|
| `readability-lxml` | >=0.8 | 网页正文提取 |
| `lxml` | >=5.0 | HTML 解析器 |

---

### 4.4 B1 — 会话管理增强（后端）

#### 4.4.1 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `routers/chat.py` | 新增重命名端点 |
| `session/chat_store.py` | 新增重命名函数 |

#### 4.4.2 新增 API 端点

##### `POST /api/chats/{chat_name}/rename`

重命名会话。

**Request**：

```json
{
  "new_name": "新名称"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `new_name` | string | 是 | 新会话名称（1-50 字符） |

**Response（成功）**：

```json
{
  "ok": true,
  "old_name": "2026-06-05_143022",
  "new_name": "产品需求讨论",
  "new_file": "产品需求讨论.json"
}
```

**Response（失败）**：

```json
{
  "ok": false,
  "error": "会话名称已存在"
}
```

---

### 4.5 C1 — 数据备份/恢复（后端）

#### 4.5.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `routers/backup.py` | 备份/恢复 API |

#### 4.5.2 新增 API 端点

##### `POST /api/backup/export`

一键导出备份 ZIP。

**Request**：无（GET 参数可选）

**Response**：文件下载（`application/zip`）

ZIP 内容结构：
```
sidemate-backup-20260605.zip
├── chats/                    # 所有对话 JSON
│   ├── 产品需求讨论.json
│   └── 2026-06-05_143022.json
├── settings.json             # 用户设置
├── kb_meta/                  # 文库元数据（不含向量数据）
│   └── documents.json
└── backup_meta.json          # 备份元信息
    # {"version": "0.9.2", "created_at": "2026-06-05T14:30:00", "chat_count": 5}
```

---

##### `POST /api/backup/import`

一键恢复备份。

**Request**：`multipart/form-data`，字段 `file` 为 ZIP 文件

**Response**：

```json
{
  "ok": true,
  "restored": {
    "chats": 5,
    "settings": true,
    "kb_meta": true
  }
}
```

**Response（失败）**：

```json
{
  "ok": false,
  "error": "备份文件格式无效"
}
```

---

### 4.6 D1 — 前端代码拆分（纯前端任务，见第 5 节）

### 4.7 E1 — 日志清理机制

#### 4.7.1 新增文件

| 文件路径 | 说明 |
|----------|------|
| `core/log_cleanup.py` | 定时清理 30 天以上日志 |

#### 4.7.2 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `server.py` | 启动时注册定时清理（`threading.Timer` 或后台线程循环） |

#### 4.7.3 逻辑

```python
def cleanup_old_logs(log_dir: str, max_age_days: int = 30):
    """清理超过 max_age_days 天的日志文件"""
    # 遍历 log_dir 下的所有文件
    # 对每个文件：mtime < (now - max_age_days) → 删除
    # 记录清理日志
```

- 启动时执行一次
- 之后每 24 小时执行一次
- 只清理 `server/data/logs/` 目录下的文件

---

### 4.8 J1 — 启动画面（Splash Screen）

#### 4.8.1 背景

当前双击 `Sidemate.exe` 后存在一段静默期（Ollama 进程启动 + 模型加载 + FastAPI 就绪），用户无法感知启动进度，体验差。需要在 Go Launcher 中增加一个启动画面窗口，实时显示启动阶段和进度。

#### 4.8.2 技术方案

**方案 A（选定）：Go 原生 Win32 无边框窗口**

在 Go Launcher（`Sidemate.exe`）中使用 Windows API 创建一个无边框小窗口，显示：
- 品牌 Logo / 应用名称
- 当前启动阶段文字
- 进度条（或简单动画）
- 浏览器成功打开后自动关闭

优点：零外部依赖，与现有 `LockOSThread()` + Windows 消息循环天然兼容，启动极快。

#### 4.8.3 修改文件

| 文件路径 | 修改内容 |
|----------|----------|
| `main.go` | 新增 `splash` 相关函数，在启动流程中创建/更新/关闭闪屏窗口 |
| `splash/logo.png`（新） | 品牌 Logo 图片（可选，嵌入二进制） |

#### 4.8.4 启动阶段状态机

```
初始化 → [检查单实例] → [启动 Ollama] → [等待模型就绪] → [启动 FastAPI] → [打开浏览器] → 关闭闪屏
```

对应显示文字：

| 阶段 | 显示文字 | 触发条件 |
|------|---------|----------|
| `init` | 🚀 正在启动桌伴... | `Sidemate.exe` 启动后立即 |
| `ollama_starting` | ⚙️ 正在启动 AI 引擎... | 开始启动 Ollama 进程 |
| `model_loading` | 🧠 正在加载模型，首次可能较慢... | Ollama 进程已启动，等待 `/api/health` 返回 |
| `server_starting` | 🔧 正在启动后端服务... | FastAPI 进程开始 |
| `server_ready` | ✅ 即将就绪... | FastAPI `/api/health` 返回 200 |
| `done` | （关闭窗口） | 浏览器成功打开 |

#### 4.8.5 Go 实现要点

```go
// 使用 syscall/lazydll 直接调用 Win32 API（不依赖 CGO）
// 核心函数：
//   - createSplashWindow() → 注册窗口类 + CreateWindowEx
//   - updateSplashText(stage string) → InvalidateRect + WM_PAINT
//   - closeSplash() → DestroyWindow

// 窗口样式：
//   - WS_POPUP | WS_VISIBLE（无边框，置顶）
//   - 尺寸：480 x 280，居中
//   - 背景：纯色（匹配应用主题色）或渐变
//   - 无标题栏，无关闭按钮（不可手动关闭）

// 在现有 main() 流程中插入：
//   1. runtime.LockOSThread()（已有）
//   2. createSplashWindow()
//   3. 启动 goroutine 执行后台启动逻辑
//   4. 主 goroutine 跑 Win32 消息循环（TranslateMessage/DispatchMessage）
//   5. 后台逻辑完成 → 发 WM_CLOSE → 消息循环退出 → 继续原有流程
```

#### 4.8.6 窗口布局草图

```
┌─────────────────────────────────────────────┐
│                                             │
│              🤖 桌伴 · Sidemate             │
│                                             │
│         ━━━━━━━━━━━━━━━░░░░░░░░░           │
│              ▲ 进度条（估算）                │
│                                             │
│         ⚙️ 正在启动 AI 引擎...              │
│                                             │
│              v0.9.2 Patch2                  │
│                                             │
└─────────────────────────────────────────────┘
```

**进度估算逻辑**（粗略）：
- 各阶段预设权重：init(5%) → ollama_starting(20%) → model_loading(50%) → server_starting(15%) → server_ready(10%)
- 进度条只做视觉引导，非精确进度

#### 4.8.7 不需要新增 API 端点

启动画面完全在 Go Launcher 层面实现，不涉及 FastAPI 后端。闪屏关闭的触发条件是 Go Launcher 成功打开浏览器（即整个启动链路完成）。

---

## 5. P0 前端任务

### 5.1 D1 — 前端代码拆分

**目标**：将 `chat.js`（1435 行）拆成子模块，保持 `<script>` 引入方式不变。

#### 拆分方案

| 新文件 | 行数估算 | 包含内容 | 原文件函数 |
|--------|---------|----------|-----------|
| `static/js/chat.js` | ~400 | 核心发送/渲染/初始化 | `sendMessage()`, `stopGeneration()`, `renderMessages()`, `renderMsg()`, `_renderSingleMsg()`, `appendStreamingMsg()`, `onInputKey()` |
| `static/js/chat-session.js` | ~150 | 会话管理 | `loadChatList()`, `onSessionChange()`, `newChat()`, `deleteChat()`, `startSessionPoll()` |
| `static/js/chat-actions.js` | ~150 | Action 模式管理 | `refreshActionBar()`, `setActionMode()` |
| `static/js/chat-files.js` | ~200 | 文件/附件相关 | `toggleAttachMenu()`, `doAttachUpload()`, `doAttachKb()`, `showFileIndicator()`, `hideFileIndicator()`, `clearPendingFile()`, `pickKbFile()`, `onUnifiedPicked()` |
| `static/js/chat-export.js` | ~80 | 导出/文件操作 | `exportChat()`, `saveFileAs()`, `clearFileRef()` |
| `static/js/chat-ui.js` | ~120 | UI 辅助 | `copyMsgContent()`, `showDriftBar()`, `driftNewChat()`, `driftDismiss()`, `updateChatOverlay()`, `scrollToBottom()`, `checkScrollBtn()`, `_restoreChatUI()` |

#### HTML 引入顺序

```html
<!-- 修改 index.html 底部的 script 引入 -->
<script src="/static/js/chat-session.js"></script>
<script src="/static/js/chat-actions.js"></script>
<script src="/static/js/chat-files.js"></script>
<script src="/static/js/chat-export.js"></script>
<script src="/static/js/chat-ui.js"></script>
<script src="/static/js/chat.js"></script>  <!-- 主模块最后加载 -->
```

**注意事项**：
- 所有函数仍挂载在全局 `window` 上（非 ES Module）
- 变量 `currentMessages`, `generating`, `abortCtrl` 等全局变量保留在 `index.html` 的内联 `<script>` 中
- 拆分不改变任何功能行为

---

### 5.2 A3 — 云端 AI 模式（前端）

#### 5.2.1 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `index.html` | 顶部 header 新增模式切换 tag + 确认弹窗；设置页新增云端配置折叠区 |
| `static/css/main.css` | 模式 tag 样式（绿色本地/红色云端）、确认弹窗样式 |
| `static/js/chat.js` | 模式切换逻辑、`sendMessage()` 中根据模式传不同参数 |
| `static/js/settings.js` | 云端配置表单交互 |

#### 5.2.2 UI 交互流程

**顶部模式切换**：

```
点击 tag 文字 → 弹出下拉（本地AI模型 / 云端AI模型）→ 选择 → 确认弹窗
    → 确认 → 调用 /api/mode/switch → toast 提示 → 更新 UI
    → 取消 → 不切换
```

**首次切到云端未配置时**：

```
选择「云端 AI 模型」→ 调用 /api/mode/switch → 返回 error（未配置）
    → toast 提示「请先在设置中配置云端 AI 模型」
    → 可选：自动跳转到设置 Tab
```

#### 5.2.3 API 对接表

| 功能 | API 端点 | Method | Request Body | Response |
|------|----------|--------|-------------|----------|
| 获取当前模式 | `/api/mode` | GET | — | `{"mode": "local", "available": [...], "cloud_configured": false, "context_window": 16000}` |
| 切换模式 | `/api/mode/switch` | POST | `{"mode": "cloud"}` | `{"ok": true, "mode": "cloud", "context_window": 128000}` 或 `{"ok": false, "error": "..."}` |
| 获取云端配置 | `/api/cloud/config` | GET | — | `{"base_url": "...", "api_key_set": true, "api_key_preview": "...", "model": "...", "context_policy": "full", "slim_history_rounds": 6}` |
| 保存云端配置 | `/api/cloud/config` | POST | `{"base_url": "...", "api_key": "...", "model": "...", "context_policy": "full", "slim_history_rounds": 6}` | `{"ok": true}` |
| 测试云端连接 | `/api/cloud/test` | POST | — | `{"ok": true, "latency_ms": 523}` 或 `{"ok": false, "error": "..."}` |

#### 5.2.4 UI 元素详细设计

**顶部 Header 区域（修改 index.html 第 32-39 行）**：

```html
<!-- 现有 -->
<div class="header">
    <img ...>
    <h1>桌伴 · Sidemate</h1>
    <span class="tag" id="sourceTag" style="display:none"></span>
    <span class="tag" id="privacyTag" style="display:none">数据不上网 模型跑本地</span>
</div>

<!-- 修改为 -->
<div class="header">
    <img ...>
    <h1>桌伴 · Sidemate</h1>
    <span class="tag tag-local" id="modeTag" onclick="toggleModeDropdown()">
        🟢 正在使用本地AI模型 ▾
    </span>
    <span class="tag tag-sub" id="modeSubTag">数据不上网 模型跑本地</span>
    <!-- 下拉菜单 -->
    <div id="modeDropdown" class="mode-dropdown" style="display:none">
        <div class="mode-option" data-mode="local" onclick="selectMode('local')">
            🟢 本地 AI 模型
            <span class="mode-option-desc">数据不上网 模型跑本地</span>
        </div>
        <div class="mode-option" data-mode="cloud" onclick="selectMode('cloud')">
            🔴 云端 AI 模型
            <span class="mode-option-desc">核心数据本地存储</span>
        </div>
    </div>
</div>
```

**确认弹窗**：

```html
<div id="modeConfirmModal" class="modal-overlay" style="display:none">
    <div class="modal-card">
        <p id="modeConfirmTitle" style="font-weight:600;margin-bottom:8px"></p>
        <p id="modeConfirmWarning" style="font-size:.88em;color:var(--text-muted);margin-bottom:12px"></p>
        <p id="modeConfirmMeta" style="font-size:.82em;color:var(--text-muted);margin-bottom:12px"></p>
        <div class="modal-actions">
            <button onclick="cancelModeSwitch()">取消</button>
            <button class="settings-btn-primary" onclick="confirmModeSwitch()">确认切换</button>
        </div>
    </div>
</div>
```

**切换到云端时的弹窗内容**：

```
标题：⚠️ 切换到云端 AI 模式

警告文案：
云端模式下对话内容将通过互联网发送至第三方 AI 服务。
引用的文库文档内容将随对话一起发送。
你可以在「设置 → 云端 AI 模型配置」中调整数据发送策略。

元信息行：
模型：{cloud_model}
数据发送：{context_policy 中文描述}
```

**切换回本地时的弹窗内容**：

```
标题：切换到本地 AI 模型

警告文案：
本地模式下所有数据均在本地处理，不会发送到互联网。
模型：{local_model_name}
```

**设置页新增折叠区（在「扩展管理」卡片之后）**：

```html
<details id="cloudConfigSection" style="margin-bottom:12px">
    <summary class="settings-summary">☁️ 云端 AI 模型配置</summary>
    <div class="settings-detail-content">
        <div class="settings-row">
            <label>API 地址</label>
            <input type="text" id="cloudBaseUrl" value="https://api.openai.com/v1"
                   style="flex:1;padding:6px 8px;border:0.5px solid var(--border-color);border-radius:4px">
        </div>
        <div class="settings-row">
            <label>API Key</label>
            <input type="password" id="cloudApiKey" placeholder="输入 API Key"
                   style="flex:1;padding:6px 8px;border:0.5px solid var(--border-color);border-radius:4px">
            <button class="settings-btn" onclick="toggleApiKeyVisibility()">显示</button>
        </div>
        <div class="settings-row">
            <label>模型名称</label>
            <input type="text" id="cloudModel" value="gpt-4o-mini"
                   style="flex:1;padding:6px 8px;border:0.5px solid var(--border-color);border-radius:4px">
        </div>
        <div class="settings-row">
            <label>上下文窗口</label>
            <span id="cloudContextInfo" style="color:var(--text-muted);font-size:.82em">—</span>
        </div>
        <!-- 数据发送策略 -->
        <div style="border-top:0.5px solid var(--border-color);margin:10px 0;padding-top:10px">
            <div style="font-size:.88em;font-weight:500;margin-bottom:8px">数据发送策略</div>
            <label style="display:block;margin-bottom:4px;font-size:.85em">
                <input type="radio" name="contextPolicy" value="full" checked>
                完整发送（默认）— 发送完整历史上下文，对话质量最佳
            </label>
            <label style="display:block;margin-bottom:4px;font-size:.85em">
                <input type="radio" name="contextPolicy" value="current_only">
                仅发送当前消息 — 最高隐私保护，但对话无记忆
            </label>
            <label style="display:block;margin-bottom:4px;font-size:.85em">
                <input type="radio" name="contextPolicy" value="slim_history">
                精简历史 — 仅保留最近
                <input type="number" id="slimHistoryRounds" value="6" min="1" max="50"
                       style="width:40px;padding:2px 4px;border:0.5px solid var(--border-color);border-radius:3px;text-align:center">
                轮对话
            </label>
            <div style="font-size:.78em;color:var(--text-muted);margin-top:4px">
                ⚠️ 引用的文库文档内容始终会随对话发送
            </div>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
            <button class="settings-btn" onclick="testCloudConnection()">测试连接</button>
            <button class="settings-btn settings-btn-primary" onclick="saveCloudConfig()">保存配置</button>
        </div>
        <div id="cloudTestResult" style="margin-top:6px;font-size:.82em"></div>
    </div>
</details>
```

#### 5.2.5 前端关键函数

```javascript
// 点击 tag 展开下拉
function toggleModeDropdown() { ... }

// 选择模式 → 弹确认窗（含隐私提示）
function selectMode(mode) {
    // mode === 'cloud' 时，弹窗显示隐私警告 + 当前 context_policy 描述
    // mode === 'local' 时，弹窗显示普通切换确认
}

// 确认切换 → 调 API
async function confirmModeSwitch() { ... }

// 取消切换
function cancelModeSwitch() { ... }

// 初始化模式 tag（页面加载时调用）
async function initModeTag() {
    const resp = await fetch('/api/mode');
    const data = await resp.json();
    updateModeTagUI(data.mode, data.cloud_configured);
}

// 更新 tag UI
function updateModeTagUI(mode, cloudConfigured) {
    const tag = document.getElementById('modeTag');
    const sub = document.getElementById('modeSubTag');
    if (mode === 'local') {
        tag.className = 'tag tag-local';
        tag.textContent = '🟢 正在使用本地AI模型 ▾';
        sub.textContent = '数据不上网 模型跑本地';
    } else {
        tag.className = 'tag tag-cloud';
        tag.textContent = '🔴 正在使用云端AI模型 ▾';
        sub.textContent = '核心数据本地存储';
    }
}

// 设置页：测试连接
async function testCloudConnection() { ... }

// 设置页：保存配置（含 context_policy）
async function saveCloudConfig() {
    const policy = document.querySelector('input[name="contextPolicy"]:checked').value;
    const rounds = document.getElementById('slimHistoryRounds').value;
    await fetch('/api/cloud/config', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
            base_url: document.getElementById('cloudBaseUrl').value,
            api_key: document.getElementById('cloudApiKey').value || undefined,
            model: document.getElementById('cloudModel').value,
            context_policy: policy,
            slim_history_rounds: parseInt(rounds) || 6
        })
    });
}

// 设置页：切换 API Key 可见性
function toggleApiKeyVisibility() { ... }
```

---

### 5.3 A5 — Research Action 联网研究（前端）

#### 5.3.1 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `static/js/chat-actions.js`（拆分后） | `refreshActionBar()` 中新增 `research` 选项（仅云端模式显示） |
| `static/js/chat.js` | `sendMessage()` 中处理 research SSE 事件；`appendStreamingMsg()` 新增搜索/抓取状态展示 |
| `index.html` | 设置页新增搜索配置折叠区 |
| `static/css/main.css` | 搜索状态卡片样式 |

#### 5.3.2 UI 交互流程

```
1. 切到云端模式 → refreshActionBar() 显示三个选项：💬 对话 | 📄 文档 | 🔍 研究
2. 用户点击「研究」→ setActionMode('research')
3. 用户提问 → sendMessage() 发送 action_mode: 'research'
4. 接收 SSE 事件：
   - event:search → 显示「🔍 搜索了「xxx」— N 条结果」小卡片
   - event:fetch  → 显示「📄 正在阅读: 标题」小卡片
   - event:token  → 正常追加文本
   - event:done   → 完成，显示统计信息
```

#### 5.3.3 API 对接表

| 功能 | API 端点 | Method | Request Body | Response |
|------|----------|--------|-------------|----------|
| 联网研究对话 | `/api/chat/stream` | POST (SSE) | `{"message": "...", "action_mode": "research", "history": [...]}` | SSE 事件流（见下表） |
| 获取搜索配置 | `/api/search/config` | GET | — | `{"search_source": "bing", "api_key_set": true}` |
| 保存搜索配置 | `/api/search/config` | POST | `{"search_source": "bing", "api_key": "..."}` | `{"ok": true}` |
| 测试搜索 | `/api/search/test` | POST | — | `{"ok": true, "results_count": 8}` |
| 获取当前模式 | `/api/mode` | GET | — | `{"mode": "cloud", ...}` |

**SSE 事件类型**：

| event | data JSON | 前端处理 |
|-------|----------|----------|
| `search` | `{"query": "xxx", "results_count": 8}` | 在消息区上方插入搜索状态卡片 |
| `fetch` | `{"url": "https://...", "title": "标题"}` | 在搜索卡片下方追加抓取状态 |
| `token` | `{"content": "..."}` | 追加到当前消息气泡 |
| `done` | `{"stats": {"search_count": 3, "fetch_count": 2}}` | 显示完成统计 |
| `error` | `{"error": "..."}` | 显示错误 toast |

#### 5.3.4 UI 元素详细设计

**Action 栏（已有 `#actionBar`，由 `refreshActionBar()` 动态渲染）**：

在线模式下新增 research 按钮：
```javascript
// refreshActionBar() 中
if (currentMode === 'cloud') {
    // 新增：🔍 研究 按钮
    actionBarHTML += `<button class="action-btn ${currentActionMode === 'research' ? 'active' : ''}" 
                       onclick="setActionMode('research', this)">🔍 研究</button>`;
}
```

**搜索/抓取状态卡片（插入在消息气泡内或上方）**：

```html
<!-- 搜索状态卡片 -->
<div class="research-card">
    <div class="research-card-search">
        🔍 搜索了「<b>Python 异步编程</b>」— 8 条结果
    </div>
    <div class="research-card-fetch">
        📄 阅读了 <b>3</b> 个网页
    </div>
</div>
```

**设置页新增搜索配置折叠区**（在云端 AI 配置之后）：

```html
<details id="searchConfigSection" style="margin-bottom:12px">
    <summary class="settings-summary">🔍 联网搜索配置</summary>
    <div class="settings-detail-content">
        <div class="settings-row">
            <label>Bing API Key</label>
            <input type="password" id="searchApiKey" placeholder="输入 Bing Search API Key"
                   style="flex:1;padding:6px 8px;border:0.5px solid var(--border-color);border-radius:4px">
            <button class="settings-btn" onclick="toggleSearchKeyVisibility()">显示</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
            <button class="settings-btn" onclick="testSearchConnection()">测试搜索</button>
            <button class="settings-btn settings-btn-primary" onclick="saveSearchConfig()">保存配置</button>
        </div>
        <div id="searchTestResult" style="margin-top:6px;font-size:.82em"></div>
    </div>
</details>
```

#### 5.3.5 前端关键函数

```javascript
// 修改 refreshActionBar() — 在线模式时显示 research 按钮
async function refreshActionBar() {
    const modeResp = await fetch('/api/mode');
    const modeData = await modeResp.json();
    const isCloud = modeData.mode === 'cloud';

    // 原有 chat/doc 按钮
    let html = '';
    html += `<button class="action-btn ${currentActionMode === 'chat' ? 'active' : ''}" ...>💬 对话</button>`;
    html += `<button class="action-btn ${currentActionMode === 'doc' ? 'active' : ''}" ...>📄 文档</button>`;

    // 在线模式专属：research 按钮
    if (isCloud) {
        html += `<button class="action-btn ${currentActionMode === 'research' ? 'active' : ''}"
                         onclick="setActionMode('research', this)">🔍 研究</button>`;
    }

    document.getElementById('actionBar').innerHTML = html;
}

// sendMessage() 中处理 research SSE 事件（新增分支）
// 在已有的 SSE 事件解析逻辑中新增：
if (eventName === 'search') {
    appendSearchCard(data.query, data.results_count);
}
if (eventName === 'fetch') {
    appendFetchCard(data.url, data.title);
}
if (eventName === 'done' && currentActionMode === 'research') {
    appendResearchStats(data.stats);
}

// 渲染搜索状态卡片
function appendSearchCard(query, count) { ... }

// 渲染抓取状态
function appendFetchCard(url, title) { ... }

// 渲染完成统计
function appendResearchStats(stats) { ... }
```

---

### 5.4 B2 — 会话管理增强（前端）

#### 5.4.1 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `static/js/chat-session.js`（拆分后） | 新增重命名交互 |

#### 5.4.2 UI 交互流程

```
方式一：双击会话下拉框 → 弹出内联编辑输入框 → 回车确认 → 调 API
方式二：下拉框旁新增「✏️」重命名按钮 → 弹出弹窗输入新名称 → 确认 → 调 API
```

推荐方式一（双击内联编辑），更简洁。

#### 5.4.3 API 对接表

| 功能 | API 端点 | Method | Request Body | Response |
|------|----------|--------|-------------|----------|
| 重命名会话 | `/api/chats/{chat_name}/rename` | POST | `{"new_name": "新名称"}` | `{"ok": true, "new_name": "...", "new_file": "..."}` |
| 会话列表（已有） | `/api/chats` | GET | — | `{"chats": [...], "current": "..."}` |

#### 5.4.4 UI 元素详细设计

在会话下拉框 `#sessionSelect` 旁新增重命名按钮：

```html
<!-- 修改 index.html 第 93-97 行区域 -->
<div class="session-wrap">
    <select id="sessionSelect" onchange="onSessionChange()"></select>
    <button id="renameChatBtn" onclick="renameChat()" title="重命名当前对话">✏️</button>
    <button id="newChatBtn" onclick="newChat()" title="新建对话">＋新建</button>
    <button id="delChatBtn" onclick="deleteChat()" title="删除当前对话" style="color:var(--error-color)">🗑</button>
    <button onclick="exportChat()" title="导出对话" class="session-export-btn">导出</button>
</div>
```

#### 5.4.5 前端关键函数

```javascript
async function renameChat() {
    const select = document.getElementById('sessionSelect');
    const currentName = select.value;
    if (!currentName) return;

    // 弹出输入框
    const newName = prompt('请输入新名称：', currentName);
    if (!newName || newName === currentName) return;

    const resp = await fetch(`/api/chats/${encodeURIComponent(currentName)}/rename`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({new_name: newName})
    });
    const data = await resp.json();

    if (data.ok) {
        showToast('会话已重命名');
        await loadChatList();  // 刷新列表
        // 选中新名称
        select.value = data.new_file || newName;
    } else {
        showToast(data.error || '重命名失败', 'error');
    }
}
```

---

### 5.5 C2 — 数据备份/恢复（前端）

#### 5.5.1 需要修改的文件

| 文件 | 修改内容 |
|------|----------|
| `index.html` | 设置页新增「备份与恢复」区块 |
| `static/js/settings.js` | 备份导出/恢复交互逻辑 |

#### 5.5.2 UI 交互流程

```
导出：点击「一键导出备份」→ 调 /api/backup/export → 浏览器下载 ZIP
恢复：选择 ZIP 文件 → 点击「一键恢复」→ 调 /api/backup/import → toast 提示 → 刷新页面
```

#### 5.5.3 API 对接表

| 功能 | API 端点 | Method | Request | Response |
|------|----------|--------|---------|----------|
| 导出备份 | `/api/backup/export` | POST | — | `application/zip` 文件流 |
| 导入恢复 | `/api/backup/import` | POST | `multipart/form-data` (file=ZIP) | `{"ok": true, "restored": {"chats": 5, "settings": true}}` |

#### 5.5.4 UI 元素详细设计

在设置页「缓存管理」卡片之后新增：

```html
<div class="settings-card">
    <div class="settings-card-title">备份与恢复</div>
    <div style="font-size:13px;color:var(--text-secondary);margin-bottom:10px">
        导出所有对话、设置和文库元数据到 ZIP 文件，或从备份恢复。
    </div>
    <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <button class="settings-btn settings-btn-primary" onclick="exportBackup()">
            📦 一键导出备份
        </button>
        <div style="display:flex;gap:8px;align-items:center">
            <input type="file" id="backupFileInput" accept=".zip"
                   style="padding:6px 8px;border:0.5px solid var(--border-color);border-radius:8px;font-size:13px">
            <button class="settings-btn" onclick="importBackup()">📥 一键恢复</button>
        </div>
    </div>
    <div id="backupResult" style="margin-top:6px;font-size:.82em"></div>
</div>
```

#### 5.5.5 前端关键函数

```javascript
async function exportBackup() {
    const resp = await fetch('/api/backup/export', {method: 'POST'});
    if (!resp.ok) {
        const data = await resp.json();
        showToast(data.error || '导出失败', 'error');
        return;
    }
    // 触发浏览器下载
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'sidemate-backup.zip';
    a.click();
    URL.revokeObjectURL(url);
    showToast('备份已导出');
}

async function importBackup() {
    const input = document.getElementById('backupFileInput');
    if (!input.files.length) {
        showToast('请选择备份文件', 'error');
        return;
    }
    const formData = new FormData();
    formData.append('file', input.files[0]);

    const resp = await fetch('/api/backup/import', {
        method: 'POST',
        body: formData
    });
    const data = await resp.json();
    if (data.ok) {
        showToast(`恢复成功：${data.restored.chats} 个对话已恢复`);
        setTimeout(() => location.reload(), 1500);
    } else {
        showToast(data.error || '恢复失败', 'error');
    }
}
```

---

## 6. P1 后端任务

### 6.1 F1 — Ollama 崩溃自动重启

**修改文件**：`core/ollama_manager.py`

**逻辑**：
- Watchdog 线程检测到 Ollama 进程退出时，不再只打日志
- 自动重启 Ollama 进程
- 通过 SSE 或心跳接口通知前端显示 toast：「Ollama 已自动重启」

**不需要新增 API 端点**，利用现有的 `/api/health` 心跳机制即可。

---

### 6.2 H1 — 设置持久化优化

**修改文件**：`routers/settings.py`, `config.py`

**逻辑**：
- 启动时加载 `settings.json` 到内存
- 变更时写入（现有的 `_save_settings` 已做到）
- 读取时直接返回内存缓存（需改 `_load_settings` 为内存缓存模式）

**不需要新增 API 端点**，纯内部优化。

---

## 7. P1 前端任务

### 7.1 G1 — 前端响应式优化

**修改文件**：`static/css/main.css`

**逻辑**：
- 窗口宽度 < 768px 时，侧边面板（文库左栏）自动折叠
- Tab 导航按钮缩小
- 输入区域适配窄屏

```css
@media (max-width: 768px) {
    .kb-left-panel[data-collapsed="false"] { /* 默认折叠 */ }
    .tabs-nav button { font-size: 0.85em; padding: 6px 10px; }
    .input-area textarea { min-height: 60px; }
}
```

**无 API 对接**。

---

### 7.2 I1 — Markdown 实时预览增强

**修改文件**：`static/js/chat.js`（或拆分后的 `chat-ui.js`）

**逻辑**：
- 增强 `md()` 函数，支持更好的表格渲染、代码块样式
- 消息气泡支持「渲染/原文」切换按钮

**无新增 API 对接**。

---

## 8. 架构级任务

### 8.1 A6/A7 — 上下文圆环指示器

#### 后端（A6）

**新增 API 端点**：

##### `GET /api/context/usage`

获取当前会话的上下文使用量。

**Response**：

```json
{
  "used_tokens": 5600,
  "total_tokens": 16000,
  "percentage": 35,
  "level": "normal"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `used_tokens` | number | 已使用 tokens 数 |
| `total_tokens` | number | 总上下文窗口（离线 16000，在线按模型映射表） |
| `percentage` | number | 使用百分比（0-100） |
| `level` | string | `"normal"` / `"warning"` / `"critical"` |

| level | 条件 | 含义 |
|-------|------|------|
| `normal` | < 60% | 正常，绿色 |
| `warning` | 60-85% | 警告，黄色 |
| `critical` | > 85% | 危险，红色 |

**修改文件**：`routers/chat.py` 或 `routers/settings.py`

#### 前端（A7）

**需要修改的文件**：

| 文件 | 修改内容 |
|------|----------|
| `index.html` | Header 右侧新增圆环 SVG |
| `static/css/main.css` | 圆环样式 + 三档颜色 + 脉冲动画 |
| `static/js/chat.js` | 发送/接收消息后更新圆环 |

**API 对接表**：

| 功能 | API 端点 | Method | Request | Response |
|------|----------|--------|---------|----------|
| 上下文使用量 | `/api/context/usage` | GET | — | `{"used_tokens": 5600, "total_tokens": 16000, "percentage": 35, "level": "normal"}` |

**UI 元素**：

```html
<!-- Header 右侧 -->
<div class="context-ring-wrap" id="contextRing" title="上下文使用量">
    <svg viewBox="0 0 40 40" width="40" height="40">
        <circle cx="20" cy="20" r="16" fill="none" stroke="var(--bg-tertiary)" stroke-width="3"/>
        <circle id="contextRingArc" cx="20" cy="20" r="16" fill="none"
                stroke="var(--accent-color)" stroke-width="3"
                stroke-dasharray="100.5" stroke-dashoffset="65"
                transform="rotate(-90 20 20)" stroke-linecap="round"/>
    </svg>
    <span class="context-ring-pct" id="contextPct">35%</span>
    <span class="context-ring-detail" id="contextDetail">11.2K/16K</span>
</div>
```

**三档样式**：

```css
.context-ring-wrap.level-normal circle#contextRingArc { stroke: var(--accent-color); }
.context-ring-wrap.level-warning circle#contextRingArc { stroke: #f0ad4e; }
.context-ring-wrap.level-critical circle#contextRingArc {
    stroke: #dc3545;
    animation: pulse-ring 1.5s ease-in-out infinite;
}
```

---

### 8.2 A8/A9 — 离线上下文满了强制新建

#### 后端（A8）

**修改文件**：`routers/chat.py` 的 `/api/chat/stream` 端点

**逻辑**：在流式对话前检测上下文使用量，超过阈值时在 SSE 中发送特定事件：

**新增 SSE 事件**：

| event | 条件 | data | 说明 |
|-------|------|------|------|
| `context_warning` | 上下文 > 85% | `{"percentage": 87, "level": "critical"}` | 前端弹窗提示 |
| `context_force_new` | 上下文 > 95% | `{"percentage": 96, "new_chat_file": "xxx.json", "summary": "..."}` | 后端自动新建会话 |

**无新增独立 API 端点**，集成在 `/api/chat/stream` 的 SSE 事件流中。

#### 前端（A9）

**SSE 事件处理**：

```javascript
// sendMessage() 的 SSE 处理中新增
if (eventName === 'context_warning') {
    showContextWarningModal(data.percentage);
}
if (eventName === 'context_force_new') {
    // 自动切换到新会话
    currentChatFile = data.new_chat_file;
    currentMessages = [];
    showToast('对话空间不足，已自动新建会话');
    await loadChatList();
}
```

**弹窗 UI**：

```html
<div id="contextWarningModal" class="modal-overlay" style="display:none">
    <div class="modal-card">
        <p>⚠️ 对话接近上限（使用 87%），继续聊天响应会变慢。</p>
        <div class="modal-actions">
            <button onclick="forceNewChat()">新建会话</button>
            <button onclick="dismissContextWarning()">继续（可能较慢）</button>
        </div>
    </div>
</div>
```

**API 对接**：无独立端点，通过 `/api/chat/stream` SSE 事件通信。

---

### 8.3 A10/A11 — 在线云端自动压缩

#### 后端（A10）

**修改文件**：`routers/chat.py` 的 `/api/chat/stream` 端点

**逻辑**：在线模式发送消息时，检测历史 > 75% → 先用云端模型压缩 → SSE 推送压缩进度 → 再正常推理。

**新增 SSE 事件**：

| event | data | 说明 |
|-------|------|------|
| `compress` | `{"phase": "preparing", "msg": "正在准备对话历史..."}` | 压缩开始 |
| `compress` | `{"phase": "compressing", "progress": 30, "msg": "正在压缩对话历史..."}` | 压缩进行中 |
| `compress` | `{"phase": "done", "before": "156K", "after": "44K", "msg": "压缩完成 (156K→44K)"}` | 压缩完成 |

**无新增独立 API 端点**，集成在 `/api/chat/stream` 的 SSE 事件流中。

#### 前端（A11）

**SSE 事件处理**：

```javascript
if (eventName === 'compress') {
    updateCompressProgress(data);
}
```

**UI 交互**：
- 压缩进行中：圆环区域替换为进度条 + 百分比 + 状态文字
- 压缩完成：圆环恢复，数值跳变（如 78% → 22%），3 秒后恢复常态

**API 对接**：无独立端点，通过 `/api/chat/stream` SSE 事件通信。

---

## 9. 新增依赖汇总

### Python 后端

| 包 | 版本 | 用途 | 用于任务 |
|---|------|------|---------|
| `openai` | >=1.30 | OpenAI 兼容 API 客户端 | A2 云端 AI 模式 |
| `readability-lxml` | >=0.8 | 网页正文提取 | A4 Research Action |
| `lxml` | >=5.0 | HTML 解析器 | A4 Research Action |

### 前端

无新增外部 JS 依赖。所有功能使用原生 JS 实现。

---

## 附录 A：前端 API 对接快速参考

> 以下为前端团队需要对接的所有 API 端点汇总。

### A1. 现有端点（Patch1 已有，前端需了解）

| 端点 | Method | 说明 | 前端使用场景 |
|------|--------|------|-------------|
| `GET /api/status` | GET | 模型状态 | 页面初始化 |
| `GET /api/models` | GET | 模型列表 | 设置页、对话页模型信息 |
| `POST /api/chat/stream` | POST (SSE) | 流式对话 | 发送消息 |
| `GET /api/chats` | GET | 会话列表 | 页面初始化、会话管理 |
| `POST /api/chats/new` | POST | 新建会话 | 新建对话 |
| `POST /api/chats/switch` | POST | 切换会话 | 下拉切换 |
| `DELETE /api/chats/{name}` | DELETE | 删除会话 | 删除对话 |
| `GET /api/chats/{name}/messages` | GET | 消息历史 | 加载对话 |
| `GET /api/config` | GET | 获取配置 | 设置页 |
| `POST /api/config` | POST | 保存配置 | 设置页 |
| `POST /api/stop` | POST | 停止生成 | 停止按钮 |
| `GET /api/health` | GET | 健康检查 | 心跳检测 |

### A2. Patch2 新增端点

| 端点 | Method | 说明 | 前端使用场景 |
|------|--------|------|-------------|
| `GET /api/mode` | GET | 获取当前 AI 模式 | 页面初始化、更新模式 tag |
| `POST /api/mode/switch` | POST | 切换 AI 模式 | 模式切换确认后 |
| `GET /api/cloud/config` | GET | 获取云端配置 | 设置页加载 |
| `POST /api/cloud/config` | POST | 保存云端配置 | 设置页保存 |
| `POST /api/cloud/test` | POST | 测试云端连接 | 设置页测试 |
| `GET /api/search/config` | GET | 获取搜索配置 | 设置页加载 |
| `POST /api/search/config` | POST | 保存搜索配置 | 设置页保存 |
| `POST /api/search/test` | POST | 测试搜索 | 设置页测试 |
| `POST /api/chats/{name}/rename` | POST | 重命名会话 | 重命名按钮 |
| `POST /api/backup/export` | POST | 导出备份 | 设置页导出 |
| `POST /api/backup/import` | POST | 导入恢复 | 设置页恢复 |
| `GET /api/context/usage` | GET | 上下文使用量 | 圆环指示器更新 |

### A3. SSE 事件类型汇总

#### `/api/chat/stream` SSE 事件（Patch2 新增）

| event | data 示例 | 触发条件 |
|-------|----------|----------|
| `search` | `{"query": "Python", "results_count": 8}` | Research Action 搜索 |
| `fetch` | `{"url": "https://...", "title": "标题"}` | Research Action 抓取 |
| `compress` | `{"phase": "compressing", "progress": 30, "msg": "..."}` | 在线模式自动压缩 |
| `context_warning` | `{"percentage": 87, "level": "critical"}` | 离线模式上下文 > 85% |
| `context_force_new` | `{"percentage": 96, "new_chat_file": "..."}` | 离线模式上下文 > 95% |

---

## 附录 B：前端文件修改清单

| 文件 | 涉及任务 | 修改类型 |
|------|---------|----------|
| `index.html` | A3, A5, A7, B2, C2 | 新增 UI 元素、script 引入 |
| `static/css/main.css` | A3, A5, A7, G1 | 新增样式 |
| `static/js/chat.js` | D1, A3, A5, A7, A9, A11 | 拆分 + 新增逻辑 |
| `static/js/chat-session.js`（新） | D1, B2 | 从 chat.js 拆出 |
| `static/js/chat-actions.js`（新） | D1, A5 | 从 chat.js 拆出 + research |
| `static/js/chat-files.js`（新） | D1 | 从 chat.js 拆出 |
| `static/js/chat-export.js`（新） | D1 | 从 chat.js 拆出 |
| `static/js/chat-ui.js`（新） | D1, I1 | 从 chat.js 拆出 |
| `static/js/settings.js` | A3, A5, C2 | 云端配置、搜索配置、备份恢复 |

---

## 附录 C：后端文件修改清单

| 文件 | 涉及任务 | 修改类型 |
|------|---------|----------|
| `core/cloud_engine.py`（新） | A2, A4 | 新增 |
| `actions/research_action.py`（新） | A4 | 新增 |
| `core/search_engine.py`（新） | A4 | 新增 |
| `routers/backup.py`（新） | C1 | 新增 |
| `core/log_cleanup.py`（新） | E1 | 新增 |
| `core/stream_engine.py` | A1 | 修改（加 num_ctx） |
| `core/model_manager.py` | A2, A6 | 修改（模式路由 + 上下文参数） |
| `routers/chat.py` | A4, A8, A10 | 修改（research + 上下文管理） |
| `routers/settings.py` | A2, A4 | 修改（云端 + 搜索配置 API） |
| `session/chat_store.py` | B1 | 修改（重命名函数） |
| `core/ollama_manager.py` | F1 | 修改（自动重启） |
| `config.py` | H1 | 修改（内存缓存） |
| `server.py` | E1 | 修改（启动清理） |
| `core/deps_check.py` | A2 | 修改（openai 依赖检查） |
| `main.go`（项目根目录） | J1 | 修改（新增 Win32 闪屏窗口逻辑） |
