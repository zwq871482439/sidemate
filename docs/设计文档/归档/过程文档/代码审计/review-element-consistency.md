# UI 元素一致性评审报告

**项目**: 桌伴 Sidemate v0.9 patch3  
**评审日期**: 2026-06-09  
**评审维度**: UI 元素一致性（CSS 变量体系、暗色模式覆盖、跨 Tab 视觉、图标体系、字号/间距/圆角）  
**评审范围**: `index.html`, `main.css`, 以及全部 13 个 JS 文件

---

## 评审摘要

| 维度 | P0 | P1 | P2 | 合计 |
|------|----|----|----|------|
| CSS 变量体系完整性 | 0 | 3 | 2 | 5 |
| 暗色模式覆盖完整性 | 1 | 4 | 3 | 8 |
| 跨 Tab 视觉一致性 | 0 | 2 | 5 | 7 |
| 图标体系一致性 | 0 | 1 | 3 | 4 |
| 字号/间距/圆角一致性 | 0 | 2 | 5 | 7 |
| **合计** | **1** | **12** | **18** | **31** |

---

## 一、CSS 变量体系完整性

### P1-01: 未定义的 CSS 变量 `--tag-local-bg` 等依赖回退值

**位置**: `main.css:772-773`

```css
.tag-local{background:var(--tag-local-bg,#e8f5e9);color:var(--tag-local-text,#2e7d32);border:1px solid var(--tag-local-border,#a5d6a7)}
.tag-cloud{background:var(--tag-cloud-bg,#fce4ec);color:var(--tag-cloud-text,#c62828);border:1px solid var(--tag-cloud-border,#ef9a9a)}
```

`--tag-local-bg`、`--tag-local-text`、`--tag-local-border`、`--tag-cloud-bg`、`--tag-cloud-text`、`--tag-cloud-border` 这 6 个变量在 `:root` 和 `[data-theme="dark"]` 中均未定义，完全依赖回退的硬编码值。虽然功能正常，但这意味着暗色模式的 `.tag-local`/`.tag-cloud` 外观实际上由硬编码的回退值控制，而非通过 `[data-theme="dark"]` 规则（后者确实存在但依赖相同的未定义变量）。

**建议**: 在 `:root` 中显式定义这些变量，在 `[data-theme="dark"]` 中覆盖。

### P1-02: 未使用的 CSS 变量 `--accent-400`、`--accent-100`、`--gray-400`

**位置**: `main.css:9-10,14`

```css
--accent-400: #deb893;   /* 未在任何规则中使用 */
--accent-100: #f5ebe0;   /* 未在任何规则中使用 */
--gray-400: #9ca3af;     /* 未在任何规则中使用 */
```

这 3 个颜色变量在 CSS 和 JS 中均未被引用。虽然它们可能是为未来扩展预留的色板，但当前版本属于死代码。

**建议**: 移除或标注为预留。

### P1-03: `--primary-200`/`--primary-50` 在暗色模式下使用亮色色板值

**位置**: `main.css:520,723`

```css
[data-theme="dark"] .agent-header{background:linear-gradient(135deg,var(--primary-700),var(--primary-500))}
/* ✅ 使用了暗色模式中会显示为新的 accent-color 相近的值 */

/* ❌ 但 .chat-sidebar-item.active 和 .chat-sidebar-new-btn:hover 在暗色模式无覆盖 */
.chat-sidebar-item.active{background:var(--primary-50);color:var(--accent-color);font-weight:500}
.chat-sidebar-new-btn:hover{background:var(--primary-50)}
```

`--primary-50` (`#e8eef5`) 和 `--primary-200` (`#c5d0e0`) 是浅色色板，在 `[data-theme="dark"]` 中未被覆盖，导致暗色模式下侧边栏激活项和新建按钮 hover 时背景异常（亮蓝灰色块出现在深色背景上）。**详见 P0-01**。

### P2-01: toast.info 重复定义

**位置**: `main.css:514,900`

```css
/* Line 514 */
.toast.info{background:var(--info-color)}

/* Line 900 */
.toast.info{background:var(--info-color);color:var(--text-on-accent,#fff)}
```

同一个选择器定义了两次，虽然值一致性尚可（line 514 缺少 `color` 属性，line 900 补全），但这种重复会导致维护混乱。

### P2-02: 部分 CSS 变量命名语义不清晰

`--accent-light`（`main.css:11`）与 `--primary-50` 相同值 `#e8eef5`。同时存在两个名称指向同一颜色不利于维护，且容易让人混淆强调色（accent）和主色（primary）的体系边界。

---

## 二、暗色模式覆盖完整性

### P0-01: 侧边栏激活项/新建按钮 hover 在暗色模式背景异常

**位置**: `main.css:728,723`

```css
.chat-sidebar-item.active{background:var(--primary-50);...}
.chat-sidebar-new-btn:hover{background:var(--primary-50)}
```

**现象**: `--primary-50` 是 `#e8eef5`（浅蓝灰），在深色背景下 `#0f172a` 的侧边栏中，点击激活的会话项会显示一块突兀的浅色背景，文字仍为 `var(--accent-color)`（暗色模式下为 `#5b8cc9`），对比度严重不足。

**修复**: 在 `[data-theme="dark"]` 中为这两个选择器添加覆盖：
```css
[data-theme="dark"] .chat-sidebar-item.active{background:var(--bg-secondary);color:var(--accent-color)}
[data-theme="dark"] .chat-sidebar-new-btn:hover{background:var(--bg-tertiary)}
```

### P1-04: 非首次聊天锁屏卡片的 SVG 插图硬编码亮色色板

**位置**: `index.html:98`

```html
<svg viewBox="0 0 64 64" fill="none">
  <rect ... stroke="#1e3a5f" stroke-width="2"/>
  ...
  <circle ... stroke="#c9976c" stroke-width="1.5"/>
  ...
</svg>
```

多个 SVG 路径使用硬编码的 `#1e3a5f`（深蓝）和 `#c9976c`（棕色），这些颜色在暗色模式下与 `var(--bg-primary: #0f172a)` 形成低对比度。虽然这些颜色定义了品牌色，但在暗色模式下应当调整为亮色版本。

### P1-05: JS 动态样式中的硬编码颜色值不响应暗色模式

**位置**: `settings.js:35,48`, `chat.js:313`, `qa.js:215-219,378`

1. **`settings.js:35`** - 可用内存颜色:
```js
availEl.style.color = avail < 1500 ? '#ef4444' : avail < 3000 ? '#f59e0b' : '#16a34a';
```
应改为 `var(--error-color)`, `var(--warning-color)`, `var(--success-color)`。

2. **`settings.js:48`** - 内存预算进度条:
```js
budgetBar.style.background = usedPct > 90 ? '#ef4444' : usedPct > 70 ? '#f59e0b' : 'var(--text-secondary)';
```
已经部分使用了 CSS 变量，但 `#ef4444` 和 `#f59e0b` 仍为硬编码。

3. **`chat.js:313`** - 上下文圆环颜色:
```js
var color = level === 'critical' ? '#dc3545' : level === 'warning' ? '#f0ad4e' : 'var(--accent-color)';
```
`#dc3545` 和 `#f0ad4e` 为硬编码。虽然 error/warning 色在亮/暗模式下差异不大，但语义上应使用 `var(--error-color)`/`var(--warning-color)`。

4. **`qa.js:215-219`** - KB 文档状态图标:
```js
var svgCheck = '<svg ... stroke="#16a34a"...';
var svgErr = '<svg ... stroke="#ef4444"...';
var svgSpin = '<svg ... stroke="#60a5fa"...';
```
这些 SVG 内联颜色为硬编码。暗色模式下 `#60a5fa` 在深色背景上尚可，但语义上应统一使用 CSS 变量。

5. **`qa.js:378`** - KB 用户消息气泡回退色:
```js
'background:var(--accent-light,#EEEDFE)'
```
回退值 `#EEEDFE` 是硬编码的紫色，与 `--accent-light: #e8eef5`（浅蓝）不一致。

### P1-06: `.attach-menu` 和 `.kb-file-popup` 的 `box-shadow` 无暗色覆盖

**位置**: `main.css:297,325`

```css
.attach-menu{...box-shadow:0 4px 12px rgba(0,0,0,.12);...}
.kb-file-popup{...box-shadow:0 4px 16px rgba(0,0,0,.15);...}
```

这两个弹出组件的阴影使用 `rgba(0,0,0,...)`，在暗色模式下黑色阴影在深色背景上几乎不可见，失去了深度感。

### P1-07: `.modal-card` 和 `.modal-overlay` 缺少暗色模式适配

**位置**: `main.css:781-782`, `index.html:451`, `errors.js:321`

```css
.modal-card{...box-shadow:0 8px 32px rgba(0,0,0,.18);...}
```

`.modal-overlay` 的 `background:rgba(0,0,0,.45)` 在两个主题中都同样适用（深色遮罩），但 `.modal-card` 的阴影在暗色模式下几乎不可见。

此外，`index.html:451` 中的 `transcriptModal` 使用硬编码 `background:rgba(0,0,0,.5)`，而 `errors.js:321` 中的自定义 `showDialog` 弹窗使用 `background:rgba(0,0,0,.45)`。

### P2-03: `--bg-hover` 变量未定义但被引用

**位置**: `main.css:672`

```css
.deletable-item:hover{background:var(--bg-hover, var(--bg-secondary));}
```

`--bg-hover` 在 `:root` 中未定义，完全依赖回退值 `var(--bg-secondary)`，语义冗余。

### P2-04: 亮色模式下 LaTeX 公式颜色缺少明确定义

**位置**: `main.css:163-168`

```css
.msg .latex-display .katex{font-size:1em}
.msg .latex-display .katex-display{margin:0}
```

KaTeX 渲染的公式颜色由 KaTeX 默认样式表控制。在暗色模式下，如果 KaTeX 默认输出黑色文字（其自身 CSS 中 `.katex{color:#000}`），则会与深色背景冲突。当前依赖 `highlight-dark.min.css` 切换，但 KaTeX 的暗色支持需要通过 `katex.min.css` 配合，需验证。

### P2-05: extension 进度条动画 `indeterminateProgress` 的 `keyframes` 定义位置不妥

**位置**: `settings.js:1414-1418`

```js
(function addKeyframes() {
  var style = document.createElement('style');
  style.textContent = '@keyframes indeterminateProgress{...}@keyframes msgSlideIn{...}@keyframes tabFadeIn{...}';
  document.head.appendChild(style);
})();
```

`@keyframes msgSlideIn` 和 `@keyframes tabFadeIn` 已在 `main.css:656,659` 中定义，此处通过 JS 重复注入。这不是暗色问题，但可能导致动画行为不一致。

---

## 三、跨 Tab 视觉一致性

### P1-08: 同功能的"导出"按钮在不同 Tab 中样式不统一

**位置**: 多处

| 位置 | 类名/选择器 | border-radius | padding | 字体 |
|------|------------|---------------|---------|------|
| 对话侧边栏 | `.chat-sidebar-export-btn` | 4px | 4px 10px | .72em |
| 对话工具栏（旧） | `.session-export-btn` | 4px | 4px 8px | .85em |
| 文库 Tab | inline style | 4px | 3px 10px | .75em |
| 纪要 Tab | `.secondary` (panel button) | 8px | 5px 14px | var(--font-sm) |

导出按钮的 border-radius 从 4px 到 8px 不等，padding 从 4px 到 14px 不等。同一个操作应当有统一的视觉表现。

### P1-09: 设置页内联 `<style>` 块与 `main.css` 定义冲突

**位置**: `index.html:522-544`

HTML 中嵌入的 `<style>` 块重新定义了 `.settings-card`、`.settings-card-title`、`.settings-row`、`.settings-btn` 等多个类，这些类在 `main.css` 中也有定义：

| 属性 | main.css | 内联 style 块 |
|------|----------|--------------|
| `.settings-card` border-radius | 10px | 12px |
| `.settings-card` padding | 14px 16px | 16px 18px |
| `.settings-card-title` font-size | 14px (无 margin-bottom) | 14px (有 margin-bottom:10px) |
| `.settings-row` font-size | var(--font-sm) | 13px |
| `.settings-row` display | flex(space-between) | flex(space-between) |
| `.settings-summary` border-bottom | 无 | 0.5px solid var(--border-color) |

两套定义同时存在，内联 `<style>` 的后加载覆盖了 main.css，导致设置页与其他页面视觉不一致。

### P2-06: 文库 Tab 操作按钮使用内联样式而非全局按钮类

**位置**: `index.html:331-332`

```html
<button onclick="kbExportSession()" style="font-size:.75em;padding:3px 10px;
  border:1px solid var(--border-color);border-radius:4px;cursor:pointer;
  background:var(--bg-primary);color:var(--text-secondary)">
  <svg>...</svg> 下载
</button>
```

应当使用 `.btn.btn-sm` + `.btn-ghost` 组合或 `.action-btn`，而非散落的内联样式。

### P2-07: Toast 样式在不同位置的 z-index 不统一

**位置**: `main.css:296,323,332,451,505`

| 元素 | z-index |
|------|---------|
| `.attach-menu` | 100 |
| `.kb-file-popup` | 200 |
| `.modal-overlay` | 200 |
| `.offline-banner` | 200 |
| `transcriptModal` (inline) | 250 |
| `.toast-container` | 350 |
| `showDialog` (errors.js) | 500 |
| `showKbInfo` (qa.js) | 500 |

z-index 缺乏统一的分层规范，200 被多个不同用途的组件共享。

### P2-08: 空状态提示在各 Tab 中风格不统一

- **对话 Tab**（`chat.js:154`）: `'<div class="empty-state">开始对话吧</div>'`
- **文库 Tab**（`index.html:337-341`）: 自定义 flex 布局 + 大图标 + 多行文本
- **纪要 Tab**（`index.html:627`）: `'<div style="color:var(--text-muted);text-align:center;padding:16px">暂无录音记录</div>'`
- **会话侧边栏**（`chat-session.js:95`）: `'<div class="chat-sidebar-empty">暂无会话</div>'`

四种不同风格的空状态提示，缺乏统一的设计模式。

### P2-09: 问答 Tab 的"提问"按钮使用硬编码样式

**位置**: `index.html:352`

```html
<button onclick="kbAsk()" style="padding:8px 16px;background:var(--accent-color);
  color:#fff;border:none;border-radius:6px;cursor:pointer">提问</button>
```

`color:#fff` 应改为 `var(--text-on-accent)`。相同功能的发送按钮（对话 Tab）使用 `.btn-send` 类。

### P2-10: 纪要 Tab 按钮使用旧式 `.panel button` 体系

**位置**: `index.html:388,445` 等

```html
<button class="primary" onclick="startRecording()">...</button>
<button class="secondary" onclick="document.getElementById('audioFileInput').click()">...</button>
```

`.panel button.primary` 和 `.panel button.secondary` 映射到与 `.btn-primary` / `.btn-ghost` 相似的样式，但经过 `.panel` 包装后增加了额外的 CSS 特异性。`minutes.js:718-732` 中动态生成的按钮也有同样的模式。

---

## 四、图标体系一致性

### P1-10: Emoji 与 SVG 混用，缺乏统一规范

**位置**: 整个代码库

当前代码库同时使用两类图标：

**SVG 体系**（`utils.js iconSvg()`）:
- `check`, `cross`, `warn`, `close`, `trash`, `doc`, `books`, `idea`, `book`, `spin`, `play`, `pause`, `write`, `think`, `stop`, `file` — 共 16 个

**Emoji 体系**（散布于 HTML/JS 中）:
- `🤖`, `🔍`, `✅`, `❌`, `⚠️`, `🔄`, `📚`, `📄`, `🌐`, `📊`, `📝`, `🔄`, `🔑`, `✏️`, `🏁`, `🔧`, `💡`, `📰`, `📦` 等 — 至少 20+ 种

**混用示例**:

| 场景 | Emoji 使用位置 | SVG 使用位置 |
|------|-------------|------------|
| 搜索 | chat.js `🔍`（Agent 搜索） | - |
| 完成/成功 | chat.js `✅`（Agent 完成） | utils.js `iconSvg('check')` |
| 错误/失败 | chat.js `❌`（错误卡片） | utils.js `iconSvg('cross')` |
| 警告 | chat.js `⚠️`（条件渲染） | utils.js `iconSvg('warn')` |
| 文档 | chat.js `📄`（doc_outline） | utils.js `iconSvg('doc')` |
| 等待/加载 | chat.js `🔄` | utils.js `iconSvg('spin')` |

部分 Emoji 在不同操作系统中渲染效果不一致（如 Windows 的 `📚` 和 macOS 的 `📚` 视觉差异大），且无法通过 `color`/`stroke` CSS 控制颜色。

### P2-11: tab 导航按钮中的 SVG 图标尺寸不统一

**位置**: `index.html:58-61`

```html
<!-- 对话 Tab -->
<svg width="15" height="15" viewBox="0 0 16 16"...>

<!-- 文库 Tab -->
<svg width="15" height="15" viewBox="0 0 16 16"...>

<!-- 纪要 Tab -->
<svg width="15" height="15" viewBox="0 0 16 16"...>

<!-- 设置 Tab -->
<svg width="15" height="15" viewBox="0 0 16 16"...>
```

所有 Tab SVG 图标都是 15x15，但其他位置的类似图标存在尺寸不一的问题：按钮内图标 14x14，消息内图标有时 12x12、有时 14x14。

### P2-12: `iconSvg` 库缺少 `globe`、`lock`、`merge`、`filter` 等常用图标

**位置**: `utils.js:12-29`

`qa.js` 中 KB 对比模式使用了 `iconSvg('lock','12')`、`iconSvg('globe','12')`、`iconSvg('merge','12')` 等图标，但 `iconSvg()` 函数中未定义这些图标：

```javascript
// qa.js:988
iconSvg('lock','12')    // 未定义，返回空字符串
iconSvg('globe','12')   // 未定义，返回空字符串
iconSvg('merge','12')   // 未定义，返回空字符串
```

当 `iconSvg()` 找不到对应图标时返回空字符串 `''`，导致对应位置缺失图标。

### P2-13: 模板字符串中的 `\uXXXX` Unicode 转义存在于代码中但实际无效

**位置**: `chat.js:85`

```js
html += '<div class="agent-timeline-summary">...' + parts.join(' \xB7 ') + '</div>'
```

`\xB7`（·）在实践中与直接使用 `·` 字符没有区别，但增加了理解成本。更重要的是 `chat.js:91-121` 中大量使用 `\uXXXX` 转义 Emoji，与直接内嵌 Emoji 的方式混合使用，缺乏一致性。

---

## 五、字号/间距/圆角一致性

### P1-11: 同层级标题字号不一致

**位置**: `main.css:270,887` vs `index.html:524`

```css
/* main.css */
.card-title{font-size:14px;font-weight:600}
.settings-card-title{font-size:14px;font-weight:600;margin-bottom:10px}

/* index.html 内联 style */
.settings-card-title{font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:10px}
```

两者字号一致（14px），但 `.card-title` 和内联 `.settings-card-title` 的 `margin-bottom` 不同（一个没有，一个有 10px）。此外，这些值未使用 CSS 字号变量（`--font-sm:13px`, `--font-md:15px`），14px 落在两个变量之间。

### P1-12: 相同类型组件的 border-radius 缺乏统一设计标记

**位置**: 多处

组件类型与 radius 值对照：

| "重要操作"按钮 | 8px | `.btn`, `.settings-btn` |
| "次要操作"按钮 | 6px | `.btn-sm`, `.btn-xs`, `.action-btn` |
| "消息气泡" | 10px | `.msg` |
| "卡片容器" | 10px/12px | `.card`(10px) vs `.settings-card`(12px) vs `.overlay-card`(12px) |
| "输入框" | 6px | `.input-area textarea`, KB 输入框 |
| "设置输入框" | 4px | cloud API 输入框 |
| "下拉菜单/弹出" | 8px | `.attach-menu`, `.kb-file-popup`, `.mode-dropdown` |

**一致性建议**：建议建立三档体系（小 4px / 中 6px / 大 8px / 特大 12px），并用 CSS 变量统一管理。

### P2-14: 设置页 `<style>` 块中重复定义了 CSS 变量体系已覆盖的规则

**位置**: `index.html:522-543`

内联 `<style>` 块中的 `.settings-row` 重新定义了 `font-size:13px`，而 `main.css:271` 中已有 `.card-row{font-size:var(--font-sm)}`（即 13px）。虽然值一致，但一处使用硬编码，一处使用变量。

### P2-15: 输入框的高度最小值不统一

- 对话 Tab textarea: `min-height:38px` + `max-height:120px`
- 文库 Tab input: 无 min-height（约为浏览器默认）
- 设置页 input: 依赖 padding 撑开
- 转写编辑 textarea: `min-height:200px`

对于同为文本输入的场景（对话 vs 文库），交互预期应为一致。

### P2-16: 进度条组件存在两套实现

**位置**: `main.css:358-359,897-898` vs `index.html:226-229,377-378`

```css
/* main.css 全局组件 */
.progress-bar{height:8px;background:var(--border-color);border-radius:4px;overflow:hidden}
.progress-fill{height:100%;background:linear-gradient(90deg,var(--accent-color),var(--accent-hover));border-radius:4px}

/* main.css 压缩进度（不同类名，相似功能） */
.compress-progress .bar{background:var(--bg-tertiary);border-radius:4px;height:5px}
```

以及 HTML 中内联的进度条（`index.html:226-229` 的 `kbInstallBar`、`index.html:377-378` 的 `whisperLoadBar`）各自有独立的内联样式实现，与全局 `.progress-bar` 组件不一致。

### P2-17: 消息区域的 `max-width` 与 KB 消息区域的宽度约束不一致

**位置**: `main.css:150`

```css
.msg{max-width:88%;...}
```

但 `#kbMessages > div` 使用的是 `max-width:100%`（`main.css:484`），文库问答消息没有 88% 的约束。这可能导致宽屏上文库消息过宽，可读性下降。

### P2-18: 章节分隔线样式不统一

**位置**: 多处

- `.drift-bar`: `border-left:3px solid var(--warning-color)`
- `.think-details`: `border-left:3px solid var(--think-color)`
- `.msg.user`: `border-right:3px solid var(--accent-color)`
- `.card-row`: 无分隔
- `.settings-row`: 无分隔
- `.modal-warning`: `border-left:3px solid var(--warning-color)`

虽然 3px 的左侧边框作为视觉强调手段在不同的上下文中被复用，但使用方向不统一（left vs right），可能造成视觉上的不一致感。

---

## 附录 A：文件引用索引

| 文件 | 路径 | 主要关注点 |
|------|------|-----------|
| HTML | `server/index.html` | 内联样式、SVG 图标、按钮体系 |
| CSS | `server/static/css/main.css` | CSS 变量体系、暗色覆盖、组件一致性 |
| JS | `chat.js` | 消息渲染、流式展示、动态 emoji |
| JS | `chat-session.js` | 侧边栏渲染 |
| JS | `chat-actions.js` | Action 按钮动态生成 |
| JS | `chat-files.js` | 文件指示器 |
| JS | `chat-export.js` | 导出 UI 文本 |
| JS | `chat-ui.js` | 漂移提示条、复制按钮 |
| JS | `qa.js` | KB 文档列表、状态图标、对比模式 |
| JS | `minutes.js` | 录音 UI、历史记录图标 |
| JS | `settings.js` | 资源面板、进度条、动态颜色 |
| JS | `stream_renderer.js` | 渲染节流（无 UI 问题） |
| JS | `core/utils.js` | `iconSvg()` 图标库、`md()` 渲染 |
| JS | `core/api.js` | 无 UI 问题 |
| JS | `core/errors.js` | Toast/Dialog 组件 |
