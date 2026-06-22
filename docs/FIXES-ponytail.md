# Sidemate 问题清单 + 修复建议（已验证安全性）

> **合并自**：AUDIT-ponytail.md（全仓审计）+ REVIEW-ponytail-P6.md（P6 diff review）
> **日期**：2026-06-22
> **原则**：每条修复建议均经过 grep 调用面验证 + 行为等价性核查，**不能引出新问题**
> **用户约束**：
> - ✅ archive 是代码归档，**保留不删**
> - ✅ docs 文档全留 docs，**不删**
> - ✅ 所有修复必须验证不引新问题

---

## 📋 修复建议总览

| # | 问题 | 风险 | 是否建议修 |
|---|------|------|-----------|
| F1 | `_injectStepContent` text 死分支 | 零 | ✅ 修 |
| F2 | `classList.toggle` 替代 `+=` 拼接 | 零 | ✅ 修 |
| F3 | reformulate 海象运算符压缩 | 零 | ✅ 修 |
| F4 | access_token 三处零调用方法 | 零 | ✅ 修 |
| F5 | template_parser 零调用函数 | 零 | ✅ 修 |
| F6 | ollama_manager 一行包装 | 零 | ✅ 修 |
| F7 | generate_queue 零读取属性 | 零 | ✅ 修 |
| F8 | access_token 两 token 生成合一 | 低 | ✅ 修（小心） |
| F9 | sha256 改 `hashlib.file_digest` | 零 | ✅ 修 |
| F10 | curl_cffi 落实优化 | 中 | ✅ 修（独立任务） |
| F11 | cache_cleanup/log_cleanup 合并 | 中 | ⚠️ 可选，需测试 |
| F12 | atomic_write_json 合并 | 中 | ⚠️ 可选，需测试 |
| F13 | kb_reformulate 两路径去重 | 零 | ⚠️ 可选，收益小 |
| F14 | search_engine 重复 tag-strip | 零 | ⚠️ 可选，收益小 |
| — | ~~archive 删除~~ | — | ❌ **撤回**（你明确保留） |
| — | ~~docs 文档删除~~ | — | ❌ **撤回**（你明确保留） |
| — | ~~HTTPException 替换~~ | — | ❌ **撤回**（改 API 格式，炸前端） |
| — | ~~deps_check 删 import_check~~ | — | ❌ **撤回**（两套互补非重复） |
| — | ~~thread_pool 重构~~ | — | ❌ **撤回**（调用面含 `.executor` 属性） |
| — | ~~think_processor 重构~~ | — | ❌ **撤回**（调用面含实例属性） |

---

## ✅ 第一类：零风险修复（grep 已验证零副作用）

### F1. 删 `_injectStepContent` 的 text 死分支

**问题**：`server/static/js/chat.js:207` 的 `_injectStepContent` 注释自称"通用步骤内容注入"，支持 `'kb'` 和 `'text'` 两种 dataType，但 grep 全文件**只有 kb_sources 一处调用**（L1349），dataType 恒为 `'kb'`。`text` 分支是死代码。

**修复**：删除 `else if (dataType === 'text')` 分支（chat.js:246-248），函数可改名 `_injectKbSources`。

```javascript
// 删掉这几行（chat.js:246-248）
} else if (dataType === 'text') {
  contentEl.textContent = data;
}
```

**为什么安全**：
- grep `_injectStepContent.*'text'` 零结果——text 分支从未被触发
- 删除后唯一调用点 `_injectStepContent('search', d.sources || [], 'kb')` 走 kb 分支，行为不变
- **验证手段**：删后 grep `_injectStepContent` 应只剩定义 + kb_sources 一处调用

---

### F2. `classList.toggle` 替代字符串拼接

**问题**：`server/static/js/chat.js:112-114` 用 `+= ' vertical'` 加类名，虽有 `indexOf` 防重复，但写法脆弱。

```javascript
// 现状（chat.js:111-114）
var _isKbStep = (step === 'reformulate' || step === 'search');
if (_isKbStep && container.className.indexOf('vertical') < 0) {
  container.className += ' vertical';
}
```

**修复**：

```javascript
var _isKbStep = (step === 'reformulate' || step === 'search');
container.classList.toggle('vertical', _isKbStep);
```

**为什么安全**：
- `classList.toggle(cls, force)` 的 `force=true` 加类、`force=false` 去类，**完全等价**于"KB 步骤加、非 KB 步骤不加"
- 原代码的 `indexOf < 0` 防护本身就是为防重复——toggle 天然幂等，更干净
- **行为差异核查**：原代码非 KB 步骤**不会移除**已加的 vertical 类（只加不删）；toggle 在 `_isKbStep=false` 时会移除。**但**看调用流程，`_handleAgentTimelineSSE` 每条 SSE 都跑，KB 步骤之后若来非 KB 步骤，toggle 会移除 vertical——**这其实是修复了一个潜在 bug**（原代码 KB 后接非 KB 步骤，垂直布局残留）。若担心，可保留原逻辑只改写法：`if (_isKbStep) container.classList.add('vertical');`
- **建议**：保守起见用 `classList.add`（只加不删，行为完全等同原代码）

```javascript
// 保守版（行为 100% 等同原代码）
if (_isKbStep) container.classList.add('vertical');
```

---

### F3. reformulate 海象运算符压缩

**问题**：`server/core/reformulate.py:25-37` 两层 if/else，中间分支（有 history 但 summary 空）和无 history 分支都走同一 prompt。

**修复**：

```python
# 现状（reformulate.py:25-37）
if not history:
    prompt = REFORMULATE_NO_HISTORY_PROMPT.format(query=query)
else:
    history_summary = _build_history_summary(history, max_chars=500)
    if not history_summary:
        prompt = REFORMULATE_NO_HISTORY_PROMPT.format(query=query)
    else:
        prompt = REFORMULATE_PROMPT.format(
            history_summary=history_summary,
            query=query,
        )

# 压缩为
history_summary = _build_history_summary(history, max_chars=500) if history else ""
prompt = (
    REFORMULATE_PROMPT.format(history_summary=history_summary, query=query)
    if history_summary
    else REFORMULATE_NO_HISTORY_PROMPT.format(query=query)
)
```

**为什么安全**：
- `_build_history_summary` 返回 `str`（行 142 签名），空 str 为 falsy，`if history_summary` 判空正确
- `history` 为空时短路不调用 `_build_history_summary`（与原逻辑一致，原代码 `if not history: return` 也是避免无意义调用）
- 三分支逻辑（无history / 有history无summary / 有history有summary）压缩后**完全等价**：前两种都走 NO_HISTORY，第三种走 REFORMULATE
- **注意**：这是 diff 里的新代码（P6 改动），改它要确保和 P6 的行为一致——上面的压缩版与 P6 diff 行为逐字等价

---

### F4. 删 access_token 三处零调用方法

**问题**：`server/core/access_token.py` 三个方法零调用方。

| 行 | 方法 | 验证 |
|----|------|------|
| 282-285 | `_remove_token`（locked 变体） | grep 全仓+动态访问零结果，仅 `_remove_token_unlocked` 被用 |
| 350-363 | `get_doc_access_level` | grep 零结果 |
| 365-375 | `clear_all` | grep 零结果（docstring "重启模拟" 是空意图） |

**修复**：删这三个方法（保留文件其余部分）。

**为什么安全**：
- grep `get_doc_access_level` / `clear_all` / `_remove_token\b`（带词边界，排除 `_remove_token_unlocked`）全仓零结果
- access_token.py **无 `__all__`**，但也没 `getattr(access_token, ...)` 动态访问（已 grep 确认）
- **注意**：删 `_remove_token` 时别误删 `_remove_token_unlocked`（后者在用）——用词边界正则 `_remove_token\b` 区分

---

### F5. 删 template_parser 零调用函数

**问题**：`server/core/template_parser.py:188-204` `template_to_outline_json` 零调用。

**修复**：删该函数。

**为什么安全**：grep `template_to_outline_json` 全仓零结果（仅定义处）。

---

### F6. 删 ollama_manager 一行包装

**问题**：`server/core/ollama_manager.py:152-158` `auto_start` 一行 `return self.start()`。

**修复**：删 `auto_start`，调用方 `server.py:235` 改为直接 `mgr.start()`。

**为什么安全**：
- `auto_start` 体只有 `return self.start()`，无额外逻辑
- 唯一调用方 server.py:235，改后等价
- **注意**：要同步改 server.py:235 的调用点，否则会 AttributeError

---

### F7. 删 generate_queue 零读取属性

**问题**：
- `server/core/generate_queue.py:126-143` `queue_length` + `queue_info` 属性零外部读取
- `server/core/generate_queue.py:108,472,488` `_worker_thread`（单数）兼容字段仅 set 不 read

**修复**：删这些属性和兼容字段赋值。

**为什么安全**：
- grep `queue_info` / `queue_length` 全仓零外部读取（仅 llm_scheduler.py:133 是另一文件的字面量，且 llm_scheduler 整文件本就待删）
- `_worker_thread` 单数 grep 仅在 generate_queue.py 内部 set，无 read

---

### F8. access_token 两 token 生成合一（低风险，小心）

**问题**：`server/core/access_token.py:144-172` `generate_full_token` / `generate_search_token` 仅字面量 `"full"`/`"search"` 不同。

**修复**：合一为 `_create_token(doc_id, level, session_id=None)`，保留两个公开方法做薄包装（或直接改调用方）。

```python
# 推荐：保留公开方法签名，内部合一
def generate_full_token(self, doc_id, session_id=None):
    return self._create_token(doc_id, "full", session_id)

def generate_search_token(self, doc_id, session_id=None):
    return self._create_token(doc_id, "search", session_id)

def _create_token(self, doc_id, level, session_id=None):
    # 原 generate_full_token 的实现，level 参数化
    ...
```

**为什么安全**：
- 调用方仅 `kb.py:1539,1541` 两处，签名不变则调用方零改动
- **建议保留公开方法**（上面的写法），只合并内部实现——这样调用方完全不用动
- **若要改调用方**：需同步改 kb.py 两处，风险略高，不推荐

---

### F9. sha256 改 `hashlib.file_digest`

**问题**：`server/core/deps_check.py:110-116` `sha256_file` 手撸分块读，Python 3.11+ 有 `hashlib.file_digest`。

**修复**：

```python
# 现状
def sha256_file(filepath: str) -> str:
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()

# 改为
def sha256_file(filepath: str) -> str:
    with open(filepath, "rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()
```

**为什么安全**：
- `hashlib.file_digest(f, "sha256")` 是 Python 3.11+ 官方 API，项目用 Python 3.14（requirements.txt 注释明确），支持
- 返回的 digest 对象 `.hexdigest()` 与手撸的 `h.hexdigest()` 输出完全一致（都是 SHA256 标准十六进制）
- 被本文件用 3 处（行 182/241/303），改动后所有调用点自动获益，无需改调用方
- **验证手段**：改后跑一次 `generate_manifest`，对比 manifest 文件 sha256 值应与改前一致

---

## 🔧 第二类：独立任务（curl_cffi 落实优化）

### F10. curl_cffi 落实优化

**问题**：`server/core/search_engine.py` 写了 curl_cffi 优先 + httpx fallback，但 deps 未声明、嵌入式未安装，实际永远走 httpx。

**修复路线**（详见 AUDIT-ponytail.md 第一部分）：

1. `requirements.txt` 加 `curl_cffi>=0.15.0`
2. **先验证嵌入式 Python 能装**（最大风险点）：
   ```bash
   python/python.exe -m pip install curl_cffi>=0.15.0
   ```
   - 装上 → 继续
   - 装不上 → 走 B 方案（deps_check 标可选 + 文档说明）
3. 打包流程 `build_full.py` / `assemble.bat` 同步
4. `deps_check.py` 标 curl_cffi 为可选
5. 启动验证日志出现 `[SEARCH] 使用 curl_cffi`

**风险**：中。嵌入式 Python 编译 C 扩展可能失败（curl_cffi 依赖 libcurl）。
**为什么这条独立**：它改依赖 + 打包流程，影响面比纯代码改动大，应单独 commit + 单独测试。

---

## ⚠️ 第三类：可选修复（收益小或需测试）

### F11. cache_cleanup / log_cleanup 合并

**问题**：两个文件都是 walk-mtime-remove 循环。

**修复**：合为 `_cleanup_old_files(path, max_age_days, recursive=True)`。

**风险**：中。需核对两个函数的**行为差异**（递归 vs 平铺、返回值、错误处理）再合，不能盲目合。
**建议**：**先放着**，收益 -40 行不大，合并风险不值得。若要做，需写测试覆盖两种场景。

---

### F12. atomic_write_json 合并

**问题**：`session_migrator.py:152-159` 与 `doc_session.py:318-332` 两份 tmp+os.replace。

**修复**：合到 `common/utils.py` 的 `atomic_write_json`。

**风险**：中。两处的 tmp 文件命名、错误处理细节可能不同，合并前要逐行对比。
**建议**：同 F11，先放着。

---

### F13. kb_reformulate 两路径去重

**问题**：`server/pipelines/local_pipeline.py:188-202` 成功/失败两路径的 dict 重复 4 字段。

**修复**：抽 `_make_kb_reformulate_event()` helper。

**风险**：零，但**收益极小**（两处重复 < 一个抽象的维护成本）。
**建议**：**不修**。ponytail 原则：两处重复不值得造抽象。

---

### F14. search_engine 重复 tag-strip

**问题**：`server/core/search_engine.py` `_strip_tags` 定义一次，行内 `re.sub(r'<[^>]+>',...))` 又出现 7 次。

**修复**：7 处行内替换为调用 `_strip_tags`；实体解码用 `html.unescape`。

**风险**：零，但**收益小**（-15 行）且改动 7 处，易出错。
**建议**：可选。若做，需逐处核对行内 regex 与 `_strip_tags` 的行为是否完全一致（尤其实体解码部分）。

---

## ❌ 第四类：已撤回的修复（会引新问题或判断错误）

### ~~archive 删除~~ — 撤回

**原 audit A1 建议**：删 `server/archive/`（1487 行）。
**撤回原因**：**用户明确要求保留**——archive 是代码归档用途，故意的。
**教训**：ponytail-audit 的"零外部引用=可删"在归档场景不适用，应先问用途。

---

### ~~docs 文档删除~~ — 撤回

**原 audit A5 建议**：删/归档 `docs/PATCH4-*` 系列。
**撤回原因**：**用户明确要求全留 docs**。
**教训**：文档不等于死代码，历史规划/报告有追溯价值。

---

### ~~HTTPException 替换 JSONResponse~~ — 撤回（关键）

**原 audit D4 建议**：routers ~130 处 `JSONResponse({"error":...})` 换 `raise HTTPException(detail={"error":...})`。
**撤回原因**：**会改 API 响应格式，炸前端**。
- `JSONResponse({"error": msg})` → 顶层 `{"error": msg}`
- `HTTPException(detail={"error": msg})` → FastAPI 默认包成 `{"detail": {"error": msg}}`，**多一层 `detail` 包装**
- 前端 `chat.js:190,1251,1712` 读 `data.error`，改后读不到
- 项目无 `exception_handler` 做格式转换
**验证手段**：grep `exception_handler` / `add_exception_handler` in server.py 零结果确认无转换层。
**教训**：ponytail-review 的"用框架原生特性"建议，必须先核查响应格式契约。

---

### ~~deps_check 删 import_check~~ — 撤回（判断错误）

**原 audit B3 建议**：删 `REQUIRED_DEPS` + `_import_check`（~55 行），只留 SHA256 manifest。
**撤回原因**：**两套是互补诊断，不是重复**。
- `import_check`（行 49-71）：检测"包装了但 import 失败"（依赖损坏/冲突）
- SHA256 manifest（行 209-263）：检测"文件被篡改/版本漂移"
- 两者检测**不同类问题**，删了 import_check 会丢失"装了但坏"的检测能力
**验证手段**：读 `check_deps` 函数体（行 73-101），它只走 import check；manifest 是 server.py 单独调用——两套独立入口。
**教训**：子代理说"更弱的第二套"是误判，需读函数体确认职责。

---

### ~~thread_pool 重构~~ — 撤回（调用面广）

**原 audit C1 建议**：ThreadPoolManager 换模块级 executor + 自由函数。
**撤回原因**：**调用面含 `.executor` 属性直接访问**，改了炸 4+ 处。
- `agent_loop.py:304` 用 `get_thread_pool().run_blocking(...)`
- `kb.py:790,2218,2356,2499` 用 `get_thread_pool().executor`（**直接摸属性**传给 `run_in_executor`）
- 改成自由函数后 `.executor` 属性不存在，4 处 AttributeError
**验证手段**：grep `get_thread_pool` 全仓 6 处调用，其中 4 处摸 `.executor`。
**教训**：重构建议必须 grep 完整调用面，不能只看子代理报告。

---

### ~~think_processor 重构~~ — 撤回（调用面广）

**原 audit C2 建议**：ThinkProcessor 类换自由函数。
**撤回原因**：**调用面含实例属性访问**。
- `model_manager.py:48` 持有 `self._think_processor = ThinkProcessor()` 实例
- `model_manager.py:120,124` 委托 `self._think_processor.strip_think(text)`
- `prompt_builder.py:222` 摸 `mm._think_processor.strip_think(content)`（**外部直接摸私有属性**）
- `local_pipeline.py:489` 也 import ThinkProcessor
- `core/__init__.py:8` export ThinkProcessor
**验证手段**：grep `ThinkProcessor` / `_think_processor` 全仓 6 处。
**教训**：同 C1，类改自由函数要保证所有属性访问点都改，风险高收益低。

---

## 📊 修复优先级建议

### 立即可做（零风险，净收益）

按"改动小、收益明确"排序：

1. **F1** 删 `_injectStepContent` text 死分支（bug）
2. **F2** classList.add 替代 `+=`（保守版）
3. **F5** 删 template_parser 零调用函数
4. **F7** 删 generate_queue 零读取属性
5. **F4** 删 access_token 三处零调用方法
6. **F6** 删 ollama_manager 一行包装（同步改 server.py 调用点）
7. **F9** sha256 改 `hashlib.file_digest`
8. **F3** reformulate 海象压缩

→ 预期 **-~80 行**，零行为变化，每条可独立 commit

### 独立任务（中风险，单独做）

9. **F10** curl_cffi 落实优化（改依赖+打包，单独 commit + 测试）

### 可选（收益小或需测试）

10. **F8** access_token 合一（低风险，保留公开方法签名）
11. **F11/F12** helper 合并（需测试，先放着）
12. **F13/F14** 小去重（收益小，可不修）

### 不做（已撤回）

- archive 删除、docs 删除、HTTPException、deps_check、thread_pool、think_processor

---

## 🔍 验证清单（每条修复后跑一遍）

修复后建议验证（按风险排序）：

```bash
# 1. 零风险修复后：grep 确认无残留引用
cd C:\Sidemate
grep -rn "template_to_outline_json\|get_doc_access_level\|clear_all\|auto_start\|queue_info" server/ --include="*.py" | grep -v __pycache__

# 2. F9 sha256 改后：对比 manifest 一致性
python/python.exe -c "from server.core.deps_check import sha256_file; print(sha256_file('requirements.txt'))"
# 改前改后输出应一致

# 3. 全量：跑现有测试
python/python.exe -m pytest server/tests/ tests/ -v

# 4. F10 curl_cffi：启动验证日志
# 应看到 [SEARCH] 使用 curl_cffi（而不是"不可用"）
```

---

*合并自 AUDIT-ponytail.md + REVIEW-ponytail-P6.md · 报告路径：`C:\Sidemate\FIXES-ponytail.md`*
