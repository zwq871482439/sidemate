# Agent 智能化改进预研报告

**分析日期**: 2026-05-22
**分析范围**: agent.py v2.0 + prompts.py v3.1
**目标**: 让 Qwen3-8B 在 Agent 模式下更聪明

---

## 一、当前 Agent 架构

```
用户输入 → 场景配置 → 构建 Agent Prompt → LLM 调用 → 解析 [TOOL_CALL] → 执行工具 → 压缩结果 → 追加到 scratchpad → 循环
```

**关键参数**:
- 最大迭代: 8 轮（默认）
- 超时: 120 秒
- 工具结果压缩阈值: 800 字符
- Scratchpad 最大消息数: 20 条

**当前工具列表**:
- `file_ops` — 文件读写
- `code_runner` — 运行 Python
- `doc_writer` — 生成 Word
- `xlsx_reader` — 读取 Excel
- `word_reader` — 读取 Word
- `long_reader` — 长文本分段阅读
- `kb_search` — 知识库搜索

---

## 二、当前问题诊断

### 问题 1: 模型不调用工具（最常见）

**现象**: 用户说"帮我写个报告"，模型直接回复"好的，以下是报告内容..."而不是调用 `doc_writer`

**根因分析**:
1. **Prompt 不够强制**: 当前 prompt 说"需要操作文件时直接调用工具"，但模型经常"觉得"自己能直接回答
2. **场景边界模糊**: chat 场景 `max_iterations=0`，但用户可能在 chat 场景下要求写文档
3. **工具描述太长**: 8B 模型上下文有限，长 prompt 容易让模型"忘记"工具调用规则

**已有缓解**:
- 第1轮空输出时追加提示重试
- 第2轮仍未调用则强制兜底
- 格式修复（中文括号→英文等）

### 问题 2: Think 标签内包含工具调用

**现象**: 模型把 `[TOOL_CALL:xxx|{...}]` 放在 `<think>...</think>` 内，导致正文为空

**根因**: Qwen3-8B 的思考习惯和工具调用格式冲突

**已有缓解**:
- 从 think 内容中提取工具调用（agent.py:304-307）
- `_strip_think()` 去除 think 标签后再解析

### 问题 3: 工具参数 JSON 格式错误

**现象**: 模型输出 `[TOOL_CALL:file_ops|{"path": "test.txt"}]` 缺少 `operation` 字段

**已有缓解**:
- 补全 JSON（加 `}`、`"}`）
- 单引号替换为双引号
- 解析失败时返回 `{"_raw": ..., "_parse_error": True}`

### 问题 4: 迭代次数浪费

**现象**: 模型在第1轮就给出了最终答案（不需要工具），但 Agent 继续空转

---

## 三、改进方案（按 ROI 排序）

### 方案 A: 强化工具调用 Prompt（高 ROI，低改动）

**问题**: 当前 prompt 太"客气"，模型经常"觉得自己能直接回答"

**改进**:
```python
# 当前（弱）
"需要操作文件/网页/代码时，直接调用工具，不要教用户怎么做"

# 改进（强）
"规则：
1. 如果用户要求创建/修改/读取文件 → 必须调用工具
2. 如果用户要求运行代码 → 必须调用工具  
3. 如果用户要求搜索知识库 → 必须调用工具
4. 禁止直接输出文件内容，必须通过工具操作
5. 每次回复只能做一件事：要么调用工具，要么给出最终答案"
```

**实现**: 修改 `prompts.py` 中的 `EXEC_SYSTEM_PROMPT`

### 方案 B: 工具选择前置（高 ROI，中改动）

**问题**: 模型在不该用工具的场景也尝试调用工具

**改进**: 在 Agent loop 开始前，先用一次轻量 LLM 调用判断是否需要工具：

```python
def _need_tools(self, user_message, scene_config):
    """判断用户输入是否需要工具调用"""
    if not scene_config or scene_config.get("max_iterations", 0) == 0:
        return False
    
    # 快速分类：用户是否需要文件/代码/搜索操作
    keywords = {
        "file_ops": ["文件", "文档", "读取", "打开", "保存", "创建"],
        "code_runner": ["代码", "运行", "执行", "python", "脚本"],
        "doc_writer": ["生成", "创建", "写", "报告", "文档"],
        "kb_search": ["搜索", "查找", "知识库", "资料"],
    }
    
    msg = user_message.lower()
    needed = []
    for tool, kws in keywords.items():
        if any(kw in msg for kw in kws):
            needed.append(tool)
    
    return needed
```

**收益**: 避免在纯问答场景下空转

### 方案 C: One-Shot 示例注入（中 ROI，低改动）

**问题**: 8B 模型对抽象描述理解不好，需要具体例子

**改进**: 在 prompt 中注入一个完整的工具调用示例：

```python
"""
示例对话：
用户：帮我创建一个报告
助手：[TOOL_CALL:doc_writer|{"template": "report", "title": "报告", "sections": [{"heading": "概述", "content": "内容"}]}]
系统：[TOOL_RESULT:doc_writer|{"status": "ok", "filename": "报告.docx"}]
助手：已生成报告.docx，你可以点击下方按钮下载。

现在请处理用户的请求。
"""
```

### 方案 D: 工具结果反馈优化（中 ROI，中改动）

**问题**: 工具结果返回后，模型不知道下一步该做什么

**改进**: 在工具结果后追加明确的"下一步提示"：

```python
# 当前
scratchpad.append({
    "role": "user",
    "content": "[TOOL_RESULT:%s|%s]" % (tool_name, json.dumps(result))
})

# 改进
next_hint = ""
if tool_name == "file_ops" and result.get("status") == "ok":
    next_hint = "\n文件操作已完成。如果需要继续操作其他文件，请调用工具。如果任务完成，请给出最终回复。"

scratchpad.append({
    "role": "user", 
    "content": "[TOOL_RESULT:%s|%s]%s" % (tool_name, json.dumps(compressed_result), next_hint)
})
```

### 方案 E: 迭代早期终止（高 ROI，低改动）

**问题**: 模型已经给出了最终答案，但还在循环

**改进**: 检测模型输出是否包含"最终答案"特征：

```python
def _is_final_answer(self, text: str) -> bool:
    """判断模型输出是否是最终答案（而非工具调用）"""
    # 如果输出较长且没有 TOOL_CALL 标记，可能是最终答案
    if len(text) > 50 and "[TOOL_CALL:" not in text:
        return True
    # 如果包含总结性语句
    final_markers = ["总结", "综上所述", "最终", "完成", "已生成"]
    if any(m in text for m in final_markers) and "[TOOL_CALL:" not in text:
        return True
    return False
```

在 loop 中：
```python
if self._is_final_answer(clean_output):
    final_text = clean_output
    break
```

---

## 四、推荐实施顺序

```
Phase 1（Patch10 内完成）:
  1. 强化工具调用 Prompt（方案 A）
  2. 迭代早期终止（方案 E）
  3. One-Shot 示例注入（方案 C）

Phase 2（后续 Patch）:
  4. 工具选择前置（方案 B）
  5. 工具结果反馈优化（方案 D）
```

---

## 五、Prompt 修改草案

```python
# prompts.py

EXEC_SYSTEM_PROMPT_V2 = """你是本地办公助手。你的工作流程：

第1步：判断用户需要什么
- 创建/读取/修改文件 → 调用工具
- 运行代码 → 调用工具  
- 搜索知识库 → 调用工具
- 纯问答 → 直接回答

第2步：调用工具（格式严格）
[TOOL_CALL:工具名|{"参数": "值"}]

可用工具：
1. file_ops — 文件操作
   读: {"operation":"read","path":"文件路径"}
   写: {"operation":"create","path":"文件名.txt","content":"内容"}

2. code_runner — 运行代码
   {"code":"print('hello')"}

3. doc_writer — 生成Word
   {"template":"report","title":"标题","sections":[{"heading":"章","content":"内容"}]}

4. kb_search — 知识库搜索
   {"query":"关键词"}

规则：
1. 必须操作文件时，禁止直接输出文件内容
2. 每次只调用一个工具
3. 看到工具结果后，决定继续或给出最终答案
4. 最终答案用中文，不要包含 [TOOL_CALL]
5. 任务完成时明确说"已完成"

示例：
用户：创建报告
助手：[TOOL_CALL:doc_writer|{"template":"report","title":"报告","sections":[{"heading":"概述","content":"内容"}]}]
系统：[TOOL_RESULT:doc_writer|{"status":"ok","filename":"报告.docx"}]
助手：已完成，生成文件：报告.docx
"""
```

---

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Prompt 过长导致 8B 模型性能下降 | 中 | 中 | 精简 prompt，移除不常用工具描述 |
| 过度强制工具调用导致纯问答也调工具 | 低 | 中 | 增加关键词判断 |
| 早期终止误判导致任务未完成 | 低 | 高 | 保守判断，仅在明确完成时终止 |

---

## 七、测试建议

1. **工具调用率测试**: 统计 100 条需要工具的请求中，模型正确调用的比例
2. **空转率测试**: 统计不需要工具的请求中，模型是否误调用工具
3. **迭代次数测试**: 对比改进前后的平均迭代次数
4. **用户满意度**: 主观评估最终答案质量
