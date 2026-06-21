# -*- coding: utf-8 -*-
"""
config.py - 全局配置管理（统一中心）
======================================
所有模块的可调参数集中在此定义，原位通过 config.get() 读取。

分组：
  - 通用：沙盒、模式、确认机制
  - Agent：迭代、超时、压缩
  - 会话缓存：上下文压缩相关
  - 上传：文件大小限制
  - 模型：Ollama 推理 token 限制、生成异常检测
  - 蒸馏：摘要/问题/回答长度限制
  - 压缩器：离线压缩参数
  - 长文本分段：chunk 相关参数
"""

import os
import json
import logging
import threading
from typing import Any, Dict

log = logging.getLogger(__name__)

# ===== 工作区根目录 =====
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))           # C:\Sidemate\server
PROJECT_ROOT = os.path.dirname(ROOT_DIR)                         # C:\Sidemate\（项目根）

# .sidemate 包签名密钥（HMAC-SHA256）
# 【安全级别说明】当前 HMAC 仅用作包完整性校验（防传输损坏），非安全签名。
# 密钥硬编码在源码中，不具备防伪造能力。如需安全签名，应升级为非对称方案（Ed25519）。
# 可通过环境变量 SIDEMATE_HMAC_KEY 覆盖默认密钥。
_SIDEMATE_HMAC_KEY_DEFAULT = "zhuoban-sidemate-default-key-v1"

# ===== 运行时目录（统一管理，避免散落各处） =====
# D1 重构：DATA_DIR 从 server/data 提升到项目根 data/
DATA_DIR = os.path.join(PROJECT_ROOT, "data")                    # C:\Sidemate\data
CACHE_DIR = os.path.join(DATA_DIR, "cache")       # P4: 缓存根目录
CHAT_DIR = os.path.join(DATA_DIR, "chats")
LOG_DIR = os.path.join(DATA_DIR, "logs")
UPLOAD_DIR = os.path.join(CACHE_DIR, "uploads")    # P4: data/tmp_upload → cache/uploads
FILES_DIR = os.path.join(CACHE_DIR, "files")       # P4: data/files → cache/files
DOCS_DIR = os.path.join(CACHE_DIR, "docs")         # P4: 新增
KBSESSION_DIR = os.path.join(DATA_DIR, "kbsession")
BACKUP_DIR = os.path.join(DATA_DIR, "backup")       # P4: 依赖备份
# D1 重构新增：数据子目录显式定义
KB_DATA_DIR = os.path.join(DATA_DIR, "kb")                       # 知识库向量数据
EXTENSIONS_DIR = os.path.join(DATA_DIR, "extensions")            # 扩展注册 JSON
RECORDER_DATA_DIR = os.path.join(DATA_DIR, "recorder")           # 录音数据
WORKSPACE_DIR = ROOT_DIR  # 保持向后兼容

def ensure_dirs():
    """确保所有运行时目录存在"""
    for d in [DATA_DIR, CHAT_DIR, LOG_DIR, CACHE_DIR, UPLOAD_DIR, FILES_DIR, DOCS_DIR,
              KBSESSION_DIR, BACKUP_DIR, KB_DATA_DIR, EXTENSIONS_DIR, RECORDER_DATA_DIR]:
        os.makedirs(d, exist_ok=True)

# 配置文件路径（D1 重构：从 ROOT_DIR 提升到 DATA_DIR）
_CONFIG_FILE = os.path.join(DATA_DIR, "settings.json")

# ===== 默认配置（唯一真相源）=====
DEFAULTS = {
    # ----- 应用版本号（唯一权威来源 single source of truth）-----
    # 其他所有模块/前端/launcher 均从此处取版本号，禁止在其他地方硬编码版本字面量。
    # launcher/build.bat 通过 findstr 解析此行抽取版本号。
    "version": "0.9.6",

    # ----- 通用 -----
    # 沙盒清理策略: "on_start" | "24h" | "7d" | "never"
    "sandbox_cleanup": "24h",
    # 模式: "qa" | "exec"
    "default_mode": "qa",
    # 确认机制: 读取外部文件时是否需要用户确认
    "confirm_external_read": True,

    # ----- 扩展与模型目录（运行时解析）-----
    "extensions_dir": "",                 # 空=DATA_DIR/extensions（D1 重构后）
    "models_dir": "",                     # 空=ROOT_DIR/models（运行时解析）

    # ----- 文件操作限制 -----
    "max_read_size_mb": 10,
    "max_write_size_mb": 5,

    # ----- Agent 设置 -----
    "agent_max_iterations": 8,
    "agent_timeout": 120,           # 秒
    "agent_result_max_chars": 800,  # 工具结果自动压缩阈值
    "agent_max_rounds": 10,         # Agent Loop 最大工具调用轮次
    "agent_tool_timeout": 20,       # 单次工具调用超时（秒）
    "agent_total_timeout": 300,     # Agent 总任务超时（秒）

    # ----- 会话缓存 -----
    "cache_keep_ratio": 0.4,          # 保留最近 40% 的原始消息
    "cache_entry_max_chars": 80,      # 每条缓存条目的最大字符数
    "cache_max_total_chars": 500,     # 缓存总字符数上限
    "cache_threshold_ratio": 0.8,     # 触发压缩的阈值比例（占 max_history_chars 的百分比）

    # ----- 文件上传 -----
    "upload_max_size": 52428800,      # 50MB (50 * 1024 * 1024)

    # ----- Ollama 推理引擎 -----
    "ollama_host": "127.0.0.1",          # Ollama 服务地址
    "ollama_port": 11434,                # Ollama 服务端口
    "ollama_model": "qwen3-5-4b",       # 默认模型（Ollama 模型名不允许 "."，用 "-" 替代）
    "ollama_auto_start": True,           # 是否自动启动 Ollama 进程
    "auto_warmup_llm": True,             # 启动时是否自动加载（预热）LLM 模型
    "ollama_health_interval": 30,        # 健康检查间隔（秒）
    "ollama_connect_timeout": 30,        # 连接超时（秒）
    "ollama_read_timeout": 120,          # 读取超时（秒）
    "ollama_max_concurrent": 1,          # 最大并发请求数
    "ollama_keep_alive": "24h",          # 模型保活时间（常驻显存不卸载）

    # ----- 云端 AI 模式 -----
    "ai_mode": "local",                          # "local" | "cloud"
    "cloud_base_url": "https://api.openai.com/v1",  # 云端 API 地址
    "cloud_api_key": "",                         # base64 编码存储的 API Key
    "cloud_model": "gpt-4o-mini",                # 云端模型名称
    "cloud_context_policy": "full",              # "full" | "current_only" | "slim_history"
    "cloud_slim_history_rounds": 6,               # slim_history 策略保留的轮数
    "cloud_context_window": 0,                    # 用户手动配置的上下文窗口（0=使用模型默认值）

    # ----- 联网研究（Patch 2）-----
    # 搜索引擎零配置：本机直搜 Bing，无需 API Key

    # ----- 蒸馏（对话摘要）-----
    "distill_summary_max_chars": 100,    # 摘要最大字符数
    "distill_question_max_chars": 200,   # 问题最大字符数
    "distill_answer_max_chars": 500,     # 回答最大字符数

    # ----- 上下文压缩器 -----
    "compress_max_code_chars": 600,      # 压缩后代码超过此长度时截断
    "offline_compress_max_input": 2000,  # 离线压缩最大输入字符数
    "offline_compress_timeout": 30,      # 离线压缩超时（秒）
    "offline_compress_max_tokens": 512,  # 离线压缩最大生成 token 数

    # ----- 长文本分段处理 -----
    "chunk_threshold_chars": 8000,       # 超过此值触发分段
    "chunk_max_chars": 2500,             # 每段目标字数
    "chunk_overlap_chars": 200,          # 段间重叠
    "chunk_memory_max_chars": 800,       # 滚动记忆上限
    "chunk_max_chunks": 30,              # 安全上限（最多分段数）
    "chunk_per_chunk_timeout": 30,       # 每段处理超时（秒）

    # ----- 知识库权限（Patch 3）-----
    "kb_permission": "full",              # "full" | "search-only" | "disabled"

    # ----- 自适应记忆（Patch 3）-----
    "history_token_budget": 3000,         # KB 对话历史 token 预算上限

    # ----- 云端AI知识对比（Patch 3 轨道B）-----
    "kb_compare_enabled": False,          # 云端AI知识对比开关（半持久化）
    "kb_compare_privacy_read": False,     # 隐私弹窗已读标记

    # ----- 并行模式（P6）-----
    "parallel_keyword_gen": False,        # 并行模式云端关键词提取开关

    # ----- 文库（Patch 6）-----
    "kb_max_documents": 200,             # D3: 最大文档数（Patch4 v3.1：50→200，用户需求）
    "kb_max_total_chunks": 4000,         # 最大 chunk 总数（按文档数比例放大 1000→4000）
    "kb_chunk_max_chars": 3000,          # 每块最大字符（Patch4 v3.1：2500→3000，适配 bge-m3）
    "kb_chunk_overlap_chars": 300,       # 重叠字符（保持 10% overlap 比例）
    "kb_search_top_k": 5,               # 检索返回 top-k（云端默认，本地模式动态降为 3）
    "kb_embedding_model": "BAAI/bge-m3",  # Patch4 v3.1：bge-base-zh-v1.5 → bge-m3（多语言+8192长序列）
    "kb_vector_dim": 1024,              # 向量维度（bge-m3 = 1024）
    "kb_embed_batch_size": 50,           # 嵌入批处理大小
    "kb_async": True,                    # 异步处理开关
    "kb_data_dir": "",                   # 数据目录（空=项目根目录下 data/kb/）

    # ----- 录音纪要（Patch 6 纪要 Tab，P6-9+ 实现）-----
    "recorder_chunk_seconds": 10,        # D25: 录音分块秒数
    "recorder_max_duration": 3600,       # 最长录音时长（秒）
    "recorder_sample_rate": 16000,       # 采样率
    "recorder_format": "webm/opus",      # 音频格式
    "recorder_max_file_size": 52428800,  # 导入音频最大 50MB
    "recorder_max_sessions": 20,         # D39: 录音 session 上限
    "recorder_keep_audio": True,         # D35: 默认长期保留音频
    "recorder_crash_recovery": True,     # D36: 崩溃恢复

    # ----- Whisper（Patch 6 扩展包，P6-10+ 实现）-----
    "whisper_model": "small",            # D21: small/medium（安装时锁定）
    "whisper_language": "zh",            # D42: 默认中文
    "whisper_device": "cpu",             # D19: 固定 CPU
    "whisper_keep_loaded": True,         # 模型常驻内存
    "whisper_enable_refine": True,       # D20: 启用 8B 辅助纠错
    "whisper_realtime_chunk_sec": 10,    # D25: 实时转写每 chunk 秒数
    "whisper_lock_on_transcribe": True,  # D22: 转写期间锁定对话 Tab
    "whisper_refine_batch_chars": 800,   # D37: 8B 纠错批次大小

    # ----- Reranker 空闲卸载（Patch 8，B5 移除内存预算后保留）-----
    "reranker_idle_timeout_sec": 300,      # Reranker 空闲超时（秒）
    "reranker_resident": False,            # Reranker 是否常驻（True=不自动卸载）
    "recorder_resident": False,            # 纪要引擎(Whisper)是否常驻（True=不自动卸载）

    # ----- 权限工具开关（Patch5 B3，3 预设可批量改）-----
    "tool_enabled_web_search": True,       # 互联网搜索（search_web/fetch_url）
    "tool_enabled_file_rw": True,          # 文件读写（write_workspace 等）
    "tool_enabled_code_exec": False,       # 代码执行（预留，默认关）
    "tool_enabled_kb_search": True,        # 知识库检索（search_kb/get_context）

    # ----- 文库检索参数（Patch 8 P8-10，从硬编码提取）-----
    "kb_vector_score_threshold": 0.35,    # 向量检索最低余弦相似度（Patch4 v3.1：0.28→0.35，适配 bge-m3 分数分布）
    "kb_relevance_floor": 0.30,           # MMR 重排序相关性地板（低于此值的候选跳过）
    "kb_reranker_top_k": 5,              # Reranker 精排返回数量
    "kb_context_max_chars_local": 5000,   # 本地模式注入 LLM 的总字符上限（Patch4 v3.1 新增）
    "kb_context_max_chars_cloud": 12000,  # 云端模式注入 LLM 的总字符上限（Patch4 v3.1 新增）
    "kb_search_top_k_local": 3,           # 本地模式 top-k（少而精，适配 4B 模型 16K 上下文）
    "kb_search_top_k_cloud": 5,           # 云端模式 top-k（多而广，云端 1M 上下文随便吃）

    # ----- .sidemate 包签名 -----
    "sidemate_hmac_key": os.environ.get("SIDEMATE_HMAC_KEY", _SIDEMATE_HMAC_KEY_DEFAULT),

    # ===== Patch5: 线程池 + 任务队列 + 令牌系统 =====
    # 线程池大小（同步阻塞操作如文件解析、embedding 计算在此执行，避免卡死 FastAPI 事件循环）
    "thread_pool_max_workers": 2,
    # BatchQueue SQLite 数据库路径（空=运行时解析为 DATA_DIR/batch_queue.db）
    "batch_queue_db_path": "",
    # BatchQueue worker 轮询间隔（秒）
    "batch_queue_poll_interval": 1.0,
    # bge-m3 dense+sparse 融合权重（score = α × dense_norm + (1-α) × sparse_norm）
    "kb_dense_sparse_alpha": 0.7,
    # 是否启用 bge-m3 sparse 检索（False 时降级为 BM25）
    "kb_enable_sparse": True,
    # 令牌默认有效期（秒，0=永不过期）
    "access_token_default_ttl": 0,
}

# ===== 本地模型统一 Token 限制（所有本地 LLM 调用共用）=====
MAX_INPUT_TOKENS = 16384    # num_ctx，上下文窗口大小
MAX_OUTPUT_TOKENS = 4096    # num_predict，最大输出 token 数

# 导出顶层常量（供 validators/sidemate_validator.py 等模块使用）
SIDEMATE_HMAC_KEY = DEFAULTS["sidemate_hmac_key"]

# 模块版本号：向后兼容别名，始终等于 DEFAULTS["version"]（唯一权威源）
__version__ = DEFAULTS["version"]


def load_config() -> Dict[str, Any]:
    """加载配置，合并 settings.json 中的值

    所有配置项（包括scene_skills等非DEFAULTS键）均可通过 get() 读取。
    """
    config = dict(DEFAULTS)
    try:
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                user_config = json.load(f)
                if isinstance(user_config, dict):
                    # 合并所有settings.json中的值（不限于DEFAULTS）
                    for k, v in user_config.items():
                        config[k] = v
    except Exception as e:
        log.warning("[CONFIG] 加载配置失败: %s，使用默认值" % str(e))

    return config


def save_config(config: Dict[str, Any]) -> bool:
    """保存配置到 settings.json（合并写入，支持非 DEFAULTS key 如 scene_skills）"""
    try:
        existing = {}
        if os.path.exists(_CONFIG_FILE):
            with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                existing = json.load(f)

        # 合并所有 key（不限于 DEFAULTS）
        for k, v in config.items():
            existing[k] = v

        with open(_CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(existing, f, ensure_ascii=False, indent=2)

        # 保存后重新加载缓存
        _invalidate_cache()

        return True
    except Exception as e:
        log.error("[CONFIG] 保存配置失败: %s" % str(e))
        return False


# ===== 模块级配置缓存（启动时加载，写操作后同步更新） =====
_config_cache: Dict[str, Any] = load_config()
_cache_lock = threading.Lock()


def _invalidate_cache() -> None:
    """重新从磁盘加载配置到内存缓存"""
    global _config_cache
    with _cache_lock:
        _config_cache = load_config()


def get(key: str, default: Any = None) -> Any:
    """获取单个配置项（直接读内存缓存，零磁盘 IO）"""
    with _cache_lock:
        return _config_cache.get(key, default if default is not None else DEFAULTS.get(key, default))


def set_value(key: str, value: Any) -> bool:
    """设置单个配置项"""
    return save_config({key: value})


# 清理策略描述（给前端显示用）
CLEANUP_OPTIONS = {
    "on_start": "每次启动时清空",
    "24h": "保留 24 小时",
    "7d": "保留 7 天",
    "never": "不自动清理（手动管理）",
}
