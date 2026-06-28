# -*- coding: utf-8 -*-
"""
routers/settings_extensions.py — 扩展包管理端点

端点前缀 /api：
  扩展上传：/api/extensions/upload
  安装进度：/api/extensions/install-progress/{task_id}
  扩展列表：/api/extensions/list
  扩展卸载：/api/extensions/uninstall/{ext_type}/{ext_name}
  旧版兼容：/api/extensions/{ext_type}/{ext_name}
"""
import os
import sys
import re
import json
import time
import logging
import shutil
import subprocess
import zipfile
import uuid as _uuid
import threading as _threading
import queue as _queue
from datetime import datetime

from fastapi import APIRouter, UploadFile, File
from fastapi.responses import JSONResponse, StreamingResponse

from routers.deps import (
    get_mgr, get_kb,
    WORKSPACE_DIR,
)

router = APIRouter()
log = logging.getLogger("settings.extensions")


# ============================================================
#  扩展依赖检查
# ============================================================

def _check_requires(manifest: dict) -> list:
    """检查扩展的前置依赖（KB/LLM 互相独立，暂不强制检查）"""
    return []


# ============================================================
#  权限系统 / 审计日志 — 已在 Patch11 拆除
# ============================================================


# ============================================================
#  扩展包管理
# ============================================================

# --- 安装任务管理器 ---
_install_tasks = {}  # task_id -> {queue, status, result, created_at}
_install_cleanup_done = False


def _cleanup_old_tasks():
    """清理超过 5 分钟的已完成安装任务"""
    global _install_cleanup_done
    if _install_cleanup_done:
        return
    _install_cleanup_done = True
    import time as _t
    now = _t.time()
    expired = [tid for tid, info in _install_tasks.items()
               if info.get("status") in ("done", "error") and now - info.get("created_at", now) > 300]
    for tid in expired:
        del _install_tasks[tid]
    _install_cleanup_done = False


def _install_worker(task_id, sidemate_path, tmp_dir, _project_dir):
    """后台线程：校验 → 解压 → 安装 → 加载"""
    from config import EXTENSIONS_DIR
    info = _install_tasks[task_id]
    q = info["queue"]

    def progress(percent, stage):
        q.put(('data: {"type":"progress","percent":%d,"stage":"%s"}\n\n' % (percent, stage)).encode("utf-8"))

    try:
        # === 阶段 1: 校验 (0-10%) ===
        progress(2, "校验扩展包完整性...")
        from common.sidemate_validator import SidemateValidator
        validator = SidemateValidator()  # v2: HMAC 已移除，改为 SHA256 完整性校验
        is_valid, msg, manifest = validator.validate_sidemate(sidemate_path)

        if not is_valid:
            raise ValueError(".sidemate 校验失败: %s" % msg)
        if not manifest:
            raise ValueError(".sidemate 包中无有效 manifest")

        ext_type = manifest.get("type", "unknown")
        ext_name = manifest.get("name", "unknown")

        # 兼容旧包名映射
        if ext_type in ("extension-knowledge", "knowledge"):
            ext_type = "knowledge"
        elif ext_type in ("extension-recorder", "recorder"):
            ext_type = "recorder"
        # llm 保持不变

        progress(10, "校验完成")

        # === 前置依赖检查 ===
        missing_deps = _check_requires(manifest)
        if missing_deps:
            raise ValueError("缺少前置依赖: %s，请先安装后再试" % "、".join(missing_deps))

        # === 阶段 2: 解压 (10-40%) ===
        extracted_dir = os.path.join(tmp_dir, "extracted")
        progress(12, "正在解压文件...")

        with zipfile.ZipFile(sidemate_path, "r") as zf:
            members = zf.namelist()
            total = len(members)
            # 安全检查
            for member in members:
                member_path = os.path.join(extracted_dir, member)
                if not os.path.realpath(member_path).startswith(os.path.realpath(extracted_dir)):
                    raise ValueError("包包含不安全路径")
            # 逐文件解压 + 进度
            for i, member in enumerate(members):
                zf.extract(member, extracted_dir)
                if i % max(1, total // 15) == 0:
                    pct = 10 + int(30 * (i + 1) / total)
                    progress(min(pct, 39), "解压文件 (%d/%d)..." % (i + 1, total))

        manifest_path = os.path.join(extracted_dir, "manifest.json")
        if not os.path.exists(manifest_path):
            raise ValueError("解压后未找到 manifest.json")

        progress(40, "解压完成，开始安装...")

        # === 阶段 3: 安装 (40-90%) ===
        if ext_type == "knowledge":
            # 文库扩展包：bge-base-zh-v1.5 + bge-reranker-base + sentence-transformers wheels
            progress(42, "安装文库扩展模型...")
            models_src = os.path.join(extracted_dir, "models")
            models_dst = os.path.join(_project_dir, "models")
            os.makedirs(models_dst, exist_ok=True)

            # 复制 models/embedding/ → _project_dir/models/embedding/
            # 复制 models/reranker/  → _project_dir/models/reranker/
            if os.path.isdir(models_src):
                for sub in ("embedding", "reranker"):
                    src_sub = os.path.join(models_src, sub)
                    dst_sub = os.path.join(models_dst, sub)
                    if os.path.isdir(src_sub):
                        if os.path.exists(dst_sub):
                            shutil.rmtree(dst_sub)
                        shutil.copytree(src_sub, dst_sub)
                        progress(50 if sub == "embedding" else 60,
                                 "安装文库模型 %s..." % sub)

            progress(65, "检查文库依赖...")
            # 依赖健康检查：KB 依赖（sentence_transformers/torch/transformers）已由
            # 基础安装包预装进嵌入式 python，knowledge 包不带 wheels（确认：包内 0 个 .whl）
            # 此处仅做健康检查，若依赖缺失则提示重装基础包（不再尝试从包内 wheels 安装）
            missing_deps = []
            for _mod in ("sentence_transformers", "torch", "transformers"):
                try:
                    __import__(_mod)
                except ImportError:
                    missing_deps.append(_mod)

            if missing_deps:
                # 依赖缺失：基础安装包损坏，提示用户重装（而非尝试从包内 wheels 安装）
                log.warning("[EXT] 文库依赖缺失: %s（基础包应预装，请重装 Sidemate）", missing_deps)
                progress(70, "⚠️ 文库依赖缺失，文档检索可能不可用")
            else:
                progress(70, "文库依赖已就绪")

            progress(80, "注册文库扩展...")
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.register("knowledge", {
                "id": "knowledge",
                "version": manifest.get("version", "1.0.0"),
                "models": {
                    "embedding": "models/embedding",
                    "reranker": "models/reranker",
                },
                "installed_at": datetime.now().isoformat(),
            })

            progress(90, "加载文库模型...")
            kb = get_kb()
            kb.load_models()

            # 动态启动 TaggingScheduler（安装扩展后无需重启服务）
            try:
                import server as _srv
                _srv._kb_installed = True
                if not _srv._tagging_scheduler:
                    from core.tagging_scheduler import TaggingScheduler
                    _ts = TaggingScheduler(kb, _srv.mgr)
                    _ts.start()
                    _srv._tagging_scheduler = _ts
                    kb._tagging_scheduler = _ts
                    # 入队所有已有的 pending 文档
                    _cnt = 0
                    for _doc in kb.documents.values():
                        if _doc.status == 'ready' and getattr(_doc, 'tag_status', 'pending') in ('pending', 'generating'):
                            _doc.tag_status = 'pending'
                            _ts.enqueue(_doc.doc_id)
                            _cnt += 1
                    if _cnt > 0:
                        log.info("[EXT] TaggingScheduler 已启动，入队 %d 篇待打标文档", _cnt)
            except Exception as _e:
                log.warning("[EXT] TaggingScheduler 启动失败（重启后自动恢复）: %s", str(_e)[:120])

            result = {"ok": True, "type": "knowledge", "name": ext_name,
                      "version": manifest.get("version", "1.0"),
                      "auto_loaded": True}

        elif ext_type == "recorder":
            # 纪要扩展包：faster-whisper small + faster-whisper wheels
            progress(42, "安装纪要扩展模型...")
            whisper_src = os.path.join(extracted_dir, "models", "whisper")
            whisper_dst = os.path.join(_project_dir, "models", "whisper")
            os.makedirs(os.path.dirname(whisper_dst), exist_ok=True)
            if os.path.isdir(whisper_src):
                if os.path.exists(whisper_dst):
                    shutil.rmtree(whisper_dst)
                shutil.copytree(whisper_src, whisper_dst)
                progress(55, "Whisper 模型安装完成")

            progress(60, "检查纪要依赖...")
            # 先检查 faster-whisper 是否已就绪
            _rec_deps_ok = True
            try:
                __import__("faster_whisper")
            except ImportError:
                _rec_deps_ok = False

            if _rec_deps_ok:
                progress(65, "纪要依赖已就绪，跳过安装")
                log.info("[EXT] 纪要依赖已就绪（基础包自带），跳过 wheels 安装")
            else:
                wheels_dir = os.path.join(extracted_dir, "wheels")
                if os.path.isdir(wheels_dir):
                    wheel_files = [os.path.join(wheels_dir, f) for f in os.listdir(wheels_dir) if f.endswith(".whl")]
                    if wheel_files:
                        log.info("[EXT] 纪要依赖缺失，安装 %d 个 wheels...", len(wheel_files))
                        pip_args = [sys.executable, "-m", "pip", "install", "--no-index",
                                    "--no-deps"] + wheel_files
                        try:
                            result = subprocess.run(pip_args, capture_output=True, encoding="utf-8", errors="replace", timeout=300)
                            if result.returncode != 0:
                                log.warning("[EXT] wheels 安装返回非零: %s", (result.stderr or "")[:200])
                        except Exception as pip_err:
                            log.warning("[EXT] wheels 安装异常: %s", str(pip_err)[:200])
                        progress(65, "纪要依赖安装完成")
                else:
                    log.warning("[EXT] 无 wheels 目录，跳过依赖安装（依赖应由基础包提供）")

            progress(80, "注册纪要扩展...")
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.register("recorder", {
                "id": "recorder",
                "version": manifest.get("version", "1.0.0"),
                "models": {
                    "whisper": "models/whisper",
                },
                "installed_at": datetime.now().isoformat(),
            })

            progress(90, "加载 Whisper 模型...")
            # P6 归档：recorder 已下线，跳过 whisper 加载
            result = {"ok": True, "type": "recorder", "name": ext_name,
                      "version": manifest.get("version", "1.0"),
                      "auto_loaded": False,
                      "note": "recorder module archived in P6"}

        elif ext_type == "llm":
            # LLM 模型包：safetensors/GGUF 文件，Ollama 直接读取
            progress(42, "安装 LLM 模型文件...")
            llm_dst = os.path.join(_project_dir, "models", "llm", ext_name)
            os.makedirs(llm_dst, exist_ok=True)

            # 模型文件可能在 extracted_dir 根目录或 models/ 子目录
            models_src = os.path.join(extracted_dir, "models")
            if os.path.isdir(models_src):
                # 检查是否存在 models/llm/<ext_name>/ 结构（打包时带了完整路径）
                deep_path = os.path.join(models_src, "llm", ext_name)
                if os.path.isdir(deep_path):
                    models_src = deep_path
                    log.info("[EXT] 检测到深层路径，使用: %s", deep_path)
                # 结构: models/<model_name>/ 或 models/ 下直接是文件
                for item in os.listdir(models_src):
                    src = os.path.join(models_src, item)
                    dst = os.path.join(llm_dst, item)
                    if os.path.isdir(src):
                        if os.path.exists(dst):
                            shutil.rmtree(dst)
                        shutil.copytree(src, dst)
                    elif os.path.isfile(src):
                        os.makedirs(os.path.dirname(dst), exist_ok=True)
                        shutil.copy2(src, dst)
                    progress(70, "复制模型文件 %s..." % item)
            else:
                # 模型文件在根目录
                for item in os.listdir(extracted_dir):
                    if item in ("_meta.json", "manifest.json", "wheels"):
                        continue
                    src = os.path.join(extracted_dir, item)
                    dst = os.path.join(llm_dst, item)
                    if os.path.isdir(src):
                        if os.path.exists(dst):
                            shutil.rmtree(dst)
                        shutil.copytree(src, dst)
                    elif os.path.isfile(src):
                        shutil.copy2(src, dst)
                    progress(70, "复制模型文件 %s..." % item)

            progress(80, "注册 LLM 模型...")
            # 直接写 Ollama blob + manifest 文件（绕过所有 API 和 CLI 的坑）
            try:
                import hashlib as _hashlib
                import json as _json
                import shutil as _shutil
                import httpx as _httpx
                import time as _time

                ollama_model_name = ext_name.replace(".", "-")
                model_path = os.path.join(_project_dir, "models", "llm", ext_name)
                models_dir = os.path.join(_project_dir, "models")
                blobs_dir = os.path.join(models_dir, "blobs")
                # Ollama API 地址从配置读取（与 model_manager 一致）
                try:
                    from config import get as _cfg
                    _ollama_host = _cfg("ollama_host", "127.0.0.1")
                    _ollama_port = _cfg("ollama_port", 11434)
                except Exception:
                    _ollama_host, _ollama_port = "127.0.0.1", 11434
                ollama_api = "http://%s:%d" % (_ollama_host, _ollama_port)

                # 找到 GGUF 文件
                gguf_files = [f for f in os.listdir(model_path) if f.endswith(".gguf")]
                if not gguf_files:
                    raise RuntimeError("未找到 GGUF 文件: %s" % model_path)
                gguf_name = gguf_files[0]
                gguf_path = os.path.join(model_path, gguf_name)
                gguf_size = os.path.getsize(gguf_path)
                log.info("[EXT] GGUF 文件: %s (%.1f MB)", gguf_name, gguf_size / 1048576)

                progress(82, "计算文件指纹...")

                # Step 1: 计算 GGUF 文件的 SHA256
                log.info("[EXT] 计算 GGUF SHA256...")
                sha256 = _hashlib.sha256()
                with open(gguf_path, "rb") as f:
                    while True:
                        chunk = f.read(8192)
                        if not chunk:
                            break
                        sha256.update(chunk)
                gguf_digest = "sha256:%s" % sha256.hexdigest()
                gguf_blob_name = "sha256-%s" % sha256.hexdigest()
                log.info("[EXT] GGUF digest: %s", gguf_digest)

                # Step 2: 移动 GGUF 到 blobs 目录（硬链接或移动）
                os.makedirs(blobs_dir, exist_ok=True)
                blob_dst = os.path.join(blobs_dir, gguf_blob_name)
                progress(85, "注册模型（%.0f MB）..." % (gguf_size / 1048576))
                if os.path.exists(blob_dst):
                    log.info("[EXT] Blob 已存在，跳过: %s", blob_dst)
                else:
                    # 先尝试硬链接（省空间），失败则复制
                    try:
                        os.link(gguf_path, blob_dst)
                        log.info("[EXT] 硬链接 GGUF → blob")
                    except OSError:
                        _shutil.copy2(gguf_path, blob_dst)
                        log.info("[EXT] 复制 GGUF → blob")
                    log.info("[EXT] Blob 写入完成: %s", blob_dst)

                # Step 3: 创建 params layer blob
                from config import MAX_OUTPUT_TOKENS as _DEFAULT_NUM_PREDICT
                params = {"num_predict": _DEFAULT_NUM_PREDICT}
                # Ollama 要求的整数参数列表（字符串值必须转换）
                _INT_PARAMS = {
                    "num_predict", "num_ctx", "num_keep", "num_batch",
                    "top_k", "seed", "num_gpu",
                }
                _FLOAT_PARAMS = {
                    "temperature", "top_p", "min_p", "repeat_penalty",
                    "presence_penalty", "frequency_penalty",
                }
                _ARRAY_PARAMS = {"stop"}  # Ollama 要求这些参数必须是数组
                # 解析 Modelfile 中的参数
                modelfile_src = os.path.join(model_path, "Modelfile")
                if os.path.exists(modelfile_src):
                    with open(modelfile_src, "r", encoding="utf-8") as mf:
                        for line in mf:
                            stripped = line.strip()
                            if stripped.startswith("PARAMETER "):
                                parts = stripped[len("PARAMETER "):].split(None, 1)
                                if len(parts) == 2:
                                    key, val = parts[0].strip(), parts[1].strip()
                                    # 剥离值两端的引号（Modelfile 格式常见）
                                    if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
                                        val = val[1:-1]
                                    # 解析 JSON 值（如 stop 的数组）
                                    if val.startswith("["):
                                        try:
                                            val = _json.loads(val)
                                        except Exception:
                                            pass
                                    elif key in _INT_PARAMS and isinstance(val, str):
                                        try:
                                            val = int(val)
                                        except (ValueError, TypeError):
                                            pass
                                    elif key in _FLOAT_PARAMS and isinstance(val, str):
                                        try:
                                            val = float(val)
                                        except (ValueError, TypeError):
                                            pass
                                    # Ollama 要求 stop 等参数必须是数组
                                    if key in _ARRAY_PARAMS and isinstance(val, str):
                                        val = [val]
                                    params[key] = val
                # 确保 num_predict 是整数
                if "num_predict" not in params:
                    params["num_predict"] = _DEFAULT_NUM_PREDICT
                elif isinstance(params["num_predict"], str):
                    try:
                        params["num_predict"] = int(params["num_predict"])
                    except (ValueError, TypeError):
                        params["num_predict"] = _DEFAULT_NUM_PREDICT
                params_bytes = _json.dumps(params, separators=(",", ":")).encode("utf-8")
                params_digest = "sha256:%s" % _hashlib.sha256(params_bytes).hexdigest()
                params_blob_name = "sha256-%s" % _hashlib.sha256(params_bytes).hexdigest()
                params_blob_path = os.path.join(blobs_dir, params_blob_name)
                with open(params_blob_path, "wb") as f:
                    f.write(params_bytes)
                log.info("[EXT] Params blob: %s → %s", params_digest, params)

                # Step 4: 创建 template layer blob（从 Modelfile 解析，或使用默认 ChatML）
                template_str = ""
                if os.path.exists(modelfile_src):
                    with open(modelfile_src, "r", encoding="utf-8") as mf:
                        mf_content = mf.read()
                    # 提取 TEMPLATE "..." 或 TEMPLATE '''...''' 块
                    import re as _re
                    tmpl_match = _re.search(r'TEMPLATE\s+["\'](.+?)["\']', mf_content, _re.DOTALL)
                    if not tmpl_match:
                        # 尝试多行 TEMPLATE ... END 块
                        tmpl_match = _re.search(r'TEMPLATE\s+"""\s*(.*?)\s*"""', mf_content, _re.DOTALL)
                    if tmpl_match:
                        template_str = tmpl_match.group(1).replace("\\n", "\n")
                if not template_str:
                    # 默认 ChatML 模板（Qwen 系列通用）
                    template_str = (
                        "{{- if .System }}<|im_start|>system\n{{ .System }}<|im_end|>\n"
                        "{{- end }}<|im_start|>user\n{{ .Prompt }}<|im_end|>\n"
                        "<|im_start|>assistant\n"
                    )
                template_bytes = template_str.encode("utf-8")
                template_digest = "sha256:%s" % _hashlib.sha256(template_bytes).hexdigest()
                template_blob_name = "sha256-%s" % _hashlib.sha256(template_bytes).hexdigest()
                template_blob_path = os.path.join(blobs_dir, template_blob_name)
                with open(template_blob_path, "wb") as f:
                    f.write(template_bytes)
                log.info("[EXT] Template blob: %s", template_digest)

                # Step 5: 创建 system prompt layer blob（从 Modelfile 解析，或使用默认）
                system_str = ""
                if os.path.exists(modelfile_src):
                    with open(modelfile_src, "r", encoding="utf-8") as mf:
                        mf_content = mf.read()
                    import re as _re
                    sys_match = _re.search(r'SYSTEM\s+["\'](.+?)["\']', mf_content, _re.DOTALL)
                    if sys_match:
                        system_str = sys_match.group(1)
                if not system_str:
                    # 使用 prompt_builder 中的默认身份 prompt
                    try:
                        from prompts import SYSTEM_PROMPT_V2
                        system_str = SYSTEM_PROMPT_V2.split("\n")[0]  # 取第一行核心身份
                    except Exception:
                        system_str = "你是桌伴(Sidemate)，本地AI办公助手。中文直接回答。"
                system_bytes = system_str.encode("utf-8")
                system_digest = "sha256:%s" % _hashlib.sha256(system_bytes).hexdigest()
                system_blob_name = "sha256-%s" % _hashlib.sha256(system_bytes).hexdigest()
                system_blob_path = os.path.join(blobs_dir, system_blob_name)
                with open(system_blob_path, "wb") as f:
                    f.write(system_bytes)
                log.info("[EXT] System blob: %s", system_digest)

                # Step 6: 创建 config layer blob
                layer_digests = [gguf_digest, template_digest, params_digest, system_digest]
                # 从 manifest 提取模型元信息（非必须，仅供 Ollama 展示）
                _model_family = manifest.get("model_family", "")
                _model_type = manifest.get("model_type", "")
                _file_type = manifest.get("file_type", "")
                # 从 GGUF 文件名推断（如 qwen3-5-4b-q5_k_m.gguf）
                if not _model_family:
                    _name_lower = gguf_name.lower()
                    if "qwen3" in _name_lower:
                        _model_family = "qwen3"
                    elif "qwen2" in _name_lower:
                        _model_family = "qwen2"
                    elif "qwen" in _name_lower:
                        _model_family = "qwen"
                    elif "llama" in _name_lower:
                        _model_family = "llama"
                    elif "gemma" in _name_lower:
                        _model_family = "gemma"
                    else:
                        _model_family = "unknown"
                if not _file_type:
                    _name_lower = gguf_name.lower()
                    for _qtype in ["q8_0", "q6_k", "q5_k_m", "q5_k_s", "q4_k_m", "q4_k_s", "q4_0", "q3_k_m", "f16", "fp16"]:
                        if _qtype in _name_lower:
                            _file_type = _qtype.upper()
                            break
                    if not _file_type:
                        _file_type = "unknown"
                config_obj = {
                    "os": "linux",
                    "architecture": "amd64",
                    "rootfs": {"type": "layers", "diff_ids": layer_digests},
                    "model_family": _model_family,
                    "model_type": _model_type,
                    "file_type": _file_type,
                }
                config_bytes = _json.dumps(config_obj, separators=(",", ":")).encode("utf-8")
                config_digest = "sha256:%s" % _hashlib.sha256(config_bytes).hexdigest()
                config_blob_name = "sha256-%s" % _hashlib.sha256(config_bytes).hexdigest()
                config_blob_path = os.path.join(blobs_dir, config_blob_name)
                with open(config_blob_path, "wb") as f:
                    f.write(config_bytes)
                log.info("[EXT] Config blob: %s", config_digest)

                # Step 7: 写 manifest
                progress(90, "写入模型注册信息...")
                layers = [
                    {
                        "mediaType": "application/vnd.ollama.image.model",
                        "digest": gguf_digest,
                        "size": gguf_size,
                    },
                    {
                        "mediaType": "application/vnd.ollama.image.template",
                        "digest": template_digest,
                        "size": len(template_bytes),
                    },
                    {
                        "mediaType": "application/vnd.ollama.image.params",
                        "digest": params_digest,
                        "size": len(params_bytes),
                    },
                    {
                        "mediaType": "application/vnd.ollama.image.system",
                        "digest": system_digest,
                        "size": len(system_bytes),
                    },
                ]
                manifest_obj = {
                    "schemaVersion": 2,
                    "mediaType": "application/vnd.docker.distribution.manifest.v2+json",
                    "config": {
                        "mediaType": "application/vnd.docker.container.image.v1+json",
                        "digest": config_digest,
                        "size": len(config_bytes),
                    },
                    "layers": layers,
                }

                manifest_dir = os.path.join(
                    models_dir, "manifests", "registry.ollama.ai", "library", ollama_model_name
                )
                os.makedirs(manifest_dir, exist_ok=True)
                manifest_path = os.path.join(manifest_dir, "latest")
                with open(manifest_path, "w", encoding="utf-8") as f:
                    _json.dump(manifest_obj, f, separators=(",", ":"))
                log.info("[EXT] Manifest 写入: %s", manifest_path)
                log.info("[EXT] Manifest 内容: %s", _json.dumps(manifest_obj, indent=2))

                # Step 8: 验证 — 轮询 /api/tags 确认 Ollama 识别
                progress(92, "验证模型注册...")
                log.info("[EXT] 等待 Ollama 识别 manifest...")
                create_ok = False
                for _poll in range(10):
                    _time.sleep(1)
                    try:
                        tags_resp = _httpx.get("%s/api/tags" % ollama_api, timeout=10, trust_env=False)
                        if tags_resp.status_code == 200:
                            existing = [m.get("name", "") for m in tags_resp.json().get("models", [])]
                            existing_base = [n.split(":")[0] for n in existing]
                            if ollama_model_name in existing or ollama_model_name in existing_base:
                                log.info("[EXT] 模型注册成功 (轮询 #%d): %s", _poll + 1, existing)
                                create_ok = True
                                break
                    except Exception as poll_err:
                        log.warning("[EXT] 轮询异常: %s", str(poll_err)[:100])

                if not create_ok:
                    log.warning("[EXT] Ollama 未立即识别 manifest，但文件已就位，重启后生效")
                    log.info("[EXT] 尝试重启 Ollama 刷新缓存...")
                    try:
                        _httpx.get("%s/api/ps" % ollama_api, timeout=5, trust_env=False)
                    except Exception:
                        pass
                    _time.sleep(2)
                    try:
                        tags_resp = _httpx.get("%s/api/tags" % ollama_api, timeout=10, trust_env=False)
                        if tags_resp.status_code == 200:
                            existing = [m.get("name", "") for m in tags_resp.json().get("models", [])]
                            existing_base = [n.split(":")[0] for n in existing]
                            if ollama_model_name in existing or ollama_model_name in existing_base:
                                log.info("[EXT] 重试后模型出现: %s", existing)
                                create_ok = True
                    except Exception:
                        pass

                if not create_ok:
                    log.warning("[EXT] Ollama 缓存未刷新，但模型文件已注册，需重启生效")

                log.info("[EXT] Ollama 模型注册完成: %s (ollama name: %s)", ext_name, ollama_model_name)

                # 清理 llm 目录（GGUF 已在 blobs 中，llm 目录不再需要）
                try:
                    if os.path.isdir(model_path):
                        shutil.rmtree(model_path)
                        log.info("[EXT] 清理 llm 目录: %s (%.1f MB 已释放)", model_path, gguf_size / 1048576)
                        # 如果 llm 父目录为空也一并清理
                        llm_parent = os.path.join(_project_dir, "models", "llm")
                        if os.path.isdir(llm_parent) and not os.listdir(llm_parent):
                            os.rmdir(llm_parent)
                            log.info("[EXT] 清理空的 llm 父目录: %s", llm_parent)
                except Exception as clean_err:
                    log.warning("[EXT] llm 目录清理失败（不影响使用）: %s", str(clean_err)[:100])

            except Exception as ollama_err:
                log.warning("[EXT] Ollama 注册异常: %s", str(ollama_err)[:200])
                raise

            progress(90, "扫描模型...")
            mgr = get_mgr()
            mgr._scan_models()

            # 注册 LLM 到 ExtensionRegistry（修复重启后 is_installed("llm") 返回 False）
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.register("llm", {
                "id": "llm",
                "version": manifest.get("version", "1.0.0"),
                "name": ext_name,
                "models": {"llm": "models/llm"},
                "installed_at": datetime.now().isoformat(),
            })

            result = {"ok": True, "type": "llm", "name": ext_name,
                      "version": manifest.get("version", "1.0")}

        else:
            raise ValueError("不支持的扩展类型: %s" % ext_type)

        # === 完成 ===
        progress(95, "即将完成...")
        info["status"] = "done"
        info["result"] = result
        result_json = json.dumps(result, ensure_ascii=False)
        q.put(('data: {"type":"done","result":%s}\n\n' % result_json).encode("utf-8"))
        q.put(None)

    except Exception as e:
        log.error("[EXT] 扩展安装失败: %s" % str(e))
        info["status"] = "error"
        info["error"] = str(e)
        err_msg = str(e)[:200].replace('"', '\\"')
        q.put(('data: {"type":"error","message":"%s"}\n\n' % err_msg).encode("utf-8"))
        q.put(None)
    finally:
        # 清理临时目录
        for _attempt in range(3):
            try:
                shutil.rmtree(tmp_dir, ignore_errors=True)
                break
            except Exception:
                import time as _time
                _time.sleep(0.5)


@router.post("/api/extensions/upload")
async def api_extensions_upload(file: UploadFile = File(...)):
    """上传 .sidemate 扩展包 — 异步模式：返回 task_id，通过 SSE 获取进度"""
    if not file.filename:
        return JSONResponse({"error": "未选择文件"}, status_code=400)

    if not file.filename.lower().endswith('.sidemate'):
        return JSONResponse({"error": "请上传 .sidemate 格式的扩展包"}, status_code=400)

    # 接收文件到临时目录
    content = await file.read()
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    from config import EXTENSIONS_DIR
    os.makedirs(EXTENSIONS_DIR, exist_ok=True)

    import tempfile
    tmp_dir = tempfile.mkdtemp(prefix="ext_install_")
    sidemate_path = os.path.join(tmp_dir, "upload.sidemate")

    with open(sidemate_path, "wb") as f:
        f.write(content)

    # 生成 task_id，启动后台安装线程
    task_id = _uuid.uuid4().hex[:12]
    import time as _t
    _install_tasks[task_id] = {
        "queue": _queue.Queue(),
        "status": "running",
        "result": None,
        "error": None,
        "created_at": _t.time(),
    }

    t = _threading.Thread(target=_install_worker, args=(task_id, sidemate_path, tmp_dir, _project_dir))
    t.daemon = True
    t.start()

    # 清理旧任务
    _cleanup_old_tasks()

    log.info("[EXT] 扩展安装任务已启动: %s (file: %s)" % (task_id, file.filename))
    return {"task_id": task_id, "filename": file.filename}


@router.get("/api/extensions/install-progress/{task_id}")
def api_extensions_install_progress(task_id: str):
    """SSE 扩展安装进度推送"""
    info = _install_tasks.get(task_id)
    if not info:
        return JSONResponse({"error": "未知安装任务"}, status_code=404)

    q = info["queue"]

    def event_stream():
        while True:
            try:
                item = q.get(timeout=300)  # 最长等待 5 分钟
            except Exception:
                # 超时，发一个心跳
                yield b': heartbeat\n\n'
                continue
            if item is None:
                break
            yield item

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.get("/api/extensions/list")
def api_extensions_list():
    """已安装扩展列表（含 type 字段，同时兼容新旧注册方式）"""
    from config import EXTENSIONS_DIR
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    extensions = []

    # 新方式：ExtensionRegistry 注册信息
    try:
        from core.extension_manager import ExtensionRegistry
        registry = ExtensionRegistry(EXTENSIONS_DIR)
        for ext_info in registry.list_installed():
            ext_id = ext_info.get("id", "unknown")
            extensions.append({
                "name": ext_id,
                "version": ext_info.get("version", "?"),
                "type": ext_id,  # knowledge / recorder
                "models": ext_info.get("models", {}),
                "installed_at": ext_info.get("installed_at", ""),
            })
    except Exception as e:
        log.warning("[EXT] 读取 ExtensionRegistry 失败: %s", str(e)[:100])

    return {"extensions": extensions}


@router.delete("/api/extensions/uninstall/{ext_type}/{ext_name}")
async def api_extensions_uninstall(ext_type: str, ext_name: str):
    """通用卸载扩展"""
    from config import EXTENSIONS_DIR
    _project_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

    if ext_type == "knowledge":
        kb = get_kb()
        if kb._embedder_loaded or kb.reranker._loaded:
            kb.unload_models()
        # 删除模型目录
        for sub in ("embedding", "reranker"):
            model_dir = os.path.join(_project_dir, "models", sub)
            if os.path.exists(model_dir):
                shutil.rmtree(model_dir)
        # 通过 ExtensionRegistry 注销
        try:
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.unregister("knowledge")
        except Exception as reg_err:
            log.warning("[EXT] 文库注册注销失败: %s", str(reg_err)[:100])
        log.info("[EXT] 文库扩展已卸载")
        return {"ok": True, "msg": "文库扩展已卸载"}

    elif ext_type == "recorder":
        # P6 归档：recorder 已下线，不再 unload whisper
        # 删除模型目录
        whisper_model_dir = os.path.join(_project_dir, "models", "whisper")
        if os.path.exists(whisper_model_dir):
            shutil.rmtree(whisper_model_dir)
        # 通过 ExtensionRegistry 注销
        try:
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.unregister("recorder")
        except Exception as reg_err:
            log.warning("[EXT] 纪要注册注销失败: %s", str(reg_err)[:100])
        log.info("[EXT] 纪要扩展已卸载")
        return {"ok": True, "msg": "纪要扩展已卸载"}

    elif ext_type == "llm":
        # 删除 manifests 目录中对应模型
        mgr = get_mgr()
        ollama_model_name = ext_name.replace(".", "-")
        models_dir = os.path.join(_project_dir, "models")
        manifest_dir = os.path.join(
            models_dir, "manifests", "registry.ollama.ai", "library", ollama_model_name
        )
        if os.path.exists(manifest_dir):
            shutil.rmtree(manifest_dir)
            log.info("[EXT] 已删除 LLM manifest: %s", manifest_dir)
        # 通过 ExtensionRegistry 注销
        try:
            from core.extension_manager import ExtensionRegistry
            registry = ExtensionRegistry(EXTENSIONS_DIR)
            registry.unregister("llm")
        except Exception as reg_err:
            log.warning("[EXT] LLM 注册注销失败: %s", str(reg_err)[:100])
        mgr._scan_models()
        log.info("[EXT] LLM 模型已卸载: %s", ext_name)
        return {"ok": True, "msg": "LLM 模型已卸载"}

    return JSONResponse({"error": "未知扩展类型: %s" % ext_type}, status_code=404)


@router.delete("/api/extensions/{ext_type}/{ext_name}")
async def api_extensions_delete_legacy(ext_type: str, ext_name: str):
    """卸载扩展（旧版路径，保留兼容）"""
    return await api_extensions_uninstall(ext_type, ext_name)


# ============================================================
#  搜索 API（Patch 2 — 联网研究配置）
# ============================================================

# ===== 搜索配置 API 已移除（本机直搜，零配置） =====
