# 桌伴 Sidemate — 代码审查报告

> 审查日期：2026-06-28
> 审查范围：`server/`（FastAPI 后端 + 静态前端 JS），重点核对工作区未提交改动（`cloud_pipeline.py` / `local_pipeline.py` / `chat.js`）及核心链路（pipelines / core / routers / 前端渲染）
> 性质：**仅形成报告，不执行修复**

---

## 第一部分：功能性 Bug 审查报告

下列问题按严重度排序。每条标注：位置、判定依据、触发条件、影响、建议方向（不修改代码）。

### 🔴 BUG-1（高 / 本次未提交改动引入的回归）— 云端「文档生成」模式保存时 `NameError`

- **位置**：[server/pipelines/cloud_pipeline.py:760](server/pipelines/cloud_pipeline.py)
- **代码**：
  ```python
  "doc_phase": "outline" if (action_mode == "doc" and _doc_outline_only) else None,
  ```
- **判定依据**：此行位于 `_run_agent_loop()` 函数体内，但 `_doc_outline_only` 只在 `run_cloud_pipeline()`（[:55](server/pipelines/cloud_pipeline.py)、[:159](server/pipelines/cloud_pipeline.py)）中定义，**从未作为 `_run_agent_loop` 的参数或局部变量出现**。该行是本次 `git diff` 新增的（见工作区改动）。
- **触发条件**：在线（cloud）模式 + 文档模式（`action_mode == "doc"`）。由于 `and` 短路，`action_mode != "doc"` 时不报错——所以普通聊天无感，**只有文档生成会崩**。
- **已用最小用例复现** Python 作用域行为：`action_mode=="doc"` 时抛 `NameError: name '_doc_outline_only' is not defined`，`"chat"` 时正常。
- **影响**：云端文档生成走到保存分支即抛异常 → 被 `run_cloud_pipeline` 外层 `except` 捕获（[:285](server/pipelines/cloud_pipeline.py)）→ 用户看到「处理过程中出错」且**整段对话不落库**（正文已流式显示但未保存，刷新即丢失）。
- **建议方向**：`_run_agent_loop` 内并无「仅提纲」语义（Agent 自行写 `.md` 并 `set_doc_status`），该字段在此函数中应恒为 `None`，或将 `_doc_outline_only` 作为参数传入。

### 🔴 BUG-2（高 / 既有代码）— 云端 Agent 预读附件时 `UnboundLocalError`

- **位置**：引用处 [server/pipelines/cloud_pipeline.py:471-473](server/pipelines/cloud_pipeline.py)，定义处 [:498](server/pipelines/cloud_pipeline.py)
- **代码**：
  ```python
  _agent_timeline_buf.append({"status": "kb_searching", ...})   # 471 行：使用
  _agent_timeline_buf.append({"status": "kb_done", ...})        # 472 行：使用
  ...
  _agent_timeline_buf = []   # 498 行：才首次赋值
  ```
- **判定依据**：`_agent_timeline_buf` 在函数内被赋值（498 行），故全函数视其为局部变量；471/472 行在赋值前引用 → `UnboundLocalError`。已用最小用例复现确认。
- **触发条件**：在线模式下用户**附带文件或引用 KB 文档**（`ctx.file_path` 非空且能解析出文本，进入 `if _doc_texts:` 分支，[:444](server/pipelines/cloud_pipeline.py)）。
- **影响**：`doc_loaded` / `agent_status` 事件已 yield 给前端，但随即抛异常 → 外层 `except` 兜底 → 用户看到「处理过程中出错」。**在线模式"带文档提问/写作"这一核心路径会失败。**
- **建议方向**：把 `_agent_timeline_buf = []`（以及 `_artifacts` 等收集变量）提前到函数顶部、preload 分支之前初始化。
- **备注**：建议实测确认该分支线上触发频率（若用户多在本地模式带文档，则线上暴露较少，但代码缺陷确凿）。

### 🟠 BUG-3（中）— `summarize_history` 工具必定 `KeyError`，功能完全失效

- **位置**：[server/core/agent_loop.py:641](server/core/agent_loop.py)
- **代码**：`stats["summarizes"] += 1`，而 `stats` 初始化（[:243-249](server/core/agent_loop.py)）只含 `searches/fetches/kb_hits/docs/start_time`，**无 `summarizes` 键**。
- **判定依据**：其余可选计数项都用安全写法 `stats["x"] = stats.get("x", 0) + 1`（如 `time_queries`/`calculations`），唯独 `summarizes` 用 `+= 1` 直接读取未初始化键。
- **影响**：模型调用 `summarize_history` 压缩历史时，进入工具即抛 `KeyError` → 被 `_execute_tool` 的宽 `except` 捕获（[:1178](server/core/agent_loop.py)）→ 返回「工具执行失败」。**长对话压缩工具形同虚设**（虽是兜底功能，但与设计意图不符）。
- **建议方向**：改用 `stats["summarizes"] = stats.get("summarizes", 0) + 1`，或在初始化时补齐键。

### 🟠 BUG-4（中 / 安全）— `fetch_url` 的 SSRF 校验可被 HTTP 重定向绕过

- **位置**：校验 [server/core/search_engine.py:67 `classify_url`](server/core/search_engine.py)，实际请求 [:241 `_http_get`](server/core/search_engine.py)（`allow_redirects=True` / `follow_redirects=True`）
- **判定依据**：`classify_url` 只在请求**前**对原始 URL 做一次 DNS 解析与分类；而真正抓取时跟随重定向且会重新解析新主机。代码注释自己也写了「实际请求时应禁止跟随重定向到新主机」，但实现仍开启重定向。
- **影响**：一个公网 URL 可 `302` 跳转到 `http://127.0.0.1:8976/...`、内网地址或云元数据端点（`169.254.169.254`），抓取层不会再次分类即放行 → SSRF。另存在 DNS rebinding（两次解析时间差）窗口。
- **缓解现状**：应用绑定 `127.0.0.1` + 默认 CORS 严格，攻击面主要是「诱导模型抓取内网」；对个人本地应用风险中等。
- **建议方向**：抓取时关闭自动重定向、对每一跳重新 `classify_url`；或自定义 redirect 钩子做逐跳校验。

### 🟡 BUG-5（中低 / 安全）— 流式渲染阶段绕过 DOMPurify，存在 DOM-XSS 窗口

- **位置**：流式渲染统一用 `{sanitize:false}`（[chat.js:456/522/529/601](server/static/js/chat.js)），仅历史/最终渲染 `_renderSingleMsg → _renderMsgBody(content)` 默认 `sanitize=true`（[chat.js:259](server/static/js/chat.js)、[utils.js:385](server/static/js/core/utils.js)）。
- **判定依据**：`innerHTML` 注入未净化的模型/工具输出。`<script>` 经 innerHTML 不执行，但 `<img onerror=...>`、`<svg onload=...>` 等事件处理器**会在流式期间触发**。
- **影响**：在线 Agent 模式下，模型会转述 `fetch_url` 抓取的网页正文与 KB 文档内容（均可被外部影响）。若其中含事件处理器型 payload，会在流式渲染窗口执行（之后历史重渲染才净化，但为时已晚）。本地单用户场景影响有限，但属真实 XSS 面。
- **建议方向**：流式阶段也走一层轻量净化（或至少剥离 `on*` 属性 / `<img>`），或用 textContent 增量 + 末尾一次性净化重排。

### 🟡 BUG-6（低 / 安全）— `calculator` 允许 `**` 与 `pow`，可被诱导算力 DoS

- **位置**：[server/core/agent_loop.py:50 `_SAFE_MATH_BINOPS`](server/core/agent_loop.py) 含 `ast.Pow`；[:51 `_SAFE_MATH_FUNCS`](server/core/agent_loop.py) 含 `pow`。
- **判定依据**：字符过滤未拦 `*`，AST 白名单放行幂运算。`9**9**9` 这类表达式会让 Python 计算超大整数，造成 CPU/内存阻塞（注：该工具在线程池执行，无超时与位数上限）。
- **影响**：恶意 prompt 可诱导模型调用 `calculator("9**9**9**9")` 拖垮工作线程。整体计算器实现（纯 AST 求值、无 `eval`、字符+节点双白名单）**是本项目安全亮点**，此为唯一遗漏点。
- **建议方向**：对指数大小/结果位数设上限，或移除 `**`/`pow`。

### 🟡 BUG-7（低 / 安全）— `file_path` 参数可读取服务器任意文件

- **位置**：[server/routers/chat.py:244-251](server/routers/chat.py)
- **代码**：`if os.path.exists(file_path): ... process_uploaded_file(file_path, ...)`，`file_path` 来自请求体且未限制在上传/工作区目录内。
- **影响**：请求方可传任意存在的本机路径，其内容会被读出并注入 prompt（云端模式下进而发往外部 API）。受 `127.0.0.1` 绑定 + 默认严格 CORS 限制，主要风险是本机恶意页面/进程读取本地文件。
- **建议方向**：将上传文件路径限定在 `UPLOAD_DIR` / 会话 `workspace/` 之内（与 `safe_workspace_path` 一致）。

### ⚪ 其他较小问题（NIT / 待确认）

| 编号 | 位置 | 说明 |
|---|---|---|
| N-1 | [cloud_pipeline.py:709](server/pipelines/cloud_pipeline.py) | `elapsed = time.time() - ctx.__dict__.get('_t0', ...)` 为死代码：`_t0` 从未设置，后续只用 `_elapsed`。 |
| N-2 | [files.py:163](server/routers/files.py) | `re.match(r'^[...]+$', doc_id)` 的 `$` 允许结尾换行（`"x\n"` 可通过校验）。实际拼成的文件名不存在，影响极小，建议用 `\Z` 或 `fullmatch`。 |
| N-3 | [access_token.py:338](server/core/access_token.py) | `filter_private_docs` 先 `verify_token`（持锁）后在锁外读 `self._tokens_cache.get(token)`，存在轻微 TOCTOU；非安全关键，建议合并到一次持锁读取。 |
| N-4 | [cloud_engine.py:906](server/core/cloud_engine.py) `test_connection` | 把表单传入的**原始** key 交给 `_decode_api_key`（按 base64 解码），极端情况下「恰好是合法 base64 的原始 key」会被错误解码。概率低。 |
| N-5 | [chat.py:855 `api_file_upload`](server/routers/chat.py) | 上传写盘前未对 `content` 做扩展名/类型白名单（仅大小限制 + 文件名净化）；工作区下载按扩展名给 MIME，可被用作任意文件中转（本地场景影响小）。 |

> ✅ 已**正面核对**的未提交改动：
> - `local_pipeline.py` 新增的 `_doc_outline_only` / `action_mode` 引用都在 `run_local_pipeline` 同一作用域内，**正确无误**。
> - `chat.js` 的 history 过滤改动（丢弃 `content` 为空的 assistant 中间态消息）是**合理的 bug 修复**，不引入回归。

---

## 第二部分：综合代码审查报告（质量 / 架构 / 可维护性）

### 1. 总体评价

项目工程化程度高：启动流程（看门狗 + 轻量 lifespan + 后台初始化状态机）、依赖完整性校验（manifest + SHA256）、日志轮转、SSE 管道分层（local / cloud / parallel / compare）、Agent 工具注册表、KB 权限/令牌系统、配置统一中心（`config.py`）都体现了成熟的设计。安全意识整体不错（路径穿越防护、SSRF 分类、安全计算器、CORS 严格默认、API Key 脱敏显示）。主要欠账在**超大文件的复杂度**与**保存/渲染逻辑的多处复制粘贴**——本次 BUG-1 正是这种重复导致的「修一处漏一处」。

### 2. 架构与设计亮点 👍

- **配置单一真相源**：`config.py` 集中所有可调参数 + 版本号，前端/launcher 统一取值；带内存缓存与写后失效（[config.py:286-306](server/config.py)）。
- **启动鲁棒性**：`_bg_init_worker` 每步独立 `try/except`、`finally` 保证 `ready` 终态（[server.py:221-360](server/server.py)）；进度文件上报与 Launcher 解耦。
- **路径安全设计清晰**：`safe_workspace_path` 用 `normpath` + 前缀校验 + 绝对路径/null byte 拒绝（[doc_session.py:70-110](server/core/doc_session.py)）；`chat_id` 多处正则白名单。
- **安全计算器**：纯 AST 递归求值替代 `eval`，字符级 + AST 节点双白名单（[agent_loop.py:66-141](server/core/agent_loop.py)），是替代「代码执行工具」的好范例。
- **云端错误翻译**：`_translate_cloud_error` 把 SDK 异常映射为友好中文 + 结构化 `error_type`（[cloud_engine.py:50-167](server/core/cloud_engine.py)）。
- **令牌系统**：`AccessTokenManager` 全程持锁、LRU 淘汰、按 doc/session 撤销、私密文档按令牌粒度过滤（[access_token.py](server/core/access_token.py)）。

### 3. 主要改进建议

**(A) 文件体量与圈复杂度**
- 单文件过大：`agent_loop.py`（1480 行）、`chat.py`（1071 行）、`cloud_pipeline.py`（919 行）、前端 `chat.js`（3242 行）、`settings.js`（2070 行）。
- `_execute_tool`（[agent_loop.py:532-1198](server/core/agent_loop.py)）一个方法用 `elif` 串联近 20 个工具分支；`run_cloud_pipeline` 单函数承载路由 + KB 注入 + doc 分支 + 保存。建议按工具/职责拆分（如工具分派表 `dict[name]→handler`，与 `TOOL_REGISTRY` 对齐），既降复杂度也便于单测。

**(B) 保存/渲染逻辑重复，易「修一处漏一处」**
- 「保存 assistant 消息 + done 事件」在 `cloud_pipeline._run_agent_loop` / `cloud_pipeline._save_and_done` / `local_pipeline` / `_base.py` 各有一份近似实现；`doc_phase=="outline"` 标记需要在 3 处分别打补丁（`_base.py:439`、`local_pipeline:637`、`cloud_pipeline:760`）——这正是 BUG-1 的温床。建议抽取统一的 `save_assistant_turn(...)` 助手函数。
- 「中途停止保存」逻辑在 cloud/local 两个 `finally` 中几乎逐字重复。

**(C) 满屏函数内惰性 import**
- `from x import y` 写在函数体内的模式遍布全代码库（pipelines、routers、agent_loop）。优点是规避循环依赖与启动开销，缺点是：依赖关系不透明、热路径重复 import 调用、静态分析/IDE 跳转困难。建议梳理真正的循环依赖，把无循环风险的导入上移到模块顶部。

**(D) 异常处理粒度**
- 大量 `except Exception: ... log.warning(str(e)[:N])` 兜底。利于不中断用户体验，但也会**吞掉真正的逻辑缺陷**（BUG-2/BUG-3 都是被宽 `except` 兜底后表现为「通用错误」，难以定位）。建议关键路径区分「预期异常」与「编程错误」，后者至少完整 `log.exception` 记栈。

**(E) 上下文用量估算的脆弱性**
- `_calc_context_usage`（[chat.py:947](server/routers/chat.py)）用「字符数/1.5」粗估 token，并在 `cloud` 分支用 `CloudEngine.__new__(CloudEngine)`（绕过 `__init__`）只为读模型能力表。功能可用，但 `__new__` 取巧、估算口径与真实 `usage` 偏差较大。建议把能力查询做成独立纯函数/`@staticmethod`，避免构造未初始化实例。

**(F) 安全杂项**
- HMAC 密钥硬编码（[config.py:34](server/config.py)，注释已说明仅做完整性校验，非防伪）；API Key 以 base64 存于 `settings.json`（仅混淆非加密）。对本地应用可接受，但建议在文档/隐私说明中明确「明文等价存储」。
- 全应用无鉴权（localhost 设计），与 CORS 严格默认共同构成边界——建议在 README/隐私文档显式声明该威胁模型。

### 4. 测试与可观测性
- 存在 `tests/` 与 `server/tests/`（含安全纯函数、KB GPU gating、回归用例），方向正确。
- 但本报告中的 BUG-1/2/3 属于「特定模式 + 特定分支」路径，现有用例未覆盖。建议补：①云端 doc 模式端到端保存；②云端带附件（KB/上传）预读；③`summarize_history` 工具调用。三者都是纯逻辑、易写断言。

---

## 附录：本次审查的重点确认清单

| 项 | 结论 |
|---|---|
| 未提交 `cloud_pipeline.py` 改动 | ❌ 引入 BUG-1（云端 doc 保存 NameError） |
| 未提交 `local_pipeline.py` 改动 | ✅ 正确 |
| 未提交 `chat.js` 改动 | ✅ 合理修复 |
| 工作区路径穿越防护 | ✅ 充分（`safe_workspace_path` + chat_id 白名单） |
| 计算器代码执行风险 | ✅ 已用 AST 白名单杜绝 `eval`（仅遗留幂运算 DoS，见 BUG-6） |
| SSRF 防护 | ⚠️ 分类完善但重定向可绕过（BUG-4） |
| 前端 XSS | ⚠️ 历史渲染已净化，流式渲染未净化（BUG-5） |
| 云端配置变更生效 | ✅ 保存后已清缓存 client（[settings_cloud.py:244-247](server/routers/settings_cloud.py)） |
