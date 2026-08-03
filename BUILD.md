# 开发环境搭建指南

> 从源码 clone 后快速部署 Sidemate 开发环境。

## 前置要求

| 依赖 | 版本 | 说明 |
|------|------|------|
| Python | 3.12+ | 推荐 3.14 |
| Go | 1.22+ | 仅编译 Launcher 时需要 |
| Git | 任意 | |

## 快速开始

```bash
git clone https://github.com/zwq871482439/sidemate.git
cd sidemate

# 一键部署（嵌入式 Python + pip 依赖 + llama-server + Launcher 编译）
python envsetup.py
```

脚本会自动：
1. 部署嵌入式 Python 并安装 pip 依赖（`requirements.txt`，另单独安装 torch CPU 版）
2. 下载/放置 llama-server 到 `lib/ollama/`
3. 编译 Go Launcher（可选）

## 手动搭建

### 1. 安装 Python 依赖

```bash
pip install -r requirements.txt
```

### 2. 获取 llama-server

llama-server 是 llama.cpp 的推理服务，负责加载 GGUF 模型。

**方式一**：从 [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) 下载 Windows 预编译版，将 `llama-server.exe` 放到 `lib/ollama/` 目录。

**方式二**：使用 Sidemate 安装包（Inno Setup），安装后从安装目录复制 `lib/ollama/llama-server.exe`。

### 3. 编译 Go Launcher（可选）

```bash
cd launcher
go build -ldflags "-H windowsgui -X main.AppVersion=v0.9.7" -o ..\Sidemate.exe .
```

> `-H windowsgui` 必须加，否则双击 exe 会弹出 CMD 黑窗口。

如果不编译 Launcher，可以直接用 `python server/server.py` 启动后端。

### 4. 下载模型

启动后在 **设置 → 模型下载** 页面下载：
- LLM 模型（Qwen3.5 0.8B/2B/4B，从 ModelScope 下载）
- 知识库模型（bge-m3 + bge-reranker-v2-m3，共约 4.5GB）

## 启动

```bash
# 方式一：完整启动（含看门狗 + 浏览器自动打开）
Sidemate.exe

# 方式二：仅后端（调试用）
python server/server.py
```

浏览器访问 `http://127.0.0.1:8976`

## 目录结构

```
sidemate/
├── server/          ← FastAPI 后端（源码）
├── launcher/        ← Go Launcher（源码）
├── docs/            ← 文档
├── tests/           ← 测试
├── python/          ← 嵌入式 Python（不进 git，安装包预装）
├── models/          ← 模型文件（不进 git，下载页获取）
├── lib/             ← llama-server + DLL（不进 git）
├── data/            ← 运行时数据（不进 git）
├── envsetup.py      ← 一键部署脚本
└── requirements.txt ← Python 依赖清单
```

## 运行测试

```bash
node tests/test_regression_v097.mjs   # 主回归测试
node tests/test_regression_d8fad96.mjs # 历史回归
node tests/_self_test.mjs             # 基础自测
```
