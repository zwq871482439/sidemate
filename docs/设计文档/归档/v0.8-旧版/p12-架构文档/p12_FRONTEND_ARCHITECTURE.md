# 桌伴 · Sidemate 前端架构文档

> 基于 Patch12 源码分析，覆盖模块结构、全局变量、Tab 路由、SSE 流式渲染、CSS 变量体系、状态管理、错误处理、API 汇总。

---

## 1. 模块结构图

```
index.html（单一入口，~747行）
├── <head> 外部依赖
│   ├── katex.min.css / katex.min.js     → LaTeX 公式渲染
│   └── highlight.min.css / .js           → 代码语法高亮
├── <head> 主样式
│   └── static/css/main.css               → 全局 CSS 变量 + 布局样式
├── <body> DOM 结构
│   ├── #offlineBanner                    → 离线横幅
│   ├── #toastContainer                   → Toast 通知容器
│   ├── #app > .header + .tabs-nav        → 标题栏 + 4 Tab 导航
│   ├── #tab-chat                         → 对话 Tab（含 ActionBar、message 列表、输入区）
│   ├── #tab-qa                           → 文库 Tab（三态：loading/安装引导/完整界面）
│   ├── #tab-minutes                      → 纪要 Tab（三态：loading/安装引导/就绪）
│   ├── #tab-settings                     → 设置 Tab（双列卡片布局）
│   └── #loadingOverlay                   → 全局加载遮罩
├── <script> 内联全局状态                  → index.html:L594-614
├── core/api.js                           → fetch 超时封装 + API 路径辅助
├── core/errors.js                        → Toast/心跳/离线横幅/自定义弹窗
├── core/utils.js                         → esc/md/LaTeX/文件卡片/代码复制
├── settings.js                           → 模型管理/资源面板/设备切换/扩展 (~960行)
├── qa.js                                 → 文库文档管理/问答交互 (~700行)
├── minutes.js                            → 录音/VAD/转写/播放 (~1100行)
└── chat.js                               → SSE 对话/会话管理/Pipeline (~1280行)
```

> **加载顺序**: 全局状态变量 → api.js → errors.js → utils.js → settings.js → qa.js → minutes.js → chat.js  
> 后加载的模块可引用（override）前面模块暴露的全局函数。

---

## 2. 全局作用域变量表

所有变量声明在 `index.html` 内联脚本或各模块顶层（`var` / `let`），通过 `<script>` 加载自然挂载到 `window`。

| 变量名 | 来源文件 | 类型 | 用途 |
|--------|---------|------|------|
| `API` | index.html:L613 | String | API 路径前缀（默认 `""`） |
| `currentMessages` | index.html:L596 | Array | 当前对话消息列表 |
| `currentChatFile` | index.html:L597 | String\|null | 当前对话文件路径 |
| `generating` | index.html:L598 | Boolean | SSE 流式生成中标志 |
| `abortCtrl` | index.html:L599 | AbortController\|null | 中止 SSE 请求的控制器 |
| `currentActionMode` | index.html:L601 | String | 当前 Action 模式（chat\|kb\|doc） |
| `_overrideTaskType` | index.html:L602 | String | 临时覆盖任务分类 |
| `_variantTargetIdx` | index.html:L603 | Number | 变体回复目标索引（-1=正常） |
| `_refFilePath` | index.html:L604 | String\|null | 引用文件路径 |
| `_maxPromptTokens` | index.html:L605 | Number | 当前模型 prompt token 上限 |
| `_lastMsgCount` | index.html:L606 | Number | 上次消息数量（Session 轮询） |
| `_sessionPollTimer` | index.html:L607 | Number\|null | Session 轮询定时器 ID |
| `pendingFile` | index.html:L608 | File\|null | 待上传文件对象 |
| `_kbBusyProcessing` | qa.js:L8 | Boolean | 文库摘要处理中 |
| `_kbGenerating` | qa.js:L9 | Boolean | 文库问答生成中 |
| `_kbModelsLoaded` | qa.js:L10 | Boolean | 文库模型已加载 |
| `_recMediaRecorder` | minutes.js:L5 | MediaRecorder\|null | 录音器实例 |
| `_recSessionId` | minutes.js:L6 | String\|null | 录音会话 ID |
| `_loadedModelId` | settings.js:L6 | String\|null | 当前已加载模型 ID |
| `__HTML_VERSION__` | index.html:L611 | String | 前端版本号（`"v2.0"`） |

---

## 3. 4 Tab 架构

> **TL;DR**: 4 个 Tab 分别由 4 个 JS 模块独立控制，`switchTab()` 函数（index.html:L627-637）负责切换 DOM 可见性并调用各自的**路由/初始化函数**。

### Tab 切换函数

```javascript
// index.html:L627-637
function switchTab(name, btn) {
  // 切换 .tabs-nav button 的 active 状态
  // 切换 .tab-content 的 active 状态
  // 根据 name 分发到对应路由函数
  if (name === 'settings') { refreshStatus(); loadRerankerResident(); ... }
  if (name === 'qa') kbRouteState();      // 文库三态路由
  if (name === 'minutes') minutesRouteState();  // 纪要三态路由
  if (name === 'chat') updateChatOverlay();     // 对话模型锁
}
```

### 各 Tab 详情

| Tab | DOM ID | 路由函数 | 核心模块 | 行数 |
|-----|--------|---------|---------|------|
| 💬 对话 | `tab-chat` | `updateChatOverlay()` | chat.js | ~1280 |
| 📚 文库 | `tab-qa` | `kbRouteState()` | qa.js | ~700 |
| 📝 纪要 | `tab-minutes` | `minutesRouteState()` | minutes.js | ~1100 |
| ⚙️ 设置 | `tab-settings` | `refreshStatus()` | settings.js | ~960 |

### Tab 三态路由模式（文库/纪要）

文库 (`kbRouteState`, qa.js:L17-50) 和纪要 (`minutesRouteState`, minutes.js:L49-97) 采用相同三态设计：

1. **Loading** — 显示 spinner，异步请求 `/api/kb/module-status` 或 `/api/recorder/whisper/status`
2. **未安装** — 显示安装引导页（拖拽上传 .zip 包）
3. **已就绪** — 显示完整功能界面

---

## 4. SSE 流式渲染流程

> **TL;DR**: `sendMessage()` 使用 `fetch` + `ReadableStream` 读取 `/api/chat/stream` 的 SSE 响应，按 80ms 间隔增量更新 `#stream-msg` 元素，`done` 事件后将内容落盘到 `currentMessages`。

### 连接建立（chat.js:L660-1175）

```
sendMessage()
  → 构造请求体 {message, history, chat_file, action_mode, file_path, override_task_type}
  → fetch(API + '/api/chat/stream', {method:'POST', signal: abortCtrl.signal})
  → resp.body.getReader() 逐块读取
  → 按 \n 分割，解析 "data: " 前缀的 JSON 行
  → 分发到对应事件处理器
```

### SSE 事件类型

| 事件 type | 说明 | 来源 | 触发动作 |
|-----------|------|------|---------|
| `task_type` | 任务分类 | chat.js:L858 | 设置 `currentTaskType` |
| `queue` | 排队序号 | chat.js:L860 | 显示排队位置 |
| `token` | 生成 Token | chat.js:L903 | 增量追加内容，80ms 节流 |
| `fold` | Think 折叠 | chat.js:L922 | 将思考内容折叠为 `<details>` |
| `done` | 流结束 | chat.js:L929 | 生成 stats，最终渲染 |
| `error` | 错误 | chat.js:L961 | 显示错误消息 |
| `think` | Thinking 阶段 | chat.js:L906-907 | （chat 中隐含，token 的前期 stage） |
| `topic_drift` | 话题漂移 | chat.js:L994 | 显示漂移提示条 |
| `pipeline_start/step/done/error` | Pipeline 流程 | chat.js:L865-901 | 显示多步骤状态 |
| `agent_start/think/action/result/done` | Agent 模式 | chat.js:L996-1054 | 渲染 Agent 面板 |
| `chunk_start/progress/result/merge/done` | 长文本分段 | chat.js:L1055-1088 | 显示分段进度 |
| `model_reload` | 模型重载 | chat.js:L947 | 显示重载提示 |
| `compress` | 上下文压缩 | chat.js:L963 | 短暂提示后消失 |
| `filter` | 响应过滤 | chat.js:L972 | 显示幻觉/质量问题警告 |
| `human_approval` | 人工审批 | chat.js:L877 | 渲染审批按钮组 |
| `kb_references` / `kb_no_reference` | KB 引用 | chat.js:L1110-1114 | Toast 提示 |

### 增量 DOM 更新

- `renderMessages()` (chat.js:L165-229)：优先增量追加（比较 `existingCount` 和 `currentMessages.length`），仅在数量不一致时全量重新渲染。
- `appendStreamingMsg()` (chat.js:L369-412)：创建/更新 `#stream-msg` 元素，每 80ms 节流渲染一次。
- Think 折叠：当 `d.type === 'fold'` 时，将 `think` 内容包裹为 `<details class="think-details"><summary>思考过程(N字)</summary>...</details>`。
- KaTeX/Highlight.js 延迟渲染：`renderMessages()` 末尾调用 `applyCodeHighlight()`，LaTeX 在 `md()` 函数内即时渲染。

### 取消机制

- 前端：点击 `#stopBtn` → `stopGeneration()` → `abortCtrl.abort()` + `POST /api/stop`
- `finally` 块恢复 UI 状态：`_restoreChatUI()` 恢复按钮/输入框状态

---

## 5. CSS 变量体系

> **TL;DR**: 全部定义在 `main.css` `:root`（Light）和 `[data-theme="dark"]`（Dark），覆盖 Logo 色系（深蓝+橙黄+米白）。

### 主色系（Primary）

| 变量 | Light 值 | Dark 值 | 用途 |
|------|---------|--------|------|
| `--primary-900` | `#1e3a5f` | — | 最深主色 |
| `--primary-700` | `#2d4a6f` | — | 默认主色（= `--accent-color`） |
| `--primary-500` | `#4a6a8f` | — | 中等主色 |
| `--primary-200` | `#c5d0e0` | — | 浅主色 |
| `--primary-50` | `#e8eef5` | — | 极浅主色 |

### 强调色（Accent）

| 变量 | Light 值 | Dark 值 | 用途 |
|------|---------|--------|------|
| `--accent-600` | `#c9976c` | — | 强调色（暖） |
| `--accent-400` | `#deb893` | — | 浅强调色 |
| `--accent-100` | `#f5ebe0` | — | 极浅强调色 |
| `--accent-color` | `var(--primary-700)` | `#5b8cc9` | 语义别名 |
| `--accent-hover` | `var(--primary-900)` | `#7aa8dd` | Hover 状态 |

### 背景色（Background）

| 变量 | Light 值 | Dark 值 | 用途 |
|------|---------|--------|------|
| `--bg-primary` | `#faf9f6` | `#0f172a` | 主背景 |
| `--bg-secondary` | `#f3f2ed` | `#1e293b` | 次背景 |
| `--bg-tertiary` | `#e8e7e2` | `#334155` | 三级背景 |

### 文字色（Text）

| 变量 | Light 值 | Dark 值 | 用途 |
|------|---------|--------|------|
| `--text-primary` | `#1f2937` | `#f8fafc` | 主文字 |
| `--text-secondary` | `#4b5563` | `#cbd5e1` | 次文字 |
| `--text-muted` | `#6b7280` | `#94a3b8` | 弱文字 |

### 边框 / 状态色

| 变量 | Light 值 | Dark 值 | 用途 |
|------|---------|--------|------|
| `--border-color` | `#d9d9d3` | `#334155` | 边框 |
| `--error-color` | `#b91c1c` | `#f87171` | 错误 |
| `--success-color` | `#059669` | `#34d399` | 成功 |
| `--warning-color` | `#d97706` | `#fbbf24` | 警告 |

### 消息 / 代码

| 变量 | Light 值 | Dark 值 | 用途 |
|------|---------|--------|------|
| `--msg-user-bg` | `#e8eef5` | `#1e293b` | 用户消息背景 |
| `--msg-ai-bg` | `#f3f2ed` | `#1e293b` | AI 消息背景 |
| `--code-bg` | `#f7f7f4` | `#0f172a` | 代码块背景 |

### Chip 标签（任务分类）

| 变量 | Light 值 | Dark 值 |
|------|---------|--------|
| `--chip-reasoning-bg` / `-text` | `#dbeafe` / `#1e40af` | `rgba(96,165,250,.15)` / `#93c5fd` |
| `--chip-code-bg` / `-text` | `#dcfce7` / `#166534` | `rgba(52,211,153,.15)` / `#86efac` |
| `--chip-text-bg` / `-text` | `#fef3c7` / `#92400e` | `rgba(251,191,36,.15)` / `#fde68a` |
| `--chip-agent-bg` / `-text` | `#ede9fe` / `#6d28d9` | `rgba(167,139,250,.15)` / `#c4b5fd` |
| `--chip-doc-bg` / `-text` | `#fce7f3` / `#9d174d` | `rgba(244,114,182,.15)` / `#f9a8d4` |

### Think / 离线横幅

| 变量 | Light 值 | Dark 值 |
|------|---------|--------|
| `--think-color` / `--think-hover` / `--think-bg` | `#7c3aed` / `#5b21b6` / `rgba(124,58,237,.04)` | `#a78bfa` / `#c4b5fd` / `rgba(124,58,237,.08)` |
| `--offline-bg` / `--offline-border` / `--offline-text` | `#fef2f2` / `#fca5a5` / `#991b1b` | `var(--bg-secondary)` / `var(--error-color)` / `var(--error-color)` |

---

## 6. 状态管理

> **TL;DR**: 无框架层的状态管理，全部使用全局变量 + 轮询 + SSE 事件驱动。

### 全局状态一览

参见第 2 节全局变量表。核心状态关系：

```
generating → 控制 UI 按钮/输入框 disabled 状态
currentMessages → 对话数据源，renderMessages() 渲染
_loadedModelId → 所有 Tab 的"模型是否加载"判断依据
_kbBusyProcessing → 文库摘要处理中，锁住 KB 问答输入
_kbModelsLoaded → 文库顶部资源栏状态
_recMediaRecorder → 录音状态，控制录音区域显隐
```

### 同步机制

| 机制 | 实现位置 | 间隔 | 说明 |
|------|---------|------|------|
| Session 轮询 | chat.js:L22-60 | 5s | `startSessionPoll()` 检测 `currentMessages` 变化 |
| KB 文档轮询 | qa.js:L314-320 | 3s | 仅在文档处理中启动 |
| 纪要进度轮询 | minutes.js:L30-46 | 2s | `_pollMinutesProgress()` 跟踪转写/纠错进度 |
| 心跳检测 | errors.js:L273-286 | 30s | `/api/status` 检测后端连通性 |
| 对话锁轮询 | minutes.js:L1059-1072 | 3s | `checkRecordingLock()` 检测录音期间对话锁定 |
| SSE 事件驱动 | chat.js:L739-1118 | — | `/api/chat/stream` 流式推送 |

### 重连恢复流程

`retryConnect()` (errors.js:L228-249) 响应离线横幅"重试连接"按钮：

```
fetchWithTimeout('/api/status', 3s)
  → hideOfflineBanner()
  → refreshStatus()           → 刷新模型状态
  → refreshActionBar()         → 刷新 Action 栏
  → kbRouteState()             → 文库 Tab 状态路由
  → minutesRouteState()        → 纪要 Tab 状态路由
  → refreshResourcePanel()     → 资源占用面板
```

---

## 7. 错误处理策略

> **TL;DR**: 三层防御——静默日志、Toast 通知中心、自定义弹窗。不依赖浏览器 `alert/confirm`。

### ERROR_MAP 错误码映射（errors.js:L22-29）

| 错误码 | 提示消息 | 建议操作 |
|--------|---------|---------|
| `MODEL_LOAD_ERROR` | 模型加载失败 | 检查模型文件完整性 |
| `KB_NOT_READY` | 文库未就绪 | 请先安装文库模块 |
| `AGENT_TIMEOUT` | Agent 响应超时 | 请简化问题后重试 |
| `NO_MODEL` | 未加载模型 | 请先在设置中加载模型 |
| `NETWORK_ERROR` | 网络连接异常 | 检查网络或稍后重试 |
| `UNKNOWN_ERROR` | 未知错误 | 请刷新页面或重启服务 |

### FRIENDLY_ERRORS HTTP 友好提示（errors.js:L31-39）

| 状态码/模式 | 友好消息 |
|------------|---------|
| `500` | 服务处理出错，请稍后重试 |
| `502` | 服务暂不可用，请稍后重试 |
| `503` | 服务繁忙，请稍后重试 |
| `timeout` | 服务响应较慢，请确认后台正在运行 |
| `NetworkError` | 无法连接服务，请检查是否已启动 |
| `AbortError` | 请求已取消 |

### silentLog 静默日志（errors.js:L9-17）

抑制启动阶段的 `NetworkError` / `Failed to fetch` 错误，避免控制台刷屏。

### showToast 通知中心（errors.js:L70-151）

- **去重**: 相同消息 5 秒内不重复显示
- **排队**: 超出 3 个上限进入队列
- **防重入**: 带 `key` 参数的 toast 同一时间仅保留一个

### showDialog 自定义弹窗（errors.js:L305-349）

- 支持 `type: 'danger'` 红色确认按钮
- 支持 `confirm: true` 双按钮模式（确定/取消）
- 点击遮罩层或按 Escape 关闭
- 返回 Promise 供 async/await 使用

---

## 8. API 调用汇总

> **TL;DR**: 前端共调用约 50+ 后端端点，通过 `fetchWithTimeout()` 全部带 10s 默认超时。

注：`(SSE)` 标记的端点使用 EventSource 或无超时的 fetch。

### 对话 / 聊天

| 端点 | 方法 | 调用模块 | 说明 |
|------|------|---------|------|
| `/api/chat/stream` | POST | chat.js | 流式对话（SSE） |
| `/api/stop` | POST | chat.js | 停止生成 |
| `/api/chats` | GET | chat.js | 对话列表 |
| `/api/chats/new` | POST | chat.js | 新建对话 |
| `/api/chats/switch` | POST | chat.js | 切换对话 |
| `/api/chats/{name}` | DELETE | chat.js | 删除对话 |
| `/api/chats/{name}/messages` | GET | chat.js | 获取消息 |
| `/api/chats/{name}/append` | POST | chat.js | 追加消息 |
| `/api/file_upload` | POST | chat.js | 上传文件 |

### 文库（KB）

| 端点 | 方法 | 调用模块 | 说明 |
|------|------|---------|------|
| `/api/kb/module-status` | GET | qa.js | KB 模块状态 |
| `/api/kb/documents` | GET | qa.js | 文档列表 |
| `/api/kb/stats` | GET | qa.js | 文库统计 |
| `/api/kb/upload` | POST | qa.js | 上传文档 |
| `/api/kb/ask` | POST | qa.js | 文库问答（SSE） |
| `/api/kb/new_session` | POST | qa.js | 新建 KB 会话 |
| `/api/kb/load-models` | POST | qa.js | 加载 KB 模型 |
| `/api/kb/unload-models` | POST | qa.js | 卸载 KB 模型 |
| `/api/kb/install-module` | POST | qa.js | 安装 KB 模块 |
| `/api/kb/documents/{id}` | DELETE | qa.js | 删除文档 |
| `/api/kb/documents/{id}/pause` | POST | qa.js | 暂停处理 |
| `/api/kb/documents/{id}/resume` | POST | qa.js | 恢复处理 |
| `/api/kb/documents/{id}/cancel` | POST | qa.js | 取消处理 |
| `/api/kb/memory-info` | GET | qa.js | KB 内存信息 |

### 纪要（Recorder）

| 端点 | 方法 | 调用模块 | 说明 |
|------|------|---------|------|
| `/api/recorder/start` | POST | minutes.js | 开始录音 |
| `/api/recorder/chunk` | POST | minutes.js | 发送音频片段 |
| `/api/recorder/finish` | POST | minutes.js | 结束录音 |
| `/api/recorder/sessions` | GET | minutes.js | 录音列表 |
| `/api/recorder/import` | POST | minutes.js | 导入音频文件 |
| `/api/recorder/{id}/status` | GET | minutes.js | 会话状态 |
| `/api/recorder/{id}/rough` | GET | minutes.js | 原始转写稿 |
| `/api/recorder/{id}/segments` | GET | minutes.js | 带时间戳分段 |
| `/api/recorder/{id}/transcript` | PUT | minutes.js | 保存转写稿 |
| `/api/recorder/{id}/summarize` | POST | minutes.js | 生成纪要 |
| `/api/recorder/{id}/refine` | POST | minutes.js | AI 纠错 |
| `/api/recorder/{id}/resume` | POST | minutes.js | 重试转写 |
| `/api/recorder/{id}` | DELETE | minutes.js | 删除录音 |
| `/api/recorder/{id}/import_kb` | POST | minutes.js | 导入到文库 |
| `/api/recorder/{id}/audio` | GET | minutes.js | 音频文件 |
| `/api/recorder/whisper/status` | GET | minutes.js | Whisper 状态 |
| `/api/recorder/whisper/load` | POST | minutes.js | 加载 Whisper |
| `/api/recorder/whisper/unload` | POST | minutes.js | 卸载 Whisper |
| `/api/recorder/locked` | GET | minutes.js | 对话锁检测 |
| `/api/recorder/storage` | GET | minutes.js | 存储统计 |
| `/api/recorder/live-transcribe` | POST | minutes.js | 实时转写 |

### 设置 / 系统

| 端点 | 方法 | 调用模块 | 说明 |
|------|------|---------|------|
| `/api/status` | GET | errors.js | 心跳检测 |
| `/api/models` | GET | settings.js | 模型列表 |
| `/api/devices` | GET | settings.js | 可用设备 |
| `/api/rescan` | POST | settings.js | 重新扫描模型 |
| `/api/device/switch` | POST | settings.js | 切换推理设备 |
| `/api/load-progress` | GET | settings.js | 模型加载进度（SSE） |
| `/api/unload/{model}` | POST | settings.js | 卸载模型 |
| `/api/resource-info` | GET | settings.js | 资源占用 |
| `/api/budget` | POST | settings.js | 设置内存预算 |
| `/api/token-budget` | GET | settings.js | Token 预算 |
| `/api/config` | GET/POST | settings.js | 配置管理 |
| `/api/info` | GET | settings.js | 版本信息 |
| `/api/env/check` | GET | settings.js | 环境检测 |

### 扩展 / Action / 缓存

| 端点 | 方法 | 调用模块 | 说明 |
|------|------|---------|------|
| `/api/extensions/list` | GET | settings.js | 扩展列表 |
| `/api/extensions/upload` | POST | settings.js | 安装扩展 |
| `/api/extensions/install-progress/{id}` | GET | settings.js | 安装进度（SSE） |
| `/api/extensions/uninstall/{type}/{name}` | DELETE | settings.js | 卸载扩展 |
| `/api/action/list` | GET | chat.js/settings.js | Action 列表 |
| `/api/action/{id}` | DELETE | settings.js | 卸载 Action |
| `/api/cache/files` | GET/DELETE | settings.js | 缓存文件 |

### Pipeline 控制

| 端点 | 方法 | 调用模块 | 说明 |
|------|------|---------|------|
| `/api/chat/pipeline/{id}/approve` | POST | chat.js | 审批 Pipeline |
| `/api/chat/pipeline/{id}/pause` | POST | chat.js | 暂停 Pipeline |
| `/api/chat/pipeline/{id}/resume` | POST | chat.js | 恢复 Pipeline |
| `/api/chat/pipeline/{id}/cancel` | POST | chat.js | 取消 Pipeline |
