# 竞品前端参考：Cherry Studio & LobeHub

> 调研日期：2026-06-19
> 目的：为 Sidemate P5 前端优化提供灵感参考
> 来源：DeepSeek awesome-deepseek-agent 仓库中的开源 AI 客户端

---

## 一、调研背景

用户反馈：希望对比其他开源 AI 客户端的前端设计，看看 Sidemate 能学什么。

调研了两个最相关的开源项目：
- **Cherry Studio**（33K+ stars）：全能 AI 工作站，定位跟 Sidemate 最接近
- **LobeHub**（59K+ stars）：Chief Agent Operator，多 Agent 调度平台

---

## 二、Cherry Studio 调研结果

### 2.1 基本信息

| 维度 | 信息 |
|------|------|
| GitHub | [CherryHQ/cherry-studio](https://github.com/CherryHQ/cherry-studio) |
| 技术栈 | Electron + React + TypeScript + Vite + Tiptap 3 |
| 开源协议 | AGPL-3.0（⚠️ 商业使用需注意）|
| Stars | 33K+ |
| 定位 | 跨平台 AI 对话客户端，集成 300+ 模型 |

### 2.2 值得学习的设计（按价值排序）

#### 🎯 高价值借鉴

**1. 助手 → 话题的两层结构**

```
助手（角色 + 系统提示词 + 模型参数）
  ├─ 话题1（独立对话）
  ├─ 话题2（独立对话）
  └─ 话题3（独立对话）
```

**对 Sidemate 的启示**：
- 当前 Sidemate 的会话结构是"chat 列表"扁平结构
- 可以考虑引入"场景/角色"概念：用户创建"文档写作助手""知识问答助手"等预设，每个预设下有多个对话
- 但 Sidemate 的"模式选择器"已经部分覆盖这个需求（本地/在线/隐身协作）

**2. 可拖拽排序的工具栏**

Cherry Studio 的对话框底部工具栏：
- 新话题 / 上传附件 / 网络搜索 / 知识库 / MCP / 提及模型 / 快捷短语 / 清空 / 展开 / 清除上下文
- **工具图标可以长按拖拽自定义顺序**

**对 Sidemate 的启示**：
- 当前 Sidemate 工具栏是固定的（写文档/引用文库/上传文件）
- 可以让用户自定义工具栏顺序，或根据模式智能显示/隐藏

**3. Token 计数实时显示**

输入框右下角实时显示：
```
当前上下文数 / 最大上下文数 / 当前上下文 Token / 预估 Token
```

**对 Sidemate 的启示**：
- 我们已经有"对话记忆环形指示器"
- 可以补充**预估 Token 数**（用户输入 + 历史上下文）
- 特别在隐身协作/隔离对比模式下，token 预算很重要

**4. 知识库的多源数据导入**

Cherry Studio 知识库支持：
- 文件夹目录（批量）
- 网址 URL
- 站点地图 sitemap.xml
- 纯文本笔记

**对 Sidemate 的启示**：
- 当前 Sidemate 只支持文件上传
- P5 文件类型扩展时可以考虑加"网址导入"和"文本直接输入"
- 这对构建知识库很实用（用户可以直接把网页加进来）

**5. "清空消息" vs "清除上下文" 的区分**

- **清空消息**：物理删除所有消息（不可恢复）
- **清除上下文**：保留消息显示，但模型忘掉之前的对话

**对 Sidemate 的启示**：
- 当前 Sidemate 只有"新建对话"
- 加一个"清除上下文"按钮很有用（用户想换话题但保留历史）
- 这个设计很贴心

#### 🛠️ 中等价值借鉴

**6. `@` 提及模型**

输入框打 `@` 弹出模型选择器，临时切换接下来的回复模型，保留上下文。

**对 Sidemate 的启示**：
- 当前 Sidemate 模式切换需要去顶部下拉
- 可以支持 `@本地` `@云端` `@隐身` 快捷切换

**7. `/` 斜杠命令**

输入框打 `/` 唤起命令面板（快捷短语、翻译、工具调用）。

**对 Sidemate 的启示**：
- 可以加 `/写文档` `/查文库` `/对比` 等快捷命令
- 对高级用户友好

**8. 思考内容自动折叠**

支持思考的模型（GPT-5/Claude/Qwen3.7）思考完成后自动折叠思考过程。

**对 Sidemate 的启示**：
- 当前 Sidemate 本地模型 think 关闭，但云端模型可能开启
- 加一个"思考过程折叠"选项

**9. 丰富的消息样式设置**

- 消息分割线（开/关）
- 衬线字体切换
- 代码行号
- 代码块可折叠
- 代码块可换行
- 消息样式（气泡/列表）
- 数学公式引擎（KaTeX/MathJax）

**对 Sidemate 的启示**：
- Sidemate 的设置项偏少
- 至少应该加"消息样式"和"代码块行为"设置

**10. 拖放排序**

话题、助手、工具栏图标都支持拖放排序。

**对 Sidemate 的启示**：
- 当前 Sidemate 会话列表不能拖拽排序
- 加拖拽排序成本低收益高

#### 🎨 设计细节借鉴

**11. 主题生态**

Cherry Studio 有独立主题站 cherrycss.com，社区贡献 Aero / PaperMaterial / Claude / Maple Neon 等主题。

**对 Sidemate 的启示**：
- P5 可以开放自定义主题（CSS 变量已经支持）
- 但不是优先级

**12. 透明窗口**

支持窗口透明度调节。

**对 Sidemate 的启示**：可选，非优先。

**13. 骨架屏 Loading**

加载态用骨架屏而不是 spinner。

**对 Sidemate 的启示**：
- 当前 Sidemate 用 spinner
- 改骨架屏体验更好

---

## 三、LobeHub 调研结果

### 3.1 基本信息

| 维度 | 信息 |
|------|------|
| GitHub | [lobehub/lobe-chat](https://github.com/lobehub/lobe-chat) |
| 技术栈 | React 19 + Vite SPA + Next.js(后端) + Zustand + SWR + antd |
| 开源协议 | Apache-2.0（✅ 商业友好）|
| Stars | 59K+ |
| 定位 | Chief Agent Operator，多 Agent 调度平台 |

### 3.2 值得学习的设计

#### 🎯 高价值借鉴

**1. Fleet 多 Agent 看板模型**

```
┌─ Fleet 看板 ─────────────────────────────┐
│ [Agent A 列] [Agent B 列] [Agent C 列]   │
│  对话内容      对话内容      对话内容      │
│  状态:运行中   状态:空闲    状态:运行中   │
└──────────────────────────────────────────┘
┌─ 运行任务侧边栏 ─────────────────────────┐
│ ▶ 任务1 (Agent A) 运行中                 │
│ ▶ 任务2 (Agent C) 运行中                 │
│ ○ 任务3 (Agent B) 空闲                   │
└──────────────────────────────────────────┘
```

**对 Sidemate 的启示**：
- Sidemate 不需要多 Agent，但**隔离对比模式的双列布局**可以参考
- 左列=本地回答，右列=云端回答，底部=融合结果
- 每列显示模型状态（思考中/检索中/回答中）

**2. 执行目标抽象（Execution Target）**

```
执行目标：local | auto | device | sandbox | none
触发方式：chat | bot | cron
```

**对 Sidemate 的启示**：
- Sidemate 的"模式"其实就是执行目标（本地/在线/隐身协作）
- 可以更清晰地表达：每个模式 = 一个执行目标 + 一组隐私约束

**3. Agent Document 作为一等公民**

- Agent 可以产出可分享、可独立打开的"文档"
- 区别于纯聊天记录

**对 Sidemate 的启示**：
- 当前 Sidemate 的文档生成结果是 .docx 下载
- 可以考虑"文档管理"概念：生成过的文档都在一个列表里，可重新打开/编辑/分享

**4. Skills 跨工具共享**

```
.agents/skills/
  ├─ .claude/skills/ → 符号链接
  ├─ .cursor/skills/ → 符号链接
  └─ .codex/skills/ → 符号链接
```

**对 Sidemate 的启示**：
- Sidemate 的"工具"（search_kb/write_section 等）本质就是 skills
- 未来可以考虑让用户自定义 skills（类似 Cherry Studio 的 MCP）

**5. Live Trace 调试器**

应用内录制 agent 执行 trace + 回放。

**对 Sidemate 的启示**：
- 当前 Sidemate 有 AgentTimeline 显示工具调用
- 可以增强：支持回放某次对话的完整工具链执行过程
- 对调试"为什么模型这么干"很有用

#### 🎨 体验细节

**6. 实验性功能的视觉规范**

Beta 标签 + Info Popover，让用户清楚知道哪些功能在试验。

**对 Sidemate 的启示**：
- 隐身协作的"智能代理"子类型可以标 Beta
- 让用户知道这是新功能，可能不稳定

**7. 产品 Glossary（术语表）**

当概念多到一定程度，主动建术语表页面。

**对 Sidemate 的启示**：
- Sidemate 的概念越来越多（模式/子模式/令牌/脱敏/知识库 vs 文库）
- P5 可以在设置页加一个"名词解释"或首次使用引导

**8. Loading 态品牌化**

连 loading screen 都做成品牌资产（带 logo 动画）。

**对 Sidemate 的启示**：
- 当前 Splash 是文字版
- P5 品牌视觉时应该做品牌化 loading（用新的 logo.svg）

**9. 骨架屏 + 渐进式加载**

加载侧边栏时显示骨架行，而不是空白或 spinner。

**对 Sidemate 的启示**：同 Cherry Studio，应该用骨架屏。

---

## 四、对 Sidemate 的具体建议（按优先级）

### 🥇 P5 应该做的（高价值低成本）

| # | 借鉴来源 | 改进点 | 复杂度 |
|---|---------|--------|--------|
| 1 | Cherry Studio | 会话列表支持拖拽排序 | 低 |
| 2 | Cherry Studio | "清除上下文"按钮（保留消息但重置模型记忆）| 低 |
| 3 | Cherry Studio | 输入框显示预估 Token 数 | 低 |
| 4 | LobeHub | 骨架屏替代 spinner | 低-中 |
| 5 | LobeHub | Beta 标签（隐身协作智能代理标 Beta）| 低 |
| 6 | Cherry Studio | 思考过程自动折叠（云端模型）| 低 |
| 7 | Cherry Studio | 消息样式设置（气泡/列表切换）| 低 |

### 🥈 P5 可以做的（中价值中成本）

| # | 借鉴来源 | 改进点 | 复杂度 |
|---|---------|--------|--------|
| 8 | Cherry Studio | 知识库支持网址/文本导入 | 中 |
| 9 | Cherry Studio | `@` 提及快捷切换模式 | 中 |
| 10 | Cherry Studio | `/` 斜杠命令面板 | 中 |
| 11 | LobeHub | 隔离对比模式的双列布局（借鉴 Fleet）| 中 |
| 12 | LobeHub | Agent Document 文档管理列表 | 中 |

### 🥉 P6+ 考虑的（低优先级或大工程）

| # | 借鉴来源 | 改进点 | 复杂度 |
|---|---------|--------|--------|
| 13 | Cherry Studio | 助手 → 话题两层结构 | 高 |
| 14 | Cherry Studio | 主题生态开放 | 中 |
| 15 | LobeHub | 自定义 Skills 系统 | 高 |
| 16 | LobeHub | Live Trace 回放 | 高 |

---

## 五、不建议照搬的设计

### ❌ Cherry Studio 的"助手广场"（300+ 预设助手）

**理由**：Sidemate 的定位是"个人 AI 助手"，不是"助手平台"。300+ 预设助手会让产品显得臃肿，偏离核心价值。

### ❌ LobeHub 的"多 Agent 并行调度"

**理由**：Sidemate 是单用户桌面应用，不需要多 Agent 并行。隐身协作的双子类型已经覆盖了"多视角"需求。

### ❌ Cherry Studio 的"MCP 服务器集成"

**理由**：当前 Sidemate 的工具系统已经够用，MCP 会增加复杂度。等用户有明确需求再考虑。

---

## 六、总结

### 核心启示

1. **细节决定体验**：Cherry Studio 的很多小设计（Token 计数、清除上下文、拖拽排序）成本低但体验提升明显
2. **结构化思维**：LobeHub 的 Fleet 模型启示我们，"多视角对比"应该有清晰的视觉分区
3. **渐进披露**：两个产品都用 Beta 标签 + 引导来管理复杂功能，Sidemate 的隐身协作双子类型可以借鉴
4. **品牌化**：连 Loading 都要品牌化，Sidemate 的 logo.svg 升级后应该全链路应用

### 给 P5 的具体建议

把 🥇 P5 应该做的 7 项加入 PATCH5-PLAN.md 的 C4（空状态 + 反馈）或新增 C7（前端体验细节）。

---

*本文档为竞品调研参考，不涉及代码复制。所有借鉴均为设计理念层面。*
