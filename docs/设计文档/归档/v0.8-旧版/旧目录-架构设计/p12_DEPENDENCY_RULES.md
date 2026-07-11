# Patch12 9 包依赖规则

## 包间依赖矩阵

通过扫描所有 Python 文件的 `import` 语句，得出以下依赖关系：

### 依赖方向（箭头 = "依赖"）

```
server.py 依赖 → core, routers, knowledge_base(桥), recorder_pkg, config
routers/  依赖 → deps, session, intelligence, knowledge(部分), files(部分), config
session/  依赖 → routers.deps, (内部: chat_store)
core/     依赖 → intelligence.stall_detector (内部: generate_queue, prompt_builder, stream_engine, think_processor)
knowledge/ 依赖 → common.cancellation (纯内聚)
intelligence/ 依赖 → 无外部包 (纯内聚)
files/    依赖 → 无外部包 (纯内聚)
common/   依赖 → 无外部包 (纯内聚)
recorder_pkg/ 依赖 → 无外部包 (纯内聚)
validators/ 依赖 → 无外部包 (纯内聚)
actions/  依赖 → 无外部包 (纯内聚)
```

## 详细依赖表

### core/ 包

| 模块 | 依赖的包内模块 | 依赖的外部包 |
|------|---------------|-------------|
| `model_manager.py` | `generate_queue`, `prompt_builder`, `stream_engine`, `think_processor` | `intelligence.stall_detector` |
| `stream_engine.py` | `generate_queue`, `think_processor` | — |
| `prompt_builder.py` | — | — |
| `think_processor.py` | — | — |
| `generate_queue.py` | — | — |

**结论**: core/ 是底层包，仅向上依赖 intelligence/ 的 stall_detector。其余纯内聚。

### routers/ 包

| 模块 | 依赖的包内模块 | 依赖的外部包 |
|------|---------------|-------------|
| `deps.py` | — | `config`, `server`(延迟) |
| `chat.py` | `deps` | `session.*`, `intelligence.*`, `core.think_processor`, `files.file_extractor`, `prompts`, `config` |
| `kb.py` | `deps` | `routers.settings._check_memory_budget`, `knowledge.memory_manager`, `prompts` |
| `recorder.py` | `deps` | `routers.settings._check_memory_budget` |
| `settings.py` | `deps` | `config`, `sidemate_validator` |
| `skill.py` | — | `intelligence.action_registry` |
| `files.py` | `deps` | — |

**结论**: routers/ 是顶层包，依赖几乎所有其他包。这是 API 层的自然特征。

### session/ 包

| 模块 | 依赖的包内模块 | 依赖的外部包 |
|------|---------------|-------------|
| `chat_store.py` | — | `routers.deps`(CHAT_DIR) |
| `context_cache.py` | `chat_store` | `routers.deps`(get_mgr) |
| `continuation.py` | `chat_store` | `routers.deps`(CHAT_DIR) |

**结论**: session/ 反向依赖 routers.deps 获取常量。这是一个轻微的耦合。

### knowledge/ 包

| 模块 | 依赖的包内模块 | 依赖的外部包 |
|------|---------------|-------------|
| `embedding_engine.py` | — | numpy |
| `reranker_engine.py` | — | — |
| `memory_manager.py` | — | — |
| `chunker.py` | — | — |
| `chunking_orchestrator.py` | — | — |

**结论**: knowledge/ 是纯内聚包，无外部项目依赖。通过 knowledge_base.py 桥文件暴露给外部。

### intelligence/ 包

| 模块 | 依赖的包内模块 | 依赖的外部包 |
|------|---------------|-------------|
| `action_registry.py` | — | — |
| `action_router.py` | — | — |
| `response_filter.py` | — | — |
| `stall_detector.py` | — | collections |
| `task_classifier.py` | — | — |

**结论**: intelligence/ 是纯内聚包，零外部项目依赖。

### common/ 包

| 模块 | 依赖的外部包 |
|------|-------------|
| `cancellation.py` | threading, logging |
| `context_compressor.py` | re, logging |
| `safe_filename.py` | os, re |

**结论**: common/ 是最底层工具包，零项目依赖。

## 依赖层级图（文字描述）

```
层级 0 (最底层, 无依赖):
  common/       通用工具
  validators/   验证器
  actions/      Action 实现

层级 1 (仅依赖层级 0):
  knowledge/    知识库（依赖 common.cancellation）
  intelligence/ 智能模块（纯内聚）
  files/        文件处理（纯内聚）
  recorder_pkg/ 录音纪要（纯内聚）

层级 2 (依赖层级 0-1):
  core/         核心引擎（依赖 intelligence.stall_detector）
  session/      会话管理（依赖 routers.deps 获取常量）

层级 3 (依赖层级 0-2):
  routers/      API 路由（依赖 core, session, intelligence, knowledge）

层级 4 (最顶层):
  server.py     入口（依赖 core, routers, knowledge_base, recorder_pkg, config）
```

## routers/deps.py 的枢纽作用

`routers/deps.py` 是整个依赖注入体系的枢纽：

### 核心职责
1. **延迟导入 server.py 的全局实例**：避免 routers → server 的循环依赖
2. **提供 getter 函数**：每个 router 通过 FastAPI 的 `Depends()` 获取服务实例
3. **集中管理常量**：从 config 获取 WORKSPACE_DIR, CHAT_DIR 等

### 提供的依赖注入函数

| 函数 | 返回 | 来源 |
|------|------|------|
| `get_mgr()` | ModelManager 实例 | `server.mgr` |
| `get_kb()` | KnowledgeBase 实例 | `server.kb` |
| `get_recorder()` | RecorderManager 实例 | `server.recorder` |
| `get_notebook()` | PetNotebook 实例 | `server.mgr.notebook` |
| `get_current_chat_file()` | 当前对话文件路径（可变列表） | `server._current_chat_file` |
| `get_default_llm()` | 默认 LLM 名称 | `server.DEFAULT_LLM` |
| `get_log()` | 主 logger | 本地 |

### 使用模式

```python
# 在 router 中通过延迟导入避免循环
from routers.deps import get_mgr, get_kb

@router.post("/api/chat")
async def api_chat():
    mgr = get_mgr()   # 运行时从 server 获取
    kb = get_kb()
    ...
```

### 避免的循环依赖

没有 deps.py 会形成：
```
server.py → routers/chat.py → server.py (循环!)
```

有了 deps.py 变成：
```
server.py → routers/chat.py → routers/deps.py → server.py (延迟导入，运行时解析)
```

## 禁止的循环依赖

根据当前代码扫描，以下循环依赖 **不存在**：

1. ~~core/ ↔ intelligence/~~: core → intelligence.stall_detector（单向）
2. ~~routers/ ↔ server.py~~: 通过 deps.py 延迟导入解决
3. ~~knowledge/ ↔ knowledge_base.py~~: 单向依赖（knowledge_base → knowledge 包）

### 需要注意的潜在循环

- `session/` 依赖 `routers.deps` 获取 `CHAT_DIR` 常量 → 如果 deps 增加对 session 的依赖就会循环
- `routers/kb.py` 和 `routers/settings.py` 之间存在导入（kb → settings._check_memory_budget）→ 这是单向的，可接受

## _check_memory_budget 的共享模式

`routers/settings.py` 中定义的 `_check_memory_budget()` 函数被 `routers/kb.py` 和 `routers/recorder.py` 导入使用。这是一个包内共享，不构成跨包依赖问题。

```python
# routers/kb.py
from routers.settings import _check_memory_budget

# routers/recorder.py
from routers.settings import _check_memory_budget
```
