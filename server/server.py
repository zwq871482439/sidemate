# -*- coding: utf-8 -*-
"""
Sidemate v0.9 Patch 4 — FastAPI + Ollama + Qwen3.5-4B
版本号统一在 config.__version__ 中定义（当前 0.9.4），
VERSION / VERSION_PATCH 保留用于向后兼容。
启动: python server.py

本文件(server.py)是主服务进程，负责：
  1. 全局服务实例化（mgr, kb, recorder, ollama_manager, ...）
  2. 注册所有 Router 模块
  3. 静态页面路由
  4. main() 启动逻辑（uvicorn）
  5. CORS 中间件

所有 API 端点已拆分到 routers/ 目录下的 Router 模块。
"""

# ===== 离线环境保护（必须在所有导入之前）=====
import os as _os

# 隔离用户级 site-packages（防止用户环境包版本冲突）
_os.environ["PYTHONNOUSERSITE"] = "1"

# 阻止 HuggingFace Hub 在线检查
_os.environ.setdefault("HF_HUB_OFFLINE", "1")
_os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# 禁用 HuggingFace Hub 遥测
_os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
_os.environ.setdefault("HF_HUB_DISABLE_PROGRESS_BARS", "1")
_os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")
_os.environ.setdefault("TQDM_DISABLE", "1")  # 禁用 sentence_transformers tqdm 进度条

import os, sys, time, logging, json, warnings

# ===== Embedded Python 兼容：确保 server 目录在 sys.path 中 =====
_server_dir = os.path.dirname(os.path.abspath(__file__))
if _server_dir not in sys.path:
    sys.path.insert(0, _server_dir)

warnings.filterwarnings("ignore", message="pkg_resources is deprecated.*")
from datetime import datetime
from typing import Optional

# ===== 启动进度上报（Go Launcher 轮询读取）=====
_PROGRESS_FILE = os.path.join(_server_dir, "data", "startup_progress.json")

def _report_startup(phase: str, progress: int, text: str):
    """写入启动进度文件，供 Go Launcher 轮询读取"""
    try:
        os.makedirs(os.path.dirname(_PROGRESS_FILE), exist_ok=True)
        with open(_PROGRESS_FILE, "w", encoding="utf-8") as f:
            json.dump({"phase": phase, "progress": progress, "text": text, "ts": time.time()}, f)
    except Exception:
        pass  # 进度上报不能影响启动

_report_startup("init", 0, "初始化...")

# ===== 进程级看门狗（在加载重量级模块之前执行） =====
if '--serve' not in sys.argv:
    import subprocess as _sp
    MAX_RESTART = 5
    _script = os.path.abspath(__file__)
    print("=" * 50)
    print("看门狗已启动 (最大重启次数: %d)" % MAX_RESTART)
    print("=" * 50)
    for _i in range(MAX_RESTART):
        _proc = _sp.run([sys.executable, _script, '--serve'], timeout=None)
        if _proc.returncode == 0:
            print("[WATCHDOG] 服务正常退出")
            break
        if _i < MAX_RESTART - 1:
            print("[WATCHDOG] 服务崩溃 (exit=%d)，3秒后重启 (%d/%d)..." % (_proc.returncode, _i + 1, MAX_RESTART))
            time.sleep(3)
        else:
            print("[WATCHDOG] 服务已崩溃 %d 次，停止自动重启" % MAX_RESTART)
    sys.exit(0)
# ===== 看门狗结束，以下为正常服务进程 =====

# ===== 路径配置 =====
from config import ROOT_DIR, WORKSPACE_DIR, DATA_DIR, CHAT_DIR, LOG_DIR, UPLOAD_DIR, CACHE_DIR, DOCS_DIR, BACKUP_DIR, ensure_dirs
ensure_dirs()

# P4 首次启动迁移
from core.data_migrator import migrate_data_layout
migrate_data_layout(DATA_DIR)

# ===== 配置常量 =====
HOST = os.environ.get("LOCAL_AI_HOST", "127.0.0.1")
PORT = int(os.environ.get("LOCAL_AI_PORT", "8976"))
VERSION = "0.9"
VERSION_PATCH = 4
LOG_FILE = os.path.join(LOG_DIR, "server.log")

# 会话缓存常量（P1-A4: 已移至 session/context_cache.py 中按需调用）
from config import get as _cfg_get, DEFAULTS as _DEFAULTS, __version__ as CONFIG_VERSION

# 统一版本号：FULL_VERSION 由 config.__version__ 驱动
FULL_VERSION = CONFIG_VERSION  # "0.9.4"

# ===== 日志 =====
_LOG_LEVEL = getattr(logging, os.environ.get("LOCAL_AI_LOG_LEVEL", "INFO").upper(), logging.INFO)
os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
logging.basicConfig(
    level=_LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
log = logging.getLogger(__name__)

# ===== 依赖健康检查（在加载重量级模块之前）=====
log.info("[STARTUP] 检查依赖完整性...")
_report_startup("deps", 5, "检查依赖完整性...")
from core.deps_check import check_deps
_deps_result = check_deps(_server_dir)
if _deps_result["all_ok"]:
    log.info("[STARTUP] 依赖检查通过 ✅")
else:
    _still_missing = []
    for _cat_items in _deps_result.get("missing", {}).values():
        _still_missing.extend(_cat_items)
    if _still_missing:
        log.warning("[STARTUP] 依赖缺失（部分功能不可用）: %s" % ", ".join(_still_missing))

# ===== 依赖安全网（manifest + SHA256 抽检）=====
from core.deps_check import (
    generate_manifest, verify_manifest,
    load_manifest, save_manifest, generate_fingerprint,
)
SITE_PACKAGES_DIR = os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")
_MANIFEST_PATH = os.path.join(DATA_DIR, "deps_manifest.json")
_PYTHON_DIR = os.path.dirname(sys.executable)  # python/ 目录
_FINGERPRINT_PATH = os.path.join(_PYTHON_DIR, ".fingerprint")

if not os.path.exists(_MANIFEST_PATH):
    # 首次启动：生成 manifest + fingerprint
    log.info("[STARTUP] 首次启动，生成依赖清单...")
    _report_startup("deps_manifest", 7, "生成依赖清单...")
    try:
        _manifest = generate_manifest(SITE_PACKAGES_DIR)
        save_manifest(_manifest, _MANIFEST_PATH)
        log.info("[STARTUP] 依赖清单已生成（%d 个包）", len(_manifest.get("packages", {})))
    except Exception as _e:
        log.warning("[STARTUP] 依赖清单生成失败（不影响使用）: %s", str(_e)[:120])
    try:
        generate_fingerprint(_PYTHON_DIR)
        log.info("[STARTUP] 环境指纹已生成")
    except Exception as _e:
        log.warning("[STARTUP] 环境指纹生成失败（不影响使用）: %s", str(_e)[:120])
else:
    # 日常启动：SHA256 抽检
    try:
        _manifest = load_manifest(_MANIFEST_PATH)
        _broken = verify_manifest(SITE_PACKAGES_DIR, _manifest)
        if _broken:
            log.warning("[STARTUP] 发现 %d 个损坏包: %s（建议重新安装）", len(_broken), _broken)
    except Exception as _e:
        log.warning("[STARTUP] 依赖抽检失败（不影响使用）: %s", str(_e)[:120])

# ===== 加载核心框架 =====
_report_startup("framework", 10, "加载 FastAPI 框架...")
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

# Ollama Manager
_report_startup("ollama_mgr", 15, "初始化 Ollama 管理器...")
from core.ollama_manager import OllamaManager
ollama_manager = OllamaManager()

_lifespan_entered = False

@asynccontextmanager
async def _lifespan(app):
    """应用生命周期：启动时自动拉起 Ollama"""
    global _lifespan_entered
    if _lifespan_entered:
        log.info("[STARTUP] lifespan 重入，跳过（uvicorn reload）")
        yield
        return
    _lifespan_entered = True

    if _cfg_get("ollama_auto_start", True):
        _report_startup("ollama_start", 70, "启动 Ollama 推理引擎...")
        log.info("[STARTUP] 自动启动 Ollama...")
        result = ollama_manager.auto_start()
        if result.get("status") in ("started", "already_running"):
            log.info("[STARTUP] Ollama 就绪: %s" % result.get("status"))
        else:
            log.warning("[STARTUP] Ollama 启动失败: %s" % result.get("error", "unknown"))

        # 模型预热：发一次极短请求，把 GGUF 加载到显存/内存，消除首次提问延迟
        _report_startup("model_warmup", 72, "预热 AI 模型...")
        try:
            import httpx as _hx
            _warmup_model = mgr._get_default_llm()
            if _warmup_model:
                _base_url = mgr._ollama_base_url
                _keep_alive = _cfg_get("ollama_keep_alive", "24h")
                _warmup_payload = {
                    "model": _warmup_model,
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": False,
                    "options": {"num_predict": 1},
                    "keep_alive": _keep_alive,
                }
                log.info("[STARTUP] 预热模型 %s ..." % _warmup_model)
                _t0 = time.time()
                _resp = _hx.post(
                    "%s/api/chat" % _base_url,
                    json=_warmup_payload,
                    timeout=_hx.Timeout(connect=30, read=120, write=30, pool=30),
                )
                _elapsed = time.time() - _t0
                if _resp.status_code == 200:
                    log.info("[STARTUP] 模型预热完成 (%.1fs)，模型已常驻显存" % _elapsed)
                    # 标记为已加载，后续首次提问无需再检查
                    _matched = mgr._find_model_name(_warmup_model)
                    if _matched and _matched not in mgr._loaded:
                        mgr._loaded[_matched] = True
                else:
                    log.warning("[STARTUP] 模型预热请求失败: HTTP %d" % _resp.status_code)
            else:
                log.info("[STARTUP] 无可用 LLM 模型，跳过预热")
        except Exception as _e:
            log.warning("[STARTUP] 模型预热失败（不影响正常使用）: %s" % str(_e)[:120])

    # Patch3: KB 自动初始化 — 检测扩展安装状态，若已安装则加载模型
    try:
        if _kb_installed and not kb._embedder_loaded:
            log.info("[STARTUP] KB 扩展已安装，自动加载模型...")
            kb.load_models()
            log.info("[STARTUP] KB 模型加载完成: embedder=%s, reranker=%s",
                     kb._embedder_loaded, kb.reranker.available)
    except Exception as e:
        log.warning("[STARTUP] KB 自动加载失败（可手动重试）: %s" % str(e)[:100])

    # Patch3: LLMScheduler 初始化
    global _llm_scheduler
    try:
        from core.llm_scheduler import LLMScheduler
        _llm_scheduler = LLMScheduler()
        log.info("[STARTUP] LLMScheduler 已初始化")
    except Exception as e:
        log.warning("[STARTUP] LLMScheduler 初始化失败: %s" % str(e)[:100])

    # Patch3: TaggingScheduler 启动
    global _tagging_scheduler
    if _kb_installed:
        try:
            from core.tagging_scheduler import TaggingScheduler
            _tagging_scheduler = TaggingScheduler(kb, mgr)
            _tagging_scheduler.start()
            log.info("[STARTUP] TaggingScheduler 已启动")
            # 把 scheduler 引用存到 kb 上，避免 upload 线程内 import server 拿不到
            kb._tagging_scheduler = _tagging_scheduler
            # 自动入队所有 tag_status=pending/generating 的已有文档（含中断恢复）
            pending_count = 0
            for doc in kb.documents.values():
                if doc.status == 'ready' and getattr(doc, 'tag_status', 'pending') in ('pending', 'generating'):
                    doc.tag_status = 'pending'  # generating → 重置为 pending，重新打标
                    _tagging_scheduler.enqueue(doc.doc_id)
                    pending_count += 1
            if pending_count > 0:
                log.info("[STARTUP] 已自动入队 %d 篇 pending 文档进行打标" % pending_count)
        except Exception as e:
            log.warning("[STARTUP] TaggingScheduler 启动失败: %s" % str(e)[:100])

    _report_startup("ready", 85, "服务就绪，等待 HTTP...")
    log.info("[STARTUP] 所有 Router 已注册，服务就绪")
    yield
    # 关闭时停止 TaggingScheduler
    if _tagging_scheduler:
        try:
            _tagging_scheduler.stop()
        except Exception as e:
            log.warning("[SHUTDOWN] TaggingScheduler 停止失败: %s" % str(e)[:80])
    # 关闭时停止 Ollama
    try:
        ollama_manager.stop()
    except Exception as e:
        log.warning("[SHUTDOWN] Ollama 停止失败: %s" % str(e)[:80])

app = FastAPI(title="sidemate", version="%s.%s" % (VERSION, VERSION_PATCH), lifespan=_lifespan)
_CORS_ORIGINS = os.environ.get("LOCAL_AI_CORS", "http://localhost:8976,http://127.0.0.1:8976").split(",")
app.add_middleware(CORSMiddleware, allow_origins=_CORS_ORIGINS, allow_methods=["*"], allow_headers=["*"])

# ===== 全局服务实例化 =====

# 模型管理器（Patch 12: 从 core 包导入）
_report_startup("model_mgr", 20, "加载模型管理器...")
from core.model_manager import ModelManager
mgr = ModelManager()

# 文库
_report_startup("knowledge_base", 30, "初始化文库引擎...")
from knowledge import get_knowledge_base
import uuid
try:
    import numpy as np
except ImportError:
    np = None
kb = get_knowledge_base()
kb._model_manager = mgr
# Patch3: 使用 ExtensionRegistry 检测文库扩展安装状态（正规流程）
from extensions import ExtensionRegistry
_ext_registry = ExtensionRegistry(os.path.join(ROOT_DIR, "extensions"))
_kb_installed = _ext_registry.is_installed("knowledge")

# Patch3: TaggingScheduler 全局实例
_tagging_scheduler = None

# Patch3: LLMScheduler 全局实例
_llm_scheduler = None
log.info("[KB] 文库初始化完成: installed=%s, mode=%s, docs=%d, chunks=%d" % (
    _kb_installed, kb.embedder.mode, len(kb.documents), len(kb.chunks)))

# KB 模型自动加载（embedder + reranker，KB 模块无需用户手动启停）
if _kb_installed:
    try:
        embedder_ok = kb.init_embedder()
        reranker_ok = kb.init_reranker()
        if not embedder_ok or not reranker_ok:
            _failed = []
            if not embedder_ok: _failed.append("embedder")
            if not reranker_ok: _failed.append("reranker")
            log.warning("[KB] 模型自动加载失败: %s，建议重装 KB 扩展", ", ".join(_failed))
        else:
            log.info("[KB] embedder + reranker 自动加载完成")
    except Exception as e:
        log.warning("[KB] 模型自动加载异常: %s", str(e)[:100])

# 录音纪要管理器（Patch 12: 从 recorder_pkg 包导入）
_report_startup("recorder", 45, "初始化录音纪要...")
from recorder_pkg.recorder_manager import RecorderManager
recorder = RecorderManager()
recorder.recover_sessions()
log.info("[RECORDER] 录音纪要初始化完成: sessions=%d, whisper=%s" % (
    len(recorder.sessions), "loaded" if recorder._whisper_loaded else "not_loaded"))

# 动态选择默认模型
_report_startup("model_select", 50, "选择默认模型...")
DEFAULT_LLM = mgr._get_default_llm()
_available_llms = [name for name, cfg in mgr.model_configs.items() if cfg["type"] == "llm"]
log.info("默认模型: %s (可用: %s)" % (DEFAULT_LLM, _available_llms))

# 当前对话文件（可变引用）
import glob as _glob
os.makedirs(CHAT_DIR, exist_ok=True)
_current_chat_file = [None]

def _today_str():
    return datetime.now().strftime("%Y-%m-%d")

def _get_latest_chat():
    today = _today_str()
    files = sorted(_glob.glob(os.path.join(CHAT_DIR, "%s_*.json" % today)), reverse=True)
    if files:
        return files[0]
    return None

_latest = _get_latest_chat()
if _latest:
    _current_chat_file[0] = _latest
else:
    # P2-01: 查找今天所有已有对话文件，优先复用空文件而非创建新文件
    today = _today_str()
    existing = _glob.glob(os.path.join(CHAT_DIR, "%s_*.json" % today))
    # 先尝试找一个空文件复用
    for f in existing:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                data = json.load(fh)
            msgs = data.get("messages", []) if isinstance(data, dict) else data
            if not msgs:
                _current_chat_file[0] = f
                break
        except Exception:
            continue
    if not _current_chat_file[0]:
        max_idx = 0
        for f in existing:
            try:
                idx = int(os.path.basename(f).split("_")[1].split(".")[0])
                max_idx = max(max_idx, idx)
            except (ValueError, IndexError):
                pass
        idx = max_idx + 1
        filepath = os.path.join(CHAT_DIR, "%s_%03d.json" % (today, idx))
        _current_chat_file[0] = filepath
        with open(filepath, "w", encoding="utf-8") as f:
            json.dump({"version": 2, "messages": []}, f, ensure_ascii=False)

# ===== 注册所有 Router =====
_report_startup("routers", 55, "注册 API 路由...")
from routers import chat as _r_chat, kb as _r_kb, recorder as _r_recorder
from routers import settings_system as _r_settings_sys, settings_cloud as _r_settings_cloud, settings_extensions as _r_settings_ext, skill as _r_skill
from routers import files as _r_files
from routers.backup import router as backup_router

app.include_router(_r_chat.router)
app.include_router(_r_kb.router)
app.include_router(_r_recorder.router)
app.include_router(_r_settings_sys.router)
app.include_router(_r_settings_cloud.router)
app.include_router(_r_settings_ext.router)
app.include_router(_r_skill.router)
app.include_router(_r_files.router)
app.include_router(backup_router)

# ===== 静态页面路由 =====

@app.get("/", response_class=HTMLResponse)
def index():
    with open(os.path.join(WORKSPACE_DIR, "index.html"), "r", encoding="utf-8") as f:
        return f.read()

# 静态文件服务 — 加 no-cache 中间件
_static_dir = os.path.join(WORKSPACE_DIR, "static")

@app.middleware("http")
async def _no_cache_static(request, call_next):
    """静态文件禁止浏览器缓存，避免更新后用户看到旧版"""
    response = await call_next(request)
    if request.url.path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    return response

if os.path.isdir(_static_dir):
    app.mount("/static", StaticFiles(directory=_static_dir), name="static")

# ===== 启动时清理过期缓存 =====
from core.cache_cleanup import cleanup_cache

# 清理 docs 目录中过期 .docx（兼容旧路径和新路径）
cleanup_cache(DOCS_DIR, max_age_days=7)
# 清理整个 cache 目录
cleanup_cache(CACHE_DIR, max_age_days=7)

# ===== 日志定期清理 =====
import threading as _threading

def _log_cleanup_worker():
    """daemon 线程：每 24 小时执行一次日志清理"""
    while True:
        time.sleep(86400)  # 24 小时
        try:
            from core.log_cleanup import cleanup_old_logs
            cleanup_old_logs(LOG_DIR)
        except Exception as e:
            log.warning("[LOG-CLEANUP] 定期清理失败: %s" % str(e)[:80])

try:
    from core.log_cleanup import cleanup_old_logs
    cleanup_old_logs(LOG_DIR)
    _log_cleanup_thread = _threading.Thread(target=_log_cleanup_worker, daemon=True)
    _log_cleanup_thread.start()
    log.info("[STARTUP] 日志定期清理已启动（间隔 24h，保留 30 天）")
except Exception as e:
    log.warning("[STARTUP] 日志清理初始化失败: %s" % str(e)[:80])

# ===== 启动 =====
_report_startup("pre_start", 65, "准备启动 HTTP 服务...")

def main():
    import uvicorn
    print("=" * 50)

    print("[1/2] 初始化模型管理器...")
    log.info("=" * 50)
    mod_versions = []
    for mod_name in ("intelligence.task_classifier", "intelligence.response_filter",
                     "common.context_compressor",
                     "prompts",
                     "config"):
        try:
            parts = mod_name.split(".")
            mod = __import__(mod_name, fromlist=[parts[-1]])
            v = getattr(mod, "__version__", None)
            if v:
                mod_versions.append("%s=%s" % (parts[-1], v))
        except ImportError:
            pass
    log.info("Sidemate v%s.%s (%s) 启动 [%s]" % (VERSION, VERSION_PATCH, FULL_VERSION, ", ".join(mod_versions)))

    print("[2/2] 启动 HTTP 服务...")
    print("")
    print("聊天窗: http://%s:%d" % (HOST, PORT))
    print("API:    http://%s:%d/api/status" % (HOST, PORT))
    print("日志:   %s" % LOG_FILE)
    print("=" * 50)

    uvicorn.run(app, host=HOST, port=PORT, log_level="warning")

if __name__ == "__main__":
    main()
