# Ponytail Code Review — P6 KB 改写 + 时间线打磨

> **Review 日期**：2026-06-22
> **Review 范围**：当前未提交 diff（6 个文件，+291/-128）
> **Review 规则**：[ponytail-review](https://github.com/DietrichGebert/ponytail) — 只评**复杂度**（过度工程），不评 correctness bug / 安全 / 性能
> **只读 Review**：本次未修改任何源码
> **注意**：本次 review 发现了 1 个真 bug + 1 个死分支，标注为 `bug`/`delete`（ponytail-review 的边界外，但既然看到了就报）

---

## Diff 概览

| 文件 | 变化 | 作用 |
|------|------|------|
| `server/core/reformulate.py` | +13/-16 | 首轮无历史时也走 reformulate，提取搜索关键词 |
| `server/prompts.py` | +12 | 新增 `REFORMULATE_NO_HISTORY_PROMPT` |
| `server/pipelines/local_pipeline.py` | +27/-2 | 始终执行 reformulate + 发 `kb_reformulate` 事件（带 elapsed） |
| `server/routers/kb.py` | +15/-5 | overview 生成改用 `_stream_engine` 直接调，禁 think |
| `server/static/css/main.css` | +98 | KB 时间线垂直布局样式 |
| `server/static/js/chat.js` | +139/-92 | 时间线垂直渲染 + `#stream-content` 重构（替代 innerHTML 全量替换） |

**整体判断**：这是一个**高质量**的改动。核心价值是把 Patch4 那套"innerHTML 全量替换 + 手动 preserve/恢复 DOM"的脆弱方案（chat.js 里删掉的那一大坨 `preservedTimeline`/`preservedDocPanel`/`preservedDocDlBar` 逻辑）换成了"`#stream-content` 子元素隔离"的干净方案——**这是 ponytail 最欣赏的那种重构：删的比加的多，更简单且更对。**

---

## 🐛 bug（ponytail-review 边界外，但必须报）

```
L206: bug: _injectStepContent 的 'text' dataType 分支零调用方（死分支）。grep 全文件仅 kb_sources 一处调用，dataType 恒为 'kb'。若未来真要传 text，再加；现在删掉 text 分支，函数只保留 kb 逻辑，名字也可从 _injectStepContent 改回 _injectKbSources。
```

**位置**：`server/static/js/chat.js:246-248`（`else if (dataType === 'text')` 分支）
**验证**：`grep "_injectStepContent.*'text'" chat.js` 无结果；唯一调用点在 L1348 `_injectStepContent('search', d.sources || [], 'kb')`
**严重度**：低（不影响运行，但注释自称"通用"误导后人，是典型的投机性抽象——ponytail 最反对的那种）

---

## 🔴 delete（死代码 / 冗余）

```
chat.js:206-251: yagni: _injectStepContent 包装成"通用步骤内容注入"，但实际只有 KB 一种用法。原 kb_sources 内联渲染（diff 里删掉的那 23 行）本来就地，现在套了层"stepName/data/dataType"通用壳却只服务一个 case。建议要么真的复用（把 reformulate 也并进来），要么退回单一职责函数 _injectKbSources(search)。
```

---

## 🟡 yagni（单实现抽象 / 投机通用化）

```
local_pipeline.py:188-202: shrink: kb_reformulate 事件在成功路径和失败路径各发一次，两个 dict 字面量重复 4 个字段（original/reformulated/changed/elapsed），仅 error 字段不同。可提取一个 _make_kb_reformulate_event() helper，或接受这点重复（ponytail 角度：两处重复 < 一个抽象的维护成本，保留也行）。
```

```
kb.py:2489-2503: native: 绕过公开 API mgr.chat() 直接用 mgr._stream_engine.run()，理由是要传 override_task_type="text" 关闭 think。但 mgr.chat_stream()（model_manager.py:150）已暴露 stream_engine 的 generator 接口——能否给 mgr.chat() 加个 _disable_think=False 参数走公开 API？现在直接摸 _stream_engine 私有属性，model_manager 内部重构会连带炸 kb.py。（若 chat() 无法支持该参数则当前写法合理，留作讨论。）
```

---

## 🟢 shrink（同逻辑更少行）

```
reformulate.py:25-37: shrink: if/else 嵌套两层（无 history / 有 history 但 summary 空 / 有 history 且 summary 非空），中间两个分支都走 REFORMULATE_NO_HISTORY_PROMPT。可压成：prompt = REFORMULATE_PROMPT.format(...) if (history_summary := _build_history_summary(...)) else REFORMULATE_NO_HISTORY_PROMPT.format(query=query)。-~5 行。（用海象运算符，项目是 Python 3.14 支持。）
```

```
chat.js:109-113: shrink: container.className += ' vertical' 用 += 字符串拼接，若 _isKbStep 触发多次会重复追加 'vertical' 类名。已有 indexOf 防护，但用 classList.toggle('vertical', _isKbStep) 更短且无重复风险。-2 行。
```

---

## ✅ 做得好的地方（ponytail 视角，值得点名）

```
chat.js:555-608: 这次重构的核心收益——删掉了 Patch4 那套 preservedTimeline/preservedDocPanel/preservedDocDlBar 的手动 preserve-restore 逻辑（~50 行脆弱代码，注释里全是 "BUG#13+17 加固"、"强制重新插入"），换成 #stream-content 子元素隔离。这是教科书级的 ponytail 重构：根因修复（不再全量替换 innerHTML）替代症状修补（手动保存恢复 DOM）。net 净删 ~40 行，且彻底消除了一类 bug。
```

```
reformulate.py: 首轮无历史时不再 return query 短路，而是走 REFORMULATE_NO_HISTORY_PROMPT 提取关键词。这是行为改进，不是过度设计——首轮直接拿原句搜文库召回率低，提取关键词是合理优化。
```

```
prompts.py:243-253: REFORMULATE_NO_HISTORY_PROMPT 写得克制——明确约束"不超过10个词"、"不要解释"、"不要加引号"，防止 LLM 跑偏。这是好 prompt 工程的体现。
```

---

## net

```
bug:   1 个（_injectStepContent text 分支死代码）
delete: -~10 行（若删 text 分支 + 退回单一职责）
shrink: -~10 行（reformulate 海象 + classList.toggle）
保留:  ~290 行净增是合理的功能价值（首轮关键词提取 + 时间线垂直布局 + 流式渲染根因重构）
```

**总评**：这个 diff **值得合入**。核心重构（`#stream-content`）是净收益，bug 只是一个无害的死分支。建议处理顺序：
1. **必须修**：删 `_injectStepContent` 的 text 死分支（或退回 `_injectKbSources`）
2. **建议改**：`classList.toggle` 替代 `+= 'vertical'`（防重复类名）
3. **可选**：reformulate 海象压缩、kb.py 是否走公开 API（讨论）
4. **不用改**：其余都 OK

---

*Review 工具：[ponytail-review](https://github.com/DietrichGebert/ponytail) · 报告路径：`C:\Sidemate\REVIEW-ponytail-P6.md`*
