# 桌伴 Sidemate — 前端团队任务书

> **版本**：Patch12 前端修复 + 文档补写
> **代码目录**：`C:\tmp\_local_ai_patch12\`
> **产出目录**：`C:\tmp\桌伴-设计文档\架构设计\`
> **日期**：2026-05-29

---

## 项目背景

桌伴 Sidemate 是一个纯离线本地 AI 助手，技术栈为 FastAPI 后端 + 原生 HTML/JS/CSS 前端（无框架、无构建工具）。当前处于 Patch12 架构重构阶段，后端已拆为 9 包 28 模块，前端尚未同步重构。

**前端技术特点**：
- 传统 `<script>` 引入（非 ES Module），所有 JS 共享 `window` 全局作用域
- CSS 变量做主题（目前只有亮色，暗色变量已定义但未启用切换）
- SSE（Server-Sent Events）流式渲染 AI 回复
- 4 Tab 架构：💬对话 / 📚文库 / 📝纪要 / ⚙️设置

---

## 前端文件结构

```
index.html                    # 单页入口（~640行）
static/
├── css/main.css              # 全局样式 + CSS 变量体系（~400行）
├── js/
│   ├── core/
│   │   ├── api.js            # fetch 超时封装 + 全局 monkey-patch（44行）
│   │   ├── errors.js         # 离线降级 + Toast 通知 + 心跳检测 + 自定义弹窗（343行）
│   │   └── utils.js          # HTML转义、Markdown渲染、LaTeX、文件卡片（324行）
│   ├── chat.js               # 对话Tab：消息发送、SSE流式、Session管理、Action切换（1288行）
│   ├── qa.js                 # 文库Tab：文档管理、语义检索、问答（~600行）
│   ├── minutes.js            # 纪要Tab：录音、转写、纠错、播放（1124行）
│   ├── settings.js           # 设置Tab：模型管理、资源面板、设备切换（~500行）
│   └── skills.js             # 已废弃（Patch11删除了技能Tab），仅1行注释
├── vendor/
│   ├── katex.min.js/css      # LaTeX 公式渲染
│   └── highlight.min.js/css  # 代码高亮
└── img/logo.jpg
```

---

## 任务 A：代码修复（优先执行）

### A1. #81 KB Action 按钮缺状态提示

**问题**：在对话 Tab 的 Action Bar 中切换到 📚"文库问答"模式时，如果文库模型未加载，点击后的反馈不够明显。此外，KB 相关操作（如上传文件到文库、KB检索）执行过程中，按钮/输入区域缺少 loading/success/error 状态反馈。

**涉及文件**：
- `static/js/chat.js` — `setActionMode()` (L458-501) 中 KB 模式切换逻辑
- `static/js/qa.js` — 文档上传、检索操作

**当前行为**：
- `setActionMode('kb')` 检查 `kbStatus.models.embedder.loaded`，未加载时弹 Toast 警告
- 但已加载状态下切换成功也没有反馈

**期望行为**：
1. 切换到 KB 模式时：如果成功，输入框 placeholder 变为 "输入问题，将自动检索文库..."（**已有**），但建议加一个短暂的 Toast 确认 "已切换到文库问答模式"
2. Action 按钮本身：点击后应有短暂的 loading 态（检查 KB 模型需要一次 API 调用）
3. KB 操作执行中：发送按钮变为禁用态 + 文案改为"检索中..."或类似

**验收标准**：
- 切换 KB 模式有明确反馈
- 操作失败有 Toast 提示（不是 alert）
- 不影响其他 action 模式（chat、doc）的切换

---

### A2. #84 前端重连后端后刷新状态

**问题**：后端重启或临时断开后，前端心跳检测（`errors.js` L264-277）能检测到并显示离线横幅。重连成功后（`retryConnect()` L228-240），只隐藏了横幅并刷新了基础状态，但没有刷新以下关键状态：
- 模型加载状态（`modelTag` 文案仍显示旧状态）
- KB 模块状态（可能需要重新加载）
- Action Bar（如果后端状态变化，action 列表可能不同）
- 纪要模块状态

**涉及文件**：
- `static/js/core/errors.js` — `retryConnect()` (L228-240)
- `static/js/chat.js` — `refreshActionBar()`, `updateChatOverlay()`
- `static/js/settings.js` — `refreshStatus()` / `refreshResourcePanel()`
- `static/js/qa.js` — `kbRouteState()`
- `static/js/minutes.js` — `minutesRouteState()`

**当前行为**：
```js
async function retryConnect() {
  var resp = await fetchWithTimeout(...+ '/api/status', {}, 3000);
  if (resp.ok) {
    hideOfflineBanner();
    showToast('服务已连接', 'success');
    if (typeof refreshStatus === 'function') await refreshStatus();
    if (typeof refreshActionBar === 'function') await refreshActionBar();
  }
}
```
可以看到只调了 `refreshStatus` 和 `refreshActionBar`，缺少 KB/Minutes 的状态刷新。

**期望行为**：
重连成功后，依次调用：
1. `refreshStatus()` — 刷新模型标签（已有）
2. `refreshActionBar()` — 刷新 Action 按钮（已有）
3. `kbRouteState()` — 刷新文库模块状态
4. `minutesRouteState()` — 刷新纪要模块状态
5. `refreshResourcePanel()` — 刷新资源面板
6. 所有调用应有 try-catch，单个模块刷新失败不影响其他模块

**验收标准**：
- 后端重启后，前端重连成功时所有 Tab 状态同步刷新
- 单个模块 API 调用失败不阻塞其他模块
- 控制台无未捕获异常

---

### A3. #82 Chat 模式任务分类 UI 移除

**问题**：Patch11 架构重构后，`task_classifier.py` 已改为后端自动调用（不再需要用户手动选择），但前端仍保留了任务分类的 Popover UI 和相关代码，包括：
- 统计栏中的分类 chip（深思/工具/快速）
- 点击 chip 弹出的分类切换 Popover
- `regenerateWithType()` 重新生成逻辑
- `variant-tag` 变体标签

**涉及文件**：
- `static/js/chat.js` — `showTypePopover()` (L231-279), `regenerateWithType()` (L281-320), `renderMsg()` 中 chip 渲染逻辑, `formatStats()` 调用
- `static/js/core/utils.js` — `formatStats()` (L237-248) 中 `taskType` 参数
- `index.html` — 检查是否有 `.task-popover` 或 `.variant-tag` 相关 HTML/CSS
- `static/css/main.css` — 搜索 `.task-popover`, `.variant-tag`, `.pop-btn`, `.chip` 等选择器并清理

**需要保留的**：
- `taskType` 作为后端返回的字段名仍存在于 API 响应中，前端可能仍在统计栏显示分类标签，但**不再可交互**
- 统计栏仍可显示后端自动判定的分类标签（只读），只是去掉手动切换功能

**期望行为**：
1. 移除 `showTypePopover()` 函数和 Popover DOM 逻辑
2. 移除 `regenerateWithType()` 函数
3. 统计栏中的分类 chip 变为纯显示（不可点击），或直接移除分类标签
4. 清理 CSS 中 `.task-popover`, `.pop-btn`, `.variant-tag` 相关样式
5. 保留后端返回的 `task_type` 字段解析（不破坏 SSE 数据处理）

**验收标准**：
- AI 回复下方的统计栏正常显示，无交互式分类 Popover
- 不影响 SSE 流式渲染和消息显示
- 清理后代码中不再有 `showTypePopover` 和 `regenerateWithType` 的定义和调用
- CSS 中无孤立的选择器

---

## 任务 B：文档补写（代码修复完成后执行）

### B1. FRONTEND_ARCHITECTURE.md（核心，必须详尽）

输出文件：`C:\tmp\桌伴-设计文档\架构设计\FRONTEND_ARCHITECTURE.md`

**必须覆盖以下内容**：

1. **模块结构图**
   ```
   index.html
   └── <script> 加载顺序（按 HTML 中的 script 标签顺序）
       ├── katex.min.js
       ├── highlight.min.js
       ├── core/api.js      → monkey-patch window.fetch
       ├── core/errors.js    → Toast/心跳/离线横幅/弹窗
       ├── core/utils.js     → Markdown/LaTeX渲染/文件卡片
       ├── chat.js           → 对话核心（最大模块）
       ├── qa.js             → 文库管理
       ├── minutes.js        → 录音纪要
       ├── settings.js       → 模型/资源管理
       └── skills.js         → 已废弃
   ```

2. **全局作用域变量表** — 列出所有 `window.xxx` 暴露的全局变量和函数，说明来源和用途
   - 例如：`API`（后端地址）、`generating`（生成中标志）、`currentChatFile`、`currentMessages`、`currentActionMode` 等

3. **4 Tab 架构**
   - Tab 切换机制：`switchTab()` 函数
   - 各 Tab 的 DOM 结构 ID 映射：`tab-chat` / `tab-qa` / `tab-minutes` / `tab-settings`
   - Tab 初始化函数：各 Tab 的路由函数（`refreshStatus` / `kbRouteState` / `minutesRouteState`）

4. **SSE 流式渲染流程**
   - EventSource 连接建立
   - 事件类型：`token` / `done` / `error` / `fold` 等
   - 增量 DOM 更新逻辑
   - Think 折叠渲染（`<details>` 标签）
   - KaTeX / Highlight.js 延迟渲染
   - 取消机制（`stopBtn` / `CancellationToken`）

5. **CSS 变量体系**
   - 主色：`--primary-*`（深蓝系）
   - 强调色：`--accent-*`（橙黄系）
   - 灰度：`--gray-*`
   - 语义色：`--bg-*` / `--text-*` / `--error-color` 等
   - 色板：`--chip-*`（分类标签）、`--think-*`（思考过程）、`--agent-*`（Agent步骤）
   - 字号：`--font-xs/sm/md/lg`
   - **新增 CSS 变量必须使用变量，禁止硬编码颜色值**

6. **状态管理**
   - 全局状态变量一览（`generating`, `currentChatFile`, `currentMessages`, `_lastMsgCount`, `_kbBusyProcessing` 等）
   - 状态同步机制：轮询（`startSessionPoll` 5s）、心跳（`startHeartbeat` 30s）、SSE 事件驱动
   - 重连恢复流程（`retryConnect` → 刷新各模块状态）

7. **错误处理策略**
   - `errors.js` 的 `ERROR_MAP` 错误码映射
   - `FRIENDLY_ERRORS` HTTP 状态码友好提示
   - `silentLog` 静默日志策略（网络错误不刷控制台）
   - Toast 通知机制：去重、排队、防重入

8. **API 调用汇总**
   - 列出前端调用的所有 API 端点、HTTP 方法、调用模块
   - 参考 `p12_API_CONTRACT.md` 中的完整 API 定义

**文档格式要求**：
- 使用 Markdown，表格化呈现变量和 API
- 每个章节有简短的 TL;DR
- 代码片段标注文件名和行号范围

---

### B2. DEPLOYMENT_GUIDE.md（前端章节）

输出文件：`C:\tmp\桌伴-设计文档\架构设计\DEPLOYMENT_GUIDE.md`（可只写前端部分，后端部分后续补充）

**前端相关内容**：
1. 浏览器兼容性要求（ES2020+、MediaRecorder API、EventSource）
2. 启动后访问地址（默认 `http://localhost:8976`）
3. 首次加载注意事项（模型未加载时对话区有遮罩）
4. Vendor 依赖说明（KaTeX、Highlight.js 的本地文件 vs CDN fallback）

---

### B3. TROUBLESHOOTING.md（前端章节）

输出文件：`C:\tmp\桌伴-设计文档\架构设计\TROUBLESHOOTING.md`（可只写前端部分）

**前端常见问题**：
1. SSE 断连白屏 → 心跳检测 → 自动/手动重连
2. 文库列表不刷新 → `kbRouteState()` 手动调用
3. KaTeX 渲染失败 → 降级为源码显示（`_renderLatex` 已有 fallback）
4. 代码高亮不生效 → `highlight.min.js` 加载失败
5. 离线横幅误报 → `pauseHeartbeat()` / `resumeHeartbeat()` 机制

---

## 重要约定

1. **CSS 变量**：所有新增样式必须使用 CSS 变量，禁止硬编码颜色值（如 `color: #333`）
2. **全局函数**：新增函数必须 `window.xxx = xxx` 暴露到全局（传统 script 模式，无模块打包）
3. **错误处理**：网络错误使用 `silentLog()` 静默处理，用户提示使用 `showToast()`
4. **API 地址**：统一使用 `apiUrl('/api/xxx')` 或 `(typeof API !== 'undefined' ? API : '') + '/api/xxx'`
5. **不使用 alert/confirm/prompt**：使用 `showToast()` 和 `showDialog()` 替代
6. **不改后端代码**：前端团队的改动范围仅限 `static/` 目录和 `index.html`，不碰 Python 文件

---

## 验收流程

### 代码修复（A1-A3）
1. 逐个修复，每个 issue 单独提交
2. 手动测试：
   - 启动后端 `start.bat`
   - 浏览器打开 `http://localhost:8976`
   - 按 issue 描述的场景逐一验证
3. 浏览器 DevTools Console 无 JS 错误

### 文档（B1-B3）
1. 文档放 `C:\tmp\桌伴-设计文档\架构设计\` 目录
2. 标注行号范围的准确性（对照实际代码验证）
3. 全局变量表完整无遗漏

---

## 关键 API 端点速查

| 端点 | 方法 | 说明 | 调用模块 |
|------|------|------|---------|
| `/api/status` | GET | 服务状态 + 模型信息 | errors.js (心跳) |
| `/api/resource-info` | GET | 内存/资源占用 | settings.js |
| `/api/chats` | GET | 对话列表 | chat.js |
| `/api/chats/new` | POST | 新建对话 | chat.js |
| `/api/chats/switch` | POST | 切换对话 | chat.js |
| `/api/chats/{name}/messages` | GET | 获取消息 | chat.js |
| `/api/chat/stream` | POST (SSE) | 流式对话 | chat.js |
| `/api/action/list` | GET | 获取 Action 列表 | chat.js |
| `/api/action/set` | POST | 设置当前 Action | chat.js |
| `/api/kb/module-status` | GET | KB 模块状态 | qa.js |
| `/api/kb/documents` | GET | 文库文档列表 | qa.js |
| `/api/kb/install-module` | POST | 安装文库模块 | qa.js |
| `/api/kb/chat/stream` | POST (SSE) | KB 流式问答 | qa.js |
| `/api/recorder/sessions` | GET | 录音会话列表 | minutes.js |
| `/api/recorder/whisper/status` | GET | Whisper 引擎状态 | minutes.js |

---

## 联系方式

有疑问随时问 slow。后端相关的设计文档已归集在 `C:\tmp\桌伴-设计文档\`，可以参考：
- `架构设计/p12_README.md` — 项目总览
- `架构设计/p12_API_CONTRACT.md` — 完整 API 定义（72 个端点）
- `架构设计/p12_DATA_ARCHITECTURE.md` — 数据目录结构
- `迁移与审计/p12-fix-plan.md` — 修复方案（含 Phase 4 即本次前端修复）
