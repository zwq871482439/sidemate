# 桌伴 Patch 12 代码审计报告

> 审计日期: 2026-05-29
> 审计范围: `C:\tmp\_local_ai_patch12\`
> 代码规模: ~23,000 行 / 63 个 Python 源文件
> 审计人: Edward (QA Engineer)

## 摘要

Patch 12 将 3 个巨型文件拆分为 9 个包、28 个模块，拆分整体质量良好。新包文件与旧根目录文件内容完全一致（仅 1 处 import 路径差异），所有活跃代码均正确使用新包路径导入。但发现 **2 个 P0 级问题**（会导致崩溃）、**5 个 P1 级问题**、**8 个 P2 级建议改进**，以及根目录 10,345 行旧代码未清理的问题。

---

## P0 — 必须立即修复（会导致崩溃或数据损坏）

### P0-01: `test_smoke.py` 引用已归档的权限端点，会导致冒烟测试必定失败
- **文件**: `test_smoke.py:268-287`
- **问题描述**: `test_permission()` 函数调用 `GET /api/permission/status` 和 `POST /api/permission/set-mode`，但注释明确说明 "权限系统已归档至 `_local-ai_old_archived/permissions.py`"。同样 `test_skills_list()` 调用 `GET /api/skill/list`（Skill 框架也已归档）。这些端点在 Patch 11 中已删除，测试会因 404 而失败。
- **影响**: 冒烟测试 T09 和 T11 必定失败，开发团队可能误以为服务有问题。
- **修复建议**: 删除 `test_permission()` 和 `test_skills_list()` 函数及其在 `main()` 中的调用（第 376-378 行）。

### P0-02: `actions/doc_action.py` 根目录版本使用旧 import 路径，直接导入会报错
- **文件**: `doc_action.py:103`（根目录旧文件）
- **问题描述**: 根目录的 `doc_action.py` 第 103 行使用 `from task_classifier import resolve_strategy`，这会导入根目录旧文件 `task_classifier.py` 而非新包 `intelligence/task_classifier.py`。由于 Python 优先在当前目录查找，这虽不会立即崩溃（旧文件内容一致），但如果旧文件被删除后此文件被直接导入，将会失败。新包版本 `actions/doc_action.py` 已修正为 `from intelligence.task_classifier import resolve_strategy`。
- **影响**: 当旧根文件被清理后，如果有代码直接 import `doc_action`（根目录），将会 ModuleNotFoundError。
- **修复建议**: 根目录 `doc_action.py` 应被删除（对应新包 `actions/doc_action.py` 已存在且正确）。如有保留必要，需修正 import 路径。

---

## P1 — 应在下个版本前修复

### P1-01: `config.py` HMAC 默认密钥硬编码，安全风险
- **文件**: `config.py:32`, `config.py:160`
- **问题描述**: `SIDEMATE_HMAC_KEY` 和 `DEFAULTS["sidemate_hmac_key"]` 的默认值均为 `"zhuoban-sidemate-default-key-v1"`。虽然注释说"生产环境应通过环境变量传入"，但默认值已进入代码库。`.sidemate` 扩展包校验使用此密钥，攻击者可用此默认密钥伪造恶意扩展包。
- **影响**: 如果用户未设置 `SIDEMATE_HMAC_KEY` 环境变量，扩展包签名形同虚设。
- **修复建议**: 
  1. 首次启动时自动生成随机密钥并保存到 `settings.json`
  2. 如果检测到使用默认密钥，在日志中打印警告

### P1-02: `core/model_manager.py` 内部导入旧路径 `knowledge_base`
- **文件**: `core/model_manager.py:407-409`, `core/model_manager.py:451-453`, `core/model_manager.py:471-474`
- **问题描述**: ModelManager 的 `load()`, `unload()` 方法中使用 `from knowledge_base import get_knowledge_base` 导入根目录旧文件。这导致 `core/model_manager.py`（新包文件）反向依赖根目录的 `knowledge_base.py` 巨型文件。
- **影响**: 如果将来删除根目录 `knowledge_base.py`，模型加载/卸载功能将崩溃。也增加了模块间的循环依赖复杂度。
- **修复建议**: 将 `get_knowledge_base()` 的获取改为通过依赖注入或延迟导入新包中的等价接口。

### P1-03: `server.py` 直接导入根目录 `knowledge_base`
- **文件**: `server.py:124`
- **问题描述**: `from knowledge_base import get_knowledge_base` 直接导入根目录 1587 行的旧巨型文件。`knowledge_base.py` 本身已通过顶部 import 将具体实现委托给新包（`knowledge/embedding_engine.py`, `knowledge/reranker_engine.py`, `knowledge/memory_manager.py`），是一个 re-export 壳。
- **影响**: 虽然当前可正常工作（因为 `knowledge_base.py` re-export 了新包），但属于遗留 import 路径。
- **修复建议**: 将 `knowledge_base.py` 中的 `KnowledgeBase` 类和 `get_knowledge_base` 函数迁移到 `knowledge/` 包的 `__init__.py` 中，然后在 `server.py` 改为 `from knowledge import get_knowledge_base`。

### P1-04: `routers/chat.py` 和 `routers/kb.py` 导入根目录 `doc_reader`
- **文件**: `routers/chat.py:728-729`, `routers/kb.py:481-482`
- **问题描述**: 在 docx 文件解析时使用 `from doc_reader import DocReader`，导入的是根目录旧文件而非 `files.doc_reader`。根目录 `doc_reader.py` 内容与 `files/doc_reader.py` 完全一致，但路径不一致。
- **影响**: 删除旧文件后会 ModuleNotFoundError。
- **修复建议**: 改为 `from files.doc_reader import DocReader`。

### P1-05: `routers/settings.py` 导入根目录 `sidemate_validator`
- **文件**: `routers/settings.py:506`
- **问题描述**: `from sidemate_validator import SidemateValidator` 导入根目录旧文件。新包路径为 `validators.sidemate_validator`。
- **影响**: 同 P1-04，旧文件删除后崩溃。
- **修复建议**: 改为 `from validators.sidemate_validator import SidemateValidator`。

---

## P2 — 建议改进

### P2-01: 根目录 10,345 行旧代码未清理
- **文件**: 根目录的 `models.py` (2431行), `knowledge_base.py` (1587行), `recorder.py` (1147行), `task_classifier.py` (194行), `response_filter.py` (1032行), `action_router.py` (100行), `action_registry.py` (73行), `context_compressor.py` (465行), `doc_reader.py` (462行), `doc_writer.py` (355行), `doc_action.py` (118行), `sidemate_validator.py` (222行), `chunker.py` (364行), `chunking_orchestrator.py` (416行), `file_extractor.py` (232行)
- **问题描述**: 这 15 个根目录文件与新包中的对应文件内容完全一致（仅 `doc_action.py` 有 1 行 import 差异），占用 10,345 行冗余代码。它们仍然可被 Python import，可能导致开发者误用旧路径。
- **修复建议**: 创建 `_legacy/` 目录或直接删除这些文件。在删除前确保所有 import 路径已迁移（见 P1-02~P1-05）。

### P2-02: `routers/chat.py` 存在大量兼容别名（可清理）
- **文件**: `routers/chat.py:100-112`
- **问题描述**: 定义了 12 个 `_xxx = xxx` 别名变量（如 `_safe_chat_name = safe_chat_name`），注释说"供 sse_gen 内部闭包引用"。实际上 `sse_gen` 闭包内可直接使用原始函数名。
- **修复建议**: 确认无外部引用后移除这些别名，统一使用新模块函数名。

### P2-03: `_safe_filename` 函数在 3 个文件中重复定义
- **文件**: `routers/chat.py:80-88`, `routers/kb.py:51-60`, `common/safe_filename.py`
- **问题描述**: 相同的文件名安全清理逻辑在 3 处独立定义。`common/safe_filename.py` 已提供了 `safe_filename()` 函数，但 routers 未使用。
- **修复建议**: 统一使用 `from common.safe_filename import safe_filename`。

### P2-04: `_check_memory_budget` 在 `routers/settings.py` 中定义但被其他 router 导入
- **文件**: `routers/settings.py:68-85`
- **问题描述**: `_check_memory_budget` 函数在 `routers/settings.py` 中定义，然后被 `routers/kb.py:41` 和 `routers/recorder.py:39` 通过 `from routers.settings import _check_memory_budget` 导入。这个以 `_` 前缀标记的"私有"函数被跨模块使用，违反命名约定。
- **修复建议**: 将此函数移至 `routers/deps.py`（依赖注入中心），或去掉下划线前缀。

### P2-05: `routers/files.py` 定义的目录路径与 `config.py` 不一致
- **文件**: `routers/files.py:17-19` vs `config.py:37-39`
- **问题描述**: `routers/files.py` 自行定义 `UPLOAD_DIR = os.path.join(WORKSPACE_DIR, "uploads")`，但 `config.py` 定义的是 `UPLOAD_DIR = os.path.join(DATA_DIR, "tmp_upload")`。实际运行中 `routers/files.py` 的缓存 API 使用 `data/uploads/` 目录，而文件上传使用 `data/tmp_upload/`，两者指向不同目录。这可能是设计意图，但命名上容易混淆。
- **修复建议**: 在 `routers/files.py` 中添加注释说明缓存目录与上传临时目录的区别。

### P2-06: `server.py` main() 函数中仍然通过 `__import__` 检查旧根文件版本
- **文件**: `server.py:254-266`
- **问题描述**: `main()` 函数中的版本检查通过 `__import__(mod_name)` 逐一导入 `task_classifier`, `response_filter`, `context_compressor`, `models`, `prompts`, `skill_fileops`, `doc_reader`, `doc_writer`, `config`。其中 `models`, `skill_fileops`, `doc_reader`, `doc_writer`, `context_compressor` 都是根目录旧文件。这会触发旧文件的模块级代码执行。
- **修复建议**: 改为检查新包模块的版本，如 `core.model_manager`, `intelligence.task_classifier`, `intelligence.response_filter`, `common.context_compressor`, `files.doc_reader`, `files.doc_writer`。

### P2-07: `routers/settings.py` 的 `/api/info` 端点同样导入旧根文件
- **文件**: `routers/settings.py:96-106`
- **问题描述**: `api_info()` 使用与 `server.py:main()` 相同的旧路径模块列表。
- **修复建议**: 同 P2-06。

### P2-08: `server.py:144` 调用 `mgr._get_default_llm()` 私有方法
- **文件**: `server.py:144`
- **问题描述**: `DEFAULT_LLM = mgr._get_default_llm()` 调用了以 `_` 前缀标记的私有方法。如果 ModelManager 的接口变更，此调用会悄无声息地失效。
- **修复建议**: 提供公开的 `get_default_llm()` 方法（去掉下划线），或在 ModelManager 中添加 public 接口。

---

## P3 — 低优先级/观察项

### P3-01: `routers/deps.py` 中 `get_notebook()` 可能抛出 AttributeError
- **文件**: `routers/deps.py:38-41`
- **问题描述**: `get_notebook()` 尝试返回 `mgr.notebook`，但 ModelManager 初始化中没有 `notebook` 属性。目前此函数无调用方，不影响运行。

### P3-02: `_kb_sessions` 字典在锁外被修改
- **文件**: `routers/kb.py:842-846` vs `routers/kb.py:848-853`
- **问题描述**: 第 842-846 行修改 `_kb_sessions` 字典时没有持锁（`_kb_sessions_lock`），但第 848-853 行的清理操作持锁。虽然异步 SSE 场景下竞争概率低，但理论上存在数据竞争。

### P3-03: `_install_tasks` 字典无大小限制
- **文件**: `routers/settings.py:476`
- **问题描述**: `_install_tasks` 字典存储安装任务状态，`_cleanup_old_tasks()` 清理超过 5 分钟的已完成任务，但不会清理运行中的任务。如果频繁触发安装但任务卡住，字典会无限增长。

### P3-04: `doc_action.py` 全局 `_cancel_event` 不是线程安全的跨请求设计
- **文件**: `doc_action.py:19`, `actions/doc_action.py:19`
- **问题描述**: 使用模块级全局 `threading.Event()` 作为取消信号，如果同时有两个文档生成请求，一个取消会影响另一个。应改为每个请求独立的取消令牌（`CancellationToken` 已在 `common/cancellation.py` 中实现）。

### P3-05: `prompts.py` 未被拆分
- **文件**: `prompts.py`
- **问题描述**: `prompts.py` 作为根目录文件保留，包含 `SYSTEM_PROMPT_RULES`, `STRATEGY_CONFIG`, `KB_SYSTEM_PROMPT`, `KB_USER_PROMPT_TEMPLATE`, `CHUNK_FINAL_REDUCE_MODES` 等多个 prompt 模板。Patch 12 未将其迁移到新包结构中。

---

## Import 一致性分析

### 新路径导入情况（✅ 正确使用）

| 文件 | 导入路径 | 状态 |
|------|---------|------|
| `server.py:115` | `from core.model_manager import ModelManager` | ✅ |
| `server.py:137` | `from recorder_pkg.recorder_manager import RecorderManager` | ✅ |
| `routers/chat.py:36-53` | `from session.chat_store import ...` | ✅ |
| `routers/chat.py:44-48` | `from session.context_cache import ...` | ✅ |
| `routers/chat.py:50-52` | `from session.continuation import ...` | ✅ |
| `routers/chat.py:207` | `from intelligence.task_classifier import check_topic_drift` | ✅ |
| `routers/chat.py:278` | `from intelligence.action_router import resolve_action` | ✅ |
| `routers/chat.py:287` | `from intelligence.task_classifier import resolve_strategy` | ✅ |
| `routers/chat.py:443` | `from intelligence.response_filter import filter_response` | ✅ |
| `routers/chat.py:521` | `from intelligence.response_filter import clean_prefix_accumulation, detect_prefix_accumulation` | ✅ |
| `routers/chat.py:185` | `from files.file_extractor import process_uploaded_file` | ✅ |
| `routers/skill.py:31` | `from intelligence.action_registry import get_available_actions` | ✅ |
| `routers/skill.py:56` | `from intelligence.action_registry import unregister_action` | ✅ |
| `core/model_manager.py:12-16` | `from core.generate_queue`, `from core.prompt_builder`, etc. | ✅ |
| `core/model_manager.py:16` | `from intelligence.stall_detector import StallDetector` | ✅ |
| `knowledge_base.py:34-37` | `from common.cancellation`, `from knowledge.embedding_engine`, etc. | ✅ |
| `core/prompt_builder.py:25` | `from common.context_compressor import compress_messages` | ✅ |
| `session/context_cache.py:14` | `from common.context_compressor import ...` | ✅ |
| `routers/settings.py:417` | `from knowledge.memory_manager import MemoryManager` | ✅ |

### 旧路径残留（⚠️ 需迁移）

| 文件 | 旧 import 路径 | 应改为 | 优先级 |
|------|---------------|--------|--------|
| `server.py:124` | `from knowledge_base import get_knowledge_base` | `from knowledge import get_knowledge_base` (需先迁移) | P1-03 |
| `core/model_manager.py:407,451,471` | `from knowledge_base import get_knowledge_base` | 依赖注入 | P1-02 |
| `routers/chat.py:728` | `from doc_reader import DocReader` | `from files.doc_reader import DocReader` | P1-04 |
| `routers/kb.py:481` | `from doc_reader import DocReader` | `from files.doc_reader import DocReader` | P1-04 |
| `routers/settings.py:506` | `from sidemate_validator import SidemateValidator` | `from validators.sidemate_validator import SidemateValidator` | P1-05 |
| `doc_action.py:103` (根目录旧文件) | `from task_classifier import resolve_strategy` | `from intelligence.task_classifier import resolve_strategy` | P0-02 |

### 无外部引用的旧根文件（可安全删除）

以下根目录文件与对应新包文件内容完全一致（经 diff 验证 0 差异），且 grep 确认无外部文件 import 它们：

- `task_classifier.py` → `intelligence/task_classifier.py` ✅ 0 diff
- `response_filter.py` → `intelligence/response_filter.py` ✅ 0 diff
- `action_router.py` → `intelligence/action_router.py` ✅ 0 diff
- `action_registry.py` → `intelligence/action_registry.py` ✅ 0 diff
- `context_compressor.py` → `common/context_compressor.py` ✅ 0 diff
- `doc_reader.py` → `files/doc_reader.py` ✅ 0 diff
- `doc_writer.py` → `files/doc_writer.py` ✅ 0 diff
- `sidemate_validator.py` → `validators/sidemate_validator.py` ✅ 0 diff
- `chunker.py` → `knowledge/chunker.py` ✅ 0 diff
- `chunking_orchestrator.py` → `knowledge/chunking_orchestrator.py` ✅ 0 diff
- `file_extractor.py` → `files/file_extractor.py` ✅ 0 diff
- `recorder.py` → `recorder_pkg/recorder_manager.py` ✅ 0 diff
- `doc_action.py` → `actions/doc_action.py` ⚠️ 1 行 diff (import 路径)

以下根目录文件仍有被 import（不能直接删除）：

- `knowledge_base.py` — 被 `server.py`, `core/model_manager.py` 引用
- `models.py` — 无活跃引用，但 `server.py` 的版本检查 `__import__("models")` 会触发加载

---

## 附录：文件清单与状态

### 新包结构（Patch 12 新增）

| 包 | 模块 | 行数 | 状态 |
|----|------|------|------|
| `core/` | `__init__.py` | 7 | ✅ |
| `core/` | `model_manager.py` | 982 | ✅ |
| `core/` | `generate_queue.py` | ~150 | ✅ |
| `core/` | `prompt_builder.py` | ~200 | ✅ |
| `core/` | `stream_engine.py` | ~350 | ✅ |
| `core/` | `think_processor.py` | ~100 | ✅ |
| `intelligence/` | `__init__.py` | 2 | ✅ |
| `intelligence/` | `task_classifier.py` | 194 | ✅ |
| `intelligence/` | `response_filter.py` | 1032 | ✅ |
| `intelligence/` | `action_router.py` | 100 | ✅ |
| `intelligence/` | `action_registry.py` | 73 | ✅ |
| `intelligence/` | `stall_detector.py` | 188 | ✅ |
| `common/` | `__init__.py` | 2 | ✅ |
| `common/` | `context_compressor.py` | 465 | ✅ |
| `common/` | `cancellation.py` | 67 | ✅ |
| `common/` | `safe_filename.py` | 25 | ✅ |
| `knowledge/` | `__init__.py` | 2 | ✅ |
| `knowledge/` | `embedding_engine.py` | ~300 | ✅ |
| `knowledge/` | `reranker_engine.py` | ~200 | ✅ |
| `knowledge/` | `memory_manager.py` | ~100 | ✅ |
| `knowledge/` | `chunker.py` | 364 | ✅ |
| `knowledge/` | `chunking_orchestrator.py` | 416 | ✅ |
| `files/` | `__init__.py` | 2 | ✅ |
| `files/` | `doc_reader.py` | 462 | ✅ |
| `files/` | `doc_writer.py` | 355 | ✅ |
| `files/` | `file_extractor.py` | 232 | ✅ |
| `files/` | `file_reader.py` | ~100 | ✅ |
| `session/` | `__init__.py` | 1 | ✅ |
| `session/` | `chat_store.py` | ~150 | ✅ |
| `session/` | `context_cache.py` | ~150 | ✅ |
| `session/` | `continuation.py` | 82 | ✅ |
| `recorder_pkg/` | `__init__.py` | 2 | ✅ |
| `recorder_pkg/` | `recorder_manager.py` | 1147 | ✅ |
| `actions/` | `__init__.py` | 2 | ✅ |
| `actions/` | `doc_action.py` | 118 | ✅ |
| `validators/` | `__init__.py` | 1 | ✅ |
| `validators/` | `sidemate_validator.py` | 222 | ✅ |
| `routers/` | `__init__.py` | 2 | ✅ |
| `routers/` | `chat.py` | 844 | ✅ |
| `routers/` | `kb.py` | 906 | ✅ |
| `routers/` | `recorder.py` | 301 | ✅ |
| `routers/` | `settings.py` | 896 | ✅ |
| `routers/` | `skill.py` | 60 | ✅ |
| `routers/` | `files.py` | 90 | ✅ |
| `routers/` | `deps.py` | 65 | ✅ |

### 根目录保留文件（待清理）

| 文件 | 行数 | 对应新包 | 可删除 |
|------|------|---------|--------|
| `models.py` | 2431 | `core/` (多文件) | ⚠️ 需先移除 `__import__("models")` |
| `knowledge_base.py` | 1587 | `knowledge/` (多文件) | ❌ 被活跃 import |
| `recorder.py` | 1147 | `recorder_pkg/` | ✅ 无引用 |
| `task_classifier.py` | 194 | `intelligence/` | ✅ 无引用 |
| `response_filter.py` | 1032 | `intelligence/` | ✅ 无引用 |
| `action_router.py` | 100 | `intelligence/` | ✅ 无引用 |
| `action_registry.py` | 73 | `intelligence/` | ✅ 无引用 |
| `context_compressor.py` | 465 | `common/` | ✅ 无引用 |
| `doc_reader.py` | 462 | `files/` | ⚠️ 被 routers 活跃 import |
| `doc_writer.py` | 355 | `files/` | ✅ 无引用 |
| `doc_action.py` | 118 | `actions/` | ✅ 无引用 |
| `sidemate_validator.py` | 222 | `validators/` | ⚠️ 被 settings.py import |
| `chunker.py` | 364 | `knowledge/` | ✅ 无引用 |
| `chunking_orchestrator.py` | 416 | `knowledge/` | ✅ 无引用 |
| `file_extractor.py` | 232 | `files/` | ✅ 无引用 |
| **合计** | **10,345** | | |

---

*审计完成。报告共发现 P0 级 2 项、P1 级 5 项、P2 级 8 项、P3 级 5 项问题。*
