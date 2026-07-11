# 桌伴 Sidemate v0.9 离线安装指南

## 前置条件

- Windows 10/11（64位）
- Python 3.14+（已内置于 venv）
- Intel Arc 集成显卡（Core Ultra 系列）
- 约 15GB 可用磁盘空间

## 目录结构

```
C:\tmp\_Sidemate_0.9\
├── venv\                    # Python 虚拟环境（已含所有依赖）
├── offline\                 # 离线安装资源
│   ├── OllamaSetup.exe      # Ollama 安装包（需手动放入）
│   └── qwen3.5-4b\          # 模型文件（或从 C:\tmp\_models\qwen3.5-4b 链接）
├── core\                    # 核心模块
├── routers\                 # API 路由
├── intelligence\            # AI 智能模块
├── knowledge\               # 文库模块
├── ...
├── config.py                # 配置文件
├── server.py                # 启动入口
└── requirements.txt         # 依赖清单
```

## 安装步骤

### 1. 安装 Ollama

```cmd
:: 方式 A：使用本目录下的安装包
offline\OllamaSetup.exe

:: 方式 B：如果已有 Ollama，跳过此步
```

安装完成后，配置 Intel GPU 加速：
```cmd
:: 设置环境变量（Arc 集显 Vulkan 加速）
set OLLAMA_VULKAN=1
set OLLAMA_INTEL_GPU=1

:: 或者通过系统设置永久添加
```

### 2. 导入模型

**方式 A：从本地 safetensors 导入**
```cmd
cd C:\tmp\_Sidemate_0.9
ollama create qwen3.5-4b -f Modelfile.qwen3.5-4b
```

**方式 B：在线拉取（需要网络）**
```cmd
ollama pull qwen3.5:4b
```

### 3. 启动服务

```cmd
cd C:\tmp\_Sidemate_0.9
venv\Scripts\python.exe server.py
```

### 4. 打开浏览器

```
http://localhost:18080
```

## 注意事项

1. **Ollama 必须先启动**：server.py 会自动启动 Ollama（如果配置了 `ollama_auto_start: true`）
2. **模型文件**：FP16 safetensors 约 9GB，首次导入需要几分钟
3. **显存**：Intel 集显共享内存，推理时约占用 10GB（FP16）。如需降低占用，换用 GGUF Q5_K_M 版本
4. **离线运行**：所有依赖已安装在 venv 中，无需联网安装包

## 依赖清单

v0.9 已删除的包（对比 Patch12）：
- openvino, openvino-genai, openvino-telemetry, openvino-tokenizers
- nncf, optimum, onnx, onnxruntime, torch

v0.9 新增的包：
- httpx >= 0.28.0
