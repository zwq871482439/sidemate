# Patch4 文档 Agent 修复方案 v2.1（最终定稿）

> 2026-06-15 多轮讨论后定稿。基于 P4 灰度测试数据分析 + 架构讨论。
> v1 → v2 核心变化：引入 workspace 工作区、双入口同工具集、UI 状态机、消除后端续写识别。
> v2 → v2.1 变化：补充灰度测试发现的稳定性问题（KB 索引原子写入 + 云端 API 超时重试）。

## 背景

P4 灰度测试暴露 6 个核心问题：
1. Chat 模式执行 DocAction 时，模型陷入 search_web 循环（10 次/0 次 fetch），文档写不完
2. 文档生成路径不跟 session，模型看不到自己写了啥，无法续写
3. "继续"/"写完了吗" 被 drift 检测当成新话题，又开新一轮 doc 任务
4. 用户不知道文档写到哪了，只能看 UI 转圈
5. KB 对比模式两边文字量差异大（本地 450 字 vs 融合 1100 字）
6. 轮次上限 10 次对长文档不够

---

## 核心架构决策（3 项）

### 决策 1：引入 Session Workspace（会话工作区）

每个 chat session 下新增 `workspace/` 子目录，作为模型的"工作台"。模型通过 4 个工具自由读写辅助文件（大纲、草稿、笔记、参考资料）。

```
data/chats/{chat_id}/
├── messages.json       ← 系统管，模型不能碰
├── meta.json           ← 系统管，模型不能碰
├── assets/             ← 用户上传，模型只读
├── docs/               ← 结构化文档（write_section 产出 + docx）
│   ├── doc_xxx.json    ← 文档状态
│   └── doc_xxx.docx    ← 最终产物
└── workspace/          ← 🆕 模型工作台（自由读写）
    ├── outline.md      ← 大纲
    ├── draft.md        ← 草稿
    └── refs.json       ← 参考资料
```

**安全边界（铁律）**：模型只能在 `workspace/` 子目录内操作，禁止 `../` 跳出，禁止绝对路径，禁止碰系统文件。

### 决策 2：双入口 + 同工具集

保留两个 UI 入口（"文档生成" / "智能聊天"），但底层工具集 100% 一致。**两个模式都有 write_section、set_doc_status、workspace 工具**。

差异只在：
- **System Prompt**：doc 模式强引导文档流程，chat 模式中立（提示有能力但让模型自主）
- **UI 默认行为**：见决策 3

**action_mode 从"能力开关"降级为"行为引导"**：不再决定有没有 write_section 工具，只影响 system prompt 文本。

### 决策 3：UI 状态机驱动

前端 UI 状态**不看用户点了哪个按钮，只看 SSE 事件流**。

```
状态 1: 纯对话（无文档）
  触发: 未收到 write_section 相关事件
  UI: 普通对话气泡 + 工具状态条

状态 2: 文档写作中
  触发: 第一次收到 write_section 的 agent_status(phase=start)
  UI: 自动展开"文档进度面板"（章节列表 + 工具耗时）
  对话气泡照常显示模型文字

状态 3: 文档完成
  触发: 收到 doc_complete 事件
  UI: 进度面板变绿 + 下载按钮
```

**关键**：chat 模式下模型自己调 write_section，UI 也会自动切换到进度面板，体验完全一致。

---

## 4 层修复架构

按"谁负责"分四层，避免互相叠改：

| 层 | 职责 | 谁来做 |
|----|------|--------|
| **A 基础设施** | 给模型提供能力（工具+持久化+注入） | 我们写代码 |
| **B 边界护栏** | 防模型犯傻的硬限制 | 我们写代码 |
| **C 体验层** | 给用户看的（进度条+融合质量） | 我们写代码 |
| **D 模型行为** | 模型自主决策（搜几次/续不续写） | 只改 prompt 文字 |

---

## 修复点详细方案（6 个）

### 修复 1：文档状态化 + Session Workspace（A 层）

**目标**：让模型写章节时自动落盘，并能自主调用工具标记文档状态。同时提供 session 级工作区。

**1.1 文档状态持久化**

数据结构（`data/chats/{chat_id}/docs/{doc_id}.json`）：
```json
{
  "doc_id": "doc_20260614_224105",
  "topic": "兵棋推演文档",
  "status": "ongoing",
  "sections": [
    {"heading": "第一章 概述", "content": "...", "ts": "..."}
  ],
  "created_at": "...",
  "updated_at": "..."
}
```

流程：
1. doc 模式启动 / chat 模式第一次 write_section → 自动创建 `status=ongoing` 记录
2. 每次 write_section → 立即追加到 sections 并落盘（盖一层看到一层）
3. 模型自己判断写完 → 调 `set_doc_status("completed")`
4. pipeline 末尾兜底：模型输出纯文本且不再调工具 → 自动标 completed
5. 触达 20 轮上限 → 保持 ongoing（让用户能"继续"）

**1.2 新增工具 set_doc_status**

注册到 TOOL_REGISTRY，让模型自主标记文档状态：
```python
"set_doc_status": {
    "schema": {
        "type": "function",
        "function": {
            "name": "set_doc_status",
            "description": "更新当前文档状态。所有章节写完后调用 status='completed'。",
            "parameters": {
                "type": "object",
                "properties": {
                    "status": {"type": "string", "enum": ["ongoing", "completed"]}
                },
                "required": ["status"]
            }
        }
    },
    "condition": None,  # chat 和 doc 模式都可用
}
```

**1.3 Session Workspace 工具集（4 个）**

```python
"list_workspace": {
    "description": "列出你的工作区文件（大纲、草稿、笔记等）",
    "parameters": {}  # 无参数
}
"read_workspace": {
    "description": "读取你工作区的某个文件",
    "parameters": {"path": "string"}  # 相对 workspace/ 的路径
}
"write_workspace": {
    "description": "写入文件到你的工作区（大纲、草稿、笔记等）",
    "parameters": {"path": "string", "content": "string"}
}
"delete_workspace": {
    "description": "删除工作区的某个文件",
    "parameters": {"path": "string"}
}
```

安全实现（`core/doc_session.py`）：
```python
def safe_workspace_path(chat_id, rel_path):
    workspace_root = os.path.join(CHAT_DIR, chat_id, "workspace")
    abs_path = os.path.normpath(os.path.join(workspace_root, rel_path))
    if not abs_path.startswith(workspace_root + os.sep) and abs_path != workspace_root:
        raise ValueError("路径越界")
    return abs_path
```

**1.4 write_section 工具 condition 改动**

从 `condition: "doc_mode"` 改为 `condition: None`（双模式都可用）。

### 修复 2：会话上下文注入（A 层）

**目标**：让模型看到自己干过啥，避免重复搜索 + 支持续写判断。

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

注入内容（4 类）：
1. **会话文件清单**（`data/chats/{chat_id}/assets/`）：文件名+类型+大小
2. **已生成文档列表**（`data/chats/{chat_id}/docs/`）：标题+章节数+状态
3. **工具调用历史**（从 `messages.json` 的 `agent_timeline` 提取）：搜过啥、fetch 过啥
4. **KB 标签概览**（保留现有逻辑）：`学习方法(2) 协同管理(1)...`
5. **workspace 文件清单**：文件名+大小（不含内容，模型自己 read_workspace）

**注入格式示例**：
```
[会话上下文]
📎 上传文件：兵棋推演模板.docx（模板，12KB）

📄 文档状态：
- 《兵棋推演文档》（6章，已完成）
- 《协调 vs 协同》（3章，写作中）

🧰 工作区文件：
- outline.md（234字）
- refs.json（156字）

🔍 本次会话工具调用历史：
- search_web: "兵棋推演"(10条), "wargaming"(8条)
- fetch_url: rand.org/...(2.3s)
- search_kb: "兵棋推演"(无结果)

📚 KB 标签概览：学习方法(2) 协同管理(1) AI落地(1)
```

**token 预算**：会话上下文总量上限 5000 token，超限按优先级裁剪：工具历史 > 文档列表 > 文件清单 > workspace 清单 > KB 标签。

**关键效果**：模型看到工具历史就不会重复搜索；看到 ongoing 文档用户说"继续"，模型自己判断要不要续写（**不再后端做关键词识别**）。

### 修复 3：轮次护栏 + 子类限制（B 层）

**目标**：防死循环 + 防 token 爆炸，但不阻碍长文档。

**改动**（`core/agent_loop.py`）：
```python
MAX_ROUNDS = 20                    # 总轮次（从 10 提到 20）
TOOL_LIMITS = {                    # 子类硬限制
    "search_web": 3,
    "search_kb": 2,
    "fetch_url": 5,
    # write_section / set_doc_status / workspace 工具不限制
}
```

**子类超限处理**：硬移除工具（不是 prompt 建议）：
```python
for tool_name, count in tool_counts.items():
    limit = TOOL_LIMITS.get(tool_name)
    if limit and count >= limit:
        tools = [t for t in tools if t["function"]["name"] != tool_name]
```

**剩 5 轮预警**：通过 tool_result 的 hint 注入：
```python
if MAX_ROUNDS - rounds <= 5:
    hint = f"⚠️ 你还剩 {MAX_ROUNDS - rounds} 轮预算，请尽快完成剩余章节或调用 set_doc_status('completed')"
```

**两模式一致**：chat 和 doc 模式都应用子类限制。

### 修复 4：Prompt 重写（D 层）

**目标**：只改 prompt 文字，让模型自己规划行为。chat 和 doc 两套 prompt 都要改。

**4.1 doc 模式 prompt**（`_DOC_BASE_PROMPT` 重写）：
```
你是桌伴的智能文档助手。用户选择了"文档生成"模式，明确想要一份文档产物。

## 文档生成流程
1. 【检索】先 search_kb 查知识库，再 search_web 补充（每个最多2-3次）
2. 【阅读】对最相关的1-2条搜索结果，用 fetch_url 读取正文
3. 【大纲】可以先用 write_workspace 写到大纲文件
4. 【写作】逐章节调用 write_section，每章节至少2-3段实质内容
5. 【完成】所有章节写完后，调用 set_doc_status("completed")

## 工具调用预算
- 总计最多 20 轮工具调用
- 搜索类（search_kb + search_web）：建议 3-5 轮
- 阅读类（fetch_url）：建议 1-3 轮
- 写作类（write_section）：剩余轮次全部用于写作
- 注意剩余轮次：剩 5 轮时必须开始收尾

## 注意事项
- 你能看到[会话上下文]，包括之前搜过的关键词——不要重复搜索
- 如果看到有 ongoing 状态的文档，且用户意图是继续，请从下一章节接着写
- 禁止只搜索不阅读（fetch_url）就开始写作
- 你有工作区（workspace），可以写大纲、草稿、笔记等辅助文件
```

**4.2 chat 模式 prompt**（`_AGENT_BASE_PROMPT` 追加一段）：
```
你具备完整的文档生成能力。
当用户要求"写文档/总结一份/生成报告"时，请直接调用 write_section 工具逐章写入，
完成后调用 set_doc_status("completed")。前端会自动展示文档进度面板。
你有工作区（workspace）可用于存放大纲、草稿等辅助文件。
```

**4.3 search_web 工具描述补充**：
```
"搜索结果只是摘要，要获取完整内容必须接着调用 fetch_url。"
```

### 修复 5：UI 状态机 + 进度可视化（C 层）

**目标**：前端根据 SSE 事件自动切换 UI，进度面板两模式共享。

**5.1 新增/改造 SSE 事件**：

| 事件 | 触发时机 | 数据 |
|------|---------|------|
| `doc_started` | 第一次 write_section 执行前 | `{topic, doc_id}` |
| `agent_status`（改造） | 每个工具调用 start/done | 增加 `phase`(start/done) + `ts`(时间戳) + `elapsed_ms` |
| `section_done` | 每个 write_section 完成 | `{heading, index, total_so_far}` |
| `doc_complete` | set_doc_status("completed") 或兜底 | `{sections, doc_url, filename, total_time}` |

**5.2 前端 DocProgressTracker**（`static/js/chat.js` 新增类）：

```javascript
class DocProgressTracker {
    constructor() {
        this.active = false;
        this.sections = [];
        this.currentSection = null;
        this.toolHistory = [];
        this.startTime = null;
    }
    
    onSSEEvent(event, data) {
        // 第一次 write_section → 激活进度面板
        // section_done → 章节加到列表
        // agent_status done → 工具历史记录（带耗时）
        // doc_complete → 收尾 + 下载按钮
    }
}
```

**5.3 进度面板视觉**：

未激活时完全不显示（零干扰）。

激活时（chat 和 doc 模式一致）：
```
┌─────────────────────────────────────────┐
│ 📄 兵棋推演文档                    ⏱ 5'23" │
├─────────────────────────────────────────┤
│ ✅ 🔍 搜索"兵棋推演"      10 条 (0.6s)  │
│ ✅ 🔗 阅读 rand.org/...         (2.3s)  │
│ ✅ ✏️ 第一章 概述               (45.2s) │
│ 🔄 ✏️ 第二章 历史  (写作中 12s)          │
└─────────────────────────────────────────┘
```

完成后变绿 + 下载按钮。

### 修复 6：融合去重 + 知识密度（C 层）

**目标**：解决 KB 对比模式两边文字量失衡。

**改动**（`prompts.py` 的 `MERGE_FUSION_PROMPT` 重写）：
```
你的任务是产出一份高知识密度的回答。

原则：
1. 核心事实以【本地知识库】为准（用户私有文档更权威）
2. 【云端AI】的内容只用于补充本地没有的事实或提供更广视角
3. 禁止简单拼接两个来源——必须去重择优
4. 追求信息密度：每句话都要有价值，删掉重复表述和过渡废话
5. 目标长度：不超过 max(本地, 云端) × 1.2 倍
```

### 修复 7：KB 向量索引原子写入（B 层，来自灰度测试漏 2）

**来源**：P4 灰度测试 `server.log` 出现：
```
[KB] 清理残留临时文件: kb_vec_ajil1me1.tmp.npz (×4 个)
[KB] 向量索引文件异常（0 字节），视为损坏并删除
```

**根因**：KB 向量索引写入时被进程退出/重启打断，留下 0 字节文件和 .tmp.npz 残留。当前代码有"检测损坏就删除"的兜底，但没有**原子写入保护**。

**改动**（`knowledge/search.py` 的索引保存函数）：
```python
def save_vector_index(vectors, path):
    """原子写入：写到临时文件 → rename 到目标路径"""
    tmp_path = path + ".tmp"
    np.savez(tmp_path, vectors=vectors)
    # Windows 下 os.replace 是原子的（跨文件系统也能用）
    os.replace(tmp_path, path)
```

**附带**：启动时清理所有 `.tmp.npz` 残留（已有逻辑，确认生效）。

**影响范围小**：只改 1 个函数。

### 修复 8：云端 API 超时重试（B 层，来自灰度测试漏 4）

**来源**：P4 灰度测试 `server.log` 出现：
```
[ERROR] [CLOUD-WT] 异常: The read operation timed out
```

**根因**：GLM 云端 API 偶发超时，当前代码超时就直接中断整个 agent 任务，没有重试。配合修复 1（文档落盘）后可以从断点续写，但单次超时就失败的体验仍然不好。

**改动**（`core/cloud_engine.py` 的 `run_with_tools()` 和 `run()`）：
```python
MAX_RETRIES = 2
RETRYABLE_ERRORS = ("read operation timed out", "connection reset", "503")

def _is_retryable(error):
    err_lower = str(error).lower()
    return any(e in err_lower for e in RETRYABLE_ERRORS)

# 在 stream 调用外层包一层重试
for attempt in range(MAX_RETRIES + 1):
    try:
        yield from self._stream_once(...)
        return
    except Exception as e:
        if attempt < MAX_RETRIES and _is_retryable(e):
            log.warning("[CLOUD] 第 %d 次重试（%s）", attempt + 1, str(e)[:80])
            time.sleep(1.0 * (attempt + 1))  # 简单退避
            continue
        raise  # 非重试错误或重试用完，抛出
```

**重试策略**：
- 只重试网络类错误（timeout / connection reset / 503）
- 最多重试 2 次，退避 1s/2s
- 业务错误（401/400/429）不重试

---

## 与原 7 点方案的差异

| 原 v1 方案 | v2 方案 | 变化原因 |
|-----------|---------|---------|
| 修复 2 续写识别（后端关键词匹配） | **删除** | 改由模型自主判断（看到 ongoing 文档自己决定） |
| 修复 3 搜索成瘾治理（独立修复点） | **合并到修复 4 prompt 重写** | 治理核心是 prompt + 工具历史注入，不是独立逻辑 |
| 修复 4 渐进式章节 + 轮次 | **拆分**：轮次→修复 3，章节→prompt 重写 | 避免同一个文件叠改 |
| - | **新增** Session Workspace | 模型需要工作台 |
| - | **新增** 双入口同工具集 | chat 模式也能写文档 |
| - | **新增** UI 状态机 | 两模式体验一致 |

---

## 文件改动清单（11 个）

| 文件 | 改动类型 | 归属修复 | 关键改动 |
|------|---------|---------|---------|
| `core/doc_session.py` | **新增** | 1 | 文档状态管理 + workspace 路径安全 + 文件操作函数 |
| `core/agent_tools.py` | 改 | 1,4 | 新增 set_doc_status + 4 个 workspace 工具 + write_section 改无条件 + 两套 prompt 重写 |
| `core/agent_loop.py` | 改 | 1,2,3 | workspace 工具执行 + 轮次护栏 + 子类计数 + 上下文注入 + doc_started/section_done 事件 |
| `core/cloud_engine.py` | 改 | 8 | run_with_tools / run 加重试逻辑（网络错误重试 2 次） |
| `knowledge/search.py` | 改（小） | 7 | 向量索引保存改原子写入（tmp + rename） |
| `pipelines/cloud_pipeline.py` | 改 | 1,5 | doc 模式初始化 doc_session + 末尾兜底 + doc_complete 事件 |
| `prompts.py` | 改 | 6 | MERGE_FUSION_PROMPT 重写 |
| `static/js/chat.js` | 改 | 5 | DocProgressTracker + UI 状态机 |
| `static/css/main.css` | 改（小） | 5 | 进度面板样式 |
| `routers/files.py` | 改 | 1 | 文档下载 API 加 chat_id + workspace 文件 API |
| `session/chat_store.py` | 改（小） | 1 | docs/ + workspace/ 子目录管理 |

**1 新增 + 10 改动**。

---

## 实施顺序建议

按依赖关系分 4 批：

**Batch 1（A 层基础设施）**：修复 1 + 修复 2
- 新建 `doc_session.py`
- 改 `agent_tools.py`（工具注册 + prompt）
- 改 `agent_loop.py`（工具执行 + 持久化 + 注入）
- 改 `chat_store.py`（子目录管理）
- 改 `files.py`（API）

**Batch 2（B+D 层护栏和行为）**：修复 3 + 修复 4
- 改 `agent_loop.py`（轮次护栏 + 子类计数）
- prompt 文字定稿（已在修复 4 方案里）

**Batch 3（稳定性补丁）**：修复 7 + 修复 8
- 改 `knowledge/search.py`（向量索引原子写入）
- 改 `core/cloud_engine.py`（超时重试）

**Batch 4（C 层体验）**：修复 5 + 修复 6
- 改 `cloud_pipeline.py`（SSE 事件）
- 改 `chat.js` + `main.css`（UI 状态机）
- 改 `prompts.py`（融合去重）

---

## 验收标准

- [ ] doc 模式写文档：进度面板自动展开，章节实时显示，完成后有下载按钮
- [ ] chat 模式说"写文档"：同样自动展开进度面板，体验一致
- [ ] 文档中断后用户说"继续"：模型看到 ongoing 状态，从下一章接着写
- [ ] 搜索不再成瘾：search_web ≤3 次，至少 1 次 fetch_url
- [ ] 长文档（>10 章）：20 轮内能写完，或剩 5 轮时自动收尾
- [ ] workspace 文件操作：模型能写大纲、读回、删草稿，路径越界被拦截
- [ ] KB 对比模式：融合结果长度 ≤ max(本地,云端)×1.2，无简单堆叠
- [ ] 删 chat：docs/ 和 workspace/ 全部清理，零残留
