# 代码审阅报告 V3 — _local-ai v0.8 (稳定性专项)

> 审阅日期: 2026-05-17
> 基准: 基于 V1/V2 报告，对比用户修复后的代码，重点审计 v0.8 新增模块
> 审阅范围: server.py, models.py, task_classifier.py, cloud_provider.py, response_filter.py, context_compressor.py, pet_notebook.py, env_check.py, prompts.py, distill.py, agent.py, skill_loader.py, skill_router.py, permissions.py, audit_log.py, training.py, feedback.py
> 规则: **只审阅，不修改**
> 重点: **稳定性问题、崩溃风险、竞态条件、资源泄漏、并发安全**

---

## V2 修复状态确认

经重新审阅代码，V2 中发现的 **NEW-1 (_stats 初始化)** 已修复（`models.py` 第75-82行已正确初始化）。

但 V2 中其余 **10 项问题全部未修复**，其中多项属于稳定性风险，详见下文。

| V2编号 | 级别 | 描述 | 修复状态 |
|--------|------|------|----------|
| NEW-1 | P0 | `_stats` / `_stats_lock` 未初始化 | **已修复** |
| NEW-2 | P1 | `_stop_generation` 锁未实际使用 | **未修复** |
| NEW-3 | P1 | `_build_prompt` 截断效率低下 | **未修复** |
| NEW-4 | P1 | `_is_output_incomplete` rfind 误匹配 | **未修复** |
| NEW-5 | P1 | `device_limits.json` 并发读写无锁 | **未修复** |
| NEW-6 | P1 | 续写时 `body_history` 语义不合理 | **未修复** |
| NEW-7 | P2 | `_detect_think_tags` 嵌套标签 | **未修复** |
| NEW-8 | P2 | `_get_model_size` 默认返回8 | **未修复** |
| NEW-9 | P2 | `cloud_provider.py` 默认空值 | **未修复** |
| NEW-10 | P2 | `server.py` 直接调用 `_strip_think` | **未修复** |
| NEW-11 | P2 | `task_classifier.py` 子串提取效率 | **未修复** |

---

## P0 严重问题（稳定性崩溃风险）

以下问题**可直接导致服务崩溃、假死或数据破坏**，与用户反馈的"测试时已经发现好几次崩溃事件"高度相关。

---

### P0-1. `_gen_lock` 死锁风险 — `_generate` 线程卡死导致服务永久假死

**位置**: `models.py` 第1043-1068行 (`chat_stream` 内部的 `_generate` 函数)

```python
def _generate():
    acquired = False
    try:
        acquired = self._gen_lock.acquire(timeout=15)
        if not acquired:
            err[0] = "generate: 等待设备释放超时"
            return
        pipe.generate(prompt, max_new_tokens=max_tokens, streamer=on_token, ...)
    except Exception as e:
        err[0] = "generate: %s" % str(e)[:200]
    finally:
        q.put(None)
        self._gen_done.set()
        if acquired:
            self._gen_lock.release()
```

**问题**:
1. `pipe.generate()` 在 NPU/GPU 设备上运行时，如果底层驱动死锁（NPU 常见稳定性问题），`_generate` 线程将**永远卡在 `pipe.generate()` 内部**，永远不会执行 `finally` 块。
2. `finally` 块中的 `self._gen_lock.release()` 永远不会执行，`_gen_lock` 被**永久占用**。
3. 后续所有 `chat_stream` 调用都会在 `_gen_lock.acquire(timeout=15)` 处超时（第1046行），返回 `err[0] = "generate: 等待设备释放超时"`。
4. 服务进入**永久性假死状态**——不崩溃，但所有对话请求都失败。用户必须重启服务。

**为什么用户会遇到"崩溃"**:
- 如果用户在前端看到"等待设备释放超时"后刷新页面重试，重试同样失败。
- 如果用户在此时切换设备（`api_device_switch`），会尝试卸载模型，但 `_generate` 线程仍持有 `pipe` 引用，底层资源未释放。
- 新的 `load()` 创建新 `pipe` 时，NPU 设备已被旧 `pipe` 占用，可能触发底层 C++ 异常（如 `Infer Request is busy`），表现为服务崩溃。

**修复建议**:
1. **最关键**：在 `_generate` 线程外设置守护机制。主线程的 `while True` 循环中 `q.get(timeout=30)` 已经能在30秒后感知超时，但 `_generate` 线程仍在运行。
2. 使用 `threading.Thread` 的 `daemon=True` 已经是 daemon（第1070行），但如果主线程不退出，daemon 线程不会自动终止。
3. **推荐方案**：将 `pipe.generate()` 放在独立的 `Process` 中执行（而非 Thread），这样如果进程卡死，可以 `terminate()` 强制终止。但这改动较大。
4. **折中方案**：在 `stop_generation()` 中增加 `_gen_lock` 的强制释放逻辑（虽然不优雅，但比假死好）：
```python
# models.py stop_generation() 改进
def stop_generation(self):
    self._stop_generation = True
    self._gen_done.wait(timeout=5.0)
    # 强制释放 _gen_lock（如果 _generate 线程卡死）
    if self._gen_lock.locked():
        try:
            self._gen_lock.release()
            log_scan.warning("[STOP] 强制释放 _gen_lock（generate 线程可能已死锁）")
        except RuntimeError:
            pass  # 锁未被当前线程持有
    # ... 后续卸载逻辑
```
5. **更重要**：`api_stop` 端点（`server.py` 第672-682行）目前只是"发起停止"，没有等待确认。应该返回停止状态，并在前端显示"正在停止..."，5秒后再允许发送新消息。

---

### P0-2. 文件上传路径遍历 — 可覆盖任意文件导致系统崩溃或数据丢失

**位置**:
- `server.py` 第1997-2008行 (`api_file_upload`)
- `server.py` 第1582-1589行 (`api_ocr_upload`)

```python
# api_file_upload (第2004行)
save_path = os.path.join(upload_dir, file.filename)
# api_ocr_upload (第1584行)
save_path = os.path.join(WORKSPACE_DIR, "tmp_upload", file.filename)
```

**问题**:
1. `file.filename` 来自 HTTP 请求头 `Content-Disposition`，未经任何校验。
2. 攻击者可构造 `file.filename = "../server.py"`，导致 `save_path` 指向 `WORKSPACE_DIR/server.py`。
3. 后果：
   - 覆盖 `server.py` → 服务代码被破坏，重启后无法启动
   - 覆盖 `settings.json` → 云端 API Key 丢失或篡改
   - 覆盖 `notebook.json` → 用户数据丢失
   - 覆盖 `models.py` → 整个模型管理逻辑被破坏

**影响**: 这不是传统意义上的"崩溃"，但一旦被恶意利用，系统文件被覆盖后服务必然无法运行。在生产环境中，任何能访问上传接口的人都能破坏系统。

**修复建议**:
```python
import os

def _safe_filename(filename: str) -> str:
    """防止路径遍历，只保留安全文件名"""
    if not filename:
        return "unnamed"
    # 去掉路径分隔符
    filename = os.path.basename(filename)
    # 进一步清理危险字符
    filename = re.sub(r'[^\w\-.]', '_', filename)
    return filename

# 在 api_file_upload 和 api_ocr_upload 中使用
save_path = os.path.join(upload_dir, _safe_filename(file.filename))
```

---

### P0-3. 对话管理 API 路径遍历 — 可删除/读取任意 `.json` 文件

**位置**:
- `server.py` 第1473-1490行 (`api_chats_delete`)
- `server.py` 第1492-1497行 (`api_chats_messages`)

```python
# api_chats_delete (第1477行)
filepath = os.path.join(CHAT_DIR, chat_name + ".json")
# api_chats_messages (第1495行)
filepath = os.path.join(CHAT_DIR, chat_name + ".json")
```

**问题**:
1. `chat_name` 来自 URL 路径参数，未经校验。
2. 攻击者可请求 `DELETE /api/chats/../notebook` → 删除 `WORKSPACE_DIR/notebook.json`。
3. 攻击者可请求 `GET /api/chats/../settings/messages` → 读取 `WORKSPACE_DIR/settings.json`。

**影响**: 数据丢失（删除小册子、设置、训练记录）或敏感信息泄露（settings.json 中的云端配置）。

**修复建议**:
```python
# 统一安全校验函数
def _safe_chat_name(chat_name: str) -> str:
    if not chat_name or "/" in chat_name or "\\" in chat_name or ".." in chat_name:
        return None
    return chat_name

# api_chats_delete 中
safe_name = _safe_chat_name(chat_name)
if not safe_name:
    return JSONResponse({"error": "非法对话名称"}, status_code=400)
filepath = os.path.join(CHAT_DIR, safe_name + ".json")
```

---

### P0-4. ZIP Slip 漏洞 — 模型/技能导入可写入任意路径

**位置**:
- `server.py` 第876-889行 (`api_models_import` 中的 ZIP 解压)
- `skill_loader.py` 第226-234行 (`import_skill_zip` 中的 ZIP 解压)

```python
# server.py 第886行
relative = member[len(zip_prefix):] if zip_prefix else member
dest = os.path.join(target_dir, relative)

# skill_loader.py 第229行
relative = member[len(zip_prefix):] if zip_prefix else member
dest = os.path.join(target_dir, relative)
```

**问题**:
1. ZIP 文件中的成员名可能包含 `../`（ZIP Slip 攻击）。
2. 例如 ZIP 中有一个成员 `../../notebook.json`，解压后会覆盖 `WORKSPACE_DIR/notebook.json`。
3. 虽然 ZIP 通常用 `/` 作为分隔符，但 `os.path.join` 在 Windows 上也会正确处理 `../`。

**影响**: 通过上传恶意 ZIP，可覆盖系统任意文件。

**修复建议**:
```python
import os

def _safe_extract_path(target_dir: str, member_path: str) -> str:
    """校验 ZIP 成员解压路径是否在目标目录内"""
    dest = os.path.normpath(os.path.join(target_dir, member_path))
    real_target = os.path.realpath(target_dir)
    real_dest = os.path.realpath(dest)
    if not real_dest.startswith(real_target + os.sep) and real_dest != real_target:
        raise ValueError("ZIP 成员路径越界: %s" % member_path)
    return dest

# 在解压循环中使用
dest = _safe_extract_path(target_dir, relative)
```

---

### P0-5. NPU/GPU 设备切换与正在进行的生成冲突

**位置**:
- `server.py` 第653-664行 (`api_device_switch`)
- `models.py` 第469-518行 (`switch_device`)

**问题**:
1. `switch_device()` 会遍历 `_loaded` 并 `del self._loaded[name]`（第496-498行）。
2. 如果此时有一个 `_generate` 线程正在运行，它的闭包中引用了 `pipe` 对象（第1050行 `pipe.generate(...)`）。
3. `del self._loaded[name]` 只是从字典中删除引用。`_generate` 线程的闭包仍持有 `pipe` 引用，**对象不会被销毁**。
4. 更严重的是：`switch_device` 随后更新 `self._default_device`（第504行），并修改所有 LLM 的 `cfg["device"]`（第506-508行）。
5. 新的请求调用 `chat_stream` → `model not in self._loaded` → 自动 `load(model)` → 创建新的 `LLMPipeline`。
6. 新的 `pipe` 尝试在同一设备（NPU/GPU）上创建 InferRequest，但旧的 `pipe` 仍在占用设备资源。
7. 结果：
   - 新 `pipe.generate()` 可能失败，抛出 `Infer Request is busy` 或类似底层错误
   - 或新 `pipe` 创建成功但运行异常缓慢/不稳定
   - 最坏情况下，驱动层资源冲突导致整个 Python 进程崩溃（segfault）

**影响**: 用户在生成过程中切换设备（或点击"停止"后切换设备），极可能导致崩溃。

**修复建议**:
1. 在 `switch_device()` 执行前，先调用 `stop_generation()` 等待当前生成完全结束（或超时）。
2. 或者：在 `switch_device()` 中检查 `_gen_lock.locked()`，如果锁被占用，返回错误 `"请等待当前生成完成后再切换设备"`。
3. 最佳方案：增加 `_active_request_count` 计数器，设备切换时检查是否有活动请求。

---

## P1 高优先级问题（稳定性/性能/安全）

### P1-6. `_stop_generation` 竞态条件 — V2 NEW-2 未修复

**位置**:
- `models.py` 第434行 (`stop_generation`)
- `server.py` 第677行 (`api_stop`)
- `server.py` 第979行、第1146行 (`sse_gen`)

```python
# models.py 第434行
def stop_generation(self):
    self._stop_generation = True   # <-- 无锁

# server.py 第677行
mgr._stop_generation = True        # <-- 无锁

# server.py 第979行、第1146行
mgr._stop_generation = False       # <-- 无锁
```

**问题**:
- 虽然 `models.py` 第65行声明了 `_stop_lock`，但**没有任何代码使用它**。
- 并发请求场景：请求A 正在生成，请求B 点击停止。B 设置 `_stop_generation = True`，这会同时中断 A 的生成。
- 更严重的是：`sse_gen` 在每次请求开始时设置 `_stop_generation = False`（第979行），如果此时 B 的 `stop_generation()` 刚设置了 `True`，A 的生成还未检查标志，A 的 `False` 会覆盖 B 的 `True`，导致 B 的停止请求失效。

**修复建议**:
```python
# models.py
def stop_generation(self):
    with self._stop_lock:
        self._stop_generation = True

def reset_stop_flag(self):
    with self._stop_lock:
        self._stop_generation = False

# server.py 中
with mgr._stop_lock:
    mgr._stop_generation = False
```

---

### P1-7. `device_limits.json` 并发读写竞争 — V2 NEW-5 未修复

**位置**: `models.py` 第686-697行 (`_update_device_token_limit`)

```python
cache_path = os.path.join(self.base_dir, "device_limits.json")
cached = {}
if os.path.exists(cache_path):
    with open(cache_path, 'r', encoding='utf-8') as f:
        cached = json.load(f)
cached[cache_key_str] = new_limit
with open(cache_path, 'w', encoding='utf-8') as f:
    json.dump(cached, f, indent=2)
```

**问题**:
- 并发对话同时触发 overflow 时，两个线程同时读取、修改、写入同一个 JSON 文件。
- 结果：`device_limits.json` 可能变成无效 JSON（如 `{"qwen3-8b@NPU": 1440}{"qwen3-8b@NPU": 1152}`），后续读取时 `json.load()` 抛出异常，回退到默认值。
- 虽然不会崩溃（异常被捕获），但缓存策略失效，每次启动都重新探测。

**修复建议**:
```python
# 在 __init__ 中增加文件锁
self._device_limits_lock = threading.Lock()

# _update_device_token_limit 中
with self._device_limits_lock:
    # 原有读写逻辑
```

---

### P1-8. `cloud_provider.py` SSE 流式响应无读超时

**位置**: `cloud_provider.py` 第279行 (`chat_stream_cloud`)

```python
resp = _SESSION.post(url, json=body, headers=headers,
                     timeout=_CLOUD_STREAM_TIMEOUT, stream=True)
resp.raise_for_status()
for line in resp.iter_lines(decode_unicode=True):
    ...
```

**问题**:
1. `timeout=_CLOUD_STREAM_TIMEOUT`（120秒）只控制**连接建立和读取第一个字节**的时间。
2. `iter_lines()` 在连接保持但服务端不发送数据时，**永远不会超时**。
3. 如果云端服务异常（如负载均衡器保持连接但后端无响应），`iter_lines()` 会永久阻塞。
4. 前端 SSE 连接也会永远挂起，用户无法发起新请求。

**影响**: 服务端线程被永久占用，可能导致线程池耗尽（FastAPI 默认线程池有限）。

**修复建议**:
1. 使用 `requests` 的 `iter_lines` 配合 `socket` 超时：
```python
import socket

# 设置底层 socket 读取超时
resp = _SESSION.post(url, json=body, headers=headers,
                     timeout=(_CLOUD_STREAM_TIMEOUT, _CLOUD_STREAM_TIMEOUT),
                     stream=True)
```
2. 或使用 `requests` 的 `iter_content` 配合手动超时检查：
```python
t0 = time.time()
for line in resp.iter_lines(decode_unicode=True):
    if time.time() - t0 > _CLOUD_STREAM_TIMEOUT:
        yield ("raw", "[ERROR] 云端响应超时")
        break
```

---

### P1-9. 数据文件并发写入竞争

**位置**:
- `pet_notebook.py` 第91-96行 (`save`)
- `feedback.py` 第69-72行 (`save`)
- `training.py` 第80-84行 (`save`)
- `server.py` 第756-760行 (`_save_settings`)
- `models.py` 第686-697行 (`_update_device_token_limit`，同上)

**问题**:
- 以上所有 `save()` 方法都直接 `open(path, "w")` 写入 JSON，**没有任何文件锁或线程锁**。
- 并发场景：
  - 用户快速发送两条消息 → `pet_notebook.extract_and_update()` 被调用两次 → 两个线程同时写 `notebook.json`
  - 用户快速切换对话 → `_save_chat` 被并发调用
  - 训练记录和反馈同时提交
- 后果：文件内容可能变成混合的无效 JSON（如前半部分是一个JSON，后半部分是另一个JSON）。

**影响**: 文件损坏后，下次启动时 `json.load()` 抛出 `JSONDecodeError`，模块回退到默认值，**用户数据丢失**。

**修复建议**:
为每个管理器增加线程锁：
```python
# PetNotebook.__init__ 中
self._save_lock = threading.Lock()

# save() 中
with self._save_lock:
    with open(self.filepath, "w", encoding="utf-8") as f:
        json.dump(self.data, f, ensure_ascii=False, indent=2)
```

---

### P1-10. `api_stop` 与新生成请求的竞态条件

**位置**: `server.py` 第672-682行 (`api_stop`)

```python
@app.post("/api/stop")
async def api_stop():
    mgr._stop_generation = True
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, mgr.stop_generation)
    return {"ok": True}
```

**问题**:
1. `mgr.stop_generation()` 在后台线程中执行，耗时可能超过 5 秒（等待 `_gen_done` + 卸载模型）。
2. 前端收到 `{"ok": True}` 后立即允许用户发送新消息。
3. 新请求进入 `sse_gen`，调用 `mgr.chat_stream()` → `_generate` 线程尝试获取 `_gen_lock`。
4. 但 `mgr.stop_generation()` 可能仍在运行，它会在 5 秒后尝试卸载模型。如果 `_generate` 线程还没启动（或刚启动），`stop_generation` 卸载模型后，`_generate` 线程的 `pipe.generate()` 会因为 `pipe` 被删除而失败。
5. 或者：如果新请求已经创建了新的 `pipe`，`stop_generation` 卸载的是旧的，但 `_gen_lock` 的竞争仍然复杂。

**影响**: 快速"停止→发送"操作序列可能导致生成失败或异常。

**修复建议**:
1. `api_stop` 应等待 `stop_generation()` 完成后再返回（或返回 `{"ok": True, "stopping": true}`，前端等待确认）。
2. 或者增加一个 `_stop_in_progress` 标志，新请求在标志为 True 时排队等待。

---

### P1-11. `_build_prompt` 截断效率低下 — V2 NEW-3 未修复

**位置**: `models.py` 第826-843行

```python
while prompt_len > max_prompt_tokens and len(messages) > 2:
    for i in range(len(messages)):
        if messages[i].get("role") in ("user", "assistant") and i < len(messages) - 1:
            removed = messages.pop(i)
            break
    else:
        break
    prompt = tok.apply_chat_template(messages, add_generation_prompt=True)
    ...
```

**问题**:
- 每次只删一条消息，然后重新调用 `apply_chat_template`（涉及 tokenizer 状态机）。
- 如果历史有 15 条，可能需要调用 15 次 `apply_chat_template` + `tok.encode()`。
- 长历史场景下，截断过程可能增加数百毫秒延迟。

**修复建议**: 预计算每条消息的 token 数，二分法决定保留多少条，只调用一次 `apply_chat_template`。

---

### P1-12. `_is_output_incomplete` rfind 误匹配 — V2 NEW-4 未修复

**位置**: `server.py` 第1138行

```python
after_match = stripped[stripped.rfind(m2.group()):]
```

**问题**:
- `rfind` 找 `m2.group()` 在 `stripped` 中的**最后一次出现**。
- 如果用户消息中本身就包含"如下："等词语，`rfind` 可能找到错误位置。
- 导致 `re.findall(r'```.*?```', after_match)` 在错误区间搜索，产生误判。

**修复建议**:
```python
after_match = stripped[m2.end():]  # 使用精确位置
```

---

### P1-13. 续写历史语义不合理 — V2 NEW-6 未修复

**位置**: `server.py` 第1283-1288行

```python
body_history = []
device = mgr._default_device
if device != "NPU" and model_history:
    body_history = list(model_history)
body_history.append({"role": "user", "content": prompt})
body_history.append({"role": "assistant", "content": "/no_think\n请直接给出最终回答，不要重复推理过程。"})
```

**问题**:
- 续写历史中，assistant 的消息内容是 `/no_think\n请直接给出最终回答，不要重复推理过程。`
- 模型会困惑：为什么上一个 assistant 回复是"不要重复推理过程"？这会引入语义偏差。

**修复建议**:
- 将 `/no_think` 指令放在 system prompt 中，而不是 assistant 消息中。

---

## P2 中等问题（代码质量/潜在隐患）

### P2-14. `_detect_think_tags` 嵌套标签处理有漏洞 — V2 NEW-7 未修复

**位置**: `models.py` 第283-306行

```python
def _detect_think_tags(self, text):
    for start_marker, end_marker in self._THINK_TAG_MARKERS:
        start_idx = text.find(start_marker)
        ...
        end_idx = text.find(end_marker, content_start)
```

**问题**:
- 如果文本中有嵌套 think 标签（如 `<think>外层<think>内层</think>外层结束</think>`），`find(end_marker)` 会找到第一个 `</think>`，导致外层内容被截断。
- 虽然 Qwen3 通常不会输出嵌套 think 标签，但 OpenVINO GenAI 的流式输出可能产生不完整的标签。

**修复建议**: 使用计数器匹配开闭标签，或限制只处理最外层标签对。

---

### P2-15. `_get_model_size` 默认返回8可能误判小模型 — V2 NEW-8 未修复

**位置**: `models.py` 第699-714行

```python
m = re.search(r'(\d+\.?\d*)\s*b', name_lower)
if not m:
    return 8  # 默认中等
```

**问题**:
- 如果用户导入的自定义模型名不包含 `数字+B` 模式（如 `"my-custom-model"`），会错误地使用 8B profile。
- 对于实际的小模型（<4B），这可能导致 context overflow。

**修复建议**:
- 尝试从 `config.json` 的 `num_hidden_layers` 和 `hidden_size` 估算参数量。
- 或默认使用最小 profile（0.5B）。

---

### P2-16. `cloud_provider.py` 默认值从空字符串改为有值后缺失 — V2 NEW-9 未修复

**位置**: `cloud_provider.py` 第117-118行

```python
"base_url": cloud.get("base_url", ""),
"model": cloud.get("model", ""),
```

**问题**:
- 首次打开前端时，Base URL 和 Model 字段显示为空。
- 用户不知道默认填什么。

**修复建议**: 恢复默认值或在 UI 中显示 placeholder。

---

### P2-17. `server.py` 直接调用 `_strip_think` — V2 NEW-10 未修复

**位置**: `server.py` 第1403行

```python
final_response = mgr._strip_think(final_response)
```

**问题**:
- `_strip_think` 以单下划线开头，是内部方法。
- 外部模块直接调用破坏了封装。

**修复建议**: 暴露公共方法 `strip_think()`。

---

### P2-18. `task_classifier.py` 子串提取效率低 — V2 NEW-11 未修复

**位置**: `task_classifier.py` 第399-406行

```python
for segment in _last_cn:
    for length in range(2, min(5, len(segment) + 1)):
        for start in range(len(segment) - length + 1):
            sub = segment[start:start + length]
```

**问题**:
- 三重循环生成所有 2-4 字子串，时间复杂度 O(n³)。
- 对于 100 字中文文本，约生成 15000 次子串操作。

**修复建议**: 使用 `collections.deque` 做滑动窗口。

---

### P2-19. `api_file_upload` / `api_ocr_upload` 无文件大小限制

**位置**:
- `server.py` 第1997-2008行
- `server.py` 第1582-1589行

**问题**:
- 未限制上传文件大小，用户可能上传数 GB 的文件导致 OOM。

**修复建议**: 增加大小校验（如最大 50MB）。

---

### P2-20. `_read_excel` 文件句柄泄漏风险

**位置**: `server.py` 第459-491行

```python
try:
    import openpyxl
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    ...
    wb.close()
except ImportError:
    # 降级: 尝试 pandas
    try:
        import pandas as pd
        dfs = pd.read_excel(file_path, sheet_name=None, nrows=50)
        ...
```

**问题**:
- 如果 `openpyxl.load_workbook` 成功，但后续代码（如 `wb.sheetnames` 或 `ws.iter_rows`）抛出异常，`wb.close()` 不会执行，文件句柄泄漏。
- 应使用 `try/finally` 或上下文管理器。

**修复建议**:
```python
try:
    import openpyxl
    wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
    try:
        ...  # 使用 wb
    finally:
        wb.close()
except ImportError:
    ...
```

---

### P2-21. `agent.py` `_trim_scratchpad` 多 system 消息超限

**位置**: `agent.py` 第720-726行

```python
@staticmethod
def _trim_scratchpad(pad: list, max_messages: int = 20) -> list:
    if len(pad) <= max_messages:
        return pad
    system_msgs = [m for m in pad if m.get("role") == "system"]
    other_msgs = [m for m in pad if m.get("role") != "system"]
    return system_msgs + other_msgs[-(max_messages - len(system_msgs)):]
```

**问题**:
- 如果 `len(system_msgs) > max_messages`（比如 agent 循环中 system prompt 被多次追加），`other_msgs[-(20-25):]` = `other_msgs[5:]`，结果是 `system_msgs + other_msgs[5:]`，总共超过 20 条。
- 而且 `other_msgs` 可能被截断为空，但 `system_msgs` 全部保留。

**修复建议**: 限制 `system_msgs` 数量（通常只保留第一条）。

---

### P2-22. `skill_router.py` 临时文件名冲突风险

**位置**: `skill_router.py` 第53行

```python
tmp_zip = os.path.join(skill_loader.workspace_dir, "tmp_upload", "import_skill_%s.zip" % str(id(file)))
```

**问题**:
- `id(file)` 返回对象内存地址，但如果 `file` 对象被 GC 回收后重新分配，新对象可能获得相同的 `id()`。
- 虽然概率极低，但理论上可能文件名冲突。

**修复建议**: 使用 `uuid.uuid4().hex` 或时间戳 + 随机数。

---

## 按文件分布

| 文件 | P0 | P1 | P2 |
|------|----|----|----|
| `server.py` | 3 | 4 | 3 |
| `models.py` | 2 | 3 | 2 |
| `skill_loader.py` | 1 | 0 | 1 |
| `cloud_provider.py` | 0 | 1 | 1 |
| `pet_notebook.py` | 0 | 1 | 0 |
| `feedback.py` | 0 | 1 | 0 |
| `training.py` | 0 | 1 | 0 |
| `agent.py` | 0 | 0 | 1 |
| `skill_router.py` | 0 | 0 | 1 |

---

*报告生成时间: 2026-05-17 02:00 GMT+8*
*审阅人: Code Review Agent*
*声明: 本报告为静态代码分析，重点关注稳定性与并发安全。P0-1 的死锁场景需要结合 NPU 驱动的实际行为验证。*
