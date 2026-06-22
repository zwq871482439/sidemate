# P7 规划 — 底层能力升级

## P7-1: 动态 num_ctx（启动时自动推荐）

**目标**：不再硬编码上下文窗口，启动时检测硬件自动推荐最优值。

**推荐表**：
| 硬件 | num_ctx | 
|------|---------|
| 独立 GPU ≥ 8GB | 32K |
| 独立 GPU ≥ 4GB | 16K |
| CPU / 集成显卡 | 8K |
| 内存 < 8GB | 4K |

**实现**：
- Go Launcher 启动时检测 GPU VRAM + 可用 RAM
- 写入 Ollama Modelfile → ollama create → 启动
- 设置页加滑块（显示推荐值，可调，改后提示重新加载模型）

---

## P7-2: ModelScope 下载 Qwen3.5 系列模型

**目标**：从 ModelScope 下载 Qwen3.5-1.5B/4B/7B/14B GGUF，自动安装到 Ollama，支持多模型切换。

**范围**：
- 设置页「模型管理」新增"下载模型"入口
- 列出可用模型清单（含大小、推荐配置）
- 显示下载进度 + 预估时间
- 下载完成后自动 `ollama create`
- 下拉切换已下载的模型

---

## P7-3: ModelScope 下载 BGE + Reranker

**目标**：从 ModelScope 下载嵌入模型和重排序模型，支持多类型切换。

**范围**：
- BGE: bge-m3 / bge-large-zh-v1.5 / bge-small-zh-v1.5
- Reranker: bge-reranker-v2-m3 / bge-reranker-large
- 设置页显示已安装/未安装状态
- 一键下载 + 自动配置
- 下拉切换

---

## P7-4: Ollama 底座 → llama.cpp 底座

**目标**：用 llama.cpp 替代 Ollama，减少中间层开销，直接控制推理参数。

**动机**：
- 性能：去掉 HTTP 中转，降低延迟
- 可控性：直接设置 num_ctx、threads、gpu_layers
- 部署：单一进程，无需额外 Docker/service

**范围**：
- Go Launcher 嵌入 llama.cpp CGO 绑定
- 支持 GGUF 模型直接加载
- 保留 Ollama 作为可选项（向后兼容）
- 推理参数通过 settings.json 配置
