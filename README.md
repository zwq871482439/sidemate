<div align="center">

# 桌伴 Sidemate

**在你的电脑上运行 AI——数据由你掌控，模型由你选择。**

本地优先的 AI 桌面应用 — 对话、知识库、文档生成，数据全部留在你的电脑上。

[功能](#-核心功能) · [快速开始](#-快速开始) · [文档](#-文档) · [技术栈](#-技术栈) 

[English](#english) | 中文

</div>

---

## 中文

桌伴 Sidemate 是一款 **本地优先的 AI 桌面应用**。它提供模型运行、知识库管理、工具链和文档生成的完整工作环境——AI 能力来自你选择的开源模型（离线运行）或在线 API，Sidemate 负责编排一切，数据由你掌控。

- 🔒 **数据不出本机**：Sidemate 本身不收集、不上传你的数据。对话、文件、知识库全部存储在你的电脑上
- 🔌 **断网照用**：离线模式（llama.cpp + Qwen3.5）完全本地运行，坐飞机也能用
- ☁️ **在线按需**：需要更强模型时，可配置在线模型 API（OpenAI 兼容 / Anthropic 双接口），数据直接发给你选的服务商，不经第三方
- 📚 **本地知识库**：上传 PDF/Word/笔记，AI 基于你的资料回答，向量化+重排序全在本地
- 📊 **报告/PPT 生成**：一键生成 Word 文档（离线可用）、HTML 可视化报告（在线模式）、PPT 演示文稿
- 🛠️ **AI Agent**：自主联网搜索、读网页、查知识库、写文档，多步任务自动完成

### 🎯 核心功能

| 功能 | 说明 |
|------|------|
| **三种模式** | 离线（本地运行）/ 在线（在线大模型）/ 并行（本地检索+在线推理） |
| **本地知识库** | bge-m3 向量化 + bge-reranker-v2-m3 精排，向量检索与重排序全在本地 |
| **KB 智能标签** | 自动为文档打标、语义分组（打标引擎可选离线/在线），支持 AI 智能筛选 |
| **文档生成** | 提纲确认→两阶段生成，支持 .docx / .html（可视化报告）/ .ppt.html（演示文稿） |
| **AI Agent** | 联网搜索、读网页、深度阅读、知识库检索、文件读写、计算器、格式转换等工具链 |
| **模型下载** | 内置下载页，从魔搭 ModelScope 一键下载，按内存自动推荐档位，支持断点续传 |
| **开箱即用** | 一键下载推荐方案，下载完成自动加载并预热模型，无需手动配置 |
| **审计日志** | 知识库每次检索记录访问明细（时间/访问者/查询词/命中片段/相关性评分） |
| **深色模式** | 完整的深色/浅色主题 |

### 🚀 快速开始

**普通用户**：下载安装包 → 一键安装 → 模型下载页选模型 → 开始使用

**开发者**：clone 源码后运行 `python envsetup.py` 一键部署（自动下载嵌入式 Python、pip 依赖、llama-server、编译 Launcher）

1. 下载安装包或 clone 源码
2. 启动后进入 **设置 → 模型下载**（或使用首页"快速开始"一键下载推荐方案）
3. 下载 LLM（按内存自动推荐档位：16GB→0.8B / 24GB→2B / 32GB→4B）和知识库模型（4.5GB）
4. 下载完成自动加载并预热模型，直接开始对话或知识库问答

**系统要求**：Windows 10/11 · 16GB 内存起步（离线模型；纯在线模式 8GB 即可）· 10GB 磁盘（含模型）

### 📖 文档

完整使用文档位于官网 Wiki：**[desk.deskware.cn/wiki](https://desk.deskware.cn/wiki/)**

- 产品介绍 · 三模式详解 · 使用场景 · FAQ · 隐私政策

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
envsetup.py                 ← 一键环境部署（嵌入式 Python + 依赖 + llama-server + Launcher 编译）
requirements.txt            ← Python 依赖清单
server/
├── core/
│   ├── llamacpp_backend/   ← llama.cpp 推理引擎
│   ├── cloud_engine.py     ← 在线 API（OpenAI 兼容）
│   ├── anthropic_adapter.py← Anthropic 接口适配
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

**Sidemate** is a **privacy-first AI desktop app**. It provides a complete workspace for running models, managing knowledge bases, chaining tools, and generating documents — AI capabilities come from open-source models (running locally) or online model APIs (your choice), Sidemate orchestrates everything, and your data stays in your hands.

- 🔒 **Your data stays local**: Sidemate itself doesn't collect or upload your data. Conversations, files, and knowledge base are stored on your machine
- 🔌 **Works offline**: Offline mode (llama.cpp + Qwen3.5) runs entirely on your machine — use it on a plane
- ☁️ **Online on your terms**: Connect online model APIs (OpenAI-compatible / Anthropic) when you need more power — data goes directly to your chosen provider, no middleman
- 📚 **Local knowledge base**: Upload PDFs/Word/notes, AI answers from your documents with vector search + reranking, all local
- 📊 **Report & PPT generation**: Generate Word docs (offline), HTML visual reports (online mode), and presentation slides in one click
- 🛠️ **AI Agent**: Autonomous web search, page reading, knowledge base lookup, file operations — multi-step tasks done automatically

### 🎯 Key Features

| Feature | Description |
|---------|-------------|
| **Three modes** | Offline (local inference) / Online (third-party LLM APIs) / Parallel (local retrieval + online reasoning) |
| **Local knowledge base** | bge-m3 embedding + bge-reranker-v2-m3 — vector search and reranking, all local |
| **KB smart tagging** | Auto-tag and group documents semantically (tagging engine: offline or online), with AI-powered filtering |
| **Document generation** | Outline confirmation → two-phase generation (.docx / .html / .ppt.html) |
| **AI Agent** | Web search, URL fetch, deep read, KB search, file I/O, calculator, format conversion |
| **Model downloader** | Built-in download page — ModelScope one-click download, RAM-based tier recommendation, resume support |
| **Zero-config start** | One-click recommended bundle — models auto-load and warm up after download |
| **Audit logging** | Every KB search logs access details (time/actor/query/matched text/relevance score) |
| **Dark mode** | Full dark/light theme |

### 🚀 Quick Start

1. Download the installer → one-click install
2. Go to **Settings → Model Download** (or use the "Quick Start" one-click recommended bundle)
3. Download an LLM (auto-recommended by RAM: 16GB→0.8B / 24GB→2B / 32GB→4B) and knowledge base models (4.5GB)
4. Models auto-load and warm up after download — start chatting right away

**Requirements**: Windows 10/11 · 16GB+ RAM (offline models; 8GB for online-only) · 10GB disk (incl. models)

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
