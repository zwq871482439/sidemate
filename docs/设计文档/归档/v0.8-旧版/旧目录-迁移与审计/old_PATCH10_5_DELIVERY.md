# Patch10.5 交付报告 — 贝叶斯 Agent 改进

**日期**: 2026-05-23
**版本**: Agent v2.1 + Prompts v3.2 + Classifier v9.1
**状态**: ✅ 完成

---

## TL;DR

将 task_classifier.py 中已有的贝叶斯先验框架扩展到 Agent 工具选择和迭代终止判断，同时修复了文件误移动问题。

---

## 变更内容

### 1. task_classifier.py — 贝叶斯工具先验

新增：
- `AGENT_TOOL_PRIORS` — 子意图→工具概率分布（5 种先验）
- `AGENT_EXPECTED_STEPS` — 子意图→预期迭代步数
- `get_agent_tool_prior(sub_intent)` — 获取工具先验
- `get_agent_expected_steps(sub_intent)` — 获取预期步数
- `get_agent_hint()` 返回值新增 `tool_prior` 字段

**先验分布示例：**
```python
"doc_writer": {"file_ops": 0.10, "doc_writer": 0.65, "code_runner": 0.05, "kb_search": 0.20}
"code_runner": {"file_ops": 0.15, "doc_writer": 0.05, "code_runner": 0.65, "kb_search": 0.15}
```

### 2. agent.py — 贝叶斯工具排序 + 终止判断

新增：
- 工具描述按贝叶斯先验概率**降序排列**（概率高的排前面）
- 高置信度工具（≥50%）注入提示："最可能需要调用 'xxx' 工具（置信度 xx%）"
- `_is_final_answer_bayesian()` — 贝叶斯终止判断
  - 先验：基于预期步数（doc_writer 预期 2 步，file_ops 预期 1 步）
  - 似然：基于文本特征（结果词 + 无请求词）
  - 阈值：后验概率 > 0.45 则终止
- `_get_expected_steps()` — 获取预期步数

**终止判断示例：**
| 场景 | 轮次 | 文本 | 先验 | 似然 | 后验 | 终止？ |
|------|------|------|------|------|------|--------|
| 写报告 | 1 | "报告已生成完毕" | 0.45 | 0.90 | 0.405 | ❌ |
| 写报告 | 2 | "报告已生成完毕" | 0.75 | 0.90 | 0.675 | ✅ |
| 运行代码 | 1 | "运行成功，结果42" | 0.75 | 0.90 | 0.675 | ✅ |
| 读文件 | 1 | "文件内容如下..." | 0.15 | 0.30 | 0.045 | ❌ |

### 3. prompts.py — Agentic 提示强化

修改 `EXEC_SYSTEM_PROMPT`：
- "你是本地办公助手" → "你是自主办公 Agent"
- 新增："你会自主分析需求→选择工具→执行→验证结果→决定下一步"
- 新增："不需要用户逐步指导，一次性完成整个任务"
- 新增决策原则：直接调用工具、判断任务完成、不重复调用

### 4. 文件恢复

将误移动到 `docs/` 的运行时文件恢复回根目录：
- `settings.json` — 配置存储
- `feedback.json` — 用户反馈
- `notebook.json` — 记忆存储
- `training.json` — 训练记录
- `setup.bat` — 依赖修复脚本
- `start.bat` — 启动脚本

---

## 测试验证

- ✅ task_classifier.py 语法通过
- ✅ agent.py 语法通过
- ✅ prompts.py 语法通过
- ✅ 所有后端文件语法通过
- ✅ 所有前端 JS 语法通过
- ✅ 贝叶斯先验计算正确
- ✅ 贝叶斯终止判断逻辑正确

---

## 效果预期

| 改进 | 预期效果 |
|------|----------|
| 工具排序 | 高概率工具排前面，8B 模型更容易选对 |
| 工具推荐提示 | 直接告诉模型"最可能需要调用 xxx" |
| 贝叶斯终止 | 减少 20-30% 过度迭代，避免过早终止 |
| Agentic 提示 | 强化自主决策意识，减少犹豫 |

---

*Patch10.5 完成，基于 Patch10 的贝叶斯增强。*
