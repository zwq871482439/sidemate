# Patch4 Workspace 统一改造方案（v3 最终定稿）

> 2026-06-16 多轮讨论后定稿。基于 v2.1 实施+测试反馈，将"文档生成"从特殊工具改造为通用 workspace 操作。
> 核心思想：**workspace 是模型的舞台，文档只是 workspace 里的一种 .md 文件**。

## 一、设计哲学

### v2.1 的问题

- `write_section` 是业务专用工具，跟通用 `write_workspace` 并存——违背"通用工具优先"
- 文档状态用独立 `doc_session.json` 维护，跟 workspace 文件系统割裂
- 模型被强制"逐章调用 write_section"，无法自由组织文档结构
- 续写靠后端猜（找 ongoing 文档），猜错就新建

### v3 的统一

**只有一个工作空间 workspace/**，模型在里面自由读写。文档只是 workspace 里的一种 `.md` 文件，后端负责把 `.md` 转成 `.docx`。

```
data/chats/{chat_id}/
├── messages.json
├── meta.json
└── workspace/             ← 模型的舞台（v2.1 已有）
    ├── outline.md         ← 大纲
    ├── notes.md           ← 笔记
    └── 团队协作.md        ← 文档（v3 新增能力：可转 docx）
```

## 二、工具集（从 9 个精简到 6 个，全通用）

| 工具 | 签名 | 作用 |
|------|------|------|
| `list_workspace` | `()` | 列出 workspace 所有文件 |
| `read_workspace` | `(path)` | 读 workspace 文件 |
| `write_workspace` | `(path, content)` | 写 workspace 文件（**支持完整 Markdown 文档**） |
| `delete_workspace` | `(path)` | 删 workspace 文件 |
| `list_docs` | `()` | 列出可下载文档（workspace 里的 .md 文件 + 转换状态） |
| `set_doc_status` | `(filename, status)` | 标记某 .md 文档状态（completed 触发生成 docx） |

### 删除的工具

- ❌ `write_section`（被 `write_workspace` 取代）

## 三、状态管理（基于文件 + 显式标记）

### 文档隐式状态

| 状态 | 触发 | UI 表现 |
|------|------|---------|
| **drafting**（写作中） | `write_workspace` 写过 .md 但没标 completed | 进度面板显示"🔄 {filename} 写作中" |
| **completed**（已完成） | `set_doc_status("{filename}", "completed")` | 触发生成 docx + 进度面板变绿 + 下载按钮 |

**关键**：状态**不需要独立 doc_session.json**，通过 `.md 文件存在性 + completed 标记列表` 推断。

### completed 文档列表持久化

`data/chats/{chat_id}/docs/.completed.json`（轻量级，只存文件名+时间）：
```json
{
  "团队协作.md": {"completed_at": "2026-06-16 22:30:00", "docx_generated": true},
  "会议纪要.md": {"completed_at": "2026-06-16 22:45:00", "docx_generated": true}
}
```

## 四、工作流（模型自主决策）

### 场景 1：写新文档

```
模型：write_workspace("团队协作.md", "# 团队协作实战手册\n## 一、核心要素\n...")
模型：set_doc_status("团队协作.md", "completed")
后端：触发 Markdown → docx 转换 → 生成可下载文件
```

### 场景 2：续写（同文档）

```
模型：read_workspace("团队协作.md")                          ← 读回
模型：write_workspace("团队协作.md", "...新增第4章...")       ← 覆盖更新
模型：set_doc_status("团队协作.md", "completed")             ← 重新生成 docx（覆盖）
```

### 场景 3：多文档（新建另一个）

```
模型：write_workspace("会议纪要.md", "# 会议纪要\n...")
模型：set_doc_status("会议纪要.md", "completed")
```

### 场景 4：用户说"再加一章到之前的"

```
模型：list_docs()                                              ← 看有哪些文档
模型：read_workspace("团队协作.md")                           ← 选一个读回
模型：write_workspace("团队协作.md", "...更新后全文...")       ← 覆盖
模型：set_doc_status("团队协作.md", "completed")             ← 重新生成
```

## 五、UI 进度面板改造

### 状态机（前端 DocProgressTracker）

```
状态 1：纯对话（无 write_workspace .md）
├── 触发：没收到 write_workspace 事件
└── UI：不显示进度面板

状态 2：文档写作中（write_workspace 写过 .md 但未 completed）
├── 触发：write_workspace 事件，写入的文件以 .md 结尾
├── UI：自动展开进度面板
│   ├── 📝 {filename} 写作中    ⏱ {elapsed}
│   ├── ✅ search_kb "xxx"  (0.6s)
│   ├── ✅ fetch_url xxx     (2.3s)
│   └── ✏️ write_workspace ({N} 次, {字数} 字)
└── 对话气泡正常显示

状态 3：文档完成（set_doc_status completed）
├── 触发：set_doc_status 事件，status=completed
├── UI：进度面板变绿 + 显示下载按钮
│   └── ✅ {filename} 已完成  共 {字数} 字  [下载 .docx]
└── 对话气泡正常显示
```

### 关键设计点

- **不再有"章节"概念**，只有"文件 + 字数"
- **图标用 SVG**（不用 emoji），符合前端 ui 风格
- **完成态保留在 UI 上**（不消失），用户可以随时下载

## 六、UI 状态切换（处理"思考中... 处理中... 思考中..."混乱）

### 问题

v2.1 测试发现工具调用过程中 UI 反复闪烁"思考中"→"处理中"→"思考中"，没有清晰的状态切换。

### 解决方案：每个新步骤开始时，前一步骤自动变 done

```javascript
// AgentTimeline 渲染逻辑
function pushTimelineStep(step) {
    // 前一步骤（current）改 done
    for (var i = timeline.length - 1; i >= 0; i--) {
        if (timeline[i].status === 'current') {
            timeline[i].status = 'done';
            timeline[i].elapsed = Date.now() - timeline[i].startTs;
            break;
        }
    }
    // 新步骤加 current
    step.status = 'current';
    step.startTs = Date.now();
    timeline.push(step);
    render();
}
```

### "思考"状态合并

- 同一轮 ReAct 内多次"思考"合并为一个步骤（显示"思考中 (N字)"，N 持续增长）
- 只有切换到工具调用（非思考）时，思考步骤才变 done

### 工具类型映射

| 工具 | UI 显示 |
|------|---------|
| search_kb | [搜索图标] 搜索知识库 "{query}" |
| search_web | [搜索图标] 搜索 "{query}" |
| fetch_url | [链接图标] 阅读 {url} |
| write_workspace | [编辑图标] 写入 {filename} |
| set_doc_status | [勾选图标] 标记 {filename} {status} |

## 七、showToast 修复（去除 HTML 注入）

### 问题

`chat.js` 多处 `showToast(iconSvg(...) + ' 文档撰写完成', 'success')`，但 `showToast` 设计只接收纯文本，`iconSvg` 的 SVG HTML 被部分场景渲染出来。

### 修复

- 去掉所有 `showToast(iconSvg(...) + ' xxx')` 调用里的 `iconSvg(...)` 前缀
- `showToast` 只接收纯文本消息
- Toast 自身的图标由 `type` 参数决定（success/error/info），不需要调用方注入

grep 全 `showToast(iconSvg` 调用点全部修正。

## 八、docx 生成时机

### 触发条件

只在 `set_doc_status(filename, "completed")` 时触发，**不在 write_workspace 时触发**：

```python
# agent_loop.py 工具执行分支
def _execute_set_doc_status(filename, status):
    if status == "completed":
        # 读 workspace/{filename}
        md_content = read_workspace_file(chat_id, filename)
        # 生成 docx（覆盖同名）
        docx_path = os.path.join(_docs_root(chat_id), filename.replace('.md', '.docx'))
        generate_docx(md_content, docx_path, title=_extract_md_title(md_content))
        # 标记完成
        mark_doc_completed(chat_id, filename)
    return {"success": True, "filename": filename, "status": status}
```

### docx 文件命名

`{原 .md 文件名}.docx`（去掉 .md 加 .docx），如：
- `团队协作.md` → `团队协作.docx`
- `outline.md` → `outline.docx`（但 outline 通常不标 completed）

### 续写时覆盖

续写时 `set_doc_status` 再次触发，docx 路径一样，**自动覆盖**。用户下载的永远是最新版。

### 兜底（模型不调 set_doc_status）

pipeline 末尾检查：如果本轮有 write_workspace .md 但没 set_doc_status completed → 不强制生成 docx（保持 drafting 状态）。

## 九、文件改动清单（5 个文件）

| 文件 | 改动 |
|------|------|
| `core/agent_tools.py` | 删除 write_section 注册；改造 set_doc_status（接收 filename）；新增 list_docs 工具；prompt 重写（删章节概念，改为"写完整 Markdown 文件"） |
| `core/agent_loop.py` | 删除 write_section 执行分支；改造 set_doc_status 执行（触发生成 docx）；新增 list_docs 执行；write_workspace 执行后维护文档隐式状态 |
| `core/doc_session.py` | 删除 DocSession 类 + 大量文档状态函数；保留 workspace 文件操作 + 路径安全；新增 completed 文档列表持久化（轻量 .completed.json） |
| `pipelines/cloud_pipeline.py` | 删除 docx 生成逻辑（搬到 set_doc_status 执行分支）；删除 doc_started/section_done SSE 事件；改造 doc_complete 事件由 set_doc_status 触发 |
| `static/js/chat.js` | 删除章节渲染（DocProgressTracker 改为文件+字数）；UI 状态机改造（思考合并、步骤切换）；去掉 showToast 的 iconSvg 前缀；进度面板 SVG 图标 |

## 十、不改的文件

| 文件 | 原因 |
|------|------|
| `pipelines/doc_action.py:generate_docx()` | 保持现有实现，docx 质量提升放 P5（引入 markdown2docx） |
| `session/chat_store.py` | 已支持 workspace 子目录，无需改 |
| `routers/files.py` | 已有 workspace 4 个 API，set_doc_status 不需要新 API |
| `static/css/main.css` | 进度面板样式沿用 v2.1（小调整） |
| `prompts.py` | MERGE_FUSION_PROMPT 已改好 |

## 十一、Prompt 重写

### doc 模式（_DOC_BASE_PROMPT）

```
你是桌伴的智能文档助手。用户选择了"文档生成"模式，明确想要一份文档产物。

## 工作流
1. 【检索】先 search_kb 查知识库，再 search_web 补充（每个最多 2-3 次）
2. 【阅读】对最相关的 1-2 条结果用 fetch_url 读正文
3. 【大纲】可以 write_workspace 写个 outline.md 理清结构
4. 【写作】用 write_workspace 写完整 Markdown 文档（含 # 标题、## 章节、内容）
5. 【完成】所有内容写完后调 set_doc_status("文件名.md", "completed")

## 工具调用预算
- 总计最多 20 轮工具调用
- 搜索类（search_kb + search_web）：建议 3-5 轮
- 阅读类（fetch_url）：建议 1-3 轮
- 写作类（write_workspace）：剩余轮次全部用于写作
- 剩 5 轮时必须开始收尾

## 注意事项
- 文档就是一个 workspace 里的 .md 文件，文件名用主题命名（如"团队协作.md"）
- 不要分多次调用 write_section——直接写完整篇 Markdown
- 不要在每次 write_workspace 后主动调 set_doc_status completed——保持 drafting 让用户能追加
- 只有用户明确说"写完了/可以了/不要更多了"时才调 set_doc_status completed
- 如果用户说"继续/追加/再加一章"，先 read_workspace 读回旧文档，再 write_workspace 覆盖更新
- 你能看到[会话上下文]，包括之前搜过的关键词——不要重复搜索
- 禁止只搜索不阅读（fetch_url）就开始写作
```

### chat 模式（_AGENT_BASE_PROMPT 追加段）

```
## 文档生成能力（chat 模式同样可用）
你具备完整的文档生成能力。当用户需要一份可下载的文档产物时：
1. 用 write_workspace 写完整 Markdown 文件（文件名用主题命名，如"团队协作.md"）
2. 只有用户明确说"写完了"时才调 set_doc_status("文件名.md", "completed")
3. 前端会自动展示文档进度面板 + 下载按钮

注意：纯文本回复不会生成文档。如果用户只是问问题，用正常回答即可；
只有用户明确要"文档/报告/总结一份"时才用 write_workspace 写 .md 文件。
```

## 十二、实施顺序

**单批完成**（寇豆码一次性改 5 个文件，严过关回归测试）：

1. 改 `core/doc_session.py`（删 DocSession，加 completed 持久化）
2. 改 `core/agent_tools.py`（删 write_section，改 set_doc_status，加 list_docs，重写 prompt）
3. 改 `core/agent_loop.py`（同步工具执行分支）
4. 改 `pipelines/cloud_pipeline.py`（删 docx 生成 + doc_started/section_done，改 doc_complete 触发）
5. 改 `static/js/chat.js`（UI 状态机 + showToast 修复 + SVG 图标）

## 十三、验收标准

- [ ] 模型用 write_workspace 写完整 Markdown 文档（不再调 write_section）
- [ ] set_doc_status completed 后能生成可下载的 .docx
- [ ] 续写：用户说"再加一章"，模型 read+write+set_doc_status，docx 自动覆盖更新
- [ ] 多文档：模型能写多个 .md 文件，分别 set_doc_status 生成多个 docx
- [ ] 进度面板显示"文件名 + 字数"，不再显示章节
- [ ] 进度面板用 SVG 图标（不用 emoji）
- [ ] UI 状态切换清晰：思考→工具→思考时前一步骤自动变 done，不闪烁
- [ ] showToast 不再注入 SVG HTML
- [ ] 完成态进度面板保留在 UI 上（不消失）
- [ ] docx 字体统一（等线 + Calibri，11pt）

## 十四、P5 后续（本方案不做）

- 引入 `markdown2docx` 替换自实现 `_parse_markdown_to_sections`（P5 5.9 节）
- docx 模板支持（封面、目录、页眉页脚）
- docx 高级元素（表格、图片、公式）
