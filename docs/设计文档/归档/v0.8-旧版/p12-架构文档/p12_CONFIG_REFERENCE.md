# 桌伴 Sidemate 配置参考手册

> config.py 是唯一的配置中心，所有模块通过 `config.get()` 读取
> 配置文件：项目根目录下的 `settings.json`

---

## 快速查找表

| 键名 | 默认值 | 分组 |
|------|--------|------|
| `sandbox_cleanup` | `"24h"` | 通用 |
| `default_mode` | `"qa"` | 通用 |
| `confirm_external_read` | `True` | 通用 |
| `max_read_size_mb` | `10` | 文件操作 |
| `max_write_size_mb` | `5` | 文件操作 |
| `agent_max_iterations` | `8` | Agent |
| `agent_timeout` | `120` | Agent |
| `agent_result_max_chars` | `800` | Agent |
| `cache_keep_ratio` | `0.4` | 会话缓存 |
| `cache_entry_max_chars` | `80` | 会话缓存 |
| `cache_max_total_chars` | `500` | 会话缓存 |
| `cache_threshold_ratio` | `0.8` | 会话缓存 |
| `upload_max_size` | `52428800` | 上传 |
| `device` | `""` | 模型/设备 |
| `npu_default_prompt_tokens` | `2400` | 模型/设备 |
| `gpu_default_prompt_tokens` | `32000` | 模型/设备 |
| `cpu_default_prompt_tokens` | `32000` | 模型/设备 |
| `token_safety_margin` | `0.95` | 模型/设备 |
| `npu_history_token_ratio` | `0.4` | 模型/设备 |
| `npu_history_max_chars` | `800` | 模型/设备 |
| `stall_check_tokens` | `15` | 模型/设备 |
| `repeat_window` | `12` | 模型/设备 |
| `repeat_threshold` | `0.5` | 模型/设备 |
| `max_retry` | `1` | 模型/设备 |
| `distill_summary_max_chars` | `100` | 蒸馏 |
| `distill_question_max_chars` | `200` | 蒸馏 |
| `distill_answer_max_chars` | `500` | 蒸馏 |
| `compress_max_code_chars` | `600` | 压缩器 |
| `offline_compress_max_input` | `2000` | 压缩器 |
| `offline_compress_timeout` | `30` | 压缩器 |
| `offline_compress_max_tokens` | `512` | 压缩器 |
| `chunk_threshold_chars` | `8000` | 长文本分段 |
| `chunk_max_chars` | `2500` | 长文本分段 |
| `chunk_overlap_chars` | `200` | 长文本分段 |
| `chunk_memory_max_chars` | `800` | 长文本分段 |
| `chunk_max_chunks` | `30` | 长文本分段 |
| `chunk_per_chunk_timeout` | `30` | 长文本分段 |
| `chunk_npu_max_chars` | `1200` | 长文本分段 |
| `kb_max_documents` | `20` | 文库 |
| `kb_max_total_chunks` | `1000` | 文库 |
| `kb_chunk_max_chars` | `2500` | 文库 |
| `kb_chunk_overlap_chars` | `200` | 文库 |
| `kb_search_top_k` | `5` | 文库 |
| `kb_embedding_model` | `"BAAI/bge-small-zh-v1.5"` | 文库 |
| `kb_vector_dim` | `512` | 文库 |
| `kb_embed_batch_size` | `50` | 文库 |
| `kb_async` | `True` | 文库 |
| `kb_data_dir` | `""` | 文库 |
| `kb_ov_max_chars` | `480` | 文库检索 |
| `kb_vector_score_threshold` | `0.28` | 文库检索 |
| `kb_relevance_floor` | `0.25` | 文库检索 |
| `kb_reranker_top_k` | `5` | 文库检索 |
| `recorder_chunk_seconds` | `10` | 录音纪要 |
| `recorder_max_duration` | `3600` | 录音纪要 |
| `recorder_sample_rate` | `16000` | 录音纪要 |
| `recorder_format` | `"webm/opus"` | 录音纪要 |
| `recorder_max_file_size` | `52428800` | 录音纪要 |
| `recorder_max_sessions` | `20` | 录音纪要 |
| `recorder_keep_audio` | `True` | 录音纪要 |
| `recorder_crash_recovery` | `True` | 录音纪要 |
| `whisper_model` | `"small"` | Whisper |
| `whisper_language` | `"zh"` | Whisper |
| `whisper_device` | `"cpu"` | Whisper |
| `whisper_keep_loaded` | `True` | Whisper |
| `whisper_enable_refine` | `True` | Whisper |
| `whisper_realtime_chunk_sec` | `10` | Whisper |
| `whisper_lock_on_transcribe` | `True` | Whisper |
| `whisper_refine_batch_chars` | `800` | Whisper |
| `memory_budget_mb` | `8000` | 内存预算 |
| `memory_budget_min_mb` | `8192` | 内存预算 |
| `memory_budget_max_mb` | `12288` | 内存预算 |
| `reranker_idle_timeout_sec` | `300` | 内存预算 |
| `reranker_resident` | `False` | 内存预算 |
| `recorder_resident` | `False` | 内存预算 |
| `sidemate_hmac_key` | 环境变量或默认值 | 签名 |

---

## 运行时目录结构

```
项目根目录/
├── data/               # DATA_DIR — 数据根目录
│   ├── chats/          # CHAT_DIR — 对话历史 JSON 文件
│   ├── logs/           # LOG_DIR — 运行日志
│   ├── tmp_upload/     # UPLOAD_DIR — 临时上传文件
│   ├── files/          # FILES_DIR — 沙盒生成文件
│   └── kb/             # 文库数据（索引、向量、元数据）
├── models/             # AI 模型文件
├── settings.json       # 用户配置覆盖文件
└── config.py           # 配置中心（默认值定义）
```

---

## 分组详解

### 1. 通用参数

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `sandbox_cleanup` | string | `"24h"` | 沙盒清理策略 | `"24h"` 适合日常；`"never"` 适合开发调试 |
| `default_mode` | string | `"qa"` | 默认对话模式 | `"qa"` 纯对话；`"exec"` Agent 执行模式 |
| `confirm_external_read` | bool | `True` | 读取外部文件时需确认 | 生产保持 `True`；开发可 `False` |

### 2. 文件操作限制

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `max_read_size_mb` | int | `10` | 最大读取文件大小（MB） | 超大文件场景可调到 20 |
| `max_write_size_mb` | int | `5` | 最大写入文件大小（MB） | 一般不需要调整 |

### 3. Agent 设置

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `agent_max_iterations` | int | `8` | 最大迭代次数 | 复杂任务可调到 12；简单任务降到 5 |
| `agent_timeout` | int | `120` | 超时秒数 | NPU 可调到 180；CPU 可调到 300 |
| `agent_result_max_chars` | int | `800` | 工具结果压缩阈值 | 调低节省上下文空间；调高保留更多信息 |

### 4. 会话缓存

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `cache_keep_ratio` | float | `0.4` | 保留最近 40% 原始消息 | 0.3-0.6 之间调整 |
| `cache_entry_max_chars` | int | `80` | 每条缓存最大字符数 | 调高保留更多细节 |
| `cache_max_total_chars` | int | `500` | 缓存总字符上限 | NPU 可降到 300 |
| `cache_threshold_ratio` | float | `0.8` | 触发压缩阈值比例 | 0.7-0.9 之间 |

### 5. 文件上传

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `upload_max_size` | int | `52428800` | 最大上传大小（50MB） | 一般不需要调整 |

### 6. 模型/设备

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `device` | string | `""` | 推理设备（空=自动） | `"NPU"` / `"GPU"` / `"CPU"` |
| `npu_default_prompt_tokens` | int | `2400` | NPU prompt token 上限 | NPU 不稳定可降到 1800 |
| `gpu_default_prompt_tokens` | int | `32000` | GPU prompt token 上限 | 一般不动 |
| `cpu_default_prompt_tokens` | int | `32000` | CPU prompt token 上限 | 一般不动 |
| `token_safety_margin` | float | `0.95` | 安全系数（95%） | 不建议改 |
| `npu_history_token_ratio` | float | `0.4` | NPU 历史占 token 上限比例 | 0.3-0.5 之间 |
| `npu_history_max_chars` | int | `800` | NPU 历史字符绝对上限 | 降到 500 可更稳定 |
| `stall_check_tokens` | int | `15` | 停滞检测窗口 | 降到 10 更敏感 |
| `repeat_window` | int | `12` | 重复检测窗口 | 降到 8 更敏感 |
| `repeat_threshold` | float | `0.5` | 重复率阈值 | 降到 0.4 更严格 |
| `max_retry` | int | `1` | 异常后重试次数 | 可设为 0 禁用重试 |

### 7. 蒸馏（对话摘要）

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `distill_summary_max_chars` | int | `100` | 摘要最大字符数 | 调高保留更多上下文 |
| `distill_question_max_chars` | int | `200` | 问题最大字符数 | 一般不需要调整 |
| `distill_answer_max_chars` | int | `500` | 回答最大字符数 | 一般不需要调整 |

### 8. 上下文压缩器

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `compress_max_code_chars` | int | `600` | 压缩后代码截断长度 | 调高保留更多代码 |
| `offline_compress_max_input` | int | `2000` | 离线压缩最大输入 | 一般不动 |
| `offline_compress_timeout` | int | `30` | 离线压缩超时（秒） | NPU 可调到 60 |
| `offline_compress_max_tokens` | int | `512` | 离线压缩最大生成 token | 一般不动 |

### 9. 长文本分段处理

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `chunk_threshold_chars` | int | `8000` | 触发分段阈值 | 调高则只对更长文本分段 |
| `chunk_max_chars` | int | `2500` | 每段目标字数 | 调低提高精度但增加轮次 |
| `chunk_overlap_chars` | int | `200` | 段间重叠字数 | 100-300 之间 |
| `chunk_memory_max_chars` | int | `800` | 滚动记忆上限 | NPU 降到 500 |
| `chunk_max_chunks` | int | `30` | 最多分段数 | 安全上限，防止无限分段 |
| `chunk_per_chunk_timeout` | int | `30` | 每段处理超时（秒） | NPU 可调到 60 |
| `chunk_npu_max_chars` | int | `1200` | NPU 每段目标字数 | 比 chunk_max_chars 更小 |

### 10. 文库

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `kb_max_documents` | int | `20` | 最大文档数 | 视存储空间调整 |
| `kb_max_total_chunks` | int | `1000` | 最大 chunk 总数 | 支持大文档场景 |
| `kb_chunk_max_chars` | int | `2500` | 分块最大字符数 | 调高增加上下文但降低精度 |
| `kb_chunk_overlap_chars` | int | `200` | 分块重叠 | 100-300 之间 |
| `kb_search_top_k` | int | `5` | 检索返回 top-k | 3-10 之间 |
| `kb_embedding_model` | string | `"BAAI/bge-small-zh-v1.5"` | 嵌入模型 | 安装时锁定 |
| `kb_vector_dim` | int | `512` | 向量维度 | 由嵌入模型决定 |
| `kb_embed_batch_size` | int | `50` | 嵌入批处理大小 | 内存不足降到 20 |
| `kb_async` | bool | `True` | 异步处理开关 | 保持 True |
| `kb_data_dir` | string | `""` | 文库数据目录 | 空=默认 data/kb/ |

### 11. 文库检索参数

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `kb_ov_max_chars` | int | `480` | OV pipeline 输入截断 | >512 tokens 会崩溃，勿超过 500 |
| `kb_vector_score_threshold` | float | `0.28` | 向量检索最低相似度 | 调低召回更多但可能不相关 |
| `kb_relevance_floor` | float | `0.25` | MMR 相关性地板 | 低于此值的候选跳过 |
| `kb_reranker_top_k` | int | `5` | Reranker 精排数量 | 3-10 之间 |

### 12. 录音纪要

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `recorder_chunk_seconds` | int | `10` | 录音分块秒数 | 5-15 之间 |
| `recorder_max_duration` | int | `3600` | 最长录音（秒） | 1小时上限 |
| `recorder_sample_rate` | int | `16000` | 采样率 | Whisper 标准 16kHz |
| `recorder_format` | string | `"webm/opus"` | 音频格式 | WebM/Opus 压缩率高 |
| `recorder_max_file_size` | int | `52428800` | 导入音频最大 50MB | 视需求调整 |
| `recorder_max_sessions` | int | `20` | 录音 session 上限 | 磁盘空间够可调高 |
| `recorder_keep_audio` | bool | `True` | 长期保留音频 | False 可节省磁盘 |
| `recorder_crash_recovery` | bool | `True` | 崩溃恢复 | 保持 True |

### 13. Whisper

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `whisper_model` | string | `"small"` | Whisper 模型大小 | `small`(~1GB)/`medium`(~1.5GB) |
| `whisper_language` | string | `"zh"` | 默认语言 | 中文环境保持 zh |
| `whisper_device` | string | `"cpu"` | 推理设备 | Whisper 固定 CPU |
| `whisper_keep_loaded` | bool | `True` | 模型常驻内存 | False 省内存但首次慢 |
| `whisper_enable_refine` | bool | `True` | 8B 辅助纠错 | False 跳过纠错节省时间 |
| `whisper_realtime_chunk_sec` | int | `10` | 实时转写每 chunk 秒数 | 5-15 之间 |
| `whisper_lock_on_transcribe` | bool | `True` | 转写时锁定对话 Tab | 防止资源冲突 |
| `whisper_refine_batch_chars` | int | `800` | 8B 纠错批次大小 | 调低减少单次延迟 |

### 14. 内存预算

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `memory_budget_mb` | int | `8000` | 内存预算上限（MB） | 16GB 机器可设 12288 |
| `memory_budget_min_mb` | int | `8192` | 滑块最小值 | 8GB 起步 |
| `memory_budget_max_mb` | int | `12288` | 滑块最大值 | 32GB 机器可设更高 |
| `reranker_idle_timeout_sec` | int | `300` | Reranker 空闲超时（秒） | 5分钟自动卸载 |
| `reranker_resident` | bool | `False` | Reranker 常驻 | True=不自动卸载 |
| `recorder_resident` | bool | `False` | Whisper 常驻 | True=不自动卸载 |

### 15. 签名

| 键名 | 类型 | 默认值 | 说明 | 调优建议 |
|------|------|--------|------|---------|
| `sidemate_hmac_key` | string | 环境变量 | .sidemate 包签名密钥 | 生产环境通过环境变量 `SIDEMATE_HMAC_KEY` 传入 |

---

## API 使用示例

```python
import config

# 读取配置
device = config.get("device")  # 返回 "NPU" 或 ""
max_tokens = config.get("npu_default_prompt_tokens", 2400)  # 带默认值

# 写入配置
config.set_value("device", "GPU")
config.save_config({"memory_budget_mb": 10240})

# 确保运行时目录存在
config.ensure_dirs()

# 清除缓存（强制下次从文件读取）
config._invalidate_cache()
```

### 配置优先级

1. `settings.json` 中的用户配置（最高优先级）
2. `config.DEFAULTS` 中的默认值
3. `config.get(key, fallback)` 中的 fallback 参数（最低优先级）

### TTL 缓存机制

- 缓存有效期：**5 秒**（`_CACHE_TTL = 5`）
- 首次调用 `config.get()` 从磁盘加载
- 5 秒内的后续调用直接返回缓存
- `config.save_config()` 后自动清空缓存
- `config._invalidate_cache()` 手动清空
