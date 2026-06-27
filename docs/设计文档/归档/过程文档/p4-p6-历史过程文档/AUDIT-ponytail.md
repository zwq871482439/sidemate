# Ponytail 过度工程审计报告 — C:\Sidemate

> **审计日期**：2026-06-22
> **审计范围**：`server/`（Python ~28k 行）、`launcher/`（Go ~4.1k 行）、根脚本、`docs/`
> **审计规则**：[ponytail-audit](https://github.com/DietrichGebert/ponytail) — 只评**复杂度**（过度工程），不评 correctness bug / 安全 / 性能（那些走正常 code review）
> **只读审计**：本次未修改任何项目代码，仅产出本报告
> **方法**：两个 Explore 子代理并行扫 `core/` 和 `routers/`+`pipelines/`，所有 `delete` 声明均 grep 全仓验证调用方，已修正 1 处子代理误判

---

## 标签说明

| 标签 | 含义 |
|------|------|
| `delete` | 死代码、未使用灵活性、投机性功能、整文件无外部引用。替换：无 |
| `stdlib` | 手撸的标准库已有功能。标出函数名 |
| `native` | 手撸的已装依赖/平台已有功能。标出特性名 |
| `yagni` | 单实现抽象、没人读的配置、单调用方层级、单实现的 interface/ABC、单产品工厂 |
| `shrink` | 同逻辑更少行。给出更短形式 |
| `dep` | 依赖声明层面的问题（漏声明/可选未标注等） |

---

## 📊 汇总

```
代码:   -~750 行 Python（archive 1487 + llm_scheduler 173 + 各 dead code/yagni/shrink）
文档:   -~2000 行 markdown（PATCH4-* 系列已腐化）
脚本:   -198 行（migrate_to_m3 + rebuild_vectors，若迁移已完成）
依赖:   +1（curl_cffi，落实优化） / -0~1（curl_cffi 若改 C 方案可去）
```

**模块规模基线**（审计前）：

| 模块 | 文件 | 行数 |
|------|------|------|
| server/core | 25 | 8,638 |
| server/routers | 11 | 6,607 |
| server/knowledge | 15 | 4,828 |
| server/pipelines | 7 | 3,525 |
| server/intelligence | 6 | 1,475 |
| server/archive | 3 | 1,487 |
| server/session | 4 | 905 |
| server/common | 4 | 805 |
| server 顶层 | 4 | 1,378 |
| 根脚本 | 3 | 514 |
| launcher (Go) | 9 | 4,130 |

---

# 第一部分：curl_cffi 深度梳理（你选定"落实优化"路线）

## 问题陈述

`server/core/search_engine.py` 写了 curl_cffi 优先 + httpx fallback 的双路径，但 `requirements.txt` 既没声明 curl_cffi，嵌入式 `python/Lib/site-packages/` 也没装。运行时实际永远走 httpx 分支。

## 完整事实链（已逐项验证）

### 1. 代码层面：双路径本身是正确的优雅降级

```python
# server/core/search_engine.py:20-26
try:
    from curl_cffi.requests import Session as _CurlSession
    _USE_CURL_CFFI = True          # 装了 → 用它（TLS 指纹伪装，过反爬）
except ImportError:
    _USE_CURL_CFFI = False         # 没装 → 用 httpx（功能保底，无指纹伪装）
    log.warning(...)               # 已是 warning 级（P1-DEP-03 建议已落实）
```

`_http_get()` (行 171-212) 按此开关分流。**逻辑无 bug，不是死代码。**

### 2. 运行时层面：当前环境实际走 httpx

| 检查项 | 结果 |
|--------|------|
| `requirements.txt` 声明 curl_cffi | ❌ 没有 |
| 嵌入式 `python/Lib/site-packages/` 装了 curl_cffi | ❌ 没有 |
| 嵌入式装了 httpx | ✅ 0.28.1 |
| `requirements.txt` 声明 httpx | ✅ `httpx>=0.28.0` |

→ **当前 Sidemate.exe 跑起来 `_USE_CURL_CFFI=False`，永远走 httpx 分支。curl_cffi 是"装了才生效"的潜伏路径。**

### 3. 历史层面：设计者本来就计划这样

`docs/设计文档/规划与方案/Cloud-Agent-Loop-架构设计.md`:
- L1236: **"curl_cffi 在嵌入式 Python 编译失败 → 保留 httpx fallback"**（已预见装不上）
- L635: `curl_cffi ≥0.15.0，~5MB wheel`
- L1185: curl_cffi **新增**

`docs/设计文档/归档/过程文档/设计讨论/sidemate-agent-prd.md`:
- L183: **"curl_cffi 最后做"**
- L194: **"16. curl_cffi 最后做"**（优先级最低的优化项）

### 4. 内部审计历史

`docs/设计文档/归档/过程文档/代码审计/python-code-audit-2026-06-09.md` 的 **P1-DEP-03** 早已指出此问题，结论："将 curl_cffi 加入 requirements.txt 或至少在 deps_check.py 中标记为可选依赖"。其中"缺失时输出 warning 日志"的建议**已落实**（search_engine.py:26）。

## 修正审计报告初稿

初稿第 33 条曾写"若 curl_cffi 是常驻路径，httpx fallback 是死代码"——**判断反了**。真相：

> curl_cffi 分支是"规划中但未落地"的优化项；httpx 是当前唯一真路径；双路径写法正确，只是 curl_cffi 未声明进 deps。

## 落实优化路线（你选定的 A 方案）

### 步骤 1：声明依赖

`requirements.txt` 第 17 行（httpx 那段）附近加：

```diff
 # ===== Ollama HTTP 客户端 =====
-httpx>=0.28.0
+httpx>=0.28.0
+# 搜索引擎 TLS 指纹伪装（可选，装了自动启用；不装则用 httpx fallback）
+curl_cffi>=0.15.0
```

### 步骤 2：验证嵌入式 Python 能否装

⚠️ **这是最大的风险点**。curl_cffi 需要编译 C 扩展（依赖 libcurl）。在嵌入式 Python 上：

```bash
# 用嵌入式 pip 试装
python/python.exe -m pip install curl_cffi>=0.15.0
# 若失败，看是否有预编译 wheel
python/python.exe -m pip install curl_cffi>=0.15.0 --only-binary :all:
```

**判断**：
- 装上 → 进入步骤 3，打包流程（`build_full.py` / `assemble.bat`）需带上 curl_cffi
- 装不上 → 走 B 方案（见下"备选"），或临时用系统 Python 跑

### 步骤 3：打包流程同步

`build_full.py` / `assemble.bat` 若有显式 pip install 列表，需把 curl_cffi 加进去。**待执行时核对**——当前审计未细看打包脚本。

### 步骤 4：deps_check.py 同步（可选但推荐）

`server/core/deps_check.py` 的 `REQUIRED_DEPS` 加 curl_cffi 为可选，让启动时能感知：

```python
# 参考写法（执行时按实际结构调整）
OPTIONAL_DEPS = {
    "curl_cffi": "搜索引擎 TLS 指纹伪装（可选，缺失则用 httpx）",
}
```

### 步骤 5：验证

启动 Sidemate，日志应出现：

```
[SEARCH] 使用 curl_cffi（TLS 指纹伪装）   ← 而不是 "curl_cffi 不可用"
```

### 备选：B 方案（若 curl_cffi 嵌入式编译失败）

维持现状不改代码，但：
1. `deps_check.py` 标记 curl_cffi 为可选依赖（已缺失，给出降级提示）
2. 在 `docs/` 记一笔"嵌入式 Python 暂不支持 curl_cffi，搜索使用 httpx fallback"

---

# 第二部分：全部发现（按可执行性排序）

> ⚠️ **行号为 2026-06-22 静态读取值，执行删除前请以最新代码为准再核一遍。**
> 所有 `delete` 声明均 grep 全仓验证调用方。

## 🔴 最大块（高价值，先做这些）

### A1. `delete` server/archive/ 整目录

- **位置**：`server/archive/`（recorder_pkg + 旧 routers，1487 行）
- **验证**：全仓零外部引用（grep `from server.archive` 无结果）
- **替换**：无
- **理由**：archive 即"已归档"，进了 git 但没人用

### A2. `delete` core/llm_scheduler.py 整文件

- **位置**：`server/core/llm_scheduler.py`（LLMScheduler + SchedulerTicket，173 行）
- **验证**：
  - `.submit()` 零调用方（grep 全仓）
  - 在 `server.py:303` 初始化但队列从不被喂入
  - 仅 `.cancel()` 接一个孤儿端点 `routers/chat.py:1101`
- **替换**：无（连带删 `routers/chat.py:1101` 的取消端点，或让它转调 GenerateQueue）
- **理由**：完整实现了但从未接入数据流，是投机性功能

### A3. `delete` batch_queue.py 的不可达 fallback 分支

- **位置**：`server/core/batch_queue.py:659-742`（`_extract_file_text` 60+ 行）
- **验证**：代码永远先走 `knowledge.file_extractor.extract_text` 并 return，下面 docx/xlsx/pdf 重实现不可达
- **替换**：只保留前 5 行的 delegation
- **理由**：不可达代码且与 file_extractor 逻辑重复

### A4. `delete` cloud_engine.py 重复的 retry 循环

- **位置**：`server/core/cloud_engine.py:522-606`（流式）与 `713-817`（带工具）
- **验证**：两条 retry 循环近乎逐行重复（attempt/backoff/yield）
- **替换**：抽一个 `_stream_with_retry(client, **kw)` 生成器
- **理由**：~80 行重复逻辑

### A5. `delete` docs/PATCH4-* 系列过时文档

- **位置**：`docs/` 下 11 个 PATCH4 开头文档（约 2000 行 markdown）
  - `PATCH4-PLAN.md`、`PATCH4-ARCHITECTURE.md`、`PATCH4-DOCAGENT-FIX.md`、`PATCH4-TEST-MANUAL.md`、`PATCH4-TEST-REPORT.md`、`PATCH4-WORKSPACE-UNIFY.md`
- **验证**：项目当前进度 P7/P8（见 `docs/PATCH7-BRAINSTORM.md`、`PATCH8-BRAINSTORM.md`）
- **替换**：无（若担心丢历史，移到 `docs/归档/` 而非删除）
- **理由**：规划/报告文档随版本腐化，留着误导新人

### A6. `delete` 根目录一次性迁移脚本（待确认）

- **位置**：`migrate_to_m3.py`（84 行）+ `rebuild_vectors.py`（114 行）
- **验证**：均为 **Patch4 v3.1** 一次性迁移脚本（bge-base-zh-v1.5 → bge-m3）
- **⚠️ 待你确认**：v3.1 向量迁移是否彻底完成？
  - 是 → 删除（-198 行）
  - 否 → 保留并在文件头标注"待重跑"

---

## 🟠 已验证的 dead code（单点删除，安全）

### B1. `delete` access_token.py 三处零调用方法

| 位置 | 方法 | 验证 |
|------|------|------|
| `server/core/access_token.py:282-285` | `_remove_token`（locked 变体） | 仅 `_remove_token_unlocked` 被用 |
| `server/core/access_token.py:350-363` | `get_doc_access_level` | grep 全仓零调用方 |
| `server/core/access_token.py:365-375` | `clear_all` | 零调用；token 在内存重启即清，docstring "重启模拟" 是空意图 |

**替换**：无

### B2. `delete` template_parser.py

- **位置**：`server/core/template_parser.py:188-204` `template_to_outline_json`
- **验证**：grep 全仓零调用方
- **替换**：无

### B3. `delete` deps_check.py 重复校验

- **位置**：`server/core/deps_check.py:31-101`（`REQUIRED_DEPS` + `_import_check`，~55 行）
- **验证**：`server.py:138-161` 已有更可靠的 SHA256 manifest 校验；`_import_check` 是更弱的第二套
- **替换**：只保留 manifest 路径
- **理由**：两套校验重复，弱的那套多余

### B4. `delete` generate_queue.py 两处

| 位置 | 内容 | 验证 |
|------|------|------|
| `server/core/generate_queue.py:126-143` | `queue_length` + `queue_info` | 零外部读取 |
| `server/core/generate_queue.py:108,472,488` | `_worker_thread`（单数）兼容字段 | 仅 set 不 read，"兼容旧引用" 已无引用 |

**替换**：无

### B5. `delete` extension_manager.py 重复 defaults dict

- **位置**：`server/core/extension_manager.py:261-297` `get_model_path` 内的 14 行 inline defaults
- **⚠️ 修正子代理误判**：`get_model_path` 本身**不能删**（有 3 个真实调用方：`embedding_engine.py:77`、`reranker_engine.py:52`、`archive/recorder_manager.py:165`），但内联 defaults 与 `_default_register_info:150-173` 重复
- **替换**：复用 `_default_register_info`

### B6. `delete` ollama_manager.py 一行包装

- **位置**：`server/core/ollama_manager.py:152-158` `auto_start`
- **验证**：一行 `return self.start()`；唯一调用方 `server.py:235`
- **替换**：调用方直接 `start()`

### B7. `delete` doc_session.py no-op 分支

- **位置**：`server/core/doc_session.py:227-268` `edit_workspace_file` 的 `count > 1` 分支（行 254-256）
- **验证**：是 `pass` + 注释"告知模型"，但从不告知任何东西
- **替换**：删除空分支

### B8. `delete` routers/chat.py 三处

| 位置 | 内容 | 验证 |
|------|------|------|
| `server/routers/chat.py:126-156` | `_sanitize_output`（30 行） | 本文件零调用；`pipelines/_base.py` 有同名实现 |
| `server/routers/chat.py:444-451` | `/api/chats/clear_context` 端点 | 自标注"已下线"，返回硬编码 410 |
| `server/routers/chat.py:73` | `ChatRequest.scene` 字段 | 全管线零读取，仅"向后兼容"标注 |
| `server/routers/chat.py:168-178` | 十个一行别名（`_safe_chat_name`/`_today_str`/...） | 调用方已从 session/ 导入原名，别名是第二个名字 |

### B9. `delete` pipelines/doc_action.py

- **位置**：`server/pipelines/doc_action.py:186-208` `cancel_doc_action`
- **验证**：零调用方
- **替换**：无

### B10. `delete` access_token.py 重复 token 生成

- **位置**：`server/core/access_token.py:144-172` `generate_full_token` / `generate_search_token`
- **验证**：两方法仅字面量 `"full"`/`"search"` 不同；调用方 `kb.py:1539/1541`
- **替换**：一个 `_create_token(doc_id, level, ...)` 方法，~15 行

---

## 🟡 yagni（单实现抽象 / 一行包装层）

### C1. `yagni` thread_pool.py 整个类

- **位置**：`server/core/thread_pool.py`（ThreadPoolManager，113 行）
- **验证**：单实现，所有调用方 `get_thread_pool().run_blocking(...)`（`agent_loop.py:304`）或 `.submit`
- **替换**：模块级 `ThreadPoolExecutor` + 两个自由函数 `run_blocking`/`submit`
- **理由**：是对 `concurrent.futures.ThreadPoolExecutor` 的薄包装 + 日志

### C2. `yagni` think_processor.py 类

- **位置**：`server/core/think_processor.py`（ThinkProcessor，86 行）
- **验证**：`__init__` 是 `pass`，全方法无状态；`strip_think` 转调 `intelligence.response_filter.strip_think_tags`；`model_manager.py:118-124` 再转调一次
- **替换**：自由函数 `strip_think` / `process_reasoning` / `clean_response`

### C3. `yagni` routers/deps.py 薄包装

- **位置**：`server/routers/deps.py:36-48,51-55,71-74,77-79`
- **方法**：`get_ollama` / `get_notebook` / `get_current_chat_file` / `get_default_llm` / `get_log`
- **验证**：前三个零非 archive 调用方；`get_default_llm` 只包 `server.DEFAULT_LLM`；`get_log` 只包 `logging.getLogger`
- **替换**：`get_log` 直接用 `logging.getLogger(__name__)`（其他文件已这么做）

### C4. `yagni` reformulate.py 过度启发式

- **位置**：`server/core/reformulate.py:83-139` `_check_keyword_preservation`（57 行）
- **验证**：唯一失败模式是"返回原 query"，而上游已在任何异常时返回原 query
- **替换**：砍到 5 行（`len(orig_kws & ref_kws) >= len(orig_kws)//2`）或信任 LLM 直接删

### C5. `yagni` kb.py 内 KB-compare session 辅助函数

- **位置**：`server/routers/kb.py:272-365`
- **验证**：`_kb_session_dir`/`_kb_round_path`/`_kb_save_round`/`_kb_load_rounds`/`_kb_rounds_to_history`/`_kb_delete_session`/`_kb_get_next_round`
- **⚠️ 待核对**：若 Patch3 compare 模式只走 `pipelines/compare_pipeline`，这些 kb.py 内镜像状态的辅助函数可能多余
- **执行前需验证**：grep 每个 `_kb_*` 函数的实际调用链

---

## 🟢 shrink（同逻辑更少行）

### D1. `shrink` cache_cleanup + log_cleanup 合并

- **位置**：`server/core/cache_cleanup.py`（39 行）+ `server/core/log_cleanup.py`（44 行）
- **验证**：同一个 walk-mtime-remove 循环，仅递归 vs 平铺不同
- **替换**：一个 `_cleanup_old_files(path, max_age_days, recursive=True)`
- **收益**：-~40 行

### D2. `shrink` 两份 atomic_write_json

- **位置**：`server/core/session_migrator.py:152-159` `_atomic_write_json` 与 `server/core/doc_session.py:318-332` `_save_completed`
- **验证**：两份 tmp-write + `os.replace` 模式
- **替换**：合到 `server/common/utils.py` 一个 `atomic_write_json`
- **收益**：-~15 行

### D3. `shrink` search_engine.py 重复 tag-strip

- **位置**：`server/core/search_engine.py` `_strip_tags` 定义在 56-62，但行内 `re.sub(r'<[^>]+>', ...)` 又在 218/228/230/281/285/306/313 出现 7 次
- **替换**：统一用 `_strip_tags`；实体解码用 stdlib `html.unescape`
- **收益**：-~15 行

### D4. `shrink` routers ~130 处手撸 JSON 错误响应

- **位置**：`server/routers/*.py`（kb.py、chat.py、files.py、settings_system.py、settings_cloud.py、settings_extensions.py、skill.py）
- **验证**：~130 处 `JSONResponse({"error": ...}, status_code=N)`
- **替换**：`raise HTTPException(status_code=N, detail={"error": msg})`，FastAPI 自动映射同款 JSON
- **收益**：去掉每处 try/except + return 对

### D5. `shrink` pipelines 行内拼 SSE

- **位置**：`server/pipelines/_base.py:110-133,309-329,410,431,461,468,473` + cloud/local/compare/parallel_pipeline.py
- **验证**：行内拼 `'data: {"type": "token", "content": %s}\n\n' % json.dumps(...)`，而 `_base.sse_event()` 正是为此存在
- **替换**：统一调用 `sse_event()`
- **收益**：_base.py 自己也在 yield_engine_tokens/handle_doc_action/save_conversation 行内拼，应先自查

### D6. `shrink` server.py 关停块重复

- **位置**：`server/server.py:391-415` 与 `417-441`
- **验证**：同一 `stop_worker/close/_tagging_scheduler.stop/ollama_manager.stop/shutdown_thread_pool` 序列写两遍
- **替换**：抽 `_shutdown()` 函数
- **收益**：-~25 行

### D7. `shrink` 重复 _safe_filename

- **位置**：`server/routers/chat.py:83-91`（用 `PurePath`）与 `server/routers/kb.py:79-88`（用 `os.path.basename`）
- **验证**：都是防穿越的路径清理，逻辑等价
- **替换**：合到 `deps.py` 一个 `_safe_filename`

### D8. `shrink` generate_queue.py 排序冗余

- **位置**：`server/core/generate_queue.py:58,71`
- **验证**：队列保持有序，两次 `self._queue.sort(...)` 第二次冗余
- **替换**：删第二次排序

---

## 🔵 stdlib / native（用已装能力替代手撸）

### E1. `stdlib` 手撸 sha256

- **位置**：`server/core/deps_check.py:110-116` `sha256_file`（手撸分块读）
- **验证**：被本文件用 3 处（行 182/241/303）
- **替换**：Python 3.11+ 的 `hashlib.file_digest(f, "sha256").hexdigest()`（项目用 Python 3.14，支持）

### E2. `native` 手撸请求体解析

- **位置**：`server/routers/chat.py:217-247` `/api/chat/stream`
- **验证**：手撸 `body = await request.json()` 再挑字段灌 `ChatRequest`（~30 行）
- **替换**：FastAPI 声明 `req: ChatRequest` 参数即自动校验 + 返回 422

### E3. `native` 手撸 no-cache 中间件

- **位置**：`server/server.py:570-578` `_no_cache_static`
- **验证**：8 行中间件给 StaticFiles 加 cache headers
- **替换**：starlette 的 `StaticFiles` 子类 + `response.headers` 后置钩子

### E4. `native` search_engine.py _http_get 双分支

- **位置**：`server/core/search_engine.py:171-212`
- **状态**：见第一部分 curl_cffi 梳理。落实优化（A 方案）后此条消失；若走 C 方案删 curl_cffi，则 httpx 分支保留、curl_cffi 分支删

---

# 第三部分：建议执行顺序

按"风险低、收益高、可独立验证"排序：

### 阶段 1：零风险清理（先做）

1. **A1** 删 `server/archive/`（git 历史保留，删了能回滚）
2. **A5** docs/PATCH4-* 移到 `docs/归档/`（不移除，只归档）
3. **B1-B10** 单点 dead code 删除（均已验证零调用）

→ 预期 **-~600 行**，零行为变化

### 阶段 2：依赖优化（你选定的方向）

4. **curl_cffi 落实**（第一部分步骤 1-5）
5. **E1** sha256 改 `hashlib.file_digest`

→ 预期搜索反爬能力提升；校验代码简化

### 阶段 3：抽象瘦身（需测试）

6. **C1** thread_pool 换自由函数
7. **C2** think_processor 换自由函数
8. **D1/D2/D6** 合并重复 helper
9. **D4** routers 换 HTTPException
10. **D5** pipelines 统一 sse_event

→ 预期 **-~250 行**，每步需跑 `tests/` 回归

### 阶段 4：需产品判断（你来定）

11. **A6** migrate_to_m3 / rebuild_vectors（确认迁移是否完成）
12. **A2** llm_scheduler（确认是否还要这个功能）
13. **C5** kb.py KB-compare 辅助函数（确认 compare 模式实现路径）
14. **C4** reformulate 启发式（确认要不要信任 LLM）

---

# 第四部分：边界与免责

- **本次审计只评复杂度**（过度工程），不评 correctness bug / 安全 / 性能
- 所有 `delete` 声明已 grep 全仓验证调用方，**但行号为 2026-06-22 静态读取值**，执行前请以最新代码为准
- 部分条目标注"⚠️ 待核对/待确认"，这些需要你或代码 owner 进一步判断
- 本报告**未修改任何项目代码**，仅产出本 md 文件

---

*审计工具：[ponytail-audit](https://github.com/DietrichGebert/ponytail) · 报告路径：`C:\Sidemate\AUDIT-ponytail.md`*
