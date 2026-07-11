# 代码审阅报告 V2 — _local-ai v0.6.9

> 审阅日期: 2026-05-16
> 基准: 基于 V1 报告（41项）对比修复后的 v0.6.9 代码
> 规则: **只审阅，不修改**

---

## 修复确认

根据 SESSION_HANDOFF.md，30/41 项已修复。经重新审阅代码，确认以下关键修复确实到位：

| 原编号 | 级别 | 描述 | 状态 |
|--------|------|------|------|
| #1 | P0 | response_filter.py 缩进错误 | 已修复（v1.3） |
| #2 | P0 | context_compressor.py `% 2 == 2` → `% 2 == 0` | 已修复 |
| #3 | P0 | server.py re.search NoneType crash | 已修复（双重None检查） |
| #4 | P0 | fallback 模型ID "deepseek-1.5b" → "" | 已修复 |
| #6 | P1 | token计数从 len() 改为 tok.encode() | 已修复（第744-767行） |
| #7 | P1 | 截断循环效率 | 部分修复（精确计数，策略未变） |
| #8 | P1 | 跨天时间差计算 | 已修复（支持完整ISO时间戳） |
| #10 | P1 | ZIP导入一次性读入内存 | 已修复（1MB分块） |
| #11 | P1 | token_timestamps 只增不减 | 已修复（第1013-1016行窗口清理） |
| #12 | P1 | CORS 允许所有来源 | 已修复（环境变量控制） |
| #17 | P1 | NPU续写历史过长 | 已修复（NPU时清空history） |
| #19 | P2 | 城市正则范围过窄 | 已修复（`\u9fff`） |
| #22 | P2 | _CODE_BLOCK_RE 位置 | 已修复（模块顶部） |
| #28 | P2 | temperature上限 | 已修复（max(0.1, min(1.5, ...))） |
| #32 | P2 | think_folded后remaining重复 | 已修复（raw_yielded_len同步） |

---

## 新发现问题

### P0 严重（1项）

#### NEW-1. `models.py` `_stats` / `_stats_lock` 在 `__init__` 中**完全未初始化**（严重回归！）

```python
# models.py 第37-71行 (__init__ 方法)
def __init__(self):
    ...
    self._stop_generation = False
    self._stop_lock = threading.Lock()
    # TODO v0.7...
    self.notebook = None
    self._system_prompt_rules = None
    self._think_instruction_func = None
    # <-- _stats 和 _stats_lock 完全缺失！

# models.py 第82-98行 (_get_think_instruction 方法)
def _get_think_instruction(self, task_type):
    ...
    return self._think_instruction_func(task_type)
    self._stats = {           # <-- 在 return 之后，永远不会执行！
        "total_requests": 0,
        "total_llm_chars": 0,
        "total_llm_time": 0,
        "total_ocr_pages": 0,
        "total_ocr_time": 0,
    }
    self._stats_lock = threading.Lock()
```

**问题**: `_stats` 和 `_stats_lock` 被错误地放在了 `_get_think_instruction` 方法的 `return` 之后，这段代码**永远不会执行**。而 `__init__` 中完全没有初始化这两个属性。

**影响**: 任何触发统计更新的代码路径都会立即崩溃：
- 第837行: `with self._stats_lock:` → `AttributeError: 'ModelManager' object has no attribute '_stats_lock'`
- 第1275行: OCR统计同样会崩溃

这意味着：
1. 任何成功完成的 LLM 对话都会崩溃（在 `chat_stream` 末尾的统计更新）
2. 任何 OCR 操作都会崩溃
3. 如果异常处理不够完善，可能连带影响对话保存逻辑

**为什么测试可能没发现**: 如果 `test_live_5rounds.py` 在异常处理外检查响应，或者 `_stats_lock` 异常被外层 try/except 捕获后未导致测试失败，可能表面上"通过了"。

**修复建议**（必须在 `__init__` 中初始化）：
```python
def __init__(self):
    ...
    self._stop_generation = False
    self._stop_lock = threading.Lock()
    self._stats = {
        "total_requests": 0,
        "total_llm_chars": 0,
        "total_llm_time": 0,
        "total_ocr_pages": 0,
        "total_ocr_time": 0,
    }
    self._stats_lock = threading.Lock()
    ...
```

---

### P1 高优先级（5项）

#### NEW-2. `_stop_generation` 竞态条件：锁未实际使用

虽然 `models.py` 第65行声明了 `_stop_lock`，但：
- `stop_generation()` 方法（第394-397行）**没有加锁**
- `server.py` 第739行、第874行直接赋值 `mgr._stop_generation = False`，**没有加锁**
- `models.py` 第953行检查 `self._stop_generation`，**没有加锁**

在CPython中bool读写是原子的，但设计意图（通过 `_stop_lock` 保护）和实际实现不一致。

**修复建议**:
```python
def stop_generation(self):
    with self._stop_lock:
        self._stop_generation = True

# server.py 中
with mgr._stop_lock:
    mgr._stop_generation = False
```

---

#### NEW-3. `_build_prompt` 截断策略效率仍然低下

第751-767行：
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

**问题**: 每次只删一条消息就重新调用 `apply_chat_template`（一次tokenizer编码）。如果历史有15条，可能需要调用15次。`apply_chat_template` 是耗时操作（涉及tokenizer状态机）。

**影响**: 长历史+大模型的加载场景，截断过程可能增加数百毫秒延迟。

**修复建议**: 预计算每条历史消息的token数，一次性决定保留多少条，只调用一次 `apply_chat_template`。

---

#### NEW-4. `_is_output_incomplete` 规则6中 `rfind` 误匹配位置

`server.py` 第865行：
```python
after_match = stripped[stripped.rfind(m2.group()):]
```

**问题**: `rfind` 找的是 `m2.group()` 在 `stripped` 中的**最后一次出现**。如果用户消息中本身就包含"如下："等词语，`rfind` 可能找到错误的位置，导致后续 `re.findall(r'```.*?```', after_match)` 在错误区间搜索。

**影响**: 极低概率的误报/漏报（"输出不完整"的误判）。

**修复建议**: 使用 `m2.start()` 或 `m2.end()` 获取精确位置：
```python
after_match = stripped[m2.end():]
```

---

#### NEW-5. `_update_device_token_limit` 文件读写竞争

`models.py` 第615-626行：
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

**问题**: 如果两个请求几乎同时触发 overflow（比如并发对话），文件读写没有锁保护，可能导致 JSON 损坏。

**影响**: 并发场景下 `device_limits.json` 可能变成无效JSON，后续读取时 `json.load()` 抛出异常（被捕获后回退到默认值，不会崩溃，但缓存失效）。

**修复建议**: 增加文件锁或使用 `threading.Lock()` 保护。

---

#### NEW-6. 续写时 `body_history` 构建的语义问题

`server.py` 第930-935行：
```python
body_history = []
device = mgr._default_device
if device != "NPU" and model_history:
    body_history = list(model_history)
body_history.append({"role": "user", "content": prompt})
body_history.append({"role": "assistant", "content": "/no_think\n请直接给出最终回答，不要重复推理过程。"})
```

**问题**: 非NPU设备保留了完整历史，但assistant消息的内容是 `/no_think
请直接给出最终回答，不要重复推理过程。`。这告诉模型"上一个assistant回复是这句指令"，模型可能会困惑——为什么assistant在对自己说"不要重复推理过程"？

**影响**: 续写时模型可能产生偏离预期的输出（因为历史中的assistant消息语义不合理）。

**修复建议**: assistant消息应包含实际的think内容（或为空），然后在system prompt中注入 `/no_think` 指令，而不是在assistant消息中。

---

### P2 中等问题（5项）

#### NEW-7. `_detect_think_tags` 嵌套标签处理有漏洞

`models.py` 第249-272行：

```python
def _detect_think_tags(self, text):
    for start_marker, end_marker in self._THINK_TAG_MARKERS:
        start_idx = text.find(start_marker)
        ...
        end_idx = text.find(end_marker, content_start)
```

**问题**: 如果文本中有嵌套或多个 think 标签（如 `<think>外层<think>内层</think>外层结束</think>`），`text.find(end_marker, content_start)` 会找到第一个 `</think>`，即内层标签的结束标记，导致外层 think 内容被截断。

**影响**: 极低概率的 think 内容提取不完整（但Qwen3通常不会输出嵌套think标签）。

**修复建议**: 使用计数器匹配开闭标签，或限制只处理最外层标签对。

---

#### NEW-8. `_get_model_size` 默认返回8可能误判小模型

`models.py` 第633-635行：
```python
m = re.search(r'(\d+\.?\d*)\s*b', name_lower)
if not m:
    return 8  # 默认中等
```

**问题**: 如果用户导入的自定义模型名不包含数字+B的模式（如 "my-custom-model"），会错误地使用8B profile（6000字符历史、4096 token输出）。对于实际的小模型（<4B），这可能导致 context overflow。

**修复建议**: 尝试从 config.json 的 `num_hidden_layers` 和 `hidden_size` 估算参数量，或默认使用最小profile（0.5B）。

---

#### NEW-9. `cloud_provider.py` 默认值从空字符串改为有值后缺失

`cloud_provider.py` 第67-68行：
```python
"base_url": cloud.get("base_url", ""),
"model": cloud.get("model", ""),
```

**问题**: 之前默认值是 `"https://api.deepseek.com"` 和 `"deepseek-chat"`。现在改为空字符串。首次打开前端时，Base URL 和 Model 字段显示为空，用户不知道默认填什么。

**影响**: 用户体验下降（需要手动输入或查看文档）。

**修复建议**: 恢复默认值，或在 UI 中显示 placeholder 提示。

---

#### NEW-10. server.py 直接调用 models.py 内部方法 `_strip_think`

`server.py` 第1048行：
```python
final_response = mgr._strip_think(raw_text)
```

**问题**: `_strip_think` 以单下划线开头，是内部方法。server.py 作为外部模块直接调用，破坏了封装。

**影响**: 代码耦合度高，如果 `_strip_think` 的签名或行为改变，server.py 需要同步修改。

**修复建议**: 暴露公共方法 `strip_think`（或 `clean_think_tags`），server.py 调用公共方法。

---

#### NEW-11. `task_classifier.py` 子串提取效率低

第399-406行：
```python
for segment in _last_cn:
    for length in range(2, min(5, len(segment) + 1)):
        for start in range(len(segment) - length + 1):
            sub = segment[start:start + length]
            if not all(c in _CN_STOPWORDS for c in sub):
                _last_substrings.add(sub)
```

**问题**: 三重循环生成所有2-4字子串。对于100字的中文文本，约生成 100×3×50 = 15000 次子串操作。虽然现代CPU处理很快，但设计上有优化空间。

**影响**: 微性能问题，在长对话中漂移检测可能增加几十毫秒延迟。

**修复建议**: 使用 `collections.deque` 做滑动窗口，或限制 `segment` 长度。

---

### 建议（3项）

#### NEW-12. `_build_prompt` 截断策略建议优化

当前每次删一条消息就重新调用 `apply_chat_template`。建议改为：
1. 预计算每条消息的字符数（已经有了 `history_chars`）
2. 二分法找到保留的最老消息索引
3. 只调用一次 `apply_chat_template`

#### NEW-13. `device_limits.json` 缓存策略建议文档化

当前"只降不升"的策略（第609-610行）是合理的设计，但建议增加注释说明：
- 为什么只降不升（避免瞬间可用导致错误恢复）
- 如何手动重置缓存（删除 device_limits.json）
- 不同NPU型号的预期差异

#### NEW-14. 建议增加 `_stats` 初始化的单元测试

`test_live_5rounds.py` 应该增加断言验证 `_stats` 在对话后有正确增量，确保统计逻辑不会因初始化问题而静默失败。

---

## 按文件分布

| 文件 | P0 | P1 | P2 | 建议 |
|------|----|----|----|------|
| `models.py` | 1 | 3 | 2 | 2 |
| `server.py` | 0 | 2 | 1 | 0 |
| `cloud_provider.py` | 0 | 0 | 1 | 0 |
| `task_classifier.py` | 0 | 0 | 1 | 0 |

---

## 修复优先级建议

1. **立即**: NEW-1（`_stats` / `_stats_lock` 未初始化）— 这是运行时崩溃的回归Bug
2. **今天**: NEW-2（`_stop_generation` 锁未使用）、NEW-4（`rfind` 误匹配）
3. **本周**: NEW-3（截断效率）、NEW-5（文件竞争）、NEW-6（续写语义）
4. **下次迭代**: NEW-7~14（中等问题和建议）

---

*报告生成时间: 2026-05-16 02:39 GMT+8*
*基准: CODE_REVIEW_REPORT.md (V1, 41项)*
*声明: 本报告为增量审计，重点检查修复后的回归和新发现的问题*
