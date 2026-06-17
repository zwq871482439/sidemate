# 知识库三大Bug根因分析报告

**时间**: 2026-05-19 23:00  
**范围**: 摘要状态显示、Chunk分片策略、无关文档召回

---

## Bug 1: 摘要生成失败但UI显示"摘要✓"

### 根因

`kb_meta.json` 中员工手册的 `summary` 字段值：

```json
"summary": "[ERROR] 模型未能产生响应，请刷新页面或重启服务"
```

**后端逻辑** (`knowledge_base.py` L557-592):

```python
summary = self._generate_doc_summary(doc_id, new_chunks)
if summary:          # ← 非空就认为是成功
    doc.summary = summary
```

而 `_generate_doc_summary()` 在 L659-661:

```python
if summary and len(summary) > 20:
    return summary[:500]
return preview[:200] + "..."   # 回退到前200字
```

问题链：
1. `_generate_doc_summary()` 调用 `mgr.chat_stream()` 获取摘要
2. 模型可能返回了 `[ERROR] 模型未能产生响应，请刷新页面或重启服务` 这个**错误消息文本**作为流式输出
3. `parts.append(chunk_text)` 把错误文本当成了摘要内容
4. `"summary"` 判断 `if summary` → True（因为错误消息非空且 > 20字）
5. 错误消息被当作合法摘要存入 `doc.summary`

**前端逻辑** (`index.html` L2049):
```javascript
if (d.summary) html += ' · <span style="color:#6366f1">摘要✓</span>';
```

只检查了 `summary` 是否存在和非空，没有校验内容是否为有效摘要。

### 同时存在的另一个问题

AI技术概述.txt 和 项目周报.md 的 `summary` 字段以 `<!--` 开头：

```json
"summary": "><!--\n\n-->\n\n本文档全面介绍了..."
```

这是 Qwen3 模型忽略了 `/no_think` 指令，输出了 `<think ...>` 标签后的残留。虽然 `re.sub` 清理了 `<think...>` 标签，但清理不彻底留下了 `><!-- -->` 前缀垃圾。

### 修复建议

| 优先级 | 修复项 | 说明 |
|--------|--------|------|
| P0 | **摘要有效性校验** | `if summary` 后增加：检测 `[ERROR]` 开头、长度异常短（<30字）、包含HTML标签 → 标记为失败 |
| P0 | **状态标记** | 摘要生成失败时 `doc.status = "ready"` 不变，但加 `metadata.summary_failed = True` |
| P1 | **前端显示** | 检测到 summary 以 `[ERROR]` 开头时，显示"摘要✗ 重试"并提供重试按钮 |
| P1 | **Think标签清理** | 改进正则，清理 `<think...>...</think` 后的残留 |
| P2 | **重试机制** | 提供 API 端点重新生成单个文档的摘要 |

---

## Bug 2: 员工手册只分了 1 个 Chunk

### 根因

员工手册.txt 原文 **680字**（file_size=1634 字节，但 `total_chars=680`），而 `chunk_max_chars` 默认 **2500**。

**chunker.py** L279-286：

```python
# 如果文本不超过 max_chars，不需要分段
if total_chars <= max_chars:
    chunk = Chunk(index=0, text=text, ...)
    return ChunkPlan(total_chunks=1, chunks=[chunk], strategy="none", ...)
```

680 < 2500 → **直接返回 1 个 chunk**，所有分片策略（章节/段落/固定）都不会触发。

### 对比

| 文档 | 字数 | max_chars | chunk数 | 策略 |
|------|------|-----------|---------|------|
| 员工手册.txt | 680 | 2500 | **1** | none（直接返回） |
| AI技术概述.txt | 1176 | 2500 | **1** | none（直接返回） |
| 项目周报.md | 766 | 2500 | **1** | none（直接返回） |
| test_knowledge_base.txt | 6389 | 2500 | **34** | section（章节检测） |

### 分析

员工手册.txt 有清晰的中文章节标题（`第一章`、`1.1`、`1.2`、`第二章` 等），**如果字数超过 2500**，chunker 会正确按章节分段。问题在于文本太短，被 `total_chars <= max_chars` 短路跳过了。

**这本身不是 bug** — 680 字的文章确实不需要分片，一个 chunk 就够了。但它导致了**覆盖率偏差**问题。

### 覆盖率偏差的本质

| 文档 | chunk数 | 占比 | 检索影响 |
|------|---------|------|----------|
| test_knowledge_base.txt | 34+1(摘要) | 35/41 = **85%** | 主导所有检索结果 |
| AI技术概述.txt | 1+1 | 2/41 = 5% | 几乎不被召回 |
| 员工手册.txt | 1+1 | 2/41 = 5% | 几乎不被召回 |
| 项目周报.md | 1+1 | 2/41 = 5% | 几乎不被召回 |

一个文档因为内容多且章节丰富被切成 35 块，其他文档因为字数少只各占 1 块。检索时 test_knowledge_base.txt 的 chunk 数量碾压性优势，导致：
- **向量检索**：35 个向量 vs 1 个向量，命中率自然偏向多 chunk 文档
- **BM25 检索**：35 个文档参与打分，概率上也更容易命中
- **RRF 融合**：上述两路偏差叠加

### 修复建议

| 优先级 | 方案 | 说明 |
|--------|------|------|
| P1 | **源多样性采样** | 检索结果按 `doc_id` 去重/均衡，每个文档最多取 2-3 条结果，确保不会一个文档霸占全部 Top-K |
| P1 | **分数归一化** | BM25 和向量分数在融合前做 per-document 归一化，避免多 chunk 文档的累积优势 |
| P2 | **最小分片** | 对短文档也按章节标题做虚拟分片（即使总字数 < max_chars），保证每个主题有独立 chunk |
| P2 | **文档权重** | 检索时按 `1/doc.chunk_count` 降权，多 chunk 文档的每条结果权重降低 |

**推荐 P1「源多样性采样」方案**，改动最小，效果最直接：

```python
# 在 search() 返回结果后，按 doc_id 分组
from collections import Counter
doc_counts = Counter(r["doc_id"] for r in results)
max_per_doc = 2  # 每个文档最多取 2 条

filtered = []
seen = Counter()
for r in results:  # 已按 score 降序
    if seen[r["doc_id"]] < max_per_doc:
        filtered.append(r)
        seen[r["doc_id"]] += 1
```

---

## Bug 3: AI技术概述.txt 被无关召回

### 现象

查询"我想弹性上班可以吗？"时，返回了：
- [1] 员工手册.txt 2% 相关 ← **正确**
- [2] AI技术概述.txt 2% 相关 ← **错误**

### 根因分析

AI技术概述.txt 有 1 个 chunk（全文 1176 字）+ 1 个摘要 chunk（500 字）。

其摘要内容为：

> "...人工智能...系统...学习...推理..."

向量检索时，查询"弹性上班"与 AI 概述的向量表示可能有一定语义距离，但由于只有 41 个 chunk 参与检索，`search_top_k=5` 意味着**几乎 12% 的 chunk 都会被返回**。

关键问题在 **`_search_vector()` 没有分数阈值过滤**：

```python
# L758-780
scores = np.dot(self.vectors, query_vec.T).flatten()
top_indices = np.argsort(scores)[::-1][:top_k]  # 取 Top-K，不管分数多低
```

只要 top_k 范围内有 chunk，就会被返回，即使相关度极低（2% = 0.02 的余弦相似度）。

**BM25 侧**有 `if score <= 0: continue` 过滤，但向量侧没有任何阈值。

### 为什么是 AI 概述而不是项目周报？

可能原因：
1. AI 概述的摘要 chunk 包含"工作"、"系统"、"时间"等泛化词汇，与"上班"有弱语义关联
2. AI 概述有 2 个 chunk（原文+摘要），比项目周报也多了 1 个命中机会
3. 向量空间中"弹性"和"智能/学习"可能有微弱的语义邻近

### 修复建议

| 优先级 | 方案 | 说明 |
|--------|------|------|
| P0 | **向量分数阈值** | `_search_vector()` 中过滤 `score < 0.15` 的结果（经验值，bge-small-zh 的余弦相似度低于此值基本不相关） |
| P1 | **源多样性采样** | 配合 Bug 2 的修复，限制每个文档最多返回 2 条 |
| P1 | **BM25 分数也加阈值** | 当前 `score <= 0` 过于宽松，建议提升到 `score < 0.5` |

---

## 问题关联性

三个 bug **不是独立的**，它们共同构成了一个系统性的**检索质量下降链**：

```
短文档不分片(Bug2) → 覆盖率偏差 → 大文档主导检索
        ↓                              ↓
摘要失败存入错误文本(Bug1) → 无效摘要chunk参与检索
        ↓
无分数阈值过滤(Bug3) → 低相关度结果混入 Top-K
        ↓
最终结果：无关文档被召回，正确答案被淹没
```

### 建议修复顺序

1. **Bug 3 (P0)**: 向量检索加分数阈值 — 立即见效，阻断低相关结果
2. **Bug 2 (P1)**: 源多样性采样 — 解决覆盖率偏差
3. **Bug 1 (P0)**: 摘要有效性校验 + UI重试 — 修复用户体验 + 数据污染
4. **Bug 1 清理**: Think 标签残留清理 — 提升摘要质量

---

## 附录：当前 Chunk 分布

| chunk_id | 文档 | heading | 字数 |
|----------|------|---------|------|
| b169d0e740cc | AI技术概述.txt | (全文) | 1175 |
| 8f422d41f97d | AI技术概述.txt §摘要 | 文档摘要 | 500 |
| fa732c8c5151 | 项目周报.md | (全文) | 765 |
| 202aa03ed0de | 项目周报.md §摘要 | 文档摘要 | 466 |
| 159d6ed8d207 | 员工手册.txt | (全文) | 679 |
| d3bd055f1751 | 员工手册.txt §摘要 | 文档摘要 | **27** ← 错误消息文本 |
| test_knowledge_base.txt × 34 chunks + 1 摘要 | | | 6389+500 |

**总计**: 41 chunks（35 来自 test_knowledge_base，2 来自 AI概述，2 来自项目周报，2 来自员工手册）
