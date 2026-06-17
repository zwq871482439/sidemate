# 前端问题诊断与重构 PRD

**项目**：本地AI助手  
**文档版本**：v1.0  
**日期**：2025-07-14  
**作者**：许清楚（Xu）· 产品经理  

---

## 1. 项目信息

- **Language**：中文
- **前端技术栈**：纯原生 HTML + CSS + JavaScript（单文件 SPA）
- **项目路径**：`C:\tmp\_local-ai\`
- **核心文件**：`index.html`（5749 行：CSS 255 行 + JS 4737 行 + HTML ~757 行）
- **后端**：FastAPI，通过 `StaticFiles` serving 前端
- **运行环境**：纯内网（无外网访问），本地开发者使用

### 原始需求复述

用户报告打开前端后页面完全冻结（只显示加载遮罩，其余空白），无法操作任何按钮。经初步诊断为：后端未启动时 `init()` 中多个 `fetch` 超时挂起、CDN 资源（KaTeX）在内网不可达导致页面卡死，以及 5749 行单文件架构导致维护困难。

---

## 2. 问题清单（按严重程度排序）

### P0 — 阻断性缺陷（必须修复）

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| P0-1 | **页面卡死** | `init()` 中 5 个 `await fetch()` 串行执行，后端未启动时全部挂起，无限等待 | 用户完全无法使用前端，首屏永远停在加载遮罩 |
| P0-2 | **CDN 资源不可达** | KaTeX JS/CSS 从 `cdn.jsdelivr.net` 加载（第 9-10 行），纯内网环境请求无限挂起 | 页面阻塞在网络请求上，LaTeX 公式渲染功能无法使用 |
| P0-3 | **无超时机制** | 全文 122 处 `fetch()` 调用，除 SSE 流式读取（第 3495 行）外无任何超时或 `AbortController` | 任何网络异常都会导致 UI 无限等待，无用户反馈 |

### P1 — 严重缺陷（应该修复）

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| P1-1 | **串行初始化阻塞** | `init()` 函数中 `refreshStatus()` → `loadCloudConfig()` → `loadPermStatus()` → `loadChatList()` → `fetch('/api/chats')` 全部串行 await | 一个请求卡住全部阻塞，启动时间远超必要 |
| P1-2 | **静默错误吞没** | 全文 34 处 `catch(e) {}` 空捕获，用户看不到任何错误提示 | 用户操作失败时无任何反馈，无法排查问题 |
| P1-3 | **无离线/降级 UI** | 后端不可达时无友好的"服务未启动"提示，只显示空白加载动画 | 用户不知道发生了什么，体验极差 |

### P2 — 架构性缺陷（建议修复）

| # | 问题 | 根因 | 影响 |
|---|------|------|------|
| P2-1 | **巨型单文件** | 5749 行全部塞在一个 `index.html` 中，CSS/JS/HTML 混杂 | 无法模块化开发、无法复用、难以定位 bug、代码审查困难 |
| P2-2 | **无构建工具** | 无 bundler/build step，所有代码裸写 | 无法使用 ES Module、TypeScript、代码分割、tree-shaking |
| P2-3 | **全局状态污染** | 大量全局变量（`currentChatFile`、`currentMessages`、`isCloudMode`、`cloudModelName`、`_overrideTaskType` 等）散落在全局作用域 | 状态难以追踪、容易产生竞态条件、不利于维护 |

---

## 3. 用户故事

### 核心场景

1. **作为本地开发者**，我希望打开前端后 3 秒内能看到可用界面（即使后端未启动），以便我知道系统当前状态而不是面对空白页面。

2. **作为本地开发者**，我希望后端未启动时前端显示明确的"服务未连接"提示，并提供重试按钮，以便我能快速判断问题所在。

3. **作为本地开发者**，我希望前端所有网络请求都有合理的超时（5-10 秒）并在失败时给出用户友好的错误提示，以便我不会面对无限等待。

4. **作为本地开发者**，我希望 LaTeX 公式能在内网环境下正常渲染（不依赖外网 CDN），以便 AI 回复中的数学公式能正确显示。

5. **作为维护者**，我希望前端代码按功能模块拆分（对话、知识库、设置、纪要等），以便我能快速定位和修改特定功能的代码。

---

## 4. 需求池

### P0 — 必须实现

| ID | 需求 | 验收标准 |
|----|------|----------|
| REQ-01 | **移除 CDN 依赖** | KaTeX 的 JS 和 CSS 改为本地内联或本地文件引入；页面在外网断开时仍可正常加载和渲染 LaTeX |
| REQ-02 | **init() 超时保护** | `init()` 中每个 fetch 请求设置 5-10 秒超时；任一请求超时不阻塞后续初始化；超时后显示降级 UI |
| REQ-03 | **全局 fetch 超时封装** | 封装统一的 `fetchWithTimeout(url, options, timeout)` 工具函数；替换所有非流式 fetch 调用；默认超时 10 秒 |
| REQ-04 | **离线降级 UI** | 后端不可达时：隐藏加载遮罩、显示"服务未连接"横幅（含重试按钮）、允许切换 Tab 查看非网络依赖的设置 |

### P1 — 应该实现

| ID | 需求 | 验收标准 |
|----|------|----------|
| REQ-05 | **并行初始化** | `init()` 中无依赖关系的请求（`refreshStatus`、`loadCloudConfig`、`loadPermStatus`）改为 `Promise.allSettled()` 并行执行；仅 `loadChatList` 在状态初始化后执行 |
| REQ-06 | **统一错误提示** | 所有 fetch 失败通过统一的 toast/横幅通知用户；替换所有 `catch(e) {}` 空捕获；错误信息包含可操作的建议（如"请检查服务是否启动"） |
| REQ-07 | **加载状态区分** | 区分"首次加载"和"刷新"两种状态；首次加载失败显示降级 UI；刷新失败显示临时 toast，不阻塞现有内容 |

### P2 — 建议实现

| ID | 需求 | 验收标准 |
|----|------|----------|
| REQ-08 | **代码模块化拆分** | 将 JS 拆分为功能模块：`api.js`（网络层）、`chat.js`（对话 Tab）、`qa.js`（知识库 Tab）、`settings.js`（设置 Tab）、`minutes.js`（纪要 Tab）、`utils.js`（工具函数）；HTML 保持单入口 |
| REQ-09 | **构建工具引入** | 引入 Vite 或 esbuild 作为构建工具；支持 ES Module 和代码分割；构建产物仍为单个可 serving 的 HTML/JS |
| REQ-10 | **状态管理集中** | 将全局变量收敛到统一的状态对象（如 `AppState`）；减少跨模块状态耦合 |

---

## 5. 非功能需求

### 5.1 性能

| 指标 | 目标 |
|------|------|
| 首屏可交互时间（后端正常） | ≤ 2 秒 |
| 首屏可交互时间（后端未启动） | ≤ 3 秒（显示降级 UI） |
| 页面文件总大小 | ≤ 200 KB（gzip 后） |
| fetch 超时默认值 | 10 秒（可配置） |

### 5.2 可用性

| 指标 | 目标 |
|------|------|
| 后端不可达时 | 显示明确的"服务未连接"提示 + 重试按钮 |
| 网络请求失败时 | 所有失败都有用户可见的错误提示 |
| LaTeX 渲染 | 内网环境下正常工作，KaTeX 加载失败时公式以源码显示（不阻塞页面） |

### 5.3 可维护性

| 指标 | 目标 |
|------|------|
| 单文件行数 | 拆分后每个模块 ≤ 500 行 |
| 外部依赖 | 零外网 CDN 依赖 |
| 代码规范 | 统一的错误处理模式、统一的 fetch 封装 |

---

## 6. 约束条件

1. **纯内网环境**：所有资源必须本地化，不能依赖任何外部 CDN（包括 `cdn.jsdelivr.net`）
2. **后端集成方式不变**：继续通过 FastAPI `StaticFiles` serving 前端静态文件
3. **SPA 架构不变**：6 个 Tab（对话、问答、纪要、记忆、技能、设置）的交互方式保持一致
4. **向后兼容**：所有现有功能（对话、知识库问答、纪要、OCR、训练等）不得因重构而丢失或降级
5. **KaTeX 功能保留**：LaTeX 公式渲染必须继续支持，但改为本地化引入
6. **渐进式改进**：优先修复 P0 阻断问题，架构重构可分阶段进行

---

## 7. 技术要点（供架构师参考）

### 7.1 CDN 依赖清单

```
第 9 行:  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.css">
第 10 行: <script src="https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/katex.min.js"></script>
```

**处理方案**：将 katex.min.js 和 katex.min.css 下载到本地 `static/` 目录，改为相对路径引入，并添加 `onerror` 降级处理。

### 7.2 init() 函数依赖关系

```
refreshStatus() ──→ 设置模型标签、设备选择器、环境表
    ├── loadCloudConfig() ──→ 无硬依赖，可并行
    ├── loadPermStatus() ──→ 无硬依赖，可并行
    └── loadChatList() ──→ 依赖 refreshStatus 结果中的 currentChatFile

fetch('/api/chats') ──→ 依赖 currentChatFile（来自 loadChatList）
fetch('/api/chats/{name}/messages') ──→ 依赖上一步结果
```

**优化方案**：
```js
// 并行阶段：无依赖的请求同时发起
const [statusResult, cloudResult, permResult] = await Promise.allSettled([
  refreshStatus(),
  loadCloudConfig(),
  loadPermStatus()
]);
// 串行阶段：依赖前面的结果
await loadChatList();
await loadCurrentChatMessages();
startSessionPoll();
```

### 7.3 fetch 调用分布

| 功能区域 | fetch 调用数 | 超时处理 |
|----------|-------------|----------|
| 模型管理（设置 Tab） | ~12 | ❌ 无 |
| 对话/Session | ~15 | ❌ 无（仅 SSE 流有 60s 读取超时） |
| 知识库（问答 Tab） | ~25 | ❌ 无 |
| 纪要（录音/转写） | ~10 | ❌ 无 |
| 训练/技能/其他 | ~20 | ❌ 无 |
| OCR/文件上传 | ~5 | ❌ 无 |
| 初始化 | ~8 | ❌ 无 |
| **总计** | **122** | **仅 1 处有超时** |

### 7.4 全局变量清单（部分）

```js
let currentChatFile = '';      // 当前对话文件
let currentMessages = [];       // 当前对话消息
let isCloudMode = false;        // 云端模式开关
let cloudModelName = '';        // 云端模型名
let currentScene = 'chat';      // 场景模式
let generating = false;         // 生成中标志
let abortCtrl = null;           // 中断控制器
let _overrideTaskType = '';     // 分类覆盖
let _maxPromptTokens = 0;       // Token 上限
let _lastMsgCount = 0;          // 消息计数
let _sessionPollTimer = null;   // 轮询定时器
```

---

## 8. 待确认问题

| # | 问题 | 影响范围 | 建议 |
|---|------|----------|------|
| Q1 | KaTeX 本地化后文件大小增加约 300KB（js + css + fonts），是否接受？ | 前端包体积 | 建议接受，内网环境磁盘空间充裕 |
| Q2 | 是否需要保留 KaTeX fonts（woff2）？LaTeX 公式使用的频率如何？ | CDN 替代方案 | 如果不常用，可仅引入 JS，跳过字体（使用系统字体渲染） |
| Q3 | P2 架构重构（模块化拆分 + 构建工具）的优先级？是否纳入本次迭代？ | 项目排期 | 建议先修复 P0/P1，P2 作为下一迭代 |
| Q4 | `init()` 中 `refreshStatus()` 内部还有嵌套的 `fetch('/api/status')`、`fetch('/api/devices')`、`fetch('/api/info')`、`fetch('/api/env/check')` 共 5 个串行请求，是否也需并行化？ | 性能优化范围 | 建议一并优化，这些请求之间无强依赖 |
| Q5 | 后端是否已配置 `StaticFiles` 支持子目录（如 `static/js/`）？ | 模块化拆分可行性 | 需确认 FastAPI 的 static mount 路径配置 |
| Q6 | 错误提示的 UI 形式偏好？Toast 通知 vs 顶部横幅 vs 内联错误？ | UI 设计 | 建议使用顶部横幅（持久显示）+ Toast（临时通知）组合 |

---

## 9. 推荐实施顺序

```
Phase 1（紧急修复，预计 1-2 天）：
├── REQ-01: 移除 CDN 依赖 → KaTeX 本地化
├── REQ-02: init() 超时保护 → 每个请求加 AbortController
├── REQ-03: 全局 fetch 超时封装 → fetchWithTimeout 工具函数
└── REQ-04: 离线降级 UI → "服务未连接" 横幅 + 重试

Phase 2（体验优化，预计 2-3 天）：
├── REQ-05: 并行初始化 → Promise.allSettled
├── REQ-06: 统一错误提示 → Toast/横幅通知
└── REQ-07: 加载状态区分 → 区分首次/刷新

Phase 3（架构优化，下一迭代）：
├── REQ-08: 代码模块化拆分
├── REQ-09: 构建工具引入
└── REQ-10: 状态管理集中
```
