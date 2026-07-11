# QA 后端 Bug 扫描报告

**项目**: Sidemate v0.9 Patch1  
**审计范围**: 后端 Python 服务（9 包 28 模块，15088 行）  
**审计人**: QA 工程师 严过关  
**审计日期**: 2025-07-14  
**审计方法**: 逐文件阅读源码，重点关注异常处理/资源泄漏/并发安全/边界条件/路径安全/数据完整性

---

## P0 — 必须修复（数据丢失 / 安全漏洞 / 服务崩溃）

### P0-01: SSE 流中 `sse_gen()` 是同步生成器，在 async 端点内阻塞事件循环
- **文件**: `routers/chat.py:307-726`
- **严重度**: P0
- **问题描述**: `api_chat_stream()` 是 `async def`，但内部 `sse_gen()` 是一个**同步生成器**（含 `time.sleep(0.3)` 等阻塞调用）。`StreamingResponse(sse_gen())` 会在事件循环线程中执行阻塞代码，导致整个 FastAPI 服务在流式对话期间卡死，所有其他 HTTP 请求被阻塞。
- **修复建议**: 要么把 `sse_gen` 改为 `async def` + 用 `await asyncio.sleep()` 替代 `time.sleep()`；要么用 `run_in_executor` 执行同步生成器。

### P0-02: `sse_gen()` 中 `mgr._gen_done.wait(timeout=10.0)` 阻塞事件循环
- **文件**: `routers/chat.py:313`
- **严重度**: P0
- **问题描述**: `threading.Event.wait()` 是阻塞调用，在 async 端点的同步生成器内会阻塞事件循环最多 10 秒。多个并发请求时服务完全无响应。
- **修复建议**: 同 P0-01，将阻塞调用移至线程池。

### P0-03: `/api/chats/switch` 路径穿越检查可被绕过
- **文件**: `routers/chat.py:760-762`
- **严重度**: P0
- **问题描述**: `os.path.realpath(filepath)` 只对最终路径做 `realpath`，但 `filepath` 由用户直接传入 `body.get("path")`。虽然检查了 `startswith(CHAT_DIR)`，但如果 `CHAT_DIR` 本身是符号链接，`realpath` 后可能不匹配。更严重的是：`os.path.realpath(filepath)` 只规范化了 filepath，而 `CHAT_DIR` 用的是 `os.path.realpath(CHAT_DIR)` — 两者比较逻辑本身是正确的，但**后续** `_current_chat_file[0] = real_path` 将用户控制的路径设为当前聊天文件，后续 `save_chat()` 会往这个路径写入 JSON。如果未来代码逻辑变更，这是一个潜在攻击面。
- **修复建议**: 额外验证文件扩展名必须为 `.json`，且文件名通过 `safe_chat_name()` 校验。

### P0-04: `save_chat()` 非原子写入 — 写入中断时数据丢失
- **文件**: `session/chat_store.py:113-114`
- **严重度**: P0
- **问题描述**: `save_chat()` 直接 `open(filepath, "w")` + `json.dump()`。如果在写入过程中进程崩溃或断电，JSON 文件会被截断为空或不完整，**整个对话历史丢失**。这是一个常见的数据丢失场景。
- **修复建议**: 使用原子写入模式：先写入临时文件 `filepath.tmp`，写完 `flush()+fsync()`，再 `os.rename()` 覆盖原文件。`os.rename()` 在 POSIX 和 NTFS 上都是原子的。

### P0-05: `api_chats_append()` JSON 写入非原子 + 无锁
- **文件**: `routers/chat.py:825-843`
- **严重度**: P0
- **问题描述**: `/api/chats/{chat_name}/append` 端点读取 JSON、追加消息、写回文件，但**没有使用 `_chat_save_lock`**（`chat_store.py` 中的全局锁）。如果同时有 `sse_gen()` 调用 `_save_chat()`，两个写操作会交错，导致 JSON 文件损坏。
- **修复建议**: 使用 `chat_store.py` 中的 `_chat_save_lock`，或调用 `save_chat()` 函数（已内置锁）。

### P0-06: `current_chat_file` 共享状态无锁 — 竞态条件
- **文件**: `routers/deps.py:50-53` + 多个路由文件
- **严重度**: P0
- **问题描述**: `_current_chat_file` 是一个可变列表 `[filepath]`，被多个 async 端点并发读写（`api_chats_switch` 写入、`api_chat_stream` 读取）。在 FastAPI 多线程/多协程环境下存在竞态条件：用户 A 切换到 chat_a，同时用户 B（同一进程但不同请求）切换到 chat_b，导致消息保存到错误的文件。
- **修复建议**: 使用 `threading.Lock()` 保护 `_current_chat_file` 的读写，或改用 `threading.local()`。

### P0-07: `_load_settings()` 吞掉 JSON 解析异常
- **文件**: `routers/settings.py:52-61`
- **严重度**: P0
- **问题描述**: `_load_settings()` 中 `except Exception: pass` 完全吞掉了 `json.load()` 的异常。如果 `settings.json` 被损坏，用户会得到默认空配置 `{} ` 而不是错误提示，可能导致后续操作用错误的默认值（如 `upload_max_size` 不存在时没有保护）。
- **修复建议**: 至少 `log.warning` 记录异常，避免静默降级。

---

## P1 — 应修复（功能缺陷 / 资源泄漏 / 性能问题）

### P1-01: `process_uploaded_file()` 对文件大小无限制
- **文件**: `files/file_extractor.py:32-33` (via `extract_text()`)
- **严重度**: P1
- **问题描述**: `extract_text()` 中 `f.read()` 读取整个文件内容到内存，没有大小检查。如果用户上传一个 2GB 的 .txt 文件到聊天，会直接 OOM。
- **修复建议**: 在 `process_uploaded_file()` 入口添加文件大小检查（如 `os.path.getsize(file_path)` 上限 50MB），或使用流式读取。

### P1-02: `api_qa_upload()` 上传 docx 时临时文件未清理
- **文件**: `routers/chat.py:868-873`
- **严重度**: P1
- **问题描述**: 上传 `.docx` 文件时写入临时路径 `tmp_path = os.path.join(UPLOAD_DIR, _safe_filename(file.filename))`，解析后未删除。多次上传会累积临时文件，占用磁盘空间。
- **修复建议**: 使用 `tempfile.NamedTemporaryFile(delete=True)` 或在解析完成后 `os.remove(tmp_path)`。

### P1-03: KB `process_document()` 中的 `_processing_lock` 不保护 `chunks` 字典的读操作
- **文件**: `knowledge_base.py:756` vs `488-508`
- **严重度**: P1
- **问题描述**: `_load_meta()` 和 `search()` 读取 `self.chunks` 和 `self.vectors` 时没有加锁，而 `process_document()` 和 `delete_document()` 在 `_processing_lock` 下修改它们。并发搜索和导入时可能读到不一致的数据。
- **修复建议**: 在 `search()` 和 `get_context()` 中也获取 `_processing_lock`（或使用 `threading.RLock`），至少在读向量索引时加锁。

### P1-04: `sse_gen()` 中续写和正文缺失续写的 `time.sleep()` 阻塞
- **文件**: `routers/chat.py:317-319`
- **严重度**: P1
- **问题描述**: `_stop_wait` 循环中 `time.sleep(0.3)` 最多阻塞 10 秒，在此期间 SSE 流无法 yield 任何数据给客户端。虽然网络连接不会被完全卡死（因为是在生成器内），但会延迟所有后续 token 输出。
- **修复建议**: 同 P0-01 方案。

### P1-05: `_save_meta()` 非原子写入
- **文件**: `knowledge_base.py:533-536`
- **严重度**: P1
- **问题描述**: 与 P0-04 类似，`kb_meta.json` 直接 `open("w")` 写入，中断会损坏所有文库元数据（文档列表、chunk 索引）。
- **修复建议**: 使用原子写入（先写临时文件再 rename）。

### P1-06: `_save_vectors()` 非原子写入
- **文件**: `knowledge_base.py:566-572`
- **严重度**: P1
- **问题描述**: `np.savez_compressed()` 直接覆盖 `kb_vectors.npz`，写入中断会损坏向量索引。
- **修复建议**: 先写入临时文件，完成后 rename。

### P1-07: `_install_worker()` 中 `subprocess.run(pip_args, ...)` 无错误检查
- **文件**: `routers/settings.py:777-779`
- **严重度**: P1
- **问题描述**: 安装依赖包时 `subprocess.run()` 的返回值被忽略（`except Exception: pass`），即使 pip 安装失败，安装流程仍继续并报告成功。用户以为扩展安装完成但实际依赖缺失。
- **修复建议**: 检查 `result.returncode`，非零时 raise 或记入进度队列。

### P1-08: `api_qa_ask()` 未对 `file_content` 长度做硬限制
- **文件**: `routers/chat.py:943`
- **严重度**: P1
- **问题描述**: `file_content[:80000]` 截断到 80K 字符，加上 system prompt 和 question，最终消息可能接近 81K 字符。对于小模型（4B，32K token 限制），这远超上下文窗口，Ollama 会报错或截断。
- **修复建议**: 根据当前模型的 token 限制动态计算 `file_content` 截断长度。

### P1-09: `api_chats_delete()` 删除后不清理 `context_cache` 相关文件
- **文件**: `routers/chat.py:782-790`
- **严重度**: P1
- **问题描述**: 删除对话文件后，`_current_chat_file[0]` 设为 None，但已删除文件的 `context_cache` 数据仍然在内存中（如果之前加载过）。下次新建对话时可能误用旧的 cache。
- **修复建议**: 删除文件时同时清理对应的内存缓存。

### P1-10: `ModelManager.__new__()` 中的单例模式非线程安全
- **文件**: `core/model_manager.py:28-34`
- **严重度**: P1
- **问题描述**: `__new__` 中的 `cls._lock` 是类属性，`_instance` 和 `_initialized` 的检查在锁内，但 `_init_lock` 的获取在 `__init__` 中。如果两个线程同时首次创建 `ModelManager`，`__new__` 返回同一实例但 `__init__` 可能被调用两次。
- **修复建议**: 在 `__init__` 中 `_init_lock` 获取后再次检查 `_initialized`（当前已有，但 `__new__` 中的 `cls._instance` 设置和 `__init__` 中的 `_initialized` 之间存在微小窗口）。

### P1-11: `stop_generation()` 中 `_gen_lock.release()` 不属于当前线程可能 RuntimeError
- **文件**: `core/model_manager.py:467-472`
- **严重度**: P1
- **问题描述**: `_gen_lock` 是普通 `threading.Lock()`，`release()` 必须由 `acquire()` 的同一线程调用。如果 `_gen_lock` 是由 StreamEngine 的线程持有的，`stop_generation()` 从另一个线程调用 `release()` 会抛 `RuntimeError: release unlocked lock`。虽然有 `try/except RuntimeError: pass` 保护，但这意味着锁可能永久被持有。
- **修复建议**: 使用 `threading.RLock()` 替代 `threading.Lock()`，或使用 `Event` 替代 Lock 进行停止信号传递。

### P1-12: `_load_meta()` 加载所有 chunk 文本到内存
- **文件**: `knowledge_base.py:474-484`
- **严重度**: P1
- **问题描述**: `_load_meta()` 在初始化时将所有 chunk 的文本内容加载到内存（`chunk.text = f.read()`）。20 文档 × 200 chunk × 平均 500 字 = 2MB，一般没问题，但如果用户导入大量大文档（如 50 个文档 × 200 chunk × 2000 字 = 20MB），启动时内存占用会明显增加。
- **修复建议**: 考虑延迟加载 chunk 文本（只在搜索时读取），或设置总 chunk 数/总字符数上限。

### P1-13: `_unload_reranker()` 直接操作 `self.reranker._loaded` 等私有属性
- **文件**: `knowledge_base.py:313-315`
- **严重度**: P1
- **问题描述**: `_unload_reranker()` 和 `unload_models()` 直接设置 `self.reranker._loaded = False`、`self.reranker._model = None`、`self.reranker._mode = "none"`。这绕过了 `RerankerEngine` 的封装，如果引擎内部有其他需要清理的状态（如 tokenizer 缓存），会被跳过。
- **修复建议**: 给 `RerankerEngine` 添加 `unload()` 方法，通过公开接口卸载。

### P1-14: `api_kb_upload()` 全量读入 `content_bytes` 可能 OOM
- **文件**: `routers/kb.py:540`
- **严重度**: P1
- **问题描述**: `await file.read()` 将整个上传文件读入内存。虽然有 `_UPLOAD_MAX_SIZE`（50MB）限制，但 50MB 的二进制数据 + 解码后的文本 + 嵌入计算可能占用 200MB+ 内存。
- **修复建议**: 考虑流式写入临时文件，再从文件解析文本。

### P1-15: `_kb_sessions` 会话清理逻辑存在竞态
- **文件**: `routers/kb.py:897-908`
- **严重度**: P1
- **问题描述**: `_kb_sessions[session_id] = kb_history` 在锁外修改字典（第 901 行），然后在 `with _kb_sessions_lock:` 内清理（第 903-908 行）。两个并发请求可能同时修改同一个 session 的 history。
- **修复建议**: 将 `_kb_sessions[session_id] = kb_history` 也放入锁内。

### P1-16: `delete_document()` 中 `chunk_order.remove(cid)` 是 O(n) 操作
- **文件**: `knowledge_base.py:1026`
- **严重度**: P1
- **问题描述**: `chunk_order` 是 list，`remove()` 每次调用遍历整个列表。如果删除一个有 200 chunks 的文档，总时间复杂度 O(200 × total_chunks)。对于 1000 chunks，这是 200K 次比较。
- **修复建议**: 先构建 `set(doc_chunk_ids)`，然后 `[cid for cid in self.chunk_order if cid not in remove_set]`。

---

## P2 — 建议修复（代码质量 / 防御性编程 / 可维护性）

### P2-01: `sse_gen()` 中 `except Exception` 吞掉所有异常
- **文件**: `routers/chat.py:459-464`
- **严重度**: P2
- **问题描述**: 虽然有 `log.error`，但 `except Exception as e` 会捕获所有异常包括 `SystemExit` 和 `KeyboardInterrupt`（Python 中 `Exception` 不包括这两者，但业务异常被完全吞掉后直接 `return`，外层 `finally` 仍会执行保存）。
- **修复建议**: 可以保持当前逻辑，但建议用 `except Exception` 而非裸 `except:`（当前已经是 `except Exception`，OK）。

### P2-02: `is_output_incomplete()` 中括号平衡检测过于简单
- **文件**: `session/continuation.py:44-52`
- **严重度**: P2
- **问题描述**: 括号平衡检测不考虑字符串内的括号，代码中有 `print("hello (world")` 之类的字符串会误判为未闭合。
- **修复建议**: 跳过字符串内容（类似 response_filter.py 中的 `_strip_trailing_comment` 方法）。

### P2-03: `clean_history_for_model()` 去掉所有 HTML 标签过于激进
- **文件**: `session/context_cache.py:52`
- **严重度**: P2
- **问题描述**: `re.sub(r'<[^>]+>', '', content)` 会去掉所有 `<...>` 内容，如果用户消息中包含合法的 `<` 符号（如数学公式 `a < b`），后续内容可能被误删。
- **修复建议**: 使用更精确的 HTML 标签正则，或只去除已知标签（`<details>`, `<think` 等）。

### P2-04: `extract_text()` 中 PDF 页数无限制
- **文件**: `files/file_extractor.py:79-83`
- **严重度**: P2
- **问题描述**: `for page in doc:` 遍历所有页面，无页数限制。一个 1000 页的 PDF 会提取大量文本。
- **修复建议**: 限制为 `pdf.pages[:100]`（与 `api_qa_upload` 中的 `pdf.pages[:50]` 保持一致）。

### P2-05: `_safe_filename()` 正则过于严格，丢失中文文件名
- **文件**: `routers/chat.py:81-89` + `routers/kb.py:80-89`
- **严重度**: P2
- **问题描述**: `re.sub(r'[^\w\-.]', '_', filename)` 会把中文字符替换为 `_`。如 `会议纪要.docx` → `______.docx`，用户无法识别文件。
- **修复建议**: 正则中加入 Unicode 范围：`re.sub(r'[^\w\-.\u4e00-\u9fff]', '_', filename)`。

### P2-06: `list_chats()` 读取每个文件加载完整 JSON 仅为计数
- **文件**: `session/chat_store.py:155-171`
- **严重度**: P2
- **问题描述**: `list_chats()` 对每个聊天文件执行完整的 `json.load()`，只为了获取消息数量。如果聊天文件很大（如 1000 条消息 × 2000 字 = 2MB × 20 文件 = 40MB），这是不必要的内存和 CPU 开销。
- **修复建议**: 只读 JSON 的 `messages` 数组长度，不加载完整内容（或用 `json.JSONDecoder().raw_decode()` 流式解析）。

### P2-07: `OllamaManager._launch_process()` 硬编码环境变量
- **文件**: `core/ollama_manager.py:161-170`
- **严重度**: P2
- **问题描述**: `OLLAMA_GPU_OVERHEAD = "2147483648"`（2GB）和 `OLLAMA_GPU_LAYERS = "99"` 是硬编码的。不同用户的 GPU 显存不同，这些值可能导致 OOM 或 GPU 利用不足。
- **修复建议**: 从 `config.py` 读取，或根据检测到的显存动态调整。

### P2-08: `_load_config()` 中 `except` 吞掉配置加载失败
- **文件**: `knowledge_base.py:184-185`
- **严重度**: P2
- **问题描述**: 配置加载失败时 `log.warning` 后使用默认值，但某些配置项（如 `upload_max_size`）如果读取失败，下游可能用 None 导致 TypeError。
- **修复建议**: 确保所有配置项都有合理的默认值兜底（当前已做到，确认 OK）。

### P2-09: `_strip_trailing_comment()` 逻辑有 bug
- **文件**: `common/context_compressor.py:141-166`
- **严重度**: P2
- **问题描述**: 函数前半部分遍历字符串跟踪 `in_single`/`in_double` 状态但**没有使用结果**。后半部分用 `count("`)%2 判断引号平衡。前半部分的遍历是死代码。另外，`line.count("\\'")` 只计算转义引号数量，但不能正确定位它们的位置。
- **修复建议**: 删除前半部分死代码，或正确使用前半部分的引号位置信息来定位注释。

### P2-10: `SidemateValidator` 中 `zf.close()` 不用 `with` 语句
- **文件**: `validators/sidemate_validator.py:68-172`
- **严重度**: P2
- **问题描述**: `ZipFile` 使用 `try/finally` 手动关闭，但如果有多个提前 return 点（如第 77 行 `return False, ...`），`zf` 未被关闭（虽然 `finally` 块会处理，但可读性差）。
- **修复建议**: 使用 `with zipfile.ZipFile(...) as zf:`。

### P2-11: `_detect_code_hallucination()` 的正则不覆盖所有语言
- **文件**: `intelligence/response_filter.py:139-142`
- **严重度**: P2
- **问题描述**: 检测模式 `r'(?:def|class|function|var|let|const)\s+[\u4e00-\u9fff]+'` 不覆盖 Go (`func`)、Rust (`fn`)、Swift (`func`) 等语言。
- **修复建议**: 扩展关键字列表。

### P2-12: `api_workspace_download()` 未验证文件非敏感
- **文件**: `routers/settings.py:406-417`
- **严重度**: P2
- **问题描述**: 虽然 `workspace` 目录理论上只包含沙盒生成的文件，但路径穿越检查通过后直接返回 `FileResponse`，没有限制文件类型。如果 AI 生成 `.env` 或配置文件，用户可以下载到敏感信息。
- **修复建议**: 添加文件类型白名单或拒绝隐藏文件（`.` 开头）。

---

## 总结

| 级别 | 数量 | 关键问题 |
|------|------|---------|
| **P0** | **7** | SSE 阻塞事件循环、非原子写入导致数据丢失、竞态条件、JSON 写入无锁 |
| **P1** | **16** | 文件大小无限制 OOM、临时文件泄漏、并发读写无锁、非原子写入、属性封装破坏 |
| **P2** | **12** | 中文文件名丢失、括号检测误判、死代码、硬编码配置 |

### 发版评估

**不建议在当前状态下直接发版。** 原因：

1. **P0-01/P0-02（SSE 阻塞事件循环）** 是架构级问题，会影响所有用户的并发体验。当一个用户在流式对话时，所有其他用户的 HTTP 请求会被阻塞。这在生产环境中表现为服务"假死"。

2. **P0-04/P0-05（非原子写入 + 无锁写入）** 直接威胁用户数据安全。对话历史和文库元数据在异常情况下可能丢失或损坏。

3. **P0-06（current_chat_file 竞态条件）** 在多标签页场景下可能导致消息写入错误的对话文件。

### 最小发版修复建议（P0 Only）

1. **P0-01/02**: 将 `sse_gen()` 改为 async generator，或用 `run_in_executor` 包裹
2. **P0-04**: `save_chat()` 改为原子写入（write tmp → fsync → rename）
3. **P0-05**: `api_chats_append()` 使用 `_chat_save_lock` 或调用 `save_chat()`
4. **P0-06**: `_current_chat_file` 读写加 `threading.Lock`
5. **P0-07**: `_load_settings()` 添加日志
6. **P0-03**: 增加扩展名校验
