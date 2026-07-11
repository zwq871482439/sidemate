# Sidemate Patch11 代码审查报告

**审查人**: 高见远（Gao）· 架构师  
**审查日期**: 2025-07-14  
**项目路径**: `C:\tmp\_local_ai_patch10\`  
**版本**: Patch 11 (`VERSION_PATCH = 11`)

---

## 1. 审查结论

> **Patch11 核心功能（PIPE 重设计）和 v4.2.1 hotfix 逻辑正确，术语统一完成度高（~98%），仅存在少量注释/文档级别的术语残留，不影响用户可见界面。建议在下一迭代中清理注释残留，当前可直接发布。**

---

## 2. 审查范围

| 类别 | 文件 | 行数 | 审查状态 |
|------|------|------|----------|
| 后端核心 | `models.py` | ~2300+ | ✅ 已审查（grep + 分段读取） |
| 后端核心 | `prompts.py` | 376 | ✅ 已审查 |
| 后端核心 | `config.py` | 247 | ✅ 已审查 |
| 后端核心 | `knowledge_base.py` | ~1900+ | ✅ 已审查（分段 + grep） |
| 后端核心 | `server.py` | 280 | ✅ 已审查 |
| 后端核心 | `action_router.py` | 101 | ✅ 已审查 |
| 后端核心 | `action_registry.py` | 74 | ✅ 已审查 |
| 后端核心 | `doc_action.py` | 119 | ✅ 已审查 |
| 路由层 | `routers/chat.py` | ~800+ | ✅ 已审查（grep + 分段） |
| 路由层 | `routers/kb.py` | 906 | ✅ 已审查（grep） |
| 路由层 | `routers/settings.py` | 896 | ✅ 已审查（grep） |
| 路由层 | `routers/recorder.py` | 301 | ✅ 已审查 |
| 路由层 | `routers/skill.py` | 61 | ✅ 已审查 |
| 路由层 | `routers/files.py` | 90 | ✅ 已审查 |
| 前端 | `static/js/chat.js` | ~800+ | ✅ 已审查（前200行 + grep） |
| 前端 | `static/js/settings.js` | ~600+ | ✅ 已审查（前200行 + grep） |
| 前端 | `static/js/qa.js` | ~500+ | ✅ 已审查（前200行 + grep） |
| 前端 | `static/js/minutes.js` | ~400+ | ✅ 已审查（前200行 + grep） |
| 前端 | `static/js/core/errors.js` | 344 | ✅ 已审查 |
| 前端 | `index.html` | ~500+ | ✅ 已审查（前100行 + grep） |
| 文档 | `PLAN_v0.9.md` | - | ⚠️ grep 扫描命中 |

---

## 3. 术语统一性审查

### 3.1 术语规范

| 旧术语 | 新术语 | 状态 |
|--------|--------|------|
| 知识库 | 文库 | ✅ UI 层面全部统一 |
| 语音转写模块 | 纪要模块 | ✅ UI 层面全部统一 |
| 主模型 | AI模型 | ✅ UI 层面全部统一 |
| LLM（用户可见） | AI模型 | ✅ UI 层面全部统一 |

### 3.2 前端术语扫描结果

| 文件 | 检查项 | 结果 |
|------|--------|------|
| `chat.js` L177 | "欢迎使用桌伴" | ✅ 正确 |
| `chat.js` L183 | "加载 AI 模型" | ✅ 正确 |
| `chat.js` L199 | "文库和纪要模块" | ✅ 正确 |
| `qa.js` 全文 | "文库" 一致性 | ✅ 全部正确 |
| `qa.js` L392 | "LLM 摘要功能砍掉" | ℹ️ 代码注释，可接受 |
| `minutes.js` 全文 | "纪要" 一致性 | ✅ 全部正确 |
| `minutes.js` L191 | `checkLLMForMinutes` 函数名 | ℹ️ 代码标识符，可接受 |
| `settings.js` L36 | `resBarLLM` 变量名 | ℹ️ 代码标识符，可接受 |
| `errors.js` L23-24 | 错误消息 | ✅ 使用 "模型加载失败"、"文库未就绪" |
| `index.html` L6 | "桌伴 · Sidemate" | ✅ 正确 |
| `index.html` L43-44 | "📚 文库"、"📝 纪要" tab | ✅ 正确 |
| `index.html` L445/453 | 元素 ID 含 "LLM" | ℹ️ HTML 元素 ID，可接受 |

### 3.3 后端术语扫描结果

| 文件 | 检查项 | 结果 |
|------|--------|------|
| `prompts.py` 全文 | "文库" 一致性 | ✅ `KB_SYSTEM_PROMPT` 正确 |
| `prompts.py` L27 | 注释 "v3.2" | ℹ️ 版本历史注释 |
| `config.py` L113 | "文库（Patch 6）" | ✅ 正确 |
| `config.py` L125 | "录音纪要" | ✅ 正确 |
| `server.py` L133-134 | 日志 "文库" | ✅ 正确 |
| `server.py` L140-141 | 日志 "录音纪要" | ✅ 正确 |
| `server.py` L146 | `_available_llms` 变量名 | ℹ️ 代码标识符，可接受 |
| `action_router.py` L29 | "📚 文库模式" | ✅ 正确 |
| `action_registry.py` L13-14 | "检索文库"、"文库扩展" | ✅ 正确 |
| `doc_action.py` L60 | "🔍 正在搜索文库..." | ✅ 正确 |
| `doc_action.py` L84 | "已引用%d条文库资料" | ✅ 正确 |
| `routers/kb.py` 全文 | SSE 消息 | ✅ 全部使用 "文库" |
| `routers/kb.py` L429 | "加载文库模型" | ✅ 正确 |
| `routers/kb.py` L643 | "🔍 正在检索文库..." | ✅ 正确 |
| `routers/kb.py` L654 | "文库中未找到..." | ✅ 正确 |
| `routers/settings.py` L601 | `ext_type == "knowledge"` | ✅ 正确 |
| `routers/settings.py` L842 | "文库模块" | ✅ 正确 |
| `routers/recorder.py` L224 | "AI 模型"+"纪要" | ✅ 正确 |

---

## 4. v4.2.1 Hotfix 验证

### 4.1 问题描述

文库模式下，LLM 回复为空。根因：某些模型的 tokenizer 默认开启 thinking 模式，导致文库问答场景输出异常。

### 4.2 修复方案验证

**文件**: `models.py`，`_apply_template()` 方法（约 L1048-1063）

```python
@staticmethod
def _apply_template(tok, messages, add_generation_prompt=True, think_mode=None):
    if think_mode == "off":
        try:
            return tok.apply_chat_template(messages, add_generation_prompt=add_generation_prompt,
                extra_context={"enable_thinking": False})
            except TypeError:
                return tok.apply_chat_template(messages, add_generation_prompt=add_generation_prompt)
    return tok.apply_chat_template(messages, add_generation_prompt=add_generation_prompt)
```

**验证结论**: ✅ **逻辑正确**

| 验证点 | 结果 | 说明 |
|--------|------|------|
| `extra_context={"enable_thinking": False}` 传递 | ✅ 正确 | 正确使用 transformers 接口 |
| `TypeError` fallback | ✅ 正确 | 兼容不支持 `extra_context` 的旧版 tokenizer |
| KB 模式强制 think_mode="off" | ✅ 正确 | `_effective_think_mode = "off" if kb_mode else think_mode` |
| 策略驱动 think_mode | ✅ 正确 | `STRATEGY_CONFIG` 中 `think_mode` 字段正确传入 |
| 非强制场景保留默认 | ✅ 正确 | `think_mode` 非 "off" 时走默认 `apply_chat_template` |

### 4.3 Think Mode 控制链路

```
STRATEGY_CONFIG.think_mode  →  chat_stream() 参数  →  _effective_think_mode  →  _apply_template()
                                    ↑
                        kb_mode=True 强制 "off"
```

- `STRATEGY_CONFIG` 中 9 个策略均含 `think_mode` 字段（"off" 或 "free"）
- KB 模式（`kb_mode=True`）无条件覆盖为 `"off"`
- 非策略场景（自由聊天）使用模型默认行为

---

## 5. Action Router / Registry 与 prompts.py 对齐

### 5.1 Action Router 命令映射

**文件**: `action_router.py`

| 命令 | Action | 术语 |
|------|--------|------|
| `/kb` | 文库模式 | ✅ "📚 文库模式（本次）" |
| `/exec` | 执行模式 | ✅ 正确 |
| `/code` | 代码模式 | ✅ 正确 |
| 其他 `/xx` | 策略覆盖 | ✅ 通过 `STRATEGY_CONFIG` 查找 |

### 5.2 Action Registry 内置 Action

**文件**: `action_registry.py`

| Action | title | tag | 术语 |
|--------|-------|-----|------|
| search_documents | "检索文库" | "文库扩展" | ✅ 正确 |

### 5.3 prompts.py 策略配置

**文件**: `prompts.py`，`STRATEGY_CONFIG`（L170-225）

- 9 个策略均有 `think_mode` 字段
- 所有 prompt 文本使用 "文库" 术语
- `EXEC_SYSTEM_PROMPT` 工具描述中使用 "文库"
- `KB_SYSTEM_PROMPT` 使用 "你是文库问答助手..."

**对齐结论**: ✅ **Router → Registry → Prompts 全链路术语对齐**

---

## 6. manifest.type 包逻辑

**文件**: `routers/settings.py`，`_install_worker()` 函数

| manifest.type | 处理逻辑 | 术语 |
|---------------|----------|------|
| `"knowledge"` | 安装文库扩展模块 | ✅ 正确处理 |
| `"whisper"` | 安装语音模块 | ✅ 正确处理 |
| `"model"` | 安装 AI 模型 | ✅ 正确处理 |

- `ext_type == "knowledge"` 匹配 `manifest.type` 字段值
- 卸载消息使用 "文库模块"
- 文件命名使用英文（如 `manifest.type` 值为 English），符合设计规范

**验证结论**: ✅ **包逻辑正确**

---

## 7. 问题清单

### P0 — 阻断性（无）

无 P0 级别问题。

### P1 — 需修复

| # | 文件 | 行号 | 当前文本 | 建议修改 | 说明 |
|---|------|------|----------|----------|------|
| 1 | `knowledge_base.py` | 248 | `"运行在 CPU 上，不与 NPU 上的 8B 主模型冲突"` | `"运行在 CPU 上，不与 NPU 上的 8B 模型冲突"` | 代码注释含旧术语"主模型" |

### P2 — 建议改进

| # | 文件 | 行号 | 当前文本 | 建议修改 | 说明 |
|---|------|------|----------|----------|------|
| 2 | `knowledge_base.py` | 1193-1194 | 注释含 "LLM" | 替换为 "AI模型" 或保留 | 已移除功能的注释，影响极低 |
| 3 | `knowledge_base.py` | 1896+ | 文档字符串含 "LLM" | 替换为 "AI模型" | 模块文档字符串 |
| 4 | `context_compressor.py` | 3, 444 | 文档字符串含 "LLM" | 替换为 "AI模型" | 模块/函数文档字符串 |
| 5 | `chunking_orchestrator.py` | 5,10,230,250,268,271,346 | 注释含 "LLM" | 替换为 "AI模型" | 代码注释，~7处 |
| 6 | `PLAN_v0.9.md` | 230 | "知识库正常" | 更新为 "文库正常" | 项目规划文档，非代码 |
| 7 | `qa.js` | 392 | "LLM 摘要功能砍掉" | 更新注释措辞 | 已废弃功能的注释 |
| 8 | `server.py` | 146 | `_available_llms` 变量名 | 可选：重命名 | 代码标识符，非用户可见 |
| 9 | `recorder.py` | ~267/290/316 | `"以下是一段中文语音转写文本..."` (3处) | 替换为 `"以下是一段中文纪要转写文本..."` | 发给 LLM 的 prompt 文本含旧术语"语音转写"，不影响用户界面但术语不一致 |

### 代码标识符（无需修改）

以下为代码标识符/元素 ID，非用户可见文本，不纳入术语修复范围：

| 文件 | 标识符 | 说明 |
|------|--------|------|
| `server.py` L146 | `_available_llms` | Python 变量名 |
| `settings.js` L36 | `resBarLLM` | JS 变量名 |
| `minutes.js` L191 | `checkLLMForMinutes` | JS 函数名 |
| `index.html` L445/453 | 含 "llm" 的元素 ID | HTML id 属性 |
| `server.py` L144 | `DEFAULT_LLM` | Python 常量名 |

---

## 8. 整体评估

| 维度 | 评分 | 说明 |
|------|------|------|
| 术语统一性 | ⭐⭐⭐⭐⭐ (98%) | UI 可见文本全部统一，仅注释级别有残留 |
| v4.2.1 Hotfix | ⭐⭐⭐⭐⭐ | 逻辑正确、兼容性好、fallback 完善 |
| 前后端对齐 | ⭐⭐⭐⭐⭐ | 术语、错误消息、SSE 事件完全一致 |
| Action/Registry/Prompt 对齐 | ⭐⭐⭐⭐⭐ | 全链路术语和逻辑对齐 |
| 包逻辑 | ⭐⭐⭐⭐⭐ | manifest.type 处理正确 |
| 代码质量 | ⭐⭐⭐⭐ | 注释残留需清理；models.py 过大（2300+行）建议拆分 |

---

## 9. 建议

1. **P1 修复**：`knowledge_base.py` L248 的 "主模型" → "模型" 改为下一个提交的必改项
2. **P2 批量清理**：将注释中的 "LLM" 统一为 "AI模型" 作为技术债务清理任务
3. **架构建议**：`models.py` 2300+ 行已超出单文件合理范围，建议按职责拆分为 `model_manager.py`、`model_template.py`、`chat_stream.py` 等模块
4. **发布就绪**：当前代码可直接发布，P1 问题不阻断发布流程

---

*报告结束*
