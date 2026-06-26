# 0.9.6 打磨清单 (13 项) — 排查结果 + 方案

---

> ## ✅ 状态总览（2026-06-26 回写）
>
> **13 项全部已完成或演进**，详见下表。本清单保留作历史记录，不再有待办项。
>
> | 编号 | 状态 | 落地位置 |
> |------|------|---------|
> | #1 模式切换预检 | ✅ 已实现 | `settings.js:_executeModeSwitch` 104-131 |
> | #2 离线 Chat 界面 | ✅ 已实现 | 标签前缀「离线 AI」+ `kb_qa` action |
> | #3 在线 Chat token 条 | ✅ 已实现 | `chat.py` `cloud_context_window` 动态取 |
> | #4 并行 Chat 界面 | ✅ 已实现 | `settings.js:340` 双模型 + 硬编码 action |
> | #5 并行齿轮 | ✅ 演进为内联开关 | `ui-enhance.js` 已重构（优于齿轮） |
> | #6 设置 Tab 齿轮 | ✅ 已实现 | `index.html:362` |
> | #7 KB 底部统计 | ✅ 已实现 | `index.html #kbStats` + `qa.js:470` |
> | #8 KB 分类聚散 | ✅ 已实现 | `prompts.py:225` prompt 约束 |
> | #9 KB 卡片信息 | ✅ 已实现 | `qa.js:347-349` 词元+搜索次数 |
> | #10 KB 概览刷新 | ✅ 已实现 | `kb.py:2514/2530` GET+POST |
> | #11 上传浮动条展开 | ✅ 已是现状 | `kbFloatList` 默认全展开 |
> | #12 摘要队列串行 | ✅ 已是现状 | tagging 单 worker + FIFO + batch gating |
> | #13 KB 概览计数 | ✅ 已实现 | 用聚类分布精确计数 |
>
> 附：审计 B9 死代码 `cancel_doc_action`（`doc_action.py:186`）已删除（2026-06-26）。

---

## P0 — 阻断性问题

### #1 模式切换缺提示
**排查结果**：`chat-ui.js:70-136` 的 `updateChatOverlay()` 已实现文案，但 chat 输入框仍在 overlay 后面可操作（layover 不阻止输入）。

**方案**（3 处微调）：
- 离线：已有「本地模型未加载」遮罩，添加「LLM 未预热」状态检测（API 返回 `ready=false` 时显示）
- 在线：已有「需要云端 API」遮罩，文字改为更友好：「在线模式需要配置云端 API 密钥，请前往设置页完成配置」
- 并行：在 `_executeModeSwitch` 中增加前置检查，调用 `/api/status` 判断 LLM 是否 ready + 云端是否配置，任一不满足则弹出 toast 提示并阻止切换

**改动文件**：`chat-ui.js` 3 行文案 + `settings.js:_executeModeSwitch` 加 10 行预检逻辑

---

### #2 离线 Chat 界面
**排查结果**：
- 模型标签 `modelTag` 显示原始模型名 `qwen3-5-4b:latest`，无标注
- 后端 `/api/action/list` 只返回 `chat` 和 `doc`，缺少 `kb_qa`

**方案**：
- 模型标签改为 `离线 AI · qwen3-5-4b`（`settings.js:283-289` 离线分支加前缀）
- 后端 action_registry.py 恢复 `kb_qa` action（或硬编码到 `chat-actions.js` 本地模式按钮列表）

**改动文件**：`settings.js` 1 行 + `chat-actions.js` 3 行（硬编码 kb_qa 按钮）

---

### #3 在线 Chat 界面
**排查结果**：
- 模型标签显示 `deepseek-v4-flash`，无标注
- Token 条调用 `/api/context/usage`，后端返回 `total_tokens` 用的是默认值 16384，没有按模型字典动态匹配

**方案**：
- 模型标签改为 `在线 AI · deepseek-v4-flash`（`settings.js:281-285` 加前缀）
- Token 条：后端 `/api/context/usage` 增加 `cloud_context_window` 读取，按 cloud_model 从 MODEL_CAPABILITIES 字典取实际值

**改动文件**：`settings.js` 1 行 + `routers/chat.py` `/api/context/usage` 加 5 行

---

### #4 并行 Chat 界面
**排查结果**：
- 当前只显示单个模型名（本地模型）
- 并行模式 action 按钮由 `chat-actions.js:68` 从 API 获取（和离线一样），应是硬编码为 KB 问答+聊天

**方案**：
- 模型标签改为 `本地 qwen3-5-4b + 云端 deepseek-v4-flash`，占一行，用 `·` 分隔
- action 按钮：硬编码 `知识库问答` + `聊天`（并行专属，不调 `/api/action/list`）
- Token 条：双列设计——`本地 0/16K（充足）` + `云端 —`（云端不显示 token，因为它用 API）

**改动文件**：`settings.js` 加并行分支 + `chat-actions.js` 加并行硬编码 + `index.html` Token 条加双列结构

---

## P1 — 体验问题

### #5 并行齿轮
**排查结果**：`ui-enhance.js:312-320` 的 `_renderGearMenu` 创建了齿轮按钮，但用的是自定义 SVG（可能不对）。

**方案**：替换 SVG 为 `iconSvg('gear','14')`，位置保持在 `actionBar` 右侧（已在 `chat-actions.js:103` 调用，位置正确）

**改动文件**：`ui-enhance.js` 1 行

---

### #6 设置 Tab
**排查结果**：`index.html` 设置导航第二项「常规」用了不同的 SVG（加号形状），不是齿轮。

**方案**：把「常规」的 SVG 换成 `iconSvg('gear','14')`（和 iconSvg 里已有的 gear 图标一致）

**改动文件**：`index.html` 1 行

---

### #7 KB 底部统计
**排查结果**：目前 KB 页底部无统计信息。

**方案**：在 `kbFullInterface` 底部新增 `<div id="kbStats">`，显示：
```
共 5 篇文档 · 已索引 17 块 · 占用 38 KB
```
（数据从 kb_meta.json 或前端已有数据获取）

**改动文件**：`index.html` 加 DOM + `qa.js` 加刷新逻辑

---

### #8 KB 分类聚类
**排查结果**：5 篇中医文档各有独立 category（中医健康/流派/病机/走势/秘传），无法合并。后端 tagging 使用 LLM 输出单一 category，LLM 自然生成了细分。

**方案**（两条路径）：
- **方案 A（轻量）**：在 prompt 里加约束「category 应尽量归类到更宽泛的主题，粒度控制在 5-8 个大类」
- **方案 B（前端聚合）**：前端展示时，检测同名前缀（如前 2 字相同）自动合并为「中医（5）」——但这个是后缀方案，不建议

**推荐方案 A**，只改 `tagging_scheduler.py:prompt` 里的 category 约束。

**改动文件**：`tagging_scheduler.py` 1 行 prompt

---

## P2 — 数据准确性问题

### #9 KB 卡片信息
**排查结果**：`qa.js` 中 KB 卡片渲染在 `kbRenderDocCards` 附近，当前显示格式是 size/chunks/tokens/hit_count。

**方案**：改文案为
```
文件大小 6.5 KB · 约 2.3K 词元 · 被搜索 18 次
```
去掉块数（chunks），用户不需要关心底层切了多少块。

**改动文件**：`qa.js` 卡片渲染函数 3 行

---

### #10 KB 概览刷新
**排查结果**：前端 `qa.js` 中刷新按钮的 onclick 只调了 `kbRefreshSummary()`，没有实际发请求。

**方案**：
- 后端新增 `POST /api/kb/overview/refresh`，用本地 LLM 重新生成概览并写回 kb_meta
- 前端点击刷新 → 按钮变「重新生成中...」→ 调 API → 显示结果 → 恢复按钮文字

**改动文件**：`routers/kb.py` 加 30 行 + `qa.js` 加 15 行

---

### #11 上传处理列表
**排查结果**：`kb-batch.js` 中浮动条 `kbFloatBar` 默认折叠，只显示「处理中 N 项」。

**方案**：浮动条默认展开，显示每项的实时状态（提取中 → 切块中 → 向量化中 → 入库完成 → 摘要生成中），通过 SSE 事件驱动

**改动文件**：`kb-batch.js` 和 `routers/kb.py` 上传 SSE 流

---

### #12 摘要生成队列
**排查结果**：`tagging_scheduler.py` 使用 P2 队列（`batch_queue`），多个文档同时入队后并发执行。

**方案**：改为单文档串行（`batch_queue` 配置 `concurrency=1`），每个文档摘要完成后才处理下一个

**改动文件**：`tagging_scheduler.py` 1 行配置

---

### #13 KB 概览计数
**排查结果**：LLM 生成概览时未准确计数（可能是 prompt 没传文档总数）

**方案**：在概览 prompt 中注入「当前知识库共 N 篇文档」，确保计数准确

**改动文件**：后端概览生成函数 prompt 模板 1 行
