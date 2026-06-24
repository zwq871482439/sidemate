# 桌伴 · Sidemate

> 本地优先的 AI 桌面助手 — 数据不出本机，云端按需连接

## 项目简介

**桌伴 Sidemate** 是一款面向 Windows 桌面的 AI 助手，核心设计理念是**本地优先、隐私可控**。内置本地 LLM（基于 Ollama），支持完全离线使用；同时提供云端 AI 模式，用户可按需配置 API Key 连接云端大模型。

### 核心特性

| 特性 | 说明 |
|------|------|
| 🔒 **本地优先** | 所有数据存放在本机，不上传。基于 Ollama + Qwen 的本地推理引擎 |
| ☁️ **云端扩展** | 支持配置 OpenAI 兼容 API，82+ 模型可选（GPT-4、Claude、Gemini 等） |
| 📚 **知识库** | 上传文档，AI 基于文档内容回答。支持向量检索 + 语义重排序 |
| 🔄 **对比模式** | 本地 AI + 云端 AI 同时回答，自动融合分析，取长补短 |
| 🎤 **录音纪要** | 语音录制 → 转写 → 智能摘要（基于 Whisper 模型） |
| 📄 **文档生成** | AI 对话中一键生成 .docx 文档，支持模板 |
| 🌙 **深色模式** | 完整的深色/浅色主题切换 |
| 📦 **离线部署** | 嵌入式 Python + 依赖预装，无需联网即可运行 |

## 技术栈

| 层 | 技术 |
|----|------|
| **后端** | Python 3.14（嵌入式）+ FastAPI + Uvicorn |
| **AI 引擎** | Ollama (Vulkan) + Qwen3.5-4B GGUF |
| **云端** | OpenAI 兼容 API（82+ 模型） |
| **知识库** | Sentence-Transformers + FAISS + Cross-Encoder Reranker |
| **语音** | Whisper (small) |
| **前端** | 原生 HTML/CSS/JS，CSS 变量主题系统 |
| **打包** | Inno Setup + Go Launcher (Sidemate.exe) |

## 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.9.7 | 2026-06 | P6 打磨：Indigo 全页面重设计 + ClearBox 明盒 + step_model 架构重构 |
| v0.9.6 | 2026-06 | P6「前端统一化 + 三模式」：并行模式 + KB 纯档案管理 + 设置页 Tab 化 |
| v0.9.5 | 2026-06 | P5「稳定与整洁」：启动重构 + 上下文治理 + 死代码清理 |
| v0.9.4 | 2026-04 | P4「双轨框架」：CloudEngine + AgentLoop + 对比模式 |
| v0.9 Patch 3 | 2026-06 | 对比模式 + KB 标签体系 + LLM 调度器 + 双线记忆 |
| v0.9 Patch 2 | 2026-05 | CloudEngine + AgentLoop + SearchEngine + 友好错误反馈 |
| v0.9 Patch 1 | 2026-05 | 基础版：本地 Chat + 知识库 + 录音纪要 |

## 项目结构

```
Sidemate/
├── Sidemate.exe              ← Go Launcher，管理生命周期
├── python/                   ← 嵌入式 Python 3.14
│   └── Lib/site-packages/    ← 165 个预装依赖
├── server/                   ← FastAPI 后端
│   ├── server.py             ← 入口
│   ├── config.py             ← 全局配置
│   ├── prompts.py            ← 6 个 Prompt 模板
│   ├── core/                 ← AI 引擎核心（12 个模块）
│   ├── pipelines/            ← SSE 流式管道（本地/云端/对比）
│   ├── routers/              ← API 路由（8 个）
│   ├── knowledge/            ← 知识处理（分块/嵌入/重排序）
│   ├── session/              ← 会话管理
│   ├── intelligence/         ← 对话智能（过滤/分类/Action）
│   └── static/               ← 前端（HTML + CSS + JS）
├── models/                   ← AI 模型文件
├── extensions/               ← 扩展包注册
├── wheels/                   ← 离线自修复备份
└── data/                     ← 运行时数据
    ├── chats/                ← 对话历史
    ├── kb/                   ← 知识库数据
    ├── recordings/           ← 录音文件
    └── logs/                 ← 日志
```

## 快速开始

### 开箱即用版（推荐）

1. 解压安装包
2. 运行 `Sidemate.exe`
3. 等待 AI 模型自动预热（约 30-60 秒）
4. 浏览器自动打开，开始使用

### 基础版

1. 运行 `Sidemate.exe` 安装程序
2. 启动后进入 **设置 → 扩展管理**
3. 安装 LLM 模型包（.sidemate 文件）
4. 开始使用

### 可选配置

- **云端 AI**：设置页填入 API Key 和 Base URL
- **知识库**：安装文库扩展包（.sidemate 文件），然后在文库 Tab 上传文档
- **录音纪要**：安装纪要扩展包（.sidemate 文件）

## 文档导航

| 文档 | 说明 |
|------|------|
| [安装部署指南](用户文档/安装部署指南.md) | 详细安装步骤 |
| [用户手册](用户文档/用户手册.md) | 各功能模块使用说明 |
| [隐私与安全说明](用户文档/隐私与安全说明.md) | 数据隐私设计 |
| [CHANGELOG](用户文档/CHANGELOG.md) | 版本变更记录 |
| [常见问题](用户文档/常见问题-FAQ.md) | 问题排查 |

## 团队

| 成员 | 角色 |
|------|------|
| slow | 项目负责人 |
| 高见远 | AI 架构师 |
| 寇豆码 | AI 工程师 |
| 许清楚 | AI 产品经理 |
| 严过关 | AI QA |
| 小虾 | AI 开发助手 |

---

*桌伴 Sidemate v0.9 · 2026*
