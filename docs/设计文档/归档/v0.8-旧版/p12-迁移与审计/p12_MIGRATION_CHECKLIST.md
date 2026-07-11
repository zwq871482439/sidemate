# Patch12 迁移检查清单

> 基于实际代码扫描，记录根目录旧文件与新建包的迁移状态
> **最后更新**：2026-05-29

> ⚠️ **状态修正**：根目录 13 个旧文件**尚未物理删除**，仅 import 路径已切到新包。
> 新包中的文件是完整副本（内容一致），删除旧文件前需确认无残留 import。

## 已迁移文件（旧文件 → 新包）

以下旧文件在根目录仍有副本，但新包中已有对应模块。server.py 和 routers/ 已优先从新包导入。

| 根目录旧文件 | 行数 | 新包目标 | 迁移状态 |
|-------------|------|---------|---------|
| `recorder.py` | 1147 | `recorder_pkg/recorder_manager.py` (1147行) | ✅ 完整迁移（内容一致） |
| `context_compressor.py` | 465 | `common/context_compressor.py` (465行) | ✅ 完整迁移（内容一致） |
| `chunker.py` | 364 | `knowledge/chunker.py` (364行) | ✅ 完整迁移（内容一致） |
| `chunking_orchestrator.py` | 416 | `knowledge/chunking_orchestrator.py` (416行) | ✅ 完整迁移（内容一致） |
| `response_filter.py` | 1032 | `intelligence/response_filter.py` (1032行) | ✅ 完整迁移（内容一致） |
| `action_registry.py` | 73 | `intelligence/action_registry.py` (73行) | ✅ 完整迁移（内容一致） |
| `action_router.py` | 100 | `intelligence/action_router.py` (100行) | ✅ 完整迁移（内容一致） |
| `task_classifier.py` | 194 | `intelligence/task_classifier.py` (194行) | ✅ 完整迁移（内容一致） |
| `doc_reader.py` | 462 | `files/doc_reader.py` (462行) | ✅ 完整迁移（内容一致） |
| `doc_writer.py` | 355 | `files/doc_writer.py` (355行) | ✅ 完整迁移（内容一致） |
| `file_extractor.py` | 232 | `files/file_extractor.py` (232行) | ✅ 完整迁移（内容一致） |
| `doc_action.py` | 118 | `actions/doc_action.py` (118行) | ✅ 完整迁移（内容一致） |
| `sidemate_validator.py` | 222 | `validators/sidemate_validator.py` (222行) | ✅ 完整迁移（内容一致） |

## 部分迁移 / 桥接文件

| 根目录文件 | 行数 | 新包目标 | 状态 |
|-----------|------|---------|------|
| `knowledge_base.py` | 1587 | `knowledge/` 包（embedding_engine, reranker_engine, memory_manager） | ⚠️ 桥文件：re-export 新包类，核心逻辑仍在根文件 |
| `models.py` | 2431 | `core/model_manager.py` (981行) | ⚠️ 部分迁移：server.py 已改用 `from core.model_manager import ModelManager` |

## 根目录仍需保留的文件（非迁移目标）

| 文件 | 行数 | 说明 |
|------|------|------|
| `server.py` | 280 | 主服务入口，必须保留 |
| `config.py` | 247 | 全局配置中心，必须保留 |
| `prompts.py` | — | Prompt 模板，独立模块 |
| `preflight.py` | 139 | 环境检查脚本 |
| `packager.py` | — | 打包工具 |
| `test_smoke.py` | — | 测试文件 |

## 当前 import 兼容层

### knowledge_base.py 桥接

`knowledge_base.py` 通过顶部 import re-export 新包的类：

```python
from common.cancellation import TaskCancelledError, CancellationToken
from knowledge.embedding_engine import EmbeddingEngine
from knowledge.reranker_engine import RerankerEngine
from knowledge.memory_manager import MemoryManager
```

**作用**：使旧代码 `from knowledge_base import EmbeddingEngine` 仍然有效。

### models.py 兼容

`server.py` 已改为：
```python
from core.model_manager import ModelManager  # 新导入
```

但 `models.py` 仍存在（2431行），部分功能尚未提取到 `core/`。

## 待做清单

### 1. 根目录旧文件清理（14 个文件）

以下文件在新包中已有完整副本，可以安全删除：

```
根目录/
├── recorder.py              → recorder_pkg/recorder_manager.py ✅
├── context_compressor.py    → common/context_compressor.py ✅
├── chunker.py               → knowledge/chunker.py ✅
├── chunking_orchestrator.py → knowledge/chunking_orchestrator.py ✅
├── response_filter.py       → intelligence/response_filter.py ✅
├── action_registry.py       → intelligence/action_registry.py ✅
├── action_router.py         → intelligence/action_router.py ✅
├── task_classifier.py       → intelligence/task_classifier.py ✅
├── doc_reader.py            → files/doc_reader.py ✅
├── doc_writer.py            → files/doc_writer.py ✅
├── file_extractor.py        → files/file_extractor.py ✅
├── doc_action.py            → actions/doc_action.py ✅
├── sidemate_validator.py    → validators/sidemate_validator.py ✅
```

**注意**：删除前需确认没有代码直接 import 根目录版本。当前 `routers/` 内的代码已改为从新包 import，但 `server.py` 的 `main()` 函数中有一段通过 `__import__(mod_name)` 动态加载模块版本的代码，可能会受影响。

### 2. knowledge_base.py 拆分

当前 `knowledge_base.py` (1587行) 需要进一步拆分：
- `KnowledgeBase` 类 → 可移入 `knowledge/knowledge_base.py`
- `KBDocument`, `KBChunk` 数据类 → 可移入 `knowledge/models.py`
- 保留根目录桥文件只做 re-export

### 3. models.py 拆分

当前 `models.py` (2431行) 是最大的单文件：
- 已提取 `core/model_manager.py` (981行)
- 已提取 `core/stream_engine.py` (661行)
- 已提取 `core/prompt_builder.py` (292行)
- 已提取 `core/think_processor.py` (257行)
- 已提取 `core/generate_queue.py` (165行)
- **待确认**：models.py 中是否还有未迁移的逻辑

### 4. chat.py 拆分

`routers/chat.py` (844行) 是最大的路由文件，可考虑进一步拆分：
- 聊天核心（stream）→ `routers/chat_stream.py`
- 对话管理 CRUD → `routers/chat_session.py`
- 问答 Tab → `routers/qa.py`

### 5. kb.py 拆分

`routers/kb.py` (882行) 可考虑拆分：
- KB 文档管理 → `routers/kb_docs.py`
- KB 模块管理 → `routers/kb_module.py`
- KB 问答 → `routers/kb_ask.py`

### 6. settings.py 拆分

`routers/settings.py` (895行) 可考虑拆分：
- 系统信息/模型管理 → `routers/settings_model.py`
- 扩展管理 → `routers/settings_ext.py`
- 配置/资源 → `routers/settings_config.py`

### 7. session/ 反向依赖清理

`session/chat_store.py` 和 `session/context_cache.py` 依赖 `routers.deps` 获取常量（CHAT_DIR 等）。应改为：
- 从 `config.py` 直接导入
- 或将 CHAT_DIR 等常量移到独立的 constants 模块

## 迁移进度总结

| 状态 | 数量 | 说明 |
|------|------|------|
| ✅ 完整迁移 | 13 个文件 | 根目录旧文件已有新包副本 |
| ⚠️ 桥接/部分迁移 | 2 个文件 | knowledge_base.py, models.py |
| 📋 待做 - 文件清理 | 13 个文件 | 删除根目录旧副本 |
| 📋 待做 - 继续拆分 | 3 个路由文件 | chat.py, kb.py, settings.py |
| 📋 待做 - 依赖清理 | 1 处 | session → routers.deps 反向依赖 |
