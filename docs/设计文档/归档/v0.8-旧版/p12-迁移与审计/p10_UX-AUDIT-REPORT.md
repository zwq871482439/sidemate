# UX 审计报告 — 桌伴 · Sidemate

> 审计日期：2026-05-27  
> 审计范围：`index.html` + `main.css` + 5 个 JS 模块  
> 审计人：齐活林（主理人，综合 Review）

---

## 一、整体评分

| 维度 | 评分 | 状态 |
|------|------|------|
| 配色体系 | 🟢 良好 | CSS 变量命名规范，亮/暗双主题完整 |
| UI 一致性 | 🟡 中等 | 卡片体系仅覆盖设置 Tab，其他 Tab 无卡片概念 |
| 色彩管理 | 🟢 良好 | 上次审计后已完成硬编码色→CSS 变量的大替换 |
| 内容分布 | 🟡 中等 | 核心功能分布合理，但信息密度不均 |
| 字号管理 | 🔴 较差 | 大量内联 `font-size`，缺乏尺寸体系 |
| 按钮体系 | 🔴 较差 | 3 套互不兼容的按钮类并存 |
| 交互反馈 | 🟢 良好 | Toast、Loading、遮罩、进度条齐全 |
| 暗色模式 | 🟡 中等 | 变量体系覆盖了核心区域，但仍有漏网之鱼 |
| Typography | 🟡 中等 | 系统字体栈合理，但无排版层级 |

---

## 二、配色体系

### 亮点
- CSS 变量命名遵循语义化原则：`--bg-primary/secondary/tertiary` + `--text-primary/secondary/muted`
- 亮色/暗色主题通过 `[data-theme="dark"]` 用同一套变量名实现切换，架构正确
- 语义色（`--error-color`/`--success-color`/`--warning-color`/`--info-color`）覆盖了状态提示场景

### 问题

| # | 问题 | 位置 | 严重度 |
|---|------|------|--------|
| P1 | 亮色主题的 `--accent-color: #4f46e5` 与 `--accent-hover: #4338ca` 对比度仅 ~1.2，hover 效果几乎看不出 | main.css L10-11 | 🟡 中等 |
| P2 | `--msg-user-bg`(#eef2ff) 与 `--msg-ai-bg`(#f8f9fa) 在亮色模式下对比太弱，用户消息与 AI 回复区分度不够 | main.css L12-14 | 🟡 中等 |
| P3 | `--bg-secondary`(#f8f9fa) 与 `--bg-primary`(#ffffff) 差值仅 ~3%，大面积使用时几乎没有层次感 | main.css L3-4 | 🟡 中等 |
| P4 | `--bg-tertiary`(#f0f0f0) 是一个"孤儿变量"——只用了 3 处（`.btn-img`、`progress-bar 背景`、`kbDropZone 背景`），在暗色模式下变成深蓝(#0f3460)，语义断裂 | main.css L5,44 | 🟢 轻微 |

---

## 三、UI 一致性

### 按钮体系——最大的一致性隐患

当前项目存在 **3 套互不兼容的按钮类**：

| 按钮体系 | 应用范围 | 基础样式 |
|----------|---------|---------|
| `.panel button` / `.primary` / `.secondary` / `.danger` | 纪要 Tab（`#minutesReady`） | `padding:5px 12px; border-radius:4px; font-size:.82em` |
| `.settings-btn` / `.settings-btn-primary` | 设置 Tab 所有卡片 | `padding:5px 14px; border-radius:8px; font-size:12px` |
| `.action-btn` | 对话 Tab Action 栏（Patch11） | `padding:4px 12px; border-radius:6px; font-size:.8em` |
| 内联样式 | 对话输入区、QA 提问按钮、多处 | 各自为政 |

**实际效果**：用户在 3 个 Tab 之间切换时，看到的按钮圆角、间距、字号均不一致。

### 卡片体系——覆盖不完整

| 组件 | 是否使用 `.settings-card` | 
|------|--------------------------|
| 设置 Tab 所有卡片 | ✅ 是 |
| 对话 Tab 消息区 | ❌ 无卡片概念 |
| QA Tab 左侧文档面板 | ❌ 使用 `kb-left-panel` 自有样式 |
| QA Tab 右侧问答区 | ❌ 内联样式 |
| 纪要 Tab 状态栏 | ❌ 内联样式 |
| 纪要 Tab 录音区 | ❌ 内联样式 |

### 图标使用
- 大量使用 Emoji（💬📚📝⚙️🔒➕📚📝⏺📁📥💾✏🗑🔊🎙⏏等），风格统一
- 但 Emoji 在不同平台渲染效果不一致（Windows vs macOS 差异显著）
- 没有使用任何 SVG 图标（除 Favicon 外）

---

## 四、字号管理

### 当前状态：无字号体系

扫描全项目字号使用，实际存在着 **14 种不同的 font-size**：

| 字号值 | 出现场景 | 用途 |
|--------|---------|------|
| `3em` | 引导页大图标 | 装饰性 |
| `2.4em` | 聊天遮罩图标 | 装饰性 |
| `1.4em` | 文件卡片图标 | 装饰性 |
| `1.3em` | 引导页标题 | 标题 |
| `1.2em` | `.md h1` | Markdown 标题 |
| `1.1em` | `.header h1` | 页面标题 |
| `1em` | 卡片标题/面板 h3 | 内容标题 |
| `.95em` | 遮罩消息 | 正文(增强) |
| `.9em` | 消息气泡/输入框 | 标准正文 |
| `.88em` | KB 消息 | 正文(缩小) |
| `.85em` | 多处混合 | 辅助文字 |
| `.82em` | 面板文本/文档列表 | 辅助文字 |
| `.78em`~`.75em` | 工具栏/标签 | 次级文字 |
| `.72em`~`.7em` | 标签/徽章 | 标注文字 |

**问题分析**：
- 没有定义 `--font-xs`、`--font-sm`、`--font-md`、`--font-lg` 这种尺寸变量
- `.78em` ~ `.82em` 之间的 5 种字号的视觉差异肉眼几乎无法区分
- 不同 Tab 对"描述文字"使用了不同的字号（设置用 13px，摘要用 .85em，纪要用 .82em）

---

## 五、布局与内容分布

### 对话 Tab
- 布局：`工具栏 → Action栏 → 消息流 → 输入区`，纵向清晰
- 模型未加载时有大遮罩指引用户去设置，UX 良好
- 滚动到底按钮（`#scrollBottomBtn`）定位用硬编码 `bottom:70px`，不响应输入区高度变化

### 文库 Tab
- 三态路由（Loading → Onboarding → Activated）设计合理
- 左侧面板首次加载后自动折叠，这个设计聪明——给问答区更多空间
- 但文档列表渲染依赖 `qa.js` 中 ~60 行的内联 HTML 构建，样式与 Settings Tab 风格脱节
- 右侧问答区缺少"会话记忆轮数"设置的视觉提示（一个下拉，用户不一定懂）

### 纪要 Tab
- 状态机设计合理（Loading → Install → Ready）
- 录音中面板集音量条、增益控制、实时转写于一个区域，信息密度合理
- 转录弹窗内容过多（播放器+粗稿+最终稿+编辑+纪要），长屏弹窗更合适
- 历史记录列表由 `minutes.js` 动态构建，样式不统一

### 设置 Tab
- 设计师投入最多的区域，卡片体系完整
- 双列 Grid 布局（系统状态+资源占用）在窄屏下会断裂
- 折叠区域（系统信息/模块版本/关于）使用 `<details>` 标签，兼容性好但样式与其他卡片不一致

---

## 六、暗色模式覆盖度

### 已覆盖 ✅
- 所有通过 CSS 变量控制的颜色自动兼容
- 对话消息气泡、代码块、输入区
- 设置 Tab 的所有卡片
- Chat 遮罩、KB 遮罩
- Toast 通知

### 未覆盖 / 半覆盖 ⚠️

| 组件 | 问题 | 位置 |
|------|------|------|
| `offline-banner` | 仍使用硬编码 `#fef2f2`/`#fca5a5`/`#991b1b` | main.css L320 |
| `task-chip.*` (6 种) | thinking/code/text/agent/doc/logic/fast 全部硬编码色 | main.css L120-128 |
| `agent-header` | 渐变用硬编码色 | main.css L262 |
| `agent-ok`/`agent-fail` | 背景/文字硬编码 | main.css L269-270 |
| `agent-step-num` | 背景 `#6366f1` 硬编码 | main.css L266 |
| `agent-done` | 颜色 `#6366f1` 硬编码 | main.css L274 |
| `chunk-progress-fill` | 渐变 `#3b82f6,#6366f1` | main.css L279 |
| `variant-tag.new` | 背景 `#dbeafe` 硬编码 | main.css L107 |
| `msg.superseded` | 边框 `#d1d5db` | main.css L103 |
| `msg.variant-new` | 边框 `#3b82f6` | main.css L104 |
| `thinking-indicator .dots span` | 背景 `#bbb` | main.css L163 |
| `loading-overlay .progress-bar .fill` | 渐变 `#818cf8` | main.css L241 |
| `.progress-fill` | 渐变 `#818cf8` | main.css L247 |
| `.btn-send:disabled` | 背景 `#c7d2fe` | main.css L183 |
| `.btn-stop:hover` | 背景 `#dc2626` | main.css L185 |
| `.session-wrap button:hover` | `#fee2e2` | main.css L89 |
| `.deletable-item .del-btn:hover` | `#fef2f2` | main.css L233 |
| `kb-sources-header .badge` | 背景 `#e0e7ff` | main.css L317 |
| `panel button.danger:hover` | 背景 `#dc2626` | main.css L221 |
| `offline-banner .retry-btn:hover` | 背景 `#dc2626` | main.css L325 |
| `offline-banner .dismiss-btn` | 颜色 `#991b1b` | main.css L326 |
| `theme-toggle-slider:before` | 背景 `#fff` | main.css L354 |

**估计**：约 20 处组件在暗色模式下会出现色差，分布在 Agent Panel、Task Chip、离线横幅、加载遮罩等区域。

---

## 七、交互设计

### 亮点
- 踩下遮罩式引导 → 用户必须加载模型才能使用，路径清晰
- KB 锁机制（对话区覆盖）避免异步处理期间的用户误操作
- Tab 记忆（`localStorage._activeTab`）刷新后保持位置
- 深色模式跟随系统偏好（`prefers-color-scheme`），也支持手动覆盖
- SSE 流式进度条（模型加载）提供实时反馈

### 问题

| # | 问题 | 影响 |
|---|------|------|
| I1 | 输入区 `➕` 和 `📚` 两个按钮功能不明确，用户很难猜出它们分别做什么 | 新用户困惑 |
| I2 | 会话记忆轮数下拉放在 Q&A 输入区上方，没有上下文解释 | 功能不被发现 |
| I3 | 纪要 Tab "释放引擎"按钮出现两次（状态栏右上 + 底部），功能重复 | 冗余 |
| I4 | `#scrollBottomBtn` 的 `bottom:70px` 硬编码，Action 栏和文件卡片会遮挡按钮 | 小概率 Bug |

---

## 八、建议优先级

### 🔴 P0 - 必须修复（影响可用性）

1. **统一按钮体系**：抽象一套 `btn` + `btn-primary` + `btn-danger` 全局类，替换 `.panel button`/`.settings-btn`/`.action-btn` 三套体系
2. **定义字号变量**：建立 `--font-xs(11px) / --font-sm(13px) / --font-md(15px) / --font-lg(18px)`，替换散布的 14 种内联字号

### 🟡 P1 - 应该修复（影响一致性）

3. **暗色模式全覆盖**：将 `task-chip.*`、`agent-*`、`offline-banner`、`loading-overlay` 等 ~20 处组件的硬编码色改为 CSS 变量或添加 dark 覆盖
4. **卡片体系统一**：给 QA Tab 左侧面板、纪要 Tab 功能区、对话 Tab 输入区加上卡片包装，复用 `.settings-card` 或建立通用 `.card` 类
5. **亮色主题 bg 对比度提升**：`--bg-secondary` 从 `#f8f9fa` 改为 `#f2f3f5`，`--accent-hover` 从 `#4338ca` 改为 `#3730a3`

### 🟢 P2 - 建议修复（锦上添花）

6. **图标工具提示**：给 `➕` / `📚` 按钮加 `title` 属性
7. **会话记忆说明**：在 Q&A 的"会话记忆"下拉旁加个小的 `ⓘ` 提示
8. **纪要 Tab 去重**：保留底部的"释放引擎"，去掉状态栏右上角的重复按钮
9. **窄屏响应**：为设置 Tab 双列 Grid 添加 `@media (max-width: 600px)` 降级为单列

---

## 九、总结

| 做得好的 | 需要改进的 |
|---------|----------|
| CSS 变量架构设计 | 按钮体系碎片化 |
| 亮/暗双主题切换机制 | 字号管理没有体系 |
| 状态机路由（三态） | 暗色模式覆盖不完整 |
| 加载反馈（SSE 进度条） | 卡片设计语言没有铺开到所有 Tab |
| 会话恢复（Tab 记忆） | 约 4% 的 CSS 属性仍为硬编码色 |
| Toast 通知系统 | 引导性微文案缺失 |

**一句话总结**：设计骨架（CSS 变量、状态路由、反馈体系）搭得好，血肉（按钮、字号、卡片风格）需要统一。核心问题不是功能缺失，而是**设计语言没有全局贯彻**——设置 Tab 看起来像一个独立产品，和其他三个 Tab 不是同一个设计系统出来的。
