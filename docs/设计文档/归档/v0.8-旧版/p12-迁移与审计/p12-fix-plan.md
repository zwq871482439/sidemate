# Patch 12 修复方案

> 评审日期: 2026-05-29
> 基于审计报告 + 代码实际验证
> 状态: 规划完成，待执行

---

## 一、审计报告评审

Edward 的审计报告**质量很高**，所有发现的问题我都通过代码验证确认了。具体评价：

| 维度 | 评分 | 说明 |
|------|------|------|
| 问题准确性 | ⭐⭐⭐⭐⭐ | 每个问题都在代码中找到了对应行，行号精确 |
| 优先级判断 | ⭐⭐⭐⭐⭐ | P0/P1/P2 分级合理，P0 确实会导致崩溃 |
| 修复建议 | ⭐⭐⭐⭐ | 大部分建议可直接执行，个别细节需要补充 |
| 遗漏项 | ⭐⭐⭐⭐ | 没有覆盖 #81/#84 等前端问题（不在审计范围内，可以理解） |

**一个需要修正的地方**：报告 P2-01 说是"15 个文件"，实际根目录有 20 个 `.py` 文件，多出来的 5 个（`config.py`, `prompts.py`, `server.py`, `packager.py`, `skill_fileops.py`）不是"旧文件"而是仍在活跃使用的根目录文件。清理时只移除那 15 个有对应新包的文件。

---

## 二、修复方案（按执行顺序排列）

### Phase 0: Think Pipeline 修复（另一队 AI 负责）
- 修改 `chat_template.jinja` 删除空 think 标签注入
- 这个和下面的修复**互不冲突**，可以并行

### Phase 1: 旧 import 路径迁移（5 处改动，约 30 分钟）

必须**先做这一步**，否则后面删旧文件会导致崩溃。

#### 1.1 `server.py:124` — knowledge_base → knowledge 包
```
旧: from knowledge_base import get_knowledge_base
新: from knowledge import get_knowledge_base
```
**前提**：需要在 `knowledge/__init__.py` 中添加 re-export：
```python
from knowledge_base import get_knowledge_base, KnowledgeBase
```
注意：这里 `knowledge_base.py` 仍然是根目录的 re-export 桥，暂时保留。未来可以进一步把 KB 类迁入 knowledge 包。

#### 1.2 `core/model_manager.py:407,452,472` — knowledge_base → 依赖注入
```
旧: from knowledge_base import get_knowledge_base (在 3 个方法内部延迟导入)
新: 同 1.1，改为 from knowledge import get_knowledge_base
```
或者更好的方案：在 ModelManager.__init__ 中接受一个 `kb_provider` 回调参数，通过 `routers/deps.py` 注入。但这改动较大，建议先走简单路径（改 import），后续再重构。

#### 1.3 `routers/chat.py:728` + `routers/kb.py:481` — doc_reader → files 包
```
旧: from doc_reader import DocReader
新: from files.doc_reader import DocReader
```
两处完全一样的改动。

#### 1.4 `routers/settings.py:506` — sidemate_validator → validators 包
```
旧: from sidemate_validator import SidemateValidator
新: from validators.sidemate_validator import SidemateValidator
```

#### 1.5 `server.py:255-266` + `routers/settings.py:97-105` — __import__ 版本检查
```
旧 mod_name 列表: "task_classifier", "response_filter", "context_compressor", "models", "prompts", "skill_fileops", "doc_reader", "doc_writer", "config"
新 mod_name 列表: "intelligence.task_classifier", "intelligence.response_filter", "common.context_compressor", "core.model_manager", "prompts", "files.file_extractor", "files.doc_reader", "files.doc_writer", "config"
```
注意：`models` 没有 `__version__`，`core.model_manager` 有。`prompts`, `config`, `skill_fileops`(→`files.file_extractor`) 需要确认哪个有版本号。

### Phase 2: 根目录旧文件归档（约 10 分钟）

**Phase 1 完成并验证后执行**。

移到 `C:\tmp\_local-ai_old_archived\patch12-legacy-py\` 的文件（15 个）：

| 文件 | 行数 | 对应新包 | 备注 |
|------|------|---------|------|
| `models.py` | 2431 | `core/` 多文件 | ⚠️ 需先确认无残留引用 |
| `knowledge_base.py` | 1587 | `knowledge/` | ⚠️ 暂时保留！是 re-export 桥 |
| `recorder.py` | 1147 | `recorder_pkg/` | ✅ 可直接删 |
| `task_classifier.py` | 194 | `intelligence/` | ✅ |
| `response_filter.py` | 1032 | `intelligence/` | ✅ |
| `action_router.py` | 100 | `intelligence/` | ✅ |
| `action_registry.py` | 73 | `intelligence/` | ✅ |
| `context_compressor.py` | 465 | `common/` | ✅ |
| `doc_reader.py` | 462 | `files/` | ✅ Phase 1.3 已迁 import |
| `doc_writer.py` | 355 | `files/` | ✅ |
| `doc_action.py` | 118 | `actions/` | ✅ |
| `sidemate_validator.py` | 222 | `validators/` | ✅ Phase 1.4 已迁 import |
| `chunker.py` | 364 | `knowledge/` | ✅ |
| `chunking_orchestrator.py` | 416 | `knowledge/` | ✅ |
| `file_extractor.py` | 232 | `files/` | ✅ |

**⚠️ `knowledge_base.py` 不能删**：它是 1587 行的 re-export 桥，`knowledge/__init__.py` 还没有接管它的所有导出。有两个选择：
- **方案 A（简单）**：保留 `knowledge_base.py`，在 Phase 1.1 只改 import 指向
- **方案 B（彻底）**：把 KB 类和 `get_knowledge_base` 函数迁到 `knowledge/__init__.py`，然后删掉 `knowledge_base.py`。但 `knowledge_base.py` 有 1587 行，里面还有大量业务逻辑，不是简单的 re-export，迁移风险高

**推荐方案 A**：先保留 `knowledge_base.py`，等后续专门做一个 KB 重构任务再处理。

### Phase 3: P0 修复（约 10 分钟）

#### P0-01: test_smoke.py 删除过期测试
- 删除 `test_permission()` 函数（引用已归档的权限端点）
- 删除 `test_skills_list()` 函数（引用已归档的 Skill 端点）
- 删除 `main()` 中对这两个函数的调用

#### P0-02: doc_action.py 根目录版本
- Phase 2 已经把根目录 `doc_action.py` 移走了，此问题自动解决

### Phase 4: 前端问题修复（约 1-2 小时）

#### #81 KB action 按钮缺状态提示

**现状分析**：
- `qa.js` 中 KB 文档操作按钮（暂停/继续/取消/删除）已经有 `disabled` 状态管理
- 但**发送按钮** (`kbBtn`) 在等待 AI 回复时只有 `disabled` + `opacity: 0.5`，没有文字提示
- 用户点击"发送"后没有明确的"正在思考"/"正在检索"反馈

**修复方案**：
1. 在 `qa.js` 的 `kbAsk()` 函数中，发送后显示状态提示：
   - 点击发送 → 按钮文字变为 "检索中..." 或显示一个小的 loading 指示器
   - 收到第一个 token → 状态变为 "生成中..."
   - 生成完成 → 恢复原始状态
2. 对话 Tab 的发送按钮同理（`chat.js:sendMessage()`），需要在等待首 token 时显示状态
3. 建议在输入框下方加一行小字 `<div id="statusHint">` 显示当前状态

#### #84 前端重连后端后刷新状态

**现状分析**：
- `chat.js` 使用 `fetch` + `ReadableStream`（不是 EventSource），没有内置重连机制
- 如果后端重启，前端不会自动重连
- 用户需要手动刷新页面才能恢复

**修复方案**：
1. 在 `chat.js` 中添加一个 `checkBackendHealth()` 函数，定时 ping `/api/status`
2. 当检测到后端恢复时：
   - 刷新模型状态（重新调用 `loadStatus()`）
   - 刷新当前聊天列表
   - 如果正在 KB Tab，重新调用 `kbRouteState()`
3. 显示一个轻量的 toast 通知："后端已恢复连接"
4. 建议间隔：5 秒一次 ping，连续 3 次成功判定为恢复

#### #82 chat 模式任务分类 UI 移除

**现状分析**：
- 前端 `index.html` 中 grep `任务分类` 和 `task.classif` 均未找到匹配
- `modeSelector` / `mode-select` 也不存在
- **这个可能已经在之前的 Patch 中移除了**，需要再确认具体指的是什么

**修复方案**：确认前端是否还有残留的分类相关 UI 元素，如果有则移除。如果没有，标记为已完成。

### Phase 5: chat.py SSE 拆分（大工程，建议单独做）

**现状**：`routers/chat.py` 有 843 行，包含 14 个函数/类。

**拆分方案**：
```
routers/chat.py (保留，但瘦身为路由注册 + 参数校验)
  ├── 路由注册（app.post/get 装饰器）
  ├── ChatRequest 模型
  └── 瘦路由函数（调用下面的模块）

routers/chat/
  ├── __init__.py
  ├── sse_stream.py      ← sse_gen() 核心流式逻辑（当前 ~400 行）
  ├── chat_ops.py         ← CRUD 操作（list/new/switch/delete/messages/append）
  ├── file_handlers.py    ← 文件上传相关（api_qa_upload, api_file_upload）
  └── qa_handler.py       ← KB 问答（api_qa_ask）
```

**建议**：这是个大工程，建议在 Phase 1-4 全部完成并稳定运行后再做。单独开一个任务。

### Phase 6: P1 安全修复 + P2 清理（锦上添花）

#### P1-01: HMAC 默认密钥
- `config.py:32` 的默认密钥 `"zhuoban-sidemate-default-key-v1"` 改为启动时自动生成
- 生成后保存到 `data/settings.json`，后续读取使用持久化的密钥

#### P2-02: routers/chat.py 兼容别名清理
- 删除 `chat.py:100-112` 的 12 个 `_xxx = xxx` 别名

#### P2-03: `_safe_filename` 去重
- `chat.py:80-88` 和 `kb.py:51-60` 的重复定义，统一用 `common/safe_filename.py`

#### P2-04: `_check_memory_budget` 迁移到 deps.py
- 从 `routers/settings.py` 移到 `routers/deps.py`

---

## 三、执行计划总结

| 阶段 | 内容 | 预估时间 | 风险 | 前置依赖 |
|------|------|---------|------|---------|
| **Phase 0** | Think Pipeline 修复 | 另一队 AI 负责 | 低 | 无 |
| **Phase 1** | 旧 import 路径迁移（5 处） | 30 min | 低 | 无 |
| **Phase 2** | 根目录 14 个旧文件归档 | 10 min | 中 | Phase 1 验证通过 |
| **Phase 3** | P0 test_smoke 修复 | 5 min | 低 | Phase 2 |
| **Phase 4** | #81/#84/#82 前端修复 | 1-2 hr | 中 | 无（可并行） |
| **Phase 5** | chat.py 843行拆分 | 2-3 hr | 高 | Phase 1-3 稳定后 |
| **Phase 6** | P1 安全 + P2 清理 | 30 min | 低 | Phase 2 |

**推荐执行顺序**：Phase 1 → Phase 2 → Phase 3 → (Phase 4 并行) → Phase 6 → Phase 5

---

## 四、关于 Think Pipeline 重设计

`think-pipeline-redesign.md` 的方案我已评审过，结论是**靠谱**。但和上面这些修复有几个交叉点需要注意：

1. **Phase 0 和 Phase 1 不冲突** — Think Pipeline 改的是 `chat_template.jinja` 和 `core/think_processor.py`，import 迁移改的是别的文件
2. **Phase 5 chat.py 拆分和 Think Pipeline Phase 2 可能冲突** — 如果另一队 AI 重构 `stream_engine.py` 的同时我们拆 `chat.py`，可能互相覆盖。建议协调好，先做 Think Pipeline Phase 1，再同步拆分
3. **核心建议**：Phase 1（删 jinja 3 行）做完后，先测试稳定性，确认无问题再继续其他改动

---

*方案完成。等待执行确认。*
