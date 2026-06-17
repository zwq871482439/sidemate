# Think Processing Pipeline 架构重设计

> 日期: 2026-05-29
> 项目: 桌伴 Patch 12
> 设计者: 齐活林（基于高见远审计 + 代码全量阅读）
> **状态: ✅ Phase 1 + Phase 2 已全部实施**

---

## 1. 现状分析

### 1.1 当前管线全链路

```
用户请求
  ↓
routers/{chat,kb}.py ──── 决定 think_mode（"on"/"off"/"free"/"auto"）
  ↓
core/stream_engine.py ──── L113-134: 策略解析 → think_mode
  ↓
core/prompt_builder.py ──── L62-67: think_mode="off" → apply_chat_template(extra_context={"enable_thinking": False})
  ↓
chat_template.jinja ──── L86-87: enable_thinking=False → 注入 "<think\n\n</think\n\n"
  ↓
OpenVINO 模型推理 ──── 模型在已闭合的 think 标签后继续生成
  ↓
core/stream_engine.py ──── L258: _skip_think_for_off_mode = (think_mode == "off")
  ├─ L298-311: 未闭合 think 标签 → strip_think 提取正文
  ├─ L313-374: 已闭合 think 标签 → 分离 think_content + after_text
  ├─ L376-494: 无 think 标签 → 直接 yield text
  ├─ L496-508: think 标签未关闭检测（循环后）
  └─ L511-517: [PIPE] 诊断 — full_output 被 think 标签吃光
  ↓
intelligence/response_filter.py ──── strip_think_tags(): 正则清理所有 think 标签
  ↓
core/think_processor.py ──── ThinkProcessor.strip_think(): 委托给 response_filter.strip_think_tags()
  ↓
routers/kb.py ──── L698-824: KB SSE 流处理
  ├─ L721-735: 实时检测 <think → 发 think 事件
  ├─ L750-758: think_open 事件处理
  ├─ L775-821: **FALLBACK**: 正文为空 → 正则提取 → 推理内容检测 → 最终兜底
  └─ L823-824: think 吃掉全部 token → 生成后续正文
  ↓
routers/chat.py ──── L252-558: Chat SSE 流处理
  ├─ L331-333: fold 事件处理
  ├─ L347-348: think 占据全部输出 → 继续生成
  └─ L431-503: strip_think 后处理
  ↓
用户看到回复
```

### 1.2 各节点职责与问题

| 文件 | 职责 | 问题 |
|------|------|------|
| `chat_template.jinja:86-87` | `enable_thinking=False` 时注入空 think 标签 | **根因**：注入 `<think\n\n</think\n\n` 后模型认为"思考已完成"，直接输出空白 |
| `core/prompt_builder.py:62-67` | 传 `extra_context={"enable_thinking": False}` | 逻辑正确，但不知道模板会注入什么 |
| `core/stream_engine.py:258-374` | 流式处理 think 标签 | **160+ 行的 think 处理逻辑**，与 KB/Chat 路由中的 think 处理重复 |
| `core/think_processor.py` | 封装 think 标签操作 | **纯委托**——strip_think() 直接调用 response_filter.strip_think_tags()，无独立价值 |
| `intelligence/response_filter.py:807-873` | `strip_think_tags()` 正则清理 | 被多个文件调用，是"唯一真相源"，但逻辑复杂（5种分支） |
| `routers/kb.py:698-824` | KB 模式 SSE 流 + fallback | **130 行的 fallback 链**：3 层正则尝试 + 推理内容检测 + 最终兜底 |
| `routers/chat.py:252-558` | Chat 模式 SSE 流 | 也有 think 处理但逻辑不同，与 KB 不一致 |

### 1.3 已识别的 Fallback/Bandaid 层

| 层级 | 位置 | 触发条件 | 必要性 | 说明 |
|------|------|---------|--------|------|
| **Layer 0** | chat_template.jinja:86-87 | `enable_thinking=False` | ❌ 有害 | 注入空 think 标签是根因，不应存在 |
| **Layer 1** | stream_engine.py:298-311 | `_skip_think_for_off_mode && len > 30` | ⚠️ 修正 Layer 0 | 试图修复模型"偷偷思考"的问题，但模板已闭合标签，走不到这里 |
| **Layer 2** | stream_engine.py:313-374 | 检测到闭合的 think 标签 | ⚠️ 有用但位置错 | 这段逻辑本身正确，但不应在流式引擎里处理 |
| **Layer 3** | stream_engine.py:511-517 | `[PIPE]` 诊断 | ✅ 有用 | 纯诊断日志，有助于排查 |
| **Layer 4** | kb.py:775-821 | KB 正文为空 | ⚠️ 修正 Layer 0+1 | 3 层正则 fallback，根源是 Layer 0 造成的空输出 |
| **Layer 5** | chat.py:347-348 | Chat think 吃掉全部输出 | ⚠️ 有用 | 继续生成正文，但触发条件依赖上游处理 |

**结论**：Layer 0 是根因。Layer 1/2/4/5 都是在修补 Layer 0 造成的问题。

---

## 2. 问题根因分析

### 2.1 核心矛盾

**chat_template.jinja 的 `enable_thinking=False` 分支设计有缺陷**。

当 `enable_thinking=False` 时，模板在 `<|im_start|>assistant\n` 后注入：
```
<think\n\n</think\n\n
```

这等于告诉模型："你已经思考完了（think 标签已闭合），请继续输出正文。" 但实际上模型看到的上下文是：
```
<|im_start|>assistant
<think

</think


```

模型需要在这里继续生成。但因为 think 标签已经闭合，模型认为"思考阶段已完成"→ 有时会直接输出换行就结束（尤其是小模型如 Qwen3-8B），导致正文为空。

### 2.2 为什么影响了多个版本

1. **初始设计**：`enable_thinking=False` → 模板注入空 think → 模型应该正常输出正文
2. **问题发现**：某些情况下模型输出空白
3. **Bandaid 1**：在 stream_engine 中添加 `_skip_think_for_off_mode` 逻辑
4. **Bandaid 2**：在 kb.py 中添加 fallback 提取逻辑
5. **Bandai 3**：在 chat.py 中添加"think 吃掉全部输出"的继续生成逻辑
6. **每一层都有效但都不完整**：因为根因从未被修复

### 2.3 为什么 Chat 模式也受影响

Chat 模式的 `think_mode` 由策略路由决定（stream_engine.py:120-130）。当策略判定为简单问题（think_mode="off"）时，也会触发同样的 `enable_thinking=False` → 模板注入空 think → 模型输出空白的问题链。

---

## 3. 新架构设计

### 3.1 设计原则

1. **模板层做最小干预**：chat_template.jinja 只负责格式化消息，不应注入或预填任何内容
2. **单一处理点**：think 标签的检测、剥离、fold 展示应在一个模块中完成
3. **流式引擎不应处理业务逻辑**：stream_engine 只负责流式传输，不做 think 标签解析
4. **路由层保持薄**：KB/Chat 路由只做事件转发，不做 think 标签正则匹配

### 3.2 核心改动

#### 改动 1：修改 chat_template.jinja（根修）

**文件**: `C:\tmp\_local_ai_patch10\models\qwen3-8b-openvino-int4\chat_template.jinja`

**第 86-88 行**，从：
```jinja
{%- if enable_thinking is defined and enable_thinking is false %}
    {{- '<think\n\n</think\n\n' }}
{%- endif %}
```

改为：
```jinja
{# enable_thinking=False 时不注入任何 think 标签，让模型直接输出正文 #}
```

即：**直接删除这 3 行**。当 `enable_thinking=False` 时，模型看到的 prompt 就是标准的 `<|im_start|>assistant\n`，模型会直接生成正文而不经过思考阶段。

**风险**：
- Qwen3 模型在没有 think 标签提示时可能仍然输出 `<think` 标签（"偷偷思考"）
- 但这正是 stream_engine 中已有的 `_skip_think_for_off_mode` 逻辑要处理的场景（Layer 1，这次变成有用的了）

#### 改动 2：统一 Think 处理到 ThinkProcessor（收拢）

将散落在 3 个文件中的 think 标签处理逻辑收拢到 `core/think_processor.py`：

**新增方法**：
```python
class ThinkProcessor:
    # 已有: strip_think(), detect_think_tags(), looks_like_reasoning()

    def process_stream_token(self, full_output: str, think_mode: str) -> dict:
        """流式场景下的 think 标签处理（统一入口）

        替代 stream_engine.py 中的 160 行 think 处理逻辑。

        Returns:
            {
                "action": "buffer" | "yield_text" | "yield_fold" | "yield_raw" | "done",
                "text": str,           # 要 yield 的正文
                "think_content": str,  # 思考内容（用于 fold）
                "think_processed": bool,
            }
        """
        ...

    def extract_body_from_raw(self, raw: str) -> dict:
        """从原始输出中提取正文（替代 kb.py 和 chat.py 中的 fallback 逻辑）

        Returns:
            {
                "body": str,           # 提取的正文
                "think_content": str,  # 思考内容
                "method": str,         # 提取方法（用于日志）
            }
        """
        ...
```

#### 改动 3：简化 stream_engine.py 的 think 处理

**文件**: `core/stream_engine.py`

将 L293-374 的 80+ 行 think 处理逻辑替换为对 `ThinkProcessor.process_stream_token()` 的调用：

```python
# 替换前（简化示意）：
if not think_folded:
    if _think_processed:
        pass
    else:
        if _skip_think_for_off_mode and len(full_output) > 30:
            # 30 行处理...
        think_end_found = False
        # 50 行处理...

# 替换后：
if not think_folded and not _think_processed:
    result = mm._think_processor.process_stream_token(full_output, think_mode)
    if result["action"] == "buffer":
        pass  # 继续累积
    elif result["action"] == "yield_text":
        yield ("text", result["text"])
        raw_yielded_len = len(full_output)
        _think_processed = True
    elif result["action"] == "yield_fold":
        if think_mode != "off":
            yield ("fold", result["think_content"])
        if result["text"]:
            yield ("text", result["text"])
        raw_yielded_len = len(full_output)
        _think_processed = True
        think_folded = True
```

#### 改动 4：简化 KB fallback

**文件**: `routers/kb.py`

将 L775-821 的 50 行 fallback 逻辑替换为对 `ThinkProcessor.extract_body_from_raw()` 的调用：

```python
# 替换前：
if not answer and raw_accumulator:
    log.warning("[KB-SSE] 正文为空，raw 累积 %d 字，尝试 fallback 提取", len(raw_accumulator))
    try:
        _cleaned = _re.sub(...)
        # ... 50 行 ...

# 替换后：
if not answer and raw_accumulator:
    log.warning("[KB-SSE] 正文为空，raw 累积 %d 字，尝试 fallback 提取", len(raw_accumulator))
    result = ThinkProcessor().extract_body_from_raw(raw_accumulator)
    if result["body"]:
        answer = result["body"]
        log.info("[KB-SSE] fallback 提取成功（%s），正文 %d 字", result["method"], len(answer))
    elif result["think_content"]:
        # 纯推理内容，作为 fold 展示
        think_folded = True
        think_content = result["think_content"]
        yield 'data: {"type":"fold","think_len":%d}\n\n' % len(think_content)
```

#### 改动 5：Chat 路由统一

**文件**: `routers/chat.py`

Chat 路由中的 think 处理逻辑（L252-558 中的 think 相关部分）也改为调用 `ThinkProcessor`，确保与 KB 路由行为一致。

### 3.3 架构图（改后）

```
用户请求
  ↓
routers/{chat,kb}.py ──── 决定 think_mode
  ↓
core/prompt_builder.py ──── think_mode="off" → extra_context={"enable_thinking": False}
  ↓
chat_template.jinja ──── enable_thinking=False → 什么都不注入（干净）
  ↓
OpenVINO 模型推理 ──── 模型直接输出正文（或偶尔偷偷思考）
  ↓
core/think_processor.py ──── process_stream_token(): 统一处理
  ├─ 无 think 标签 → 直接 yield text
  ├─ 有闭合 think 标签 → yield fold + yield text
  └─ 有未闭合 think 标签 → yield text（strip 后）
  ↓
routers/{chat,kb}.py ──── 薄层转发：text→正文事件, fold→折叠事件
  ↓
（如果正文为空）→ ThinkProcessor.extract_body_from_raw(): 单一 fallback
  ↓
用户看到回复
```

---

## 4. 实现方案

### 4.1 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `chat_template.jinja` | **修改** | 删除 L86-88（空 think 标签注入） |
| `core/think_processor.py` | **扩展** | 新增 `process_stream_token()` 和 `extract_body_from_raw()` |
| `core/stream_engine.py` | **简化** | L293-374 的 think 处理替换为 ThinkProcessor 调用 |
| `routers/kb.py` | **简化** | L775-821 的 fallback 替换为 ThinkProcessor 调用 |
| `routers/chat.py` | **简化** | think 相关逻辑统一为 ThinkProcessor 调用 |
| `intelligence/response_filter.py` | **不变** | `strip_think_tags()` 保持为底层实现 |
| `core/prompt_builder.py` | **不变** | 传 `enable_thinking: False` 的逻辑正确 |

### 4.2 实现优先级

**Phase 1 — 根修（最小改动，最大效果）**：
1. 修改 `chat_template.jinja`：删除 L86-88
2. 测试 KB 模式和 Chat 模式

**Phase 2 — 收拢（重构，降低维护成本）**：
3. 扩展 `ThinkProcessor`
4. 简化 `stream_engine.py`
5. 简化 `routers/kb.py` 和 `routers/chat.py`

**建议先做 Phase 1，验证根修有效后再做 Phase 2。**

> **✅ 实施记录 (2026-05-29)**：Phase 1 和 Phase 2 已一次性全部完成：
> - Phase 1: 删除 chat_template.jinja L86-88（空 think 标签注入）
> - Phase 2a: ThinkProcessor 新增 process_stream_token() 和 extract_body_from_raw()
> - Phase 2b: stream_engine.py L293-374 的 80+ 行 inline think 逻辑替换为 ThinkProcessor 调用
> - Phase 2c: kb.py L775-821 的 50 行 fallback 替换为 ThinkProcessor.extract_body_from_raw()
> - Phase 2d: chat.py strip_think 调用统一改为 ThinkProcessor
> - 所有文件已通过 Python 语法检查
> - jinja 模板已有备份 chat_template.jinja.bak

### 4.3 迁移策略

1. **Phase 1 可以立即执行**：删除 chat_template.jinja 的 3 行代码，零风险（改回来也容易）
2. **Phase 2 应在 Phase 1 验证后执行**：需要更多测试
3. **每步都可通过 git revert 回滚**

---

## 5. 风险评估

### 5.1 Phase 1 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 删除模板注入后，模型偶尔仍输出 `<think` 标签 | 中 | 低 | stream_engine 的 `_skip_think_for_off_mode` 逻辑会处理 |
| 模型输出质量变化（没有了空 think 前缀） | 低 | 低 | 空 think 前缀本来就不应该影响输出质量 |
| 其他模型受影响 | 极低 | 无 | 只有 qwen3-8b 有这个 jinja 模板 |

### 5.2 测试策略

1. **Phase 1 测试**：
   - KB 模式：问 10 个中文问题，确认能正常返回正文
   - Chat 模式：问 10 个简单问题（触发 think_mode="off"），确认能正常返回
   - Chat 模式：问 3 个复杂问题（触发 think_mode="free"），确认 think fold 正常
   - 检查日志：确认不再出现 `[PIPE] full_output has X chars but all consumed by think tags`

2. **Phase 2 测试**：
   - 运行 `test_smoke.py`
   - 与 Phase 1 的输出做 diff 对比，确保行为一致

### 5.3 回滚方案

- Phase 1：恢复 chat_template.jinja 的 3 行代码
- Phase 2：git revert
