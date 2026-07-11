# Patch12 API 接口契约

> 基于 routers/ 目录下所有路由文件的端点扫描生成

## 端点总览

| Router 文件 | 端点前缀 | 端点数量 |
|------------|---------|---------|
| `chat.py` | `/api` | 11 |
| `kb.py` | `/api/kb` | 16 |
| `recorder.py` | `/api/recorder` | 18 |
| `settings.py` | `/api` | 22 |
| `skill.py` | `/api/action` | 2 |
| `files.py` | `/api/cache` | 3 |
| **总计** | | **72** |

---

## 1. 聊天/会话 API（routers/chat.py）

### POST /api/chat
非流式对话。

**请求体**（ChatRequest）:
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message | string | 否 | 用户消息 |
| model | string | 否 | 模型名称（默认用 DEFAULT_LLM） |
| max_tokens | int | 否 | 最大生成 token 数 |
| history | list | 否 | 历史消息列表 |
| chat_file | string | 否 | 对话文件路径 |
| mode | string | 否 | 模式 |
| action_mode | string | 否 | "chat"|"kb"|"doc"|扩展ID |
| file_path | string | 否 | 附件文件路径 |

**返回**: `{"response": "...", ...}`

### POST /api/chat/stream ⭐ SSE
流式对话（核心端点）。SSE 格式返回。

**请求体**（ChatRequest，通过 `request.json()` 解析）:
| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| message | string | 是 | 用户消息 |
| model | string | 否 | 模型名称 |
| max_tokens | int | 否 | 最大 token 数 |
| history | list | 否 | 历史消息 |
| chat_file | string | 否 | 对话文件路径 |
| action_mode | string | 否 | 动作模式（默认 "chat"） |
| file_path | string | 否 | 上传文件路径 |
| override_task_type | string | 否 | 强制任务类型 |
| kb_query | string | 否 | KB 检索查询 |

**SSE 事件类型**:
| type | 说明 | 附加字段 |
|------|------|---------|
| `task_type` | 任务分类结果 | `task_type`, `confidence` |
| `mode_hint` | 模式提示 | `message` |
| `token` | 生成的 token | `content` |
| `fold` | 思考过程折叠 | `think_len` |
| `think` | 思考内容片段 | `content` |
| `topic_drift` | 话题漂移事件 | `reason`, `overlap`, `drift_level`, `suggestion` |
| `kb_sources` | KB 检索来源 | `sources` (数组) |
| `slash_hint` | 斜杠命令提示 | `message` |
| `filter` | 响应过滤结果 | `warnings`, `corrections` |
| `truncate` | 截断后的内容 | `content` |
| `compress` | 上下文压缩通知 | `msg` |
| `model_reload` | 模型重新加载 | `model` |
| `error` | 错误 | `content` |
| `done` | 完成 | `model`, `chars`, `think_chars`, `time`, `speed`, `task_type` |
| `[DONE]` | 流结束标记 | — |

### GET /api/chats
列出所有对话。

**返回**:
```json
{
  "chats": [{"name": "...", "path": "...", "messages": 5, "current": true}],
  "current": "当前对话路径"
}
```

### POST /api/chats/new
创建新对话。

**返回**: `{"path": "...", "name": "..."}`

### POST /api/chats/switch
切换对话。

**请求体**: `{"path": "对话文件路径"}`

**返回**: `{"path": "...", "messages": [...]}`

### DELETE /api/chats/{chat_name}
删除对话。

**返回**: `{"ok": true, "deleted": "..."}`

### GET /api/chats/{chat_name}/messages
获取对话消息。

**返回**: `{"messages": [...]}`

### POST /api/chats/{chat_name}/append
追加消息到对话文件。

**请求体**: `{"role": "user|assistant|system", "content": "...", "ts": "HH:MM:SS"}`

**返回**: `{"ok": true, "msg_count": 10}`

### POST /api/qa/upload
问答 Tab 文件上传。

**请求**: multipart/form-data，file 字段。

**返回**: `{"ok": true, "content": "文件文本", "filename": "...", "size": 12345}`

### POST /api/qa/ask
问答 Tab 基于文件内容回答。

**请求体**: `{"question": "...", "file_content": "...", "file_name": "..."}`

**返回**: `{"answer": "AI回答"}`

### POST /api/file_upload
上传文件到临时目录。

**请求**: multipart/form-data，file 字段。

**返回**: `{"path": "保存路径", "filename": "...", "size": 12345}`

---

## 2. 文库管理 API（routers/kb.py）

### GET /api/kb/stats
文库统计。

**返回**: `{"ready_documents": 5, "processing_documents": 1, "max_documents": 20, ...}`

### GET /api/kb/module-status
KB 模块安装状态。

**返回**:
```json
{
  "installed": true,
  "ready": true,
  "module_version": "1.0",
  "models": {"embedder": {...}, "reranker": {...}},
  "memory": {...},
  "dependencies": {"rank_bm25": true, "jieba": true, "numpy": true}
}
```

### GET /api/kb/memory-info
内存余量详情。

### POST /api/kb/install-module
安装 KB 模块（接收 ZIP 包）。

**请求**: multipart/form-data，file 字段（.zip）。

**返回**: `{"success": true, "installed_models": [...], "auto_loaded": true}`

### POST /api/kb/uninstall-module
卸载 KB 模块。

**返回**: `{"success": true, "removed_models": 2, "freed_mb": 2100}`

### POST /api/kb/load-models
加载文库嵌入模型和 Reranker。

**返回**: `{"success": true, ...}`

### POST /api/kb/unload-models
卸载文库模型。

### GET /api/kb/documents
列出所有文库文档。

### POST /api/kb/upload
上传文件到文库（异步处理+进度）。

**请求**: multipart/form-data，file 字段。

**返回**: `{"ok": true, "doc_id": "...", "status": "processing", ...}`

### GET /api/kb/documents/{doc_id}/status
查询文档处理进度。

### DELETE /api/kb/documents/{doc_id}
删除文库文档。

### POST /api/kb/documents/{doc_id}/pause
暂停文档处理。

### POST /api/kb/documents/{doc_id}/resume
恢复文档处理。

### POST /api/kb/documents/{doc_id}/cancel
取消文档处理。

### POST /api/kb/ask ⭐ SSE
基于文库问答 — SSE 流式返回。

**请求体**: `{"question": "...", "session_id": "...", "kb_history_turns": 0}`

**SSE 事件类型**: `status`, `token`, `think`, `fold`, `sources`, `error`, `[DONE]`

### POST /api/kb/new_session
新建 KB 问答会话。

**请求体**: `{"session_id": "..."}`

### POST /api/kb/search
文库检索（仅返回结果不调用 LLM）。

**请求体**: `{"query": "...", "top_k": 5}`

**返回**: `{"results": [...]}`

### POST /api/kb/import_text
直接导入文本到文库。

**请求体**: `{"filename": "...", "text": "...", "source": "transcript"}`

**返回**: `{"ok": true, "doc_id": "...", "status": "processing"}`

---

## 3. 录音纪要 API（routers/recorder.py）

### GET /api/recorder/whisper/status
Whisper 模型状态。

**返回**: `{"installed": true, "ready": true, "model_name": "...", "mem_mb": 1000}`

### POST /api/recorder/whisper/load
加载 Whisper 模型。

### POST /api/recorder/whisper/unload
卸载 Whisper 模型。

### POST /api/recorder/start
开始录音会话。

**返回**: `{"session_id": "...", ...}`

### POST /api/recorder/chunk
上传音频块（实时落盘）。

**请求**: raw body + query param `session_id`。

### POST /api/recorder/finish
结束录音，触发转写。

**请求体**: `{"session_id": "..."}`

### POST /api/recorder/import
导入已有音频文件。

**请求**: multipart/form-data，file 字段（mp3/wav/m4a/webm）。

### GET /api/recorder/locked
对话 Tab 是否锁定（转写中）。

**返回**: `{"locked": true/false}`

### GET /api/recorder/sessions
历史录音列表。

**返回**: `{"sessions": [...], "storage": {...}}`

### GET /api/recorder/{session_id}/status
查询转写进度。

### GET /api/recorder/{session_id}/transcript
获取最终转写原文。

### GET /api/recorder/{session_id}/rough
获取原始粗稿。

### GET /api/recorder/{session_id}/segments
获取转写时间戳段落数据。

**返回**: `{"ok": true, "segments": [...]}`

### GET /api/recorder/{session_id}/audio
播放录音文件。

**返回**: FileResponse (audio/webm)

### PUT /api/recorder/{session_id}/transcript
更新转写稿（用户编辑后保存）。

**请求体**: `{"text": "..."}`

### POST /api/recorder/{session_id}/summarize
生成 AI 会议纪要。

### POST /api/recorder/{session_id}/import_kb
转写稿导入文库。

### POST /api/recorder/{session_id}/pause
暂停处理。

### POST /api/recorder/{session_id}/resume
恢复处理。

### POST /api/recorder/{session_id}/cancel
取消处理。

### DELETE /api/recorder/{session_id}
删除录音 session。

### GET /api/recorder/storage
录音空间占用统计。

### POST /api/recorder/recover
手动触发崩溃恢复。

### POST /api/recorder/live-transcribe
实时转写。

**请求**: raw body（音频数据）+ query param `session_id`。

**返回**: `{"ok": true, "text": "..."}`

### POST /api/recorder/{session_id}/refine
手动触发 8B 纠错润色。

---

## 4. 设置/模型/配置 API（routers/settings.py）

### GET /api/info
返回版本和模块信息。

**返回**:
```json
{
  "version": "0.8.12",
  "version_display": "v0.8 patch 12",
  "modules": {"task_classifier": "v1.0", ...}
}
```

### GET /api/status
模型状态。

### GET /api/health
健康检查端点。

**返回**: `{"status": "ok", "model_loaded": true, "device": "NPU", ...}`

### GET /api/token-budget
Token 预算计算。

### GET /api/models
返回可用 LLM 模型列表和当前状态。

**返回**:
```json
{
  "available": ["qwen3-8b-ov"],
  "loaded": ["qwen3-8b-ov"],
  "current": "qwen3-8b-ov",
  "device": "NPU",
  "profile": {...}
}
```

### POST /api/load/{model_name}
加载模型。

### POST /api/unload/{model_name}
卸载模型。

### GET /api/devices
返回可用设备列表 + 当前选中设备。

### POST /api/device/switch
切换推理设备（会卸载当前 LLM）。

**请求体**: `{"device": "NPU"|"GPU"|"CPU"}`

### GET /api/env/check
返回完整环境报告。

### POST /api/stop
停止当前生成（同步等待）。

### POST /api/rescan
重新扫描模型目录。

### POST /api/models/import [已废弃 410]
已合并到 `/api/extensions/upload`。

### GET /api/workspace/{file_path:path}
下载沙盒中生成的文件。

### GET /api/workspace
列出沙盒中所有文件。

### GET /api/config
获取用户配置。

### POST /api/config
保存用户配置。

### GET /api/resource-info
统一的资源信息端点（内存、模块占用、预算）。

### POST /api/budget
设置内存预算。

**请求体**: `{"budget_mb": 10240}`

### POST /api/extensions/upload
上传 .sidemate 扩展包（异步模式）。

**请求**: multipart/form-data，file 字段（.sidemate）。

**返回**: `{"task_id": "...", "filename": "..."}`

### GET /api/extensions/install-progress/{task_id} ⭐ SSE
扩展安装进度推送（SSE 格式）。

**SSE 事件类型**: `progress`（percent, stage）, `done`（result）, `error`（message）

### GET /api/extensions/list
已安装扩展列表。

### DELETE /api/extensions/uninstall/{ext_type}/{ext_name}
卸载扩展（通用）。

**路径参数**: ext_type = "whisper"|"knowledge", ext_name = 扩展名

### GET /api/load-progress ⭐ SSE
模型加载进度（SSE 格式）。

**Query 参数**: `model_name`, `device`（可选）

**SSE 事件类型**: `progress`（percent, stage）, `done`, `error`

### DELETE /api/extensions/{ext_type}/{ext_name}
卸载扩展（旧版兼容路径）。

---

## 5. Action 管理 API（routers/skill.py）

### GET /api/action/list
列出所有可用 Action（内置 + 扩展安装的）。

**返回**: `{"actions": [...], "total": 5}`

### DELETE /api/action/{action_id}
卸载扩展 Action。

---

## 6. 缓存文件管理 API（routers/files.py）

### GET /api/cache/files
列出缓存文件。

**Query 参数**: `category` = "uploads"|"recordings"|"files"

**返回**: `{"files": [...], "total": 5, "total_size": 12345}`

### DELETE /api/cache/files/{filename}
删除单个缓存文件。

**Query 参数**: `category`

### DELETE /api/cache/files
清空某类缓存文件。

**Query 参数**: `category`

**返回**: `{"ok": true, "deleted": 5}`

---

## SSE 流式接口特殊说明

### SSE 协议格式

所有 SSE 端点遵循标准 Server-Sent Events 协议：

```
data: {"type": "token", "content": "你好"}\n\n
data: {"type": "token", "content": "世界"}\n\n
data: {"type": "done", "chars": 100}\n\n
data: [DONE]\n\n
```

**特征**：
- Content-Type: `text/event-stream`
- 结束标记: `data: [DONE]\n\n`
- 心跳: `: heartbeat\n\n`（仅扩展安装进度端点）

### SSE 端点列表

| 端点 | 说明 |
|------|------|
| `POST /api/chat/stream` | 聊天流式对话 |
| `POST /api/kb/ask` | 文库问答流式 |
| `GET /api/load-progress` | 模型加载进度 |
| `GET /api/extensions/install-progress/{task_id}` | 扩展安装进度 |

## WebSocket 接口

**当前 Patch12 无 WebSocket 接口。**

所有实时通信均通过 SSE 实现。录音的实时转写通过 HTTP POST 循环上传音频块实现。

---

## 前端同步事项记录

> 以下为 2026-05-29 前端团队同步后的核对结果

### ❌ 已废弃：Pipeline 端点（前端需移除调用）

前端 `chat.js:1200-1226` 曾调用以下端点，后端**从未实现**，属历史残留：

| 方法 | 端点 | 状态 |
|------|------|------|
| POST | `/api/chat/pipeline/{id}/approve` | ❌ 不存在，请前端移除 |
| POST | `/api/chat/pipeline/{id}/pause` | ❌ 不存在，请前端移除 |
| POST | `/api/chat/pipeline/{id}/resume` | ❌ 不存在，请前端移除 |
| POST | `/api/chat/pipeline/{id}/cancel` | ❌ 不存在，请前端移除 |

### 💡 建议：心跳端点切换

| 当前 | 建议 | 说明 |
|------|------|------|
| `GET /api/status` | `GET /api/health` | `/api/health` 更轻量，不返回完整模型状态 JSON |

### 📋 P12 新增端点（前端暂未使用）

以下端点已就绪，前端可按需接入：

| 端点 | 说明 | 可能用途 |
|------|------|---------|
| `GET /api/workspace` | 沙盒文件列表 | 文件管理 Tab |
| `GET /api/workspace/{path}` | 沙盒文件下载 | 导出生成的文件 |
| `POST /api/kb/search` | 文库纯检索（不调 LLM） | 搜索预览 |
| `POST /api/kb/import_text` | 直接导入文本到文库 | 从纪要导入 |

### ✅ 术语已统一

前端同步文档中列出的 9 处术语修改（知识库→文库、语音转写→纪要、主模型→AI模型）**已全部完成**。
