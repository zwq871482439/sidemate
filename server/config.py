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

# .sidemate 包完整性校验：已从 HMAC 迁移到纯 SHA256 hash 验证（见 sidemate_validator.py）
# HMAC 密钥配置已废弃，保留空兼容字段避免旧 settings.json 报错

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
    "version": "0.9.8",

    # ----- 通用 -----
    # 沙盒清理策略: "on_start" | "24h" | "7d" | "never"
    "sandbox_cleanup": "24h",
    # 模式: "qa" | "exec"
    "default_mode": "qa",
    # 确认机制: 读取外部文件时是否需要用户确认
    "confirm_external_read": True,
    # CORS 严格模式: True=仅允许 LOCAL_AI_CORS 配置的本地源;
    #               False=调试模式，允许任意源访问本机 API（存在本机恶意页面窃取数据风险）
    "cors_strict": True,

    # ----- 扩展与模型目录（运行时解析）-----
    "extensions_dir": "",                 # 空=DATA_DIR/extensions（D1 重构后）
    "models_dir": "",                     # 空=ROOT_DIR/models（运行时解析）

    # ----- 文件操作限制（已废弃，代码内未引用） -----
    # "max_read_size_mb": 10,
    # "max_write_size_mb": 5,

    # ----- Agent 设置（已废弃：实际由 agent_loop.py 硬编码常量控制）-----
    # 真实生效值：MAX_ROUNDS=20, MAX_TOOL_HISTORY_CHARS=60000 等
    # "agent_max_iterations": 8,
    # "agent_timeout": 120,
    # "agent_result_max_chars": 800,
    # "agent_max_rounds": 10,
    # "agent_tool_timeout": 20,
    # "agent_total_timeout": 300,

    # ----- 会话缓存 -----
    "cache_keep_ratio": 0.4,          # 保留最近 40% 的原始消息
    "cache_entry_max_chars": 80,      # 每条缓存条目的最大字符数
    "cache_max_total_chars": 500,     # 缓存总字符数上限
    "cache_threshold_ratio": 0.8,     # 触发压缩的阈值比例（占 max_history_chars 的百分比）

    # ----- 文件上传 -----
    "upload_max_size": 52428800,      # 50MB (50 * 1024 * 1024)

    # ----- 推理引擎（P7-4: Ollama → llama.cpp）-----
    # 保留旧名兼容（ollama_* 仍可读，但实际指向 llama-server）
    "ollama_host": "127.0.0.1",          # llama-server 服务地址
    "ollama_port": 11434,                # llama-server 服务端口
    "ollama_model": "qwen3.5-4b-q4",     # 默认模型 model_id（实际由 last_loaded_model 优先）
    "last_loaded_model": "",             # 用户上次加载的模型 ID（启动时优先；空则按硬件推荐）
    "ollama_auto_start": True,           # 是否自动启动 llama-server 进程
    "auto_warmup_llm": True,             # 启动时是否预热（llama-server 启动即加载，预热可选）
    # ollama_health_interval / connect/read_timeout / max_concurrent 已废弃（P7-4 换 llama.cpp 后遗留，代码内未引用）
    # P7-4 新增 llama.cpp 专属配置
    "llamacpp_ctx_size": 8192,           # 上下文窗口大小（--ctx-size 启动参数）
    "llamacpp_gpu_layers": 99,           # GPU offload 层数（-ngl，0=纯CPU）
    "llamacpp_model": "",                # 默认模型 model_id（空时自动选最大可用）

    # ----- 云端 AI 模式 -----
    "ai_mode": "local",                          # "local" | "cloud"
    "kb_ai_mode": "local",                       # 知识库问答专用 LLM："local" | "cloud"（独立于 ai_mode）
    "cloud_base_url": "https://api.openai.com/v1",  # 云端 API 地址
    "cloud_api_key": "",                         # base64 编码存储的 API Key
    "cloud_model": "gpt-4o-mini",                # 云端模型名称
    "cloud_api_format": "openai",                # 接口格式："openai"（/v1/chat/completions）| "anthropic"（/v1/messages）
    "cloud_proxy_mode": "system",                # 云端请求代理："system"（跟随系统代理）| "direct"（直连，代理不稳时逃生口）
    "cloud_context_policy": "full",              # "full" | "current_only" | "slim_history"
    "cloud_slim_history_rounds": 6,               # slim_history 策略保留的轮数
    "cloud_context_window": 0,                    # 用户手动配置的上下文窗口（0=使用模型默认值）

    # ----- 联网研究（Patch 2）-----
    # 搜索引擎零配置：本机直搜 Bing，无需 API Key

    # ----- 蒸馏（对话摘要，已废弃：代码内未引用，早期功能遗留）-----
    # "distill_summary_max_chars": 100,
    # "distill_question_max_chars": 200,
    # "distill_answer_max_chars": 500,

    # ----- 上下文压缩器 -----
    "compress_max_code_chars": 600,      # 压缩后代码超过此长度时截断
    "offline_compress_max_input": 2000,  # 离线压缩最大输入字符数
    "offline_compress_timeout": 30,      # 离线压缩超时（秒）
    "offline_compress_max_tokens": 512,  # 离线压缩最大生成 token 数

    # ----- 长文本分段处理（已废弃：实际由 agent_loop.py 内硬编码控制）-----
    # 真实生效值：chunk_size=3000, deep_read 截断 15000 等
    # "chunk_threshold_chars": 8000,
    # "chunk_max_chars": 2500,
    # "chunk_overlap_chars": 200,
    # "chunk_memory_max_chars": 800,
    # "chunk_max_chunks": 30,
    # "chunk_per_chunk_timeout": 30,

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
    "kb_chunk_max_chars": 500,          # 每块最大字符（Patch5 A4：2500→500，隐私边界 + 检索精度）
    "kb_chunk_overlap_chars": 50,       # 重叠字符（保持 10% overlap 比例）
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
    # whisper_device 已废弃（固定 CPU，代码内未引用）
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

    # ----- .sidemate 包完整性（已废弃 HMAC，纯 SHA256 hash 校验）-----
    # "sidemate_hmac_key": "",  # 已废弃，validator 不再使用

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
MAX_INPUT_TOKENS = 8192     # num_ctx，上下文窗口大小（P6 统一 8K，P7 改为动态读取）
MAX_OUTPUT_TOKENS = 4096    # num_predict，最大输出 token 数

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


# ===== 关键配置项校验（防止异常配置导致崩溃或安全问题）=====
# 仅校验安全/数值型关键配置，未知 key 保持原样（如 scene_skills）
_CONFIG_VALIDATORS = {
    "cors_strict": lambda v: isinstance(v, bool),
    "upload_max_size": lambda v: isinstance(v, int) and 0 < v <= 100 * 1024 * 1024,
    "llamacpp_gpu_layers": lambda v: isinstance(v, int) and 0 <= v <= 200,
    "llamacpp_ctx_size": lambda v: isinstance(v, int) and 512 <= v <= 131072,
    "cloud_context_window": lambda v: isinstance(v, int) and 0 <= v <= 2097152,
    "kb_max_documents": lambda v: isinstance(v, int) and 1 <= v <= 10000,
    "kb_max_total_chunks": lambda v: isinstance(v, int) and 1 <= v <= 100000,
    "access_token_default_ttl": lambda v: isinstance(v, int) and 0 <= v <= 86400 * 30,
    "thread_pool_max_workers": lambda v: isinstance(v, int) and 1 <= v <= 16,
    "ai_mode": lambda v: v in ("local", "cloud"),
    "kb_ai_mode": lambda v: v in ("local", "cloud"),
    "cloud_context_policy": lambda v: v in ("full", "current_only", "slim_history"),
    "cloud_api_format": lambda v: v in ("openai", "anthropic"),
    "cloud_proxy_mode": lambda v: v in ("system", "direct"),
    "kb_permission": lambda v: v in ("full", "search-only", "disabled"),
    "sandbox_cleanup": lambda v: v in ("on_start", "24h", "7d", "never"),
    "default_mode": lambda v: v in ("qa", "exec"),
    "confirm_external_read": lambda v: isinstance(v, bool),
    "auto_warmup_llm": lambda v: isinstance(v, bool),
    "kb_async": lambda v: isinstance(v, bool),
    "kb_enable_sparse": lambda v: isinstance(v, bool),
    "reranker_resident": lambda v: isinstance(v, bool),
    "recorder_resident": lambda v: isinstance(v, bool),
    "tool_enabled_web_search": lambda v: isinstance(v, bool),
    "tool_enabled_file_rw": lambda v: isinstance(v, bool),
    "tool_enabled_code_exec": lambda v: isinstance(v, bool),
    "tool_enabled_kb_search": lambda v: isinstance(v, bool),
    "parallel_keyword_gen": lambda v: isinstance(v, bool),
}


def _validate_config_value(key: str, value: Any) -> bool:
    """校验配置项类型/范围。未定义校验器的 key 一律放行。"""
    validator = _CONFIG_VALIDATORS.get(key)
    if validator is None:
        return True
    try:
        return bool(validator(value))
    except Exception:
        return False


# 配置写锁：保护 save_config 的"读-改-写"序列（稳定性测试 S3 抓到的丢更新 race）
# 与 _cache_lock 独立；锁序固定 _save_lock → _cache_lock（_invalidate_cache 内取后者）
_save_lock = threading.Lock()


def save_config(config: Dict[str, Any]) -> bool:
    """保存配置到 settings.json（原子写入，防崩溃截断）

    并发安全：整个读-改-写在 _save_lock 内完成——否则两个线程并发写不同 key 时，
    后写者会用过期的读结果覆盖先写者的更新（lost update）。
    """
    tmp_path = _CONFIG_FILE + ".tmp"
    with _save_lock:
        try:
            existing = {}
            if os.path.exists(_CONFIG_FILE):
                with open(_CONFIG_FILE, "r", encoding="utf-8") as f:
                    existing = json.load(f)

            # 校验关键配置项，非法值拒绝并记录
            for k, v in config.items():
                if not _validate_config_value(k, v):
                    log.warning("[CONFIG] 拒绝非法配置值: %s=%r（类型或范围不符）" % (k, v))
                    return False
                existing[k] = v

            # 原子写入：先写临时文件，再替换目标文件
            with open(tmp_path, "w", encoding="utf-8") as f:
                json.dump(existing, f, ensure_ascii=False, indent=2)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, _CONFIG_FILE)

            # 保存后重新加载缓存
            _invalidate_cache()

            return True
        except Exception as e:
            log.error("[CONFIG] 保存配置失败: %s" % str(e))
            # 清理临时文件
            try:
                if os.path.exists(tmp_path):
                    os.remove(tmp_path)
            except Exception:
                pass
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
