# 桌伴 (Sidemate) Prompt 体系架构 V2

> 版本：2.0 | 目标模型：Qwen3.5-4B Q5_K_M GGUF | 运行环境：Ollama v0.17.6+

---

## 一、设计总览

### 1.1 核心变更

| 问题 | V1 现状 | V2 方案 |
|------|---------|---------|
| 短输入幻觉 | 规则 9 一句话约束 | 三重防御：首字约束 + 重复惩罚 + 后处理兜底 |
| System Prompt 太弱 | 9 条规则平铺 | 三层分层：身份层 / 规则层 / 场景增强层 |
| 策略增强太笼统 | 每种策略一句话 | 每种策略 2-4 条具体指令 + 温度/采样参数 |
| think_mode 不可靠 | `think: false` 参数 | 用户消息末尾追加 `/no_think` + 后处理 strip |
| 总长度无控制 | 未限制 | 核心身份+通用规则 ≤ 400 字，场景增强 ≤ 100 字 |

### 1.2 架构图

```
用户输入
  │
  ▼
┌─────────────┐
│  Action 路由  │  chat / kb / doc
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  策略分类器   │  9 种策略
└──────┬──────┘
       │
       ▼
┌─────────────────────────────────┐
│        System Prompt 构建器       │
│                                 │
│  ┌───────────┐  核心身份层（固定）  │
│  │  IDENTITY  │  ~50 字           │
│  └─────┬─────┘                   │
│  ┌─────┴─────┐  通用规则层（固定）  │
│  │   RULES    │  ~200 字          │
│  └─────┬─────┘                   │
│  ┌─────┴─────┐  场景增强层（动态）  │
│  │  ENHANCE   │  ~80 字           │
│  └───────────┘                   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│        用户消息后处理              │
│  think_mode=off → 追加 /no_think │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│        Ollama 请求               │
│  messages + sampler overrides   │
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│        回复后处理                 │
│  strip think标签 + 首字修正      │
└─────────────────────────────────┘
```

---

## 二、分层 System Prompt 完整内容

### 2.1 第一层：核心身份（IDENTITY）

> 固定不变，所有 Action 共享。

```
你是「桌伴」，本地AI办公助手。你运行在用户电脑上，通过对话界面与用户交流。
```

**设计理由**：
- 明确身份、部署方式、交互方式
- 50 字以内，不浪费 token
- 不说"你是基于xxx的"——4B 模型会因此产生无关续写

### 2.2 第二层：通用规则（RULES）

> 固定不变，所有 Action 共享。共 8 条，约 200 字。

```
必须遵守：
1. 用中文回答。代码中变量名可用英文。
2. 直接回答，不重复问题，不说"好的""当然"。
3. 回答完就停。不问"需要进一步了解吗"。
4. 不确定就说不确定，不编造信息。
5. 禁止以逗号、顿号、连词开头。每次回复必须是独立完整的句子。
6. 禁止续写用户消息。你是助手，不是续写工具。
7. 禁止输出思考标签（如<think >、<thinking>、<reason>）。
8. 不主动提供代码示例，除非用户明确要求。
```

**与 V1 的关键差异**：

| V1 规则 | V2 变更 | 原因 |
|---------|---------|------|
| 规则 2 "不寒暄" | 删除"不寒暄"，改为"不说'好的''当然'" | 更具体，4B 模型对具体示例更敏感 |
| 规则 3 "连贯输出" | 删除 | 与首字约束重复，且表述模糊 |
| 规则 5 "不问进一步" | 保留，精简表述 | - |
| 规则 9 "禁止续写" | 拆为规则 5 + 规则 6 | 双重约束：首字 + 续写 |
| - | **新增规则 5**：禁止以逗号开头 | 直接针对逗号幻觉 |
| - | **新增规则 6**：禁止续写用户消息 | 直接针对续写幻觉 |

### 2.3 第三层：场景增强（ENHANCE）

> 由策略分类器动态选择，每次只注入 1 个场景增强块。

详见下文第三节。

---

## 三、9 种策略的完整 Prompt 配置

### 3.1 配置表

| 策略 | 场景增强 prompt | temperature_offset | top_p_offset | repeat_penalty_offset | think_mode | min_length |
|------|----------------|-------------------|-------------|----------------------|------------|------------|
| greeting | 见 3.2.1 | +0.1 | 0 | +0.05 | off | 5 |
| qa | 见 3.2.2 | 0.0 | 0 | 0 | off | 10 |
| math | 见 3.2.3 | -0.3 | -0.05 | 0 | free | 20 |
| logic | 见 3.2.4 | -0.3 | -0.05 | 0 | free | 20 |
| code | 见 3.2.5 | -0.2 | -0.05 | 0 | free | 15 |
| analysis | 见 3.2.6 | -0.1 | 0 | 0 | free | 20 |
| creative | 见 3.2.7 | +0.3 | +0.05 | 0 | off | 30 |
| summarize | 见 3.2.8 | -0.1 | 0 | 0 | off | 10 |
| default | （空） | 0.0 | 0 | 0 | off | 10 |

**新增字段说明**：
- `top_p_offset`：精细控制采样范围，数学/逻辑场景收窄
- `repeat_penalty_offset`：greeting 场景提高重复惩罚，防止"你好你好你好"
- `min_length`：后处理最小有效长度阈值（过短则丢弃重试或标记异常）

### 3.2 各策略场景增强 prompt

#### 3.2.1 greeting

```
这是一句问候。用1-2句话简短友好地回应。不要提供额外帮助或建议。
```

**设计理由**：
- 明确"这是问候"——帮助模型理解意图类型
- "不要提供额外帮助"——防止"你好"触发"我可以帮你xxx"模式
- greeting 是逗号幻觉重灾区，此 prompt 配合规则 5/6 形成三重防御

#### 3.2.2 qa

```
这是一道知识问答。准确回答问题本身，不展开无关内容。如果问题模糊，给出最可能的解释并回答。
```

#### 3.2.3 math

```
这是一道数学题。分步计算，每步写清算式。最后单独写出答案。
```

#### 3.2.4 logic

```
这是一道逻辑推理题。先列出已知条件，再逐步推理，最后给出结论。
```

#### 3.2.5 code

```
这是一个编程需求。先简述思路（1-2句），再写完整代码。代码加必要注释。
```

#### 3.2.6 analysis

```
这是一个分析任务。从多个角度分析，给出过程和结论。用分点或分段组织内容。
```

#### 3.2.7 creative

```
这是一个创意写作任务。内容丰富，结构清晰。可以适当使用修辞，但保持通顺。
```

#### 3.2.8 summarize

```
这是一个总结任务。提炼核心要点，按重要性排列。用简洁的语言概括。
```

---

## 四、Action 级 Prompt 方案

### 4.1 chat（默认 Action）

使用三层通用 prompt，无额外修改。

### 4.2 kb（知识库问答）

**替换身份层 + 规则层**，使用独立的 KB Prompt：

```
你是「桌伴」知识库问答助手。严格基于下方【参考资料】回答问题。

规则：
1. 回答必须基于参考资料中的内容。
2. 回复开头用[来源]标注引用了哪段资料。
3. 如果参考资料中没有相关信息，回答："参考资料中未找到相关信息。"
4. 不编造资料中没有的内容。
5. 用中文回答。
6. 禁止以逗号开头。禁止续写用户消息。

【参考资料】
{context}
```

**设计理由**：
- 独立 prompt 避免与通用规则冲突（通用规则说"不编造"，KB 规则更严格）
- `{context}` 在运行时替换为检索到的文档片段
- 引用标注降低 4B 模型的"自由发挥"倾向

### 4.3 doc（文档处理 / Agent 模式）

```
你是「桌伴」办公助手，当前处于文档处理模式。你可以使用工具完成任务。

规则：
1. 按工具调用格式输出指令。
2. 每次只调用必要的工具。
3. 用中文描述你的操作和结果。
4. 遇到不确定的情况，停下来向用户确认。
5. 禁止以逗号开头。禁止续写用户消息。

可用工具：{tools_description}
```

---

## 五、prompt_builder.py 修改方案

### 5.1 新增常量定义

**文件位置**：`prompts.py`

在现有 `QA_SYSTEM_PROMPT_RULES` 之前，新增：

```python
# ── V2 分层 Prompt ──

# 第一层：核心身份（所有 Action 共享）
IDENTITY_PROMPT = "你是「桌伴」，本地AI办公助手。你运行在用户电脑上，通过对话界面与用户交流。"

# 第二层：通用规则（所有 Action 共享）
RULES_PROMPT = """必须遵守：
1. 用中文回答。代码中变量名可用英文。
2. 直接回答，不重复问题，不说"好的""当然"。
3. 回答完就停。不问"需要进一步了解吗"。
4. 不确定就说不确定，不编造信息。
5. 禁止以逗号、顿号、连词开头。每次回复必须是独立完整的句子。
6. 禁止续写用户消息。你是助手，不是续写工具。
7. 禁止输出思考标签（如<think >、<thinking>、<reason>）。
8. 不主动提供代码示例，除非用户明确要求。"""

# 第三层：场景增强（按策略选择）
STRATEGY_ENHANCEMENTS = {
    "greeting": "这是一句问候。用1-2句话简短友好地回应。不要提供额外帮助或建议。",
    "qa": "这是一道知识问答。准确回答问题本身，不展开无关内容。如果问题模糊，给出最可能的解释并回答。",
    "math": "这是一道数学题。分步计算，每步写清算式。最后单独写出答案。",
    "logic": "这是一道逻辑推理题。先列出已知条件，再逐步推理，最后给出结论。",
    "code": "这是一个编程需求。先简述思路（1-2句），再写完整代码。代码加必要注释。",
    "analysis": "这是一个分析任务。从多个角度分析，给出过程和结论。用分点或分段组织内容。",
    "creative": "这是一个创意写作任务。内容丰富，结构清晰。可以适当使用修辞，但保持通顺。",
    "summarize": "这是一个总结任务。提炼核心要点，按重要性排列。用简洁的语言概括。",
    "default": "",
}

# 策略参数配置（V2 扩展）
STRATEGY_CONFIG_V2 = {
    "greeting":   {"temperature_offset": +0.1, "top_p_offset": 0.0,  "repeat_penalty_offset": +0.05, "think_mode": "off",  "min_length": 5},
    "qa":         {"temperature_offset": 0.0,  "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 10},
    "math":       {"temperature_offset": -0.3, "top_p_offset": -0.05, "repeat_penalty_offset": 0.0,  "think_mode": "free", "min_length": 20},
    "logic":      {"temperature_offset": -0.3, "top_p_offset": -0.05, "repeat_penalty_offset": 0.0,  "think_mode": "free", "min_length": 20},
    "code":       {"temperature_offset": -0.2, "top_p_offset": -0.05, "repeat_penalty_offset": 0.0,  "think_mode": "free", "min_length": 15},
    "analysis":   {"temperature_offset": -0.1, "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "free", "min_length": 20},
    "creative":   {"temperature_offset": +0.3, "top_p_offset": +0.05, "repeat_penalty_offset": 0.0,  "think_mode": "off",  "min_length": 30},
    "summarize":  {"temperature_offset": -0.1, "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 10},
    "default":    {"temperature_offset": 0.0,  "top_p_offset": 0.0,  "repeat_penalty_offset": 0.0,   "think_mode": "off",  "min_length": 10},
}
```

### 5.2 修改 PromptBuilder.build()

**文件位置**：`prompt_builder.py`

**修改 1：system prompt 构建（替换原有逻辑）**

```python
# ── 原代码（删除）──
# if kb_mode:
#     messages.append({"role": "system", "content": KB_SYSTEM_PROMPT})
# else:
#     sys_parts = list(SYSTEM_PROMPT_RULES)
#     ...

# ── 新代码 ──
def _build_system_prompt(self, kb_mode: bool, strategy: str,
                         context_cache: str | None,
                         drift_hint: str | None,
                         kb_context: str | None) -> str:
    """构建 system prompt，三层结构。"""
    
    if kb_mode:
        # KB 模式：使用独立 prompt
        prompt = KB_SYSTEM_PROMPT_TEMPLATE.format(context=kb_context or "（无参考资料）")
        return prompt
    
    # Chat 模式：三层叠加
    parts = [IDENTITY_PROMPT, RULES_PROMPT]
    
    # 场景增强
    enhancement = STRATEGY_ENHANCEMENTS.get(strategy, "")
    if enhancement:
        parts.append(enhancement)
    
    # 会话摘要（如有）
    if context_cache:
        parts.append(f"[本会话较早的对话摘要] {context_cache}")
    
    # 话题切换提示（如有）
    if drift_hint:
        parts.append(f"[话题切换提醒] {drift_hint}")
    
    return "\n".join(parts)
```

**修改 2：用户消息后处理（新增 /no_think 机制）**

```python
def _apply_no_think(self, user_message: str, think_mode: str) -> str:
    """当 think_mode=off 时，在用户消息末尾追加 /no_think。"""
    if think_mode == "off":
        return user_message.rstrip() + "\n/no_think"
    return user_message
```

**修改 3：build() 方法主流程（替换）**

```python
def build(self, pipe, message, history, model_name, context_cache,
          task_type, drift_hint, signals, kb_mode, strategy,
          kb_history_turns, think_mode) -> list:
    """构建完整的 messages 列表。"""
    
    # 1. 确定 think_mode
    config = STRATEGY_CONFIG_V2.get(strategy, STRATEGY_CONFIG_V2["default"])
    effective_think = think_mode if think_mode else config["think_mode"]
    
    # 2. 构建 system prompt
    kb_context = ... # 从 kb 相关逻辑获取
    system_content = self._build_system_prompt(
        kb_mode=kb_mode,
        strategy=strategy,
        context_cache=context_cache,
        drift_hint=drift_hint,
        kb_context=kb_context,
    )
    
    messages = [{"role": "system", "content": system_content}]
    
    # 3. 加入历史（保持原有压缩/截断逻辑不变）
    # ... existing history handling code ...
    
    # 4. 加入用户消息（带 /no_think）
    processed_message = self._apply_no_think(message, effective_think)
    messages.append({"role": "user", "content": processed_message})
    
    return messages

def get_sampler_overrides(self, strategy: str) -> dict:
    """返回策略对应的采样参数覆盖。"""
    config = STRATEGY_CONFIG_V2.get(strategy, STRATEGY_CONFIG_V2["default"])
    overrides = {}
    
    base_temp = ... # 获取基础 temperature
    if config["temperature_offset"]:
        overrides["temperature"] = max(0.0, base_temp + config["temperature_offset"])
    
    base_top_p = ... # 获取基础 top_p
    if config.get("top_p_offset"):
        overrides["top_p"] = max(0.1, min(1.0, base_top_p + config["top_p_offset"]))
    
    base_rp = ... # 获取基础 repeat_penalty
    if config.get("repeat_penalty_offset"):
        overrides["repeat_penalty"] = base_rp + config["repeat_penalty_offset"]
    
    return overrides
```

### 5.3 修改调用链（ollama_service.py 或等效文件）

在调用 Ollama API 的地方，将 sampler overrides 传入：

```python
# 原有调用
# response = await ollama.chat(model=model, messages=messages)

# 修改后
sampler_overrides = prompt_builder.get_sampler_overrides(strategy)
response = await ollama.chat(
    model=model,
    messages=messages,
    # 注意：不传 think 参数，改用 /no_think 在消息中控制
    options=sampler_overrides,  # temperature, top_p, repeat_penalty
)
```

---

## 六、/no_think 控制方案

### 6.1 机制说明

```
think_mode="off"  →  用户消息末尾追加 "\n/no_think"
think_mode="free" →  用户消息不变（Qwen3.5 默认启用 thinking）
```

### 6.2 为什么选 /no_think 而非 think:false

| 维度 | `think: false` (API 参数) | `/no_think` (消息内) |
|------|--------------------------|---------------------|
| 可靠性 | 依赖 Ollama 版本，v0.17.6 前不稳定 | Qwen3.5 模型原生支持 |
| 兼容性 | 仅 Ollama 支持 | 模型级别，跨推理引擎 |
| 可调试性 | 参数不可见 | 出现在 messages 中，可追溯 |
| 社区验证 | 部分用户报告失效 | 广泛验证有效 |

### 6.3 后处理兜底

无论 think_mode 设置如何，都应在回复后处理中 strip 掉 thinking 标签：

```python
import re

def clean_response(text: str) -> str:
    """清理模型回复中的 thinking 标签。"""
    # 移除 <think ...>...</think > 类标签
    text = re.sub(r'<think[^>]*>.*?</think\s*>', '', text, flags=re.DOTALL)
    # 移除开头残留的 <think 标签（未闭合）
    text = re.sub(r'^\s*<think[^>]*>\s*', '', text)
    
    # 首字修正：如果以逗号、顿号开头，移除首个标点
    text = re.sub(r'^[，、；：]\s*', '', text)
    
    # 移除开头空白
    text = text.strip()
    
    return text
```

### 6.4 注意事项

- `/no_think` 必须追加在**用户消息末尾**，不能加在 system prompt 中
- 如果用户消息本身以换行结尾，`/no_think` 仍然能正确触发
- Ollama v0.17.6+ 的 Qwen3.5 专用渲染器会处理 `emitEmptyThinkOnNoThink`，即使模型输出空 think 块也不会影响用户体验

---

## 七、防幻觉三重防御

### 7.1 防御层

```
输入 "你好"
    │
    ▼
┌─────────────────────────────────────────┐
│ 第1层：策略分类                          │
│ greeting 策略 → "这是一句问候。          │
│  用1-2句话简短友好地回应。               │
│  不要提供额外帮助或建议。"                │
│ → 模型明确知道这是问候，不是续写请求      │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 第2层：规则约束                          │
│ 规则5：禁止以逗号、顿号、连词开头         │
│ 规则6：禁止续写用户消息                  │
│ → 即使模型倾向续写，规则提供了强约束     │
└──────────────────┬──────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────┐
│ 第3层：采样参数                          │
│ greeting: repeat_penalty +0.05           │
│ + 后处理首字修正                         │
│ → 即使生成逗号开头，后处理会 strip 掉   │
└─────────────────────────────────────────┘
```

### 7.2 短输入特别处理

对于长度 ≤ 4 个字的输入（"你好"、"谢谢"、"在吗"），额外触发：

```python
SHORT_INPUT_PENALTY = {
    "repeat_penalty": 1.25,   # 提高重复惩罚
    "temperature": 0.3,       # 降低温度
}
```

在 `get_sampler_overrides()` 中叠加：

```python
def get_sampler_overrides(self, strategy: str, user_message: str) -> dict:
    config = STRATEGY_CONFIG_V2.get(strategy, STRATEGY_CONFIG_V2["default"])
    overrides = {}
    # ... 原有逻辑 ...
    
    # 短输入额外保护
    if len(user_message.strip()) <= 4:
        for k, v in SHORT_INPUT_PENALTY.items():
            if k in overrides:
                overrides[k] = max(overrides[k], v) if k == "repeat_penalty" else min(overrides[k], v)
            else:
                overrides[k] = v
    
    return overrides
```

---

## 八、风险评估

### 8.1 高风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 4B 模型忽略 system prompt 规则 | 逗号幻觉仍偶发 | 三重防御 + 后处理兜底，非单纯依赖 prompt |
| `/no_think` 在某些 Ollama 版本失效 | thinking 标签泄露 | 后处理 strip 兜底；记录 Ollama 最低版本要求 v0.17.6 |
| prompt 总长度超 4B 上下文有效窗口 | 回复质量下降 | IDENTITY 50字 + RULES 200字 + ENHANCE 80字 = 330字，历史消息另算 |

### 8.2 中风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 策略分类错误导致错误增强 | 如"你好"被分为 qa | 增强层是附加性的，即使分类错误也不影响核心规则层 |
| repeat_penalty 过高影响正常回复 | 创意类回复出现生硬 | creative 策略 repeat_penalty_offset=0，不受影响 |
| KB prompt 替换身份层后用户困惑 | KB 模式下助手人设变化 | KB prompt 保留了"桌伴"身份，只是强调知识库角色 |

### 8.3 低风险

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| V1 到 V2 迁移兼容性 | 旧配置文件报错 | 保留 `QA_SYSTEM_PROMPT_RULES` 变量名作为废弃标记，新变量独立命名 |
| top_p_offset 计算溢出 | 参数超出 [0,1] | 代码中 clamp 到 [0.1, 1.0] |

### 8.4 不变更清单

以下模块**不需要修改**：
- 策略分类器（classifier）逻辑和模型
- 历史消息压缩/截断逻辑
- 前端对话界面
- Ollama 启动参数和模型加载

---

## 九、总长度验证

| 组成部分 | 字数 | 说明 |
|---------|------|------|
| IDENTITY_PROMPT | ~40 字 | 核心身份 |
| RULES_PROMPT | ~200 字 | 通用规则 |
| 场景增强（最长） | ~70 字 | code 策略 |
| 会话摘要 | ~100 字（上限） | 可选 |
| **合计（不含摘要）** | **~310 字** | ✅ 远低于 500 字上限 |
| **合计（含摘要）** | **~410 字** | ✅ 仍低于 500 字上限 |

---

## 十、迁移清单

1. **prompts.py**：新增 `IDENTITY_PROMPT`、`RULES_PROMPT`、`STRATEGY_ENHANCEMENTS`、`STRATEGY_CONFIG_V2`、`SHORT_INPUT_PENALTY`、`KB_SYSTEM_PROMPT_TEMPLATE`
2. **prompts.py**：保留 `QA_SYSTEM_PROMPT_RULES`、旧 `STRATEGY_CONFIG`（标记 deprecated，不删除）
3. **prompt_builder.py**：新增 `_build_system_prompt()` 方法
4. **prompt_builder.py**：新增 `_apply_no_think()` 方法
5. **prompt_builder.py**：修改 `build()` 主方法
6. **prompt_builder.py**：新增 `get_sampler_overrides()` 方法
7. **ollama_service.py**：修改 API 调用，传入 sampler overrides
8. **response_handler.py**（或等效）：新增 `clean_response()` 后处理函数
9. **requirements**：无新增依赖
