# Patch12 项目总览

## 项目名称

**桌伴** — 本地 AI 助手（Local AI Assistant）

## 版本

- **版本号**: `0.12`（VERSION=0.8, VERSION_PATCH=12）
- **来源**: `server.py:72-73` 定义 `VERSION = "0.8"`, `VERSION_PATCH = 12`
- **展示格式**: `v0.8 patch 12`（即 `v0.12`）

## 技术栈

| 层级 | 技术 | 版本 |
|------|------|------|
| Web 框架 | FastAPI | 0.136.1 |
| ASGI 服务器 | Uvicorn | 0.46.0 |
| SSE 支持 | sse-starlette | 3.4.1 |
| AI 推理引擎 | OpenVINO GenAI | 2026.1.0.0 |
| 大语言模型 | Qwen3 系列 | 通过 OpenVINO 格式加载 |
| 嵌入模型 | BAAI/bge-small-zh-v1.5 | sentence-transformers 5.5.0 |
| NLP 工具 | jieba, rank-bm25 | 分词 + BM25 检索 |
| 语音转写 | faster-whisper + ctranslate2 | 扩展包安装 |
| Python 版本 | 3.14 (Windows) | — |
| 运行环境 | Windows 11 离线环境 | NPU/GPU/CPU 三模式 |

## 9 包 28 模块结构

### 包一览（9 个）

| 包名 | 说明 | 模块数 |
|------|------|--------|
| `core/` | 核心推理引擎（模型管理、流式生成、Prompt 构建） | 6 |
| `routers/` | FastAPI 路由（6 个 Router 模块） | 8 |
| `session/` | 会话管理（聊天存储、上下文缓存、续写） | 4 |
| `knowledge/` | 知识库（分块、嵌入、Reranker、内存管理） | 6 |
| `intelligence/` | 智能模块（Action 路由、响应过滤、策略分类、停滞检测） | 6 |
| `files/` | 文件处理（文档读写、文件提取） | 5 |
| `common/` | 通用工具（取消令牌、上下文压缩、安全文件名） | 4 |
| `recorder_pkg/` | 录音纪要管理 | 2 |
| `validators/` | 验证器（.sidemate 包签名校验） | 2 |
| `actions/` | Action 实现（文档操作） | 2 |
| `pipeline/` | Pipeline（已归档，仅保留 init） | 1 |

### 模块详细列表

#### core/ (6 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 7 | 导出 ModelManager, StreamEngine, PromptBuilder, ThinkProcessor, GenerateQueue, GenerateTicket |
| `model_manager.py` | 981 | 模型管理器：加载/卸载/切换设备/推理入口 |
| `stream_engine.py` | 661 | 流式生成引擎：token 流处理 |
| `prompt_builder.py` | 292 | Prompt 构建器：system prompt 拼装 |
| `think_processor.py` | 257 | 思考过程处理：`<think/>` 标签解析 |
| `generate_queue.py` | 165 | 生成队列：排队管理 |

#### routers/ (8 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 11 | 包说明 |
| `chat.py` | 844 | 聊天/会话/QA/文件上传路由 |
| `kb.py` | 882 | 文库管理路由 |
| `settings.py` | 895 | 设置/模型/配置/扩展路由 |
| `recorder.py` | 300 | 录音纪要路由 |
| `skill.py` | 60 | Action 管理路由 |
| `files.py` | 89 | 缓存文件管理路由 |
| `deps.py` | 64 | 共享依赖注入枢纽 |

#### session/ (4 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 0 | 空 |
| `chat_store.py` | 158 | 聊天文件 CRUD |
| `context_cache.py` | 169 | 上下文缓存/压缩 |
| `continuation.py` | 82 | 自动续写检测 |

#### knowledge/ (6 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 2 | 包说明 |
| `chunker.py` | 364 | 文本分块器 |
| `chunking_orchestrator.py` | 416 | 分块编排器 |
| `embedding_engine.py` | 128 | 嵌入引擎（BGE/OpenVINO） |
| `reranker_engine.py` | 155 | Reranker 精排引擎 |
| `memory_manager.py` | 119 | 内存预算管理 |

#### intelligence/ (6 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 2 | 包说明 |
| `action_registry.py` | 73 | Action 注册表 |
| `action_router.py` | 100 | `/xx` 指令路由 |
| `response_filter.py` | 1032 | 响应过滤器（重复检测/前缀累积清理） |
| `stall_detector.py` | 187 | 生成停滞检测器 |
| `task_classifier.py` | 194 | 任务策略分类器 |

#### files/ (5 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 0 | 空 |
| `doc_reader.py` | 462 | 文档读取（Word/PDF/Excel） |
| `doc_writer.py` | 355 | 文档写入 |
| `file_extractor.py` | 232 | 文件内容提取（三级策略） |
| `file_reader.py` | 93 | 文件读取工具 |

#### common/ (4 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 2 | 包说明 |
| `cancellation.py` | 66 | CancellationToken 取消令牌 |
| `context_compressor.py` | 465 | 上下文压缩器 |
| `safe_filename.py` | 25 | 安全文件名工具 |

#### recorder_pkg/ (2 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 0 | 空 |
| `recorder_manager.py` | 1147 | 录音纪要管理器 |

#### validators/ (2 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 0 | 空 |
| `sidemate_validator.py` | 222 | .sidemate 包 HMAC 签名校验 |

#### actions/ (2 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 0 | 空 |
| `doc_action.py` | 118 | 文档操作 Action |

#### pipeline/ (1 模块)
| 模块 | 行数 | 说明 |
|------|------|------|
| `__init__.py` | 5 | 归档说明 |

### 根目录核心文件

| 文件 | 行数 | 说明 |
|------|------|------|
| `server.py` | 280 | 主服务入口 + 全局实例化 |
| `config.py` | 247 | 全局配置中心 |
| `knowledge_base.py` | 1587 | 文库核心（桥文件，re-export 新包） |
| `models.py` | 2431 | 模型管理（旧版，未完全迁移） |
| `prompts.py` | — | Prompt 模板集合 |

## 启动方式

```bash
# 方式 1: 直接启动（带看门狗自动重启）
python server.py

# 方式 2: 直接启动（跳过看门狗）
python server.py --serve

# 方式 3: 通过批处理
start.bat
```

## 环境要求

- **操作系统**: Windows 11
- **Python**: >= 3.10（推荐 3.14）
- **内存**: >= 8GB（推荐 16GB）
- **硬盘**: >= 10GB（含模型文件）
- **GPU**: 可选，支持 NPU (Intel)、GPU (Intel Arc)、CPU 三种推理模式
- **网络**: 完全离线运行，无需网络连接

## 目录结构

```
_local_ai_patch12/
├── server.py              # 主服务入口
├── config.py              # 全局配置中心
├── knowledge_base.py      # 文库核心（桥文件）
├── models.py              # 模型管理（旧版）
├── prompts.py             # Prompt 模板
├── settings.json          # 用户配置
├── requirements.txt       # 依赖列表
├── setup.bat              # 环境搭建脚本
├── start.bat              # 启动脚本
├── preflight.py           # 环境检查
├── index.html             # 前端页面
├── static/                # 静态资源
├── data/                  # 运行时数据
│   ├── chats/             # 对话记录
│   ├── kb/                # 文库数据
│   ├── logs/              # 日志
│   ├── tmp_upload/        # 临时上传
│   ├── files/             # 文件存储
│   └── recordings/        # 录音文件
├── models/ → ../patch10/models/   # 模型文件（符号链接）
├── core/                  # 核心推理引擎
├── routers/               # API 路由
├── session/               # 会话管理
├── knowledge/             # 知识库模块
├── intelligence/          # 智能模块
├── files/                 # 文件处理
├── common/                # 通用工具
├── recorder_pkg/          # 录音纪要
├── validators/            # 验证器
├── actions/               # Action 实现
└── pipeline/              # 已归档
```
