# Patch 4 技术实施方案

> 版本：v0.9 Patch 4 | 日期：2026-06-11 | 状态：📝 技术设计
> 配套文档：[PATCH4-PLAN.md](../../_Sidemate_0.9_patch3/docs/PATCH4-PLAN.md)

---

## 0. 当前代码基线

### 0.1 目录结构（P3 → P4 迁移后）

```
C:\tmp\_Sidemate_0.9_patch4\
├── LICENSE                              ← 新增（专有 EULA）
├── THIRD-PARTY-NOTICES                  ← 新增（第三方许可）
├── build_full.py                        ← 构建脚本
├── docs/
│   ├── PATCH5-PLAN.md
│   └── PATCH6-BRAINSTORM.md
└── server/
    ├── server.py                        (459 行)     ← 主入口
    ├── config.py                        (270 行)     ← 配置中心
    ├── prompts.py                       (398 行)     ← 提示词
    ├── knowledge_base.py                (1,726 行)   ← ⚠️ 待拆分
    ├── index.html                       (955 行)     ← 前端单页
    ├── settings.json                    ← 运行时配置
    ├── requirements.txt
    │
    ├── routers/                         ← 路由层（8 文件）
    │   ├── deps.py                      (89 行)      ← 依赖注入
    │   ├── chat.py                                   ← Chat SSE
    │   ├── kb.py                                      ← KB 管理
    │   ├── settings.py                 (1,914 行)    ← ⚠️ 待拆分
    │   ├── backup.py                                 ← 备份
    │   ├── recorder.py                               ← 纪要
    │   ├── files.py                                  ← 文件管理
    │   └── skill.py                                  ← 技能（归档中）
    │
    ├── pipelines/                       ← SSE 管道
    │   ├── __init__.py                              ← create_pipeline(ctx)
    │   ├── _base.py                                  ← StreamContext + 共享
    │   ├── local_pipeline.py                         ← 本地推理
    │   ├── cloud_pipeline.py                         ← 云端推理
    │   └── compare_pipeline.py                       ← 对比模式
    │
    ├── core/                            ← 核心引擎
    │   ├── model_manager.py                          ← 模型管理
    │   ├── stream_engine.py                          ← Ollama 流式推理
    │   ├── cloud_engine.py                           ← 云端 API
    │   ├── agent_loop.py                             ← FC 工具循环
    │   ├── agent_tools.py                            ← 工具定义
    │   ├── llm_scheduler.py                          ← P0/P2 调度
    │   ├── tagging_scheduler.py                      ← 异步打标
    │   ├── reformulate.py                            ← 问题重写
    │   ├── search_engine.py                          ← Bing 搜索
    │   ├── generate_queue.py                         ← GPU 队列
    │   ├── ollama_manager.py                         ← Ollama 生命周期
    │   ├── prompt_builder.py                         ← prompt 组装
    │   ├── think_processor.py                        ← <think/> 处理
    │   ├── template_parser.py                        ← docx→模板
    │   ├── deps_check.py                (253 行)     ← ⚠️ 待增强
    │   ├── session_migrator.py                       ← 会话迁移
    │   └── log_cleanup.py                            ← 日志清理
    │
    ├── knowledge/                       ← 已从 KB 提取的子包
    │   ├── __init__.py
    │   ├── chunker.py                                ← 分块策略
    │   ├── chunking_orchestrator.py                  ← 分块编排
    │   ├── embedding_engine.py                       ← 嵌入引擎
    │   ├── reranker_engine.py                        ← 精排引擎
    │   └── memory_manager.py                         ← 内存管理
    │
    ├── common/                          ← ⚠️ 待合并
    │   ├── __init__.py
    │   ├── cancellation.py               (66 行)
    │   ├── context_compressor.py         (455 行)
    │   ├── safe_filename.py              (35 行)
    │   └── text_utils.py                 (39 行)
    │
    ├── actions/                         ← ⚠️ 待收编
    │   ├── __init__.py
    │   └── doc_action.py                (299 行)
    │
    ├── validators/                      ← ⚠️ 待收编
    │   ├── __init__.py
    │   └── sidemate_validator.py        (241 行)
    │
    ├── session/                         ← ⚠️ 待去反依赖
    │   ├── __init__.py
    │   ├── chat_store.py                (466 行)
    │   ├── context_cache.py
    │   └── continuation.py
    │
    ├── extensions/                      ← 扩展注册
    │   ├── __init__.py
    │   └── registry.py                  (197 行)   ← ⚠️ VALID_IDS 待扩展
    │
    ├── intelligence/                    ← 智能层
    │   ├── action_registry.py
    │   ├── action_router.py
    │   ├── response_filter.py
    │   ├── stall_detector.py
    │   └── task_classifier.py
    │
    ├── files/                           ← 文件处理
    │   ├── doc_reader.py
    │   ├── doc_writer.py
    │   ├── file_extractor.py
    │   └── file_reader.py
    │
    ├── recorder_pkg/                    ← 纪要扩展
    │   └── recorder_manager.py
    │
    ├── static/                          ← 前端静态资源
    │   ├── js/
    │   └── css/
    │
    ├── web/                             ← Web 资源
    │
    └── data/                            ← 运行时数据
        ├── chats/                       ← 用户数据
        ├── kb/                          ← 用户数据
        ├── kbsession/                   ← 用户数据
        ├── docs/                        ← ⚠️ 待迁入 cache/
        ├── tmp_upload/                  ← ⚠️ 待迁入 cache/
        ├── files/                       ← ⚠️ 待迁入 cache/
        └── logs/                        ← ⚠️ 待迁入 cache/
```

### 0.2 关键依赖关系图

```
knowledge_base.py (1726行)
├── import → common.cancellation
├── import → knowledge.embedding_engine
├── import → knowledge.reranker_engine
└── import → knowledge.memory_manager

被引用方：
├── server.py → get_knowledge_base()
├── tagging_scheduler.py → extract_title_and_first_paragraphs, normalize_tag
└── routers/deps.py → get_kb() → from server import kb

---

routers/settings.py (1914行) — 路由端点清单：
├── [系统信息]     /api/warmup (POST), /api/info, /api/status, /api/health, /api/token-budget
├── [模型管理]     /api/models, /api/load/{name} (POST), /api/unload/{name} (POST),
│                  /api/model/unload (POST), /api/model/delete (DELETE), /api/models/import (POST)
├── [设备管理]     /api/devices, /api/device/switch (POST)
├── [环境/系统]    /api/env/check, /api/stop (POST), /api/rescan (POST)
├── [工作区]       /api/workspace, /api/workspace/{path}
├── [配置]         /api/config (GET/POST)
├── [资源/预算]    /api/resource-info, /api/budget (POST)
├── [AI模式]       /api/mode, /api/mode/switch (POST)          ← 云端
├── [云端配置]     /api/cloud/config (GET/POST),
│                  /api/cloud/model-capabilities, /api/cloud/test (POST)   ← 云端
├── [扩展安装]     /api/extensions/upload (POST), /api/extensions/install-progress/{id},
│                  /api/extensions/list, /api/extensions/uninstall/{type}/{name} (DELETE),
│                  /api/extensions/{type}/{name} (DELETE)
└── [加载进度]     /api/load-progress

---

session/ 反向依赖：
├── chat_store.py → from routers.deps import (get_current_chat_file, CHAT_DIR, ...)
├── context_cache.py → from routers.deps import get_mgr
└── continuation.py → from routers.deps import CHAT_DIR
⚠️ 违反依赖方向：数据层不应依赖路由层
```

---

## 1. Batch 1：代码重构

### 1.1 knowledge_base.py → knowledge/ 子包扩展

**目标**：将 `knowledge_base.py` 从 1726 行单文件拆分为 `knowledge/` 子包内的多个模块。

#### 拆分方案

| 新模块 | 职责 | 来源行号 | 预估行数 |
|--------|------|----------|---------|
| `knowledge/tags.py` | 标签归一化 + 标题提取 | L42-108 | ~70 |
| `knowledge/models.py` | KBDocument + KBChunk 数据类 | L109-144 | ~40 |
| `knowledge/ops.py` | 文档 CRUD（import/process/delete/pause/resume/cancel） | L145-1270 | ~500 |
| `knowledge/search.py` | 检索（BM25 + 向量 + RRF融合 + Reranker + MMR + search + get_context） | L937-1588 | ~350 |
| `knowledge/ask.py` | 文库问答（ask + 上下文组装） | L1590-1670 | ~100 |
| `knowledge/stats.py` | 统计信息 + 标签查询 | L1672-1714 | ~50 |
| `knowledge/compat.py` | 兼容层：re-export 所有公开 API | 新增 | ~30 |
| `knowledge/__init__.py` | 包入口 + `get_knowledge_base()` 工厂 | L1716-1727 | ~20 |

#### 迁移后的 knowledge/ 目录

```
knowledge/
├── __init__.py          ← 包入口 + get_knowledge_base()
├── models.py            ← KBDocument, KBChunk
├── tags.py              ← normalize_tag, extract_title_and_first_paragraphs
├── ops.py               ← 文档管理 CRUD
├── search.py            ← 检索引擎（BM25 + 向量 + Reranker）
├── ask.py               ← 文库问答
├── stats.py             ← 统计 + 标签查询
├── compat.py            ← 兼容 re-export
├── chunker.py           ← (已有) 分块策略
├── chunking_orchestrator.py  ← (已有) 分块编排
├── embedding_engine.py  ← (已有) 嵌入引擎
├── reranker_engine.py   ← (已有) 精排引擎
└── memory_manager.py    ← (已有) 内存管理
```

#### KnowledgeBase 类的归属

`KnowledgeBase` 类本身放在 `knowledge/__init__.py` 中（作为包的主入口类），或拆分到 `ops.py` + `search.py` + `ask.py` + `stats.py` 作为 mixin：

**推荐方案：Mixin 模式**

```python
# knowledge/__init__.py
from knowledge.models import KBDocument, KBChunk
from knowledge.ops import _KBOpsMixin
from knowledge.search import _KBSearchMixin
from knowledge.ask import _KBAaskMixin
from knowledge.stats import _KBStatsMixin

class KnowledgeBase(_KBOpsMixin, _KBSearchMixin, _KBAaskMixin, _KBStatsMixin):
    """本地文库 — Mixin 组合"""
    def __init__(self, base_dir=None):
        # __init__ 逻辑从原 L148-216 迁入
        ...

def get_knowledge_base() -> KnowledgeBase:
    """单例工厂（原 L1720-1727）"""
    ...
```

#### 兼容层

```python
# knowledge/compat.py
"""向后兼容：支持 from knowledge_base import XXX 的旧写法"""
from knowledge import KnowledgeBase, get_knowledge_base, KBDocument, KBChunk
from knowledge.tags import normalize_tag, extract_title_and_first_paragraphs
```

#### import 修正清单

| 文件 | 旧 import | 新 import | 备注 |
|------|-----------|-----------|------|
| `server.py:261` | `from knowledge_base import get_knowledge_base` | `from knowledge import get_knowledge_base` | 主入口 |
| `tagging_scheduler.py:90` | `from knowledge_base import extract_title_and_first_paragraphs` | `from knowledge.tags import extract_title_and_first_paragraphs` | |
| `tagging_scheduler.py:144` | `from knowledge_base import normalize_tag` | `from knowledge.tags import normalize_tag` | |

#### 删除

- 删除 `server/knowledge_base.py`（拆分完成后）

---

### 1.2 settings.py 拆分为 3 个路由文件

**目标**：将 1914 行的 `routers/settings.py` 按功能域拆分为 3 个独立 Router。

#### 拆分方案

| 新文件 | 路由前缀 | 端点 | 行数估算 |
|--------|---------|------|---------|
| `routers/settings_general.py` | 无前缀 | /api/info, /api/status, /api/health, /api/token-budget, /api/config, /api/resource-info, /api/budget, /api/env/check, /api/stop, /api/rescan, /api/workspace, /api/load-progress, /api/warmup | ~600 |
| `routers/settings_model.py` | 无前缀 | /api/models, /api/load/{name}, /api/unload/{name}, /api/model/unload, /api/model/delete, /api/models/import, /api/devices, /api/device/switch | ~500 |
| `routers/settings_cloud.py` | 无前缀 | /api/mode, /api/mode/switch, /api/cloud/config (GET/POST), /api/cloud/model-capabilities, /api/cloud/test, /api/extensions/*, _install_worker | ~800 |

#### 共享逻辑提取

以下辅助函数从 `settings.py` 提取到 `routers/_settings_shared.py`：

| 函数 | 用途 |
|------|------|
| `_load_settings()` | 加载 settings.json |
| `_save_settings(settings)` | 保存 settings.json |
| `_check_memory_budget(estimated_mb)` | 内存预算检查 |
| `_safe_extract_path(target_dir, member_path)` | 路径安全检查 |
| `_cleanup_old_tasks()` | 安装任务清理 |
| `_install_worker(...)` | 扩展安装后台线程 |

#### server.py 路由注册变化

```python
# 旧（settings.py 一个大文件）
from routers.settings import router as settings_router
app.include_router(settings_router)

# 新（3 个子路由）
from routers.settings_general import router as general_router
from routers.settings_model import router as model_router
from routers.settings_cloud import router as cloud_router
app.include_router(general_router)
app.include_router(model_router)
app.include_router(cloud_router)
```

#### 删除

- 删除 `routers/settings.py`（拆分完成后）

---

### 1.3 common/ 四合一

**目标**：将 common/ 下小文件合并精简。

| 原文件 | 行数 | 内容 | 状态 |
|--------|------|------|------|
| `cancellation.py` | 66 | TaskCancelledError, CancellationToken | 被 knowledge_base.py 引用，→ 合入 utils.py |
| `context_compressor.py` | 455 | compress_messages, offline_compress_with_model | 被 prompt_builder.py、context_cache.py 引用 → 不动 |
| `safe_filename.py` | 35 | safe_filename | **零引用**（chat.py/kb.py/files.py 各自定义了同名本地函数）→ 直接删除 |
| `text_utils.py` | 39 | extract_keywords | 被 task_classifier.py 引用 → 合入 utils.py |

**方案**：保留 `context_compressor.py`（455 行，足够独立），cancellation + text_utils 合并为 `common/utils.py`，`safe_filename.py` 直接删除。

```
common/
├── __init__.py
├── utils.py              ← cancellation + text_utils (~105行)
└── context_compressor.py ← 不动 (455行)
```

#### import 修正清单

| 文件 | 旧 import | 新 import |
|------|-----------|-----------|
| `knowledge_base.py` (将删除，拆到 knowledge/ 后自动更新) | `from common.cancellation import ...` | `from common.utils import ...` |
| `task_classifier.py:277` | `from common.text_utils import extract_keywords` | `from common.utils import extract_keywords` |

---

### 1.4 actions/ 收编

**目标**：将 `actions/doc_action.py` (299行) 移入 `pipelines/`（它只在 pipeline 中被调用）。

#### 引用方

| 文件 | import |
|------|--------|
| `pipelines/cloud_pipeline.py:134` | `from actions.doc_action import run_doc_action` |
| `pipelines/cloud_pipeline.py:455,623` | `from actions.doc_action import generate_docx` |
| `pipelines/local_pipeline.py:201,568` | `from actions.doc_action import run_doc_action, generate_docx` |
| `pipelines/_base.py:265,454` | `from actions.doc_action import run_doc_action, generate_docx` |

**方案**：`actions/doc_action.py` → `pipelines/doc_action.py`

```python
# 所有引用方改为：
from pipelines.doc_action import run_doc_action, generate_docx
```

#### 删除

- 删除 `actions/` 目录

---

### 1.5 validators/ 收编

**目标**：将 `validators/sidemate_validator.py` (241行) 移入 `common/`。

#### 引用方

| 文件 | import |
|------|--------|
| `routers/settings.py:928`（将拆分到 settings_cloud.py） | `from validators.sidemate_validator import SidemateValidator` |

**方案**：`validators/sidemate_validator.py` → `common/sidemate_validator.py`

```python
# settings_cloud.py 中：
from common.sidemate_validator import SidemateValidator
```

#### 删除

- 删除 `validators/` 目录

---

### 1.6 session/ 去反依赖

**目标**：消除 session/ 对 routers/ 的反向依赖。

#### 当前问题

```
session/chat_store.py:25    → from routers.deps import (get_current_chat_file, ..., CHAT_DIR)
session/context_cache.py:14 → from routers.deps import get_mgr
session/continuation.py:13  → from routers.deps import CHAT_DIR
```

#### 解决方案：引入 `session/_paths.py`

```python
# session/_paths.py — 路径常量，从 config.py 直接获取
from config import CHAT_DIR, FILES_DIR  # 直接从 config 取，不走 deps
```

#### chat_store.py 的依赖注入改造

```python
# 旧：直接依赖 routers.deps 的全局状态
from routers.deps import get_current_chat_file, set_current_chat, CHAT_DIR

# 新：通过参数传入，或从 config 取常量
from config import CHAT_DIR  # 常量直接从 config 取
# get_current_chat_file / set_current_chat 仍需从全局获取，
# 但改为从 server.py import（上游），而非从 routers.deps（同级路由）
```

**最终方案**：

| 常量/函数 | 旧来源 | 新来源 |
|-----------|--------|--------|
| `CHAT_DIR` | `routers.deps.CHAT_DIR` | `config.CHAT_DIR` |
| `get_current_chat_file` | `routers.deps.get_current_chat_file` | `server._current_chat_file`（或保留 deps） |
| `set_current_chat` | `routers.deps.set_current_chat` | `server._current_chat_file`（或保留 deps） |
| `get_mgr` | `routers.deps.get_mgr` | `server.mgr`（或保留 deps） |

**妥协方案**：如果完全消除 deps 引用太复杂（涉及 `get_current_chat_file` 的可变列表包装），则采用最小改动：仅将 `CHAT_DIR` 等常量改为从 `config` 直接取，保留 deps 中的函数引用。这些函数本身就是从 server 转发的。

---

## 2. Batch 2：数据聚合

### 2.1 data/ 目录重组

#### 当前 → 目标

```
data/                              data/
├── chats/          (保留)         ├── chats/              ← 用户数据
├── kb/             (保留)         ├── kb/                 ← 用户数据
├── kbsession/      (保留)         ├── kbsession/          ← 用户数据
├── docs/           (迁移)         ├── cache/
├── tmp_upload/     (迁移)         │   ├── docs/           ← 原 data/docs/
├── files/          (迁移)         │   ├── uploads/        ← 原 data/tmp_upload/
└── logs/           (保留但迁移)   │   └── files/          ← 原 data/files/
                                   └── logs/               ← 原 data/logs/
```

> 注：`recordings/` 在安装目录中不存在，纪要扩展安装时会自行创建。

#### 迁移映射表

| 旧路径 | 新路径 | 说明 |
|--------|--------|------|
| `data/docs/` | `data/cache/docs/` | KB 处理中的临时文档 |
| `data/tmp_upload/` | `data/cache/uploads/` | 上传临时文件 |
| `data/files/` | `data/cache/files/` | 工作区文件缓存 |
| `data/logs/` | `data/logs/` | 不变（仅添加清理策略） |

#### 代码改动

| 文件 | 改动 |
|------|------|
| `config.py` | 新增 `CACHE_DIR = os.path.join(DATA_DIR, "cache")`；修改 `UPLOAD_DIR` → `cache/uploads/`, `FILES_DIR` → `cache/files/`；新增 `DOCS_DIR = os.path.join(CACHE_DIR, "docs")` |
| `routers/deps.py` | `UPLOAD_DIR`, `FILES_DIR` 引用自动跟随 config 新值 |
| `pipelines/cloud_pipeline.py:458,626` | `os.path.join(ROOT_DIR, "data", "docs", ...)` → 引用 `config.DOCS_DIR` |
| `pipelines/local_pipeline.py:571` | 同上 |
| `pipelines/_base.py:457` | 同上 |
| `routers/chat.py:858` | 同上 |
| `knowledge_base.py`（已拆分到 knowledge/） | `self.data_dir` 路径不变（`data/kb/` 是用户数据，不迁） |

#### 迁移脚本（首次启动时执行）

```python
# core/data_migrator.py
def migrate_data_layout():
    """P4 首次启动时迁移 data/ 目录结构"""
    cache_dir = os.path.join(DATA_DIR, "cache")
    moves = [
        ("docs", "cache/docs"),
        ("tmp_upload", "cache/uploads"),
        ("files", "cache/files"),
    ]
    for old_name, new_rel in moves:
        old_path = os.path.join(DATA_DIR, old_name)
        new_path = os.path.join(DATA_DIR, new_rel)
        if os.path.isdir(old_path) and not os.path.isdir(new_path):
            os.makedirs(os.path.dirname(new_path), exist_ok=True)
            shutil.move(old_path, new_path)
            log.info("[DATA-MIGRATE] %s → %s", old_name, new_rel)
```

### 2.2 KB 向量泄漏修复

**问题**：`_save_vectors()` 写入 `kb_vectors.npz.tmp` 后 rename，但进程中断时 `.tmp.npz` 残留。

```python
# knowledge/ops.py (原 knowledge_base.py L667-692)

def _save_vectors(self):
    """原子写入向量索引"""
    if self.vectors is None or len(self.chunk_order) == 0:
        return

    tmp_path = self.vectors_path + ".tmp"
    try:
        np.savez_compressed(tmp_path, vectors=self.vectors, order=self.chunk_order)
        # 原子替换
        if os.path.exists(self.vectors_path):
            os.remove(self.vectors_path)
        os.rename(tmp_path, self.vectors_path)
    except Exception as e:
        log.error("[KB] 保存向量失败: %s", str(e))
        if os.path.exists(tmp_path):
            os.remove(tmp_path)  # 清理临时文件
        raise
```

**启动清理**（在 `_load_meta` 中）：

```python
# 启动时清理残留的 .tmp 文件
for f in os.listdir(self.data_dir):
    if f.endswith(".tmp") or f.endswith(".tmp.npz"):
        os.remove(os.path.join(self.data_dir, f))
        log.info("[KB] 清理残留临时文件: %s", f)
```

### 2.3 录音块自动清理

```python
# recorder_pkg/recorder_manager.py
# 转写完成后自动删除 chunks/ 目录
def _cleanup_chunks(self, session_id: str):
    chunks_dir = os.path.join(DATA_DIR, "recordings", session_id, "chunks")
    if os.path.isdir(chunks_dir):
        shutil.rmtree(chunks_dir, ignore_errors=True)
        log.info("[RECORDER] 已清理录音块: %s", session_id)
```

### 2.4 启动清理策略

```python
# core/cache_cleanup.py
import os, time, logging

def cleanup_cache(max_age_days=7):
    """清理 data/cache/ 中超过 max_age_days 天的文件"""
    cache_dir = os.path.join(DATA_DIR, "cache")
    if not os.path.isdir(cache_dir):
        return

    now = time.time()
    cutoff = now - max_age_days * 86400
    cleaned = 0

    for root, dirs, files in os.walk(cache_dir):
        for f in files:
            fpath = os.path.join(root, f)
            try:
                if os.path.getmtime(fpath) < cutoff:
                    os.remove(fpath)
                    cleaned += 1
            except Exception:
                pass

    if cleaned:
        log.info("[CACHE-CLEANUP] 清理 %d 个过期文件 (>=%d天)", cleaned, max_age_days)
```

### 2.5 ISS 卸载策略

在 `setup.iss` 的 `[UninstallDelete]` 段：

```iss
[UninstallDelete]
; 清理 cache 和 logs，保留用户数据
Type: filesandordirs; Name: "{app}\server\data\cache"
Type: filesandordirs; Name: "{app}\server\data\logs"
; 不删除 chats/ kb/ kbsession/ recordings/（用户数据）
```

---

## 3. Batch 3：依赖安全网

### 3.1 deps_check.py 增强

#### 新增功能流程

```
启动时 deps_check.check_and_repair(server_dir):
  1. check_all() — import 检查
  2. [首次] generate_manifest() — 扫描 site-packages/，生成 deps_manifest.json
  3. [首次] create_snapshot() — wheels/ → backup/deps_snapshot.zip
  4. [首次] 删除 wheels/ 目录
  5. [日常] verify_manifest() — SHA256 抽检 20% 核心包
  6. 发现损坏 → repair_from_snapshot() — 从 zip 解压覆盖
```

#### 新增 deps_manifest.json 结构

```json
{
  "version": "1.0",
  "generated_at": "2026-06-11T10:00:00",
  "snapshot_path": "backup/deps_snapshot.zip",
  "packages": {
    "torch": {
      "version": "2.3.1",
      "sha256": "abc123...",
      "files": ["torch/__init__.py", "torch/nn/modules/..."]
    },
    "transformers": {
      "version": "4.42.0",
      "sha256": "def456...",
      "files": [...]
    }
  }
}
```

#### SHA256 抽检逻辑

```python
# core/deps_check.py 新增

CORE_PACKAGES = {"torch", "transformers", "sentence_transformers", "numpy", "faiss"}

def verify_manifest(site_packages: str, manifest: dict) -> list:
    """抽检核心包的 SHA256"""
    broken = []
    packages = manifest.get("packages", {})

    # 核心包全检 + 其他包抽检 20%
    check_set = set()
    for pkg_name in packages:
        if pkg_name in CORE_PACKAGES:
            check_set.add(pkg_name)
        elif random.random() < 0.2:
            check_set.add(pkg_name)

    for pkg_name in check_set:
        info = packages[pkg_name]
        pkg_dir = os.path.join(site_packages, pkg_name.replace("-", "_"))
        if not os.path.isdir(pkg_dir):
            broken.append(pkg_name)
            continue

        # 抽检入口文件
        init_file = os.path.join(pkg_dir, "__init__.py")
        if os.path.isfile(init_file):
            actual = sha256_file(init_file)
            expected = info.get("sha256", "")
            if expected and actual != expected:
                broken.append(pkg_name)

    return broken
```

#### 压缩备份

```python
def create_snapshot(wheels_dir: str, backup_dir: str) -> str:
    """wheels/ → backup/deps_snapshot.zip"""
    os.makedirs(backup_dir, exist_ok=True)
    zip_path = os.path.join(backup_dir, "deps_snapshot.zip")

    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zf:
        for root, dirs, files in os.walk(wheels_dir):
            for f in files:
                fpath = os.path.join(root, f)
                arcname = os.path.relpath(fpath, wheels_dir)
                zf.write(fpath, arcname)

    return zip_path
```

#### 调用时机

```python
# server.py 启动序列
def startup():
    # ... 现有启动逻辑 ...

    # 依赖安全网
    manifest_path = os.path.join(DATA_DIR, "deps_manifest.json")
    if not os.path.exists(manifest_path):
        # 首次启动：生成 manifest + 创建 snapshot + 删除 wheels/
        generate_manifest_and_snapshot(SITE_PACKAGES, WHEELS_DIR, BACKUP_DIR)
    else:
        # 日常：抽检 → 发现损坏 → 自修复
        broken = verify_manifest(SITE_PACKAGES, load_manifest(manifest_path))
        if broken:
            repair_from_snapshot(BACKUP_DIR, broken)
```

---

## 4. Batch 4：收尾 + 扩展注册 + 产品化基础

### 4.1 ISS 脚本更新

#### 新增/修改的 ISS 指令

```iss
; ===== setup.iss 修改 =====

[Setup]
; 品牌图（P4 新增）
WizardImageFile=installer\wizard_image.bmp
WizardSmallImageFile=installer\wizard_small.bmp

; EULA 页（P4 新增）
InfoBeforeFile=LICENSE
InfoBeforeType=ftANSI

; 版本号
AppVerName=Sidemate v0.9 Patch 4
VersionInfoVersion=0.9.4.0

[Files]
; 核心文件
Source: "server\*"; DestDir: "{app}\server"; Flags: ignoreversion recursesubdirs; Excludes: "__pycache__,*.pyc,data\chats,data\kb,data\kbsession,data\recordings,settings.json"

; LICENSE 打包
Source: "LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "THIRD-PARTY-NOTICES"; DestDir: "{app}"; Flags: ignoreversion

; wheels/ 仍需打包（首次启动后会被压缩为 snapshot）
Source: "wheels\*"; DestDir: "{app}\wheels"; Flags: ignoreversion recursesubdirs

[UninstallDelete]
Type: filesandordirs; Name: "{app}\server\data\cache"
Type: filesandordirs; Name: "{app}\server\data\logs"
Type: filesandordirs; Name: "{app}\backup"
; 保留：{app}\server\data\chats, kb, kbsession, recordings
```

#### 不打包项（Excludes）

- `settings.json` — 运行时生成
- `extensions/*.json` — 运行时生成
- `data/chats/`, `data/kb/`, `data/kbsession/`, `data/recordings/` — 用户数据

### 4.2 LLM 扩展注册

#### registry.py 变更

```python
# extensions/registry.py
class ExtensionRegistry:
    VALID_IDS = {"knowledge", "recorder", "llm"}  # 新增 "llm"
```

#### 安装时注册逻辑

```python
# _install_worker() 中（settings_cloud.py），安装 ext_type == "model" 时：
if ext_type == "model":
    # 检测是否为 LLM 模型包
    if manifest.get("model_type") == "llm" or "gguf" in str(manifest.get("files", [])):
        registry.register("llm", {
            "version": manifest.get("version", "1.0.0"),
            "models": {"llm": f"models/{model_name}"},
        })
```

#### KB 包依赖声明

```json
// extensions/knowledge/manifest.json（打包时写入）
{
  "id": "knowledge",
  "version": "1.0.0",
  "requires": ["llm"],
  "models": {
    "embedding": "models/embedding",
    "reranker": "models/reranker"
  }
}
```

#### 安装引导检查

```python
# settings_cloud.py 中的扩展安装逻辑
def _check_requires(manifest: dict) -> list:
    """检查扩展的前置依赖"""
    requires = manifest.get("requires", [])
    missing = []
    for req in requires:
        if req == "llm" and not registry.is_installed("llm"):
            missing.append("LLM 模型包")
    return missing
```

### 4.3 产品化元素

#### ISS 品牌图

需要准备两张 BMP 图片：

| 图片 | 尺寸 | 用途 |
|------|------|------|
| `installer/wizard_image.bmp` | 164×314 px | 安装向导左侧大图 |
| `installer/wizard_small.bmp` | 55×55 px | 安装向导右上角小图标 |

#### LICENSE 文件打包

- `LICENSE`（专有 EULA）→ 安装根目录
- `THIRD-PARTY-NOTICES` → 安装根目录
- ISS `InfoBeforeFile=LICENSE` 在安装向导中展示 EULA

#### /api/onboard/status（为 Batch 5 准备）

```python
# routers/settings_general.py
@router.get("/api/onboard/status")
def api_onboard_status():
    """返回当前安装状态（首次引导用）"""
    from extensions.registry import ExtensionRegistry
    from config import get as cfg_get

    registry = ExtensionRegistry(os.path.join(_project_dir(), "extensions"))

    return {
        "llm_installed": registry.is_installed("llm"),
        "cloud_configured": bool(cfg_get("cloud_api_key", "")),
        "kb_installed": registry.is_installed("knowledge"),
        "recorder_installed": registry.is_installed("recorder"),
        "model_loaded": _is_model_loaded(),  # 检查 Ollama 是否有模型
    }
```

---

## 5. Batch 5：首次引导 + 多状态审查 + 关于对话框

### 5.1 前端 Onboarding 组件

#### 文件结构

```
static/js/onboarding.js   ← 新增 (~200 行)
```

#### 组件设计

```javascript
// static/js/onboarding.js

async function showOnboarding() {
    const status = await fetch('/api/onboard/status').then(r => r.json());
    const hasAI = status.llm_installed || status.cloud_configured;
    const hasKB = status.kb_installed;
    const hasCloud = status.cloud_configured;

    const overlay = document.createElement('div');
    overlay.id = 'onboarding-overlay';
    overlay.className = 'onboarding-overlay';

    if (!hasAI) {
        renderRoute1(overlay);
    } else if (!hasKB) {
        renderRoute2(overlay, { hasCloud });
    } else {
        renderRoute3(overlay, { hasCloud });
    }

    document.body.appendChild(overlay);
}

function renderRoute1(overlay) { /* ... */ }
function renderRoute2(overlay, opts) { /* ... */ }
function renderRoute3(overlay, opts) { /* ... */ }

function closeOnboarding() {
    localStorage.setItem('sidemate_onboarded', '1');
    document.getElementById('onboarding-overlay')?.remove();
}
```

#### 触发时机

```javascript
// index.html <script> 尾部
window.addEventListener('DOMContentLoaded', () => {
    if (!localStorage.getItem('sidemate_onboarded')) {
        showOnboarding();
    }
});
```

### 5.2 CSS 样式

```css
/* static/css/onboarding.css */
.onboarding-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
}

.onboarding-card {
    background: var(--bg-primary);
    border-radius: 16px;
    padding: 40px;
    max-width: 520px;
    width: 90%;
    text-align: center;
}
```

### 5.3 多状态审查清单

#### 6 种状态 + 审查重点

| # | LLM | Cloud | KB | 审查文件 | 重点 |
|---|-----|-------|----|---------|------|
| S1 | ❌ | ❌ | ❌ | `updateChatOverlay()`, `api_mode()` | 锁屏+引导是否正常 |
| S2 | ❌ | ✅ | ❌ | `cloud_pipeline.py`, `mode/switch` | 在线 Chat 是否正常 |
| S3 | ✅ | ❌ | ❌ | `local_pipeline.py`, `mode` | 离线 Chat 标准路径 |
| S4 | ✅ | ✅ | ❌ | `mode/switch`, 前端 Tab 显隐 | 模式切换是否干净 |
| S5 | ✅ | ❌ | ✅ | `kb.py`, `compare_pipeline.py` | 对比按钮是否隐藏 |
| S6 | ✅ | ✅ | ✅ | 全链路 | 标准路径 |

#### 审查清单

- [ ] `pipelines/__init__.py` 的 `create_pipeline()` — 6 种状态下路由是否正确
- [ ] `index.html` 的 Tab 显隐逻辑 — KB Tab 在 KB 未安装时是否隐藏
- [ ] 对比按钮在 Cloud 未配置时是否隐藏/禁用
- [ ] `updateChatOverlay()` 在无模型时的行为
- [ ] SSE 管道在 Cloud 模式但 API Key 无效时的错误处理

### 5.4 "关于"对话框

#### settings.js 新增函数

```javascript
function showAbout() {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';
    modal.innerHTML = `
        <div class="about-dialog">
            <img src="/static/img/logo.svg" class="about-logo" />
            <h2>桌伴 Sidemate</h2>
            <p class="about-version">v${APP_VERSION}</p>
            <p class="about-copyright">© 2026 许清楚. All rights reserved.</p>
            <div class="about-env" id="about-env"></div>
            <button onclick="this.closest('.modal-overlay').remove()">关闭</button>
        </div>
    `;

    // 加载环境信息
    fetch('/api/system/info').then(r => r.json()).then(data => {
        document.getElementById('about-env').innerHTML = `
            <p>Python ${data.python_version || '-'}</p>
            <p>Ollama ${data.ollama_version || '-'}</p>
            <p>${data.gpu_info || '无 GPU 信息'}</p>
        `;
    });

    document.body.appendChild(modal);
}
```

#### 后端补充

```python
# routers/settings_general.py
@router.get("/api/system/info")
def api_system_info():
    """系统运行环境信息"""
    import platform
    return {
        "python_version": platform.python_version(),
        "ollama_version": _get_ollama_version(),  # 从 ollama_manager 获取
        "gpu_info": _get_gpu_info(),               # 从 Vulkan/设备信息获取
        "app_version": "0.9.4",
        "build_date": "2026-06-11",
    }
```

### 5.5 版本号展示优化

| 位置 | 当前 | 改动 |
|------|------|------|
| 设置页标题栏 | "桌伴 Sidemate" | → "桌伴 Sidemate v0.9.4" |
| 浏览器标签 | 固定标题 | → `document.title = "桌伴 v0.9"` |
| 版本来源 | 硬编码 | → 从 `/api/settings` 获取 `version_display` |

```python
# server.py 新增/修改
VERSION = "0.9"
VERSION_PATCH = 4  # 从 0 改为 4
```

注意：版本号统一在 `server.py` 的 `VERSION` / `VERSION_PATCH` 定义，不在 config.py（config.py 只管路径和 token 配置）。

---

## 6. 实施顺序与依赖关系

```
Batch 1: 代码重构（纯搬迁 + import 修正）
├── 1.1 knowledge_base.py → knowledge/ 子包
├── 1.2 settings.py → 3 个路由文件
├── 1.3 common/ 四合一
├── 1.4 actions/ 收编到 pipelines/
├── 1.5 validators/ 收编到 common/
└── 1.6 session/ 去反依赖

    ↓  依赖 Batch 1 的目录结构

Batch 2: 数据聚合
├── 2.1 data/ 目录重组 + 迁移脚本
├── 2.2 KB 向量泄漏修复
├── 2.3 录音块自动清理
├── 2.4 启动清理策略
└── 2.5 ISS 卸载策略（写 ISS）

    ↓  依赖 Batch 2 的 data/ 布局

Batch 3: 依赖安全网
├── 3.1 deps_check.py 增强（manifest + SHA256 + snapshot）
└── 3.2 server.py 启动序列集成

    ↓  依赖 Batch 1-3 的最终目录结构

Batch 4: 收尾 + 产品化
├── 4.1 ISS 脚本更新（适配新目录 + EULA + 品牌图）
├── 4.2 LLM 扩展注册
├── 4.3 /api/onboard/status
└── 4.4 冒烟测试

    ↓  依赖 Batch 4 的 API

Batch 5: 首次引导 + 关于
├── 5.1 前端 Onboarding 组件
├── 5.2 多状态审查（6 种状态）
├── 5.3 "关于"对话框
└── 5.4 版本号展示优化
```

---

## 7. 风险与回滚

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| knowledge_base.py 拆分导致循环 import | 启动失败 | compat.py re-export 兜底 |
| data/ 迁移失败 | 用户数据丢失 | 迁移前备份，move 而非 copy |
| SHA256 校验误报 | 正常包被"修复" | 仅抽检核心包，阈值保守 |
| ISS EULA 页编码问题 | 中文乱码 | 使用 ANSI 编码或 UTF-8 BOM |
| 6 状态审查发现阻塞 bug | 延期 | 批量修复，P3 hotfix 兜底 |

---

## 8. 不做的事

| 项目 | 原因 |
|------|------|
| JS 模块化重构 | 传统 script 模式收益不大 |
| common/context_compressor.py 拆分 | 455 行合理，无需拆 |
| API 路由前缀变更 | 影响前端所有 fetch 调用 |
| data/ 使用 SQLite | 当前 JSON 文件方案足够 |
