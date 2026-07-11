# Patch 6：前端统一化 + 模式系统重构 + 明盒设计

> 状态：🧭 规划中 | 日期：2026-06-21
> 更新：桌面云（桌伴云）挪至 [PATCH8-BRAINSTORM.md](PATCH8-BRAINSTORM.md)；隐身协作→并行模式（2026-06-21 定稿）

---

## 一、模式系统重构（2026-06-21 定稿）

### 1.1 背景

当前模式系统混乱：
- **Chat Tab**：本地 / 云端 两档切换
- **文库 Tab**：独立对话窗口，带"云端对比"隐藏开关
- **痛点**：用户要在两个 Tab 之间切换才能用"本地安全+云端补充"；文库 Tab 职责不清

### 1.2 定稿架构（三模式，无子类型）

```
┌─ 模式选择（Chat Tab header 三段按钮）──┐
│  离线  │  在线  │  并行                │
└────────────────────────────────────────┘
```

| 模式 | 引擎 | 后端 pipeline | 数据流 | actions |
|------|------|-------------|--------|---------|
| 离线 | 仅本地 4B | `local_pipeline` | 0 字节出机器 | 聊天 / 文档生成 / 查知识库 |
| 在线 | 仅云端 | `cloud_pipeline` | 问题+历史出机器 | 智能对话 / 智能文档 |
| 并行 | 双轨独立 | `parallel_pipeline`（复用 compare_pipeline） | 问题出机器，KB 不出 | 无（自动融合） |

### 1.3 并行模式流程

```
每轮固定三步（pipeline 自动执行）：

Step 0: Reformulation（可选开关控制）
  默认：本地 4B 改写追问
  开关「允许云端模型生成关键词」开启时：云端拆解 3-5 个检索关键词 → bge-m3 用关键词多轮召回

Step 1: bge-m3 检索 KB → 4B 生成本地答案（KB System Prompt + chunks）
Step 2: 云端模型生成答案（纯问题，无 KB 上下文）
Step 3: 4B 自动融合（MERGE_FUSION_PROMPT，本地执行）

工具栏开关（仅并行模式可见）：⚙️ → 「允许云端模型生成关键词」
开关位置：并行模式工具栏右侧齿轮按钮下拉
默认：关闭
```

双线记忆：
  memory_local = 融合结果  → 下一轮本地历史
  memory_cloud = 云端答案  → 下一轮云端历史

云端永远看不到：KB chunks、本地答案、检索结果
```

**和现有 compare_pipeline 的差异**：本地列增加 `memory_local` 历史注入（当前 history=None）。

### 1.4 知识库 Tab 改造

- 文库 → **知识库**（纯档案管理，移除全部对话功能）
- 原 KB Tab 离线问答 → 离线模式「查知识库」action
- 原 KB Tab 云端对比 → 并行模式（搬入 Chat Tab）
- 保留：上传/删除/批量/打标/Tag 聚类/检索诊断/热力图

### 1.5 用户心智模型

| 改造前 | 改造后 |
|--------|--------|
| Chat Tab + KB Tab 两个地方对话 | 所有对话在 Chat Tab，按模式分流 |
| "云端对比"藏在 KB Tab 的隐藏开关 | 并行模式 = Chat Tab 第三档 |
| KB Tab 既管文档又管对话 | 知识库 Tab 只管文档管理 |

### 1.6 ClearBox 明盒设计（Layer 1 实时透明）

并行模式下 AgentTimeline 展示完整过程，用户可展开查看原始来源：

```
AgentTimeline（有 KB 时显示）：
  ● 本地知识库检索（3篇文档）
  ● 本地 AI 基于知识库生成回答
  ● 云端 AI 基于通用知识补充
  ● 本地自动融合优化
  ↓
  最终回答
```

### 1.7 实施清单

| 模块 | 改动 | 复杂度 |
|------|------|--------|
| 前端模式选择器 | 三段按钮：离线/在线/并行 | 低 |
| 前端确认弹窗 | 切换时弹窗+功能说明+风险告知 | 低 |
| 前端 AgentTimeline | 并行模式展示三步流程+可展开 | 中 |
| 前端消息渲染 | 融合答案 + 来源标注 | 中 |
| parallel_pipeline | 基于 compare_pipeline 增加本地 history 注入 | 低 |
| KB Tab 移除对话 | 删除问答区，保留管理区 | 低 |
| 离线模式加 action | 「查知识库」action 按钮 | 中 |
| 纪要模块 | 代码归档移除 | 低 |
| 前端整体重构 | 统一 UI：Token条/输入框融合/去骨架屏/SVG图标 | 高 |

---

## 二、设置页 Tab 化（从 P5 推迟）

### Tab 结构

```
[常规] [云端 AI] [知识库] [隐私安全] [关于]

常规：系统资源占用 / 数据目录 / 反馈渠道
云端 AI：API 配置 / Token 预算
知识库：文档统计 / 检索质量测试 / 权限管理
隐私安全：数据存储 / 隐私声明 / 数据导出
关于：版本号 / CHANGELOG / 系统诊断 / THIRD-PARTY
```

---

## 三、ClearBox 明盒设计

### 3.1 核心理念

三层透明：实时层（AgentTimeline + 思考动画）→ 回放层（Live Trace）→ 可视化层（HTML 产出）

### 3.2 可视化产出

- 沙箱 iframe + CSP 渲染云端生成的 HTML
- 本地模式用预设模板（4B 填 JSON，前端渲染）
- 导出 HTML / PNG / 嵌入 Markdown

### 3.3 实施优先级

| 优先级 | 任务 |
|--------|------|
| P0 | 沙箱 iframe + CSP |
| P0 | `render_html` 工具 + 云端自由 HTML |
| P1 | Live Trace 持久化 + 回放 UI |
| P1 | AgentTimeline 动画 |
| P2 | 本地模式预设模板 |
| P2 | 导出 PNG / 嵌入 Markdown |

---

## 四、KB Tag 智能归并 + 分组显示

### 4.1 算法

方案 D（推荐）：前缀匹配粗筛 + Embedding 细筛。新增 `tag_parent` 字段，原 tag 保留。

### 4.2 UI

平铺 ↔ 分组视图切换，树形展开/折叠面板/颜色标签。

---

## 五、P5 遗留技术债清理

### 5.1 死代码

- `_compress_cloud_history` (routers/chat.py:929)
- `check_topic_drift` (intelligence/task_classifier.py:174)
- 前端 `topic_drift` SSE 处理 + `showDriftBar` + `.drift-bar` CSS

### 5.2 全链路冗余

- `drift_hint` 参数链路（~30 文件）
- `_refFilePath` 混合语义 → 拆分为 `_kbRefDocId` / `_uploadedFileName`
- `token-estimator.js` 删除 `estimateTotal`

### 5.3 依赖清理

可删 13 包：jieba, rank_bm25, av, onnxruntime, mdurl, markdown_it, mdit_py_plugins, jiter, click, typer, shellingham, websockets, httptools, watchfiles, rich, pygments, google
保留：ctranslate2, faiss, scipy, sklearn, huggingface_hub 等间接依赖

---

## 六、从 P5 推迟的任务

### 6.1 C5 系统诊断

跟设置页 Tab 化一起做，放在「关于」Tab

### 6.2 前置条件

- 依赖清理需全量回归测试
- 纪要模块代码归档

---

## 七、前端原型

原型文件：`docs/prototypes/p6-chat.html` / `docs/prototypes/p6-kb.html`

| 元素 | Chat 页面 | KB 页面 |
|------|----------|---------|
| 模式选择 | 三段按钮（离线/在线/并行） | — |
| 确认弹窗 | 功能说明 + 风险告知 | — |
| Token 条 | 本轮 + 历史 = 总数/上限 · 状态 | — |
| 输入框 | 融合 + / textarea / 发送 | 搜索文件名 |
| AgentTimeline | 内联 AI 气泡 + 可展开 | — |
| 消息样式 | 气泡/论坛风切换 | — |
| 标签树 | — | 左侧父+子层级 |
| LLM 概览 | — | 紫色渐变摘要面板 |
| 文档卡片 | — | 标题+预览+标签+切块/Token+热力图圆点 |
| 骨架屏 | 删除（气泡自带状态过渡） | — |
| 品牌色 | 统一 #1E3A5F | 统一 #1E3A5F |

---

*本文档为 P6 实施阶段规划文档。*
