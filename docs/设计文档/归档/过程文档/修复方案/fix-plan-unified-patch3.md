# 桌伴 Sidemate v0.9 patch3 — 统一修复方案

> **生成日期**: 2026-06-09  
> **数据来源**: 4 份独立评审报告 + 1 份开发团队自审查报告  
> **参考设计系统**: `SIDEMATE_DESIGN_TOKENS.md`  
> **合并原则**: 去重 → 统一编号 → 按优先级排序 → 关联设计系统令牌  
> **目标**: 发版前全部修复

---

## 修复总览

| 级别 | 去重后数量 | 说明 |
|------|-----------|------|
| **P0 阻塞发版** | 7 | 安全漏洞 + 功能缺失 + 视觉崩溃 |
| **P1 重要** | 33 | 用户体验 + 代码健壮性 + 一致性 |
| **P2 建议** | 38 | 代码质量 + 细节优化 |
| **合计** | **78** | （原始 104 → 去重后 78） |

---

## P0 阻塞发版（7 个）

### FIX-001 · XSS：KB 错误事件内容未转义

| 维度 | 安全 |
|------|------|
| **来源** | 安全评审 P0-XSS-01 |
| **文件** | `qa.js:534` |
| **问题** | `kbAsk()` 中 SSE `error` 事件的 `evt.content` 未转义直接 `innerHTML`，存在 XSS 注入风险 |
| **修复方案** | `aiDiv.innerHTML = iconSvg('cross','14') + ' ' + esc(evt.content);` |
| **工作量** | 5 分钟 |
| **关联设计令牌** | 无（安全修复，不涉及视觉） |

---

### FIX-002 · DOM 引用缺失：`sourceTag` / `privacyTag` 不存在

| 维度 | 功能 |
|------|------|
| **来源** | 功能评审 P0-01 |
| **文件** | `settings.js:220-243` |
| **问题** | `getElementById('sourceTag')` 和 `getElementById('privacyTag')` 引用不存在的 DOM 元素，约 25 行状态更新逻辑成为死代码，模型来源指示功能完全失效 |
| **修复方案** | 二选一：① 在 `index.html` 设置页恢复对应 DOM 元素（推荐，模型来源是有价值的用户信息）；② 清理 `settings.js` 中 220-243 行死代码块 |
| **工作量** | 30 分钟（恢复 DOM）或 10 分钟（清理死代码） |
| **设计令牌参考** | 若恢复 DOM，使用 `--text-body-sm` 字号 + `--accent-subtle` 背景的标签样式 |

---

### FIX-003 · DOM 引用缺失：`kbUninstallBtn` 不存在

| 维度 | 功能 |
|------|------|
| **来源** | 功能评审 P1-01（升级为 P0，因功能完全失效且前次审计已标记但未修复） |
| **文件** | `qa.js:662` |
| **问题** | `kbUninstallModule()` 中 `getElementById('kbUninstallBtn')` 返回 null，函数立即退出，文库卸载功能不可用 |
| **修复方案** | 二选一：① 在 `index.html` 文库 Tab 操作栏添加卸载按钮（推荐）；② 确认卸载已移至设置页扩展管理，清理该函数 |
| **工作量** | 20 分钟 |

---

### FIX-004 · 删除会话无 Loading 反馈

| 维度 | UX |
|------|------|
| **来源** | UX 评审 P0-01 |
| **文件** | `chat-session.js:194-223`、`chat-session.js:254-283` |
| **问题** | `_sidebarDeleteChat()` 和 `deleteChat()` 发送 DELETE 请求后无任何 loading 指示，用户可能误操作或重复点击 |
| **修复方案** | 删除开始时 `showToast('正在删除...', 'info', 0)` （持续显示），完成时 `showToast('已删除', 'success', 2000)` |
| **工作量** | 15 分钟 |

---

### FIX-005 · Send/Stop 按钮切换布局抖动

| 维度 | UX |
|------|------|
| **来源** | UX 评审 P0-02 |
| **文件** | `chat.js:380-381`、`index.html:175-178` |
| **问题** | `sendBtn`/`stopBtn` 通过 `display:none/block` 切换，宽度差异导致输入栏右侧抖动 |
| **修复方案** | 将切换方式从 `display:none/block` 改为 `visibility:hidden/visible` + `position:absolute`，保持占位空间不变。或给两个按钮统一 `min-width: 64px` |
| **工作量** | 10 分钟 |

---

### FIX-006 · 启动 Loading / KB 安装进度为假动画

| 维度 | UX |
|------|------|
| **来源** | UX 评审 P0-03 + P0-04 |
| **文件** | `utils.js:87-113`、`index.html:836-882`、`qa.js:50-99` |
| **问题** | `showLoading()` 使用硬编码 8 秒 CSS 动画；`kbInstallModule()` 使用硬编码进度值（20%→40%→100%），对于 2.1GB 安装包严重误导用户 |
| **修复方案** | |
| | **启动 Loading**：在 `init()` 关键步骤完成后更新 `loadingText` 文字（"正在获取模型信息..."→"加载对话记录..."→"初始化完成"），移除固定时长动画 |
| | **KB 安装**：对接后端真实安装进度 API（SSE `/api/kb/install-progress`），如后端暂不支持，改为不确定进度条 + 阶段文字提示（"正在上传..."→"正在安装..."→"即将完成"） |
| **工作量** | 1-2 小时（取决于后端 API 现状） |
| **设计令牌参考** | 进度条使用 `--accent-default` → `--accent-hover` 渐变（参见 SIDEMATE_DESIGN_TOKENS §4 按钮） |

---

### FIX-007 · 暗色模式侧边栏激活项背景崩溃

| 维度 | 元素一致性 |
|------|-----------|
| **来源** | 元素评审 P0-01 |
| **文件** | `main.css:728,723` |
| **问题** | `.chat-sidebar-item.active` 和 `.chat-sidebar-new-btn:hover` 使用 `--primary-50: #e8eef5`（浅蓝灰），暗色模式下深色侧边栏出现刺眼亮色块 |
| **修复方案** | 在 `[data-theme="dark"]` 中添加覆盖： |
| | ```css |
| | [data-theme="dark"] .chat-sidebar-item.active { background: var(--bg-secondary); color: var(--accent-default); } |
| | [data-theme="dark"] .chat-sidebar-new-btn:hover { background: var(--bg-tertiary); } |
| | ``` |
| **工作量** | 5 分钟 |
| **关联设计令牌** | 暗色 `--bg-surface: #162031`（侧边栏底色）、`--accent-default: #d4a87c`（激活高亮） |

---

## P1 重要修复（33 个）

### 安全类（3 个）

#### FIX-008 · Action 按钮标签未前端转义
- **来源**: 安全评审 P1-XSS-01
- **文件**: `chat-actions.js:88-90`
- **问题**: `a.label` 和 `a.icon_svg` 来自后端 API，前端未转义直接 `innerHTML`
- **修复**: `btn.innerHTML = (a.icon_svg ? escHtml(a.icon_svg) : '') + ' ' + esc(a.label || a.id);`

#### FIX-009 · `unifiedInput` 接受可执行文件类型
- **来源**: 安全评审 P1-SEC-04
- **文件**: `index.html:154`
- **问题**: `accept` 属性包含 `.py/.js/.html/.css/.xml` 等脚本文件
- **修复**: 移除可执行文件类型，保持与 KB 上传一致：`accept=".txt,.md,.csv,.json,.docx,.doc,.xlsx,.xls,.pdf,.pptx,.ppt,.zip,.rar,.7z"`

#### FIX-010 · 缺少前端文件大小校验
- **来源**: 安全评审 P1-SEC-05
- **文件**: `chat-files.js:126`、`qa.js:306`
- **问题**: 上传文件无前端大小预检，依赖后端拒绝
- **修复**: 添加 `if (file.size > 50 * 1024 * 1024) { showToast('文件大小超过 50MB 限制', 'error'); return; }`

---

### 功能/逻辑类（10 个）

#### FIX-011 · `rerankerResidentChk` 不存在 → 死代码
- **来源**: 功能评审 P1-02
- **文件**: `settings.js:511-512`
- **修复**: 移除 `loadRerankerResident()` 函数及 `switchTab` 中的调用

#### FIX-012 · KB 侧 finalize 后覆盖渲染，丢失思考详情
- **来源**: 功能评审 P1-03
- **文件**: `qa.js:541-549`
- **问题**: `kbRenderer.finalize()` 已渲染最终内容，紧接着 `aiDiv.innerHTML = md(fullAnswer) + sourcesHtml` 丢掉了思考过程
- **修复**: 删除 541-549 行的额外渲染（保留 `finalize()` 的结果），或在覆盖渲染中包含 `thinkFoldShown` / `thinkText`

#### FIX-013 · Chat 侧 `agent_think` 与 `think_token` 可能竞态
- **来源**: 功能评审 P1-04
- **文件**: `chat.js:810-820`
- **修复**: 确认后端是否已废弃 `agent_think` 事件，如已废弃则清理该分支；如仍需兼容，添加互斥标记

#### FIX-014 · 文库路由注释不一致（三级 vs 二级）
- **来源**: 功能评审 P1-05
- **文件**: `index.html:200`、`qa.js:17`
- **修复**: 统一注释为"二态路由：未安装/已安装"

#### FIX-015 · 纪要引擎加载失败后路由状态不恢复
- **来源**: 功能评审 P1-06
- **文件**: `minutes.js:233-237`
- **修复**: 在 `catch` 块中添加 `minutesRouteState()` 调用

#### FIX-016 · Chat / KB 上下文指示器阈值不统一
- **来源**: 功能评审 P1-07
- **文件**: `chat.js:304`（80%）、`qa.js:640`（85%）
- **修复**: 统一为 80% critical / 60% warning

#### FIX-017 · Chat 侧上下文指示器颜色硬编码
- **来源**: 功能评审 P1-08
- **文件**: `chat.js:313`
- **修复**: 改为 `var(--error-color)` / `var(--warning-color)` / `var(--accent-color)`

#### FIX-018 · `downloadFile()` 与 `saveFileAs()` 功能重复
- **来源**: 功能评审 P1-09 + 架构评审 P2-DEAD-03
- **文件**: `utils.js:443-451`、`chat-export.js:28-36`
- **修复**: 统一为一个函数（保留 `saveFileAs`，含 `URL.revokeObjectURL` 清理），全局替换引用

#### FIX-019 · `_heartbeatTimer` 缺少 `stopHeartbeat()`
- **来源**: 架构评审 P1-ARCH-04 + 自审查 P1-08
- **文件**: `errors.js:273-289`
- **修复**: 添加 `function stopHeartbeat() { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }`，导出到 window

#### FIX-020 · `_kbBusyLastState` 跨文件隐式定义
- **来源**: 架构评审 P1-ARCH-01
- **文件**: `qa.js:677`
- **修复**: 在 `qa.js` 顶部 `var _kbBusyLastState = false;` 显式声明

---

### UX 交互类（10 个）

#### FIX-021 · 文件上传失败状态丢失
- **来源**: UX 评审 P1-01
- **文件**: `chat-files.js:131-153`
- **修复**: 上传失败时保留文件指示条，添加红色边框 + 错误图标状态

#### FIX-022 · 模式切换确认弹窗缺 loading 过渡
- **来源**: UX 评审 P1-02
- **文件**: `settings.js:976-1001`
- **修复**: `confirmModeSwitch` 开始时禁用确认按钮 + 显示"切换中..."

#### FIX-023 · KB 文档上传后无即时进度展示
- **来源**: UX 评审 P1-03
- **文件**: `qa.js:306-343`
- **修复**: 上传成功后立即插入占位卡片（带 spinner），轮询更新状态

#### FIX-024 · Tab 切换重复请求导致闪烁
- **来源**: UX 评审 P1-04
- **文件**: `index.html:817-827`
- **修复**: 缓存 Tab 状态，仅首次或手动刷新时请求

#### FIX-025 · 模型预热全局覆层无取消机制
- **来源**: UX 评审 P1-05
- **文件**: `settings.js:375-422`
- **修复**: 覆层添加"取消"按钮，调用后端取消 API
- **设计令牌参考**: 按钮使用次要链接风格（SIDEMATE §4.2），`--text-tertiary` 色

#### FIX-026 · 自定义弹窗 Escape 关闭不统一
- **来源**: UX 评审 P1-06/07
- **文件**: `qa.js:718-744`、`qa.js:932-967`、`chat.js:1108-1120`
- **修复**: 为 `showKbInfo()`、`showKbComparePrivacyDialog()`、`_showContextWarning()` 添加 Escape 键处理器；为 `transcriptModal` Escape 添加 `stopPropagation`

#### FIX-027 · 模式弹窗 ESC 监听器未及时移除
- **来源**: UX 评审 P1-08
- **文件**: `settings.js:958-968`
- **修复**: 在 `cancelModeSwitch` 中立即 `removeEventListener`

#### FIX-028 · input 禁用状态视觉弱
- **来源**: UX 评审 P1-09
- **文件**: `main.css:230-231`
- **修复**: 禁用时添加 `::placeholder { color: var(--text-tertiary); opacity: 0.5; }`

#### FIX-029 · textarea 超出无滚动提示
- **来源**: UX 评审 P1-10
- **文件**: `utils.js:65-68`
- **修复**: 当 `scrollHeight > 120` 时在 textarea 底部添加淡出渐变 overlay

#### FIX-030 · KB 问答生成中无"停止"按钮
- **来源**: UX 评审 P1-11
- **文件**: `qa.js:419-558`
- **修复**: 生成期间将"提问"按钮变为"停止"按钮，调用后端中断 API
- **设计令牌参考**: 停止按钮使用 `--color-error: #c44d4d` 暖红色

---

### 元素一致性/暗色模式类（7 个）

#### FIX-031 · CSS 6 个变量未定义（`--tag-local-bg` 等）
- **来源**: 元素评审 P1-01 + 自审查 P2-05
- **文件**: `main.css:772-773`
- **修复**: 在 `:root` 中显式定义 6 个变量，在 `[data-theme="dark"]` 中覆盖
- **设计令牌参考**: 亮色使用现有值；暗色使用 `--bg-subtle` 级别的深色底 + `--text-primary` 级别的文字

#### FIX-032 · JS 动态样式硬编码颜色（50+ 处）
- **来源**: 元素评审 P1-05 + 自审查 P1-02
- **文件**: `settings.js:35,48`、`chat.js:313`、`qa.js:215-219,378`
- **修复**: 分批替换：优先替换 `#ef4444` → `var(--error-color)`、`#16a34a` → `var(--success-color)`、`#f59e0b/#f0ad4e` → `var(--warning-color)`、`#dc3545` → `var(--error-color)`；SVG 内联色改为 `currentColor` + CSS class

#### FIX-033 · SVG 插图硬编码亮色色板
- **来源**: 元素评审 P1-04
- **文件**: `index.html:98`
- **修复**: 将 `stroke="#1e3a5f"` → `stroke="var(--illustration-primary)"`，`stroke="#c9976c"` → `stroke="var(--illustration-secondary)"`，`fill` 同理
- **设计令牌参考**: SIDEMATE_DESIGN_TOKENS §2 色彩系统 + §4.3 插画色规则

#### FIX-034 · 弹出组件 `box-shadow` 无暗色覆盖
- **来源**: 元素评审 P1-06/07
- **文件**: `main.css:297,325,781-782`
- **修复**: 暗色模式下阴影加深：`box-shadow: 0 4px 20px rgba(0,0,0,0.4)`
- **设计令牌参考**: `--shadow-overlay-dark: 0 4px 32px rgba(0, 0, 0, 0.35)`

#### FIX-035 · 跨 Tab "导出"按钮样式不统一
- **来源**: 元素评审 P1-08
- **文件**: 多处
- **修复**: 统一为 `.btn.btn-sm.btn-ghost` 组合，移除内联样式
- **设计令牌参考**: `--radius-sm: 6px` 圆角 + `--font-caption: 12px` 字号

#### FIX-036 · 设置页内联 `<style>` 与 `main.css` 冲突
- **来源**: 元素评审 P1-09
- **文件**: `index.html:522-544`
- **修复**: 将内联样式块中的差异合并到 `main.css`，删除内联块。统一 `border-radius` 为 `--radius-lg: 12px`

#### FIX-037 · Emoji 与 SVG 图标混用
- **来源**: 元素评审 P1-10
- **文件**: 全局
- **修复**: 分阶段迁移：先为 `iconSvg()` 补齐缺失图标（`lock`/`globe`/`merge`/`filter`），再将高频 Emoji（`🤖`/`✅`/`❌`/`⚠️`/`🔄`）替换为 SVG 图标调用。不建议一次性全部替换

---

### 架构/代码质量类（3 个）

#### FIX-038 · JS 加载顺序隐式依赖
- **来源**: 架构评审 P1-ARCH-07/08
- **文件**: `index.html:800-816`
- **问题**: `qa.js` 调用 `chat-ui.js` 的函数，但加载在 `chat-ui.js` 之前
- **修复**: 将 `chat-ui.js` 移到 `qa.js` 之前加载，或提取共用函数到 `core/` 目录

#### FIX-039 · Tab 键导航干扰（隐藏元素仍有 tabindex）
- **来源**: UX 评审 P1-13
- **文件**: `index.html` 全局
- **修复**: 给 `display:none` 的表单元素添加 `tabindex="-1"`；非激活 Tab 内容区的输入元素在切换时管理 tabindex

#### FIX-040 · 空状态引导缺失（侧边栏 + 纪要）
- **来源**: UX 评审 P1-15/16
- **文件**: `chat-session.js:91-97`、`minutes.js:619-627`
- **修复**: |
| | **侧边栏**: "还没有对话记录" + [新建对话] 按钮 |
| | **纪要**: "点击上方「开始录音」记录你的第一次会议" |
| | **设计令牌参考**: 使用 SIDEMATE 空状态覆层设计哲学（§1 "不冷漠"原则），`--text-secondary` 文字 + `--accent-default` 按钮色 |

---

## P2 建议优化（38 个）

### 安全/XSS 防御（4 个）

| 编号 | 问题 | 文件 | 修复 |
|------|------|------|------|
| FIX-041 | `msgCount` 数值未转义 | `chat-ui.js:78` | `esc(String(msgCount))` |
| FIX-042 | `kbAddMsg()` HTML 检测启发式不可靠 | `qa.js:384` | 统一使用 `md()` 或 `textContent` |
| FIX-043 | 动态 onclick 中 ID 未转义 | `qa.js:276-286` | 改用 `data-*` 属性 + 事件委托 |
| FIX-044 | DOMPurify 未引入 | `utils.js` | 后续版本考虑引入 |

### 暗色模式细节（6 个）

| 编号 | 问题 | 文件 | 修复 |
|------|------|------|------|
| FIX-045 | `.msg.user` 背景硬编码 `#e0eaf8` | `main.css:151` | 改为 `var(--msg-user-bg)`，暗色覆盖 |
| FIX-046 | `.msg .ts` 时间戳 `#888` | `main.css:169` | 改为 `var(--text-muted)` |
| FIX-047 | 重试按钮 hover `#dc2626` | `main.css:502` | 改为 `var(--error-color)` |
| FIX-048 | 上下文指示器 CSS 硬编码 | `main.css:795-796` | 改为 `var(--warning-color)` / `var(--error-color)` |
| FIX-049 | 删除按钮 hover `#fef2f2` | `main.css:734` | 改为 CSS 变量 |
| FIX-050 | LaTeX 公式暗色模式 | `main.css:163-168` | 验证 KaTeX 暗色支持，必要时覆盖 `.katex { color: inherit }` |

### 代码清理（8 个）

| 编号 | 问题 | 文件 | 修复 |
|------|------|------|------|
| FIX-051 | `showLoading/hideLoading` 缺 null 保护 | `utils.js:88-108` | 添加 `if (!el) return` |
| FIX-052 | `playerSeeking` 未显式声明 | `minutes.js:1263` | 顶部添加 `var playerSeeking = false;` |
| FIX-053 | `window.confirmDocOutline` 重复导出 | `chat.js:909/1149` | 保留一处 |
| FIX-054 | `updateKbLockBar()` 空函数 | `chat-ui.js:158-161` | 移除定义 + `qa.js:181` 调用 |
| FIX-055 | CSS 未使用变量（`--accent-400` 等） | `main.css:9-14` | 移除或标注预留 |
| FIX-056 | `@keyframes` 重复注入 | `settings.js:1414-1418` | 移除 JS 注入，保留 `main.css` 中的定义 |
| FIX-057 | Toast `.warning` 重复 CSS | `main.css:512,898` | 删除旧定义 |
| FIX-058 | Toast `.info` 重复 CSS | `main.css:514,900` | 合并 |

### 组件一致性（8 个）

| 编号 | 问题 | 文件 | 修复 |
|------|------|------|------|
| FIX-059 | 文库 Tab 按钮内联样式 | `index.html:331-332` | 改用 `.btn.btn-sm.btn-ghost` |
| FIX-060 | KB "提问"按钮 `color:#fff` | `index.html:352` | 改为 `var(--text-on-accent)` |
| FIX-061 | 纪要 Tab 旧式 `.panel button` | `index.html:388,445` | 统一为 `.btn` 体系 |
| FIX-062 | 空状态提示 4 种风格不统一 | 多处 | 统一为 SIDEMATE 覆层风格 |
| FIX-063 | 进度条两套实现 | 多处 | 统一使用 `.progress-bar` + `.progress-fill` |
| FIX-064 | 输入框高度不统一 | 多处 | 提取 `--input-min-height: 38px` 变量 |
| FIX-065 | 字号/圆角无设计标记 | 多处 | 建立三档圆角体系 `--radius-sm/md/lg`（与设计令牌对齐） |
| FIX-066 | 消息区域 `max-width` 不一致 | `main.css:150,484` | KB 消息添加 `max-width:88%` |

### UX 细节（8 个）

| 编号 | 问题 | 文件 | 修复 |
|------|------|------|------|
| FIX-067 | 导出 Toast 时长可缩短 | `chat-export.js:4-26` | 成功时 `showToast(..., 2000)` |
| FIX-068 | SSE 中断无重试引导 | `chat.js:476-1061` | 错误卡片添加"重新发送"按钮 |
| FIX-069 | Loading 隐藏时机过早 | `index.html:881` | 确保所有异步操作完成后再 `hideLoading()` |
| FIX-070 | 扩展安装 SSE 无超时 | `settings.js:626-753` | 添加超时机制 |
| FIX-071 | 发送按钮未输入时无 disabled | `chat.js:318-321` | `oninput` 中动态设置 `sendBtn.disabled` |
| FIX-072 | 拖拽区视觉反馈弱 | `index.html:216-218` | 添加背景色变化 |
| FIX-073 | Focus 可见性不足 | `main.css` | 添加全局 `:focus-visible` outline |
| FIX-074 | 响应式缺中间断点 | `main.css:542` | 添加 768px 断点 + `minmax` |

### 架构/性能（4 个）

| 编号 | 问题 | 文件 | 修复 |
|------|------|------|------|
| FIX-075 | 侧边栏导出竞态风险 | `chat-session.js:170-192` | 改为 `async/await` 串行化 |
| FIX-076 | 会话轮询永不销毁 | `chat-session.js:26-62` | 非 Chat Tab 时暂停轮询 |
| FIX-077 | `stream-msg` DOM 查询无缓存 | `chat.js` 约 20 处 | 缓存到局部变量 |
| FIX-078 | window 内部变量不必要暴露 | 多处 | 移除 `_lastActionIds`/`_lastMsgCount` 等全局暴露 |

---

## 设计系统对齐说明

修复过程中应遵循 `SIDEMATE_DESIGN_TOKENS.md` 的以下规范：

| 修复涉及 | 对应设计令牌 | 说明 |
|----------|-------------|------|
| 暗色模式覆盖 | §2 色彩系统（Dark Mode 列） | 所有暗色值使用令牌定义 |
| 进度条 | §4.1 按钮 — accent 渐变 | `--accent-default` → `--accent-hover` |
| 空状态 | §4.1 空状态覆层 | 插画 + 标题 + 描述 + CTA 四层结构 |
| 弹出组件 | §6 阴影层级 | `--shadow-overlay-dark` |
| 按钮体系统一 | §4.2 + §6 圆角令牌 | `--radius-sm/md/lg` |
| 插画/图标色 | §4.3 + §2 illustration 色板 | `--illustration-primary/secondary/tertiary` |
| 间距 | §5 间距体系 | 8px 基准，`--space-xs` ~ `--space-3xl` |
| z-index | §6 层级规范 | 覆层 10/11、导航 50、Toast 100、Modal 200 |

---

## 建议修复顺序

### 第一批：P0（发版前必须完成）
1. FIX-001（XSS，5 分钟）
2. FIX-007（暗色崩溃，5 分钟）
3. FIX-005（按钮抖动，10 分钟）
4. FIX-004（删除反馈，15 分钟）
5. FIX-002（sourceTag 死代码，10-30 分钟）
6. FIX-003（kbUninstallBtn，20 分钟）
7. FIX-006（假进度条，1-2 小时）

### 第二批：P1 安全 + 功能
8. FIX-008 ~ FIX-010（安全类）
9. FIX-011 ~ FIX-020（功能/逻辑类）

### 第三批：P1 UX + 元素一致性
10. FIX-021 ~ FIX-030（交互体验）
11. FIX-031 ~ FIX-040（视觉一致性 + 架构）

### 第四批：P2
12. FIX-041 ~ FIX-078 按模块分批

---

> **文档生成**: 由 5 份独立评审报告去重合并  
> **评审来源**: reviewer-security / reviewer-function / reviewer-ux / reviewer-element + 开发团队自审查  
> **设计系统**: `SIDEMATE_DESIGN_TOKENS.md`（Linear 基因 + Sidemate 品牌融合）
