# Patch12 模块 Import 映射表

> 基于 `grep -rn "^from \|^import "` 扫描结果生成

## 各包 `__init__.py` 导出

### core/__init__.py
```python
from core.generate_queue import GenerateQueue, GenerateTicket
from core.model_manager import ModelManager
from core.prompt_builder import PromptBuilder
from core.stream_engine import StreamEngine
from core.think_processor import ThinkProcessor
```

### routers/__init__.py
无导出，仅文档字符串说明 5 个 Router 模块。

### 其他包 __init__.py
| 包 | 导出 |
|----|------|
| `common/` | 无（仅文档注释） |
| `knowledge/` | 无（仅文档注释） |
| `intelligence/` | 无（仅文档注释） |
| `session/` | 无（空文件） |
| `files/` | 无（空文件） |
| `validators/` | 无（空文件） |
| `recorder_pkg/` | 无（空文件） |
| `actions/` | 无（空文件） |
| `pipeline/` | 无（仅文档注释） |

## 跨包依赖详细映射

### server.py（根入口）
| import 来源 | 导入内容 |
|-------------|---------|
| `config` | `ROOT_DIR, WORKSPACE_DIR, CHAT_DIR, LOG_DIR, UPLOAD_DIR, ensure_dirs` |
| `config` | `get as _cfg_get, DEFAULTS as _DEFAULTS` |
| `core.model_manager` | `ModelManager` |
| `knowledge_base`（桥文件） | `get_knowledge_base` |
| `recorder_pkg.recorder_manager` | `RecorderManager` |
| `routers` | `chat, kb, recorder, settings, skill, files` |

### routers/chat.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `get_mgr, get_kb, get_current_chat_file, get_default_llm, get_log, WORKSPACE_DIR, CHAT_DIR, UPLOAD_DIR, FILES_DIR` |
| `session.chat_store` | `safe_chat_name, today_str, new_chat_file, save_chat, load_chat, load_chat_cache, list_chats` |
| `session.context_cache` | `clean_history_for_model, clean_think_content, update_session_cache` |
| `session.continuation` | `get_latest_chat, is_output_incomplete` |
| 运行时动态导入 | `files.file_extractor.process_uploaded_file`, `intelligence.task_classifier.check_topic_drift`, `intelligence.action_router.resolve_action`, `intelligence.task_classifier.resolve_strategy`, `intelligence.response_filter.filter_response`, `core.think_processor.ThinkProcessor`, `prompts.KB_USER_PROMPT_TEMPLATE`, `config.get` |

### routers/kb.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `get_mgr, get_kb, get_log, WORKSPACE_DIR, UPLOAD_DIR` |
| `routers.settings` | `_check_memory_budget` |
| 运行时动态导入 | `doc_reader.DocReader`, `prompts.KB_USER_PROMPT_TEMPLATE`, `knowledge.memory_manager.MemoryManager` |

### routers/recorder.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `get_mgr, get_kb, get_recorder, get_log` |
| `routers.settings` | `_check_memory_budget` |

### routers/settings.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `get_mgr, get_kb, get_recorder, get_log, WORKSPACE_DIR, UPLOAD_DIR, FILES_DIR` |
| 运行时动态导入 | `config.load_config, config.save_config, config.get, config.set_value`, `sidemate_validator.SidemateValidator` |

### routers/skill.py
| import 来源 | 导入内容 |
|-------------|---------|
| 运行时动态导入 | `intelligence.action_registry.get_available_actions, intelligence.action_registry.unregister_action` |

### routers/files.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `get_log, WORKSPACE_DIR` |

### routers/deps.py（依赖注入枢纽）
| import 来源 | 导入内容 |
|-------------|---------|
| `config` | `WORKSPACE_DIR, CHAT_DIR, UPLOAD_DIR, FILES_DIR` |
| `server`（延迟导入） | `mgr, kb, recorder, _current_chat_file, DEFAULT_LLM` |

### session/chat_store.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `CHAT_DIR` |

### session/context_cache.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `get_mgr` |
| `session.chat_store` | `load_chat_cache` |

### session/continuation.py
| import 来源 | 导入内容 |
|-------------|---------|
| `routers.deps` | `CHAT_DIR` |
| `session.chat_store` | `today_str` |

### core/model_manager.py
| import 来源 | 导入内容 |
|-------------|---------|
| `core.generate_queue` | `GenerateQueue, GenerateTicket` |
| `core.prompt_builder` | `PromptBuilder` |
| `core.stream_engine` | `StreamEngine` |
| `core.think_processor` | `ThinkProcessor` |
| `intelligence.stall_detector` | `StallDetector` |

### core/stream_engine.py
| import 来源 | 导入内容 |
|-------------|---------|
| `core.generate_queue` | `GenerateQueue` |
| `core.think_processor` | `ThinkProcessor, THINK_END_MARKERS, THINK_START_MARKERS` |

### knowledge_base.py（根目录桥文件）
| import 来源 | 导入内容 |
|-------------|---------|
| `common.cancellation` | `TaskCancelledError, CancellationToken` |
| `knowledge.embedding_engine` | `EmbeddingEngine` |
| `knowledge.reranker_engine` | `RerankerEngine` |
| `knowledge.memory_manager` | `MemoryManager` |

## 通过根目录桥文件的 import

### knowledge_base.py（桥文件）

`knowledge_base.py` 是一个 **桥文件/兼容层**，位于项目根目录。它：

1. **re-export** 新包中的类：从 `knowledge.embedding_engine`, `knowledge.reranker_engine`, `knowledge.memory_manager`, `common.cancellation` 导入
2. **保持 API 兼容**：外部代码仍然可以用 `from knowledge_base import KnowledgeBase` 访问
3. **实际数据结构**：定义 `KBDocument`, `KBChunk` 数据类
4. **核心逻辑**：`KnowledgeBase` 类包含 1587 行的文库核心逻辑

### server.py 中的桥接
```python
from knowledge_base import get_knowledge_base  # 通过根目录桥文件
```

### models.py（旧版未完全迁移）
`models.py` (2431行) 仍在根目录，是旧版模型管理器。新包 `core/model_manager.py` 已提取部分逻辑。

## import 兼容层总结

| 根目录旧文件 | 新包对应 | 状态 |
|-------------|---------|------|
| `knowledge_base.py` | `knowledge/` 包 | 桥文件，re-export 新包类 |
| `models.py` | `core/model_manager.py` | 未完全迁移，server.py 仍用 `from core.model_manager import` |
| `recorder.py` | `recorder_pkg/recorder_manager.py` | 新包已完整，旧文件仍存 |
| `context_compressor.py` | `common/context_compressor.py` | 新包已完整，旧文件仍存 |
| `chunker.py` | `knowledge/chunker.py` | 新包已完整，旧文件仍存 |
| `chunking_orchestrator.py` | `knowledge/chunking_orchestrator.py` | 新包已完整，旧文件仍存 |
| `response_filter.py` | `intelligence/response_filter.py` | 新包已完整，旧文件仍存 |
| `action_registry.py` | `intelligence/action_registry.py` | 新包已完整，旧文件仍存 |
| `action_router.py` | `intelligence/action_router.py` | 新包已完整，旧文件仍存 |
| `task_classifier.py` | `intelligence/task_classifier.py` | 新包已完整，旧文件仍存 |
| `doc_reader.py` | `files/doc_reader.py` | 新包已完整，旧文件仍存 |
| `doc_writer.py` | `files/doc_writer.py` | 新包已完整，旧文件仍存 |
| `file_extractor.py` | `files/file_extractor.py` | 新包已完整，旧文件仍存 |
| `doc_action.py` | `actions/doc_action.py` | 新包已完整，旧文件仍存 |
| `sidemate_validator.py` | `validators/sidemate_validator.py` | 新包已完整，旧文件仍存 |
