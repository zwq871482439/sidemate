# Patch5 代码审计报告 — 代码质量 + Bug 排查

> 审计人：严过关（QA 工程师 Edward）
> 审计日期：2026-06-20
> 审计范围：Patch5 批次 A（T01线程池/令牌、T02队列、T03私密/embedding）+ B（批量操作/去重/热力图/权限预设）+ D1（目录重构）

## 1. 总览

### 审计范围（已 Read 的文件）
| 模块 | 文件 | 行数 |
|------|------|------|
| 并发 | `server/core/thread_pool.py` | 167 |
| 并发 | `server/core/access_token.py` | 311 |
| 并发 | `server/core/batch_queue.py` | 736 |
| 知识 | `server/core/dedup_detector.py` | 218 |
| 知识 | `server/knowledge/embedding_engine.py` | 325 |
| 知识 | `server/knowledge/file_extractor.py` | 402 |
| 知识 | `server/knowledge/search.py` | （检索路径） |
| 知识 | `server/knowledge/ops.py` | （持久化/导入） |
| 知识 | `server/knowledge/models.py` | 44 |
| 路由 | `server/routers/kb.py` | （batch/去重 API） |
| 路由 | `server/routers/settings_system.py` | （权限预设 API） |
| 配置 | `server/config.py` | 302 |
| 服务 | `server/server.py` | （lifespan） |
| Go | `launcher/watchdog.go` | 242 |
| Go | `launcher/gpu_detect.go` | 190 |
| Go | `launcher/hardlink.go` | 250 |
| 测试 | `tests/test_p5_batch_a.py` | 1459 |
| 测试 | `tests/test_p5_stress_100files.py` | 23541 |

### 边界测试脚本
编写并执行了 `tests/test_p5_qa_audit_boundary.py`（33 个断言，25 PASS / 8 发现），用于佐证静态阅读结论。

### Bug 数量统计
| 严重度 | 数量 |
|--------|------|
| 🔴 高（必须修） | 4 |
| 🟡 中（建议修） | 7 |
| 🟢 低（可选） | 6 |
| **合计** | **17** |

### 代码质量评分：**6.5 / 10**

扣分项：D1 重构无迁移脚本（-1.5）、SQLite 连接从不关闭（-1）、文本提取逻辑三处重复（-0.5）、getattr 默认值陷阱（-0.5）。
加分项：线程局部连接设计正确、降级链完整、Go 端常量提取规范（+0.5）、断点恢复机制设计良好。

---

## 2. Bug 排查

### 2.1 并发 Bug

| # | Bug | 文件:行号 | 严重度 | 重现条件 | 修复建议 |
|---|-----|-----------|--------|----------|----------|
| C1 | **SQLite 连接从不关闭（资源泄漏）** | `batch_queue.py:116-129` | 🔴高 | 每次进程生命周期 | `_get_conn()` 用 `threading.local()` 为每个线程创建连接，但 `BatchQueue` **没有 `close()` 方法**，`server.py` shutdown 时只调 `stop_worker()`，从不关闭连接。worker 线程的连接在 join 后成为孤儿，WAL 文件 `-wal`/`-shm` 不被 checkpoint。实测 Windows 下 `WinError 32`（文件被占用）。 | 在 `BatchQueue` 增加 `close()` 方法遍历关闭线程局部连接；lifespan shutdown 时调用；执行 `PRAGMA wal_checkpoint(TRUNCATE)` |
| C2 | **`canRestart` 切片别名导致重启计数丢失** | `watchdog.go:183-189` | 🟡中 | 高频重启场景 | `valid := wd.restartTimes[:0]` 共享底层数组，后续 `recordRestart` 的 append 可能写入被"清零"的位置，导致滑动窗口计数不准确，重启上限失效。 | 改为 `valid := make([]time.Time, 0, len(wd.restartTimes))` 新建切片 |
| C3 | **worker 异常时任务卡在 processing** | `batch_queue.py:491-505` | 🟢低 | worker 线程在 `_process_task` 之外异常退出 | `_worker_loop` 的 except 只记日志继续循环，但若 `get_pending` 本身抛异常（如 DB locked），任务已标记 processing 但未执行。依赖 `recover_pending` 在重启时修复。 | 可接受（有重启恢复兜底），但建议 `get_pending` 失败时回滚标记 |

**并发设计正确的部分（无 Bug）**：
- ✅ SQLite 线程局部连接：`threading.local()` 每线程独立连接，`check_same_thread=False` 正确（实测 4 线程并发无错误）
- ✅ `get_pending` 用 `BEGIN IMMEDIATE` 原子取任务（实测 4 线程并发无重复领取）
- ✅ `ThreadPoolManager` shutdown 后 submit 会惰性重建（实测安全，不崩溃）

### 2.2 资源泄漏

| # | Bug | 文件:行号 | 严重度 | 说明 | 修复建议 |
|---|-----|-----------|--------|------|----------|
| R1 | **SQLite 连接泄漏**（同 C1） | `batch_queue.py` | 🔴高 | 无 `close()` 方法，线程局部连接从不显式释放 | 见 C1 |
| R2 | **临时文件清理用 `shutil.rmtree` 删整个目录** | `batch_queue.py:596-604` | 🟡中 | `finally` 块检查 `"kb_upload" in _tmp_dir` 后 `rmtree` 整个临时目录。若多个任务共享同一上传临时目录（并发上传），会误删其他任务正在处理的文件。 | 改为只删 `task.file_path` 本身，或用每任务独立子目录 |
| R3 | **`_get_doc_preview_text` 遍历全部 chunks** | `dedup_detector.py:147-164` | 🟢低 | L2 检测对每个现有文档调用 `_get_doc_preview_text`，内部遍历 `self.kb.chunks.values()` 全部 chunk 过滤 `doc_id`。200 文档 × N chunks = O(D×C) 复杂度。 | 预构建 `doc_id → chunks` 索引缓存 |

**未发现泄漏的部分**：
- ✅ `ThreadPoolExecutor` 在 lifespan shutdown 正确调用 `shutdown_thread_pool(wait=False)`
- ✅ xlsx `wb.close()` 已调用（`batch_queue.py:663`、`kb.py:137`）
- ✅ PDF `doc.close()` 已调用（`file_extractor.py:84,94`）

### 2.3 边界情况

| # | 边界 | 文件:行号 | 严重度 | 结论 | 说明 |
|---|------|-----------|--------|------|------|
| B1 | **空 batch（0 文件）提交** | `batch_queue.py` | ✅安全 | `create_batch(total_files=0)` + `get_pending()` 返回 None（实测 PASS） |
| B2 | **空 doc_ids 批量删除** | `kb.py:1548-1549` | ✅安全 | 有 `if not doc_ids: return 400` 校验（实测 PASS） |
| B3 | **`is_private` 字段在 kb_meta.json 缺失** | `models.py:29`, `ops.py:448` | ✅安全 | `KBDocument` 用 `is_private: bool = False` 默认值，`KBDocument(**doc_data)` 对老数据缺失字段自动填充默认值（向后兼容良好） |
| B4 | **token 参数空字符串 vs None** | `access_token.py:158` | ✅安全 | `verify_token` 首行 `if not token: return False, "none"` 同时处理 None 和 "" |
| B5 | **`filter_private_docs` 令牌作用域** | `access_token.py:229-261` | 🟡中 | **实测发现**：`generate_full_token("private_1")` 生成的令牌只绑定 `private_1`，但 `filter_private_docs` 调用 `verify_token(token)` **不传 doc_id**，令牌验证通过后对所有私密文档放行。即一个文档的 full token 变成了"全局私密访问通行证"。 | 设计意图待确认——若是"访问级别令牌"则需文档级隔离，若是"会话级授权"则需文档说明 |
| B6 | **DedupDetector 超短文本** | `dedup_detector.py:96-97` | ✅安全 | `check_l2` 首行 `if not text_content or not text_content.strip(): return None`（实测 PASS） |
| B7 | **DedupDetector `existing_preview[0]` 访问** | `dedup_detector.py:116` | 🟢低 | `if new_text[0] != existing_preview[0]` — 前面已保证 `new_text` 非空（96行），`existing_preview` 经 110-111 行过滤也非空。但若 `existing_text[:2000]` 为多字节字符截断产生空串边界（极罕见），有理论风险。实测安全。 | 可加防御 `if not existing_preview: continue` |

---

## 3. 异常处理

| # | 问题 | 文件:行号 | 严重度 | 说明 |
|---|------|-----------|--------|------|
| E1 | **`getattr` 默认值陷阱** | `embedding_engine.py:160-161` | 🔴高 | `getattr(self._model, 'get_embedding_dimension', self._model.get_sentence_embedding_dimension)` — **默认值参数 `self._model.get_sentence_embedding_dimension` 在 getattr 调用时就会被求值**。若 SentenceTransformer 实例既没有 `get_embedding_dimension` 也没有 `get_sentence_embedding_dimension`（某些魔改/旧版本），这一行直接抛 `AttributeError`，被外层 `except Exception` 吞掉，降级到 none 模式，用户无感知地失去检索能力。**实测已复现此 AttributeError**。 | 改为：`fn = getattr(self._model, 'get_embedding_dimension', None) or getattr(self._model, 'get_sentence_embedding_dimension', None); self.vector_dim = fn() if fn else 1024` |
| E2 | **FlagModel + SentenceTransformer 都失败时静默降级** | `embedding_engine.py:164-170` | 🟡中 | 两个都失败时 `_mode="none"`，`encode()` 返回零向量。搜索功能完全失效但无用户可见错误。仅 log.error。 | 在 `search()` 检测 `_mode=="none"` 时返回明确错误提示，而非空结果 |
| E3 | **epub DRM 异常捕获** | `file_extractor.py:142-148` | ✅良好 | 已处理：检查 `err_msg` 含 "drm"/"encrypt" 返回友好提示，其他异常返回空串。 |
| E4 | **`agent_loop` 工具异常无独立 try-except** | `agent_loop.py:300-302` | 🟡中 | `run_blocking(self._execute_tool, ...)` 若 `_execute_tool` 抛异常，异常会向上传播。`run_blocking` 内部 `future.result()` 会重新抛出。外层 `_run` 的 for 循环（288-331行）没有针对单次工具调用的 try-except，一个工具异常会终止整个 agent loop。 | 在工具调用处包 try-except，异常时返回 `{"error": ...}` 作为 tool result 继续 |
| E5 | **wmic/PowerShell 超时** | `gpu_detect.go:88,103` | 🟢低 | `exec.Command("wmic"...)` 无 `context.WithTimeout`，wmic 卡住时无超时（Windows 上 wmic 偶发卡 30s+）。 | 加 `exec.CommandContext` 带 10s 超时 |
| E6 | **watchdog HTTP 非200状态码当失败** | `watchdog.go:173` | 🟢低 | `return resp.StatusCode == http.StatusOK` — 若服务返回 503（如启动中）会计入失败计数，连续3次503会触发重启，而此时进程其实正常启动中。 | 可放宽到 `< 500` 或对 503 特殊处理 |

**异常处理良好的部分**：
- ✅ `_process_task` 的 finally 块清理临时文件（batch_queue.py:596-604）
- ✅ `_load_meta` chunk 文本加载异常隔离，单个损坏不阻断全部（ops.py:457-462）
- ✅ 向量索引文件 <100 字节检测损坏并删除（ops.py:467-474）

---

## 4. 代码质量

### 4.1 重复代码（三处文本提取逻辑）

| # | 问题 | 严重度 | 涉及文件 |
|---|------|--------|----------|
| Q1 | **`extract_text` 逻辑三处重复** | 🟡中 | ① `file_extractor.py:27` 的 `extract_text()` ② `batch_queue.py:627` 的 `_extract_file_text()` ③ `kb.py:97` 的 `_extract_upload_text()` |

**详细对比**：
- `file_extractor.py:extract_text`：按扩展名分发，PDF 用 PyMuPDF(fitz)→pdfplumber→pypdf 三级降级，docx 用 python-docx，xlsx 用 openpyxl
- `batch_queue.py:_extract_file_text`：按扩展名分发，PDF 用 pdfplumber→pypdf 两级降级，docx 用 DocReader，xlsx 用 openpyxl（**与 file_extractor 不一致**）
- `kb.py:_extract_upload_text`：按扩展名分发，PDF 用 pdfplumber→pypdf，docx 用 DocReader（**与 batch_queue 一致但与 file_extractor 不一致**）

**风险**：同一个 PDF 文件，通过上传 API（kb.py）、批量队列（batch_queue）、对话注入（file_extractor）三条路径提取的结果可能不同（fitz vs pdfplumber 文本质量有差异）。已部分委托（epub/html/srt/rtf 都委托给 file_extractor），但核心格式（pdf/docx/xlsx）仍各自实现。

**建议**：统一收敛到 `file_extractor.extract_text`，batch_queue 和 kb.py 只做薄包装（增加 image_count 返回）。

### 4.2 命名一致性

| # | 问题 | 严重度 |
|---|------|--------|
| Q2 | `BatchQueue` 类 vs `batch_queue` 模块 vs `_batch_queue` 全局变量（server.py:364） | 🟢低 | 命名规范一致（类 PascalCase、模块 snake_case、实例 _前缀），**无问题** |

### 4.3 函数复杂度

| # | 问题 | 严重度 | 说明 |
|---|------|--------|------|
| Q3 | `_extract_file_text` 函数 109 行 | 🟢低 | `batch_queue.py:627-735`，大段 if-elif 按扩展名分发。可接受（结构清晰），但与 Q1 合并后可消除 |

### 4.4 魔法数字

| # | 问题 | 严重度 | 文件 |
|---|------|--------|------|
| Q4 | Python 端魔法数字 | 🟢低 | `batch_queue.py` timeout=30、200 页上限等硬编码。Go 端 `watchdog.go:27-34` 已提取为命名常量（`wdCheckInterval` 等），**Go 端做得好**，Python 端部分数字未提取 |

---

## 5. 输入验证

| 端点 | 校验情况 | 严重度 | 说明 |
|------|----------|--------|------|
| `batch_delete` (`kb.py:1538`) | ✅ 空校验 + 上限校验 | — | `if not doc_ids: 400` + `if len > _BATCH_MAX_ITEMS(50): 400`。**未校验 doc_id 格式**（非法字符串直接传给 delete_document，由下游处理） |
| `batch_privacy` (`kb.py:1615`) | ⚠️ is_private 类型陷阱 | 🟡中 | `is_private = bool(body.get("is_private", False))` — **字符串 `"false"` 经 `bool()` 变为 `True`**！前端若传 JSON 字符串 `"false"` 而非布尔 `false`，文档会被错误标记为私密。建议显式校验 `isinstance(is_private, bool)` |
| `duplicates/resolve` (`kb.py:1734`) | ✅ action 枚举校验 | — | `if action not in ("keep_both", "replace", "cancel"): 400`，规范 |
| `permissions/preset/apply` (`settings_system.py:813`) | ✅ preset_id 校验 | — | 遍历 `_PERMISSION_PRESETS` 查找，未匹配返回 400，规范 |
| 文件上传扩展名 | ✅ | — | `_SUPPORTED_EXTENSIONS` frozenset（batch_queue.py:73），大小写：`file_type` 在入队前已 lower |

---

## 6. 测试覆盖

### 6.1 `test_p5_batch_a.py`（194 断言）覆盖矩阵
| 模块 | 覆盖 | 评价 |
|------|------|------|
| thread_pool.py | ✅ 单例/submit/run_blocking/lazy_init/shutdown/concurrent | 充分 |
| access_token.py | ✅ generate/verify/revoke/filter/expiry/clear | 充分 |
| batch_queue.py | ✅ init/WAL/create/enqueue/get_pending/atomic/update/progress/recover/cancel/empty | 充分 |
| models.py is_private | ✅ 默认值/向后兼容 | 充分 |
| search.py 私密过滤 | ✅ accessible_doc_ids | 充分 |
| dense+sparse 融合 | ✅ | 充分 |
| config P5 keys | ✅ | 充分 |

### 6.2 未覆盖的高风险模块
| 模块 | 缺失测试 | 严重度 |
|------|----------|--------|
| `access_token.py` TTL 过期 | test_p5_batch_a 有 `test_token_expiry` 但未覆盖"过期后自动从缓存清理"和"过期令牌 revoke" | 🟡中 |
| `dedup_detector.py` L2 边界 | **完全无测试**（超短文本/空文本/IndexError 边界） | 🟡中 |
| `embedding_engine.py` getattr 陷阱 | **无测试覆盖双失败降级路径** | 🔴高 |
| `batch_queue.py` SQLite 连接关闭 | **无 close() 方法，无相关测试** | 🔴高 |
| Go 端（watchdog/gpu_detect/hardlink） | **完全无测试**（canRestart 逻辑、GPU 解析、硬链接） | 🟡中 |

### 6.3 `test_p5_stress_100files.py`（38 断言）
覆盖 100 文件排队/消费、处理期间健康检查、进度查询、中途取消、断点恢复、线程池集成。**设计良好**，用 MockKB 避免 Ollama 依赖。但未覆盖：worker 异常恢复、SQLite 并发写竞争。

---

## 7. 向后兼容（D1 重构）— ⚠️ 高风险

### D1-1：配置文件路径变更（🔴 P0 级）

| 项目 | 详情 |
|------|------|
| **变更** | `settings.json` 从 `server/data/settings.json` → `data/settings.json` |
| **代码** | `config.py:61` `_CONFIG_FILE = os.path.join(DATA_DIR, "settings.json")`，`DATA_DIR = PROJECT_ROOT/data`（config.py:39） |
| **影响** | 老用户从旧版本升级，其 `server/data/settings.json`（含 ai_mode、cloud_api_key、ollama_model 等所有配置）**不会被新代码读取**。新代码在 `data/settings.json` 找不到文件 → 使用 DEFAULTS → **用户配置全部丢失**（API Key、模型选择、权限设置等） |
| **迁移脚本** | ❌ **不存在**。`data_migrator.py` 只迁移 docs/tmp_upload/files 子目录，不迁移 settings.json |
| **严重度** | 🔴 **P0** — 用户感知最强的数据丢失 |

### D1-2：知识库数据路径变更（🔴 P0 级）

| 项目 | 详情 |
|------|------|
| **变更** | KB 数据从 `server/data/kb/` → `data/kb/`（`KB_DATA_DIR = DATA_DIR/kb`，config.py:49） |
| **影响** | 老用户的向量索引、kb_meta.json、chunk 文本在 `server/data/kb/`，新代码去 `data/kb/` 找 → **文库文档全部"消失"**（实际数据还在老路径） |
| **迁移脚本** | ❌ 不存在 |
| **严重度** | 🔴 **P0** — 用户积累的知识库内容丢失 |

### D1-3：会话记录路径变更（🟡 P1 级）

| 项目 | 详情 |
|------|------|
| **变更** | chats/kbsession/recorder 等从 `server/data/` → `data/` |
| **影响** | 老用户的对话历史、录音转写记录丢失（但相比配置和KB，影响较小） |
| **迁移脚本** | ❌ 不存在 |
| **严重度** | 🟡 **P1** |

### D1-4：现状验证
实测当前项目 `server/data/` 仅剩空的 `chats/` 目录，`data/` 有完整数据——说明这是**全新安装**的状态。但对**老用户升级**场景，无迁移逻辑是确定的缺陷。

### 修复建议（D1）
在 `server.py` lifespan startup 最前面增加迁移逻辑：
```python
def _migrate_d1_layout():
    old_data = os.path.join(ROOT_DIR, "data")  # server/data
    new_data = DATA_DIR  # data/
    if os.path.isdir(old_data):
        for item in os.listdir(old_data):
            src = os.path.join(old_data, item)
            dst = os.path.join(new_data, item)
            if not os.path.exists(dst):
                shutil.move(src, dst)
        log.info("[D1-MIGRATE] 迁移完成 server/data → data/")
```

---

## 8. 高优先级 Bug（必须修）

| # | Bug | 文件:行号 | 类别 |
|---|-----|-----------|------|
| 🔴1 | **D1 配置/KB 数据路径变更无迁移脚本**（老用户升级配置和文库丢失） | `config.py:39,61` `server.py` | 向后兼容 |
| 🔴2 | **SQLite 连接从不关闭**（BatchQueue 无 close 方法，WAL 不 checkpoint） | `batch_queue.py:116-129` | 资源泄漏 |
| 🔴3 | **getattr 默认值陷阱**（SentenceTransformer 双方法缺失时直接崩，静默降级） | `embedding_engine.py:160-161` | 异常处理 |
| 🔴4 | **agent_loop 工具异常无独立捕获**（单个工具异常终止整个 agent loop） | `agent_loop.py:300-302` | 异常处理 |

---

## 9. 中优先级问题

| # | 问题 | 文件:行号 |
|---|------|-----------|
| 🟡5 | `batch_privacy` 的 `bool("false")=True` 类型陷阱 | `kb.py:1625` |
| 🟡6 | `filter_private_docs` 令牌作用域过宽（单文档令牌变全局通行证） | `access_token.py:229-261` |
| 🟡7 | 临时文件清理 `rmtree` 整个 kb_upload 目录（并发上传误删） | `batch_queue.py:599-602` |
| 🟡8 | 文本提取逻辑三处重复（pdf/docx/xlsx 提取结果不一致） | file_extractor/batch_queue/kb.py |
| 🟡9 | FlagModel+SentenceTransformer 双失败静默降级（用户无感知失去检索） | `embedding_engine.py:164-170` |
| 🟡10 | `canRestart` 切片别名导致重启计数可能不准 | `watchdog.go:183-189` |
| 🟡11 | dedup/embedding/Go 端关键模块缺测试覆盖 | tests/ |

---

## 10. 低优先级问题

| # | 问题 | 文件:行号 |
|---|------|-----------|
| 🟢12 | wmic/PowerShell 无超时（卡住时 GPU 检测挂起） | `gpu_detect.go:88,103` |
| 🟢13 | watchdog 503 计入失败计数（启动期误重启风险） | `watchdog.go:173` |
| 🟢14 | DedupDetector `_get_doc_preview_text` O(D×C) 复杂度 | `dedup_detector.py:147` |
| 🟢15 | Python 端部分魔法数字未提取为常量 | batch_queue.py 多处 |
| 🟢16 | worker 异常时任务卡 processing（靠重启 recover 兜底） | `batch_queue.py:491` |
| 🟢17 | `existing_preview[0]` 极端边界（多字节截断，理论风险） | `dedup_detector.py:116` |

---

## 附录：边界测试脚本执行结果

```
QA 审计边界测试结果: 25 PASS / 8 FAIL / 共 33
[✓] empty_batch / sqlite_multithread / get_pending_concurrent / thread_pool_*
[✓] token_ttl / token_wrong_doc / filter_private_no_token
[✓] dedup_short/empty/whitespace/single_char
[✓] sqlite_get_pending / d1_config_path / embedding_no_model
[✗] WinError 32（SQLite 文件锁定 — 佐证 C1 资源泄漏）
[✗] filter_private_with_token（佐证 B5 令牌作用域问题）
[✗] batch_privacy_str_coercion（佐证 🟡5 类型陷阱）
```

测试脚本：`tests/test_p5_qa_audit_boundary.py`
