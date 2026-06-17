# Patch10 系统架构设计与任务分解

**架构师**: 高见远 (Gao)  
**日期**: 2026-05-22  
**版本**: v1.0  
**基于**: Patch9 代码审计 + PRD_PATCH10 + Agent 预研报告

---

## 一、架构设计摘要

### 1.1 设计原则

1. **增量开发优先**: 90% 工作是修改现有文件，最小化新增文件
2. **前端无框架约束**: 纯 HTML/JS/CSS，所有 UI 变更通过 DOM 操作实现
3. **后端 FastAPI 保持**: Router 结构不变，在现有端点上扩展
4. **P0 先行**: Bug 修复和状态机简化必须先于体验优化落地
5. **数据不出机**: 删除所有云端/联网代码，不新增任何外部依赖

### 1.2 模块变更总览

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            Patch10 变更矩阵                                  │
├─────────────────┬───────────────────────────────────────────────────────────┤
│ 模块            │ 变更内容                                                   │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ Bug 修复        │ chunking_orchestrator.py:264 移除 stream=True              │
│ (P0)            │ models.py: 统一 _stop_generation 访问接口                  │
│                 │ routers/chat.py:760 改用 setter 而非直接赋值               │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 前端体验        │ main.css → CSS 变量化 + dark 主题                          │
│ (P0+P1)         │ index.html → 深色模式开关 + 代码块结构改造                 │
│                 │ chat.js → 代码块高亮/复制 + 主题切换 + 进度条 SSE          │
│                 │ settings.js → 设置面板重构 + 扩展中心 + 错误提示优化       │
│                 │ utils.js → md() 输出含语言标记的 code 标签                 │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 模型加载进度条  │ models.py → load() 插入进度回调                            │
│ (P0)            │ routers/settings.py → 新增 SSE 进度端点                    │
│                 │ chat.js/settings.js → 订阅 SSE 更新 UI                     │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 设置重构        │ routers/settings.py → 删除训练/审计/云端 UI 端点           │
│ (P0)            │ settings.js → 移除训练/参数模板/审计/云端 UI               │
│                 │ index.html → 设置面板 HTML 精简                            │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 统一扩展安装    │ routers/settings.py → 泛化 extensions/upload 支持多类型    │
│ (P0)            │ routers/settings.py → 扩展列表返回 type 字段               │
│                 │ settings.js → 扩展中心 UI（模型/KB/纪要）                  │
│                 │ index.html → Tab 动态显隐逻辑                              │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ KB 状态机简化   │ routers/kb.py → module-status 返回二态                     │
│ (P0)            │ routers/kb.py → install-module 安装后自动 load-models      │
│                 │ qa.js → 移除 activation 状态路由，二态切换                 │
│                 │ index.html → 移除 kbActivation DOM                         │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 取消 web-search │ prompts.py → 移除 web_reader/web_search 工具描述           │
│ (P0)            │ agent.py → 从 _TOOL_SKILL_MAP 移除搜索工具                 │
│                 │ 删除 skills/web_search.py（如存在）                        │
│                 │ index.html/settings.js → 移除搜索相关 UI                   │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ Agent 改进      │ prompts.py → EXEC_SYSTEM_PROMPT 强化工具调用规则           │
│ (P1)            │ prompts.py → 注入 one-shot 示例                            │
│                 │ agent.py → _is_final_answer() 早期终止检测                 │
│                 │ agent.py → 硬迭代上限 min(max_iterations, 20)              │
│                 │ agent.py → 重试计数器 + 格式错误友好提示                   │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 录音另存        │ minutes.js → 新增 saveAs() 函数 (.txt/.md/.docx)           │
│ (P1)            │ index.html → 纪要面板增加"另存为"按钮                      │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 对话文件从 KB   │ chat.js → 文件选择器改为调用 /api/kb/documents             │
│ (P1)            │ routers/chat.py → 文件上传改为存入 KB                      │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 导出功能        │ chat.js/minutes.js → exportChat() / exportMinutes()        │
│ (P1)            │ 前端直接生成 Blob 下载，无需后端 API                       │
├─────────────────┼───────────────────────────────────────────────────────────┤
│ 错误提示优化    │ static/js/core/errors.js → 错误码映射表扩展                │
│ (P1)            │ 各 JS 文件 → 统一使用 showError() 替代 alert()             │
└─────────────────┴───────────────────────────────────────────────────────────┘
```

---

## 二、文件变更清单

### 2.1 后端文件变更

| 路径 | 变更类型 | 变更内容 |
|------|----------|----------|
| `server.py` | 修改 | VERSION_PATCH 9 → 10；扩展初始化逻辑调整 |
| `models.py` | 修改 | ① 添加 `stop_requested` property（带锁）② `load()` 插入进度回调参数 ③ `chat_stream` 开头增加 `max_tokens = max_tokens or 1500` |
| `chunking_orchestrator.py` | 修改 | 第264行移除 `stream=True` 参数 |
| `prompts.py` | 修改 | ① 移除 web_reader 工具描述 ② EXEC_SYSTEM_PROMPT 强化工具调用规则 ③ 注入 one-shot 示例 ④ 移除 SEARCH_SYSTEM_PROMPT |
| `agent.py` | 修改 | ① 从 `_TOOL_SKILL_MAP` 移除 web_search/web_reader ② 添加 `_is_final_answer()` 方法 ③ 硬迭代上限 `min(max_iterations, 20)` ④ 重试计数器 + 友好错误提示 ⑤ think 标签后处理增强 |
| `routers/chat.py` | 修改 | ① 第760行 `mgr._stop_generation = False` → `mgr.stop_requested = False` ② 文件上传逻辑改为存入 KB ③ 移除 web-search 相关引用 |
| `routers/settings.py` | 修改 | ① 扩展上传接口泛化（支持 model/knowledge/whisper 类型）② 扩展列表返回 type 字段 ③ 新增 `/api/extensions/uninstall` 通用卸载 ④ 删除训练/审计相关端点（或标记废弃）⑤ 新增 `/api/load-progress` SSE 端点 ⑥ 模型加载端点接入进度回调 |
| `routers/kb.py` | 修改 | ① `module-status` 返回二态（移除 activated 中间态语义）② `install-module` 安装成功后自动调用 `load_models()` ③ 移除 `/api/kb/load-models` 前端调用需求（保留 API 兼容） |
| `routers/recorder.py` | 修改 | 扩展状态接口适配统一扩展格式 |
| `config.py` | 修改 | TTL 缓存加锁（P2 优化，顺手修复） |
| `skills/web_search.py` | 删除 | 整个文件删除（如存在） |

### 2.2 前端文件变更

| 路径 | 变更类型 | 变更内容 |
|------|----------|----------|
| `index.html` | 修改 | ① 设置面板 HTML 精简（删除训练/参数模板/审计/云端区块）② 新增深色模式开关 ③ 代码块结构改造（为 highlight.js 预留）④ 移除 kbActivation 状态 DOM ⑤ 扩展中心 HTML ⑥ 纪要"另存为"按钮 ⑦ Tab 动态显隐控制 |
| `static/css/main.css` | 修改 | ① 全部硬编码颜色改为 CSS 变量 ② 新增 `[data-theme="dark"]` 变量覆盖 ③ 代码块高亮样式 ④ 复制按钮样式 ⑤ 进度条样式 |
| `static/js/chat.js` | 修改 | ① 代码块渲染后调用高亮 ② 添加复制按钮绑定 ③ 主题切换监听 ④ SSE 进度订阅（模型加载）⑤ 文件选择器改为 KB 文档列表 ⑥ 对话导出功能 ⑦ 错误提示改用友好文案 |
| `static/js/settings.js` | 修改 | ① 设置面板初始化逻辑精简 ② 扩展中心 UI 逻辑（安装/卸载/列表）③ 资源面板保留 ④ 深色模式开关逻辑 ⑤ 模型加载进度条 UI |
| `static/js/qa.js` | 修改 | ① `kbRouteState()` 二态路由（移除 activation 状态）② 安装完成后直接显示 fullInterface |
| `static/js/minutes.js` | 修改 | ① `minutesRouteState()` 适配扩展中心 ② 纪要另存功能（.txt/.md/.docx）③ 纪要导出功能 |
| `static/js/core/utils.js` | 修改 | ① `md()` 函数代码块输出改为 `<pre><code class="language-xxx">` ② 新增 `downloadBlob()` 工具函数 |
| `static/js/core/errors.js` | 修改 | ① 错误码映射表扩展 ② `showError()` 支持 action/link 参数 |
| `static/js/core/api.js` | 修改 | 新增 SSE 连接管理（含自动重连） |

### 2.3 新增文件

| 路径 | 说明 |
|------|------|
| `static/vendor/highlight.min.js` | highlight.js 轻量版（仅含 Python/JS/Bash/JSON/Markdown） |
| `static/vendor/highlight.min.css` | highlight.js 主题样式（含 dark 适配） |

---

## 三、依赖关系图

```
T01: Bug 修复 + 基础设施
    ├── chunking_orchestrator.py (stream=True 修复)
    ├── models.py (stop 竞态修复 + 进度回调接口)
    ├── routers/chat.py (stop 赋值修复)
    └── config.py (TTL 缓存加锁)
         │
         ▼
T02: 前端基础体验 (依赖 T01)
    ├── main.css → CSS 变量 + dark 主题
    ├── index.html → 深色开关 + 代码块结构 + 设置精简
    ├── static/js/core/utils.js → md() 改造 + downloadBlob()
    ├── static/js/core/errors.js → 友好错误提示
    └── static/vendor/highlight.* → 代码高亮库
         │
         ▼
T03: 设置重构 + 扩展中心 + KB 简化 (依赖 T01, T02)
    ├── routers/settings.py → 扩展泛化 + 进度 SSE + 删除训练审计
    ├── routers/kb.py → 二态状态机 + 自动加载
    ├── routers/recorder.py → 适配扩展格式
    ├── settings.js → 扩展中心 + 资源面板 + 深色开关
    ├── qa.js → 二态路由
    ├── minutes.js → 适配扩展格式
    └── index.html → Tab 动态显隐
         │
         ▼
T04: Agent 改进 + 取消 web-search (依赖 T01)
    ├── prompts.py → 强化 prompt + one-shot + 移除搜索
    ├── agent.py → 早期终止 + 硬上限 + 重试机制
    └── skills/web_search.py → 删除
         │
         ▼
T05: 体验优化集成 (依赖 T02, T03, T04)
    ├── chat.js → 代码高亮/复制 + 进度条 + KB 文件选择 + 导出
    ├── minutes.js → 另存功能 + 导出
    ├── settings.js → 模型加载进度 UI
    └── index.html → 最终集成调整
```

---

## 四、有序任务列表

### T01: Bug 修复 + 基础设施（P0）

**目标**: 修复 Patch9 审计发现的 P0 Bug，建立后续开发的基础接口

**涉及文件**:
- `chunking_orchestrator.py` — 移除第264行 `stream=True`
- `models.py` — 添加 `stop_requested` property（getter/setter 带 `_stop_lock`）；`load()` 方法签名增加可选 `progress_callback` 参数；`chat_stream` 开头 `max_tokens = max_tokens or 1500`
- `routers/chat.py` — 第760行 `mgr._stop_generation = False` → `mgr.stop_requested = False`
- `config.py` — `_cache_lock = threading.Lock()`，保护 `_cache` 和 `_cache_time` 更新

**关键设计决策**:
- `stop_requested` 使用 property + 上下文管理器模式，确保所有访问都经过锁
- `load()` 的 `progress_callback` 签名为 `Callable[[int, str], None]`，(percent, stage)
- 保持向后兼容：`load()` 的 callback 参数有默认值 None

**验收标准**:
- [ ] chunking_orchestrator 不再传递未支持参数
- [ ] 所有 `_stop_generation` 访问通过 property
- [ ] config 缓存更新线程安全

---

### T02: 前端基础体验 — 深色模式 + 代码高亮（P0+P1）

**目标**: 建立前端主题系统和代码块渲染基础能力

**涉及文件**:
- `static/css/main.css` — 全部颜色改为 CSS 变量；定义 `:root` 和 `[data-theme="dark"]` 两套变量；新增代码块高亮样式、复制按钮样式、进度条样式
- `index.html` — 在设置面板新增"深色模式"开关（toggle）；改造代码块输出结构（为 highlight.js 预留 class）；删除训练/参数模板/审计/云端相关的 HTML 区块；新增扩展中心 HTML 占位
- `static/js/core/utils.js` — `md()` 函数代码块输出改为 `<pre><code class="language-{lang}">`；新增 `downloadBlob(content, filename, mimeType)` 工具函数
- `static/js/core/errors.js` — 扩展错误码映射表，支持 `{message, action, link}` 结构；`showError()` 支持渲染操作按钮
- `static/vendor/highlight.min.js` + `highlight.min.css` — 引入代码高亮库（仅常用语言子集）

**关键设计决策**:
- CSS 变量命名规范：`--bg-primary`, `--bg-secondary`, `--text-primary`, `--text-secondary`, `--border-color`, `--accent-color`, `--msg-user-bg`, `--msg-ai-bg`, `--code-bg`
- 深色模式切换通过 `document.documentElement.setAttribute('data-theme', 'dark')` 实现
- 主题偏好保存到 `localStorage`，页面加载时自动恢复
- highlight.js 采用轻量自定义打包（仅 Python/JS/Bash/JSON/Markdown），避免全量 1MB+

**验收标准**:
- [ ] 深色模式开关切换即时生效
- [ ] 主题偏好持久化到 localStorage
- [ ] 代码块自动识别语言并高亮
- [ ] 错误提示包含可操作指引

---

### T03: 设置重构 + 扩展中心 + KB 状态机简化（P0）

**目标**: 统一模块安装接口，简化 KB 状态机，清理未使用功能

**涉及文件**:
- `routers/settings.py` — ① 泛化 `/api/extensions/upload`：读取 manifest.type（model/knowledge/whisper），根据类型解压到不同目录（models/ / data/kb/module/ / extensions/whisper/）② `/api/extensions/list` 返回扩展列表含 `type` 字段 ③ 新增 `/api/extensions/uninstall/{ext_type}/{ext_name}` 通用卸载 ④ 删除或标记废弃训练/审计端点（前端不再调用）⑤ 新增 `/api/load-progress` SSE 端点，订阅模型加载进度 ⑥ `/api/load/{model_name}` 接入 `mgr.load(progress_callback=...)`
- `routers/kb.py` — ① `api_kb_module_status()` 返回简化：`{"installed": bool, "ready": bool}`（ready = installed && embedder loaded）② `api_kb_install_module()` 安装成功后自动调用 `kb.load_models()` ③ 保留 `/api/kb/load-models` API 但前端不再必需调用
- `routers/recorder.py` — `api_recorder_whisper_status()` 返回格式适配：`{"installed": bool, "ready": bool}` 替代三级状态
- `static/js/settings.js` — ① 删除 `loadTrainingRecords()`、`loadTemplates()`、`loadAuditLogs()` 等函数 ② 新增扩展中心逻辑：`refreshExtensions()`、`installExtension(file)`、`uninstallExtension(type, name)` ③ 保留 `refreshResourcePanel()` 和内存预算逻辑 ④ 深色模式开关事件绑定
- `static/js/qa.js` — ① `kbRouteState()` 改为二态：未安装 → onboarding；已安装 → fullInterface（移除 activation 状态）② 删除 `kbActivate()` 函数
- `static/js/minutes.js` — ① `minutesRouteState()` 改为二态：未安装 → install；已安装 → ready（移除 installed_not_loaded 状态）② 删除 `loadWhisper()` 手动加载 UI 逻辑（改为扩展中心统一安装）
- `index.html` — ① 删除训练/参数模板/审计/云端 HTML 区块 ② 新增扩展中心面板 HTML ③ 删除 kbActivation DOM ④ 删除 minutesInactive DOM ⑤ Tab 导航增加动态显隐控制（`style.display` 根据扩展安装状态切换）

**关键设计决策**:
- 扩展包 ZIP 结构统一要求 `manifest.json` 含 `type` 字段：`"type": "model" | "knowledge" | "whisper"`
- 模型扩展 ZIP：解压到 `models/` 目录，安装后自动扫描注册
- KB 扩展 ZIP：解压到 `data/kb/module/`，安装后自动调用 `load_models()`
- Whisper 扩展 ZIP：解压到 `extensions/whisper/`，保持现有逻辑
- 卸载时根据类型清理对应目录
- Tab 显隐：前端启动时调用 `/api/extensions/list`，根据已安装扩展决定显示哪些 Tab
- 未安装模块的 Tab 隐藏（而非禁用），保持界面简洁

**验收标准**:
- [ ] 上传模型 ZIP → 自动安装 → 对话 Tab 可用
- [ ] 上传 KB ZIP → 自动安装+加载 → 问答 Tab 可用
- [ ] 上传 Whisper ZIP → 自动安装 → 纪要 Tab 可用
- [ ] 卸载扩展后对应 Tab 隐藏
- [ ] KB 安装后无需手动"激活"直接可用
- [ ] 设置面板不再显示训练/参数模板/审计/云端

---

### T04: Agent 智能化改进 + 取消 web-search（P1+P0）

**目标**: 提升 Agent 工具调用准确率，删除联网搜索功能

**涉及文件**:
- `prompts.py` — ① 从 `EXEC_SYSTEM_PROMPT` 删除 `web_reader` 工具描述 ② 重写工具调用规则（强化"必须调用工具"的边界）③ 在 prompt 末尾注入 one-shot 示例（创建报告 → 调用 doc_writer → 收到结果 → 最终回复）④ 删除 `SEARCH_SYSTEM_PROMPT` 或标记废弃 ⑤ `__version__` v3.1 → v3.2
- `agent.py` — ① 从 `_TOOL_SKILL_MAP` 删除 `web_search` 和 `web_reader` ② 添加 `_is_final_answer(text: str) -> bool` 方法：检测输出是否包含工具调用标记，若无且长度>50或包含总结性词汇则判定为最终答案 ③ Agent loop 中每轮迭代后检测 `_is_final_answer()`，若成立则提前终止 ④ 硬迭代上限：`max_iterations = min(scene_config.get("max_iterations", 8), 20)` ⑤ 重试计数器：格式错误时重试，最多2次，超过后返回友好错误"抱歉，我遇到了技术问题，请重新描述您的需求" ⑥ think 标签后处理：从 think 内容中提取误放的 tool_call，自动移到正文 ⑦ `__version__` v2.0 → v2.1
- `skills/web_search.py` — 删除整个文件（如存在）
- `server.py` — VERSION_PATCH 9 → 10；检查是否还有 web_search skill 注册逻辑

**关键设计决策**:
- Prompt 强化规则（针对 8B 模型）：
  - 规则1: 用户要求创建/修改/读取文件 → 必须调用工具
  - 规则2: 用户要求运行代码 → 必须调用工具
  - 规则3: 用户要求搜索知识库 → 必须调用工具
  - 规则4: 禁止直接输出文件内容，必须通过工具操作
  - 规则5: 每次回复只能做一件事：要么调用工具，要么给出最终答案
- One-shot 示例放在 prompt 最后，格式清晰展示完整交互流程
- 早期终止保守策略：仅在确认无 `[TOOL_CALL:` 且输出较长（>50字）时终止，避免误判
- 重试机制：每次格式错误递增计数器，超过阈值后不再重试，直接返回友好错误

**验收标准**:
- [ ] Agent 工具调用成功率 ≥ 80%（测试集验证）
- [ ] think 标签内不再包含工具调用代码
- [ ] 单次请求工具调用循环 ≤ 3 次
- [ ] 格式错误自动重试 ≤ 2 次
- [ ] 无 web_search/web_reader 工具引用

---

### T05: 体验优化集成 — 进度条 + 文件选择 + 导出 + 另存（P1）

**目标**: 集成所有前端体验优化功能

**涉及文件**:
- `static/js/chat.js` — ① 消息渲染后扫描代码块，调用 `hljs.highlightElement()` ② 为每个 `<pre>` 添加复制按钮，点击后写剪贴板并显示"已复制" ③ 订阅 `/api/load-progress` SSE，更新模型加载进度条 UI ④ 文件选择器改造：`pickUnified()` 改为调用 `/api/kb/documents` 获取文档列表，用户选择后传递 doc_id 给聊天 API ⑤ 新增 `exportChat()`：将当前对话导出为 Markdown Blob 下载 ⑥ 错误提示统一改用 `showError()` 并传入 action 参数
- `static/js/minutes.js` — ① 纪要生成后显示"另存为"按钮组（.txt/.md/.docx）② `saveMinutesAs(format)` 函数：生成对应格式 Blob 并下载 ③ `.docx` 格式使用简单 HTML→Word 转换（或纯文本表格），不引入复杂库 ④ 新增 `exportMinutes()` 导出当前纪要
- `static/js/settings.js` — ① 模型加载按钮点击后显示进度条组件 ② 加载过程中按钮置灰防重复点击 ③ 加载失败显示错误原因
- `index.html` — ① 模型加载区域增加进度条 DOM ② 对话区文件选择器改为下拉列表（从 KB 获取）③ 纪要面板增加另存按钮组

**关键设计决策**:
- 代码高亮时机：在 `renderMessages()` 完成后，对 `#messages` 内所有 `pre code` 调用 `hljs.highlightElement()`
- 复制按钮实现：为每个 `<pre>` 动态插入 `<button class="code-copy-btn">复制</button>`，点击后用 Clipboard API，降级用 `document.execCommand('copy')`
- 模型加载 SSE：前端 `EventSource` 连接 `/api/load-progress?model_name=xxx`，接收 `{percent: 10, stage: "初始化"}` 事件
- KB 文件选择：前端调用 `/api/kb/documents` 获取文档列表，渲染为 `<select>` 下拉框，选中后传递 `doc_id` 而非本地文件路径
- 导出格式：
  - Markdown: 简单拼接 `# 对话记录 — {date}\n\n## 用户\n{msg}\n\n## 助手\n{msg}`
  - 纯文本: 同上，去掉 Markdown 标记
  - docx: 使用 HTML mime trick（`application/vnd.openxmlformats-officedocument.wordprocessingml.document`）或简单 ZIP 结构，不引入 docx.js 依赖（保持零新增 npm 包原则）
- 进度条阶段映射：10%"验证文件"→50%"加载权重"→90%"编译优化"→100%"完成"

**验收标准**:
- [ ] 代码块有语法高亮和复制按钮
- [ ] 点击复制后按钮变"已复制"，2秒后恢复
- [ ] 模型加载显示实时进度条
- [ ] 对话文件选择从 KB 文档列表中选择
- [ ] 对话可导出为 Markdown
- [ ] 纪要可另存为 .txt/.md/.docx
- [ ] 错误提示友好且可行动

---

## 五、技术决策 rationale

### 5.1 为什么用 CSS 变量而非 class 切换实现深色模式？

- **优势**: 一处切换全局生效，无需为每个组件维护两套 class；与纯 HTML/JS/CSS 技术栈天然契合
- **实现**: `:root` 定义浅色变量，`[data-theme="dark"]` 覆盖深色变量，JS 切换 `html[data-theme]` 属性
- **工作量**: 约需定义 10-15 个核心变量，覆盖 90% 场景

### 5.2 为什么 highlight.js 采用自定义轻量包？

- 全量 highlight.js 约 1MB+，自定义打包（仅 5 种语言）约 100KB
- 前端无构建工具，直接引入 min.js，无法 tree-shaking
- 手动从 highlightjs.org 下载常用语言子集，放入 vendor/

### 5.3 为什么扩展中心不新建 router 而改造 settings.py？

- 现有 `/api/extensions/upload` 和 `/api/extensions/list` 已在 settings.py
- 新增端点数量少（仅 uninstall 泛化 + load-progress SSE），不值得新建文件
- 保持 Router 数量稳定，符合 Patch9 拆分原则

### 5.4 为什么 KB 状态机简化后仍保留 `/api/kb/load-models` API？

- 向后兼容：避免其他调用方（如测试脚本、外部工具） breakage
- 前端不再调用即可，API 保留无害
- 符合增量开发"不破坏已有接口"原则

### 5.5 为什么 docx 导出不引入 docx.js？

- 项目原则：纯 HTML/JS/CSS，不引入 npm 包管理
- docx.js 体积大（>500KB），且需要构建工具
- 替代方案：使用 HTML mime trick 或简单 ZIP 结构生成 .docx，满足基本需求
- 若用户强烈需要完美 docx，可后续 Patch 评估引入

### 5.6 为什么 Agent 改进只做 Phase 1（A+E+C）？

- 预研报告明确推荐 Phase 1 为 Patch10 范围
- Phase 2（工具选择前置 B + 结果反馈优化 D）改动较大，需更多测试
- Phase 1 三管齐下（强化 prompt + 早期终止 + one-shot）已能解决 80% 问题

### 5.7 为什么 `_stop_generation` 用 property 而非直接全局替换？

- 代码审计显示赋值点分散在 models.py 和 routers/chat.py 多处
- property 可以在不修改所有调用方的情况下统一加锁
- 只有直接赋值的点需要改（chat.py:760 和 settings.py:546），其他读取点自动受益

---

## 六、接口变更详情

### 6.1 新增 API 端点

```
GET /api/load-progress
  功能: SSE 推送模型加载进度
  参数: ?model_name={name}
  事件: {type: "progress", percent: 10, stage: "验证文件"}
        {type: "progress", percent: 50, stage: "加载权重"}
        {type: "progress", percent: 90, stage: "编译优化"}
        {type: "done", percent: 100}
        {type: "error", message: "..."}

DELETE /api/extensions/uninstall/{ext_type}/{ext_name}
  功能: 卸载指定类型扩展
  参数: ext_type ∈ [model, knowledge, whisper]
  返回: {ok: true} | {error: "..."}
```

### 6.2 修改的 API 端点

```
POST /api/extensions/upload
  变更: 支持多类型扩展（原仅 whisper-transcriber）
  新增: 读取 manifest.type，根据类型路由到不同目录

GET /api/extensions/list
  变更: 返回扩展列表含 type 字段
  返回: {extensions: [{name, version, type, ...}]}

GET /api/kb/module-status
  变更: 简化返回
  原返回: {installed, activated, ...}
  新返回: {installed, ready, ...}  // ready = installed && models_loaded

POST /api/kb/install-module
  变更: 安装成功后自动调用 load_models()
  返回: 新增 {auto_loaded: true}

GET /api/recorder/whisper/status
  变更: 返回二态
  原返回: {status: "not_installed|installed_not_loaded|ready"}
  新返回: {installed: bool, ready: bool, ...}
```

### 6.3 废弃的 API 端点（保留但前端不再调用）

```
GET /api/training/records
POST /api/training/record
DELETE /api/training/record/{id}
GET /api/training/stats
GET /api/training/templates
GET /api/training/template/{model}
POST /api/training/template
DELETE /api/training/template/{model}
GET /api/training/export
POST /api/training/import
GET /api/audit/query
GET /api/audit/stats
DELETE /api/audit/clear
```

---

## 七、风险与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|----------|
| 深色模式 CSS 覆盖不全 | 中 | 中 | 建立 10 个核心变量，开发时双主题并行测试 |
| SSE 进度推送与前端兼容 | 低 | 中 | 测试 Chrome/Edge/Firefox，准备轮询降级 |
| Agent prompt 过长导致性能下降 | 中 | 中 | one-shot 示例精简到 3 轮以内，总 prompt < 2K 字 |
| 扩展 ZIP 安全（恶意文件） | 低 | 高 | 限制 ZIP 内文件类型，解压路径白名单，禁止执行权限 |
| KB 自动加载内存不足 | 中 | 高 | 安装前检查内存预算，不足时返回警告但允许安装（用户手动加载） |
| 代码高亮库加载失败 | 低 | 低 | onerror 处理，降级为无高亮显示 |

---

## 八、测试要点

### 8.1 单元测试（工程师自测）

- [ ] `chunking_orchestrator._call_llm()` 不再传 `stream=True`
- [ ] `mgr.stop_requested = True` 后 `mgr.stop_requested` 返回 True
- [ ] `agent._is_final_answer()` 正确识别最终答案
- [ ] `agent` 硬迭代上限生效（配置 100 → 实际 20）
- [ ] KB 安装后自动加载（mock 测试）

### 8.2 集成测试

- [ ] 完整对话流程：发送消息 → 接收回复 → 代码块高亮 → 复制按钮可用
- [ ] 深色模式切换：开关 → 即时生效 → 刷新页面 → 恢复偏好
- [ ] 模型加载进度：点击加载 → 进度条 0→100 → 按钮恢复
- [ ] 扩展安装流程：上传 ZIP → 安装 → Tab 显示 → 功能可用
- [ ] KB 二态：未安装 → 隐藏 Tab；安装 → 直接可用；卸载 → Tab 隐藏
- [ ] Agent 工具调用："创建报告" → 调用 doc_writer → 返回结果

### 8.3 回归测试

- [ ] 现有对话功能不受影响
- [ ] 现有 KB 问答功能不受影响
- [ ] 现有纪要录音功能不受影响
- [ ] 现有 Pipeline 功能不受影响
- [ ] 停止生成按钮正常工作

---

## 九、附录：CSS 变量设计令牌

```css
:root {
  --bg-primary: #ffffff;
  --bg-secondary: #f8f9fa;
  --bg-tertiary: #f0f0f0;
  --text-primary: #333333;
  --text-secondary: #666666;
  --text-muted: #999999;
  --border-color: #e5e7eb;
  --accent-color: #4f46e5;
  --accent-hover: #4338ca;
  --msg-user-bg: #eef2ff;
  --msg-user-text: #1e3a5f;
  --msg-ai-bg: #f8f9fa;
  --msg-ai-border: #e5e7eb;
  --code-bg: #f0f0f0;
  --code-text: #333333;
  --error-color: #ef4444;
  --success-color: #16a34a;
  --warning-color: #f59e0b;
}

[data-theme="dark"] {
  --bg-primary: #1a1a2e;
  --bg-secondary: #16213e;
  --bg-tertiary: #0f3460;
  --text-primary: #e0e0e0;
  --text-secondary: #b0b0b0;
  --text-muted: #808080;
  --border-color: #2a2a4a;
  --accent-color: #818cf8;
  --accent-hover: #a5b4fc;
  --msg-user-bg: #312e81;
  --msg-user-text: #e0e0ff;
  --msg-ai-bg: #1e1e3f;
  --msg-ai-border: #2a2a5a;
  --code-bg: #2d2d4a;
  --code-text: #e0e0e0;
  --error-color: #f87171;
  --success-color: #4ade80;
  --warning-color: #fbbf24;
}
```

---

*文档结束。本架构设计基于 Patch9 代码审计和 Patch10 PRD，所有变更均为增量修改，最小化新增文件。*
