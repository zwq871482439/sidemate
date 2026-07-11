# 文渊·Codex 代码审计报告

**日期**：2026-05-23  
**版本**：v0.8.x（patch10）  
**项目路径**：`C:\tmp\_local_ai_patch10\`  
**审计团队**：寇豆码（后端）、高见远（前端）、严过关（运行时Bug）

---

## 审计总览

| 审计维度 | 审查人 | 文件范围 | 发现数 |
|---------|--------|---------|--------|
| 后端代码审计 | 寇豆码 · 工程师 | 全部 .py（19 文件） | 21 项（0 P0, 9 P1, 12 P2） |
| 前端代码审计 | 高见远 · 架构师 | 全部 .js/.css/.html | 待汇总（已合并至下方） |
| 运行时Bug排查 | 严过关 · QA工程师 | 全部源文件 | 37 项（5 P0, 19 P1, 13 P2） |

**去重后合并统计**（去除交叉重复项）：

| 严重程度 | 数量 | 说明 |
|---------|------|------|
| **P0（必崩）** | **5** | 必定导致崩溃或数据丢失 |
| **P1（功能异常）** | **22** | 功能不可用或行为错误 |
| **P2（体验/优化）** | **20** | 性能、安全加固、可维护性 |
| **合计** | **47** | |

---

## 🔴 P0 — 必崩（5 项）

### P0-01: `server.py:210` — index.html 文件句柄泄漏
- **发现者**：严过关
- **描述**：`open(os.path.join(WORKSPACE_DIR, "index.html", ...)).read()` 文件句柄从不关闭。高并发下触发 `ResourceWarning` 或文件锁。
- **触发**：每次访问首页 `/`
- **修复**：改为 `with open(...) as f: return f.read()`

### P0-02: `routers/chat.py:678-684` — 模型并发卸载导致 chat_stream 崩溃
- **发现者**：严过关
- **描述**：`model_choice = loaded[0]` 后，agent 执行中模型被并发卸载，`mgr.chat_stream()` 内部崩溃。
- **触发**：用户A聊天时，用户B在设置页卸载模型
- **修复**：`chat_stream` 内部增加模型有效性校验

### P0-03: `config.py:222-224` — get() 返回 None 导致下游 TypeError
- **发现者**：严过关
- **描述**：key 既不在缓存也不在 DEFAULTS 时返回 None，`models.py` 中 `_cfg("xxx")` 做数值运算会 TypeError。
- **触发**：settings.json 配置键缺失时
- **修复**：关键调用点添加 `or default_fallback`

### P0-04: `routers/kb.py:645-649` — numpy vstack 空数组维度不匹配
- **发现者**：严过关
- **描述**：`kb.vectors` 被裁剪为空数组后，`np.vstack([kb.vectors, summary_vec])` 因 shape 不匹配崩溃。
- **触发**：删除文档所有 chunks 后重试摘要
- **修复**：检查 vectors 为空时直接赋值

### P0-05: `agent.py:437` — `True.group(0)` AttributeError 崩溃
- **发现者**：严过关
- **描述**：`_guess_intent` 返回 `(True, tool_name, params)` 而非 match 对象，后续 `tool_match.group(0)` 调用 `True.group(0)` 崩溃。
- **触发**：模型输出不含 `[TOOL_CALL:...]` 但被猜到意图时
- **修复**：`if hasattr(tool_match, 'group') else ""`
- **⚠️ 最容易在生产中触发的必崩 Bug**

---

## 🟠 P1 — 功能异常（22 项）

### 后端架构问题（寇豆码 + 严过关 共同发现）

| ID | 文件 | 问题 | 修复建议 |
|----|------|------|---------|
| P1-01 | `routers/chat.py:580-583` | scene 映射逻辑错误：`"chat" if old_mode == "qa" else "chat"` 始终为 "chat"，前端的 mode 参数被完全忽略 | 删除无效分支或修正映射 |
| P1-02 | `routers/chat.py:101-119` | `_new_chat_file()` 并发竞态：两个请求可能创建相同编号文件 | 使用文件锁或原子操作 |
| P1-03 | `config.py:176-224` | TTL 缓存竞态：save_config 后 5 秒内其他线程仍返回旧值 | save_config 后直接更新 _cache |
| P1-04 | `server.py:65-66` | 模块级 `_cfg_get` 在 settings.json 损坏时可能获得 None | 添加 fallback 值 |
| P1-05 | `routers/settings.py:350` | 双锁问题：settings.py 和 config.py 各用各的锁写 settings.json | 统一使用 config.py 的锁 |
| P1-06 | `routers/kb.py:516-519` | 异步处理线程未捕获异常，文档永远卡在 "processing" | 包裹 try/except，失败设 error 状态 |
| P1-07 | `routers/kb.py:612-618` | vectors 裁剪后 chunk_order 与 vectors 行数可能不一致 | 检查 keep_indices 为空时置 None |
| P1-08 | `agent.py:278-280` | `min(0, 8)` = 0 导致 agent 永不执行 | 确保 `scene_max_iter >= 1` |
| P1-09 | `routers/recorder.py:108-111` | Whisper 未加载完成时录音不会触发转写 | finish 时加入待处理队列 |
| P1-10 | `models.py:161-168` | 单例 `__new__` 的 lock 不覆盖 `__init__` | 使用模块级单例替代 |
| P1-11 | `routers/chat.py:1146` | `data: dict` 无法被 FastAPI 自动注入 request body | 改为 `Request` + `await request.json()` |
| P1-12 | `routers/chat.py:1264` | 同上，`api_chats_append` 的 body 始终为空 | 同上 |
| P1-13 | `routers/chat.py:976-1027` | filter 警告中 break 嵌套层级混乱，可读性差 | 重构为独立函数 |
| P1-14 | `routers/chat.py:619-621` | 上传文件未做大小预检，大文件可能 OOM | 先检查 `os.path.getsize()` |
| P1-15 | `routers/chat.py:1219-1223` | chats/switch 路径校验用 realpath 但存在性检查用原始路径 | 统一使用 real_path |
| P1-16 | `routers/kb.py:593` | 摘要锁无超时保护，LLM 卡死时锁永远持有 | 添加 lock 超时 |
| P1-17 | `routers/settings.py:660-666` | async 函数中同步读 UploadFile，大文件可能读到空数据 | 先读到内存/临时文件再传给同步函数 |
| P1-18 | `agent.py:668-669` | 直接访问 `skill_loader._registry` 私有属性 | 使用公开方法 |
| P1-19 | `routers/kb.py:139-140` | `_kb_sessions` 无大小限制，长期运行内存无限增长 | 添加 LRU 淘汰 |
| P1-20 | `static/js/api.js:38-46` | 全局 fetch monkey-patch 影响第三方库 | 仅业务代码使用 fetchWithTimeout |
| P1-21 | `static/js/settings.js:150-201` | refreshStatus 中两个 fetch 串行执行 | 使用 Promise.all 并行 |
| P1-22 | `models.py:57-59` | HIGH 请求取消 LOW 请求但前端无通知 | 返回特定错误码通知前端 |

---

## 🟡 P2 — 体验/优化（20 项）

| ID | 文件 | 问题 | 修复建议 |
|----|------|------|---------|
| P2-01 | `server.py:191-194` | 崩溃重启每次创建新空对话文件 | 检查最新文件是否为空，是则复用 |
| P2-02 | `static/js/chat.js:25-39` | Session 轮询后台标签页也持续请求 | 使用 visibilityState 暂停 |
| P2-03 | `static/js/chat.js:436-464` | 空对话导出 Markdown 有大量空行 | 过滤空消息 |
| P2-04 | `static/js/chat.js:496-497` | sendMessage 空消息检查可读性差 | 简化为 `!text && !pendingImageFile` |
| P2-05 | `routers/recorder.py:276` | live-transcribe session_id 传参方式不一致 | 确认前端传参方式 |
| P2-06 | `static/js/qa.js:156-166` | 面板折叠在首次加载时立即触发 | 延迟折叠或提供展开动画 |
| P2-07 | `routers/chat.py:90-94` | `_safe_chat_name` 未检查 null bytes | 添加 `\x00` 检查 |
| P2-08 | `routers/kb.py:239` | KB 安装包全量加载到内存，2GB 可能 OOM | 使用流式写入 |
| P2-09 | `routers/settings.py:1117-1118` | tempdir 清理在 Windows 上可能失败 | 使用 TemporaryDirectory 或延迟清理 |
| P2-10 | `static/js/chat.js:591-594` | variant 模式 history 截取包含超时消息 | 统一过滤条件 |
| P2-11 | `routers/chat.py` | chat 路由承担过多职责（聊天+agent+pipeline+历史），违反单一职责 | 拆分为独立模块 |
| P2-12 | `config.py` | 配置读写路径散落多处硬编码 | 集中管理 |
| P2-13 | `agent.py` | agent prompt 硬编码中文，国际化困难 | 抽取为配置 |
| P2-14 | `models.py` | GenerateQueue 优先级逻辑可进一步优化 | 评估是否需要更细粒度 |
| P2-15 | 全局 | 日志格式不统一，缺少结构化字段 | 统一为 JSON 格式日志 |
| P2-16 | 全局 | 前端 CSS 变量定义分散，主题切换不完整 | 统一 CSS 变量管理 |
| P2-17 | 全局 | 前端 JS 缺乏模块化，全局命名空间污染 | 考虑引入 ES Module |
| P2-18 | `routers/deps.py` | lazy import 模式增加调试难度 | 考虑依赖注入框架 |
| P2-19 | 全局 | 缺少健康检查端点 | 添加 `/api/health` |
| P2-20 | 全局 | 缺少 API 版本控制 | 考虑 `/api/v1/` 前缀 |

---

## 修复优先级建议

### 第一批：立即修复（P0 全部 + 高频触发的 P1）
1. **P0-05** `agent.py:437` — True.group(0) 崩溃（最容易触发）
2. **P0-04** `routers/kb.py:645` — numpy vstack 空数组
3. **P0-01** `server.py:210` — 文件句柄泄漏
4. **P0-03** `config.py:222` — get() 返回 None
5. **P0-02** `routers/chat.py:684` — 模型并发卸载
6. **P1-11/12** `chat.py:1146/1264` — FastAPI body 注入问题（pipeline 审批和消息追加不可用）
7. **P1-01** `chat.py:580` — scene 映射死代码
8. **P1-17** `settings.py:660` — 模型导入同步/异步混用

### 第二批：尽快修复（剩余 P1）
9. **P1-06** `kb.py:516` — 异步线程异常未捕获
10. **P1-03** `config.py` — TTL 缓存竞态
11. **P1-16** `kb.py:593` — 摘要锁无超时
12. **P1-02** `chat.py:101` — 新建对话竞态
13. 其他 P1 项

### 第三批：按需修复（P2）
- 按影响范围和用户感知度排序，逐步处理

---

## 架构层面建议

1. **路由拆分**：`chat.py` 承担了聊天、Agent、Pipeline、历史四个领域的逻辑，建议拆分为 `chat.py`、`agent.py`（路由层）、`pipeline.py`、`chat_history.py`
2. **统一锁策略**：当前 settings.py 和 config.py 各用各的锁写同一个文件，需要统一
3. **异步一致性**：部分 async 函数中混用同步 I/O，需要系统性排查和修正
4. **前端模块化**：当前全局 JS + fetch monkey-patch 的模式不利于扩展，v0.9 可考虑引入轻量模块化

---

*报告完毕。审计团队解散。*
