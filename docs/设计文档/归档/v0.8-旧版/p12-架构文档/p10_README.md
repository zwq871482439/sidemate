# 本地 AI 助手

基于 FastAPI + OpenVINO + Qwen3 的本地 AI 系统，支持 Intel NPU/GPU/CPU 多硬件后端。

## 项目结构

```
_local-ai/
├── server.py              # FastAPI 主入口（含离线保护）
├── preflight.py           # 启动前环境检查
├── models.py              # ModelManager（模型加载/推理）
├── agent.py               # Agent Loop v2.1（工具调用）
├── prompts.py             # Prompt Engineering v3.2
├── config.py              # 配置管理
├── chunking_orchestrator.py  # 长文本编排
├── knowledge_base.py      # 知识库
├── recorder.py            # 语音纪要
├── task_classifier.py     # 任务分类
├── routers/               # API 路由
│   ├── chat.py            # 对话 API
│   ├── kb.py              # 知识库 API
│   ├── settings.py        # 设置/扩展中心 API
│   ├── recorder.py        # 纪要 API
│   ├── notebook.py        # 记忆 API
│   └── skill.py           # 技能 API
├── static/                # 前端资源
│   ├── css/main.css       # 样式（含深色模式）
│   ├── js/                # JS 模块
│   │   ├── chat.js        # 对话 Tab
│   │   ├── qa.js          # 问答 Tab
│   │   ├── minutes.js     # 纪要 Tab
│   │   ├── settings.js    # 设置/扩展中心
│   │   └── core/          # 工具函数
│   └── vendor/            # 第三方库（highlight.js）
├── skills/                # 技能模块
│   ├── builtin/           # 内置技能
│   └── custom/            # 自定义技能
├── docs/                  # 文档
│   ├── design/            # 架构设计（ARCHITECTURE_PATCH10.md 等）
│   ├── patch-reports/     # 补丁报告
│   ├── planning/          # 规划文档（ROADMAP.md 等）
│   └── research/          # 调研报告
├── setup.bat              # 环境初始化（支持离线安装）
├── start.bat              # 服务启动（含离线保护）
├── download_vendor.bat    # 准备离线依赖包（需网络，仅一次）
├── vendor/                # 离线依赖包目录
├── export/                # 扩展模块 ZIP
│   ├── qwen3-*.zip        # 模型包
│   ├── kb-module-*.zip    # 知识库包
│   └── whisper-*.zip      # 语音包
├── data/                  # 数据目录
│   ├── kb/                # 知识库数据
│   └── recordings/        # 录音文件
├── extensions/            # 已安装扩展
├── models/                # 模型文件
├── chats/                 # 对话记录
└── pipelines/             # Pipeline 定义
```

## 快速开始

只需两个脚本：

```bash
# 1. 准备离线依赖包（仅需在有网络的机器上执行一次）
download_vendor.bat

# 2. 一键初始化 + 环境验证
setup.bat

# 3. 启动服务
start.bat
#    访问 http://localhost:8976
```

`setup.bat` 自动完成：Python检查 → 内存检查 → venv创建 → 离线依赖安装 → 目录创建 → **环境验证**（核心库/设备/模型/内存）。

## Patch10 新特性

- 🌙 深色模式（设置面板切换）
- 🧩 扩展中心（统一安装模型/KB/Whisper）
- 🤖 Agent 智能化改进（工具调用更可靠）
- 📊 模型加载进度条（实时 SSE 推送）
- 📝 代码块高亮 + 一键复制
- 💾 对话/纪要导出（.md/.txt/.docx）
- 🎯 KB 状态机简化（安装即用）
- 🔒 全面离线独立运行（零外连依赖）
- 🛡️ 自动阻断 telemetry 后台通信

## 离线独立运行

项目已完成全面离线审计（见 `OFFLINE_AUDIT_REPORT.md`），所有代码过程可脱离互联网独立运行：

| 保护机制 | 说明 |
|----------|------|
| `server.py` 启动拦截 | 在导入任何库之前设置 `HF_HUB_OFFLINE=1`、`OPENVINO_TELEMETRY=0` |
| `start.bat` 环境变量 | 所有离线保护环境变量在启动脚本层级设置 |
| `setup.bat` 离线路径 | 检测 vendor/ 后自动走 `--no-index --find-links` |
| `preflight.py` 检查 | 独立环境检查脚本，验证所有依赖和目录 |
| `download_vendor.bat` | 一键准备离线依赖包 |

**已移除的联网功能：**
- `cloud_provider.py` — 云端 API 代理（已删除）
- 云端 API 相关配置项（从 config.py 移除）

## 扩展模块

扩展包 ZIP 放在 `export/` 目录，通过前端扩展中心上传安装：

| 扩展 | 文件名 | 大小 |
|------|--------|------|
| Qwen3 0.6B | qwen3-0.6b.zip | 437MB |
| Qwen3 1.7B | qwen3-1.7b.zip | 1.2GB |
| Qwen3 4B | qwen3-4b.zip | 2.3GB |
| Qwen3 8B | qwen3-8b-openvino-int4.zip | 3.6GB |
| 知识库 | kb-module-offline-v1.0.zip | 1.2GB |
| Whisper | whisper-small-extension.zip | 508MB |

## 版本

- Server: Patch 10
- Agent: v2.1
- Prompts: v3.2

---

*更多文档见 `docs/` 目录*
