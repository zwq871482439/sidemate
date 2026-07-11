# 桌伴 Sidemate 故障排查手册

> 适用于 Patch 12 架构（9 包 28 模块）

---

## 快速索引

| 现象 | 可能原因 | 跳转 |
|------|---------|------|
| 启动失败 | Python 版本 / 依赖缺失 | [启动问题](#1-启动问题) |
| 模型加载失败 | 模型文件损坏 / NPU 驱动 | [模型问题](#2-模型加载问题) |
| NPU 不可用 | 驱动 / OpenVINO 版本 | [NPU 问题](#3-npu设备问题) |
| 文库嵌入报错 | 模型未加载 / 文件格式 | [文库问题](#4-文库问题) |
| 对话空白回复 | Think 标签泄漏 / 上下文溢出 | [对话问题](#5-对话问题) |
| 端口冲突 | 8000 端口被占用 | [网络问题](#6-网络问题) |
| 录音转写失败 | Whisper 模型未安装 | [纪要问题](#7-录音纪要问题) |
| SSE 断连白屏 | 后端重启 / 网络中断 | [前端问题](#8-前端问题) |
| 内存不足 | 多模型同时加载 | [性能问题](#9-性能问题) |
| .sidemate 包安装失败 | 签名不匹配 / 格式错误 | [扩展包问题](#10-sidemate包问题) |

---

## 1. 启动问题

### 现象：`python server.py` 报错

**检查步骤**：

```bash
# 1. 确认 Python 版本 >= 3.10
python --version

# 2. 运行 preflight 检查
python preflight.py

# 3. 检查依赖是否完整
pip install -r requirements.txt
```

**常见错误**：

| 错误信息 | 原因 | 解决 |
|---------|------|------|
| `ModuleNotFoundError: No module named 'fastapi'` | 核心依赖缺失 | `pip install fastapi uvicorn pydantic sse-starlette` |
| `ModuleNotFoundError: No module named 'openvino_genai'` | AI 引擎未安装 | `pip install openvino-genai` |
| `ImportError: cannot import name 'GenerateQueue'` | 包结构不完整 | 确认 core/ 目录下文件齐全 |
| `PermissionError` | 目录权限不足 | 以管理员权限运行 |

### 现象：setup.bat 运行失败

- 检查是否在项目根目录运行
- 检查 Python 是否加入 PATH
- 检查磁盘空间是否充足（模型文件 ~5GB）

---

## 2. 模型加载问题

### 现象：模型加载超时或崩溃

**检查步骤**：

```bash
# 1. 确认模型文件存在
ls models/qwen3-8b-openvino-int4/

# 2. 检查关键文件
ls models/qwen3-8b-openvino-int4/openvino_model.bin    # 权重文件
ls models/qwen3-8b-openvino-int4/tokenizer.json         # 分词器
ls models/qwen3-8b-int4/tokenizer_config.json            # 配置
```

**常见错误**：

| 错误信息 | 原因 | 解决 |
|---------|------|------|
| `RuntimeError: Failed to read model` | 模型文件损坏 | 重新下载/导入模型 |
| `OSError: Cannot open` | 路径含中文/空格 | 移到纯英文路径 |
| `MemoryError` | 内存不足 | 关闭其他程序，或切换到 CPU 设备 |
| 加载进度卡在 99% | NPU 编译中，首次加载较慢 | 等待 2-5 分钟 |

### 现象：模型加载成功但推理报错

- 检查 `config.py` 中 `device` 设置是否与实际设备匹配
- 检查 `npu_default_prompt_tokens` 是否过大（推荐 2400）
- 查看 `data/logs/` 目录下的日志文件

---

## 3. NPU 设备问题

### 现象：NPU 不可用，fallback 到 CPU

**检查步骤**：

```bash
# 1. 检查 NPU 驱动
# Intel NPU 驱动版本 >= 1.0.0
# 设备管理器 → 神经网络处理器 → Intel NPU

# 2. 检查 OpenVINO 版本
python -c "import openvino; print(openvino.__version__)"
# 需要 >= 2024.5

# 3. 检查 NPU 是否被识别
python -c "import openvino as ov; print(ov.Core().available_devices)"
# 应包含 'NPU'
```

**常见问题**：

| 问题 | 解决 |
|------|------|
| NPU 不在设备列表 | 更新 Intel NPU 驱动到最新版 |
| NPU 推理报 Shape 错误 | 降低 `npu_default_prompt_tokens` 到 1800 |
| NPU 首次推理极慢 | 首次编译需要 2-5 分钟，后续会缓存 |
| NPU 生成重复/循环 | `repeat_threshold` 降到 0.4 |

**NPU 兼容性**：
- Intel Core Ultra 100 系列（Meteor Lake）：NPU 11 TOPS
- Intel Core Ultra 200 系列（Lunar Lake）：NPU 50 TOPS（XDNA 2）
- AMD Ryzen AI：不支持 OpenVINO NPU，需用 CPU/GPU

---

## 4. 文库问题

### 现象：文档上传后嵌入失败

**检查步骤**：

```bash
# 1. 确认嵌入模型已加载
curl http://localhost:8000/api/kb/module-status

# 2. 检查磁盘空间
# 嵌入索引文件存放在 data/kb/ 目录

# 3. 检查文件格式
# 支持：.txt, .md, .pdf, .docx, .xlsx, .pptx, .csv, .json
```

**常见错误**：

| 错误信息 | 原因 | 解决 |
|---------|------|------|
| `KB not ready` | 嵌入模型未加载 | 先调用 `/api/kb/load-models` |
| `OV pipeline shape mismatch` | 输入文本超 512 tokens | 文档会自动截断，检查日志 |
| `CUDA out of memory` | GPU 内存不足 | 切换嵌入模型到 CPU |
| 文档状态一直是 `processing` | 异步任务卡住 | 调用 `/api/kb/documents/{id}/cancel` 后重试 |

### 现象：文库问答答非所问

- 检查 `kb_search_top_k` 是否太小（默认 5）
- 检查 `kb_vector_score_threshold` 是否太高（默认 0.28）
- 检查文档是否处理完成（status=ready）
- 检查文档数量是否超过 `kb_max_documents`（默认 20）

---

## 5. 对话问题

### 现象：空白回复

**根因分析**：

1. **Think 标签泄漏**：模型输出了 `<think` 标签但没有闭合 `</think`
   - stream_engine 有 80+ 行 fallback 处理
   - `think_mode="off"` 时应传 `enable_thinking: False`

2. **上下文溢出**：prompt 超过 token 限制
   - 检查日志中 `prompt too long` 警告
   - 降低 `npu_default_prompt_tokens` 或减少历史长度

3. **生成异常**：stall/重复检测触发但中断失败
   - 检查 `stall_check_tokens` 和 `repeat_threshold` 配置

**解决**：
```
# 临时：删除对话历史重新开始
# 永久：在设置中切换设备为 CPU（更大上下文窗口）
```

### 现象：回复重复或循环

- 降低 `repeat_threshold`（从 0.5 → 0.4）
- 降低 `repeat_window`（从 12 → 8）
- 检查温度设置（strategy 的 `temperature_offset`）

---

## 6. 网络问题

### 现象：端口 8000 被占用

```bash
# Windows
netstat -ano | findstr :8000
# 然后 taskkill /PID <pid> /F

# 或者修改 config.py 中的端口设置
# server.py 启动参数中指定 --port 8001
```

### 现象：浏览器无法连接

- 确认 `start.bat` 运行成功且控制台无错误
- 确认浏览器访问 `http://localhost:8000`
- 检查防火墙是否阻止了 Python

---

## 7. 录音纪要问题

### 现象：录音后转写无结果

**检查步骤**：

```bash
# 1. 确认 Whisper 模型已安装
curl http://localhost:8000/api/recorder/whisper/status

# 2. 检查录音文件
ls data/tmp_upload/

# 3. 检查转写状态
curl http://localhost:8000/api/recorder/{session_id}/status
```

**常见错误**：

| 错误 | 原因 | 解决 |
|------|------|------|
| `Whisper not installed` | Whisper 扩展未安装 | 通过扩展管理安装 |
| `Audio format not supported` | 音频格式不支持 | 使用 mp3/wav/m4a/webm |
| `Recording too long` | 超过 `recorder_max_duration`（3600秒） | 缩短录音 |
| 转写卡住 | 崩溃恢复未触发 | 调用 `/api/recorder/recover` |

### 现象：8B 纠错质量差

- 检查 `whisper_refine_batch_chars`（默认 800）
- 确认主模型已加载（纠错依赖 8B 模型）
- 纠错 prompt 是 "以下是一段中文语音转写文本，存在语音识别错误"

---

## 8. 前端问题

### 现象：SSE 断连白屏

**原因**：后端重启后 SSE 连接断开，前端 EventSource 报错

**解决**：
- 前端 `errors.js` 中 `retryConnect` 应自动重连
- 重连后应刷新：`kbRouteState()` + `minutesRouteState()` + `refreshResourcePanel()`
- 手动刷新页面（F5）

### 现象：KB 列表不刷新

- 检查 `/api/kb/documents` 返回是否正常
- 返回格式是纯数组，前端需兼容：`Array.isArray(data) ? data : (data.documents || [])`
- 手动调用 `kbRouteState()` 刷新

### 现象：KaTeX/LaTeX 渲染失败

- 检查 `static/vendor/katex/` 目录是否完整
- 检查 CDN 是否可访问（离线环境需本地 KaTeX 文件）
- 查看 browser console 是否有 JS 错误

### 现象：暗色模式显示异常

- 所有 CSS 必须使用 CSS 变量，不能硬编码颜色
- 检查 `main.css` 中的 `[data-theme="dark"]` 规则
- 主色（蓝色）在暗色模式下保持色相不变

---

## 9. 性能问题

### 现象：内存不足

**内存占用参考**（INT4 模型）：

| 组件 | 占用 |
|------|------|
| Qwen3-8B INT4 权重 | ~5 GB |
| KV Cache（4K ctx） | ~0.6 GB |
| BGE 嵌入模型 | ~0.4 GB |
| Reranker | ~0.4 GB |
| Whisper small | ~1 GB |
| 总计（全开） | ~7.4 GB |

**优化建议**：

1. 设置 `memory_budget_mb` 限制总内存
2. 设置 `reranker_resident: False`（空闲 5 分钟后卸载 Reranker）
3. 设置 `recorder_resident: False`（空闲后卸载 Whisper）
4. 设置 `whisper_keep_loaded: False`（用完立即卸载）
5. 降低 `kb_embed_batch_size`（从 50 → 20）

### 现象：生成速度慢

- NPU：首次推理需编译（2-5 分钟），后续正常
- CPU：预期 3-8 token/s
- GPU：预期 10-30 token/s
- 检查 `max_tokens` 设置是否过大

---

## 10. .sidemate 包问题

### 现象：安装失败

**检查步骤**：

1. 确认文件扩展名为 `.sidemate`
2. 确认文件未损坏（大小 > 0）
3. 检查 HMAC 签名是否匹配

**常见错误**：

| 错误 | 原因 | 解决 |
|------|------|------|
| `HMAC mismatch` | 签名不匹配 | 重新下载包 |
| `Invalid manifest` | manifest.json 格式错误 | 检查包的制作流程 |
| `Unsupported type` | 不支持的扩展类型 | 仅支持 model/knowledge/whisper/action |
| `File exists` | 同名扩展已安装 | 先卸载旧版本 |

---

## 日志排查

日志文件位置：`data/logs/`

```bash
# 查看最新日志
ls -lt data/logs/ | head -5

# 搜索错误
grep -i "error\|exception\|fail" data/logs/*.log

# 搜索特定模块
grep "\[MODEL\]" data/logs/*.log     # 模型相关
grep "\[KB\]" data/logs/*.log        # 文库相关
grep "\[RECORDER\]" data/logs/*.log  # 录音相关
grep "\[ACTION\]" data/logs/*.log    # Action 相关
```

## 紧急恢复

```bash
# 1. 停止服务
# 按 Ctrl+C 或关闭终端

# 2. 清理临时文件
rm -rf data/tmp_upload/*

# 3. 重置配置（恢复默认值）
# 删除 settings.json，重启后自动生成
rm settings.json

# 4. 紧急模式启动（仅 CPU，最小配置）
# 修改 config.py 中 device="CPU" 后启动
```
