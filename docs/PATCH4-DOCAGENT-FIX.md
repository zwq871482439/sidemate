# Patch4 文档 Agent 修复方案（P4 灰度测试 Bug 修复）

> 2026-06-15 讨论定稿。基于 P4 灰度测试数据（D:/新建文件夹 (4)/data）分析得出。

## 背景

P4 灰度测试暴露 6 个核心问题：
1. Chat 模式执行 DocAction 时，模型陷入 search_web 循环（10 次/0 次 fetch），文档写不完
2. 文档生成路径不跟 session，模型看不到自己写了啥，无法续写
3. "继续"/"写完了吗" 被 drift 检测当成新话题，又开新一轮 doc 任务
4. 用户不知道文档写到哪了，只能看 UI 转圈
5. KB 对比模式两边文字量差异大（本地 450 字 vs 融合 1100 字）
6. 轮次上限 10 次对长文档不够

## 7 个修复点

### 修复 1：文档状态持久化（P0）

**位置**：`data/chats/{chat_id}/docs/{doc_id}.json`

**数据结构**：
```json
{
  "doc_id": "doc_20260614_224105",
  "topic": "给我总结一份关于兵棋推演方面的文档",
  "status": "ongoing",          // ongoing | completed | interrupted
  "sections": [
    {"heading": "第一章...", "content": "..."}
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

**改动**：
- 新增 `core/doc_session.py`：文档状态管理（加载/保存/列出/清理）
- `agent_loop.py` write_section 执行时立即持久化
- pipeline 在 docx 生成后把 status 改成 completed
- 中断时 status 保持 ongoing

**原则**：文档进度和产物都跟 chat 走，删 chat = 全清

### 修复 2：续写识别 + drift 修正（P0）

**位置**：`pipelines/cloud_pipeline.py` doc 模式分流

**续写意图识别规则**（正则 + 关键词）：
- "继续"、"接着写"、"写完"、"完成"、"go on"、"continue"
- "继续写"、"接着写第X章"
- 触发条件：session 有 ongoing 文档 + 用户输入匹配续写意图

**分流逻辑**：
- 有 ongoing 文档 + 续写意图 → 续写模式（注入已写章节到 prompt）
- 有 ongoing 文档 + 改话题 → 提示「上份文档《xxx》未完成，继续还是新建？」
- 无 ongoing 文档 → 正常新文档流程

### 修复 3：搜索成瘾治理（P0）

**根因**：doc 模式 prompt 只说"可以搜索"，没说必须 fetch，模型光搜不读。

**改动**：
- `_DOC_BASE_PROMPT` 重写，加硬约束
- `search_web` 工具描述加"必须 fetch_url 才能获取完整内容"
- 工具调用历史注入到 system prompt（见修复 7），让模型知道"搜过啥"

**新 doc prompt 核心约束**：
```
信息获取铁律：
1. 先 search_kb 查本地（1次）
2. 再 search_web 补充（最多2次）
3. 必须至少 fetch_url 1次 真正阅读网页内容
4. 然后立即开始 write_section
禁止：只搜索不阅读就写文档
```

### 修复 4：渐进式章节 + 轮次（P0）

**方案**：选项 D（总 20 轮 + 子类限制 + 模型感知 + 预警）

**子类限制**：
```
总轮次上限：20 轮
├── search_web：≤ 3 次
├── search_kb：≤ 2 次
├── fetch_url：≤ 5 次
└── write_section：无限制
```

**模型感知**：
- prompt 里写明预算：「你有最多 20 轮工具调用预算，搜索阶段 3-5 轮，阅读阶段 1-3 轮，剩余全用于写作」
- 剩余 5 轮时主动提示模型（通过 tool result 的 hint）

**write_section 工具返回**：
```json
{
  "success": true,
  "total_sections": 3,
  "next_hint": "请继续写下一章节，或直接给出最终回答结束文档生成"
}
```

### 修复 5：完成感知 + 进度可视化（P1）

**新增 SSE 事件**：
- `doc_complete`：文档完成（含 sections 数、doc_url）
- `agent_status` 增加 `phase`（start/done）和 `ts`（时间戳）字段

**前端进度条**：
```
📄 生成中：兵棋推演文档
✅ 🔍 搜索"兵棋推演" — 10 条结果 (0.6s)
✅ 🔍 搜索"wargaming methodology" — 8 条结果 (0.5s)
✅ 🔗 阅读 rand.org/wargaming... (2.3s)
✅ ✏️ 第一章 概述 (45.2s)
🔄 ✏️ 第二章 历史 (写作中... 32s)
⬜ 第三章 类型
```

### 修复 6：融合去重 + 知识密度（P1）

**位置**：`prompts.py` 的 `MERGE_FUSION_PROMPT`

**重写原则**：
```
你的任务是产出一份高知识密度的回答。

原则：
1. 核心事实以【本地知识库】为准（用户私有文档更权威）
2. 【云端AI】的内容只用于补充本地没有的事实或提供更广视角
3. 禁止简单拼接两个来源——必须去重择优
4. 追求信息密度：每句话都要有价值，删掉重复表述和过渡废话
5. 目标长度：不超过 max(本地, 云端) × 1.2 倍
```

### 修复 7：会话上下文注入（P0）

**隐私铁律**（写进代码注释）：
```python
# ⚠️ 注入云端的 system prompt 只能包含：
#   1. 用户主动上传的文件清单（文件名+类型，不含内容）
#   2. 云端自己生成的产物（文档列表）
#   3. 云端自己的工具调用历史
#   4. KB 标签概览（粗粒度，帮模型判断要不要检索）
# 绝不能注入：KB 文档清单、KB 文档摘要、KB 文档正文
# KB 信息只能通过 search_kb 工具按需获取
```

**注入内容**：
1. 会话文件清单（`data/chats/{chat_id}/assets/`）
2. 已生成文档列表（`data/chats/{chat_id}/docs/`）
3. 工具调用历史（从 `messages.json` 的 `agent_timeline` 提取）
4. KB 标签概览（保留现有逻辑）

**token 预算**：会话上下文总量上限 5000 token，超限按优先级裁剪（工具历史 > 文档列表 > 文件清单 > KB 标签）

## 文件改动预估

| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `core/doc_session.py` | 新增 | 文档状态管理 |
| `core/agent_loop.py` | 改 | 持久化 + 续写 + 轮次 + 上下文注入 |
| `core/agent_tools.py` | 改 | prompt 重写 + 工具描述 |
| `pipelines/cloud_pipeline.py` | 改 | doc 模式分流 + 续写 + 进度事件 |
| `pipelines/compare_pipeline.py` | 改 | 融合 prompt 传入（小改） |
| `prompts.py` | 改 | MERGE_FUSION_PROMPT + doc prompt |
| `static/js/chat.js` | 改 | 进度条 UI + doc_complete 处理 |
| `routers/files.py` | 改 | 文档下载 API 加 chat_id |
| `session/chat_store.py` | 改 | docs 子目录管理 |

共 9 个文件（1 新增 + 8 改动）。
