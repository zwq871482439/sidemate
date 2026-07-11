# 桌伴 Sidemate v0.9 Patch1 — 代码审计报告

**审计日期**：2026-06-01  
**审计范围**：`C:\tmp\_Sidemate_0.9_patch1\`（server/ + launcher/ + 前端）  
**审计基线**：从 OpenVINO 迁移到 Ollama 后的架构正确性

---

## 一、关键阻断问题（P0）

### P0-1: GGUF MTP 层不兼容 Ollama 0.24.0
- **文件**: `server/models/llm/qwen3.5-4b/Qwopus3.5-4B-Coder-MTP-Q5_K_M.gguf`
- **现象**: 对话时报 `qwen3next: layer 32 missing attn_qkv/attn_gate projections`
- **根因**: 该 GGUF 包含 MTP（Multi-Token Prediction）层，Ollama 0.24.0 加载器把 MTP 层当常规 attention 层处理，找不到 `attn_qkv` 投影就报错
- **参考**: GitHub ollama/ollama#16282
- **修复**: 更换为**不带 MTP 的 GGUF 文件**（文件名不含 `-MTP-`），或等待 Ollama 修复
- **状态**: ❌ 需用户更换模型文件

---

## 二、重要问题（P1）

### P1-1: 前端设置页 localStorage key 使用旧前缀
- **文件**: `server/static/js/settings.js` 第200/385/742/759行
- **描述**: 使用 `_local_ai_last_model` 和 `_local_ai_last_device`，这是旧版前缀，与产品名"桌伴 Sidemate"不一致
- **影响**: 功能正常，但用户切换浏览器/设备时迁移体验差
- **建议**: 统一为 `_sidemate_last_model` 等，加迁移逻辑

### P1-2: `load()` 是假加载，不触发 Ollama 预热
- **文件**: `server/core/model_manager.py` 第309-329行
- **描述**: `load()` 只设 `_loaded[name] = True`，不调 ollama API 预加载模型。用户看到"模型就绪"但第一次对话时 ollama 才真正加载（冷启动延迟 5-15 秒）
- **建议**: 加载时发一个 `POST /api/generate {"model": name, "prompt": "", "keep_alive": -1}` 预热模型

### P1-3: stream_engine 的 max_tokens 对 Ollama 语义不同
- **文件**: `server/core/stream_engine.py` 第237行
- **描述**: 传 `max_tokens` 给 Ollama `/v1/chat/completions`，Ollama 实际映射到 `num_predict`。这个兼容性目前正常工作（Ollama 做了转换），但如果未来 Ollama 版本变更可能失效
- **建议**: 同时在 `options` 里显式传 `{"num_predict": max_tokens}` 作为保底

### P1-4: 设备管理接口冗余
- **文件**: `server/routers/settings.py` 第109-137行 + `server/core/model_manager.py` 第410-422行
- **描述**: Ollama 模式下只有 "ollama" 一个设备，但前端仍然有设备选择器、设备切换 API、`/api/devices` 端点。虽然都是 no-op，但增加了代码复杂度
- **建议**: 前端隐藏设备选择器（Ollama 模式下不需要），后端保留接口但简化实现

### P1-5: 思考模式 think_mode 调整 max_tokens 但 Ollama 不支持动态调整
- **文件**: `server/core/stream_engine.py` 第138-152行
- **描述**: `think_mode="on"` 时把 `max_tokens` 设为 8192，`think_mode="off"` 时限制为 2048。但 Ollama 的思考模式控制不是靠 token 数——Qwen3.5 的 `enable_thinking` 是通过 chat template 控制的
- **建议**: Ollama 模式下移除基于 think_mode 的 max_tokens 调整逻辑

---

## 三、建议改进（P2）

### P2-1: Modelfile 缺少 `PARAMETER num_predict`
- **文件**: `server/models/llm/qwen3.5-4b/Modelfile`
- **描述**: 当前只有 `temperature`、`num_ctx`、`stop`，缺少 `num_predict`（默认为 128，太小）
- **建议**: 添加 `PARAMETER num_predict 4096`（与 profile 的 default_max_tokens 对齐）

### P2-2: `fmtMB(0)` 之前返回 "--"，已修复
- **文件**: `server/static/js/core/utils.js` 第18-22行
- **描述**: 已改为返回 `0 MB`，预算区不再显示 `-- / 10.0 GB`
- **状态**: ✅ 已修复

### P2-3: 4B profile 的 `default_max_tokens` 偏低
- **文件**: `server/core/model_manager.py` 第443行
- **描述**: 4B profile 的 `default_max_tokens` 原来是 2048，对于现代 4B 模型偏保守
- **状态**: ✅ 已改为 4096

### P2-4: `_detect_hardware` 只返回 `cpu` 和 `gpu`，缺少 GPU 检测
- **文件**: `server/core/model_manager.py` 第596-613行
- **描述**: `hw = {"cpu": "", "gpu": ""}` 但实际只查了 CPU（wmic），GPU 字段永远为空
- **建议**: 如果需要 GPU 信息，用 `wmic path win32_videocontroller get name` 查询

### P2-5: `recorder_manager.py` 使用 `compute_type="int8"`
- **文件**: `server/recorder_pkg/recorder_manager.py`
- **描述**: Whisper 模型使用 `int8` 量化，这是 faster-whisper 的正常参数（不是 OpenVINO 残留），保持不变即可
- **状态**: ℹ️ 确认正常

### P2-6: settings.js 中 `_apiBase` 重复定义
- **文件**: `server/static/js/settings.js` 第110行和第753行
- **描述**: `_apiBase` 在两个不同函数内各自定义了一次，应提取为模块级变量
- **建议**: 在文件顶部定义一次即可

---

## 四、信息性说明（P3）

### P3-1: NPU/OpenVINO 残留清除确认
- **描述**: 全局扫描 `\bnpu\b|openvino|OpenVINO` 在 `.py` 和 `.js` 文件中零匹配（除 `int8` 是 faster-whisper 的正常参数）
- **状态**: ✅ 清除完毕

### P3-2: API 只绑定 127.0.0.1
- **文件**: `server/server.py`
- **描述**: uvicorn 绑定 `127.0.0.1:8976`，局域网无法访问，安全性确认
- **状态**: ✅ 安全

### P3-3: Job Object 进程管理
- **文件**: `launcher/main.go`
- **描述**: 所有子进程绑定到 Job Object + KillOnClose，主进程退出时 Windows 内核自动清理
- **状态**: ✅ 已实现

### P3-4: 托盘右键菜单稳定性
- **文件**: `launcher/tray_windows.go`
- **描述**: 改用 `TPM_RETURNCMD` 模式，不再依赖 `WM_COMMAND` 回调
- **状态**: ✅ 已修复

---

## 五、审计清单

| 维度 | 状态 | 说明 |
|------|------|------|
| OpenVINO/NPU 残留 | ✅ 清除 | `.py` + `.js` 零匹配 |
| 死代码 | ✅ 基本干净 | 无明显死代码 |
| Ollama API 兼容 | ⚠️ 需注意 | `max_tokens` 映射正常但建议加 `num_predict` |
| 错误处理 | ✅ 良好 | 关键路径有 try/except |
| 资源泄漏 | ✅ 良好 | httpx 用 with 上下文管理 |
| 安全性 | ✅ 良好 | 127.0.0.1 绑定 + 无硬编码 URL |
| 配置一致性 | ✅ 良好 | 端口 8976 统一 |
| 进程管理 | ✅ 良好 | Job Object + taskkill /T /F |
| 前端代码 | ✅ 良好 | 无 console.log / debugger |
| GGUF 模型兼容 | ❌ 阻断 | MTP 版本不兼容 Ollama 0.24 |

---

## 六、优先修复顺序

1. **🔴 P0-1**: 更换不带 MTP 的 GGUF 模型文件（用户操作）
2. **🟡 P1-2**: 实现模型预热（首次对话不再冷启动）
3. **🟡 P2-1**: Modelfile 添加 `PARAMETER num_predict 4096`
4. **🟢 P2-6**: 提取 `_apiBase` 为模块级变量
5. **🟢 P1-1**: localStorage key 统一前缀
