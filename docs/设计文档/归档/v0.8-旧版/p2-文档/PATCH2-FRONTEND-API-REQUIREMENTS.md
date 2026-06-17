# Sidemate v0.9.2 Patch2 — 前端 API 需求文档

> **目标读者**：后端团队  
> **来源**：前端团队  
> **日期**：2026-06-06  
> **版本**：v1.0

---

## 0. 摘要

Patch2 前端需要对接 **12 个新增 API 端点** + 复用现有 `/api/chat/stream`（新增 SSE 事件类型）。本文档列出每个端点的请求/响应格式、SSE 事件定义、及前端预期行为。

---

## 1. 新增 API 端点（12 个）

### 1.1 `GET /api/mode`

**获取当前 AI 模式。**

| 字段 | 来源 | 说明 |
|------|------|------|
| Response | 后端 | `mode`, `available`, `cloud_configured`, `context_window`, `max_history_chars` |

```json
{
  "mode": "local",
  "available": ["local", "cloud"],
  "cloud_configured": false,
  "context_window": 16000,
  "max_history_chars": 12000
}
```

**前端调用时机**：页面初始化时调用，设置 Header 模式 Tag。

---

### 1.2 `POST /api/mode/switch`

**切换 AI 模式。**

| 字段 | 来源 | 说明 |
|------|------|------|
| Request | 前端 | `{"mode": "cloud"}` |
| Response (成功) | 后端 | `{"ok": true, "mode": "cloud", "context_window": 128000, "max_history_chars": 150000, "max_output_tokens": 16384}` |
| Response (失败-未配置) | 后端 | `{"ok": false, "error": "云端 AI 模型未配置，请先在设置中配置 API Key 和模型"}` |
| Response (失败-连接失败) | 后端 | `{"ok": false, "error": "云端 AI 连接失败: Connection refused"}` |

**前端调用时机**：用户在确认弹窗中点击「确认切换」后。

---

### 1.3 `GET /api/cloud/config`

**获取云端 AI 配置（API Key 脱敏）。**

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

**前端调用时机**：进入设置页「云端 AI 配置」折叠区时。

---

### 1.4 `POST /api/cloud/config`

**保存云端 AI 配置。**

Request:
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
| `base_url` | string | 否 | API 地址 |
| `api_key` | string | 否 | API Key（后端 base64 编码存储） |
| `model` | string | 否 | 模型名称 |
| `context_policy` | string | 否 | `"full"` / `"current_only"` / `"slim_history"` |
| `slim_history_rounds` | number | 否 | `slim_history` 模式下保留轮数 |

Response:
```json
{"ok": true, "context_window": 128000, "max_output_tokens": 16384}
```

---

### 1.5 `POST /api/cloud/test`

**测试云端连接。**

Request: 无（使用已保存配置）

Response (成功):
```json
{"ok": true, "model": "gpt-4o-mini", "latency_ms": 523}
```

Response (失败):
```json
{"ok": false, "error": "Authentication failed: Invalid API Key"}
```

---

### 1.6 `GET /api/search/config`

**获取搜索配置。**

```json
{
  "search_source": "bing",
  "api_key_set": true,
  "api_key_preview": "***...***abc"
}
```

---

### 1.7 `POST /api/search/config`

**保存搜索配置。**

Request:
```json
{
  "search_source": "bing",
  "api_key": "your-bing-api-key"
}
```

Response:
```json
{"ok": true}
```

---

### 1.8 `POST /api/search/test`

**测试搜索连接。**

Response (成功):
```json
{"ok": true, "results_count": 8, "latency_ms": 342}
```

Response (失败):
```json
{"ok": false, "error": "搜索服务不可用: ..."}
```

---

### 1.9 `POST /api/chats/{chat_name}/rename`

**重命名会话。**

Request:
```json
{"new_name": "产品需求讨论"}
```

Response (成功):
```json
{
  "ok": true,
  "old_name": "2026-06-05_143022",
  "new_name": "产品需求讨论",
  "new_file": "产品需求讨论.json"
}
```

Response (失败):
```json
{"ok": false, "error": "会话名称已存在"}
```

---

### 1.10 `POST /api/backup/export`

**一键导出备份 ZIP。**

Response: `application/zip` 文件下载。ZIP 结构：
```
sidemate-backup-20260606.zip
├── chats/         # 所有对话 JSON
├── settings.json  # 用户设置
├── kb_meta/       # 文库元数据
└── backup_meta.json  # 备份元信息
```

---

### 1.11 `POST /api/backup/import`

**一键恢复备份。**

Request: `multipart/form-data`, 字段 `file` 为 ZIP 文件

Response:
```json
{
  "ok": true,
  "restored": {"chats": 5, "settings": true, "kb_meta": true}
}
```

---

### 1.12 `GET /api/context/usage`

**获取当前会话上下文使用量。**

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
| `used_tokens` | number | 已使用 tokens |
| `total_tokens` | number | 总上下文窗口 |
| `percentage` | number | 0-100 |
| `level` | string | `"normal"` (<60%) / `"warning"` (60-85%) / `"critical"` (>85%) |

**前端调用时机**：每次发送/接收消息后更新 Header 圆环指示器。

---

## 2. SSE 事件新增类型（复用 `/api/chat/stream`）

### 2.1 Research Action 事件（仅 `action_mode == "research"`）

| event | data 格式 | 说明 |
|-------|----------|------|
| `search` | `{"query": "关键词", "results_count": 8}` | 搜索状态 |
| `fetch` | `{"url": "https://...", "title": "网页标题"}` | 网页抓取状态 |
| `done` | `{"stats": {"search_count": 3, "fetch_count": 2}}` | 研究完成统计 |

**前端处理**：
- `search` → 在消息区插入搜索状态卡片
- `fetch` → 追加网页抓取状态项
- `done` → 显示「已搜索 N 次 · 已阅读 M 个网页」统计

### 2.2 上下文管理事件

| event | data | 触发条件 | 前端处理 |
|-------|------|----------|----------|
| `context_warning` | `{"percentage": 87, "level": "critical"}` | 离线模式上下文 >85% | 弹窗提醒 |
| `context_force_new` | `{"percentage": 96, "new_chat_file": "xxx.json", "summary": "..."}` | 离线模式上下文 >95% | 自动切换新会话 |
| `compress` | `{"phase": "compressing", "progress": 30, "msg": "正在压缩..."}` | 在线模式上下文 >75% | 显示压缩进度 |

**`compress` 事件 phase 值**：
- `"preparing"` — 准备中
- `"compressing"` — 压缩中（附带 `progress` 0-100）
- `"done"` — 完成（附带 `before` / `after` 字符数）

---

## 3. 前端文件修改清单（供参考）

| 文件 | 关联 API |
|------|----------|
| `index.html` | A3 模式 Tag + A7 圆环 + B2 重命名 + C2 备份 |
| `static/css/main.css` | A3/A5/A7 新组件样式 |
| `static/js/chat.js` | `GET /api/mode`, SSE 新事件 |
| `static/js/chat-session.js` (新) | `POST /api/chats/{name}/rename` |
| `static/js/chat-actions.js` (新) | `GET /api/mode` (判断 research 可见性) |
| `static/js/settings.js` | `/api/cloud/*`, `/api/search/*`, `/api/backup/*` |

---

## 4. 附录：现有端点（前端仍在使用）

| 端点 | Method | 前端使用场景 |
|------|--------|-------------|
| `GET /api/status` | GET | 页面初始化 |
| `GET /api/models` | GET | 设置页 |
| `POST /api/chat/stream` | POST | 发送消息（所有模式） |
| `GET /api/chats` | GET | 会话列表 |
| `POST /api/chats/new` | POST | 新建会话 |
| `POST /api/chats/switch` | POST | 切换会话 |
| `DELETE /api/chats/{name}` | DELETE | 删除会话 |
| `GET /api/chats/{name}/messages` | GET | 加载消息历史 |
| `GET /api/config` | GET | 设置页 |
| `POST /api/config` | POST | 设置页 |
| `POST /api/stop` | POST | 停止生成 |
| `GET /api/health` | GET | 心跳检测 |

---

> 📬 **问题反馈**：如有 API 签名变更或字段调整，请同步更新本文档。
