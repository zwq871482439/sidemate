# 前端 UI/UX 审计报告

**项目**: 桌伴 Sidemate v0.9 patch3  
**审计日期**: 2026-06-09  
**审计范围**: `C:\tmp\_Sidemate_0.9_patch3\server\` 下全部前端代码  
**审计文件**: `index.html` + `static/css/main.css` + 13 个 JS 文件  
**审计维度**: CSS变量/配色、DOM引用完整性、UX问题、事件绑定、空函数/死代码、安全  

---

## 审计摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| **P0 (阻塞)** | 2 | 安全漏洞，需立即修复 |
| **P1 (重要)** | 11 | 影响用户体验或代码健壮性 |
| **P2 (建议)** | 9 | 代码质量改进 |
| **合计** | **22** | |

---

## 一、CSS 变量与配色

### 1.1 变量体系评估

**优点**:
- `:root` 和 `[data-theme="dark"]` 覆盖完整，暗色主题覆盖了所有语义变量
- 色板分层清晰：primary(蓝) + accent(橙) + gray(中性) + 语义色
- 字号体系统一 (`--font-xs/sm/md/lg`)
- chip 语义色板（reasoning/code/text/agent/doc）设计合理

**缺陷**:

#### [P1-01] CSS 中硬编码颜色未走变量
**文件**: `main.css`  
**位置**:
- `:151` — `.msg.user{ background:#e0eaf8 }` — 用户消息气泡背景硬编码，暗色模式下不会变化
- `:169` — `.msg .ts{ color:#888 }` — 时间戳颜色硬编码
- `:502` — `.retry-btn:hover{ background:#dc2626 }` — 重试按钮悬停色
- `:795` — `.level-warning .context-ring-pct{ color:#f0ad4e }`
- `:796` — `.level-critical .context-ring-pct{ color:#dc3545 }`
- `:769` — `.tag-local{ background:#e8f5e9; color:#2e7d32; border-color:#a5d6a7 }`
- `:770` — `.tag-cloud{ background:#fce4ec; color:#c62828; border-color:#ef9a9a }`
- `:734` — `.si-delete:hover{ background:#fef2f2 }`

**影响**: 暗色模式下部分元素颜色不跟随主题切换，视觉不协调  
**建议**: 将以上硬编码值提取为 CSS 变量，并在 `[data-theme="dark"]` 中覆盖

#### [P1-02] JS 中大量硬编码颜色值
**文件**: `utils.js`, `settings.js`, `minutes.js`, `qa.js`, `chat.js`  
**位置**: 50+ 处使用硬编码 hex 颜色（如 `#16a34a`, `#ef4444`, `#f59e0b`, `#60a5fa`, `#4caf50`, `#f44336`, `#dc3545`, `#f0ad4e`）  
**典型**:
- `utils.js:13-27` — `iconSvg()` 中 check/cross/warn/stop 图标使用 `#16a34a`, `#ef4444`, `#f59e0b`
- `settings.js:35` — `availEl.style.color = avail < 1500 ? '#ef4444' : '#f59e0b' : '#16a34a'`
- `minutes.js:655-681` — 转写状态 SVG 图标全部硬编码
- `qa.js:215-220` — 状态图标 SVG 硬编码
- `chat.js:313` — `level === 'critical' ? '#dc3545' : '#f0ad4e'`

**影响**: 暗色主题下这些颜色可能与背景对比度不足，且无法统一调整  
**建议**: 将颜色值提取为 CSS 变量（如 `--icon-success`, `--icon-error`），JS 中通过 `getComputedStyle` 获取或使用 `currentColor` + CSS class

#### [P2-01] `--accent-light` 变量值与 `--primary-50` 重复
**文件**: `main.css:11`  
```css
--accent-light: #e8eef5;  /* 与 --primary-50 完全相同 */
```
**建议**: 澄清语义，如果是有意为之可保留但添加注释

#### [P2-02] 部分语义变量未定义完整 fallback
**文件**: `main.css`  
`--text-muted: #6b7280` 和 `--msg-ai-bg: #f3f2ed` 直接使用 hex 而非引用 gray 变量  
**建议**: `--text-muted: var(--gray-400)` 或保持现状但添加注释说明

---

## 二、DOM 引用完整性

### 2.1 getElementById 引用统计

JS 中共发现 **180+ 处** `getElementById` 调用，引用约 **120 个唯一 ID**。  
HTML 中定义约 **130+ 个** ID 元素。

#### [P1-03] 潜在空引用：`showLoading()` 无 null 检查
**文件**: `utils.js:88-99`  
```javascript
function showLoading(text, showProgress) {
  document.getElementById('loadingText').textContent = text || '加载中...';
  var bar = document.getElementById('loadingProgress');
  // ... 未检查 null
  document.getElementById('loadingOverlay').style.display = 'flex';
}
```
**影响**: 若 `loadingOverlay` 不存在（如 DOM 结构变更），直接抛异常  
**建议**: 与 `showModuleLoading()` 一致，添加 `if (!overlay) return` 保护

#### [P1-04] `hideLoading()` 同样缺少 null 保护
**文件**: `utils.js:105-108`  
```javascript
function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';
  document.getElementById('loadingProgress').style.display = 'none';
}
```
**建议**: 添加 `var el = document.getElementById('...'); if (el) el.style...` 模式

#### [P2-03] `_restoreChatUI()` 中部分元素 ID 可能为空
**文件**: `chat-ui.js:6-17`  
已有 if 保护（`if (btn) {...}`），处理良好。无需修改。

#### [P2-04] `chat.js` 中 `stream-msg` 引用极高频
**文件**: `chat.js` — 约 20 处 `getElementById('stream-msg')`  
每次 SSE 事件处理都重新查找 DOM，无缓存。  
**建议**: 考虑在发送消息时缓存到局部变量，减少 DOM 查询开销

---

## 三、UX 问题

#### [P1-05] 消息气泡 `.msg.user` 暗色模式下颜色不正确
**文件**: `main.css:151`  
```css
.msg.user{ background: #e0eaf8; } /* 硬编码，暗色模式下应为 --msg-user-bg */
```
**影响**: 暗色主题下用户气泡仍为浅蓝色，与深色背景对比过强  
**建议**: 改为 `background: var(--msg-user-bg)`

#### [P1-06] 时间戳 `.msg .ts` 颜色暗色模式对比度不足
**文件**: `main.css:169`  
```css
.msg .ts{ color: #888; }
```
**影响**: 暗色背景上 `#888` 对比度约 3.5:1，勉强达标但不理想  
**建议**: 改为 `color: var(--text-muted)`

#### [P2-05] 模式标签 `.tag-local` / `.tag-cloud` 暗色模式无覆盖
**文件**: `main.css:769-770`  
硬编码的浅色背景（`#e8f5e9`, `#fce4ec`）在暗色主题下过亮  
**建议**: 添加 `[data-theme="dark"]` 覆盖

#### [P2-06] 上下文使用量指示器颜色硬编码
**文件**: `main.css:795-796`  
```css
.level-warning .context-ring-pct{ color: #f0ad4e; }
.level-critical .context-ring-pct{ color: #dc3545; }
```
**建议**: 使用 `var(--warning-color)` / `var(--error-color)`

#### [P2-07] Toast `.warning` 颜色定义存在冲突
**文件**: `main.css`  
- `:512` — `.toast.warning{ color:#1a1a1a }` (旧定义)  
- `:898` — `.toast.warning{ color:#fff }` (新定义)  
同一选择器在文件中出现两次，后者覆盖前者。可能导致维护困惑。  
**建议**: 删除 `:512` 的旧定义，保留 `:898`

---

## 四、事件绑定

### 4.1 事件函数引用完整性

HTML 中 `onclick` 绑定的函数全部在 JS 中找到实现：

| HTML onclick | JS 定义位置 | 状态 |
|---|---|---|
| `switchTab()` | index.html 内联 script | OK |
| `retryConnect()` | errors.js:228 | OK |
| `newChat()` | chat-session.js | OK |
| `deleteChat()` | chat-session.js | OK |
| `sendMessage()` | chat.js | OK |
| `stopGeneration()` | chat.js | OK |
| `toggleAttachMenu()` | chat-files.js | OK |
| `scrollToBottom()` | chat-ui.js:164 | OK |
| `copyCode()` | utils.js:471 | OK |
| `selectMode()` | settings.js | OK |
| `confirmModeSwitch()` | settings.js | OK |
| `cancelModeSwitch()` | settings.js | OK |
| `kbTogglePanel()` | qa.js | OK |

#### [P1-07] EventSource 未在所有错误路径关闭
**文件**: `settings.js:678-733`  
```javascript
var es = new EventSource(_apiBase + '/api/extensions/install-progress/' + taskId);
es.addEventListener('progress', function(e) { ... });
es.addEventListener('done', function(e) { es.close(); ... });
es.addEventListener('error', function(e) { es.close(); });
```
**分析**: 已有 `done` 和 `error` 事件处理器中调用 `es.close()`。但 `error` 事件的语义是连接错误，EventSource 会自动重连，调用 `close()` 可阻止重连——此处处理正确。  
**结论**: 无问题，处理良好。

#### [P1-08] `_heartbeatTimer` 无清理机制
**文件**: `errors.js:253-289`  
```javascript
var _heartbeatTimer = null;
function startHeartbeat() {
  if (_heartbeatTimer) return;
  _heartbeatTimer = setInterval(async function() { ... }, 30000);
}
```
**影响**: 一旦启动，心跳检测永远不会停止（只有暂停/恢复）。对于单页应用这是可接受的，但切换 Tab 时持续消耗网络。  
**建议**: 在页面 `visibilitychange` 时暂停心跳（已有此逻辑用于其他轮询），或在长时间不活跃时清理

#### [P1-09] `_sessionPollTimer` 无清理逻辑
**文件**: `chat-session.js:26-62`  
```javascript
_sessionPollTimer = setInterval(async function() { ... }, 5000);
```
**影响**: 一旦启动，5 秒轮询永不停歇。虽有 `visibilityState` 检查跳过不可见时，但定时器本身一直运行。  
**建议**: 添加 `stopSessionPoll()` 函数，在删除会话或切换到非 Chat Tab 时清理

---

## 五、空函数 / 死代码

#### [P2-08] `skills.js` 为废弃文件，仍被加载
**文件**: `skills.js:1-3` (3行注释) + `index.html:807`  
```html
<script src="/static/js/skills.js?v=2.5"></script>
```
```javascript
// skills.js — 已废弃，功能合并到 settings.js
// Patch11: 技能 Tab 已删除，能力管理移入设置 Tab
```
**影响**: 产生一次无意义的 HTTP 请求（虽然是本地缓存），增加代码库理解负担  
**建议**: 删除 `skills.js` 文件并在 `index.html` 中移除对应的 `<script>` 标签

#### [P2-09] `updateKbLockBar()` 空函数体
**文件**: `chat-ui.js:158-161`  
```javascript
function updateKbLockBar() {
  // KB 处理中锁定（由 qa.js 调用）
  // 空实现保留兼容，实际在 qa.js 中处理
}
```
**影响**: 通过 `window.updateKbLockBar` 暴露到全局，qa.js 可能调用但实际无效果  
**建议**: 确认 qa.js 中是否还有调用点，若无则清理

#### [P2-10] `downloadFile()` 与 `saveFileAs()` 功能重复
**文件**: `utils.js:443-451` (downloadFile) + `chat-export.js` (saveFileAs)  
两个函数功能几乎相同（创建 `<a>` 触发下载），且都被 `renderFileCard()` 引用  
**建议**: 统一为一个函数

---

## 六、安全审计

### 6.1 XSS 风险

#### [P0-01] `_mdFallback()` 行内代码未转义（XSS 漏洞）
**文件**: `utils.js:369`  
```javascript
text = text.replace(/`([^`\n]+)`/g, '<code>$1</code>');
```
**影响**: 当 `marked.js` 未加载时（降级路径），行内代码内容 **直接插入 HTML** 而未经 `esc()` 转义。攻击者构造 `\`<img src=x onerror=alert(1)>\`` 格式的消息即可触发 XSS。  
**严重性**: **P0** — 虽然 marked.js 通常会加载，但降级路径是真实存在的攻击面  
**建议**: 改为 `'<code>' + esc('$1') + '</code>'`，由于 replace 的 `$1` 无法直接在函数中转义，需改为 function callback：
```javascript
text = text.replace(/`([^`\n]+)`/g, function(_, code) {
  return '<code>' + esc(code) + '</code>';
});
```

#### [P0-02] `_mdFallback()` 链接 href 未转义（XSS 漏洞）
**文件**: `utils.js:388`  
```javascript
text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
```
**影响**: URL 部分 `$2` 直接插入 `href` 属性，未经 `escAttr()` 转义。可构造 `[click](javascript:alert(1))` 触发 XSS，或 `[click](" onclick="alert(1)")` 注入属性。  
**严重性**: **P0** — 降级路径中的 XSS 漏洞  
**建议**: 改为 function callback 并过滤 `javascript:` 协议：
```javascript
text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function(_, text, url) {
  if (/^javascript:/i.test(url.trim())) return esc(text);
  return '<a href="' + escAttr(url) + '" target="_blank">' + esc(text) + '</a>';
});
```

#### [P1-10] `md()` 函数使用 marked.js 但未启用 sanitize
**文件**: `utils.js:246-251`  
```javascript
var options = {
  renderer: renderer,
  gfm: true,
  breaks: true,
  pedantic: false
  // 未设置 sanitize: true 或使用 DOMPurify
};
```
**影响**: marked.js v5+ 已移除内置 `sanitize` 选项。当前配置下，若后端返回的 AI 消息包含原始 HTML，会直接渲染。  
**缓解因素**: 
- 后端为本地离线服务，消息来源可信（本地 AI 模型生成）
- 代码块已通过 `esc(code)` 转义
- heading 中已使用 `escAttr(slug)` 处理锚点 ID
- `showDialog()` 中 title/message 使用了 `esc()` 转义
**建议**: 在 `marked.parse()` 后添加 DOMPurify 清洗（需引入 dompurify.js），或在 marked renderer 中对非代码内容做统一转义

#### [P1-11] `showToast()` 中 `iconSvg()` 返回值直接 innerHTML
**文件**: `errors.js:124-128`  
```javascript
var html = '<div class="toast-msg">' + esc(message) + '</div>';
if (action) {
  html += '<div class="toast-action">' + iconSvg('idea','12') + ' ' + esc(action) + '</div>';
}
toast.innerHTML = html;
```
**分析**: `message` 和 `action` 都经过了 `esc()` 转义。`iconSvg()` 返回硬编码的 SVG 字符串（不接受外部输入），因此安全。  
**结论**: 无 XSS 风险，但建议在注释中说明 `iconSvg()` 返回值为可信静态内容

### 6.2 脚本加载顺序

**文件**: `index.html:800-816`  
加载顺序：
1. `api.js` → 2. `utils.js` → 3. `errors.js` → 4. `stream_renderer.js` → 5. `settings.js` → 6. `qa.js` → 7. `minutes.js` → 8. `skills.js`(废弃) → 9. `chat-session.js` → 10. `chat-actions.js` → 11. `chat-files.js` → 12. `chat-export.js` → 13. `chat-ui.js` → 14. `chat.js`

**分析**: 加载顺序正确。依赖链 `api → utils → errors → stream_renderer → ... → chat` 确保：
- `fetchWithTimeout` 在所有模块之前可用
- `esc()` / `iconSvg()` 在 `errors.js` 之前加载
- `chat.js` 最后加载，可引用所有子模块

**结论**: 加载顺序无问题。

### 6.3 innerHTML 使用分析

全项目约 **60+ 处** `innerHTML` 赋值。关键安全评估：

| 位置 | 数据来源 | 是否转义 | 风险 |
|---|---|---|---|
| `chat.js` SSE 消息渲染 | 后端 AI 回复 | 通过 `md()` 处理 | 中（见 P1-10） |
| `errors.js:128` Toast | 用户/系统消息 | `esc()` 转义 | 低 |
| `errors.js:333` Dialog | `esc(title)` + `esc(message)` | 已转义 | 低 |
| `utils.js:230` 代码块 | `esc(code)` 后 hljs 处理 | 已转义 | 低 |
| `chat-ui.js:78-89` 漂移条 | 模板字符串 + `msgCount` 数字 | 安全 | 低 |
| `qa.js` / `minutes.js` 状态图标 | 硬编码 SVG + `esc()` 数据 | 安全 | 低 |

---

## 七、内存泄漏 / 定时器清理

#### [P1-09 补充] 定时器清理汇总

| 定时器变量 | 文件 | 是否有清理 | 状态 |
|---|---|---|---|
| `_heartbeatTimer` | errors.js | 无 `clearInterval` | 需关注 |
| `_sessionPollTimer` | chat-session.js | 无 `clearInterval` | 需关注 |
| `_kbPollTimer` | qa.js:297 | `clearInterval` ✓ | OK |
| `_minutesPollTimer` | minutes.js:31 | `clearInterval` ✓ | OK |
| `_recTimerInterval` | minutes.js:549 | `clearInterval` ✓ | OK |
| `_refinePollTimers[]` | minutes.js:1179 | `clearInterval` ✓ | OK |
| `settings.js:399 _poll` | settings.js:404 | `clearInterval` ✓ (局部) | OK |
| `minutes.js:220 _poll` | minutes.js:225 | `clearInterval` ✓ (局部) | OK |
| `stream_renderer._timer` | stream_renderer.js:58 | `clearTimeout` ✓ | OK |

**重点关注**: `_heartbeatTimer` 和 `_sessionPollTimer` 全生命周期不清理，但因为是长期运行的检测功能，影响可控。

---

## 八、其他发现

#### [P2-11] `_renderFootnotesFallback()` 中 `fn.text` 未转义
**文件**: `utils.js:336`  
```javascript
fnHtml += '<li id="fn-' + fn.id + '">' + fn.text + ' <a ...>' + ...;
```
`fn.id` 来自正则匹配 `^\[\^(\w+)\]$`，仅含 `\w` 字符，安全。  
`fn.text` 来自 Markdown 原文 `(.+)` 匹配，理论上可含 HTML。  
**影响**: 若 marked.js 将脚注文本原样保留（不渲染为 HTML），`fn.text` 会被直接插入 HTML。  
**建议**: 对 `fn.id` 使用 `escAttr()`，对 `fn.text` 使用 `esc()` 或 `md()` 渲染

---

## 九、改进建议总览

### 立即修复 (P0)

1. **`_mdFallback()` 行内代码 XSS** — `utils.js:369` — 改为 callback + `esc()`
2. **`_mdFallback()` 链接 XSS** — `utils.js:388` — 改为 callback + `escAttr()` + 过滤 `javascript:` 协议

### 高优先级 (P1)

3. CSS 硬编码颜色 → 提取变量（`main.css` 8处 + JS 50+处）
4. `showLoading()` / `hideLoading()` 添加 null 保护
5. `.msg.user` 背景色改为 `var(--msg-user-bg)`
6. `.msg .ts` 颜色改为 `var(--text-muted)`
7. 添加 `stopSessionPoll()` 并在适当时机调用
8. 考虑为 `md()` 添加 DOMPurify 后处理
9. `_renderFootnotesFallback` 中转义 `fn.text`

### 建议优化 (P2)

10. 删除废弃的 `skills.js` 及其 `<script>` 标签
11. 清理空函数 `updateKbLockBar()`
12. 合并 `downloadFile()` / `saveFileAs()`
13. 消除 Toast `.warning` 重复 CSS 规则
14. 暗色模式下 `.tag-local` / `.tag-cloud` 添加覆盖
15. 上下文指示器颜色改用 CSS 变量
16. `stream-msg` DOM 查询添加缓存
17. 澄清 `--accent-light` 与 `--primary-50` 重复
18. `--text-muted` / `--msg-ai-bg` 改为引用 gray 变量

---

## 十、文件审计清单

| 文件 | 行数 | 审计维度覆盖 | 问题数 |
|---|---|---|---|
| `index.html` | ~816 | 脚本加载顺序、DOM ID、onclick 绑定 | 1 |
| `static/css/main.css` | ~900 | 变量完整性、硬编码颜色、主题一致性 | 6 |
| `static/js/core/api.js` | 44 | 依赖关系 | 0 |
| `static/js/core/utils.js` | 542 | XSS、Markdown 安全、死代码 | 4 |
| `static/js/core/errors.js` | 356 | Toast 安全、心跳清理、Dialog 安全 | 2 |
| `static/js/stream_renderer.js` | 79 | 定时器清理 | 0 |
| `static/js/settings.js` | ~1200 | 硬编码颜色、EventSource、定时器 | 3 |
| `static/js/qa.js` | ~1000 | 定时器清理、硬编码颜色 | 1 |
| `static/js/minutes.js` | ~1400 | 硬编码颜色、定时器清理、DOM 引用 | 2 |
| `static/js/chat.js` | ~1300 | SSE 安全、DOM 引用频率、硬编码颜色 | 2 |
| `static/js/chat-session.js` | 288 | 定时器清理、DOM 引用 | 1 |
| `static/js/chat-actions.js` | 146 | 事件绑定 | 0 |
| `static/js/chat-files.js` | 172 | DOM 引用 | 0 |
| `static/js/chat-export.js` | 41 | Blob 清理 | 0 |
| `static/js/chat-ui.js` | 194 | 空函数、DOM 引用 | 1 |
| `static/js/skills.js` | 3 | 死代码 | 1 |

**总计**: 15 个文件，~7800+ 行代码，22 个审计发现
