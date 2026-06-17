# 桌伴 Sidemate v0.9 patch3 — 前端 UX 交互体验评审报告

> **评审人**: reviewer-ux  
> **评审日期**: 2026-06-09  
> **评审范围**: `index.html` + `main.css` + 13 个 JS 文件  
> **评审维度**: 操作反馈完整性、加载状态管理、弹窗关闭机制、按钮/输入框交互、键盘可访问性、空状态处理、响应式适配  
> **评审方法**: 逐文件逐函数读取源码，基于实际代码进行审查，不凭空猜测

---

## 评审摘要

| 级别 | 数量 | 说明 |
|------|------|------|
| **P0 (阻塞发版)** | 4 | 核心交互缺陷，影响基本可用性 |
| **P1 (重要但可后修)** | 12 | 明显影响用户体验 |
| **P2 (建议优化)** | 10 | 体验优化建议 |
| **合计** | **26** | |

---

## 一、操作反馈完整性

### [P0-01] 删除会话操作无 Loading 反馈，单次耗时场景无进度提示

**文件**: `chat-session.js:194-223`  
**严重级别**: P0

`_sidebarDeleteChat()` 在发送 DELETE 请求后，调用了 `loadChatList()` 和 `newChat()` 等多个异步操作，整个过程无任何 loading 指示器。用户点击删除后界面可能在短时间内无明显变化，然后突然切换会话，容易造成困惑。

同样的问题也存在于 `deleteChat()` 函数 (`chat-session.js:254-283`)。

**建议**: 删除操作开始时显示 Toast "正在删除..."，完成后显示 Toast "已删除"。

---

### [P0-02] 发送消息后 Send→Stop 按钮切换存在布局抖动

**文件**: `chat.js:380-381`, `chat.js:820-822`, `index.html:175-178`  
**严重级别**: P0

```javascript
// chat.js:380-381
document.getElementById('sendBtn').style.display = 'none';
document.getElementById('stopBtn').style.display = '';
```

`sendBtn`（文本"发送"）和 `stopBtn`（文本"停止"）宽度不同，通过 `display:none/block` 切换时，按钮容器宽度发生变化，导致输入栏右侧区域的布局抖动。虽然 HTML 中 `stopBtn` 使用了 `position:absolute` (`index.html:177`)，但仍存在细微抖动——当 `sendBtn` 消失后，其父容器 `(position:relative;width:64px)` 的视觉占用没有内容填充。

**建议**: 两个按钮使用相同的 `min-width`（已设置为 `width:100%`），但需确认两个按钮文字宽度一致，或使用 `visibility:hidden` 替代 `display:none` 保持占位。

---

### [P1-01] 文件上传成功后反馈不够明显

**文件**: `chat-files.js:131-153`  
**严重级别**: P1

`onUnifiedPicked()` 中：
- 选择文件时调用 `showFileIndicator()` 显示文件指示条（不错）
- 上传成功后调用 `showToast('文件已上传', 'success')`（不错）

但上传_失败_后的 `clearPendingFile()` 清除了所有 UI 状态，用户可能不知道失败原因只能看到指示条消失。虽然有 Toast 错误提示，但如果在 Toast 触发前用户操作了其他元素，信息可能丢失。

**建议**: 上传失败时保留文件指示条上的错误状态（如红色边框 + 错误图标），让失败原因可见更久。

---

### [P1-02] 模式切换确认弹窗缺少 "切换中..." 过渡状态

**文件**: `settings.js:976-1001`  
**严重级别**: P1

`confirmModeSwitch()` 中直接发送请求后等待响应，期间无任何 loading 提示。如果网络延迟或后端处理慢，用户可能以为点击失效而重复点击。

**建议**: 在 `confirmModeSwitch` 开始时禁用确认按钮并显示 "切换中..." 文字。

---

### [P1-03] KB 文档上传后无明确进度展示（仅轮询刷新）

**文件**: `qa.js:306-343`  
**严重级别**: P1

`kbUploadFile()` 调用 `/api/kb/upload` 返回后直接调用 `kbRefreshDocs()`。文档处理（索引、摘要）在后端异步进行，前端没有针对单文件处理状态的进度反馈。用户上传文件后只能看到文档列表中出现一个 "processing" 状态的条目（需要 3 秒轮询间隔），体验割裂。

**建议**: 上传成功后立即在文档列表中插入一个占位卡片（带旋转 spinner），然后通过轮询更新其状态为完成。

---

### [P2-01] 导出对话成功/失败反馈使用 `showToast` 但提示时长固定

**文件**: `chat-export.js:4-26`  
**严重级别**: P2

导出成功/失败的 Toast 使用默认 4 秒时长。但对于导出操作，成功提示可以更短（2 秒），因为用户关注的是文件是否下载了，而不是 Toast 说了什么。

**建议**: 成功时使用 `showToast('对话已导出', 'success', 2000)`。

---

### [P2-02] SSE 流式传输中断后缺少重连引导

**文件**: `chat.js:476-1061`  
**严重级别**: P2

当 SSE 流因网络中断等原因异常退出时，错误信息直接显示在消息区域中（`'\u274C 连接错误: ' + esc(e.message)`），但未提供"重试"按钮或操作建议。用户只能手动重新发送消息。

**建议**: 错误卡片中增加"重新发送"按钮，点击自动填充上一次的问题并重试。

---

## 二、加载状态管理

### [P0-03] 启动过程有 loading 遮罩但缺少进度粒度

**文件**: `index.html:772-776`, `utils.js:87-113`, `index.html:836-882`  
**严重级别**: P0

`init()` 函数中虽然 HTML 中有 `#loadingOverlay`（默认 `display:flex`），但：
1. `init()` 中并行调用 `refreshStatus()` 后无额外 loading 更新
2. `showLoading()` 中使用了硬编码的 8 秒 CSS 动画 (`loadProgress` animation)，并非真实进度
3. `init()` 调用链较长（`refreshStatus()` → `updateChatOverlay()` → `kbRouteState()` → `loadCloudConfig()` 等），但 loading 只在 `init()` 尾部调用 `hideLoading()`

如果后端响应慢，用户看到的是一条正在假运行的进度条，体验差。

**建议**: 在 `init` 中的关键步骤完成后更新 `loadingText` 文字（如"模型信息已获取"→"加载对话记录..."→"初始化完成"），给用户更真实的进度感。

---

### [P0-04] KB 文库模块安装/加载缺少真实进度

**文件**: `qa.js:50-99`, `index.html:225-230`  
**严重级别**: P0

`kbInstallModule()` 使用硬编码的进度值：
- `bar.style.width = '20%'` → "正在上传安装包..."
- `bar.style.width = '40%'` → "正在解压并安装..."
- `bar.style.width = '100%'` → 成功

这些百分比值与实际安装进度无关，用户看到的进度条完全是假的。对于 2.1GB 的安装包，假进度条会严重误导用户等待预期。

**建议**: 后端提供安装进度 SSE 或使用 `fetch` 的 `onprogress` 事件获取真实上传/安装进度。

---

### [P1-04] Tab 切换时文库和纪要存在短暂闪烁

**文件**: `index.html:817-827 (switchTab)`  
**严重级别**: P1

`switchTab()` 在切换到 `qa` 时调用 `kbRouteState()`，在切换到 `minutes` 时调用 `minutesRouteState()`。这两个函数内部都是先显示 loading → fetch → 显示内容。每次切 Tab 都要重新请求，如果之前已加载过，会造成不必要的闪烁。

```javascript
// index.html:823-826
if (name === 'qa') kbRouteState();  // 每次都重新请求
if (name === 'minutes') minutesRouteState();  // 每次都重新请求
```

**建议**: 缓存 Tab 状态，仅首次切换时或手动刷新时重新请求。

---

### [P1-05] 模型预热等待期间全局覆层锁定 UI 但缺少取消机制

**文件**: `settings.js:375-422`  
**严重级别**: P1

`handleWarmup()` 调用 `showModuleLoading()` 显示全局覆层（`#moduleLoadingOverlay`，`z-index:90`）。这个覆层_没有关闭按钮_，用户只能等待预热完成。如果预热卡住或耗时远超预期，用户无法取消或退出。

**建议**: 全局覆层上增加一个"取消"按钮，调用后端取消预热的 API。

---

### [P2-03] 初始加载白屏时间：loading overlay 隐藏时机过早

**文件**: `index.html:881`  
**严重级别**: P2

`hideLoading()` 在 `init()` 末尾调用，但 `init()` 中的 `try/catch` 块只包裹了对话加载部分。如果 `refreshStatus()` 在其中触发的连锁异步操作（`updateChatOverlay` / `kbRouteState`）未完成前，loading 就被隐藏了，用户会看到短暂的空状态。

幸运的是 `refreshStatus()` 使用 `await`，但 `updateChatOverlay`、`kbRouteState` 等函数内部又有异步请求，这些不会阻塞 `refreshStatus` 返回。

**建议**: 确保 `init()` 中的所有关键初始化操作都完成后再调用 `hideLoading()`。

---

### [P2-04] 扩展安装进度的 SSE 连接无超时处理

**文件**: `settings.js:626-753`  
**严重级别**: P2

`installExtension()` 使用 `EventSource` 监听安装进度。但 `EventSource` 默认有自动重连机制，如果安装已经失败但连接仍在，会导致状态卡住。代码中的 `es.onerror` 处理过于简单，只显示"安装连接中断"，未区分"真正失败"和"临时断连"。

**建议**: `EventSource` 添加超时机制，超时后强制关闭并提示用户。

---

## 三、弹窗/Modal/Overlay 关闭机制

### [P1-06] `transcriptModal` 点击遮罩层仅部分生效

**文件**: `minutes.js:838-843`, `index.html:451`  
**严重级别**: P1

`index.html:451` 中 `transcriptModal` 设置了 `onclick="if(event.target===this) closeTranscriptModal()"`，即点击遮罩关闭。这_很好_。

`minutes.js:847-854` 添加了 Escape 键关闭：

```javascript
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') {
    var modal = document.getElementById('transcriptModal');
    if (modal && modal.style.display === 'flex') {
      closeTranscriptModal();
    }
  }
});
```

这_也正确_。但 **Escape 键处理未 stopPropagation**，如果 transcriptModal 打开时有其他 Escape 处理器（如 `showDialog()` 的 Escape），会导致冲突。

**建议**: 在 Escape 处理器中添加 `e.stopPropagation()` 和 `e.stopImmediatePropagation()`。

---

### [P1-07] `showDialog()` 和 `showKbInfo()` 等自定义弹窗不支持 Escape 关闭

**文件**: `errors.js:317-361`, `qa.js:718-744`  
**严重级别**: P1

等等——再检查 `showDialog()`：
```javascript
// errors.js:357-359
document.addEventListener('keydown', function handler(e) {
  if (e.key === 'Escape') { ...; resolve(false); }
});
```

`showDialog()` _确实_ 支持 Escape 关闭。这是好的。

但 `showKbInfo()` (`qa.js:718-744`) 的自定义弹窗**没有 Escape 键关闭**。它只支持点击遮罩关闭 (`onclick="if (e.target === overlay) overlay.remove()"`）。

`showKbComparePrivacyDialog()` (`qa.js:932-967`) 同样**不支持 Escape 键关闭**。

**建议**: 上述弹窗添加 Escape 键关闭处理器。

---

### [P1-08] 模式确认弹窗 `modeConfirmModal` 的 Escape 关闭依赖全局监听器

**文件**: `settings.js:958-968`, `index.html:187-197`  
**严重级别**: P1

`selectMode()` 中注册了全局 keydown 监听器 `_modeSwitchKeyHandler`，但该监听器_始终在 document 上_，仅在弹窗不可见时 `return`。这意味着每次 Escape 键按下时都会执行此函数，尽管大多数时候直接 return。这是一个轻微的全局性能问题。

**建议**: 在 `cancelModeSwitch` 中立即移除事件监听器，而非仅在弹窗关闭时 return。

---

### [P2-05] 上下文警告弹窗 `contextWarnModal` 不支持 Escape 关闭

**文件**: `chat.js:1108-1120`  
**严重级别**: P2

`_showContextWarning()` 动态创建的弹窗只有两个按钮："继续"和"新建会话"，不支持 Escape 键关闭。

```javascript
overlay.innerHTML = '<div class="modal-card">' +
  '<h3>⚠️ 对话接近上限</h3>' +
  '<div class="modal-warning">...</div>' +
  '<div class="modal-actions">' +
  '<button class="btn-cancel" onclick="...remove()">继续（可能较慢）</button>' +
  '<button class="btn-confirm" onclick="newChat();...remove()">新建会话</button>' +
  '</div></div>';
```

**建议**: 添加 Escape 键关闭（等价于"继续"按钮）。

---

### [P2-06] 附件菜单点击外部关闭使用了延迟绑定

**文件**: `chat-files.js:4-31`  
**严重级别**: P2

```javascript
function toggleAttachMenu() {
  ...
  if (_attachMenuOpen) {
    setTimeout(function() {
      document.addEventListener('click', _closeAttachMenu, {once: true});
    }, 50);
  }
}
```

使用 50ms 的 `setTimeout` 来避免当前事件触发关闭——这是一种 hack，在边界情况下可能失败（如在 50ms 内产生另一个事件）。

**建议**: 使用 `e.stopPropagation()` 在菜单/按钮上阻止冒泡，直接绑定 `document.addEventListener('click', _closeAttachMenu)`。

---

## 四、按钮/输入框交互

### [P1-09] input 禁用状态下 placeholder 无视觉层级区分

**文件**: `index.html:174`, `main.css:230-231`  
**严重级别**: P1

CSS 规则：
```css
.input-area textarea:disabled{opacity:.5;background:var(--bg-secondary)}
```

禁用状态使用 `opacity:.5`，这同时影响文字和背景。在暗色模式下 `opacity:.5` 可能导致文字几乎不可见。此外，placeholder 文字用的是 `::placeholder` 默认样式，禁用状态下用户无法区分"输入框不可用"和"输入框为空"。

**建议**: 禁用时明确改变 placeholder 颜色（如 `color: var(--text-muted); opacity: 0.6`）。

---

### [P1-10] textarea 自动扩高在 `max-height:120px` 超出后无滚动提示

**文件**: `utils.js:65-68`, `main.css:228`  
**严重级别**: P1

```javascript
function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}
```

当内容超出 120px 时，textarea 不再扩高，内容在内部滚动。但没有任何视觉提示（如底部淡出效果）告知用户"还有更多内容在滚动区域内"。用户可能误以为输入被截断。

**建议**: 当 `scrollHeight > 120` 时，在 textarea 底部添加一个淡出渐变 overlay，或显示一个"展开"按钮。

---

### [P1-11] KB 文库问答在生成中无"停止生成"按钮

**文件**: `qa.js:419-558`  
**严重级别**: P1

`kbAsk()` 中判断 `if (_kbGenerating) return` 阻止重复发送，但在生成期间**没有提供停止按钮**。对话 Tab 有 `stopBtn`，文库 Tab 的 `kbInput` 旁边的"提问"按钮没有切换为"停止"的行为。如果生成时间过长，用户只能等待或刷新页面。

**建议**: 生成期间将"提问"按钮变为"停止"按钮，调用后端 `/api/kb/stop` 中断回答。

---

### [P1-12] 模式下拉菜单点击外部关闭逻辑与其他菜单不一致

**文件**: `settings.js:893-906`  
**严重级别**: P1

```javascript
function toggleModeDropdown() {
  ...
  if (show) {
    setTimeout(function() { document.addEventListener('click', function h(e) {
      if (!e.target.closest('.mode-dropdown') && !e.target.closest('.tag-mode')) {
        dd.style.display = 'none';
        document.removeEventListener('click', h);
      }
    }); }, 10);
  }
}
```

与 `toggleAttachMenu()` 一样使用了延迟绑定技巧（10ms）。多个菜单使用不同延迟值（10ms vs 50ms），风格不统一且都脆弱。

**建议**: 统一所有弹出菜单的关闭机制，使用 `stopPropagation` 方式。

---

### [P2-07] 发送按钮在未输入文字时无 disabled 视觉提示

**文件**: `chat.js:318-321`, `main.css:286`  
**严重级别**: P2

`sendMessage()` 在空输入时直接 `return`：
```javascript
if (!text && (typeof pendingFile !== 'undefined') && !pendingFile) return;
```

但 `sendBtn` 始终是可点击状态。用户点击发送时不产生任何效果也无反馈。更好的做法是在输入为空且无 pendingFile 时禁用发送按钮：

```css
.btn-send:disabled{background:var(--bg-tertiary);cursor:not-allowed}
```

但这个 disabled 样式已被定义，只是按钮从未被设置为 disabled。

**建议**: 在 `msgInput` 的 `oninput` 事件中根据内容动态设置 `sendBtn.disabled`。

---

### [P2-08] 文件拖拽区域视觉反馈仅在 hover 时改变边框颜色

**文件**: `index.html:216-218` (文库拖拽), `index.html:286-288` (文档拖拽)  
**严重级别**: P2

拖拽区域的 `ondragover` 只改变 `borderColor`：
```javascript
ondragover="event.preventDefault();this.style.borderColor='var(--accent-hover)'"
```

缺少明显的高亮背景变化，用户可能注意不到这个细微的颜色变化。

**建议**: 拖拽 hover 时添加背景色变化（如 `background: var(--bg-secondary)`）或边框动画。

---

## 五、键盘可访问性

### [P1-13] Tab 键导航顺序混乱——部分隐藏元素仍有 tabindex

**文件**: `index.html` (全局)  
**严重级别**: P1

HTML 中存在 `display:none` 的元素（如 `#sessionSelect`, `#newChatBtn`, `#delChatBtn` — index.html:141-144），但这些隐藏元素可能仍保留在 Tab 键导航序列中，用户使用 Tab 键时会"跳进"不可见元素。

此外，当对话 Tab 不激活（`tab-content` 非 active）时，其中的 input/button 理论上仍处于 Tab 导航中。

**建议**: 给隐藏功能的元素添加 `tabindex="-1"`（如果确认不需要键盘导航），或使用 `visibility:hidden` + `position:absolute` 完全移出导航序列。

---

### [P1-14] KB 输入框在禁用状态下 placeholder 信息不可交互

**文件**: `qa.js:193-213`  
**严重级别**: P1

当模型未加载时：
```javascript
kbInput.placeholder = '⚠️ 请先加载 AI 模型（前往设置页）';
kbInput.disabled = true;
```

placeholder 中的"前往设置页"提示无法点击，用户也不知道如何跳转。应提供一个可点击的链接或按钮引导用户。

**建议**: 在输入框旁边显示一个小的提示文字/图标，点击后跳转到设置页，而不是只用 placeholder。

---

### [P2-09] Enter 键提交在各 Tab 中行为不一致

**文件**: `chat.js:272-274`, `index.html:351`, `index.html:352`  
**严重级别**: P2

- 对话 Tab: Enter 提交 (有 Shift+Enter 换行支持) ✓
- 文库 Tab: `kbInput` 只有 `onkeydown="if(event.key==='Enter'){kbAsk()}"` 无 Shift+Enter 换行支持 ✗
- 设置 Tab: 云端 API Key 输入框无 Enter 键特殊处理

文库输入框 (`kbInput`) 是 `<input type="text">` 而非 `<textarea>`，Enter 键直接提交可以理解。但在设置页的 API Key 输入框 (`cloudApiKey`) 中，按 Enter 不会保存，可能导致用户误操作（以为 Enter 会保存配置）。

**建议**: 在设置页的关键输入框上添加 Enter 键处理（如保存配置），或明确提示"请点击保存按钮"。

---

### [P2-10] Focus 状态可见性不足

**文件**: `main.css` (全局)  
**严重级别**: P2

只有 `textarea:focus` 定义了 outline 样式 (`border-color:var(--accent-color)`)。但普通的 `<input type="text">`（如设置页的 API 地址、模型名称、数据策略）和 `<button>` 没有明确的 `:focus-visible` 样式。在键盘导航时，用户看不到焦点在哪个元素上。

**建议**: 添加全局 `:focus-visible { outline: 2px solid var(--accent-color); outline-offset: 2px; }` 规则，确保键盘用户能追踪焦点位置。

---

## 六、空状态处理

### [P1-15] 侧边会话面板空状态只有 "暂无会话" 文字

**文件**: `chat-session.js:91-97`, `index.html:115`, `main.css:725`  
**严重级别**: P1

```javascript
if (!chats.length) {
  list.innerHTML = '<div class="chat-sidebar-empty">暂无会话</div>';
  return;
}
```

空会话列表只显示"暂无会话"四个字，缺少引导性操作提示。用户可能不知道如何开始。

**建议**: 空状态下显示引导文字 + 按钮，如"还没有对话记录，开始你的第一次对话吧" + [新建对话] 按钮。

---

### [P1-16] 纪要 Tab 历史列表空状态缺少引导

**文件**: `minutes.js:619-627`  
**严重级别**: P1

```javascript
if (!sessions.length) { el.innerHTML = '<div style="color:var(--text-muted);text-align:center;padding:16px">暂无录音记录</div>'; return; }
```

纯文字空状态，缺少开始录音的引导按钮。

**建议**: 添加提示"点击上方「开始录音」记录你的第一次会议"。

---

### [P2-11] 对话区域空状态根据模型状态差异化——这点做得好

**文件**: `chat.js:148-159`  
**严重级别**: P2 (正面)

```javascript
if (loaded) {
  el.innerHTML = '<div class="empty-state">开始对话吧</div>';
} else {
  el.innerHTML = '';  // 由 #chatModelOverlay 接管
}
```

这个逻辑很好：模型已加载时显示引导文字，模型未加载时留空给覆盖层。这是一个好的 UX 设计实践。

---

## 七、响应式适配

### [P2-12] 设置页只有一个 @media 断点（600px）

**文件**: `main.css:542` 和 `index.html:522`  
**严重级别**: P2

```css
@media(max-width:600px){.settings-grid{grid-template-columns:1fr}}
```

设置页使用了 `grid-template-columns:1fr 1fr` 双列布局，在 600px 以下变为单列。但缺少中间断点（如 768px~900px 之间的平板布局），也不考虑 1024px 以上的宽屏优化（当前双列在任何宽度下都是各 50%）。

**建议**: 考虑增加中等宽度断点，或让设置卡片最小宽度更具弹性（使用 `minmax` 函数）。

---

### [P2-13] 对话 Tab 在小窗口下侧边栏与消息区布局紧凑但可用

**文件**: `main.css:753-768`  
**严重级别**: P2

```css
@media (max-width: 768px) {
  .chat-sidebar{width:160px}
  ...
  /* KB 左栏自动折叠 */
  .kb-left-panel[data-collapsed="false"]{width:0;min-width:0;overflow:hidden}
}
@media (max-width: 520px) {
  .chat-sidebar{position:absolute;left:0;top:0;bottom:0;z-index:20}
  ...
}
```

响应式策略基本合理：768px 时侧边栏缩窄，520px 时变成可切换的浮动面板。但缺少侧边栏切换按钮（`.chat-sidebar-toggle` 样式已定义但未见对应的 HTML 按钮）。

**建议**: 在 `<520px` 时自动显示侧边栏切换按钮。

---

### [P2-14] 消息区超长内容溢出处理不完整

**文件**: `main.css:149`, `index.html:145`  
**严重级别**: P2

`#messages` 区域设置了 `overflow-y:auto` 垂直滚动，但 `word-wrap:break-word` 仅在 `.msg` 内定义。对于超长的无空格字符串（如 URL），`word-wrap` 可能无法处理，`overflow-x` 未显式设置为 `hidden` 或 `auto`。

**建议**: 在 `#messages` 上添加 `overflow-x:hidden`。

---

## 八、已有审计报告问题的补充验证

### 前次审计已验证问题状态

参考 `前端UX审计报告-2026-06-02.md` 和 `frontend-ui-audit-2026-06-09.md`：

| 问题 | 状态 | 说明 |
|------|------|------|
| "5.1 transcriptModal 缺 Escape" | **已修复** | minutes.js:847-854 已添加 Escape 处理 |
| "5.2 KB Lock Overlay 硬编码偏移" | **已修复** | main.css 中使用 `position:absolute;top:0` |
| "5.3 Send/Stop 按钮切换布局抖动" | **部分修复** | HTML 中 stopBtn 已设 position:absolute，但仍存在细微抖动 |
| "4.2 启动无 loading 指示" | **仍存在** | init() 中有 loading overlay 但进度虚假 |
| "4.3 Action 栏空状态" | **仍存在** | 当无 action 时 actionBar 为空 `<div>` |

---

## 总结建议优先级

### 发版前必须处理（P0）

1. **删除会话无 Loading 反馈** — 添加 Toast 或内联 spinner
2. **Send/Stop 按钮切换抖动** — 固定按钮宽度或使用 visibility 切换
3. **启动 loading 进度虚假** — 改为阶段性文字提示
4. **KB 安装进度虚假** — 对接真实进度 API

### 建议尽快修复（P1）

5. 文件上传失败状态保留
6. 模式切换 loading 过渡
7. KB 上传后即时插入占位卡片
8. Tab 切换缓存避免重复请求
9. 模型预热全局覆层添加取消按钮
10. 自定义弹窗统一 Escape 关闭
11. input 禁用状态视觉区分
12. textarea 超出滚动提示
13. KB 生成中无停止按钮
14. 模式下拉菜单关闭机制统一
15. Tab 键导航修正
16. KB 输入框模型未加载引导
17. 侧边会话空状态引导
18. 纪要空状态引导

### 后续版本优化（P2）

19. 导出 Toast 时长差异化
20. SSE 中断重连引导
21. 启动 loading 时机
22. 扩展安装 SSE 超时
23. 发送按钮 disabled 视觉
24. 拖拽区域视觉反馈
25. Focus 可见性增强
26. 响应式中间断点

---

> **评审完成时间**: 2026-06-09  
> **总发现数**: 26 个问题（4 P0 / 12 P1 / 10 P2）
