# 前端功能有效性评审报告

**项目**: 桌伴 Sidemate v0.9 patch3  
**评审日期**: 2026-06-09  
**评审人**: 功能审查专家 (reviewer-function)  
**评审范围**: 7 个维度深度审查  
**参考审计报告**: `frontend-ui-audit-2026-06-09.md`、`code-audit-2026-06-09.md`

---

## 评审摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| **P0 (阻塞发版)** | 2 | DOM 引用死代码导致功能缺失、事件绑定安全问题 |
| **P1 (重要但可后修)** | 9 | 状态路由不一致、流式渲染边界、上下文指示器不统一 |
| **P2 (建议优化)** | 10 | 代码冗余、性能优化、维护性改进 |
| **合计** | **21** | |

---

## 一、DOM 引用完整性

### 已修复确认（来自前次审计）

以下前次审计报告中提到的问题经确认已修复：

- `whisperModelLabel` — 无引用，已清除 ✓
- `whisperMemLabel` — 无引用，已清除 ✓
- `llmEnhanceLabel` — 无引用，已清除 ✓
- `skills.js` — 文件已删除、HTML 中 `<script>` 标签已移除 ✓

### [P0-01] `sourceTag` / `privacyTag` 不存在于 HTML → 死代码功能缺失

**文件**: `settings.js:220-243`  
**位置**: `refreshStatus()` 函数内

```javascript
var sourceTag = document.getElementById('sourceTag');  // ← HTML 中不存在
if (sourceTag) {
    sourceTag.textContent = '正在使用本地AI模型';
    sourceTag.className = 'tag online on';
    // ... 共 15 行状态更新逻辑，全部因 sourceTag 为 null 而静默跳过
}

var privacyTag = document.getElementById('privacyTag');  // ← HTML 中不存在
if (privacyTag) privacyTag.style.display = data.current ? '' : 'none';
```

**影响**: 模型来源标签和隐私标签的状态更新逻辑成为死代码。这些元素在之前版本中存在但已被移除，而 JS 代码未同步清理。虽然 `if (sourceTag)` 空值保护防止了 JS 崩溃，但 **模型来源指示功能完全失效** — 用户无法在界面上看到模型来源状态变化。

**修复建议**: 要么从 HTML 中恢复 `sourceTag` / `privacyTag` 元素，要么清理 `settings.js` 中对应的死代码块（约 25 行）。

---

### [P1-01] `kbUninstallBtn` 不存在 → 文库卸载功能不可用

**文件**: `qa.js:662` (`kbUninstallModule()` 函数)  

```javascript
var btn = document.getElementById('kbUninstallBtn');
if (!btn) return;  // ← HTML 中不存在，函数在此处静默退出
```

**影响**: 文库模块的"卸载"功能完全失效。用户无法从 UI 上触发文库模块卸载。虽然函数有 null 保护不导致 JS 崩溃，但功能缺失。

**修复建议**: 在 HTML 中添加 `id="kbUninstallBtn"` 的卸载按钮元素，或移除该函数并确认是否只需要通过设置页扩展管理卸载。

---

### [P1-02] `rerankerResidentChk` 不存在 → 死代码

**文件**: `settings.js:511-512` (`loadRerankerResident()` 函数)

```javascript
var chk = document.getElementById('rerankerResidentChk');
if (chk) chk.checked = !!cfg.reranker_resident;
```

**影响**: Patch3 移除了"文库引擎常驻内存"选项，但 `loadRerankerResident()` 仍然被 `switchTab('settings')` 调用。`rerankerResidentChk` 的 DOM 元素已被移除，此处为死代码。

**修复建议**: 移除 `loadRerankerResident()` 函数及其调用点（`index.html:823` 的 `switchTab` 和 `settings.js` 的 `window` 导出），或在 `switchTab` 调用中移除该函数引用。

---

### [P2-01] `showLoading()` / `hideLoading()` 缺少 null 保护

**文件**: `utils.js:88-99`、`utils.js:105-108`

```javascript
function showLoading(text, showProgress) {
  document.getElementById('loadingText').textContent = text || '加载中...';  // ← 无 null 检查
  var bar = document.getElementById('loadingProgress');
  // ... 未检查 null
  document.getElementById('loadingOverlay').style.display = 'flex';  // ← 无 null 检查
}
function hideLoading() {
  document.getElementById('loadingOverlay').style.display = 'none';  // ← 无 null 检查
  document.getElementById('loadingProgress').style.display = 'none';  // ← 无 null 检查
}
```

**影响**: 如果 DOM 结构变更导致对应元素不存在，这些函数会抛出 `TypeError` 异常。其他类似函数（如 `showModuleLoading`、`hideModuleLoading`）已正确添加 null 保护。

**修复建议**: 添加 `if (!el) return` 保护，与 `showModuleLoading` / `hideModuleLoading` 保持一致。

---

## 二、事件绑定可用性

### 事件绑定总体评估: ✅ PASS

HTML 中所有 `onclick` / `onchange` / `oninput` / `onkeydown` 绑定的函数在 JS 中全部存在对应实现。主要事件绑定包括：

| 模块 | 绑定方式 | 状态 |
|------|---------|------|
| Tab 切换 (`switchTab`) | HTML inline onclick | ✅ 实现于 index.html 内联 |
| 模式切换 (`selectMode`/`confirmModeSwitch`) | HTML inline onclick | ✅ 实现于 settings.js |
| 会话操作 (`newChat`/`deleteChat`/`onSessionChange`) | HTML inline onclick | ✅ 实现于 chat-session.js |
| 消息发送 (`sendMessage`/`stopGeneration`) | HTML inline onclick | ✅ 实现于 chat.js |
| 录音控制 (`startRecording`/`pauseRecording`) | HTML inline onclick | ✅ 实现于 minutes.js |
| 文库操作 (`kbAsk`/`kbNewChat`/`kbOnFilePicked`) | HTML inline onclick | ✅ 实现于 qa.js |
| 侧边栏会话列表 | JS event delegation | ✅ 实现于 chat-session.js:4-23 |
| 按键处理 (`onInputKey`) | HTML inline onkeydown | ✅ 实现于 chat.js:272-274 |
| 模式弹窗 ESC/Enter | JS keydown listener | ✅ 实现于 settings.js:961-968 |
| 转写弹窗 ESC | JS keydown listener | ✅ 实现于 minutes.js:847-854 |

### [P2-02] `playerSeeking` 全局变量未声明

**文件**: `index.html:467`、`minutes.js:1263`

在 HTML 中：
```html
<input type="range" id="playerProgress" ...
  onpointerdown="playerSeeking=true"
  onpointerup="playerSeeking=false;seekPlayer(this.value)">
```

在 JS 中：
```javascript
// minutes.js:1263
if (typeof playerSeeking !== 'undefined' && playerSeeking) return;
```

**影响**: `playerSeeking` 通过隐式全局创建（非严格模式下赋值给未声明变量自动挂载到 `window`），功能正常但不规范。严格模式下会报 `ReferenceError`。

**修复建议**: 在 minutes.js 顶部添加 `var playerSeeking = false;` 明确声明。

---

### [P2-03] KB 内联 onclick 使用模板字符串拼接 path/ID

**文件**: `qa.js` (文档列表)、`minutes.js` (历史列表)

大量使用如:
```javascript
'<button onclick="kbDeleteDoc(\'' + d.doc_id + '\')">'
'<button onclick="deleteSession(\'' + s.session_id + '\')">'
```

**影响**: `doc_id` 和 `session_id` 来自后端 API 响应，直接拼入 HTML 属性存在潜在注入风险（虽然 `session_id` 是服务端生成的，但 `doc_id` 理论上可被篡改）。功能上正常工作。

**修复建议**: 使用 `event.target.closest()` + `data-*` 属性进行事件委托，或对 ID 值使用 `escAttr()` 转义。

---

## 三、SSE 流式渲染正确性

### [P1-03] KB 侧 finalize 后额外覆盖渲染（双重渲染）

**文件**: `qa.js:541-549`

```javascript
aiDiv._streaming = false;
kbRenderer.finalize();                 // ← 通过 renderFn 渲染（含 cursor）

if (fullAnswer) {
  aiDiv.innerHTML = md(fullAnswer) + sourcesHtml;  // ← 再次直接设置 innerHTML
} else if (sourcesHtml) {
  aiDiv.innerHTML = '...' + sourcesHtml;
} else {
  aiDiv.innerHTML = '文库中未找到相关信息。';
}
```

**影响**: `StreamRenderer.finalize()` 通过 `renderFn` 已经渲染了最终内容（因为 `_streaming` 已设为 `false`，所以不包含光标）。紧接着又直接设置 `innerHTML`，造成**同一次流结束时的双重渲染**。虽然最终结果正确，但浪费了一次 DOM 操作。更严重的是，`renderFn` 中拼接了思考详情 `<details>`，而 Line 545 的 `aiDiv.innerHTML = md(fullAnswer) + sourcesHtml` **丢掉了思考过程的折叠内容**。

**修复建议**: 
1. 要么删除 Line 544-549 的额外渲染（因为 finalize 已渲染完成）
2. 要么在 Line 544-549 的渲染中也包含思考详情（`thinkFoldShown` / `thinkText`）

### [P1-04] Chat 侧 `agent_think` 事件可能与 `think_token` 产生竞态

**文件**: `chat.js:810-820`

```javascript
} else if (d.type === 'agent_think') {
  // 新版 agent_think 事件（data = {content: string}）
  if (d.content) {
    _cloudThinkText += d.content;
    if (now - lastRender > RENDER_INTERVAL) {
      _renderCloudThink(_cloudThinkText, fullText);
      lastRender = now;
    }
  }
}
```

**影响**: SSE 同时存在 `agent_think` (line 810) 和 `think_token` (line 587) 两个事件类型处理云端推理模型的思考内容。如果后端同时发送这两种事件（例如不同代码路径），可能导致思考内容重复累加或渲染混乱。

**修复建议**: 确认后端是否已废弃 `agent_think` 事件，如果已废弃则清理该处理分支；如果仍需兼容，添加互斥逻辑防止重复处理。

---

### StreamRenderer 自身评估: ✅ PASS

- `tick()` → 设置 pending 标记，按节流间隔安排渲染 ✓
- `flush()` → clearTimeout + 执行 renderFn ✓  
- `finalize()` → 设置 finalized 标记 + 无条件 flush ✓
- 定时器清理：`flush()` 和 `finalize()` 都 clearTimeout ✓
- 空值防护：`containerEl` null check + `renderFn` try/catch ✓

---

## 四、状态机路由

### [P1-05] 文库路由：注释声称三级状态机，实际仅为二级

**文件**: `index.html:200`、`qa.js:17`

HTML 注释：
```html
<!-- 问答 Tab（文库版 Patch 7: 三级状态机）-->
```

JS 注释：
```javascript
// --- 二态状态路由 ---
```

**实际实现** (`qa.js:17-47`):
- State 1: 未安装 (`kbOnboarding`)
- State 2: 已安装 (`kbFullInterface`)
- 中间 Loading 是过渡动画，不算状态

但在 HTML 中定义了三个完整的 UI 区域：
- `kbOnboarding` (State 1: 未安装)
- `kbLoading` (过渡态)
- `kbFullInterface` (State 2/3: 已激活)

**分析**: Patch10 注释提到"二态路由，安装即自动加载"，说明原本的"已安装未加载"中间状态已被移除。HTML 注释 `<!-- 问答 Tab（文库版 Patch 7: 三级状态机）-->` 已过时，实际代码是二态设计。**这不是功能 bug，但文档/注释不一致**。如果 `kbModelOverlay`（模型未加载遮罩）也视为状态，则实际上级联了 4 个可见模式。

**修复建议**: 同步更新 HTML 和 JS 中的注释，明确描述当前路由逻辑。

---

### [P1-06] 纪要路由：加载语音引擎失败后不自动恢复

**文件**: `minutes.js:69-101`、`minutes.js:199-238`

`reloadWhisper()` 函数（line 199）通过 `showModuleLoading` 显示全局覆层并轮询状态。但在错误路径中：
```javascript
} catch(e) {
  if (typeof hideModuleLoading === 'function') hideModuleLoading();
  if (loadArea) loadArea.style.display = '';      // 恢复旧 UI 按钮
  if (typeof showToast === 'function') showToast('加载失败: ' + e.message, 'error');
  // ← 未重置路由状态
}
```

**影响**: 如果加载语音引擎失败，用户停留在 `minutesIdle` 状态，进度条区域被隐藏、旧按钮恢复。但如果用户想重新尝试加载，`minutesRouteState()` 不会被自动调用，旧 UI 可能处于不一致状态。

**修复建议**: 在错误处理中调用 `minutesRouteState()` 重置界面状态。

---

### Chat 模型锁状态: ✅ PASS

`updateChatOverlay()` (`chat-ui.js:118-156`) 正确实现了三种情境：
1. 云端模式 → 隐藏遮罩 ✓
2. 模型已预热 → 隐藏遮罩 ✓
3. 有模型但未预热 → 显示锁屏卡片 ✓
4. 无模型 → 显示首次引导 ✓
5. Tab 切换和模型状态变化都会触发重新检查 ✓

---

## 五、Action 系统

### Patch3 设计方案检查: ✅ PASS

设计方案要求"移除 Chat Tab KB Action 按钮"。

当前 `refreshActionBar()` (`chat-actions.js:8-96`) 实现：
- **在线模式**: 仅渲染 `agent`（智能对话）和 `doc`（智能文档）两个按钮 ✓
- **本地模式**: 从 `/api/action/list` 获取 action 列表动态渲染 ✓

在 `setActionMode()` (`chat-actions.js:98-141`) 中：
- 在线模式将 `agent` 映射到后端 `action_mode: 'chat'` ✓
- 切换 Action 时清理文件引用状态 ✓
- UI 高亮更新使用 `data-action` 属性匹配 ✓

### [P2-04] local action list 中 validIds 回退逻辑可能干扰

**文件**: `chat-actions.js:76-80`

```javascript
var validIds = actions.map(function(a) { return a.id; });
if (typeof currentActionMode !== 'undefined' && validIds.indexOf(currentActionMode) === -1) {
  currentActionMode = 'chat';
}
```

**影响**: 如果后端返回的 action 列表中包含 `kb` 模式（通过文库扩展注册），而 `currentActionMode` 是其他值，该回退是合理的。但需确认 `kb` action 是否已从后端移除，如果仍在列表中出现，Chat Tab Action Bar 会显示 KB 按钮。

**修复建议**: 确认后端 `/api/action/list` 在 Chat Tab 上下文中不返回 `kb` action，或在前端过滤掉 `kb` id。

---

## 六、上下文指示器

### [P1-07] Chat 与 KB 上下文指示器使用不同的百分比阈值

**文件**: `chat.js:302-310`、`qa.js:640-648`

Chat 侧阈值：
```javascript
// chat.js:304-306
if (pctVal >= 80) { ... }     // critical ≥ 80%
else if (pctVal >= 60) { ... } // warning ≥ 60%
```

KB 侧阈值：
```javascript
// qa.js:640-644
if (pct >= 85) { ... }        // critical ≥ 85%
else if (pct >= 60) { ... }   // warning ≥ 60%
```

**影响**: 两个 Tab 的上下文指示器使用不同的危险阈值（80% vs 85%），视觉状态映射不一致。用户可能在 Chat Tab 看到红色警告（80%），但切换到文库 Tab 时同样的使用率是黄色（80% < 85%）。

**修复建议**: 统一阈值常量（建议 80% 为标准，因为 Chat 侧圆环同时管理 session 和模型 token）。

---

### [P1-08] KB 上下文指示器颜色使用 CSS 变量，Chat 侧则硬编码

**文件**: `chat.js:313` (硬编码)、`qa.js:641-643` (CSS 变量)

```javascript
// chat.js:313 — 硬编码
var color = level === 'critical' ? '#dc3545' : level === 'warning' ? '#f0ad4e' : 'var(--accent-color)';

// qa.js:641-643 — CSS 变量
var color = 'var(--success-color)';   // 或 var(--warning-color) / var(--error-color)
```

**影响**: Chat 侧的上下文圆环颜色无法跟随暗色主题动态变化。虽然 `var(--accent-color)` 在正常状态下能响应主题，但 `#dc3545` 和 `#f0ad4e` 是硬编码值。

**修复建议**: 统一使用 CSS 变量：`var(--error-color)` / `var(--warning-color)` / `var(--success-color)`。

---

### [P2-05] 上下文圆环弧长常量差异

**文件**: `chat.js:311`、`qa.js:629`

```javascript
// chat.js — 硬编码
var circ = 94.2;

// qa.js — 计算
var circumference = 2 * Math.PI * 15; // r=15, 值 ≈ 94.247...
```

**影响**: 极微小的视觉差异（94.2 vs 94.24778, 误差 0.05%），不影响功能，但代码风格不一致。

**修复建议**: 统一使用 `2 * Math.PI * 15` 或提取为常量。

---

## 七、Session 管理

### Session 轮询: ✅ PASS

- `startSessionPoll()` (`chat-session.js:26-62`) — 5 秒间隔，检测外部会话变化 ✓
- `stopSessionPoll()` (`chat-session.js:64-69`) — 提供清理接口 ✓
- 检查 `generating` 状态防止竞态 ✓
- 检查 `document.visibilityState` 跳过不可见时 ✓
- 跨 Tab 切换时 `_lastMsgCount` 不重置，支持恢复后同步 ✓

### [P2-06] 侧边栏导出函数切换-导出-切回的并发风险

**文件**: `chat-session.js:170-192` (`_sidebarExportChat`)

```javascript
function _sidebarExportChat(path) {
  // 1. 切换到目标会话
  fetch('/api/chats/switch', {body: JSON.stringify({path: path})})
    .then(function(resp) {
      currentChatFile = path;
      exportChat();  // 2. 导出
      // 3. 切回原会话
      fetch('/api/chats/switch', {body: JSON.stringify({path: origPath})})
        .then(function(r2) {
          currentChatFile = origPath;
          renderMessages();
        });
    });
}
```

**影响**: 如果用户在导出期间（第 2 步和第 3 步之间）进行操作（如发送消息），`currentChatFile` 此时指向被导出的会话而非原会话，可能导致消息被保存到错误的会话文件。

**修复建议**: 使用 `async/await` 串行化操作，在导出完成后立即切回；或使用后端支持直接导出指定会话而不切换。

---

### [P2-07] 会话轮询机制永不停歇

**文件**: `chat-session.js:26-62`

```javascript
_sessionPollTimer = setInterval(async function() { ... }, 5000);
```

**影响**: 虽然有 `visibilityState` 检查和 `generating` 守卫，但 `setInterval` 定时器本身永不销毁（`stopSessionPoll()` 存在但仅在极少数场景调用）。对于单页应用这是可接受的，但长时间闲置时仍消耗微量资源。

**修复建议**: 在 Tab 切换到非 Chat Tab 时暂停轮询，切回时恢复。

---

## 八、额外发现

### [P1-09] `downloadFile()` 与 `saveFileAs()` 功能完全重复

**文件**: `utils.js:443-451` (`downloadFile`)、`chat-export.js:28-36` (`saveFileAs`)

两个函数实现几乎完全相同（创建 `<a>` 元素触发浏览器下载）。`renderFileCard()` 同时引用两者生成两个按钮。

**影响**: 维护负担，两个功能相同的函数给使用者造成困惑。

**修复建议**: 统一为一个函数（推荐保留 `saveFileAs`，因其包含 `URL.revokeObjectURL` 内存清理）。

---

### [P2-08] `window.confirmDocOutline` / `window.cancelDocOutline` 导出两次

**文件**: `chat.js:909` (第一个导出)、`chat.js:1149` (第二个导出)、`chat.js:1259-1298` (函数定义)、`chat.js:1300-1301` (第三个导出)

**影响**: 无功能影响（重复赋值），但增加代码混淆度。

**修复建议**: 保留一处导出即可。

---

### [P2-09] `updateKbLockBar()` 空函数体 — 注释误导

**文件**: `chat-ui.js:158-161`

```javascript
function updateKbLockBar() {
  // KB 处理中锁定（由 qa.js 调用）
  // 空实现保留兼容，实际在 qa.js 中处理
}
```

**影响**: 函数通过 `window.updateKbLockBar` 暴露并在 `qa.js:181` 被调用（`if (typeof updateKbLockBar === 'function') updateKbLockBar()`），但函数体为空。原设计中该函数应控制 Chat Tab 的 `kbLockOverlay` 元素显示/隐藏，但在当前版本中未实现。

**修复建议**: 要么实现锁定逻辑（根据 `_kbBusyProcessing` 切换 `kbLockOverlay` 显隐），要么移除该函数及调用点。

---

### [P2-10] KB 文档列表 item onclick 函数通过 `window` 暴露但通过 innerHTML 动态生成

**文件**: `qa.js:276-286`、`qa.js:691-700`

文档操作按钮（暂停/取消/删除）通过 innerHTML 拼接 onclick 属性：
```javascript
html += '<button onclick="kbPauseDoc(\'' + d.doc_id + '\')">';
```

同时函数已在文件末尾暴露到 `window`（如 `window.kbPauseDoc = kbPauseDoc`），命名规范正确。但 `doc_id` 值来自后端 API，未经过 `escAttr()` 转义直接拼入 HTML 属性。

**修复建议**: 使用 `data-doc-id` 属性 + 事件委托，避免 `innerHTML` 拼接 onclick。

---

## 九、改进建议总览

### 立即修复 (P0)

| # | 标题 | 文件 | 行号 |
|---|------|------|------|
| P0-01 | `sourceTag` / `privacyTag` 不存在，状态指示功能缺失 | settings.js | 220-243 |
| P0-02 | `kbUninstallBtn` 不存在，文库卸载功能失效 | qa.js | 662 |

### 高优先级 (P1)

| # | 标题 | 文件 | 行号 |
|---|------|------|------|
| P1-01 | `rerankerResidentChk` 不存在，`loadRerankerResident` 为死代码 | settings.js | 511-512 |
| P1-02 | KB 侧 finalize 后覆盖渲染，丢失思考详情 | qa.js | 541-549 |
| P1-03 | Chat 侧 `agent_think` 与 `think_token` 可能竞态 | chat.js | 810-820 |
| P1-04 | 文库路由注释与实现不一致（三级 vs 二级） | index.html / qa.js | 200 / 17 |
| P1-05 | 纪要引擎加载失败后路由状态不恢复 | minutes.js | 233-237 |
| P1-06 | Chat / KB 上下文指示器阈值不统一 | chat.js / qa.js | 304 / 640 |
| P1-07 | Chat 侧上下文指示器颜色硬编码 | chat.js | 313 |
| P1-08 | `downloadFile()` / `saveFileAs()` 功能重复 | utils.js / chat-export.js | 443 / 28 |

### 建议优化 (P2)

| # | 标题 | 文件 | 行号 |
|---|------|------|------|
| P2-01 | `showLoading()` / `hideLoading()` 缺 null 保护 | utils.js | 88-108 |
| P2-02 | `playerSeeking` 未显式声明 | index.html / minutes.js | 467 / 1263 |
| P2-03 | 动态 onclick 中 ID 未转义 | qa.js / minutes.js | 多处 |
| P2-04 | local action list 中 `kb` 可能出现在 Chat 栏 | chat-actions.js | 76-80 |
| P2-05 | 上下文圆环弧长常量不一致 | chat.js / qa.js | 311 / 629 |
| P2-06 | 侧边栏导出切换-导出-切回存在竞态 | chat-session.js | 170-192 |
| P2-07 | 会话轮询定时器永不销毁 | chat-session.js | 29 |
| P2-08 | `window.confirmDocOutline` 重复导出 | chat.js | 909 / 1149 |
| P2-09 | `updateKbLockBar()` 空函数体 | chat-ui.js | 158-161 |
| P2-10 | KB 文档 onclick 拼接未转义 | qa.js | 276-286 |

---

## 十、已确认修复项（来自前次审计）

| 原问题 | 当前状态 |
|--------|---------|
| `whisperModelLabel` DOM 引用 | ✅ 已清除 |
| `whisperMemLabel` DOM 引用 | ✅ 已清除 |
| `llmEnhanceLabel` DOM 引用 | ✅ 已清除 |
| `skills.js` 废弃文件加载 | ✅ 已删除 |
| `_mdFallback()` XSS (P0-01) | ⚠️ 需确认（不在功能审查范围）|
| `_mdFallback()` 链接 XSS (P0-02) | ⚠️ 需确认（不在功能审查范围）|

---

## 十一、审查总结

本次功能有效性审查覆盖了 15 个文件（~8300 行代码），对 7 个核心维度进行了深度分析。共发现 **21 个问题**，其中：

- **P0 (2个)**：`sourceTag`/`privacyTag` 缺失导致模型来源指示功能完全失效；`kbUninstallBtn` 缺失导致文库卸载不可用。
- **P1 (9个)**：涉及 DOM 死代码、流式渲染数据丢失、状态路由不一致、上下文指示器阈值不统一等影响用户体验和代码健壮性的问题。
- **P2 (10个)**：代码质量改进建议，包括冗余代码清理、变量声明规范、性能优化等。

核心功能（对话、文库问答、纪要转写、设置管理）的基本流程完整可用，Action 系统和 Session 管理逻辑正确。主要风险集中于：废弃 DOM 元素引用未清理、流式渲染边界处理、以及跨模块的阈值/颜色不一致问题。

前次审计报告的已知问题中，4 项 DOM 引用问题和 skills.js 加载问题已确认修复。
