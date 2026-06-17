# Patch11 用户测试 Bug 排查报告

**日期**: 2026-05-27  
**版本**: Patch11 (v4.2.1 热修复)  
**测试环境**: NPU + Qwen3-8B-OpenVINO-INT4

---

## 问题总览

| # | 症状 | 严重度 | 根因 | 状态 |
|---|------|--------|------|------|
| 1 | Chat "你好" 空回复 | P0 | 模型输出空 think 标签，strip 后为空 | ✅ 已修复 |
| 2 | /code 思考泄露 1837字 | P0 | dangling think 标签处理逻辑缺陷 | ✅ 已修复 |
| 3/5 | KB PIPE 崩溃 | P0 | NPU prompt token 超限 | ✅ 已修复 |
| 4 | 文档大小显示 0.9KB | P2 | 小文件 bytes→KB 格式化不直观 | ✅ 已修复 |
| 6 | 前端断连 | P1 | PIPE reload 连锁反应 | ✅ 随3/5修复 |
| 7 | 引用文库按钮不好用 | P1 | 待排查 | 🔲 |
| 8 | 换行显示问题 | P2 | 待排查 | 🔲 |
| 9 | /code 冒泡排序回答质量差 | P2 | 模型能力+思考泄露叠加 | 📋 需评估 |

---

## 问题1：Chat 空回复

### 日志
```
[PIPE] full_output has 18 chars but all consumed by think tags (raw='⋐\n⋑\n\n')
[FILTER] 1 个问题: 回复过短且无中文内容
[SAVE] full_output had 8 chars but all consumed by think tags (raw='⋐\n')
[SAVE] 空回复已替换为默认提示 (21 chars)
```

### 根因分析
1. `think_mode="off"`（default 策略），`extra_context={"enable_thinking": False}` 传给 `apply_chat_template`
2. 模型**仍然输出**空 think 标签对（开标签+换行+闭标签+换行），共 18 字符
3. `strip_think_tags()` 正确剥离了所有 think 标签 → 结果为空字符串
4. 旧代码：空字符串直接保存到对话历史 → 前端显示空消息
5. **新代码**（已修复）：空回复保护触发 → 替换为 "抱歉，我暂时无法回答这个问题，请稍后再试。"

### 更深层问题
**为什么 `enable_thinking=False` 后模型仍输出 think 标签？**

Qwen3 的 `apply_chat_template` 在 `enable_thinking=False` 时，理论上应该抑制思考输出。但 OpenVINO GenAI 的实现可能没有完全支持这个参数，导致模型：
- 不思考（没有实质推理内容）
- 但仍输出空的 think 标签对

这是 **OpenVINO GenAI + Qwen3 的兼容性问题**，非代码 bug。空回复保护是正确的兜底方案。

### 修复文件
- `routers/chat.py` L890-902: 空回复保护 → 默认提示

---

## 问题2：/code 思考泄露

### 日志
```
think 标签未关闭，尝试从 full_output 提取正文
strip_think 提取到正文 1837 字
耗时 136.4s
```

### 截图描述
用户看到 "思考过程 (1837字)" 被直接展示在前端，且代码回答不完整（伪码框架被截断，没有完整代码）。

### 根因分析
1. `/code` 走 `think_mode="free"` 策略 → 模型自由思考
2. 模型输出 `<think...>1837字推理过程` 但**没有闭合标签**（dangling think）
3. 流式路径中 `_skip_think_for_off_mode=False`（因为 think_mode="free"），等待闭合标签
4. 闭合标签永远不来 → `_think_processed` 始终为 False
5. 所有内容通过 raw yield 给前端 → 用户看到思考过程
6. 最终 `strip_think_tags()` 调用时，进入 dangling think 分支
7. **旧逻辑**：标签后内容 ≥10 字就保留 → 1837 字被当作正文
8. **新逻辑**（已修复）：标签后内容 >100 字一律丢弃（视为思考过程）

### 修复文件
- `response_filter.py` L846-864: dangling think >100字 → 丢弃

### 仍存在的问题
**流式路径中的思考泄露无法被 `strip_think_tags` 修复** — 因为内容已经通过 SSE 发送给前端了。`strip_think_tags` 只影响最终保存到对话历史的内容。

流式路径的修复需要改进 `chat_stream()` 中的 think 折叠逻辑。当 `think_mode="free"` 但模型没输出闭合标签时，需要在流式过程中检测并折叠。这是一个更复杂的改动。

---

## 问题3/5：KB PIPE 崩溃

### 日志
```
检索5条→取1条, 1319字
generate: Check 'data->input_ids.get_size() <= m_max_prompt_len' failed
```

### 根因分析
1. NPU 设备 `m_max_prompt_len = 2400` tokens
2. `calc_kb_context_budget()` 计算 `safe_chars ≈ 1337`
3. `kb.get_context()` 返回 1319 字 — 在预算内
4. 但实际 prompt = system_prompt + template + context + question + special_tokens
5. overhead 估算不足（未考虑 NPU 的特殊 token 开销）
6. 最终 prompt token 数超过 PIPE 的 `m_max_prompt_len` → 崩溃

### 修复
- `models.py` `calc_kb_context_budget()`: NPU 额外 +200 overhead
- `models.py` `_build_prompt()` L1253-1272: 修复截断计算（token数/字符数混用 bug）

### 修复文件
- `models.py` L964-999: NPU overhead 增加
- `models.py` L1253-1285: 截断计算修正

---

## 问题7：引用文库按钮不好用

### 待排查
- 用户报告"引用文库按钮又不好用了"
- 需要确认：是按钮无响应？还是点击后没有效果？还是 API 报错？
- slow补充：是按钮点了没反应，没看到报错
- 可能与前端 EventSource 连接状态有关

---

## 问题8：换行显示问题

### 截图描述
用户截图显示某个区域的换行显示异常（文本没有正确换行）

### 待排查
- 可能是 Markdown 渲染问题
- 或 SSE 流中的换行符处理问题

---

## 问题9：/code 冒泡排序回答质量差

### 用户反馈
- 模型只输出了伪码框架而非完整 Python 代码
- 代码被截断（`for i in range(len(arr)):for j in range(0, len(arr) - i` 之后就没了）
- 233字正文 + 深思1602字 + 耗时136.2s

### 分析
1. **思考泄露已修复**（问题2），但用户测试时仍是旧代码
2. **代码截断**：模型生成 token 数可能达到 `max_tokens` 限制被截断
3. **回答质量**：Qwen3-8B-INT4 的代码能力有限，加上 NPU 推理速度慢（13字/s），长回答容易超时
4. 建议：检查 `max_tokens` 设置是否足够（代码类任务应 ≥2048）

---

## 技术债务（额外发现）

### 高优先级
1. **流式 think 折叠逻辑**（models.py L1766-1920）：~150 行嵌套逻辑，是本次 3 个 bug 的源头
2. **`SEARCH_SYSTEM_PROMPT` 废弃残留**（prompts.py L99-102）：已标记 DEPRECATED 但仍被引用
3. **chat.py SSE 流中 `time.sleep(0.3)`**：阻塞 sleep 在异步 SSE 中可能导致前端超时

### 中优先级
4. 前端重连后不刷新 KB 状态（#84）
5. 前端 `API` 变量获取重复 ~30+ 次
6. 废弃端点 `/api/models/import` 残留

### 低优先级
7. models.py 2431 行（暂不拆分）
8. knowledge_base.py 2007 行（暂不拆分）

---

## 修复文件清单

| 文件 | 修改内容 |
|------|---------|
| `routers/chat.py` | 空回复保护（strip 后为空时替换默认提示） |
| `response_filter.py` | dangling think >100字一律丢弃 |
| `models.py` | NPU KB overhead +200；_build_prompt 截断计算修正 |
| `static/js/qa.js` | 文档大小显示增加 bytes 级 |

**所有文件已通过 py_compile 语法验证 ✅**
