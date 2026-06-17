# Patch11 技术债务修复方案

**日期**: 2026-05-27  
**项目**: 桌伴 · Sidemate  
**版本**: Patch11 (v4.2.1 热修复后)

---

## 优先级定义

| 级别 | 含义 | 行动标准 |
|------|------|---------|
| 🔴 P0 | 影响用户体验/可靠性 | 本周修 |
| 🟡 P1 | 代码卫生/可维护性 | 下个迭代修 |
| 🟢 P2 | 长期关注 | 有空再改 |

---

## 🔴 P0 — 影响可靠性

### T1. 流式 think 折叠逻辑重构

**问题**: `models.py` L1766-1920 约 150 行嵌套逻辑，是本轮 3 个 bug 的源头（空回复、思考泄露、dangling think）。当前状态机在 `think_mode="free"` 时无法正确处理未闭合标签。

**根因**: 
- `_think_processed` 状态标志散落在多个 if/else 分支
- `think_mode="off"` 和 `think_mode="free"` 走的是同一套检测代码，靠 `_skip_think_for_off_mode` 标志区分
- dangling think（无闭合标签）时，流式路径直接 yield raw → 思考泄露到前端
- `_THINK_END_MARKERS` 只覆盖了 HTML 风格标签，没有覆盖 Qwen3 可能的其他格式

**方案**: 提取为独立类 `ThinkProcessor`

```python
# 新文件: think_processor.py

class ThinkProcessor:
    """统一的 think 标签流式处理器"""
    
    def __init__(self, think_mode: str, on_fold, on_text):
        self.think_mode = think_mode  # "off" | "free"
        self.state = "idle"           # idle → in_think → done
        self.buffer = ""
        self.on_fold = on_fold        # callback(think_content)
        self.on_text = on_text        # callback(text_content)
    
    def feed(self, full_output: str) -> list:
        """输入累积的 full_output，返回待 yield 的 (type, content) 列表"""
        actions = []
        if self.state == "done":
            # think 已处理，后续 token 直接作为正文
            new = full_output[len(self._last_processed_len):]
            if new:
                actions.append(("text", new))
            self._last_processed_len = len(full_output)
            return actions
        
        if self.state == "idle":
            if self._detect_think_start(full_output):
                self.state = "in_think"
                self.buffer = full_output
            else:
                # 没有 think 标签，直接正文
                new = full_output[len(self._last_processed_len):]
                if new:
                    actions.append(("raw", new))
                self._last_processed_len = len(full_output)
            return actions
        
        if self.state == "in_think":
            # 检查闭合
            think_content, after_text = self._try_split(full_output)
            if think_content is not None:
                # 找到闭合标签
                if len(think_content) >= 20 and self.think_mode != "off":
                    actions.append(("fold", think_content))
                if after_text:
                    actions.append(("text", after_text))
                self.state = "done"
                self._last_processed_len = len(full_output)
            elif self._should_timeout(full_output):
                # 超时/足够长 → 强制关闭 dangling think
                tag_end = self._find_tag_body_end(full_output)
                body = full_output[tag_end:].strip()
                if len(body) > 100:
                    # 长内容 = 思考，丢弃
                    pass
                else:
                    actions.append(("text", body))
                self.state = "done"
                self._last_processed_len = len(full_output)
            return actions
```

**改动范围**:
- 新增 `think_processor.py`（~120 行）
- 修改 `models.py` `chat_stream()` 中 L1766-1920 替换为 `ThinkProcessor` 调用（约 -100 行）
- 修改 `models.py` 中的 `_detect_think_tags()` / `_strip_think()` 保留但标记为 legacy

**风险**: 中。核心路径改动，需要充分测试 chat/kb/code 三种模式。

**预计工作量**: 2-3 小时（含测试）

---

### T2. chat.py SSE 流中阻塞 sleep

**问题**: `chat.py` L634 使用 `time.sleep(0.3)` 阻塞当前线程。在 SSE 异步流中，这会阻塞事件循环。

**方案**: 替换为 `asyncio.sleep`

```python
# Before (chat.py ~L634)
time.sleep(0.3)

# After
import asyncio
await asyncio.sleep(0.3)
```

**前提**: 确认该函数是否为 async。如果是同步 generator（`def _stream_gen()`），需要改为 `async def _stream_gen()` + 前端 SSE 改用 `StreamingResponse` 的 async 模式。

**改动范围**: 
- `chat.py` _stream_gen 函数签名 + sleep 调用
- 前端不需要改（SSE 协议不变）

**风险**: 低。纯替换，逻辑不变。

**预计工作量**: 30 分钟

---

## 🟡 P1 — 代码卫生

### T3. 清理废弃 `SEARCH_SYSTEM_PROMPT`

**问题**: `prompts.py` L99-102 已标记 `[DEPRECATED]`，但仍被 `STRATEGY_CONFIG` 和预览端点引用。如果 task_classifier 分到 "search" 策略，会拿到废弃 prompt。

**方案**:
1. 从 `STRATEGY_CONFIG` 中移除 `"search"` 策略条目
2. 将 `SEARCH_SYSTEM_PROMPT` 重命名为 `_DEPRECATED_SEARCH_SYSTEM_PROMPT`（下划线前缀警告）
3. 在 `resolve_strategy()` 中，"search" 策略 fallback 到 "default"
4. 下个版本彻底删除

**改动范围**: `prompts.py` 仅

**预计工作量**: 15 分钟

---

### T4. 清理废弃端点 `/api/models/import`

**问题**: `settings.py` L304-308 挂着一个已废弃的导入端点。

**方案**: 删除或改为返回 `410 Gone`

```python
# 方案A: 删除
# 直接删掉这个路由函数

# 方案B: 返回 410
@app.post("/api/models/import")
async def api_models_import_deprecated():
    raise HTTPException(status_code=410, detail="此接口已废弃，请使用 .sidemate 包导入")
```

**改动范围**: `routers/settings.py` 仅

**预计工作量**: 5 分钟

---

### T5. 前端 API 地址统一

**问题**: `chat.js`, `qa.js`, `minutes.js` 等文件中 `typeof API !== 'undefined' ? API : ''` 重复 ~30+ 次。

**方案**: 提取为工具函数

```javascript
// static/js/core/utils.js (新增或在现有 utils 中追加)
function apiUrl(path) {
    const base = (typeof API !== 'undefined') ? API : '';
    return base + path;
}

// 使用
// Before: fetch((typeof API !== 'undefined' ? API : '') + '/api/chat', ...)
// After:  fetch(apiUrl('/api/chat'), ...)
```

**改动范围**: 
- 新增或修改 `static/js/core/utils.js`
- 修改 `chat.js`, `qa.js`, `minutes.js`, `settings.js` 中的 ~30 处

**预计工作量**: 30 分钟（机械替换）

---

### T6. 前端重连后刷新 KB 状态（#84）

**问题**: `errors.js` 的 `retryConnect()` 只调了 `refreshStatus` 和 `refreshActionBar`，没刷新 KB 文档列表。用户从 KB tab 断连再重连后看到过时列表。

**方案**: 在 `retryConnect()` 成功回调中增加 KB 刷新

```javascript
// errors.js retryConnect() 回调中追加
if (typeof refreshKBDocuments === 'function') {
    refreshKBDocuments();
}
```

**改动范围**: `static/js/core/errors.js` 仅

**风险**: 低。增加一个条件调用，不影响现有逻辑。

**预计工作量**: 10 分钟

---

## 🟢 P2 — 长期关注

### T7. models.py 巨型文件拆分（2431 行）

**现状**: 单文件承载 GenerateQueue、ModelManager（含 chat_stream、_build_prompt、calc_kb_context_budget、think 处理等）

**建议拆分方案**:

| 新文件 | 内容 | 预计行数 |
|--------|------|---------|
| `generate_queue.py` | GenerateQueue + GenerateTicket | ~150 行 |
| `think_processor.py` | ThinkProcessor 类（T1 产出） | ~120 行 |
| `prompt_builder.py` | _build_prompt + calc_kb_context_budget | ~300 行 |
| `models.py`（保留） | ModelManager 骨架 + pipe 管理 | ~600 行 |

**前提**: T1（think 重构）先完成，否则拆分时容易引入 bug。

**风险**: 高。核心模块拆分，需要全量回归测试。

**预计工作量**: 4-6 小时（含测试）

**建议**: 暂不动。等项目稳定后有大块时间再做。

---

### T8. knowledge_base.py 巨型文件（2007 行）

**现状**: 含嵌入管理、检索、文档 CRUD、reranker、状态机等。

**建议**: 功能稳定后按模块拆分。低优先级，不影响开发和用户体验。

---

### T9. global 变量清理（7 处）

**现状**: `config.py`, `knowledge_base.py`, `models.py`, `routers/kb.py`, `routers/settings.py` 使用 global 实现单例。

**评估**: 离线部署、单进程架构下 global 单例完全够用。改成依赖注入或模块级单例是"好看但没必要"的改动。**不建议动**。

---

## 执行建议

### 立即可做（本周）
1. **T3** 清理 SEARCH_SYSTEM_PROMPT（15min）
2. **T4** 清理废弃端点（5min）
3. **T6** 前端重连刷新 KB（10min）

### 下个迭代
4. **T1** 流式 think 折叠重构（2-3h，核心改动）
5. **T2** 替换阻塞 sleep（30min）
6. **T5** 前端 API 地址统一（30min）

### 暂不动
7. T7 models.py 拆分（风险高）
8. T8 knowledge_base.py 拆分（低优先）
9. T9 global 变量（没必要）

---

## 修复记录

| 任务 | 状态 | 日期 |
|------|------|------|
| Patch11 6 个测试 bug | ✅ 已修复 | 2026-05-27 |
| T1 think 重构 | 🔲 待实施 | - |
| T2 阻塞 sleep | 🔲 待实施 | - |
| T3 废弃 prompt | 🔲 待实施 | - |
| T4 废弃端点 | 🔲 待实施 | - |
| T5 API 地址统一 | 🔲 待实施 | - |
| T6 KB 重连刷新 | 🔲 待实施 | - |
