# Python 后端全面代码审计报告

**项目**: Sidemate 0.9 patch3
**日期**: 2026-06-09
**审计范围**: `C:\tmp\_Sidemate_0.9_patch3\server\` 下全部 Python 代码
**审计人**: AI Agent (general-purpose-2)
**代码规模**: 9 包 / 28+ 模块 / 5 路由 / ~65 个 Python 文件

---

## 审计维度与发现汇总

| 维度 | P0 | P1 | P2 | 合计 |
|------|----|----|----|----|
| 1. 依赖完整性 | 2 | 1 | 1 | 4 |
| 2. 依赖冲突 | 0 | 2 | 1 | 3 |
| 3. 警告处理 | 0 | 1 | 1 | 2 |
| 4. 死代码 | 0 | 2 | 2 | 4 |
| 5. 空函数 / 空实现 | 0 | 1 | 2 | 3 |
| 6. 技术债务 | 1 | 3 | 3 | 7 |
| 7. 安全 | 1 | 2 | 1 | 4 |
| **合计** | **4** | **12** | **11** | **27** |

---

## 1. 依赖完整性 (Dependency Integrity)

### P0-DEP-01: faiss 在 deps_check 中声明但不在 requirements.txt 中

**文件**: `core/deps_check.py`
**位置**: `REQUIRED_DEPS` 列表
**描述**: `REQUIRED_DEPS` 包含 `("faiss", "faiss_cpu", "kb")`，但 `requirements.txt` 中没有 `faiss-cpu` 或任何 faiss 相关包。如果依赖检查通过但实际未安装，知识库功能将在运行时崩溃。
**建议**: 在 `requirements.txt` 中添加 `faiss-cpu` 并锁定版本，或从 `REQUIRED_DEPS` 中移除该条目。

### P0-DEP-02: openai 在 deps_check 中声明但不在 requirements.txt 中

**文件**: `core/deps_check.py`
**位置**: `REQUIRED_DEPS` 列表
**描述**: `REQUIRED_DEPS` 包含 `("openai", "openai", "cloud")`，但 `requirements.txt` 中没有 `openai` 包。`core/cloud_engine.py` 和 `core/agent_loop.py` 都深度依赖 OpenAI SDK（Function Calling、流式响应）。如果用户未手动安装，云端模式和 Agent 功能将完全不可用。
**建议**: 在 `requirements.txt` 中添加 `openai>=1.0.0` 并锁定版本。

### P1-DEP-03: curl_cffi 为可选依赖但无优雅降级

**文件**: `core/search_engine.py`
**描述**: 搜索引擎优先使用 `curl_cffi` 进行 Bing 搜索，如果未安装则回退到 `httpx`。但缺少 `curl_cffi` 时的日志仅为 debug 级别，用户无法感知搜索能力降级。此外，`curl_cffi` 不在 `requirements.txt` 中，也未在 `deps_check.py` 中声明。
**建议**: 将 `curl_cffi` 加入 `requirements.txt` 或至少在 `deps_check.py` 中标记为可选依赖，并在缺失时输出 warning 级别日志。

### P2-DEP-04: readability-lxml 缺少版本锁定

**文件**: `requirements.txt`
**描述**: `readability-lxml` 在 `requirements.txt` 中列出但无版本锁定。该库被 `core/search_engine.py` 用于网页正文提取，不同版本间 API 可能不兼容。
**建议**: 锁定版本号，如 `readability-lxml>=0.4.0`。

---

## 2. 依赖冲突 (Dependency Conflicts)

### P1-CON-01: httpx 与 requests 功能重叠

**文件**: `requirements.txt`
**描述**: 同时引入 `httpx>=0.28.0` 和 `requests==2.33.1`。项目中大部分新代码使用 `httpx`（流式引擎、云端引擎、搜索引擎），仅少量旧代码使用 `requests`。两个 HTTP 库并存增加打包体积（约 2MB+）和维护复杂度。
**涉及文件**:
- `core/stream_engine.py` — 使用 `httpx.stream()`
- `core/cloud_engine.py` — 使用 `httpx`
- `core/search_engine.py` — 同时使用两者
- `core/model_manager.py` — 使用 `httpx`
**建议**: 将所有 `requests` 调用迁移到 `httpx`，从 `requirements.txt` 中移除 `requests`。

### P1-CON-02: pypdf 与 PyPDF2 功能重叠

**文件**: `requirements.txt`
**描述**: 同时引入 `pypdf==6.10.2` 和 `PyPDF2==3.0.1`。两者均为 PDF 处理库，`pypdf` 是 `PyPDF2` 的后继项目。项目中 `knowledge_base.py` 和 `routers/kb.py` 混用两者。
**建议**: 统一使用 `pypdf`（活跃维护），移除 `PyPDF2`，并迁移所有 `PyPDF2` 调用。

### P2-CON-03: numpy 版本与 faiss-cpu 兼容性未声明

**文件**: `requirements.txt`
**描述**: `numpy==2.2.6` 但如果将来添加 `faiss-cpu`，部分 faiss 版本与 numpy 2.x 不兼容。当前因 faiss 未在 requirements.txt 中声明，该问题尚未暴露。
**建议**: 添加 `faiss-cpu` 时明确测试 numpy 兼容性，必要时锁定 numpy<2。

---

## 3. 警告处理 (Warning Handling)

### P1-WRN-01: 全局抑制 pkg_resources 弃用警告掩盖潜在问题

**文件**: `server.py:40`
**代码**: `warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")`
**描述**: 在服务启动时全局过滤 `pkg_resources` 弃用警告。虽然 `pkg_resources` 确实已被弃用，但全局过滤可能导致其他依赖的弃用警告也被忽略，影响依赖升级决策。
**建议**: 定位使用 `pkg_resources` 的代码，替换为 `importlib.metadata` 或 `importlib.resources`，然后移除全局过滤。

### P2-WRN-02: config.py 默认 HMAC 密钥仅在启动时警告一次

**文件**: `config.py:36-37`
**描述**: 使用默认 HMAC 密钥时仅打印一次警告。对于离线桌面应用影响有限（默认密钥在源码中可见），但如果未来支持网络功能，该默认密钥将成为安全隐患。
**建议**: 在 README 或配置文档中说明该密钥仅用于开发/测试，生产环境应通过环境变量 `SIDEMATE_HMAC_KEY` 设置自定义密钥。

---

## 4. 死代码 (Dead Code)

### P1-DEAD-01: research_action.py 已弃用但仍保留

**文件**: `actions/research_action.py`
**描述**: 整个文件标记为 `DeprecationWarning`（`warnings.warn("...已弃用...", DeprecationWarning)`），但仍包含完整实现（SEARCH/FETCH 标记机制）。该文件约 200+ 行代码，占用维护负担且可能误导新开发者。
**建议**: 删除该文件，或在文件顶部添加 `# DEPRECATED - DO NOT USE` 注释并在后续版本移除。

### P1-DEAD-02: prompts.py 保留 V1 弃用提示词

**文件**: `prompts.py`
**描述**: `STRATEGY_CONFIG`（V1）和 `STRATEGY_CONFIG_V2`（V2）并存。V1 版本已不再被调用但仍占用约 30+ 行代码。同样，`THINK_CONTROL` 字典中所有值均为空字符串 `""`，实际无任何作用。
**建议**: 删除 `STRATEGY_CONFIG`（V1），仅保留 `STRATEGY_CONFIG_V2`。如果 `THINK_CONTROL` 无实际效果，也应清理。

### P2-DEAD-03: llm_scheduler.py 与 generate_queue.py 大量重复代码

**文件**: `core/llm_scheduler.py`, `core/generate_queue.py`
**描述**: 两个调度器实现几乎相同的优先级队列模式（LLMScheduler 用 P0/P2，GenerateQueue 用 HIGH/LOW）。两者都有类似的僵尸检测、ticket/context manager 机制，代码重复率估计 70%+。
**建议**: 提取通用基类 `BasePriorityQueue`，两个调度器继承并特化，消除重复代码。

### P2-DEAD-04: think_processor.py 为极简包装

**文件**: `core/think_processor.py`
**描述**: 该模块仅包含最简 think 标签剥离逻辑，实际处理委托给 `response_filter` 模块。作为一个独立模块，其职责过于单薄。
**建议**: 将 think 标签处理逻辑合并到 `response_filter.py`，删除 `think_processor.py`。

---

## 5. 空函数 / 空实现 (Empty Functions)

### P1-EMPTY-01: 大量 except Exception: pass 吞没异常

**涉及文件**: 几乎所有模块，约 50+ 处
**主要分布**:
- `core/model_manager.py` — 模型加载、环境检测中的异常吞没
- `core/stream_engine.py` — 流式解析中的异常吞没
- `core/cloud_engine.py` — 云端调用中的异常吞没
- `core/search_engine.py` — 搜索降级中的异常吞没
- `knowledge_base.py` — KB 操作中的异常吞没
- `routers/chat.py` — 聊天路由中的异常吞没
- `routers/kb.py` — KB 路由中的异常吞没
- `routers/settings.py` — 设置路由中的异常吞没

**典型模式**:
```python
try:
    result = some_operation()
except Exception:
    pass  # 静默失败
```

**建议**: 逐步替换为 `except Exception as e: logger.debug(f"...: {e}")`，至少记录异常信息以便调试。优先修改关键路径（模型加载、流式响应、KB 搜索）。

### P2-EMPTY-02: config.py get() 方法无类型验证

**文件**: `config.py`
**描述**: 配置 get() 方法不验证返回值类型。例如，期望 `int` 的配置项可能返回 `str`，导致后续 `TypeError`。
**建议**: 在关键配置项（如 `max_tokens`、`temperature`）添加类型检查和默认值转换。

### P2-EMPTY-03: 部分路由端点缺少输入验证

**文件**: `routers/kb.py`, `routers/settings.py`
**描述**: 部分端点直接使用用户输入构建路径或查询，未做充分验证。例如 KB 文件上传路径未做严格的路径规范化。
**建议**: 在所有接受用户输入的端点添加 Pydantic 模型验证。

---

## 6. 技术债务 (Technical Debt)

### P0-TECH-01: routers/kb.py 文件过大（~52KB）

**文件**: `routers/kb.py`
**描述**: 单个路由文件约 52KB，包含知识库管理、文件上传、搜索、问答、扩展安装/卸载等大量功能。文件过大导致难以维护和测试。
**建议**: 拆分为多个子模块：
- `routers/kb_search.py` — 搜索与问答
- `routers/kb_files.py` — 文件管理
- `routers/kb_extensions.py` — 扩展管理

### P1-TECH-02: model_manager.py 魔法数字未提取为常量

**文件**: `core/model_manager.py`
**位置**: `_CHARS_PER_TOKEN = 1.5`, `_MAX_PROMPT_CHARS = 28000`
**描述**: 上下文长度和 token 估算使用硬编码魔法数字。不同模型的上下文窗口差异很大，当前值对所有模型使用相同限制。
**建议**: 将这些参数移入 `config.py` 或根据当前加载模型动态调整。

### P1-TECH-03: knowledge_base.py 文件过大（~69KB）

**文件**: `knowledge_base.py`
**描述**: 69KB 的单文件包含向量搜索、BM25 混合搜索、reranker、全文提取、分块、嵌入等所有 KB 功能。
**建议**: 拆分为 `kb/` 包：
- `kb/embeddings.py` — 向量嵌入
- `kb/search.py` — 搜索与混合检索
- `kb/chunker.py` — 文档分块
- `kb/extractor.py` — 全文提取
- `kb/reranker.py` — 重排序

### P1-TECH-04: cloud_engine.py MODEL_CAPABILITIES 硬编码 80+ 模型

**文件**: `core/cloud_engine.py`
**位置**: `MODEL_CAPABILITIES` 字典
**描述**: 80+ 个模型的能力信息硬编码在 Python 源码中。每次新增模型或更新能力需要修改源码并重新部署。
**建议**: 将模型能力配置外部化（JSON/YAML 配置文件），支持热加载。

### P2-TECH-05: generate_queue 与 llm_scheduler 功能重叠

**文件**: `core/generate_queue.py`, `core/llm_scheduler.py`
**描述**: 如前述（P2-DEAD-03），两个调度器代码高度重复，维护时需要同步修改两处。
**建议**: 同 P2-DEAD-03，提取通用基类。

### P2-TECH-06: stall_detector.py 存在 TODO 标记

**文件**: `intelligence/stall_detector.py`
**描述**: 代码中存在 TODO 注释，表明检测逻辑尚未完全实现。
**建议**: 完善 TODO 项或将其转为明确的 Issue 跟踪。

### P2-TECH-07: doc_action.py 使用全局缓存字典

**文件**: `actions/doc_action.py`
**位置**: `_kb_context_cache` 全局字典
**描述**: 使用模块级全局字典缓存跨阶段的 KB 上下文，无过期机制，可能导致内存泄漏。
**建议**: 使用 ` TTLCache` 或在生成完成后主动清理缓存条目。

---

## 7. 安全 (Security)

### P0-SEC-01: HMAC 签名默认密钥硬编码在源码中

**文件**: `config.py:33`
**代码**: `_SIDEMATE_HMAC_KEY_DEFAULT = "zhuoban-sidemate-default-key-v1"`
**描述**: `.sidemate` 扩展包的 HMAC-SHA256 签名使用硬编码默认密钥。由于桌面应用分发时源码可被反编译，攻击者可使用该密钥伪造恶意 `.sidemate` 扩展包。
**风险**: 任意代码执行（通过恶意扩展包）
**建议**:
1. 每次安装时生成随机密钥，存储在用户本地
2. 或使用操作系统密钥链（keyring）管理签名密钥
3. 短期方案：至少通过环境变量 `SIDEMATE_HMAC_KEY` 允许用户自定义

### P1-SEC-02: 扩展包验证器允许 .py 文件

**文件**: `validators/sidemate_validator.py`
**位置**: `ALLOWED_EXTENSIONS` 白名单
**描述**: 扩展包允许的文件类型包括 `.py` 文件。虽然 `.sidemate` 包有 HMAC 签名验证，但如果签名密钥泄露（见 P0-SEC-01），攻击者可以打包恶意 `.py` 文件在用户机器上执行任意代码。
**建议**:
1. 从 `ALLOWED_EXTENSIONS` 中移除 `.py`
2. 如果需要动态代码加载，改用受限的 DSL 或沙箱执行

### P1-SEC-03: routers/chat.py 路径遍历防护不完整

**文件**: `routers/chat.py`
**位置**: `_safe_filename()` 函数
**描述**: `_safe_filename()` 使用字符串替换清理文件名，但未使用 `os.path.normpath()` 或 `pathlib.PurePath` 进行规范化。某些 Unicode 或编码技巧可能绕过简单过滤。
**建议**: 使用 `pathlib.PurePath(name).name` 获取安全的文件名部分，拒绝包含路径分隔符的输入。

### P2-SEC-04: cloud_engine.py API Key 以 Base64 存储

**文件**: `core/cloud_engine.py`
**描述**: 云端 AI 服务的 API Key 以 Base64 编码存储在本地配置中。Base64 不是加密，仅是编码，任何能读取配置文件的人都能直接解码获取 API Key。
**建议**: 使用操作系统密钥链（Windows Credential Manager / macOS Keychain）存储 API Key，或至少使用 `cryptography.fernet` 加密。

---

## 审计总结

### 整体评估

Sidemate 0.9 patch3 的 Python 后端架构设计合理（FastAPI + SSE 流式 + 本地 LLM + 知识库），核心功能路径完整。但在依赖管理、代码组织和安全实践方面存在改进空间。

### 关键风险

1. **依赖声明不完整**（P0）: `faiss` 和 `openai` 在运行时被依赖但未在 `requirements.txt` 中声明，可能在全新安装时导致功能不可用。
2. **HMAC 默认密钥泄露风险**（P0）: 硬编码签名密钥使扩展包验证机制形同虚设。
3. **文件过大**（P0/P1）: `kb.py`（52KB）和 `knowledge_base.py`（69KB）严重影响可维护性。

### 优先修复建议

**立即修复（P0）**:
1. 将 `faiss-cpu` 和 `openai` 加入 `requirements.txt`
2. 解决 HMAC 默认密钥安全问题
3. 规划 `routers/kb.py` 和 `knowledge_base.py` 的拆分

**近期修复（P1）**:
1. 消除 `httpx` / `requests` 和 `pypdf` / `PyPDF2` 的重叠依赖
2. 删除 `research_action.py` 弃用代码
3. 将 `except Exception: pass` 替换为带日志的异常处理
4. 从扩展包白名单中移除 `.py` 文件

**后续优化（P2）**:
1. 提取 `generate_queue.py` / `llm_scheduler.py` 通用基类
2. 外部化 `MODEL_CAPABILITIES` 配置
3. 清理 `prompts.py` 弃用代码
4. 改进配置类型验证和输入验证

---

*报告生成时间: 2026-06-09*
*审计工具: 静态代码分析 + 模式匹配搜索*
*审计覆盖率: ~65 个 Python 文件，100% 模块覆盖*
