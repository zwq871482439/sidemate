# 前端死代码 & 硬编码扫描报告

> 扫描日期：2026-05-27  
> 扫描范围：index.html + main.css + 7 个 JS 文件

---

## 一、确认的死代码（可安全删除）

### CSS

| 位置 | 内容 | 原因 |
|------|------|------|
| main.css L221 | `.img-preview{font-size:.75em;...}` | `#imgPreview` 元素已从 HTML 移除（图片上传已归档） |

### HTML 残留注释

| 位置 | 内容 | 建议 |
|------|------|------|
| index.html L87 | `<!-- (imgPreview 已移除 — 图片上传功能已归档) -->` | 删掉注释行 |

---

## 二、剩余硬编码色（3 处）

| 文件 | 行号 | 代码 | 应改为 |
|------|------|------|--------|
| `minutes.js` | 1026 | `span.style.background = '#dbeafe'` | `span.style.background = 'var(--bg-secondary)'` |
| `qa.js` | 171 | `reloadBtn.style.color = '#fff'` | 保留 — 按钮白字，语义正确 |
| `settings.js` | 340 | `btn.style.color = '#fff'` | 保留 — 按钮白字，语义正确 |

---

## 三、硬编码魔法数字（可抽为变量）

### 重复最多的模式

`(typeof API !== 'undefined' ? API : '')` 在 7 个 JS 文件中出现 **约 80 次**。

**建议**：在 `api.js` 中新增：

```js
function apiUrl(path) {
  return (typeof API !== 'undefined' ? API : '') + path;
}
```

然后全项目把 `fetch((typeof API !== 'undefined' ? API : '') + '/api/xxx')` 改为 `fetch(apiUrl('/api/xxx'))`。

**收益**：省约 1200 字符，降低 API 前缀可能的未来变更成本。

### localStorage 键名散落

| 键名 | 使用文件 | 出现次数 |
|------|---------|---------|
| `_activeTab` | index.html | 2 次 |
| `_local_ai_last_model` | settings.js | 2 次 |
| `_local_ai_last_device` | settings.js | 2 次 |
| `_recGain` | minutes.js | 2 次 |
| `kb_history_turns` | index.html | 1 次 |
| `theme` | index.html | 3 次 |

**建议**：集中在 `api.js` 定义常量 `const LS = { tab:'_activeTab', model:'_local_ai_last_model', ... }`。

**收益**：统一键名管理，避免拼写错误。

### 重复的 fetch 超时模式

每个 JS 文件都有 `fetch(api + '/xxx').catch(function(e){ console.error(...) })` 模式。

**建议**：在 `api.js` 新增 `async function apiGet(path)` 和 `async function apiPost(path, body)`。

**收益**：削减重复的 `.catch` 和错误日志代码。

---

## 四、确认的无用窗口暴露（0 处）

经逐函数核查，所有 `window.xxx = xxx` 均在其所在模块内有调用或从 onclick 触发，**无真正死窗口暴露**。

之前怀疑的 `pipelineApprove`、`showDriftBar`、`setActionMode` 等均通过 chat.js 内动态 HTML 的 onclick 调用，不是死代码。

---

## 五、可清理的 CSS 样式

| 位置 | 选择器 | 原因 |
|------|--------|------|
| main.css L | `.ocr-wrap` 块 | 已注释掉 `/* (OCR 样式已移除) */`，可删除注释块 |
| main.css L179 | `.input-area button:disabled` CSS 规则 | 旧选择器，`btn-send:disabled` 已有覆盖 |
| main.css L202 | `.panel input[type=text]` | 纪要 Tab 已无 textarea 使用场景（只剩弹窗），可简化为通用 `.panel input` |

---

## 六、建议优先级

| 优化 | 影响 | 风险 |
|------|------|------|
| 🟡 删 `.img-preview` CSS | -3 行 | 零 |
| 🟡 改 `#dbeafe` → `var(--bg-secondary)` | -1 硬编码 | 零 |
| 🟢 加 `apiUrl()` 辅助函数 | -1200 字符，+3 行 | 低（纯替换） |
| 🟢 统一 localStorage 键名 | +5 行，统一管理 | 低 |
| 🟢 删 OCR 注释代码块 | -10 行 | 零 |
