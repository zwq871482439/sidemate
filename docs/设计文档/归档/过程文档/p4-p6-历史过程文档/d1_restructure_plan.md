# 桌伴 Patch5 D1 — 目录重构完整迁移方案

> **架构师**: 高见远  
> **日期**: 2025-06-20  
> **Git Tag**: `v0.9.5-pre-restructure`（已备份，可回滚）  
> **风险等级**: 🔴 高（涉及数据迁移 + 代码迁移 + 路径配置 + Go Launcher）

---

## 目录

1. [路径映射表（完整）](#1-路径映射表完整)
2. [import 路径变更表](#2-import-路径变更表)
3. [config.py 变更](#3-configpy-变更)
4. [.gitignore 变更](#4-gitignore-变更)
5. [Go Launcher 影响评估](#5-go-launcher-影响评估)
6. [有序实施步骤](#6-有序实施步骤)
7. [风险评估 + 验证点](#7-风险评估--验证点)

---

## 1. 路径映射表（完整）

### 1A. 数据迁移（用户数据 — `mv` 移动）

| # | 当前路径 | 目标路径 | 类型 | 说明 |
|---|---------|---------|------|------|
| D1 | `server/data/` | `data/` | **数据提升** | 整个目录提升到项目根，所有子目录跟随（chats/logs/cache/backup/kbsession/kb/deps_manifest.json/.onboard_done） |
| D2 | `server/knowledge/data/kb/` | `data/kb/` | **数据合并** | KB 数据合并进 data/kb/（kb_meta.json/kb_vectors.npz/kb_texts/）。**注意**：`server/data/kb/` 已存在且为空壳（backup.py 引用），迁移后 knowledge/data/kb 的内容合并进来 |
| D3 | `server/recorder_pkg/data/recordings/` | `data/recorder/` | **数据提升** | 录音数据提升到 data/recorder/（audio/chunks/sessions.json） |
| D4 | `server/settings.json` | `data/settings.json` | **配置提升** | 用户运行时配置提升到 data/ |

**⚠️ 重要发现**：`server/data/kb/` 和 `server/knowledge/data/kb/` 是**两个不同的 kb 目录**：
- `server/data/kb/` — backup.py 引用的位置（`os.path.join(DATA_DIR, "kb", ...)`），目前可能为空或只有少量文件
- `server/knowledge/data/kb/` — KnowledgeBase 实际使用的位置（`ops.py` 中 `base_dir + "data/kb"`），存放真正的 kb_meta.json / kb_vectors.npz / kb_texts/

**迁移策略**：以 `knowledge/data/kb/` 为准（真实数据），合并到 `data/kb/`。`server/data/kb/` 如果有残留文件也合并进来。

### 1B. 代码迁移（`mv` 移动 + import 修改）

| # | 当前路径 | 目标路径 | 类型 | 说明 |
|---|---------|---------|------|------|
| C1 | `server/files/file_extractor.py` | `server/knowledge/file_extractor.py` | **代码合并** | 合并进 knowledge 包 |
| C2 | `server/files/doc_reader.py` | `server/knowledge/doc_reader.py` | **代码合并** | 合并进 knowledge 包 |
| C3 | `server/files/doc_writer.py` | `server/knowledge/doc_writer.py` | **代码合并** | 合并进 knowledge 包 |
| C4 | `server/files/file_reader.py` | `server/knowledge/file_reader.py` | **代码合并** | 合并进 knowledge 包 |
| C5 | `server/files/__init__.py` | （删除） | **删除** | 空文件，合并后 knowledge/__init__.py 已有 |
| C6 | `server/extensions/registry.py` | `server/core/extension_manager.py` | **代码合并** | ExtensionRegistry 类合并进 core/ |
| C7 | `server/extensions/knowledge.json` | `data/extensions/knowledge.json` | **注册数据迁移** | 注册 JSON 迁移到 data/extensions/ |
| C8 | `server/extensions/llm.json` | `data/extensions/llm.json` | **注册数据迁移** | 注册 JSON 迁移到 data/extensions/ |
| C9 | `server/extensions/__init__.py` | （删除或改为 re-export） | **删除** | 合并后不再需要 |

### 1C. 目录删除（迁移完成后）

| 路径 | 操作 | 前提 |
|------|------|------|
| `server/files/` | 删除整个目录 | C1-C5 完成后 |
| `server/extensions/` | 删除整个目录 | C6-C9 完成后 |
| `server/knowledge/data/` | 删除（已迁移到 data/kb/） | D2 完成后 |
| `server/recorder_pkg/data/` | 删除（已迁移到 data/recorder/） | D3 完成后 |
| `server/data/` | 删除（已迁移到 data/） | D1 完成后 |

---

## 2. import 路径变更表

### 2A. `from files.*` → `from knowledge.*`（4 个文件，17 处 import）

| 当前 import | 目标 import | 影响文件 | 行号 |
|------------|------------|---------|------|
| `from files.doc_reader import DocReader` | `from knowledge.doc_reader import DocReader` | `core/batch_queue.py` | 645 |
| `from files.file_extractor import extract_text` | `from knowledge.file_extractor import extract_text` | `core/batch_queue.py` | 696, 705, 714, 723 |
| `from files.file_extractor import process_uploaded_file, calc_file_budget` | `from knowledge.file_extractor import process_uploaded_file, calc_file_budget` | `routers/chat.py` | 246 |
| `from files.file_extractor import calc_file_budget, smart_extract` | `from knowledge.file_extractor import calc_file_budget, smart_extract` | `routers/chat.py` | 261 |
| `from files.doc_reader import DocReader` | `from knowledge.doc_reader import DocReader` | `routers/chat.py` | 736 |
| `from files.file_extractor import calc_file_budget, smart_extract` | `from knowledge.file_extractor import calc_file_budget, smart_extract` | `pipelines/_base.py` | 280 |
| `from files.file_extractor import calc_file_budget, smart_extract` | `from knowledge.file_extractor import calc_file_budget, smart_extract` | `pipelines/local_pipeline.py` | 214 |
| `from files.doc_reader import DocReader` | `from knowledge.doc_reader import DocReader` | `routers/kb.py` | 117 |
| `from files.file_extractor import extract_text` | `from knowledge.file_extractor import extract_text` | `routers/kb.py` | 166, 170, 174, 178 |
| `from files.file_extractor import calc_file_budget, smart_extract` | `from knowledge.file_extractor import calc_file_budget, smart_extract` | `pipelines/cloud_pipeline.py` | 146 |

**受影响文件清单（10 个文件）**：
1. `server/core/batch_queue.py`
2. `server/routers/chat.py`
3. `server/routers/kb.py`
4. `server/pipelines/_base.py`
5. `server/pipelines/local_pipeline.py`
6. `server/pipelines/cloud_pipeline.py`

**注意**：`server/routers/files.py` 第 435 行 `from routers import files as _r_files` 是 **router 模块注册**，不受影响（这是 FastAPI router，不是 files 包）。

### 2B. `from extensions.*` → `from core.extension_manager`（10 个文件，13 处 import）

| 当前 import | 目标 import | 影响文件 | 行号 |
|------------|------------|---------|------|
| `from extensions.registry import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `extensions/__init__.py` | 7（此文件将删除） |
| `from extensions.registry import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `routers/kb.py` | 189 |
| `from extensions.registry import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `routers/settings_extensions.py` | 196, 280, 669, 786, 819, 837, 858 |
| `from extensions.registry import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `routers/settings_system.py` | 500 |
| `from extensions import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `routers/kb.py` | 63 |
| `from extensions import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `routers/recorder.py` | 62 |
| `from extensions import ExtensionRegistry` | `from core.extension_manager import ExtensionRegistry` | `recorder_pkg/recorder_manager.py` | 151 |

**受影响文件清单（6 个文件）**：
1. `server/routers/kb.py`
2. `server/routers/settings_extensions.py`
3. `server/routers/settings_system.py`
4. `server/routers/recorder.py`
5. `server/recorder_pkg/recorder_manager.py`
6. `server/server.py`（第 351 行 `from extensions import ExtensionRegistry`）

### 2C. 扩展目录路径引用变更（所有 `os.path.join(ROOT_DIR, "extensions")` 需改为 `data/extensions`）

| 当前路径计算 | 目标路径计算 | 影响文件 | 行号 |
|------------|------------|---------|------|
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `server/server.py` | 352 |
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `routers/kb.py` | 53（`_get_extensions_dir`） |
| `os.path.join(_project_dir, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `routers/kb.py` | 191 |
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `routers/recorder.py` | 52（`_get_extensions_dir`） |
| `os.path.join(_project_dir, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `routers/settings_extensions.py` | 197, 281, 670, 787, 820, 838, 859 |
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `routers/settings_system.py` | 502, 510 |
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `knowledge/embedding_engine.py` | 75 |
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `knowledge/reranker_engine.py` | 50 |
| `os.path.dirname(pkg_dir) + "extensions"` | `os.path.join(DATA_DIR, "extensions")` | `recorder_pkg/recorder_manager.py` | 145（`_get_extensions_dir`） |
| `os.path.join(ROOT_DIR, "extensions")` | `os.path.join(DATA_DIR, "extensions")` | `recorder_pkg/recorder_manager.py` | 163 |

**⚠️ 这是最容易漏改的部分**。建议在 `config.py` 中新增 `EXTENSIONS_DIR` 常量统一管理，所有引用处改为 `from config import EXTENSIONS_DIR`。

---

## 3. config.py 变更

### 3A. 新增 PROJECT_ROOT 常量

```python
# config.py 新增

# 项目根目录（C:\Sidemate\，server 的父目录）
PROJECT_ROOT = os.path.dirname(ROOT_DIR)  # ROOT_DIR = server/，PROJECT_ROOT = C:\Sidemate\
```

### 3B. 路径常量变更

```python
# config.py 修改前 → 修改后

# ===== 修改前 =====
DATA_DIR = os.path.join(ROOT_DIR, "data")
# _CONFIG_FILE = os.path.join(ROOT_DIR, "settings.json")

# ===== 修改后 =====
PROJECT_ROOT = os.path.dirname(ROOT_DIR)
DATA_DIR = os.path.join(PROJECT_ROOT, "data")
_CONFIG_FILE = os.path.join(DATA_DIR, "settings.json")

# 新增：扩展注册数据目录（JSON 文件）
EXTENSIONS_DIR = os.path.join(DATA_DIR, "extensions")

# 新增：录音数据目录
RECORDER_DATA_DIR = os.path.join(DATA_DIR, "recorder")

# KB 数据目录（显式定义，不再依赖 knowledge 包内部 __file__ 推导）
KB_DATA_DIR = os.path.join(DATA_DIR, "kb")
```

### 3C. 完整变更后的路径常量区

```python
# ===== 工作区根目录 =====
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))           # C:\Sidemate\server
PROJECT_ROOT = os.path.dirname(ROOT_DIR)                         # C:\Sidemate\

# ===== 运行时目录（统一管理） =====
DATA_DIR = os.path.join(PROJECT_ROOT, "data")                    # C:\Sidemate\data
CACHE_DIR = os.path.join(DATA_DIR, "cache")
CHAT_DIR = os.path.join(DATA_DIR, "chats")
LOG_DIR = os.path.join(DATA_DIR, "logs")
UPLOAD_DIR = os.path.join(CACHE_DIR, "uploads")
FILES_DIR = os.path.join(CACHE_DIR, "files")
DOCS_DIR = os.path.join(CACHE_DIR, "docs")
KBSESSION_DIR = os.path.join(DATA_DIR, "kbsession")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")
KB_DATA_DIR = os.path.join(DATA_DIR, "kb")                       # 新增
EXTENSIONS_DIR = os.path.join(DATA_DIR, "extensions")            # 新增
RECORDER_DATA_DIR = os.path.join(DATA_DIR, "recorder")           # 新增

# 配置文件路径
_CONFIG_FILE = os.path.join(DATA_DIR, "settings.json")           # 从 ROOT_DIR 改到 DATA_DIR

WORKSPACE_DIR = ROOT_DIR  # 保持向后兼容
```

### 3D. ensure_dirs() 变更

```python
def ensure_dirs():
    """确保所有运行时目录存在"""
    for d in [DATA_DIR, CHAT_DIR, LOG_DIR, CACHE_DIR, UPLOAD_DIR, FILES_DIR, DOCS_DIR,
              KBSESSION_DIR, BACKUP_DIR, KB_DATA_DIR, EXTENSIONS_DIR, RECORDER_DATA_DIR]:
        os.makedirs(d, exist_ok=True)
```

### 3E. DEFAULTS 变更

```python
DEFAULTS = {
    ...
    # 修改：扩展目录从 ROOT_DIR 改为 DATA_DIR
    "extensions_dir": "",  # 空=运行时解析为 DATA_DIR/extensions（不再是 ROOT_DIR/extensions）
    
    # 修改：KB 数据目录
    "kb_data_dir": "",  # 空=运行时解析为 DATA_DIR/kb（不再是 knowledge/data/kb）
    ...
}
```

---

## 4. .gitignore 变更

### 修改前

```gitignore
# ====== 用户数据（运行时生成）======
# 主数据目录
server/data/
# KB 知识库数据
server/knowledge/data/
# 录音数据
server/recorder_pkg/data/
# 用户配置
server/settings.json
```

### 修改后

```gitignore
# ====== 用户数据（运行时生成）======
# 统一数据目录（D1 重构后，所有用户数据在项目根 data/ 下）
data/
```

**简化说明**：4 条规则合并为 1 条 `data/`。settings.json、kb 数据、录音数据全部在 `data/` 下，一条规则全覆盖。

---

## 5. Go Launcher 影响评估

### 5A. Go Launcher 硬编码路径清单（`launcher/main.go`）

| 行号 | 当前路径 | 用途 | 需要改吗？ |
|------|---------|------|-----------|
| 530 | `filepath.Join(appDir, "server", "data", "logs", "launcher.log")` | Launcher 日志 | **✅ 是** → `filepath.Join(appDir, "data", "logs", "launcher.log")` |
| 613 | `filepath.Join(appDir, "server", "data", "logs", "ollama-stdout.log")` | Ollama stdout 重定向 | **✅ 是** → `filepath.Join(appDir, "data", "logs", "ollama-stdout.log")` |
| 785 | `filepath.Join(serverDir, "data", "logs", "python-stdout.log")` | Python stdout 重定向（serverDir = server/） | **✅ 是** → `filepath.Join(appDir, "data", "logs", "python-stdout.log")` |
| 814 | `filepath.Join(appDir, "server", "data", "startup_progress.json")` | 启动进度文件（删除旧文件） | **✅ 是** → `filepath.Join(appDir, "data", "startup_progress.json")` |
| 822 | `filepath.Join(appDir, "server", "data", "startup_progress.json")` | 启动进度文件（轮询读取） | **✅ 是** → `filepath.Join(appDir, "data", "startup_progress.json")` |
| 899 | `filepath.Join(appDir, "server", "data", "startup_progress.json")` | 启动进度文件（成功后删除） | **✅ 是** → `filepath.Join(appDir, "data", "startup_progress.json")` |
| 52 | `filepath.Join(appDir, "server", "models")` | OLLAMA_MODELS 环境变量 | **❌ 否**（server/models 是 Junction，不动） |
| 54 | `filepath.Join(appDir, "server", "server.py")` | FastAPI 入口脚本 | **❌ 否**（server.py 不动） |

### 5B. watchdog.go 路径

| 行号 | 当前路径 | 用途 | 需要改吗？ |
|------|---------|------|-----------|
| 68 | `filepath.Join(appDir, "server", "data", "logs", "launcher.log")` | Watchdog 日志 | **✅ 是** → `filepath.Join(appDir, "data", "logs", "launcher.log")` |

### 5C. tray_windows.go 路径

| 行号 | 当前路径 | 用途 | 需要改吗？ |
|------|---------|------|-----------|
| 249 | `filepath.Join(appDir, "server", "static", "img", "logo.ico")` | 托盘图标 | **❌ 否**（static/ 不动） |

### 5D. server.py 中的进度文件路径

```python
# server.py 第 46 行
_PROG红线_FILE = os.path.join(_server_dir, "data", "startup_progress.json")
```

**✅ 需要改** → `os.path.join(DATA_DIR, "startup_progress.json")`（DATA_DIR 重构后指向 `C:\Sidemate\data`）

### 5E. Go Launcher 修改总结

**共 7 处需修改**（main.go 6 处 + watchdog.go 1 处），全部是 `"server", "data"` → `"data"` 的模式：

```go
// 修改前（所有出现的地方）：
filepath.Join(appDir, "server", "data", ...)

// 修改后：
filepath.Join(appDir, "data", ...)
```

**特殊情况**：`main.go:785` 用的是 `serverDir`（= `server/` 目录），不是 `appDir`：
```go
// 修改前：
pythonLogPath := filepath.Join(serverDir, "data", "logs", "python-stdout.log")

// 修改后：
pythonLogPath := filepath.Join(appDir, "data", "logs", "python-stdout.log")
```

**⚠️ Go Launcher 改完必须重新编译**：
```bash
cd C:\Sidemate\launcher
go build -o Sidemate.exe .
```

---

## 6. 有序实施步骤

### Phase 0: 准备（确保可回滚）

```bash
# 0.1 确认 git tag 存在
cd C:\Sidemate
git tag -l "v0.9.5-pre-restructure"

# 0.2 创建重构分支
git checkout -b patch5-d1-restructure
```

**验证点**：`git tag -l` 能看到 tag，分支创建成功。

---

### Phase 1: 数据迁移（mv，最关键）

> ⚠️ **先停掉 Sidemate 服务**，确保没有进程占用文件。

```bash
cd C:\Sidemate

# 1.1 创建目标根 data 目录
mkdir data

# 1.2 迁移主数据目录 server/data/ → data/
#     （chats/logs/cache/backup/kbsession/kb/deps_manifest.json/.onboard_done 全部跟随）
mv server/data/* data/
mv server/data/.onboard_done data/   # 隐藏文件单独 mv

# 1.3 合并 KB 数据：server/knowledge/data/kb/ → data/kb/
#     注意：data/kb/ 可能已有残留（来自 server/data/kb/），需要合并
#     策略：knowledge/data/kb 是真实数据，优先保留
cp -rn server/knowledge/data/kb/* data/kb/ 2>/dev/null || true
# 确认复制成功后删除源
rm -rf server/knowledge/data

# 1.4 迁移录音数据：server/recorder_pkg/data/recordings/ → data/recorder/
mv server/recorder_pkg/data/recordings data/recorder
# 删除空的 data 目录
rmdir server/recorder_pkg/data 2>/dev/null || true

# 1.5 迁移用户配置：server/settings.json → data/settings.json
mv server/settings.json data/settings.json

# 1.6 创建扩展注册数据目录，迁移 JSON
mkdir -p data/extensions
mv server/extensions/knowledge.json data/extensions/
mv server/extensions/llm.json data/extensions/
```

**验证点**：
```bash
# 确认数据完整
ls data/chats/        # 有聊天文件
ls data/kb/           # 有 kb_meta.json, kb_vectors.npz, kb_texts/
ls data/recorder/     # 有 audio/, chunks/, sessions.json
ls data/logs/         # 有 server.log
cat data/settings.json # 能正常读取
ls data/extensions/   # 有 knowledge.json, llm.json
```

---

### Phase 2: 代码迁移（extensions → core/）

```bash
cd C:\Sidemate\server

# 2.1 迁移 registry.py → core/extension_manager.py
mv extensions/registry.py core/extension_manager.py

# 2.2 删除 extensions 包（__init__.py 和 __pycache__）
rm -rf extensions/__init__.py
rm -rf extensions/__pycache__
rmdir extensions 2>/dev/null || true
```

**验证点**：`ls core/extension_manager.py` 存在，`ls extensions/` 不存在。

---

### Phase 3: 代码迁移（files → knowledge/）

```bash
cd C:\Sidemate\server

# 3.1 迁移 files 包的 4 个 .py 文件到 knowledge/
mv files/file_extractor.py knowledge/
mv files/doc_reader.py knowledge/
mv files/doc_writer.py knowledge/
mv files/file_reader.py knowledge/

# 3.2 删除 files 包
rm -rf files/__init__.py
rm -rf files/__pycache__
rmdir files 2>/dev/null || true
```

**验证点**：`ls knowledge/file_extractor.py` 存在，`ls files/` 不存在。

---

### Phase 4: config.py 修改

修改 `server/config.py`：

1. 新增 `PROJECT_ROOT` 常量
2. `DATA_DIR` 改为 `os.path.join(PROJECT_ROOT, "data")`
3. `_CONFIG_FILE` 改为 `os.path.join(DATA_DIR, "settings.json")`
4. 新增 `KB_DATA_DIR`、`EXTENSIONS_DIR`、`RECORDER_DATA_DIR`
5. `ensure_dirs()` 加入新目录

**验证点**：
```bash
cd C:\Sidemate\server
python -c "from config import DATA_DIR, PROJECT_ROOT, EXTENSIONS_DIR, KB_DATA_DIR, RECORDER_DATA_DIR; print('DATA_DIR:', DATA_DIR); print('PROJECT_ROOT:', PROJECT_ROOT)"
# 预期输出：
# DATA_DIR: C:\Sidemate\data
# PROJECT_ROOT: C:\Sidemate
```

---

### Phase 5: import 修改（批量替换）

#### 5A. files → knowledge（6 个文件）

```bash
# 批量替换 from files. → from knowledge.
# 需要修改的文件：
# - core/batch_queue.py
# - routers/chat.py
# - routers/kb.py
# - pipelines/_base.py
# - pipelines/local_pipeline.py
# - pipelines/cloud_pipeline.py
```

具体替换规则：
- `from files.file_extractor` → `from knowledge.file_extractor`
- `from files.doc_reader` → `from knowledge.doc_reader`
- `from files.doc_writer` → `from knowledge.doc_writer`
- `from files.file_reader` → `from knowledge.file_reader`

#### 5B. extensions → core.extension_manager（6 个文件）

```bash
# 批量替换：
# from extensions.registry import ExtensionRegistry → from core.extension_manager import ExtensionRegistry
# from extensions import ExtensionRegistry → from core.extension_manager import ExtensionRegistry
```

需修改文件：
- `server/server.py`（第 351 行）
- `routers/kb.py`（第 63, 189 行）
- `routers/settings_extensions.py`（第 196, 280, 669, 786, 819, 837, 858 行）
- `routers/settings_system.py`（第 500 行）
- `routers/recorder.py`（第 62 行）
- `recorder_pkg/recorder_manager.py`（第 151 行）

#### 5C. 扩展目录路径引用（os.path.join 改 EXTENSIONS_DIR）

**推荐做法**：在 config.py 新增 `EXTENSIONS_DIR` 后，所有引用处改为：

```python
from config import EXTENSIONS_DIR
registry = ExtensionRegistry(EXTENSIONS_DIR)
```

需修改文件（10 个文件，~16 处）：
- `server/server.py`（第 352 行）
- `routers/kb.py`（第 53, 191 行的 `_get_extensions_dir`）
- `routers/recorder.py`（第 52 行的 `_get_extensions_dir`）
- `routers/settings_extensions.py`（第 197, 281, 670, 787, 820, 838, 859 行）
- `routers/settings_system.py`（第 502, 510 行）
- `knowledge/embedding_engine.py`（第 75 行）
- `knowledge/reranker_engine.py`（第 50 行）
- `recorder_pkg/recorder_manager.py`（第 145, 163 行）

#### 5D. knowledge/ops.py KB 数据路径

修改 `server/knowledge/ops.py` 第 32-37 行：

```python
# 修改前：
def __init__(self, base_dir: str = None):
    self.base_dir = base_dir or os.path.dirname(os.path.abspath(__file__))
    self.data_dir = os.path.join(self.base_dir, "data", "kb")
    self.texts_dir = os.path.join(self.data_dir, "kb_texts")
    self.meta_path = os.path.join(self.data_dir, "kb_meta.json")
    self.vectors_path = os.path.join(self.data_dir, "kb_vectors.npz")

# 修改后：
def __init__(self, base_dir: str = None):
    from config import KB_DATA_DIR
    self.base_dir = base_dir or os.path.dirname(os.path.abspath(__file__))
    self.data_dir = KB_DATA_DIR  # C:\Sidemate\data\kb
    self.texts_dir = os.path.join(self.data_dir, "kb_texts")
    self.meta_path = os.path.join(self.data_dir, "kb_meta.json")
    self.vectors_path = os.path.join(self.data_dir, "kb_vectors.npz")
```

#### 5E. recorder_manager.py 录音数据路径

修改 `server/recorder_pkg/recorder_manager.py` 第 78-84 行：

```python
# 修改前：
def __init__(self, data_dir: str = None):
    if data_dir is None:
        data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "recordings")
    self.data_dir = data_dir

# 修改后：
def __init__(self, data_dir: str = None):
    if data_dir is None:
        from config import RECORDER_DATA_DIR
        data_dir = RECORDER_DATA_DIR  # C:\Sidemate\data\recorder
    self.data_dir = data_dir
```

#### 5F. routers/files.py 录音路径

修改 `server/routers/files.py` 第 22-25 行：

```python
# 修改前：
_recorder_base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "recorder_pkg", "data", "recordings")
RECORDING_DIR = os.path.realpath(os.path.join(_recorder_base, "audio"))

# 修改后：
from config import RECORDER_DATA_DIR
RECORDING_DIR = os.path.realpath(os.path.join(RECORDER_DATA_DIR, "audio"))
```

#### 5G. routers/backup.py KB 元数据路径

修改 `server/routers/backup.py` 第 13-16 行（路径值不变，但 DATA_DIR 已指向新位置，自动跟随）：

```python
# 不需要改代码！DATA_DIR 重构后已指向 C:\Sidemate\data
# os.path.join(DATA_DIR, "kb", "documents.json") 自动变成 C:\Sidemate\data\kb\documents.json
_KB_META_CANDIDATES = [
    os.path.join(DATA_DIR, "kb", "documents.json"),
    os.path.join(DATA_DIR, "kb", "kb_meta.json"),
]
```

同时修改 backup.py 中 settings.json 的路径引用（第 50, 129 行）：

```python
# 修改前：
settings_path = os.path.join(ROOT_DIR, "settings.json")

# 修改后：
from config import DATA_DIR
settings_path = os.path.join(DATA_DIR, "settings.json")
```

#### 5H. server.py 进度文件路径

修改 `server/server.py` 第 46 行：

```python
# 修改前（在 config import 之前）：
_PROG红线_FILE = os.path.join(_server_dir, "data", "startup_progress.json")

# 修改后（延迟到 config import 之后）：
# 将 _PROGRESS_FILE 的定义移到第 82 行之后（config import 之后）
from config import DATA_DIR
_PROGRESS_FILE = os.path.join(DATA_DIR, "startup_progress.json")
```

**验证点**：
```bash
cd C:\Sidemate\server
python -c "import server"  # 检查无 import 错误（dry run）
# 或
python -c "
from core.extension_manager import ExtensionRegistry
from knowledge.file_extractor import extract_text
from knowledge.doc_reader import DocReader
print('All imports OK')
"
```

---

### Phase 6: .gitignore 修改

修改 `C:\Sidemate\.gitignore`，将第 12-20 行替换：

```gitignore
# ====== 用户数据（运行时生成）======
# 统一数据目录（D1 重构后）
data/
```

---

### Phase 7: Go Launcher 修改 + 重新编译

#### 7A. 修改 main.go（6 处）

所有 `filepath.Join(appDir, "server", "data", ...)` → `filepath.Join(appDir, "data", ...)`：
- 第 530 行
- 第 613 行
- 第 814 行
- 第 822 行
- 第 899 行

第 785 行特殊处理：
```go
// 修改前：
pythonLogPath := filepath.Join(serverDir, "data", "logs", "python-stdout.log")
// 修改后：
pythonLogPath := filepath.Join(appDir, "data", "logs", "python-stdout.log")
```

#### 7B. 修改 watchdog.go（1 处）

第 68 行：`filepath.Join(appDir, "server", "data", "logs", "launcher.log")` → `filepath.Join(appDir, "data", "logs", "launcher.log")`

#### 7C. 重新编译

```bash
cd C:\Sidemate\launcher
go build -o Sidemate.exe .
```

**验证点**：
```bash
# 编译成功，无错误
ls -la C:\Sidemate\launcher\Sidemate.exe
```

---

### Phase 8: 全量启动验证

```bash
# 8.1 启动 Sidemate
cd C:\Sidemate
launcher\Sidemate.exe

# 8.2 检查日志
type data\logs\launcher.log     # Launcher 日志在新位置
type data\logs\server.log       # Server 日志在新位置

# 8.3 检查启动进度文件
type data\startup_progress.json # 应在新位置生成

# 8.4 功能验证
# - 打开浏览器 http://127.0.0.1:8976
# - 创建新对话 → 检查 data/chats/ 有新文件
# - 知识库页面 → 检查能读取已有文档
# - 录音功能 → 检查 data/recorder/ 有新录音
# - 设置页面 → 修改设置 → 检查 data/settings.json 更新
```

---

### Phase 9: 向后兼容迁移（可选，P6 做）

在 `config.py` 的 `load_config()` 或 `server.py` 启动时加入自动迁移逻辑：

```python
def migrate_to_new_layout():
    """D1 重构：旧位置 → 新位置自动迁移"""
    import shutil
    
    # server/data/ → data/（如果旧位置还有）
    old_data = os.path.join(ROOT_DIR, "data")
    new_data = DATA_DIR
    if os.path.isdir(old_data) and old_data != new_data:
        # 合并迁移...
        pass
    
    # server/settings.json → data/settings.json
    old_settings = os.path.join(ROOT_DIR, "settings.json")
    new_settings = os.path.join(DATA_DIR, "settings.json")
    if os.path.exists(old_settings) and not os.path.exists(new_settings):
        shutil.move(old_settings, new_settings)
    
    # server/knowledge/data/kb/ → data/kb/
    # server/recorder_pkg/data/recordings/ → data/recorder/
    # ...
```

---

## 7. 风险评估 + 验证点

### 7A. 高风险项

| 风险 | 严重度 | 影响 | 缓解措施 |
|------|--------|------|---------|
| **KB 向量库迁移损坏** | 🔴 极高 | kb_vectors.npz 损坏导致知识库不可用 | 迁移前 `cp -rn`（不覆盖），确认完整后再删源；保留 git tag 可回滚 |
| **Go Launcher 路径漏改** | 🔴 极高 | Launcher 找不到日志/进度文件，启动失败 | Phase 7 全量替换 + 重新编译 + 启动测试 |
| **extensions 路径引用漏改** | 🟠 高 | ExtensionRegistry 找不到 JSON，文库/纪要扩展显示未安装 | 用 `EXTENSIONS_DIR` 常量统一管理，Phase 5C 逐个检查 |
| **settings.json 路径变更** | 🟠 高 | 用户配置丢失（新位置没有，旧位置有） | Phase 1.5 先 mv；config.py 的 load_config 加 fallback 逻辑 |
| **import 漏改** | 🟡 中 | 某些功能运行时才触发 import，启动时不报错 | Phase 5 全量 grep 验证 + 功能测试 |
| **recorder sessions.json 绝对路径** | 🟡 中 | sessions.json 里有旧的绝对路径（`C:\tmp\_Sidemate...\recordings\audio\xxx.webm`），迁移后找不到 | 检查 sessions.json 内容，必要时批量替换路径 |

### 7B. 可能漏改的隐蔽点

| 位置 | 问题 | 检查方法 |
|------|------|---------|
| `knowledge/embedding_engine.py:75` | `os.path.join(ROOT_DIR, "extensions")` | grep `ROOT_DIR.*extensions` |
| `knowledge/reranker_engine.py:50` | `os.path.join(ROOT_DIR, "extensions")` | grep `ROOT_DIR.*extensions` |
| `recorder_pkg/recorder_manager.py:145` | `_get_extensions_dir()` 用 `__file__` 推导 | 检查 `_get_extensions_dir` 逻辑 |
| `server.py:46` | `_PROGRESS_FILE` 在 config import 之前定义 | 确认移到 config import 之后 |
| `routers/files.py:23` | `_recorder_base` 用 `__file__` 推导 recorder_pkg/data | 改为 `RECORDER_DATA_DIR` |
| `backup.py:50,129` | `os.path.join(ROOT_DIR, "settings.json")` | 改为 `DATA_DIR` |
| **前端 JS** | 可能有硬编码 `/data/` API 路径（但这是 HTTP API 路径，不是文件路径，不受影响） | 确认前端只通过 API 访问，不直接访问文件路径 |

### 7C. 不需要改的（确认安全）

| 路径 | 原因 |
|------|------|
| `server/models/` | Junction 链接到根 models/，不动 |
| `server/static/` | 前端静态资源，不动 |
| `server/index.html` | 入口页面，不动 |
| `launcher/main.go:52` `server/models` | OLLAMA_MODELS，Junction 不动 |
| `launcher/main.go:54` `server/server.py` | 入口脚本不动 |
| `launcher/tray_windows.go:249` `server/static/img/logo.ico` | 静态资源不动 |
| `python/` / `models/` / `lib/` | 运行时资产，gitignore，不动 |

### 7D. 每步验证清单

| 步骤 | 验证命令 | 预期结果 |
|------|---------|---------|
| Phase 1 后 | `ls data/kb/kb_vectors.npz` | 文件存在 |
| Phase 2 后 | `ls core/extension_manager.py` | 文件存在 |
| Phase 3 后 | `ls knowledge/file_extractor.py` | 文件存在 |
| Phase 4 后 | `python -c "from config import DATA_DIR; print(DATA_DIR)"` | 输出 `C:\Sidemate\data` |
| Phase 5 后 | `python -c "from core.extension_manager import ExtensionRegistry; from knowledge.file_extractor import extract_text; print('OK')"` | 输出 `OK` |
| Phase 6 后 | `git status .gitignore` | 显示已修改 |
| Phase 7 后 | `ls launcher/Sidemate.exe` | 新编译的 exe 存在 |
| Phase 8 后 | 浏览器访问 `http://127.0.0.1:8976` | 页面正常加载 |

### 7E. 回滚方案

如果任何步骤失败：

```bash
cd C:\Sidemate
git checkout v0.9.5-pre-restructure
# 恢复数据（如果数据已被 mv）
# 如果用了 cp -rn + rm，数据已在 git tag 的 server/data/ 中
```

**⚠️ 关键**：Phase 1 的 KB 数据迁移建议用 `cp -rn`（复制不覆盖）而非直接 `mv`，确认目标完整后再删源。这样即使中间步骤出错，源数据还在。

---

## 附录：受影响文件完整清单

### 需修改的 Python 文件（16 个）

| # | 文件 | 修改内容 |
|---|------|---------|
| 1 | `server/config.py` | DATA_DIR/PROJECT_ROOT/EXTENSIONS_DIR/KB_DATA_DIR/RECORDER_DATA_DIR/_CONFIG_FILE |
| 2 | `server/server.py` | import extension_manager + EXTENSIONS_DIR + _PROGRESS_FILE 路径 |
| 3 | `server/knowledge/ops.py` | data_dir 改用 KB_DATA_DIR |
| 4 | `server/recorder_pkg/recorder_manager.py` | data_dir 改用 RECORDER_DATA_DIR + import 路径 + extensions 路径 |
| 5 | `server/routers/files.py` | RECORDING_DIR 改用 RECORDER_DATA_DIR |
| 6 | `server/routers/backup.py` | settings.json 路径改用 DATA_DIR |
| 7 | `server/routers/kb.py` | import 路径 + extensions 路径 |
| 8 | `server/routers/chat.py` | import 路径 (files → knowledge) |
| 9 | `server/routers/settings_extensions.py` | import 路径 + extensions 路径 |
| 10 | `server/routers/settings_system.py` | import 路径 + extensions 路径 |
| 11 | `server/routers/recorder.py` | import 路径 + extensions 路径 |
| 12 | `server/core/batch_queue.py` | import 路径 (files → knowledge) |
| 13 | `server/pipelines/_base.py` | import 路径 (files → knowledge) |
| 14 | `server/pipelines/local_pipeline.py` | import 路径 (files → knowledge) |
| 15 | `server/pipelines/cloud_pipeline.py` | import 路径 (files → knowledge) |
| 16 | `server/knowledge/embedding_engine.py` | extensions 路径 |
| 17 | `server/knowledge/reranker_engine.py` | extensions 路径 |

### 需修改的 Go 文件（2 个）

| # | 文件 | 修改内容 |
|---|------|---------|
| 1 | `launcher/main.go` | 6 处 `server/data` → `data` |
| 2 | `launcher/watchdog.go` | 1 处 `server/data` → `data` |

### 需修改的配置文件（1 个）

| # | 文件 | 修改内容 |
|---|------|---------|
| 1 | `.gitignore` | 4 条规则合并为 `data/` |

### 删除的目录（5 个）

| # | 目录 | 前提 |
|---|------|------|
| 1 | `server/files/` | Phase 3 完成后 |
| 2 | `server/extensions/` | Phase 2 完成后 |
| 3 | `server/knowledge/data/` | Phase 1.3 完成后 |
| 4 | `server/recorder_pkg/data/` | Phase 1.4 完成后 |
| 5 | `server/data/` | Phase 1.2 完成后 |

---

## 附录：重构后目录结构（预期）

```
C:\Sidemate\
├── server/
│   ├── config.py              ← 修改：DATA_DIR 指向 ../data
│   ├── server.py              ← 修改：import + 路径
│   ├── core/
│   │   ├── extension_manager.py  ← 新增（原 extensions/registry.py）
│   │   └── ...（其他 core 文件）
│   ├── knowledge/
│   │   ├── file_extractor.py    ← 新增（原 files/）
│   │   ├── doc_reader.py        ← 新增（原 files/）
│   │   ├── doc_writer.py        ← 新增（原 files/）
│   │   ├── file_reader.py       ← 新增（原 files/）
│   │   ├── ops.py               ← 修改：KB_DATA_DIR
│   │   └── ...
│   ├── recorder_pkg/
│   │   ├── recorder_manager.py  ← 修改：RECORDER_DATA_DIR
│   │   └── ...
│   ├── routers/                 ← 多个文件修改 import
│   ├── pipelines/               ← 多个文件修改 import
│   ├── models/                  ← 不动（Junction）
│   ├── static/                  ← 不动
│   └── index.html               ← 不动
├── data/                     ← 新位置（原 server/data/ + knowledge/data/ + recorder_pkg/data/）
│   ├── chats/
│   ├── logs/
│   ├── cache/
│   │   ├── uploads/
│   │   ├── files/
│   │   └── docs/
│   ├── backup/
│   ├── kbsession/
│   ├── kb/                   ← 原 knowledge/data/kb/
│   │   ├── kb_meta.json
│   │   ├── kb_vectors.npz
│   │   └── kb_texts/
│   ├── recorder/             ← 原 recorder_pkg/data/recordings/
│   │   ├── audio/
│   │   ├── chunks/
│   │   └── sessions.json
│   ├── extensions/           ← 新位置（原 server/extensions/*.json）
│   │   ├── knowledge.json
│   │   └── llm.json
│   ├── settings.json         ← 原 server/settings.json
│   ├── deps_manifest.json
│   ├── startup_progress.json
│   └── .onboard_done
├── launcher/
│   ├── main.go               ← 修改：6 处路径
│   ├── watchdog.go           ← 修改：1 处路径
│   └── Sidemate.exe          ← 重新编译
├── python/                   ← 不动
├── models/                   ← 不动
├── lib/                      ← 不动
└── .gitignore                ← 修改
```
