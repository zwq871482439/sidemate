<div align="center">

# 桌伴 Sidemate

**不上传你的数据，也能用 AI。**

本地 AI 桌面助手 — 对话、知识库、文档生成，数据全部留在你的电脑上。

[功能](#-核心功能) · [快速开始](#-快速开始) · [文档](#-文档) · [技术栈](#-技术栈) · [路线图](#-路线图)

[English](#english) | 中文

</div>

---

## 中文

桌伴 Sidemate 是一款 **Windows 桌面 AI 助手**，核心理念是 **本地优先、隐私可控**：

- 🔒 **数据不出本机**：对话、文件、知识库全部存储在你的电脑上，默认不传任何服务器
- 🔌 **断网照用**：本地模式（llama.cpp + Qwen3.5）完全离线运行，坐飞机也能用
- ☁️ **云端按需**：需要更强模型时，可配置主流云端模型 API，你来选
- 📚 **本地知识库**：上传 PDF/Word/笔记，AI 基于你的资料回答，向量化+重排序全在本地
- 📊 **报告/PPT 生成**：一键生成 Word 文档、HTML 可视化报告、PPT 演示文稿
- 🛠️ **AI Agent**：自主联网搜索、读网页、查知识库、写文档，多步任务自动完成

### 🎯 核心功能

| 功能 | 说明 |
|------|------|
| **三种模式** | 离线（完全本地）/ 在线（云端大模型）/ 并行（本地检索+云端推理） |
| **本地知识库** | bge-m3 向量化 + bge-reranker-v2-m3 精排，dense+sparse 双路检索 |
| **KB 问答引擎可选** | 知识库问答独立选择本地/云端 LLM，不受全局模式影响 |
| **文档生成** | 提纲确认→两阶段生成，支持 .docx / .html（可视化报告）/ .ppt.html（演示文稿） |
| **AI Agent** | 联网搜索、读网页、深度阅读、知识库检索、文件读写、计算器、格式转换等工具链 |
| **模型下载** | 提供下载页，从魔搭 ModelScope 一键下载 LLM（三档）和知识库模型，支持断点续传 |
| **审计日志** | 知识库每次检索记录访问明细（时间/访问者/查询词/命中片段/相关性评分） |
| **深色模式** | 完整的深色/浅色主题 |

### 🚀 快速开始

**普通用户**：下载安装包 → 一键安装 → 模型下载页选模型 → 开始使用

**开发者**：clone 源码后运行 `setup_dev.bat` 一键部署，详见 [BUILD.md](BUILD.md)

1. 下载安装包或 clone 源码
2. 启动后进入 **设置 → 模型下载**
3. 下载 LLM 模型（推荐 4B，2.7GB）和知识库模型（4.5GB）
4. 开始对话或知识库问答

**系统要求**：Windows 10/11 · 8GB 内存起步（建议 16GB）· 10GB 磁盘

### 📖 文档

完整文档位于 `docs/设计文档/用户文档/`：

- [用户手册](docs/设计文档/用户文档/v0.9.7-用户手册.md) — 产品总入口
- [新手指引](docs/设计文档/用户文档/v0.9.7-新手指引.md) — 5 分钟上手
- [三模式使用指南](docs/设计文档/用户文档/v0.9.7-三模式使用指南.md) — 离线/在线/并行
- [知识库使用指南](docs/设计文档/用户文档/v0.9.7-知识库使用指南.md)
- [工具调用使用指南](docs/设计文档/用户文档/v0.9.7-工具调用使用指南.md)
- [设置页使用手册](docs/设计文档/用户文档/v0.9.7-设置页使用手册.md)
- [CHANGELOG](docs/设计文档/用户文档/CHANGELOG.md)

### 🛠 技术栈

| 层 | 技术 |
|----|------|
| **推理引擎** | llama.cpp（llama-server）+ Qwen3.5 GGUF（0.8B/2B/4B） |
| **后端** | Python 3.14（嵌入式）+ FastAPI |
| **前端** | 原生 HTML/CSS/JS（无框架，CSS 变量主题） |
| **知识库** | bge-m3（embedding）+ bge-reranker-v2-m3（reranker） |
| **Launcher** | Go（进程管理 + 看门狗 + GPU 检测） |
| **打包** | Inno Setup |
| **协议** | Apache-2.0 |

### 📦 项目结构

```
server/
├── core/
│   ├── llamacpp_backend/   ← llama.cpp 推理引擎
│   ├── cloud_engine.py     ← 云端 API
│   ├── download_engine.py  ← 模型下载
│   ├── agent_loop.py       ← Agent 工具循环
│   └── model_manager.py    ← 模型管理
├── pipelines/              ← 三模式 SSE 管道
│   ├── local_pipeline.py   ← 离线
│   ├── cloud_pipeline.py   ← 在线
│   └── parallel_pipeline.py← 并行
├── knowledge/              ← 知识库（检索/分块/向量化）
├── routers/                ← API 路由
└── static/                 ← 前端
launcher/                   ← Go Launcher
```

---

<div id="english"></div>

## English

**Sidemate** is a **Windows desktop AI assistant** built on the principle of **local-first, privacy by design**:

- 🔒 **Your data never leaves your machine**: Conversations, files, and knowledge base are stored locally — nothing is uploaded by default
- 🔌 **Works offline**: Local mode (llama.cpp + Qwen3.5) runs entirely offline — use it on a plane
- ☁️ **Cloud on your terms**: Connect mainstream cloud model APIs when you need more power — you choose
- 📚 **Local knowledge base**: Upload PDFs/Word/notes, AI answers from your documents with vector search + reranking, all local
- 📊 **Report & PPT generation**: Generate Word docs, HTML visual reports, and presentation slides in one click
- 🛠️ **AI Agent**: Autonomous web search, page reading, knowledge base lookup, file operations — multi-step tasks done automatically

### 🎯 Key Features

| Feature | Description |
|---------|-------------|
| **Three modes** | Offline (fully local) / Online (cloud LLM) / Parallel (local retrieval + cloud reasoning) |
| **Local knowledge base** | bge-m3 embedding + bge-reranker-v2-m3, dense+sparse dual retrieval |
| **KB engine selection** | KB Q&A independently chooses local/cloud LLM, separate from global mode |
| **Document generation** | Outline confirmation → two-phase generation (.docx / .html / .ppt.html) |
| **AI Agent** | Web search, URL fetch, deep read, KB search, file I/O, calculator, format conversion |
| **Model downloader** | Built-in download page — get LLMs and KB models from ModelScope with resume support |
| **Audit logging** | Every KB search logs access details (time/actor/query/matched text/relevance score) |
| **Dark mode** | Full dark/light theme |

### 🚀 Quick Start

1. Download the installer → one-click install
2. Go to **Settings → Model Download**
3. Download an LLM (4B recommended, 2.7GB) and knowledge base models (4.5GB)
4. Start chatting or asking your knowledge base

**Requirements**: Windows 10/11 · 8GB+ RAM (16GB recommended) · 10GB disk

### 🛠 Tech Stack

| Layer | Technology |
|-------|------------|
| **Inference** | llama.cpp (llama-server) + Qwen3.5 GGUF (0.8B/2B/4B) |
| **Backend** | Python 3.14 (embedded) + FastAPI |
| **Frontend** | Vanilla HTML/CSS/JS (no framework, CSS variable theming) |
| **Knowledge base** | bge-m3 (embedding) + bge-reranker-v2-m3 (reranker) |
| **Launcher** | Go (process management + watchdog + GPU detection) |
| **License** | Apache-2.0 |

### 📄 License

Core code is licensed under **Apache-2.0**. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES](THIRD-PARTY-NOTICES).

---

### 🔗 Links

- **Website**: [desk.deskware.cn](https://desk.deskware.cn)
- **Wiki**: [desk.deskware.cn/wiki](https://desk.deskware.cn/wiki/) — 产品介绍、模式详解、使用场景、FAQ
- **GitHub**: [github.com/zwq871482439/sidemate](https://github.com/zwq871482439/sidemate)
- **Contact**: sidemate@deskware.cn

---

<div align="center">

**桌伴 Sidemate** · 本地优先 · 隐私可控 · Apache-2.0 开源

[官网](https://desk.deskware.cn) · [Wiki](https://desk.deskware.cn/wiki/) · [GitHub](https://github.com/zwq871482439/sidemate)

</div>
