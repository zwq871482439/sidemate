# Patch12 数据架构设计

## 数据目录结构

```
data/                           # 主数据目录（config.DATA_DIR）
├── chats/                      # 对话记录（config.CHAT_DIR）
│   ├── 2026-05-27_001.json    # 命名格式: {日期}_{序号}.json
│   ├── 2026-05-28_001.json
│   └── 2026-05-29_001.json
├── kb/                         # 文库数据
│   ├── kb_meta.json           # 文档元信息 + chunk 索引
│   ├── kb_vectors.npz         # 向量索引（numpy 压缩格式）
│   ├── kb_texts/              # chunk 原文（按 chunk_id 存储）
│   │   └── {chunk_id}.txt     # 每个文件对应一个 chunk
│   └── module/                # KB 扩展模块
│       ├── install_info.json  # 安装信息（版本、安装时间、模型列表）
│       └── wheels/            # 离线依赖包（可选）
├── logs/                       # 日志目录（config.LOG_DIR）
│   └── server.log             # 主服务日志
├── tmp_upload/                 # 临时上传目录（config.UPLOAD_DIR）
│   └── {safe_filename}        # 上传的文件缓存
├── files/                      # 文件存储目录（config.FILES_DIR）
└── recordings/                 # 录音文件存储
    └── {session_id}/          # 按录音会话组织
        ├── audio.webm          # 原始录音音频
        ├── transcript.json     # 转写稿
        └── meta.json          # 会话元数据
```

## SQLite 数据库

**当前 Patch12 未使用 SQLite 数据库。**

所有数据存储采用 JSON 文件 + numpy 向量文件的方式：

| 数据类型 | 存储格式 | 文件 |
|---------|---------|------|
| 对话记录 | JSON | `data/chats/{date}_{idx}.json` |
| 文库元信息 | JSON | `data/kb/kb_meta.json` |
| 文库向量 | numpy npz | `data/kb/kb_vectors.npz` |
| 文库 chunk 文本 | 文本文件 | `data/kb/kb_texts/{chunk_id}.txt` |
| 录音元数据 | JSON | `data/recordings/{session_id}/meta.json` |
| 系统配置 | JSON | `settings.json` |

### 对话文件格式

```json
{
  "version": 2,
  "messages": [
    {
      "role": "user",
      "content": "用户消息",
      "ts": "14:30:00"
    },
    {
      "role": "assistant",
      "content": "AI 回复",
      "ts": "14:30:05",
      "think": "思考过程内容（可选）",
      "model": "qwen3-8b-ov",
      "chars": 150,
      "think_chars": 200,
      "time": 5.2,
      "speed": 67,
      "task_type": "text"
    }
  ],
  "updated_at": "2026-05-29 14:30:05"
}
```

### 文库元信息格式（kb_meta.json）

包含 `KBDocument` 和 `KBChunk` 的数据结构：

**KBDocument**:
```python
@dataclass
class KBDocument:
    doc_id: str           # UUID
    filename: str         # 原始文件名
    file_type: str        # 文件扩展名
    file_size: int        # 文件大小（字节）
    imported_at: str      # 导入时间 ISO 格式
    status: str           # pending/processing/indexing/ready/paused/cancelled/error
    chunk_count: int      # 分块数量
    total_chars: int      # 总字符数
    progress: float       # 处理进度 0.0-1.0
    source: str           # upload | transcript
    metadata: dict        # 额外元数据（如 has_images）
    error_msg: str        # 错误信息
    summary: str          # 文档前200字预览
```

**KBChunk**:
```python
@dataclass
class KBChunk:
    chunk_id: str         # UUID
    doc_id: str           # 所属文档 ID
    index: int            # 块序号
    text: str             # 块文本（从 kb_texts/ 文件单独加载）
    char_count: int       # 字符数
    heading: str          # 标题
    source_label: str     # 来源标注，如 "报告.pdf §第一章"
```

## 文件存储结构

### 模型文件（models/）

```
models/                          # 模型存储（符号链接 → _local_ai_patch10/models/）
├── qwen3-8b-ov/                # Qwen3 8B OpenVINO 格式
│   ├── openvino_model.bin
│   ├── openvino_model.xml
│   ├── config.json
│   ├── tokenizer.json
│   └── ...
├── bge-small-zh-v1.5-ov/       # BGE 嵌入模型 OpenVINO 格式（KB 扩展）
│   ├── openvino_model.xml
│   └── ...
├── bge-reranker-base-ov/       # BGE Reranker OpenVINO 格式（KB 扩展）
│   ├── openvino_model.xml
│   └── ...
└── ...                         # 其他模型
```

### 扩展模块

```
extensions/
└── whisper/                     # Whisper 语音识别扩展
    ├── manifest.json           # 扩展清单
    ├── models/                 # Whisper 模型文件
    │   └── model.bin
    └── wheels/                 # 离线依赖包
```

## 配置文件

### config.py（全局配置中心）

**路径**: 项目根目录 `config.py`

**核心常量**:
| 常量 | 值 | 说明 |
|------|---|------|
| `ROOT_DIR` | `os.path.dirname(os.path.abspath(__file__))` | 项目根目录 |
| `DATA_DIR` | `{ROOT_DIR}/data` | 数据目录 |
| `CHAT_DIR` | `{DATA_DIR}/chats` | 对话目录 |
| `LOG_DIR` | `{DATA_DIR}/logs` | 日志目录 |
| `UPLOAD_DIR` | `{DATA_DIR}/tmp_upload` | 临时上传目录 |
| `FILES_DIR` | `{DATA_DIR}/files` | 文件存储目录 |
| `WORKSPACE_DIR` | `ROOT_DIR` | 工作区（= 根目录） |

**配置管理方式**:
1. `DEFAULTS` 字典定义所有默认值（唯一真相源）
2. `settings.json` 覆盖用户自定义值
3. `get(key)` 带 TTL 缓存（5秒过期）读取
4. `set_value(key, value)` 保存到 settings.json
5. `save_config(config)` 合并写入

### settings.json（用户配置）

**路径**: `{ROOT_DIR}/settings.json`

当前内容示例：
```json
{
  "memory_budget_mb": 10240,
  "reranker_resident": true,
  "scene_skills": {
    "doc": ["file-ops", "word-reader", "word-writer", "kb-search", "long-reader"],
    "code": ["code-runner", "file-ops"]
  },
  "device": "NPU",
  "permission_mode": "assist",
  "recorder_resident": false
}
```

### 配置分组一览

| 分组 | 配置项数 | 说明 |
|------|---------|------|
| 通用 | 3 | 沙盒清理、默认模式、确认机制 |
| 文件操作限制 | 2 | 读写大小限制 |
| Agent | 3 | 迭代次数、超时、结果压缩 |
| 会话缓存 | 4 | 缓存比率、条目上限等 |
| 文件上传 | 1 | 最大上传大小 |
| 模型/设备 | 8 | 设备、token 限制、异常检测 |
| 蒸馏 | 3 | 摘要/问题/回答长度 |
| 上下文压缩器 | 4 | 压缩参数 |
| 长文本分段 | 7 | chunk 相关参数 |
| 文库 | 11 | KB 相关参数 |
| 录音纪要 | 7 | 录音参数 |
| Whisper | 7 | 语音转写参数 |
| 内存预算 | 5 | 预算管理 |
| KB 检索 | 4 | 检索参数 |
| 签名 | 1 | HMAC 密钥 |

## 数据流概览

```
用户请求 → FastAPI Router → deps.py(获取全局实例)
                              ↓
                        ModelManager(模型推理)
                              ↓
                        StreamEngine(流式生成)
                              ↓
                        ThinkProcessor(思考分离)
                              ↓
                        ResponseFilter(响应过滤)
                              ↓
                        ChatStore(保存对话)
```

```
文库文档 → FileExtractor(文本提取)
              ↓
         ChunkingOrchestrator(分块)
              ↓
         EmbeddingEngine(向量化)
              ↓
         kb_meta.json + kb_vectors.npz + kb_texts/
              ↓
         检索: 向量搜索 → RerankerEngine(精排) → 上下文注入
```
