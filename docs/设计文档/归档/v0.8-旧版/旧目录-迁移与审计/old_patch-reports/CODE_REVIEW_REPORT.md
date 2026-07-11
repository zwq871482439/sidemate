# 代码审阅报告 — _local-ai v0.6.5

> 审阅日期: 2026-05-16
> 审阅范围: server.py, models.py, task_classifier.py, cloud_provider.py, response_filter.py, context_compressor.py, pet_notebook.py, env_check.py, prompts.py, distill.py, settings.json, notebook.json
> 规则: **只审阅，不修改**

---

## 总览

| 级别 | 数量 | 说明 |
|------|------|------|
| P0 (严重) | 5 | 会导致崩溃、功能完全失效或数据安全问题 |
| P1 (高) | 14 | 会导致功能异常、性能问题或安全漏洞 |
| P2 (中) | 14 | 代码质量、可维护性、潜在隐患 |
| 建议 | 8 | 改进建议，非缺陷 |

**整体评价**: 项目架构清晰，三层记忆设计（Session→Cache→Notebook）合理，NPU适配和Pipe恢复策略体现了工程经验。但存在**3个确定的运行时Bug**（P0级），需要立即修复；另有若干架构层面的设计债务（P1级），建议在v0.7前处理。

---

## P0 严重问题（必须立即修复）

### 1. `response_filter.py:121` — 缩进错误导致运行时异常

```python
# 第119-124行
        if issues:
            # 最多报告 5 条，避免刷屏
        shown = issues[:_MAX_REPORT_ITEMS]
        if len(issues) > _MAX_REPORT_ITEMS:
            shown.append(f"  - ... 还有 {len(issues)-_MAX_REPORT_ITEMS} 处")
            warnings.append(f"代码块 #{i+1} 疑似幻觉:\n" + "\n".join(shown))
```

**问题**: `if issues:` 块内只有注释，后续代码缩进层级混乱。`shown = ...` 与 `if issues:` 同级，但 `warnings.append` 缩进在第二个 `if` 内。**实际运行时会报 IndentationError**（除非文件中有不可见字符掩盖了问题）。

**影响**: `response_filter.py` 模块无法导入，导致 server.py 第1003行的过滤器静默跳过（`except ImportError: pass`），所有过滤功能失效。

**修复建议**:
```python
        if issues:
            shown = issues[:_MAX_REPORT_ITEMS]
            if len(issues) > _MAX_REPORT_ITEMS:
                shown.append(f"  - ... 还有 {len(issues)-_MAX_REPORT_ITEMS} 处")
            warnings.append(f"代码块 #{i+1} 疑似幻觉:\n" + "\n".join(shown))
```

---

### 2. `context_compressor.py:156` — 条件永远为False，注释剥离逻辑完全失效

```python
# 第152-161行
    single_count = line.count("'") - line.count("\\'")
    double_count = line.count('"') - line.count('\\"')

    if single_count % 2 == 0 and double_count % 2 == 2:  # <-- BUG
```

**问题**: `double_count % 2 == 2` 永远不可能为真（任何整数对2取模只能是0或1）。这意味着 `"安全找 #"` 分支永远不会执行，`_strip_trailing_comment` 函数实际上**从不剥离任何行尾注释**。

**影响**: 代码压缩时保留大量注释，增加上下文长度。虽然功能不崩溃，但违背了压缩器的设计目标。

**修复建议**:
```python
    if single_count % 2 == 0 and double_count % 2 == 0:
```

---

### 3. `server.py:850` — 正则匹配结果可能为None时调用 `.group()`

```python
# 第846-852行
        for pattern in trailing_patterns:
            if re.search(pattern + r'\s*(```)?\s*$', stripped):
                after_match = stripped[stripped.rfind(re.search(pattern, stripped).group()):]
                code_in_tail = re.findall(r'```.*?```', after_match, re.DOTALL)
```

**问题**: 第849行已确认 `re.search(pattern, stripped)` 匹配成功，但第850行重新调用 `re.search(pattern, stripped).group()`。**如果正则引擎内部状态变化或输入变化，第二次 search 可能返回 None**（虽然概率低，但在多线程或特殊字符情况下可能发生）。

**影响**: `AttributeError: 'NoneType' object has no attribute 'group'`

**修复建议**:
```python
        for pattern in trailing_patterns:
            m = re.search(pattern + r'\s*(```)?\s*$', stripped)
            if m:
                m2 = re.search(pattern, stripped)
                if m2:
                    after_match = stripped[stripped.rfind(m2.group()):]
                    code_in_tail = re.findall(r'```.*?```', after_match, re.DOTALL)
```

---

### 4. `models.py:363` — fallback模型ID不存在

```python
# 第363行
        return "deepseek-1.5b"  # 兜底，基本不会走到
```

**问题**: `_get_default_llm()` 在没有扫描到任何LLM时返回 `"deepseek-1.5b"`。该模型ID既不在 `_KNOWN_MODELS` 中，也不会出现在 `model_configs` 中（因为扫描逻辑只识别本地目录）。

**影响**: 如果 `models/` 目录为空或扫描失败，后续 `mgr.load("deepseek-1.5b")` 会报 `"未知模型"`，但错误信息不够清晰。

**修复建议**:
```python
        return "none"  # 或返回 None，让调用方明确处理无模型的情况
```

---

### 5. `settings.json` — API Key 明文存储

```json
{
  "cloud": {
    "api_key": "42f7411f0e2f4f0aa58b81cd23fb5b8d.izWFJywrIxGI1zhG",
    ...
  }
}
```

**问题**: API Key 以明文形式存储在 JSON 文件中，没有加密或权限保护。

**影响**: 文件被复制/泄露时，云端API密钥直接暴露。

**修复建议**:
- 使用 `keyring` 库或 Windows Credential Manager / macOS Keychain 存储密钥
- 或者至少对密钥做简单的 base64 编码 + 环境变量盐值
- 文件系统层面设置 `chmod 600`（类Unix）或限制 Windows ACL

---

## P1 高优先级问题（功能/性能/安全）

### 6. `models.py:710` — Prompt Token 计数使用字符数而非 Token 数

```python
# 第710行
            prompt_len = len(prompt) if isinstance(prompt, list) else len(prompt)
```

**问题**: `apply_chat_template` 返回字符串时，`len(prompt)` 是**字符数**，不是 token 数。1个汉字 ≈ 1-1.5 token，英文单词可能 1 token ≈ 4-5 字符。拿字符数去和 `max_prompt_tokens`（token上限）比较，**会导致NPU/GPU上的截断判断严重不准确**。

**影响**: NPU模式下上限仅1840 token，但按字符数计算可能让实际token数远超1840，导致context overflow仍然发生。

**修复建议**:
```python
            if isinstance(prompt, list):
                prompt_len = len(prompt)
            else:
                # 用 tokenizer 编码获取真实 token 数
                prompt_len = len(tok.encode(prompt))
```

---

### 7. `models.py:710-728` — Token 截断循环效率低下且逻辑有漏洞

```python
# 第714-724行
                while prompt_len > max_prompt_tokens and len(messages) > 2:
                    for i in range(len(messages)):
                        if messages[i].get("role") in ("user", "assistant") and i < len(messages) - 1:
                            removed = messages.pop(i)
                            ...
                            break
                    else:
                        break
```

**问题**:
- 每次只删一条消息，然后重新调用 `apply_chat_template`（耗时操作）
- `for i in range(len(messages))` 每次都从最早的message开始扫描，但早期的system message或context_cache不会被删除（因为条件要求 `role in ("user", "assistant")`），**如果只有1条user+1条assistant，循环会无限break**
- 如果messages中有2条system（context_cache+notebook+think_instr），`len(messages) > 2` 为真但找不到可删的，进入 `else: break`

**影响**: 截断逻辑可能在某些边界情况下失效，导致仍然overflow。

**修复建议**:
- 改为二分法截断：直接计算所有历史消息的长度，一次性决定保留多少条
- 或者使用tokenizer的 `encode` + `decode` 进行精确截断

---

### 8. `task_classifier.py:458-462` — 跨天时间差计算错误

```python
# 第458-462行
            last_time = datetime.strptime(last_msg["ts"], "%H:%M:%S")
            now_time = datetime.strptime(datetime.now().strftime("%H:%M:%S"), "%H:%M:%S")
            gap = (now_time - last_time).total_seconds()
            if gap < 0:
                gap += 86400  # 跨天
```

**问题**: 只比较时间（HH:MM:SS），日期信息完全丢失。如果用户周一23:00发消息，周二01:00发消息，计算结果 gap = 2小时（而不是26小时）。虽然 `gap += 86400` 处理了跨天（负数→+24h），但**跨多天无法处理**（比如周五→下周一）。

**影响**: Session膨胀检测（B3策略）在跨天场景下不准确。

**修复建议**:
- 在消息中存储完整时间戳（含日期），如 `"ts": "2026-05-16 02:05:01"`
- 或使用 `datetime.fromisoformat` 解析完整时间

---

### 9. `models.py:620-661` — `_build_prompt` 中每次对话都动态导入模块

```python
# 第647行
            from prompts import SYSTEM_PROMPT_RULES
# 第666行
                    from task_classifier import get_think_instruction
```

**问题**: `from prompts import SYSTEM_PROMPT_RULES` 在 `_build_prompt` 函数内部每次调用都执行。虽然Python的import机制会缓存模块，但函数级import仍有开销（查找sys.modules）。

**影响**: 每次对话都有不必要的import开销，虽然很小。

**修复建议**:
- 在模块顶部统一导入，或作为类属性缓存

---

### 10. `server.py:560-565` — 模型ZIP导入一次性读取到内存

```python
# 第560-565行
            with open(tmp_zip, "wb") as f:
                content = file.file.read()
                f.write(content)
                total_size = len(content)
```

**问题**: `file.file.read()` 一次性读取整个上传文件到内存。如果用户上传 `qwen3-14b.zip`（9GB），会占用9GB内存。

**影响**: 大模型导入时可能导致OOM（尤其是小内存设备）。

**修复建议**:
```python
            CHUNK_SIZE = 1024 * 1024  # 1MB
            with open(tmp_zip, "wb") as f:
                total_size = 0
                while True:
                    chunk = file.file.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    f.write(chunk)
                    total_size += len(chunk)
```

---

### 11. `models.py:942-970` — `token_timestamps` 列表只增不减

```python
# 第942行
            token_timestamps = []  # [(time, token_text), ...]
# 第967行
                token_timestamps.append((now, token))
# 第970行
                if len(token_timestamps) % 10 == 0 and self._check_stall(token_timestamps, now, model_name=model):
```

**问题**: `_check_stall` 只取最后30个token（`_STALL_CHECK_TOKENS = 30`），但 `token_timestamps` 列表在整个生成过程中**持续追加从不清理**。长输出（4096 tokens）会产生4000+个元组。

**影响**: 内存占用随输出长度线性增长，虽然单个元组很小（~50字节），但极端情况下可能浪费~200KB。

**修复建议**:
```python
            # 只保留最近 N+M 个token的时间戳
            MAX_TS_KEEP = self._STALL_CHECK_TOKENS + self._REPEAT_WINDOW + 10
            token_timestamps.append((now, token))
            if len(token_timestamps) > MAX_TS_KEEP:
                token_timestamps = token_timestamps[-MAX_TS_KEEP:]
```

---

### 12. `server.py:42` — CORS 允许所有来源

```python
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
```

**问题**: 生产环境中允许任意来源访问API，存在CSRF和凭证泄露风险。

**影响**: 如果服务暴露在内网或公网，恶意网站可直接调用本地AI服务的API。

**修复建议**:
```python
origins = os.environ.get("LOCAL_AI_CORS", "http://localhost:8976,http://127.0.0.1:8976").split(",")
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_methods=["*"], allow_headers=["*"])
```

---

### 13. `models.py:858` / `server.py:725` — `_stop_generation` 竞态条件

```python
# server.py:725
    mgr._stop_generation = False
# server.py:858 (sse_gen内部)
        mgr._stop_generation = False
```

**问题**: `_stop_generation` 是单例 `ModelManager` 的共享状态。如果用户同时发起两个对话请求（比如两个浏览器标签页），A请求点击"停止"会将 `_stop_generation = True`，这会**同时中断B请求的生成**。

**影响**: 多并发场景下，停止按钮会误伤其他对话。

**修复建议**:
- 使用请求级别的中断标志（如UUID映射的dict），而非单例标志
- 或在 `chat_stream` 参数中传入独立的 `stop_event`

---

### 14. `models.py:534` — 访问OpenVINO GenAI内部私有属性

```python
# 第533-534行
        try:
            limit = getattr(pipe, 'm_max_prompt_len', None)
```

**问题**: `m_max_prompt_len` 是 OpenVINO GenAI `LLMPipeline` 的内部属性（下划线前缀是C++绑定暴露的属性），**不同版本可能不存在或命名变化**。

**影响**: OpenVINO GenAI升级后可能直接AttributeError。

**修复建议**:
- 捕获 `AttributeError` 单独处理
- 增加版本兼容性注释
- 或改用官方API（如果有）探测token上限

---

### 15. `models.py:25-35` — 单例模式线程安全问题

```python
# 第25-35行
class ModelManager:
    _instance = None
    _lock = threading.Lock()

    def __new__(cls):
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._initialized = False
            return cls._instance
```

**问题**: `__new__` 使用类锁是正确的，但 `cls._instance = super().__new__(cls)` 创建实例时**没有初始化**。真正的初始化在 `__init__` 中。如果两个线程同时调用 `ModelManager()`，第一个线程释放锁后，第二个线程拿到 `_instance`（`_initialized=True`），返回已初始化实例。这个逻辑是正确的。

但问题在**子类化**: 如果有人继承 `ModelManager`，`_instance` 是类属性，子类和父类共享同一个实例。

**影响**: 当前无直接影响，但属于设计债务。

---

### 16. `server.py:702` — `api_chat` 非流式接口返回裸Dict

```python
# 第701-713行
@app.post("/api/chat")
async def api_chat(request: Request):
    ...
    return mgr.chat(...)  # 返回 dict
```

**问题**: `mgr.chat()` 返回Python dict，FastAPI会自动序列化为JSON，但如果dict中包含非序列化对象（如datetime），会报错。

**影响**: 潜在的类型不一致问题。

**修复建议**:
```python
    return JSONResponse(mgr.chat(...))
```

---

### 17. `models.py:917` — 续写时构建的history可能过长

```python
# 第915-917行
            body_history = list(model_history or [])
            body_history.append({"role": "user", "content": prompt})
            body_history.append({"role": "assistant", "content": "/no_think\n请直接给出最终回答，不要重复推理过程。"})
```

**问题**: 续写时把原始prompt和assistant回复都append到history中，但没有检查总长度。NPU模式下这些额外内容可能超出1840 token上限。

**影响**: NPU续写时可能再次overflow。

**修复建议**:
- 续写时清空history或只保留system message

---

### 18. `server.py:1041` — 空回复时发送error事件但后续仍发送done

```python
# 第1040-1043行
            yield 'data: {"type": "error", "content": "模型未产生响应..."}\n\n'

        yield 'data: {"type": "done", "model": "%s", ...}\n\n' % (...)
        yield 'data: [DONE]\n\n'
```

**问题**: 空回复时先发送error再发送done。前端需要处理error+done的组合事件，可能产生UI闪烁。

**影响**: 用户体验问题。

**修复建议**:
- error后直接return，不发done；或把error信息包含在done中

---

### 19. `pet_notebook.py:298` — 城市正则范围过窄

```python
# 第298行
            r"我在([\u4e00-\u9fa5]{2,6}?)(?:[，。,.!\s市省]|生活|工作|居住|$)",
```

**问题**: `\u9fa5` 只到 U+9FA5，但CJK统一表意文字扩展A/B/C/D/E/F/G有大量汉字超出此范围（如 U+9FA6~U+9FFF 的字符）。虽然城市名不太可能用到这些字，但正则范围不够准确。

**影响**: 极低概率的漏匹配。

**修复建议**:
```python
            r"我在([\u4e00-\u9fff]{2,6}?)(?:[，。,.!\s市省]|生活|工作|居住|$)",
```

---

## P2 中等问题（代码质量/可维护性）

### 20. `server.py:18` 与 `SESSION_HANDOFF.md` 版本不一致

```python
# server.py 第17-18行
VERSION = "0.6"
VERSION_PATCH = 7     # <-- 这里
```

**问题**: `SESSION_HANDOFF.md` 说当前版本是 v0.6.5，但代码里 `VERSION_PATCH = 7`。

**影响**: 版本号混乱，不利于问题追溯。

---

### 21. `models.py:5` 与 `SESSION_HANDOFF.md` 版本不一致

```python
# models.py 第5行
__version__ = "v1.3"
```

**问题**: `SESSION_HANDOFF.md` 说 models.py 是 v1.2，但代码里是 v1.3。

---

### 22. `task_classifier.py:263` — 变量在函数使用后定义

```python
# 第201-245行 (classify_task函数)
# ... 使用了 _CODE_BLOCK_RE ...

# 第263行
_CODE_BLOCK_RE = re.compile(r'```')
```

**问题**: Python允许函数内引用模块级变量（因为函数定义时不会求值），但这不符合代码规范，阅读者可能误以为 `_CODE_BLOCK_RE` 未定义。

**修复建议**: 移到文件顶部（所有正则定义之后）。

---

### 23. `server.py:859` — 未使用变量 `client_disconnected`

```python
# 第859行
        client_disconnected = False
```

**问题**: 声明了但从未读取或赋值。

**修复建议**: 删除。

---

### 24. `models.py:475` — `_stats` dict 非线程安全

```python
# 第67-73行
        self._stats = {
            "total_requests": 0,
            ...
        }
```

**问题**: 多线程并发修改 `_stats` 时可能丢失计数。

**修复建议**: 使用 `threading.Lock()` 保护，或使用 `collections.Counter`。

---

### 25. `cloud_provider.py` 使用 `urllib` 而非 `requests`

**问题**: `env_check.py` 检测到 `requests` 可用，但 `cloud_provider.py` 使用低级的 `urllib`。`urllib` 的SSE流解析更复杂，且错误处理不如 `requests` 完善。

**修复建议**: 统一使用 `requests`（如果已依赖）。

---

### 26. `models.py:249` — `_looks_like_reasoning` 只检查前200字符

```python
# 第269行
        text_lower = text[:200]  # 只看前 200 字
```

**问题**: 如果dangling think标签后的推理内容前200字没有匹配到信号词（如先输出空行或废话），会被误判为正文。

---

### 27. `server.py:1026` — `think` 字段保存到历史

```python
# 第1024-1027行
                    {"role": "assistant", "content": final_response, "ts": time.strftime("%H:%M:%S"),
                     "think": think_content if think_folded else "", "model": model_choice,
                     "chars": response_chars, ...}
```

**问题**: think内容（可能很长，1500+字符）被保存到历史JSON中，增加历史文件大小。

**建议**: 可选是否保存think内容，或设置think最大保存长度。

---

### 28. `models.py:898` — temperature调整后可能超出合理范围

```python
# 第898行
        adjusted_temp = max(0.1, profile["temperature"] + temp_offset)
```

**问题**: 只做了下限限制（min 0.1），没有上限。如果 `temp_offset` 为正（如reasoning的0.0），没问题；但如果未来添加了正的temp_offset，可能超过1.0。

**修复建议**:
```python
        adjusted_temp = max(0.1, min(1.5, profile["temperature"] + temp_offset))
```

---

### 29. `env_check.py:35` — subprocess重复导入

```python
# 第24行
            import subprocess
# 第35行
            import subprocess
```

**问题**: `subprocess` 在 `_detect_hardware` 函数内导入了两次（Windows分支和Linux/macOS分支）。虽然Python会缓存，但属于代码冗余。

---

### 30. `server.py:189` — `split_idx` 赋值逻辑可读性差

```python
# 第181-189行
    for i in range(len(messages) - 1, -1, -1):
        msg_chars = len(messages[i].get("content", ""))
        if running_chars + msg_chars > keep_chars:
            split_idx = i + 1
            break
        running_chars += msg_chars
        split_idx = i
```

**问题**: `split_idx = i` 在每次循环都执行（不仅是else分支），虽然逻辑正确，但可读性差。

---

### 31. `server.py:1019` — error检测过于激进

```python
# 第1019行
            is_error_response = final_response.strip().startswith("[ERROR]") or "[ERROR]" in final_response.strip()[:20]
```

**问题**: 如果模型正常回复中恰好包含 `[ERROR]` 字样（如在解释错误处理时），会被误判为错误回复而不保存。

**修复建议**: 增加更严格的判断，如检查是否以 `[ERROR]` 开头。

---

### 32. `models.py:1017` — think_folded后remaining正文输出重复

```python
# 第1170-1174行
                remaining = full_output[raw_yielded_len:]
                if remaining:
                    total_chars += len(remaining)
                    yield ("text", remaining)
```

**问题**: 在 `_detect_think_tags` 分支中（第1124-1129行）已经yield了 `after`，这里又yield了 `remaining`。如果 `after` 和 `remaining` 有重叠，可能重复发送内容。

**影响**: 可能导致前端显示重复文本。

---

### 33. `server.py:1017` — 保存的`final_response`可能包含think标签

```python
# 第1016行
        final_response = response_text or raw_text
```

**问题**: 如果模型没有正确折叠think标签（`think_folded=False`），`response_text` 为空，fallback到 `raw_text`，而 `raw_text` 包含完整的 `<think>...</think>` 标签。

**影响**: 历史记录中保存了未剥离think标签的原始文本。

---

## 建议（非缺陷）

### 34. 增加单元测试覆盖率

当前只有 `test_live_5rounds.py`（集成测试）和 `test_classifier_v3.py`（分类器测试）。建议为以下模块增加单元测试：
- `context_compressor._strip_trailing_comment`（尤其那个 `% 2 == 2` 的bug）
- `response_filter.filter_response`
- `models._build_prompt` 的截断逻辑
- `pet_notebook.extract_and_update`

### 35. 添加类型提示

核心模块（`models.py`, `server.py`）已有部分类型提示，但 `response_filter.py` 和 `context_compressor.py` 可以补充更多 `-> list[str]`、`-> bool` 等提示。

### 36. 使用 `pydantic` 校验API输入

FastAPI原生支持Pydantic模型，当前使用 `await request.json()` 手动解析，可以改为：
```python
class ChatRequest(BaseModel):
    message: str
    model: str | None = None
    max_tokens: int | None = None
```

### 37. 日志分级

当前大量使用 `log.info` 输出调试信息，建议：
- 常规操作（加载/卸载模型）用 `log.info`
- 详细的token级信息用 `log.debug`
- 添加环境变量控制日志级别 `LOG_LEVEL=debug`

### 38. 文档化NPU限制

`models.py` 中NPU的1800 token限制是硬编码的经验值，建议在代码注释中增加：
- 该数值的来源（Ultra 7 155H + INT4实测）
- 不同NPU型号的预期差异
- 如何重新探测的说明

### 39. 配置文件校验

`settings.json` 没有schema校验，建议增加：
```python
def validate_settings(data: dict) -> list[str]:
    errors = []
    if "cloud" in data:
        if not data["cloud"].get("api_key"):
            errors.append("cloud.api_key为空")
        ...
    return errors
```

### 40. 增加健康检查端点

建议增加 `/api/health` 端点：
```python
@app.get("/api/health")
def api_health():
    return {
        "status": "ok",
        "model_loaded": bool(mgr.get_loaded_llms()),
        "device": mgr._default_device,
        "uptime": time.time() - START_TIME,
    }
```

### 41. 前端 `index.html` 未审阅

由于时间关系，本次审阅未覆盖 `index.html`（75KB单文件前端）。建议单独安排前端代码审阅，重点检查：
- XSS防护（SSE消息直接插入DOM是否做了转义）
- 大文件上传的进度条和取消逻辑
- 本地存储（localStorage）的敏感数据处理

---

## 附录：按文件的问题分布

| 文件 | P0 | P1 | P2 |
|------|----|----|----|
| `response_filter.py` | 1 | 0 | 0 |
| `context_compressor.py` | 1 | 0 | 0 |
| `server.py` | 1 | 7 | 6 |
| `models.py` | 1 | 6 | 5 |
| `settings.json` | 1 | 0 | 0 |
| `task_classifier.py` | 0 | 1 | 1 |
| `pet_notebook.py` | 0 | 1 | 1 |
| `cloud_provider.py` | 0 | 0 | 1 |

---

## 修复跟踪

> 以下标记由 Session 016/017 逐步更新

| # | 状态 | Session |
|---|------|---------|
| #1 | FIXED (Session 015) | 缩进错误已修复 |
| #2 | FIXED (Session 016) | `% 2 == 2` → `% 2 == 0` |
| #3 | FIXED (Session 016) | re.search NoneType → 双重检查 |
| #4 | FIXED (Session 016) | fallback "" |
| #5 | FIXED (Session 017) | API Key XOR 混淆 |
| #6 | FIXED (Session 016) | tok.encode() 精确计数 |
| #7 | FIXED (Session 016) | 截断 tok.encode() |
| #8 | FIXED (Session 016) | 跨天时间差 |
| #9 | FIXED (Session 016) | 缓存实例属性 |
| #10 | FIXED (Session 016) | 分块写入 |
| #11 | FIXED (Session 016) | token_timestamps 清理 |
| #12 | FIXED (Session 016) | CORS 环境变量 |
| #13 | FIXED (Session 016) | _stop_lock |
| #14 | FIXED (Session 016) | 兼容性注释 |
| #15 | WON'T FIX | 无子类化场景 |
| #16 | FIXED (Session 016) | JSONResponse |
| #17 | FIXED (Session 016) | NPU 续写优化 |
| #18 | FIXED (Session 016) | 空 reply 直接 return |
| #19 | FIXED (Session 016) | 城市正则范围 |
| #20 | FIXED (Session 015) | 版本号同步 |
| #21 | FIXED (Session 015) | 版本号同步 |
| #22 | FIXED (Session 016) | 正则移到顶部 |
| #23 | FIXED (Session 016) | 删除未用变量 |
| #24 | FIXED (Session 016) | _stats_lock |
| #25 | FIXED (Session 017) | urllib → requests |
| #26 | FIXED (Session 016) | 检查范围 500 |
| #27 | FIXED (Session 016) | think 长度限制 |
| #28 | FIXED (Session 016) | temperature 上限 |
| #29 | FIXED (Session 016) | import 合并 |
| #30 | FIXED (Session 016) | split_idx 注释 |
| #31 | FIXED (Session 016) | error 检测 |
| #32 | FIXED (Session 016) | remaining strip |
| #33 | FIXED (Session 016) | _strip_think |
| #34 | FIXED (Session 017) | 幻觉检测单元测试 |
| #35 | FIXED (Session 017) | 类型提示补充 |
| #36 | FIXED (Session 017) | Pydantic 校验 |
| #37 | FIXED (Session 017) | 日志分级 |
| #38 | FIXED (Session 017) | NPU 限制文档化 |
| #39 | FIXED (Session 017) | settings schema 校验 |
| #40 | FIXED (Session 017) | /api/health 端点 |
| #41 | WON'T FIX | 前端审阅不需要 |
| `env_check.py` | 0 | 0 | 1 |

---

*报告生成时间: 2026-05-16 02:05 GMT+8*
*审阅人: Code Review Agent*
*声明: 本报告仅包含静态代码分析发现的问题，未执行动态测试。部分问题可能在实际运行中被框架或异常处理掩盖。*
