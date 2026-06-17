# 桌伴 Sidemate v0.9 — 产品需求文档

## 项目信息

| 字段 | 值 |
|---|---|
| Project Name | sidemate-v0.9 |
| 版本 | 0.9 |
| 语言 | 中文 |
| 技术栈 | FastAPI + Ollama + 前端(不变) |
| 原始需求 | 将推理底座从 OpenVINO GenAI 迁移到 Ollama，模型从 Qwen3-8B INT4 升级到 Qwen3.5-4B GGUF Q5_K_M |

---

## 1. 产品目标

**将 Sidemate 的推理底座从 OpenVINO GenAI 迁移到 Ollama，彻底解决 think/answer 分离不稳定问题，同时提升系统在 Intel Arc 集显上的运行稳定性和维护性。**

---

## 2. 用户故事

| # | 用户故事 |
|---|---|
| US-1 | 作为用户，我希望 AI 回复中思考过程和最终答案能**干净分离**，不再出现残缺的 `</think` 标签泄漏到正文中。 |
| US-2 | 作为用户，我希望简单问候（如"你好"）能得到**快速响应**，不再因为模型强制深度思考而等待数秒才输出一个字。 |
| US-3 | 作为用户，我希望 AI 助手在长时间运行后依然稳定，不再遇到 Python 3.14 下 StreamerBase segfault 导致的崩溃。 |
| US-4 | 作为开发者，我希望推理层代码大幅简化——利用 Ollama 原生 `reasoning_content` 字段，而不是维护一套 hack 文本匹配逻辑。 |
| US-5 | 作为用户，我希望本次升级对我的使用体验**零感知**——前端界面、API 接口、文库和纪要功能完全不变。 |

---

## 3. 需求池

### P0 — Must Have（必须完成）

| ID | 需求 | 验收标准 |
|---|---|---|
| P0-1 | Ollama 进程管理 | `core/ollama_manager.py` 能启动/停止/健康检查 Ollama 进程，服务启动时自动拉起 |
| P0-2 | 模型调用切换 | `core/model_manager.py` 从 openvino_genai.LLMPipeline 改为调用 Ollama HTTP API (`/v1/chat/completions`) |
| P0-3 | SSE 流式输出 | `core/stream_engine.py` 从 lambda streamer 改为 Ollama SSE streaming，逐 token 推送到前端 |
| P0-4 | Think/Answer 分离 | 利用 Ollama 原生 `reasoning_content` 字段实现 think/answer 分离，**移除**旧版文本匹配 hack |
| P0-5 | 生成队列适配 | `core/generate_queue.py` 适配 Ollama，确保并发请求串行排队执行 |
| P0-6 | 依赖清理 | 删除 openvino-genai 相关依赖，新增 httpx（或 aiohttp）；确认 Python 3.14 兼容 |
| P0-7 | 配置迁移 | `config.py` 新增 Ollama 相关配置（API URL、模型名、超时等），移除 OpenVINO 相关配置 |
| P0-8 | 前端零改动 | 所有 API 端点签名和 SSE 数据格式不变，`index.html` 不做任何修改 |

### P1 — Should Have（应该完成）

| ID | 需求 | 验收标准 |
|---|---|---|
| P1-1 | 健康检查端点 | 提供 `/health` 端点，返回 Ollama 服务状态 + 模型加载状态 |
| P1-2 | 模型自动拉取 | 首次启动时自动检测并拉取 `qwen3.5:4b-q5_k_m` 模型 |
| P1-3 | think 处理器简化 | `core/think_processor.py` 大幅简化或标记为 deprecated，逻辑内联到 stream_engine |
| P1-4 | 依赖注入调整 | `routers/deps.py` 适配新的模型管理接口 |

### P2 — Nice to Have（锦上添花）

| ID | 需求 | 验收标准 |
|---|---|---|
| P2-1 | 模型热切换 | 支持通过配置切换不同 Ollama 模型，无需重启服务 |
| P2-2 | 推理性能监控 | 记录 tokens/s、首 token 延迟等指标，可通过 API 查询 |
| P2-3 | Ollama 日志集成 | 将 Ollama 进程 stdout/stderr 集成到 Sidemate 日志系统 |

---

## 4. 技术约束

| 约束 | 说明 |
|---|---|
| 运行时 | Python 3.14 + FastAPI |
| 推理后端 | Ollama，使用 Intel SYCL 后端（Arc 集显，8 Xe-core） |
| 模型 | Qwen3.5-4B GGUF Q5_K_M（~3.2GB VRAM） |
| 硬件 | Intel Core Ultra 7 155H / 32GB DDR5 / Arc 集显（共享显存） |
| NPU | v0.9 不再使用 NPU |
| 前端 | 完全不变（index.html 零改动） |
| 不变模块 | 文库(knowledge/)、纪要(recorder_pkg/)、文件管理(files/)、Action Router 架构 |
| API 兼容 | Ollama `/v1/chat/completions`（OpenAI 兼容接口） |

---

## 5. 改动范围映射

```
core/
├── model_manager.py      # 重写：openvino → Ollama HTTP API
├── stream_engine.py      # 重写：lambda streamer → Ollama SSE
├── think_processor.py    # 简化/废弃：文本匹配 → 原生 reasoning_content
├── generate_queue.py     # 适配：Ollama 调用方式
├── ollama_manager.py     # 新增：进程管理 + 健康检查
config.py                 # 修改：新增 Ollama 配置，移除 OpenVINO 配置
requirements.txt          # 修改：删 openvino，加 httpx/aiohttp
routers/deps.py           # 可能调整：依赖注入
```

---

## 6. 待确认问题

| # | 问题 | 影响 |
|---|---|---|
| Q1 | Ollama SYCL 后端在 Arc 集显上的 tokens/s 实际表现？需实测确认是否满足交互体验要求（目标 ≥ 20 tokens/s） | P0-2, P0-3 |
| Q2 | Ollama 的 `reasoning_content` 在非思考模式（简单问候）下是否返回空？需确认 `reasoning_effort` 参数行为 | P0-4 |
| Q3 | Qwen3.5-4B 的上下文窗口默认值？是否需要通过 `num_ctx` 参数调整？ | P0-2 |
| Q4 | `generate_queue.py` 是否可以大幅简化？Ollama 本身是否支持并发请求？需确认是否还需要排队机制 | P0-5 |
| Q5 | Ollama 进程异常退出时的自动恢复策略？（重启间隔、最大重试次数） | P0-1 |
| Q6 | 是否需要保留 OpenVINO 作为 fallback 后端，还是完全移除？ | P0-6, P0-7 |

---

## 附录：迁移动机总结

| 问题 | 根因 | Ollama 如何解决 |
|---|---|---|
| `</think\n>` 闭合标签几乎不输出 | Qwen3-8B INT4 模型缺陷 | Qwen3.5-4B 原生支持 + Ollama `reasoning_content` 字段 |
| StreamerBase segfault | OpenVINO GenAI 与 Python 3.14 不兼容 | Ollama 是独立进程，通过 HTTP 通信 |
| `enable_thinking=False` 无效 | 模型训练行为，非 API 层可控 | Ollama 支持 `reasoning_effort` 参数控制思考深度 |
