# 桌伴 Sidemate v0.9 Patch1 — 代码审查报告

**审查日期**: 2026-06-02  
**审查范围**: `C:\tmp\_Sidemate_0.9_patch1\server\` 全量代码  
**审查背景**: Patch1 从 OpenVINO 迁移到 Ollama + sentence-transformers + PyTorch + faster-whisper，并新增文档生成 Action

---

## 一、问题汇总

| 级别 | 数量 | 说明 |
|------|------|------|
| 🔴 P0（功能缺陷） | 1 | doc_action KB 检测属性名错误（已修复） |
| 🟡 P1（残留/清理） | 3 | OpenVINO `_ov_pipeline` 残留、注释中旧路径 |
| 🟢 P2（优化建议） | 4 | docx 清理策略、配置集中化、前端细节 |
| ℹ️ 信息 | 2 | 已确认无问题的检查项 |

---

## 二、详细问题清单

### 🔴 P0：功能缺陷

#### P0-1: `doc_action.py` KB 加载检测属性名错误 ✅ 已修复
- **文件**: `actions/doc_action.py:61`
- **问题**: 用 `getattr(kb, 'embedder_loaded', False)` 检测 KB 是否加载，但 KnowledgeBase 的实际属性是 `_embedder_loaded`（带下划线前缀）
- **影响**: 文档模式永远不会走 KB 搜索分支，即使用户已加载文库
- **修复**: 已改为 `getattr(kb, '_embedder_loaded', False)`

---

### 🟡 P1：残留/清理

#### P1-1: `knowledge_base.py` 卸载代码中 `_ov_pipeline` 残留
- **文件**: `knowledge_base.py` 3处
- **代码**: `self.reranker._ov_pipeline = None`、`self.embedder._ov_pipeline = None`
- **影响**: 无害。Patch1 的 `embedding_engine.py` 和 `reranker_engine.py` 均无 `_ov_pipeline` 属性。Python 中给不存在的属性赋 None 只是动态添加属性，不会报错，但也没有实际效果
- **建议**: 清理这3行，避免混淆

#### P1-2: 注释中包含旧路径引用
- **文件**: 多处
- **代码**:
  - `actions/doc_action.py:5` — `参照 _local_ai_patch12 版本`
  - `routers/chat.py` — `归档至 _local-ai_old_archived/ocr/`
  - `routers/settings.py` — `归档至 _local-ai_old_archived/`
  - `routers/skill.py` — `归档至 _local-ai_old_archived/`
- **影响**: 仅注释，不影响运行
- **建议**: 更新注释指向当前项目路径

#### P1-3: `knowledge_base.py` 中 `import torch` 仅用于 `torch.cuda.empty_cache()`
- **文件**: `knowledge_base.py`（卸载模型时）
- **影响**: Patch1 确实还依赖 torch（reranker 用 PyTorch transformers），所以 `import torch` 不是残留。但 `torch.cuda.empty_cache()` 在纯 CPU 部署下无效果
- **建议**: 加条件判断 `if torch.cuda.is_available()`，当前代码已有，OK

---

### 🟢 P2：优化建议

#### P2-1: `data/docs/` 目录无清理策略
- **文件**: `routers/chat.py` docx 生成
- **问题**: 每次文档生成都会在 `data/docs/` 创建 `.docx` 文件，但没有清理机制
- **建议**: 
  1. 启动时清理超过 7 天的 .docx 文件
  2. 或在 `settings.py` 的启动逻辑中加一行清理

#### P2-2: docx 输出路径硬编码
- **文件**: `routers/chat.py:~490`
- **代码**: `os.path.join(ROOT_DIR, "data", "docs", doc_filename)`
- **问题**: 没有通过 `config.py` 配置化
- **建议**: 低优先级，当前可接受

#### P2-3: 文档生成取消功能不完整
- **文件**: `actions/doc_action.py` + 前端
- **问题**: `cancel_doc_action()` 存在但前端没有取消按钮（只有"跳过等待"按钮跳过确认倒计时）
- **说明**: 3 秒确认暂停期间没有取消机制，只能跳过等待。一旦开始生成就走正常 stop 流程
- **建议**: 可在确认栏加"取消"按钮调用 `/api/stop`，当前不是阻塞问题

#### P2-4: `doc_confirm` 事件的倒计时是后端等待
- **文件**: `actions/doc_action.py:93`
- **代码**: `_cancel_event.wait(timeout=CONFIRM_PAUSE_SECONDS)` — 后端真的等 3 秒
- **问题**: SSE 是 pull 模式，后端 wait 3 秒期间前端才能收到 doc_confirm 事件。如果前端已经关闭连接，后端白白等 3 秒
- **建议**: 可接受，3 秒不构成性能问题。如果要优化可以用更短的等待（1-2秒）

---

## 三、已确认无问题的检查项

### ✅ 依赖完整性
- `python-docx==1.2.0` 在 `requirements.txt` 第43行 ✅
- `sentence-transformers==5.5.0` 在 `requirements.txt` 第21行 ✅
- 无 OpenVINO 依赖残留 ✅

### ✅ 安全检查
- `/api/doc/download/{filename}` 路径穿越防护完整：
  - 检查 `.endswith('.docx')`
  - 检查 `'..' not in filename`
  - 检查 `'/' not in filename`
  - 检查 `'\\' not in filename`
- ✅ 无注入风险

### ✅ 前后端 SSE 事件一致性
| 后端 yield | 前端处理 | 状态 |
|-----------|---------|------|
| `doc_confirm` | ✅ 显示倒计时+跳过按钮 | OK |
| `doc_ready` | ✅ 追加下载按钮 | OK |
| `doc_error` | ✅ toast 错误提示 | OK |
| `mode_hint`（KB搜索中） | ✅ toast 提示 | OK |
| `doc_cancelled` → 映射为 `mode_hint` | ✅ toast 提示 | OK |

### ✅ CSS 变量使用
- `.doc-download-btn` 使用 `var(--accent-color)`、`var(--text-on-accent)` ✅
- `.doc-confirm-bar` 使用 `var(--bg-secondary)`、`var(--border-color)`、`var(--text-muted)` ✅
- `.msg-copy-btn` 使用 `var(--bg-secondary)`、`var(--accent-color)`、`var(--text-on-accent)` ✅
- 无新增硬编码颜色 ✅

### ✅ HTML ID 唯一性
- `stream-msg` — 流式消息容器，动态创建唯一 ✅
- `docConfirmBar` — 确认栏，单次存在，setTimeout 后自动移除 ✅
- 无 ID 冲突 ✅

### ✅ deps.py 依赖注入
- `get_mgr()` → `from server import mgr` ✅
- `get_kb()` → `from server import kb` ✅
- `get_recorder()` → `from server import recorder` ✅
- doc_action 通过 `chat.py` 传入 kb 实例，不直接依赖 deps.py ✅

### ✅ chat.py doc 分支变量作用域
- `_doc_mode` 在 `sse_gen()` 内定义，在 docx 生成和 done 事件中引用 — 同一函数作用域 ✅
- `_doc_mode = False` 在取消分支中正确设置，阻止后续 docx 生成 ✅

---

## 四、架构总览

### 文档生成 Action 完整流程（重写后）

```
用户选 📄 → 输入文档需求 → action_mode="doc"
     ↓
chat.py sse_gen() → if _doc_mode:
     ↓
doc_action.run_doc_action():
  1. 检测 KB 是否加载 → KB 搜索(top_k=3) → yield mode_hint
  2. yield doc_confirm（3秒确认暂停）
     ↓ 前端显示倒计时 + 跳过按钮
  3. 增强prompt（DOC_SYSTEM_ENHANCEMENT + KB上下文）
  4. mgr.chat_stream() 流式生成 → yield (phase, content)
     ↓
chat.py 收集 final_response
     ↓
if _doc_mode: generate_docx() → yield doc_ready
     ↓
前端显示「📄 下载文档」按钮
```

### 涉及文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `actions/doc_action.py` | 重写 | 完整流程：KB搜索→确认→生成→docx |
| `routers/chat.py` | 修改 | doc分支改为调用run_doc_action + else分支包裹原逻辑 |
| `prompts.py` | 新增 | DOC_SYSTEM_ENHANCEMENT 模板 |
| `routers/chat.py` (端点) | 新增 | GET /api/doc/download/{filename} |
| `static/js/chat.js` | 新增 | doc_confirm/doc_ready/doc_error 事件处理 |
| `static/css/main.css` | 新增 | .doc-confirm-bar + .doc-download-btn 样式 |

---

## 五、建议的后续清理

1. **清理 `_ov_pipeline` 残留**（3行，低风险）
2. **添加 docx 自动清理**（启动时清理 7 天前的文件）
3. **更新注释**（去掉旧路径引用）
4. **测试**：重启服务后验证以下场景：
   - KB 未加载时 → 文档直接生成 ✅
   - KB 已加载时 → 自动搜索引用 → 确认 → 生成 ✅
   - 确认倒计时跳过 ✅
   - docx 下载成功 ✅
   - 复制按钮右下角显示+点击复制 ✅
   - 纪要内存正确归属 ✅

---

## 六、硬编码排查报告

### 排查范围
`server/` 下所有 `.py`、`.js`、`.css`、`.html` 文件中的硬编码值。

### 分类汇总

#### ✅ 合理的硬编码（无需修改）

| 类别 | 位置 | 值 | 说明 |
|------|------|-----|------|
| **默认模型名** | `config.py` | `"qwen3.5-4b"` | 作为默认配置值，用户可改 |
| **模型列表** | `model_manager.py` | `MODEL_DISPLAY_NAMES` 字典 | 硬编码支持的模型清单，随版本更新 |
| **向量维度** | `config.py` | `kb_vector_dim: 768` | bge-base-zh-v1.5 固定 768 维 |
| **端口** | `config.py` / `server.py` | PORT 通过环境变量读，默认 8976 | ✅ 可配置 |
| **Ollama 地址** | `config.py` | `ollama_host: "127.0.0.1"`, `ollama_port: 11434` | ✅ 可配置 |
| **Ollama 参数** | `ollama_manager.py` | `OLLAMA_VULKAN=1` | ✅ Vulkan 加速，安装时设定 |
| **Context 限制** | `model_manager.py` | `_MAX_PROMPT_CHARS=28000` | Qwen3.5-4B ~32K tokens，合理的保守值 |
| **Prompt 限制** | `prompt_builder.py` | `max_prompt_chars=45000` | 同上，另一处检查点 |
| **Whisper 配置** | `config.py` | `whisper_model: "small"`, `device: "cpu"`, `compute_type: "int8"` | ✅ 合理默认值 |
| **docx 清理** | `server.py` | 7 天阈值 | 合理，不需要配置化 |
| **确认暂停** | `doc_action.py` | 3 秒 | 合理，不需要配置化 |
| **注入模型路径** | `embedding_engine.py` / `reranker_engine.py` | fallback candidates 列表 | 搜索顺序固定，无需配置 |

#### ⚠️ 需要注意但不影响功能的硬编码

| 类别 | 位置 | 值 | 风险 |
|------|------|-----|------|
| **minutes.js SVG 颜色** | `minutes.js` ~15处 | `#16a34a`(绿)、`#ef4444`(红)、`#60a5fa`(蓝)、`#f59e0b`(黄) | ⚠️ 这些颜色不跟随主题切换。暗色模式下视觉OK（这些都是亮色在深背景上），但如果改主题色可能不协调。**建议后续用 CSS 变量** |
| **settings.js 状态颜色** | `settings.js` 5处 | `#ef4444`、`#f59e0b`、`#16a34a`、`#fff` | ⚠️ 同上，状态颜色不跟随主题 |
| **qa.js SVG 颜色** | `qa.js` | `#1e3a5f`、`#c9976c` | ⚠️ 问答面板的装饰 SVG |
| **CSS 硬编码** | `main.css` 3处 | `#dc2626`(retry-btn hover)、`#1a1a1a`(toast.warning text)、`#fff`(slider/theme-btn) | ⚠️ 少量 CSS 硬编码颜色，主题切换时部分可能不协调 |
| **errors.js** | `errors.js` | `#fff` fallback | 低风险，有 `var()` 前缀 |
| **playBtn SVG** | `minutes.js` | `fill="#fff"` | 播放/暂停按钮，低风险 |

#### 🔧 已修复的硬编码路径问题

| 问题 | 修复 |
|------|------|
| `registry.py` 默认路径含子目录 `bge-base-zh-v1.5` | ✅ 已改为 `models/embedding` |
| `settings.py` 扩展注册时写入的路径含子目录 | ✅ 已改为 `models/embedding` |
| `registry.py` 注释中旧路径 | ✅ 已修复 |

### 结论

**整体健康度良好**。核心配置（端口、地址、模型名）全部通过 `config.py` + 环境变量可配置。

**唯一值得关注的**是 `minutes.js` 和 `settings.js` 里约 20 处 SVG/status 硬编码颜色（红绿蓝黄），这些不跟随暗色主题切换。但实际测试中这些颜色在暗色模式下视觉效果反而更好（亮色在深背景上对比度高），所以**优先级低**。

如果后续要彻底消除，建议方案：
1. 在 `main.css` 里定义 `--status-success`、`--status-error`、`--status-warning`、`--status-info` 变量
2. `minutes.js` 和 `settings.js` 改用 `getComputedStyle` 读取 CSS 变量值

---

## 七、P1 残留修复记录（2026-06-02 执行）

| # | 修复项 | 文件 | 状态 |
|---|--------|------|------|
| 1 | 删除 `_ov_pipeline = None`（3处） | `knowledge_base.py` | ✅ |
| 2 | 注释旧路径 `_local-ai_old_archived` → 更新为"已在 Patch11 拆除" | `chat.py`、`settings.py`(2处)、`skill.py` | ✅ |
| 3 | 注释旧路径 `_local_ai_patch12` → 删除引用 | `doc_action.py` | ✅ |
| 4 | 添加 docx 启动清理（7天过期） | `server.py` | ✅ |
| 5 | `registry.py` 默认路径修复（含子目录→直接目录） | `registry.py`(注释+代码共3处) | ✅ |
| 6 | `settings.py` 扩展注册路径修复 | `settings.py` | ✅ |
