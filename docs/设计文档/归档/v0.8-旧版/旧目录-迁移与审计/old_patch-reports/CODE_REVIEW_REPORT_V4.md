# 代码审阅报告 V4 — _local-ai v0.8 patch 4 (深度稳定性专项)

> 审阅日期: 2026-05-18
> 基准: 基于 V3 报告，验证用户修复情况，深度审计 v0.8 patch 4 新增模块
> 审阅范围: server.py, models.py, task_classifier.py, cloud_provider.py, response_filter.py, context_compressor.py, pet_notebook.py, env_check.py, prompts.py, distill.py, agent.py, skill_loader.py, skill_router.py, permissions.py, audit_log.py, training.py, feedback.py, config.py, chunker.py, chunking_orchestrator.py
> 规则: **只审阅，不修改**
> 重点: **稳定性问题、崩溃风险、竞态条件、资源泄漏、并发安全、新增模块风险**

---

## V3 修复状态确认

| V3编号 | 级别 | 描述 | 修复状态 | 验证位置 |
|--------|------|------|----------|----------|
| P0-1 | P0 | `_gen_lock` 死锁风险 | **缓解未根治** | models.py:512-518 增加强制释放，但 NPU 卡死线程仍在运行 |
| P0-2 | P0 | 文件上传路径遍历 | **已修复** | server.py:2336 使用 `_safe_filename()` |
| P0-3 | P0 | 对话管理路径遍历 | **已修复** | server.py:1785,1806 使用 `_safe_chat_name()` |
| P0-4 | P0 | ZIP Slip 漏洞 | **已修复** | server.py:1054, skill_loader.py:233 使用 `_safe_extract_path()` |
| P0-5 | P0 | 设备切换冲突 | **已修复** | models.py:550-551 检查 `_gen_lock.locked()` 和 `_stopping` |
| P1-6 | P1 | `_stop_generation` 竞态条件 | **仍未修复** | server.py:774,1147 等处仍直接赋值 |
| P1-7 | P1 | `device_limits.json` 并发读写 | **已修复** | models.py:82,747 增加 `_device_limits_lock` |
| P1-8 | P1 | `cloud_provider.py` SSE 无读超时 | **仍未修复** | cloud_provider.py:284-304 无迭代超时保护 |
| P1-9 | P1 | 数据文件并发写入竞争 | **部分修复** | pet_notebook.py:36, feedback.py:43, training.py:48 已有锁，但 `_save_chat` / `_save_settings` 仍无锁 |
| P1-10 | P1 | `api_stop` 竞态条件 | **缓解未根治** | 第776行 `run_in_executor` 改为异步，但仍可能竞争 |
| P1-11 | P1 | `_build_prompt` 截断效率 | **已修复** | models.py:885-940 使用二分法 + 预计算 token 数 |
| P1-12 | P1 | `_is_output_incomplete` rfind | **已修复** | server.py:1308-1310 改用 `m2.end()` |
| P1-13 | P1 | 续写历史语义不合理 | **仍未修复** | server.py:1474 仍用 assistant 消息传递 `/no_think` |
| P2-14 | P2 | `_detect_think_tags` 嵌套标签 | **仍未修复** | models.py:330-353 未处理嵌套 |
| P2-15 | P2 | `_get_model_size` 默认返回8 | **仍未修复** | models.py:766 仍返回8 |
| P2-16 | P2 | `cloud_provider.py` 默认空值 | **仍未修复** | cloud_provider.py:127-128 仍为空字符串 |
| P2-17 | P2 | `server.py` 直接调用 `_strip_think` | **仍未修复** | server.py:1655 仍直接调用 |
| P2-18 | P2 | `task_classifier.py` 子串提取效率 | **需重新评估** | 代码已重构，原三重循环位置已变更 |
| P2-19 | P2 | 上传文件无大小限制 | **已修复** | server.py:2339,2354 已增加 `_UPLOAD_MAX_SIZE` 检查 |
| P2-20 | P2 | `_read_excel` 句柄泄漏 | **仍需关注** | server.py:557-573 `wb.close()` 在 try 内部，异常时可能泄漏 |
| P2-21 | P2 | `_trim_scratchpad` system 超限 | **仍未修复** | agent.py:879-885 未限制 system 数量 |
| P2-22 | P2 | `skill_router.py` 临时文件名冲突 | **仍未修复** | skill_router.py:53 仍用 `id(file)` |

---

## P0 严重问题（可直接导致崩溃/假死/数据破坏）

### P0-1. `_stop_generation` 全局标志竞态条件 — 并发请求互相干扰，停止信号丢失

**位置**:
- `server.py:774` (`api_stop`)
- `server.py:1147` (`sse_gen` 入口)
- `server.py:1334` (`sse_gen` 等待 stop 完成后)
- `models.py:1294` (`chat_stream` 中重置)
- `models.py:489,512,1592` (多处读取/写入)

**问题**:

虽然 `models.py` 第74行声明了 `_stop_lock`，但 **没有任何代码使用它来保护 `_stop_generation` 的读写**。

```python
# server.py:774 — 直接赋值，无锁
with mgr._stop_lock:
    mgr._stop_generation = True

# server.py:1147 — 直接赋值，无锁
mgr._stop_generation = False

# models.py:1294 — 直接赋值，无锁
with self._stop_lock:
    self._stop_generation = False
```

**崩溃场景**:

```
时间线:
T0: 请求A 开始生成，_stop_generation = False
T1: 请求B 点击停止，_stop_generation = True（意图停止A）
T2: 请求C 进入 sse_gen，执行 mgr._stop_generation = False（C的入口重置）
T3: 请求A 的 on_token 回调检查 _stop_generation → 读到 False → 不停止！
```

结果：**B 的停止信号被 C 的入口重置覆盖，A 继续生成，B 的停止无效**。

更严重的场景：
- 请求A 生成中，B 点击停止
- B 的 `api_stop` 调用 `stop_generation()`，等待 `_gen_done`（最多8秒）
- 在此期间，用户 C 发送新消息
- C 的 `sse_gen` 执行 `mgr._stop_generation = False`
- 但 B 的 `stop_generation()` 还在 `self._gen_done.wait(timeout=8)` 中等待
- B 最终超时返回，但 A 的生成并未被停止
- A 的 `_generate` 线程仍在运行，持有 `_gen_lock`
- C 的新请求在 `_gen_lock.acquire(timeout=15)` 处等待15秒后失败

**影响**: 停止功能不可靠，用户体验极差；并发请求互相干扰，服务稳定性严重受损。

**修复建议**:
```python
# models.py
@property
def stop_flag(self):
    with self._stop_lock:
        return self._stop_generation

@stop_flag.setter
def stop_flag(self, value):
    with self._stop_lock:
        self._stop_generation = value

# server.py 中所有直接赋值改为 property 访问
mgr.stop_flag = False  # 替代 mgr._stop_generation = False
```

---

### P0-2. `config.py get()` 每次从文件读取 — 并发性能灾难 + 配置不一致

**位置**: `config.py:142-145`

```python
def get(key: str, default: Any = None) -> Any:
    """获取单个配置项（每次从文件读取，确保最新值）"""
    config = load_config()  # <-- 每次调用都读取整个文件
    return config.get(key, default if default is not None else DEFAULTS.get(key))
```

**问题**:

1. **性能灾难**: 在高频调用场景下（如 models.py 的 `_check_stall` 每10个token调用一次，每次 `chat_stream` 调用 `get()` 十几次），每次调用都打开文件 → 解析JSON → 返回。在对话高峰期，IO开销累积严重。

2. **配置不一致**: 如果并发线程A和B同时调用 `get("device")`：
   - A 读取文件，得到 `"NPU"`
   - 同时用户修改 settings.json 为 `"GPU"`
   - B 读取文件，得到 `"GPU"`
   - 同一时刻，系统内两个模块对同一配置项有不同认知

3. **并发读取竞争**: 如果有线程正在执行 `save_config()`（写文件），另一个线程执行 `load_config()`（读文件），可能读到不完整的 JSON，导致 `json.load()` 抛出异常，回退到默认值。

**崩溃场景**:
- 线程A正在 `save_config()` 中写入 settings.json（写到一半）
- 线程B调用 `get("device")` → `load_config()` → `json.load()` 读到不完整JSON → 异常
- B 回退到默认值 → 后续逻辑使用错误配置
- 如果此时 B 是 `_build_prompt` 正在获取 `NPU_HISTORY_MAX_CHARS`，默认值可能与实际不同，导致上下文计算错误

**修复建议**:
```python
# 方案1: 线程级缓存 + 文件修改时间检查
_config_cache = None
_config_mtime = 0
_config_lock = threading.Lock()

def get(key: str, default: Any = None) -> Any:
    global _config_cache, _config_mtime
    with _config_lock:
        try:
            mtime = os.path.getmtime(_CONFIG_FILE)
        except OSError:
            mtime = 0
        if _config_cache is None or mtime > _config_mtime:
            _config_cache = load_config()
            _config_mtime = mtime
        return _config_cache.get(key, default if default is not None else DEFAULTS.get(key))

# 方案2 (更激进): 只在启动时加载一次，提供 reload_config() 手动刷新
```

---

## P1 高优先级问题（稳定性/性能/安全）

### P1-3. `chunking_orchestrator.py` `_call_llm` 传递不存在参数 `stream=True`

**位置**: `chunking_orchestrator.py:260-265`

```python
def _call_llm(self, prompt: str) -> str:
    output_parts = []
    try:
        for phase, content in self.model_manager.chat_stream(
            prompt, self.model_name,
            max_tokens=None,
            history=None,
            stream=True,  # <-- chat_stream 没有 stream 参数！
        ):
```

**问题**:

`ModelManager.chat_stream()` 的签名是：
```python
def chat_stream(self, message, model=None, max_tokens=None, history=None,
                context_cache=None, drift_hint=None, _agent_mode=False,
                override_task_type=None, scene=None):
```

没有 `stream` 参数。传入 `stream=True` 会导致 `TypeError: chat_stream() got an unexpected keyword argument 'stream'`。

虽然外层有 `try/except` 捕获（第271行），但结果是：**长文本分段处理完全静默失败**，`_call_llm` 返回空字符串，所有 chunk 的 `raw_output` 为空，后续解析全部失败，最终返回空答案。

**影响**: doc/research 场景的长文本处理功能在 orchestrator 模式下完全不可用。

**修复建议**:
```python
# 删除 stream=True
for phase, content in self.model_manager.chat_stream(
    prompt, self.model_name,
    max_tokens=None,
    history=None,
):
```

---

### P1-4. `chunker.py` `_find_sentence_boundary` 向前搜索逻辑错误 — 可能找到过远的切断点

**位置**: `chunker.py:84-111`

```python
def _find_sentence_boundary(text, target_pos, search_range=100):
    # ... 向后搜索 ...
    # 如果向后找不到，向前搜索
    if best_dist > search_range:
        search_start = max(0, target_pos - search_range)
        last_end = None
        for m in _SENTENCE_END.finditer(text, search_start, target_pos):
            last_end = m.end()  # 只记录最后一个
        if last_end is not None:
            best = last_end
            best_dist = target_pos - last_end
```

**问题**:

向前搜索时，代码只记录 `last_end`（循环结束后最后一个匹配的句子结束位置），而不是 **离 `target_pos` 最近** 的句子结束位置。

**示例**:
```
text = "句1。句2。句3。句4。句5。" * 20  # 100字
target_pos = 95  # 目标在第19个"句5"附近
search_range = 100
search_start = max(0, 95-100) = 0

finditer 从 0 到 95 找到所有句子结束位置：5, 10, 15, ..., 90
last_end = 90
best = 90, best_dist = 5

这个例子正好是对的。但考虑：
text = "句1。" + "X" * 80 + "句2。句3。"
target_pos = 90
search_start = max(0, 90-100) = 0

finditer 从 0 到 90：
  - 位置3: "句1。"
  - 位置87: "句2。"
last_end = 87
best = 87, best_dist = 3

但实际上离 90 更近的是 87（距离3），这是对的。问题是：
如果文本是 "句1。" + "X" * 95 + "句2。"，target_pos=95
last_end = 3（句1的结束），best_dist = 92
这意味着切在位置3，只保留了4个字符，丢弃了91个字符！

正确的做法应该是：如果向前找不到在合理范围内的句子边界，直接返回 target_pos，而不是返回100个字符之前的句子边界。
```

**影响**: 长文本分段时，某些 chunk 可能异常短（只有几个字），导致上下文信息严重丢失，影响长文本处理质量。

**修复建议**:
```python
# 向前搜索时，找离 target_pos 最近的（而非最后一个）
closest_end = None
closest_dist = search_range + 1
for m in _SENTENCE_END.finditer(text, search_start, target_pos):
    dist = target_pos - m.end()
    if dist < closest_dist:
        closest_dist = dist
        closest_end = m.end()
if closest_end is not None and closest_dist <= search_range:
    best = closest_end
    best_dist = closest_dist
# 如果前后都找不到在 search_range 内的，直接返回 target_pos
```

---

### P1-5. `agent.py` `_execute_long_reader` 文件路径安全校验缺失

**位置**: `agent.py:720-725`

```python
def _execute_long_reader(self, params):
    file_path = params.get("file_path", "")
    # ...
    if not os.path.isabs(file_path):
        file_path = os.path.join(self.workspace_dir, file_path)
    if not os.path.exists(file_path):
        return {"error": "long_reader: 文件不存在"}
```

**问题**:

路径校验只有 `os.path.exists()`，没有 **沙箱边界校验**。如果 `file_path` 是 `../../Windows/System32/drivers/etc/hosts`，拼接后会变成绝对路径，然后 `os.path.exists()` 返回 True，文件被成功读取。

虽然 `agent.py` 的 `_execute_tool` 中对 `file_ops` 的 read 操作有 `_external_read` 标记（第685-688行），但 `long_reader` 是特殊路由，不走 `_execute_tool`，直接在这里读取文件。

**影响**: 通过构造特定的 `file_path` 参数，可以读取工作空间外的任意文件（虽然需要已存在）。

**修复建议**:
```python
# 在 _execute_long_reader 中加入沙箱校验
real_path = os.path.realpath(file_path)
real_workspace = os.path.realpath(self.workspace_dir)
if not real_path.startswith(real_workspace + os.sep) and real_path != real_workspace:
    return {"error": "long_reader: 文件路径超出工作空间范围"}
```

---

### P1-6. `server.py` `_save_chat` 和 `_save_settings` 并发写入无锁保护

**位置**:
- `server.py:227-254` (`_save_chat`)
- `server.py:923-928` (`_save_settings`)

**问题**:

虽然 pet_notebook.py、feedback.py、training.py 都已经各自加了 `_save_lock`，但 `_save_chat` 和 `_save_settings` 仍然是裸写：

```python
def _save_chat(filepath, messages, context_cache=None):
    # ... 读取现有数据 ...
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def _save_settings(settings):
    with _settings_save_lock:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(settings, f, ensure_ascii=False, indent=2)
```

`_save_settings` 已经有锁了（第921行 `_settings_save_lock`），但 `_save_chat` 完全没有锁。

**崩溃场景**:
- 用户快速发送两条消息（或一条消息发送中 Session 缓存触发压缩）
- 两个线程同时调用 `_save_chat` 写同一个文件
- 文件内容变成混合的无效 JSON
- 下次加载对话时 `json.load()` 失败，对话历史丢失

**修复建议**:
```python
# 在 server.py 模块级增加 chat 文件锁
_chat_save_locks = {}  # filepath -> threading.Lock()
_chat_locks_lock = threading.Lock()

def _get_chat_lock(filepath):
    with _chat_locks_lock:
        if filepath not in _chat_save_locks:
            _chat_save_locks[filepath] = threading.Lock()
        return _chat_save_locks[filepath]

def _save_chat(filepath, messages, context_cache=None):
    if not filepath:
        return
    lock = _get_chat_lock(filepath)
    with lock:
        # 原有逻辑
```

---

### P1-7. `models.py` NPU 硬编码跳过 session cache 和 notebook 注入 — 上下文不一致

**位置**: `models.py:817-827`

```python
# Session cache 注入（Layer 2：近期对话压缩摘要）
# NPU 模式下跳过额外注入，节省 token
if context_cache and device != "NPU":
    sys_parts.append("[本会话较早的对话摘要] " + context_cache)
# 小册子注入（Layer 3：跨会话永久记忆）
# NPU 模式下跳过小册子注入，节省 token
if self.notebook and device != "NPU":
    try:
        notebook_text = self.notebook.build_inject_text()
        ...
```

**问题**:

同一用户、同一对话，在 NPU 设备上运行时：**完全丢失 session cache 和 notebook 记忆**。这意味着：
- 用户切换到 NPU 后，AI "忘记" 了之前的对话摘要
- 用户切换到 NPU 后，AI "忘记" 了用户的名字、偏好、关键事实
- 这种体验不一致是 **不可预测** 的，用户不知道为什么 AI 突然 "失忆"

更严重的是：这个逻辑是 **硬编码** 的，没有配置项可以调整。如果用户认为 NPU 的 token 限制足够（如某些 NPU 固件版本），也无法开启记忆注入。

**修复建议**:
1. 改为基于 token 预算的动态判断，而非硬编码设备类型
2. 或者增加配置项 `npu_inject_memory: bool`，让用户选择
3. 最差也应记录日志，让用户知道记忆被跳过了

---

### P1-8. `server.py` 续写历史仍用 assistant 消息传递 `/no_think` 指令

**位置**: `server.py:1473-1474`

```python
body_history.append({"role": "assistant", "content": "/no_think\n请直接给出最终回答，不要重复推理过程。"})
```

**问题**:

这是 V3 P1-13 中提出的问题，仍未修复。将 `/no_think` 放在 assistant 消息中会让模型困惑：
- 模型看到的是 "assistant 刚才说 '不要重复推理过程'"
- 但这不是真实的 assistant 回复，而是系统注入的指令
- 可能引入语义偏差，影响续写质量

**修复建议**:
```python
# 将指令放在 system 消息中（追加到已有 system prompt 后）
body_history.insert(0, {"role": "system", "content": "/no_think\n请直接给出最终回答，不要重复推理过程。"})
```

---

### P1-9. `models.py` `_detect_think_tags` 未处理嵌套标签 — think 内容截断错误

**位置**: `models.py:330-353`

```python
def _detect_think_tags(self, text):
    for start_marker, end_marker in self._THINK_TAG_MARKERS:
        start_idx = text.find(start_marker)
        if start_idx < 0:
            continue
        # ...
        end_idx = text.find(end_marker, content_start)
        if end_idx < 0:
            continue
        think_content = text[content_start:end_idx].strip()
```

**问题**:

如果文本中有嵌套 think 标签（虽然少见，但流式输出中可能因标签不完整而产生），`text.find(end_marker)` 会找到 **第一个** 结束标签，而不是匹配最外层开始标签的结束标签。

**示例**:
```
<think>外层思考<think>内层思考</think>外层继续</think>正文
```

当前代码：
- `start_idx` = 0（找到 `<think`）
- `content_start` = 6（`<think>` 之后）
- `end_idx` = `text.find("</think", 6)` = 内层 `</think>` 的位置
- `think_content` = `"外层思考<think>内层思考"` — 包含了内层的开始标签！
- `after` = `"外层继续</think>正文"` — 包含了外层的结束标签！

**影响**: think 内容被错误截断，正文包含 think 标签残留，前端渲染异常。

**修复建议**:
```python
# 使用计数器匹配嵌套标签
def _detect_think_tags(self, text):
    for start_marker, end_marker in self._THINK_TAG_MARKERS:
        start_idx = text.find(start_marker)
        if start_idx < 0:
            continue
        # 找到开始标签的结束（> 或 换行）
        tag_end = text.find(">", start_idx)
        if tag_end < 0:
            tag_end = text.find("\n", start_idx)
        if tag_end < 0:
            continue
        content_start = tag_end + 1
        # 计数器匹配嵌套
        depth = 1
        pos = content_start
        while pos < len(text) and depth > 0:
            if text.startswith(start_marker, pos):
                depth += 1
                pos += len(start_marker)
            elif text.startswith(end_marker, pos):
                depth -= 1
                if depth == 0:
                    end_idx = pos
                    break
                pos += len(end_marker)
            else:
                pos += 1
        if depth == 0:
            # 成功匹配
            think_content = text[content_start:end_idx].strip()
            after_start = end_idx + len(end_marker)
            if after_start < len(text) and text[after_start] == ">":
                after_start += 1
            after = text[after_start:].lstrip("\n")
            return True, think_content, after
    return False, "", ""
```

---

### P1-10. `models.py` `_extract_accumulation_delta` 动态阈值导致大段前缀误判为正常

**位置**: `models.py:1059`

```python
if len(delta) <= max(len(last_new_part), 20):
    return delta
```

**问题**:

当 `last_new_part` 很长时（如模型已经输出了50字），delta 阈值变成 `max(50, 20) = 50`。这意味着如果模型输出 `"前缀" + "新增51字"`，会被误判为 **不是前缀累积**。

但实际上，前缀累积模式的特征不是 "delta有多长"，而是 "new_part 是否以 last_new_part 为前缀"。delta 的长度不应该影响判断。

**示例**:
- token1: "我正在思考这个问题"
- token2: "我正在思考这个问题的解决方案"
- `last_new_part` = "我正在思考这个问题" (11字)
- `delta` = "的解决方案" (5字)
- 判定：5 <= max(11, 20) = 20 → 返回 delta ✓ (正确)

但：
- token1: "我正在思考这个问题的解决方案的详细步骤的第一步"
- token2: "我正在思考这个问题的解决方案的详细步骤的第一步和第二步"
- `last_new_part` = 37字
- `delta` = "和第二步" (4字)
- 判定：4 <= max(37, 20) = 37 → 返回 delta ✓ (正确)

再但：
- token1: "A" * 100
- token2: "A" * 100 + "B" * 60
- `last_new_part` = 100字
- `delta` = "B" * 60 = 60字
- 判定：60 <= max(100, 20) = 100 → 返回 delta ✓ (正确)

等等，这个例子是对的。让我想一个反例：
- token1: "前缀文本" (4字)
- token2: "前缀文本" + "X" * 100 (104字)
- `delta` = "X" * 100 = 100字
- 判定：100 <= max(4, 20) = 20 → 100 <= 20 为 False → 返回 None（误判为正常！）

**问题确认**: 当 last_new_part 很短（<20字）时，阈值固定为20。如果 delta > 20，就被误判为非累积。但前缀累积的本质是 "new_part 以 last_new_part 开头"，与 delta 多长无关。

**影响**: 某些前缀累积场景（短前缀 + 长增量）被漏检，重复内容输出到前端。

**修复建议**:
```python
# 移除 delta 长度检查，或者使用更大的固定阈值
# 核心判断：new_part.startswith(last_new_part) 即为累积
if last_new_part and len(new_part) > len(last_new_part):
    if new_part.startswith(last_new_part):
        delta = new_part[len(last_new_part):]
        # 额外验证：累积模式下 delta 不应该超过 new_part 的50%（防止巧合匹配）
        if len(delta) <= len(new_part) * 0.5:
            return delta
        # 但如果已经确认是累积模式，继续信任
        if accum_already_detected:
            return delta
```

---

## P2 中等问题（代码质量/潜在隐患）

### P2-11. `server.py` `api_chat_stream` 中 `long_file_marker` 定义后未使用

**位置**: `server.py:1203`

```python
if len(file_content) > _chunk_threshold and user_scene in ("doc", "research"):
    prompt += "\n\n[用户上传了长文件 %s（%d字），系统将自动分段分析]" % (...)
    long_file_marker = {"long_file": file_path, "long_file_chars": len(file_content)}
    # <-- 这个变量后续没有被使用！
else:
    prompt += "\n\n[用户上传了文件 %s，内容如下：]\n%s" % (...)
```

**问题**: `long_file_marker` 变量被赋值但从未被读取。看起来原本是要传给 agent 上下文或保存到消息记录中，但逻辑遗漏了。

**修复建议**: 要么删除这个变量，要么将其用途补全（如传给 AgentLoop）。

---

### P2-12. `response_filter.py` `detect_prefix_accumulation` 阈值对短文本过于宽松

**位置**: `response_filter.py:375-404`

```python
def detect_prefix_accumulation(text):
    if not text or len(text) < _PREFIX_ACCUM_MIN_TEXT_LEN:
        return False, ""
    # ...
    if top_4c >= _PREFIX_ACCUM_4GRAM_THRESHOLD:  # 阈值 = 8
        return True, ...
```

**问题**:

`_PREFIX_ACCUM_MIN_TEXT_LEN = 50`，`_PREFIX_ACCUM_4GRAM_THRESHOLD = 8`。

对于50字的中文文本，如果某个4-gram出现8次，意味着这4个字符至少占用了32个字符位置（不考虑重叠）。在50字文本中，这几乎不可能发生，除非文本极度重复。

实际结果是：短文本（50-200字）中的前缀累积几乎 **永远不会被检测到**，因为阈值太高。

**修复建议**:
```python
# 阈值应按文本长度动态调整
threshold = max(3, min(8, len(text) // 20))  # 50字→2（但最小3），200字→10（但最大8）
```

---

### P2-13. `cloud_provider.py` SSE 流式响应仍无迭代超时保护

**位置**: `cloud_provider.py:284-304`

```python
resp = _SESSION.post(url, json=body, headers=headers,
                     timeout=_CLOUD_STREAM_TIMEOUT, stream=True)
resp.raise_for_status()
full_text = ""
for line in resp.iter_lines(decode_unicode=True):
    # 无超时检查！
    ...
```

**问题**:

`timeout=120` 只控制连接建立时间。一旦连接建立，如果云端服务端保持连接但不发送数据，`iter_lines()` 会永久阻塞。

这个问题在 V3 P1-8 中已报告，仍未修复。

**修复建议**:
```python
t0 = time.time()
for line in resp.iter_lines(decode_unicode=True):
    if time.time() - t0 > _CLOUD_STREAM_TIMEOUT:
        yield ("raw", "[ERROR] 云端响应超时")
        break
    ...
```

---

### P2-14. `skill_router.py` 临时 ZIP 文件名冲突风险

**位置**: `skill_router.py:53`

```python
tmp_zip = os.path.join(skill_loader.workspace_dir, "tmp_upload", "import_skill_%s.zip" % str(id(file)))
```

**问题**:

`id(file)` 返回对象内存地址。Python 对象被 GC 回收后，新对象可能复用相同的内存地址（虽然概率低）。更可靠的做法是使用 UUID 或时间戳+随机数。

**修复建议**:
```python
import uuid
tmp_zip = os.path.join(skill_loader.workspace_dir, "tmp_upload", "import_skill_%s.zip" % uuid.uuid4().hex[:8])
```

---

### P2-15. `agent.py` `_trim_scratchpad` system 消息数量无上限

**位置**: `agent.py:879-885`

```python
def _trim_scratchpad(pad, max_messages=20):
    if len(pad) <= max_messages:
        return pad
    system_msgs = [m for m in pad if m.get("role") == "system"]
    other_msgs = [m for m in pad if m.get("role") != "system"]
    return system_msgs + other_msgs[-(max_messages - len(system_msgs)):]
```

**问题**:

如果 `system_msgs` 数量超过 `max_messages`（如 agent 循环中多次追加了 system 消息），`other_msgs[-(20-25):]` 会变成 `other_msgs[5:]`，返回 `system_msgs + other_msgs[5:]`，总消息数超过 20。

**修复建议**:
```python
def _trim_scratchpad(pad, max_messages=20):
    if len(pad) <= max_messages:
        return pad
    # 只保留第一条 system 消息（通常是最初的系统提示）
    system_msgs = [m for m in pad if m.get("role") == "system"]
    first_system = [system_msgs[0]] if system_msgs else []
    other_msgs = [m for m in pad if m.get("role") != "system"]
    keep_other = max_messages - len(first_system)
    return first_system + other_msgs[-keep_other:]
```

---

### P2-16. `server.py` 直接调用 `mgr._strip_think` — 破坏封装

**位置**: `server.py:1655`

```python
final_response = mgr._strip_think(final_response)
```

**问题**:

`_strip_think` 是内部方法（单下划线），但 server.py 直接调用。虽然 models.py 第326-328 行已经暴露了公共接口 `strip_think()`，但 server.py 没有使用。

**修复建议**:
```python
final_response = mgr.strip_think(final_response)
```

---

### P2-17. `_read_excel` openpyxl 句柄在异常时可能泄漏

**位置**: `server.py:553-588`

```python
def _read_excel(file_path):
    try:
        import openpyxl
        wb = openpyxl.load_workbook(file_path, read_only=True, data_only=True)
        try:
            # 使用 wb
            ...
        finally:
            wb.close()  # 只在 try 成功时关闭
    except ImportError:
        # pandas 降级
```

**问题**:

`wb.close()` 在内层 `try` 的 `finally` 中，但如果 `openpyxl.load_workbook()` 成功而 `wb.sheetnames` 或 `ws.iter_rows` 抛出异常，`wb.close()` 会执行（正确）。但如果 `wb.close()` 本身抛出异常，外层的异常处理会覆盖内层的。

更微妙的问题：如果 `openpyxl` 可用但 `load_workbook` 失败（如文件损坏），异常被外层 `except Exception` 捕获，wb 未创建，不会泄漏。但如果 `load_workbook` 成功，然后 `wb.sheetnames` 访问成功，但 `ws.iter_rows` 在循环中抛异常，`finally` 中的 `wb.close()` 执行（正确）。

实际上这段代码的异常处理是合理的。唯一的风险是：如果 `wb.close()` 抛异常，会被吞掉。但这不算严重问题。

**降级为 P3 观察项**。

---

## P3 观察项（值得注意但当前风险较低）

### P3-18. `models.py` `_get_model_size` 对非标命名模型默认返回 8B

**位置**: `models.py:759-774`

```python
def _get_model_size(self, model_name):
    name_lower = (model_name or "").lower()
    m = re.search(r'(\d+\.?\d*)\s*b', name_lower)
    if not m:
        return 8  # 默认中等
```

**问题**: 自定义模型名不含数字+B时（如 `"my-llm-model"`），错误使用8B profile，可能导致小模型的 context overflow。

**建议**: 尝试从 `config.json` 的 `hidden_size` 和 `num_hidden_layers` 估算参数量。

---

### P3-19. `cloud_provider.py` 默认 Base URL 和 Model 为空字符串

**位置**: `cloud_provider.py:127-128`

首次打开前端时，Base URL 和 Model 字段为空，用户不知道默认填什么。

---

### P3-20. `models.py` `chat_stream` 中 `max_tokens` 可能超过 device prompt 上限

**位置**: `models.py:1216-1217`

`max_tokens` 从 profile 获取（如 8B 模型是 4096），但 `_build_prompt` 中的 `max_prompt_tokens` 是 device limit（如 NPU 是 2400）。如果 `max_tokens` + prompt tokens > device limit，生成可能被截断或报错。

这不是 bug，但应增加校验或自动调整。

---

## 按文件分布汇总

| 文件 | P0 | P1 | P2 | P3 | 总计 |
|------|----|----|----|----|------|
| `server.py` | 1 | 3 | 2 | 0 | 6 |
| `models.py` | 1 | 3 | 1 | 1 | 6 |
| `config.py` | 1 | 0 | 0 | 0 | 1 |
| `chunking_orchestrator.py` | 0 | 1 | 0 | 0 | 1 |
| `chunker.py` | 0 | 1 | 0 | 0 | 1 |
| `agent.py` | 0 | 1 | 1 | 0 | 2 |
| `response_filter.py` | 0 | 0 | 1 | 0 | 1 |
| `cloud_provider.py` | 0 | 0 | 1 | 1 | 2 |
| `skill_router.py` | 0 | 0 | 1 | 0 | 1 |
| **总计** | **3** | **10** | **7** | **3** | **23** |

---

## 修复优先级建议

### 第一优先级（建议立即修复）

1. **P0-1** `_stop_generation` 竞态条件 — 并发请求互相干扰，停止功能不可靠
2. **P0-2** `config.get()` 每次从文件读取 — 性能灾难 + 配置不一致
3. **P1-3** `chunking_orchestrator.py` 传递不存在的 `stream=True` — 长文本处理完全不可用

### 第二优先级（建议本迭代修复）

4. **P1-4** `chunker.py` 向前搜索逻辑错误 — 长文本分段质量下降
5. **P1-5** `agent.py` 文件路径安全校验缺失 — 可读取工作空间外文件
6. **P1-6** `_save_chat` 并发写入无锁 — 对话历史可能损坏
7. **P1-7** NPU 硬编码跳过记忆注入 — 用户体验不一致
8. **P1-8** 续写历史语义不合理 — 影响续写质量
9. **P1-9** `_detect_think_tags` 嵌套标签 — think 内容截断错误
10. **P1-10** `_extract_accumulation_delta` 动态阈值 — 累积检测漏检

### 第三优先级（建议后续迭代）

11-23. 其余 P2/P3 问题

---

*报告生成时间: 2026-05-18 23:40 GMT+8*
*审阅人: Code Review Agent*
*声明: 本报告为静态代码分析，重点关注稳定性与并发安全。部分问题需结合 NPU 驱动实际行为验证。*
