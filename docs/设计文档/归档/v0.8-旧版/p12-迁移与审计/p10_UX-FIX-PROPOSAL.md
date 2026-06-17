# UX 修复方案

> 基于 UX-AUDIT-REPORT.md 的 P0→P2 问题提出具体修复方案  
> **先审阅，确认后再实施**

---

## 方案一：统一按钮体系（P0）

### 现状

```
.panel button.primary     {padding:5px 12px; border-radius:4px; font-size:.82em}
.settings-btn             {padding:5px 14px; border-radius:8px; font-size:12px}
.settings-btn-primary     {background:var(--accent-color); color:#fff; border:none}
.action-btn               {padding:4px 12px; border-radius:6px; font-size:.8em}
```

### 方案：统一为全局 `.btn` 体系

在 `main.css` 新增：

```css
/* ===== 全局按钮体系 ===== */
.btn{padding:5px 14px;border:0.5px solid var(--border-color);border-radius:8px;cursor:pointer;font-size:13px;background:var(--bg-primary);color:var(--text-primary);transition:all .15s}
.btn:hover{border-color:var(--text-muted)}
.btn-primary{background:var(--accent-color);color:#fff;border-color:var(--accent-color)}
.btn-primary:hover{background:var(--accent-hover)}
.btn-danger{color:var(--error-color);border-color:var(--error-color)}
.btn-danger:hover{background:var(--error-color);color:#fff}
.btn-ghost{background:transparent;border:none;color:var(--text-secondary)}
.btn-ghost:hover{color:var(--text-primary)}
.btn-xs{font-size:11px;padding:3px 10px}
.btn-sm{font-size:12px;padding:4px 12px}
```

### 替换范围

| 旧类 | 新类 | 影响范围 |
|------|------|---------|
| `.panel button.primary` | `.btn-primary` | 纪要 Tab "开始录音"按钮 |
| `.panel button.secondary` | `.btn` | 纪要 Tab "上传音频文件"按钮 |
| `.panel button.danger` | `.btn-danger` | （已无引用，仅保留 CSS） |
| `.settings-btn` | `.btn` | 设置 Tab 所有次要按钮 |
| `.settings-btn-primary` | `.btn-primary` | 设置 Tab 所有主要按钮 |
| `.settings-select` | 不替换（只有 select 用，保留） | — |
| `.action-btn` | `.btn` | 对话 Tab Action 栏 |
| `.action-btn.active` | `.btn-primary` | 选中的 Action |
| `.btn-send` | `.btn-primary` | 对话发送按钮 |
| `.btn-stop` | `.btn-danger` | 停止生成按钮 |
| `.session-wrap button` | `.btn-sm` | 工具栏新建/删除 |
| `.code-copy-btn` | `.btn-xs` | 代码块复制按钮 |

### 注意
- 旧类名保留作为兼容（不改 JS 中的 `class` 引用），旧类向后兼容指向新类
- 纪要 Tab 的 `.panel button` 由 `.panel` 上下文限定，改为全局 `.btn` 后需清除 `.panel` 的 button 默认样式

---

## 方案二：字号变量体系（P0）

### 方案：在 `:root` 新增 4 级字号变量

```css
/* ===== 字号体系 ===== */
--font-xs: 11px;   /* 标注/徽章/代码块复制按钮 */
--font-sm: 13px;   /* 辅助文字/按钮/卡片行 */
--font-md: 15px;   /* 标准正文/消息气泡/输入框 */
--font-lg: 18px;   /* 页面标题/Tab 按钮 */
```

### 替换策略

| 旧值 | 新变量 | 出现频率 |
|------|--------|---------|
| `.7em` ~ `.78em` / `font-size:12px` | `var(--font-xs)` | ~15 处 |
| `.82em` ~ `.85em` / `font-size:13px` | `var(--font-sm)` | ~30 处 |
| `.9em` ~ `.95em` / `font-size:14px` | `var(--font-md)` | ~25 处 |
| `1.1em` ~ `1.3em` / `font-size:18px` | `var(--font-lg)` | ~8 处 |

### 不改的
- 装饰性超大 Emoji（`font-size:2em`/`3em`）——不属于字号体系
- Markdown 渲染字号（`.md h1/h2/h3`）——语义级联，不需要变量

### 好处
- 将来调字号只需改 4 个变量
- JS 内联样式 `font-size:13px` → `font-size:var(--font-sm)` 批量替换

---

## 方案三：暗色模式全覆盖（P1）

### 覆盖清单——在 `main.css` 的 Dark 区域新增

```css
/* ===== 新增暗色覆盖 ===== */
/* Task Chip */
[data-theme="dark"] .task-chip.reasoning,
[data-theme="dark"] .task-chip.thinking{background:#1e3a5f;color:#93c5fd}
[data-theme="dark"] .task-chip.code,
[data-theme="dark"] .task-chip.fast{background:#14532d;color:#86efac}
[data-theme="dark"] .task-chip.text,
[data-theme="dark"] .task-chip.logic{background:#451a03;color:#fde68a}
[data-theme="dark"] .task-chip.agent{background:#2e1065;color:#c4b5fd}
[data-theme="dark"] .task-chip.doc{background:#4a044e;color:#f9a8d4}
/* Agent Panel */
[data-theme="dark"] .agent-header{background:linear-gradient(135deg,var(--accent-color),var(--accent-hover))}
[data-theme="dark"] .agent-step-num{background:var(--accent-color)}
[data-theme="dark"] .agent-done{color:var(--accent-color)}
[data-theme="dark"] .agent-ok{background:var(--bg-secondary);color:var(--success-color)}
[data-theme="dark"] .agent-fail{background:var(--bg-secondary);color:var(--error-color)}
/* Chunk */
[data-theme="dark"] .chunk-progress-fill{background:linear-gradient(90deg,var(--info-color),var(--accent-color))}
/* Variant */
[data-theme="dark"] .variant-tag.new{background:var(--bg-secondary);color:var(--accent-hover)}
[data-theme="dark"] .msg.superseded{border-left-color:var(--border-color)}
[data-theme="dark"] .msg.variant-new{border-left-color:var(--accent-color)}
/* Dots */
[data-theme="dark"] .thinking-indicator .dots span{background:var(--text-muted)}
/* Loading progress gradient */
[data-theme="dark"] .loading-overlay .progress-bar .fill,
[data-theme="dark"] .progress-fill{background:linear-gradient(90deg,var(--accent-color),var(--accent-hover))}
/* Disabled/Error Hover */
[data-theme="dark"] .btn-send:disabled{background:var(--bg-tertiary)}
[data-theme="dark"] .btn-stop:hover{background:var(--error-color);opacity:.8}
/* Session hover */
[data-theme="dark"] .session-wrap button:hover{background:var(--bg-secondary)}
/* Deletable item hover */
[data-theme="dark"] .deletable-item .del-btn:hover{background:var(--bg-secondary)}
/* Badge */
[data-theme="dark"] .kb-sources-header .badge{background:var(--bg-secondary)}
/* Panel danger hover */
[data-theme="dark"] .panel button.danger:hover{background:var(--error-color);opacity:.8}
/* Offline banner */
[data-theme="dark"] .offline-banner{background:var(--bg-secondary);border-bottom-color:var(--error-color);color:var(--error-color)}
[data-theme="dark"] .offline-banner .dismiss-btn{color:var(--text-muted)}
/* Theme toggle */
[data-theme="dark"] .theme-toggle-slider:before{background:var(--text-primary)}
```

**影响**：纯 CSS 新增，不动 HTML/JS，约 40 行。

---

## 方案四：亮色主题微调（P1）

### 问题
`--bg-secondary` #f8f9fa 与 `--bg-primary` #ffffff 差值太小，卡片/消息气泡区分度差  
`--accent-hover` #4338ca 与 `--accent-color` #4f46e5 对比太弱

### 方案：微调 4 个变量值

```css
/* 调整前 → 调整后 */
--bg-secondary: #f8f9fa  → #f2f4f7  /* 加深 1%，与 bg-primary 形成可见层次 */
--bg-tertiary:  #f0f0f0  → #e8eaed  /* 加深以配合 bg-secondary */
--accent-hover: #4338ca  → #3730a3  /* 加深以增强 hover 可见性 */
--msg-ai-bg:    #f8f9fa  → #f2f4f7  /* 跟随 bg-secondary */
```

**影响**：只改变量值，不动任何选择器，4 行。

---

## 方案五：卡片体系统一（P1）

### 方案
建一个全局 `.card` 类（不做大改 HTML，仅加 class）：

```css
/* ===== 通用卡片 ===== */
.card{background:var(--bg-primary);border:0.5px solid var(--border-color);border-radius:10px;padding:14px 16px;margin-bottom:12px}
.card-title{font-size:14px;font-weight:600;color:var(--text-primary);margin-bottom:10px}
```

然后 `.settings-card` 改为：

```css
.settings-card{/* 直接继承 .card 所有属性，不变 */ }
```

### 受益区域（只加 class，不改 DOM 结构）

| 区域 | 改造 |
|------|------|
| 对话 Tab 输入区 `.input-area` | 外层包 `<div class="card">` 或加 `background:var(--bg-primary)` |
| QA Tab 上传区 `#kbDropZone` | 加 `class="card"` |
| QA Tab 问答区 `#kbMessages` 容器 | 加 `class="card"` 包住 |
| 纪要 Tab 状态栏 | 已有 `<div style="background:var(--bg-secondary)">` → 改 `class="card"` |
| 纪要 Tab 录音区 | 同上 |
| 纪要 Tab 历史记录 | 加 `<div class="card">` 包装 |

**实际改动量**：`index.html` 加 ~6 个 `class="card"`，`main.css` 加 3 行 CSS。

---

## 方案六：轻量交互修复（P2）

| 修复项 | 改动 | 代码量 |
|--------|------|--------|
| `➕`/`📚` 加 tooltip | 已有 `title` 属性，无需改 | 0 行 |
| 会话记忆下拉旁加说明 | 在下拉后加 `ⓘ` span | 1 行 HTML |
| 纪要 Tab 去重（右上"释放引擎"） | 删除状态栏右侧的释放按钮，保留底部 | 删 3 行 HTML |
| `#scrollBottomBtn` 动态 bottom | JS 监听输入区高度变化 | ~5 行 JS |
| 窄屏响应 | 加 `@media(max-width:600px)` 让设置 Tab 单列 | ~3 行 CSS |

---

## 汇总

| 方案 | 优先级 | 改动文件 | 代码量 | 风险 |
|------|--------|---------|--------|------|
| ① 统一按钮体系 | P0 | main.css | +25 行，改 ~20 处 HTML class | 🟡 中等（需逐 Tab 验证） |
| ② 字号变量 | P0 | main.css + index.html + 5 个 JS | +4 行 CSS，改 ~80 处引用 | 🟢 低（纯替换） |
| ③ 暗色覆盖 | P1 | main.css 仅 dark 区块 | +40 行 | 🟢 低（纯 CSS 新增） |
| ④ 亮色微调 | P1 | main.css `:root` 区块 | 改 4 个变量值 | 🟢 低 |
| ⑤ 卡片统一 | P1 | main.css + index.html | +3 行 CSS，+6 处 HTML class | 🟢 低 |
| ⑥ 交互修复 | P2 | index.html + JS | ~10 行 | 🟢 低 |

**建议执行顺序**：②字号 → ④亮色微调 → ③暗色覆盖 → ①按钮统一 → ⑤卡片统一 → ⑥交互修复

这样先打好基础设施（变量体系），再逐步铺开视觉统一。你觉得这个顺序和方案怎么样？哪些要调？