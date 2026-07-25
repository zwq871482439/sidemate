#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
build_extensions.py — 纯模型扩展包构建工具
=============================================
Patch5 C1: 扩展包从"模型+依赖"改为"仅模型"。
依赖（FlagEmbedding / sentence-transformers 等）已预装在嵌入式 Python 中，
扩展包不再包含 wheels/ 目录。

用法：
    python installer/build_extensions.py

产出文件（输出到 output/extensions/）：
    - sidemate-knowledge-bge-m3-v2.0.0.sidemate   (~6.5GB)
    - sidemate-llm-qwen3.5-4b-v1.0.0.sidemate     (~3GB)

.sidemate 包格式 = ZIP（ZIP_STORED，不压缩，模型文件本身已是压缩格式）。

注意：
    实际运行此脚本会打包 6.5GB+ 数据，耗时较长。
    本脚本仅供发版时手动运行，不随安装流程执行。
"""

import os
import sys
import json
import time
import zipfile
import logging

# ===== 日志配置 =====
logging.basicConfig(level=logging.INFO, format="[EXT] %(message)s")
log = logging.getLogger(__name__)

# ===== 路径常量 =====
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)  # C:\Sidemate
OUTPUT_DIR = os.path.join(PROJECT_DIR, "output", "extensions")


def _write_dir_to_zip(zf: zipfile.ZipFile, dir_rel: str) -> int:
    """将项目内一个子目录的所有文件写入 zip。

    Args:
        zf: ZipFile 对象
        dir_rel: 相对于 PROJECT_DIR 的目录路径（如 "models/embedding"）

    Returns:
        int: 写入的文件数
    """
    abs_dir = os.path.join(PROJECT_DIR, dir_rel)
    if not os.path.isdir(abs_dir):
        log.warning("  目录不存在，跳过: %s", dir_rel)
        return 0

    count = 0
    total_bytes = 0
    for root, dirs, files in os.walk(abs_dir):
        # 排除 __pycache__ 等无关目录
        dirs[:] = [d for d in dirs if d != "__pycache__"]
        for f in files:
            filepath = os.path.join(root, f)
            # arcname 使用正斜杠（ZIP 规范）
            arcname = os.path.relpath(filepath, PROJECT_DIR).replace("\\", "/")
            zf.write(filepath, arcname)
            count += 1
            total_bytes += os.path.getsize(filepath)

    size_gb = total_bytes / 1024 / 1024 / 1024
    log.info("  写入 %d 文件 (%.2f GB) from %s", count, size_gb, dir_rel)
    return count


def build_knowledge_extension() -> str:
    """构建知识库模型扩展包（BGE-M3 + Reranker-v2-m3）。

    包含：
      - models/embedding/  (BGE-M3, ~4.3GB)
      - models/reranker/   (BGE-Reranker-v2-m3, ~2.2GB)
      - manifest.json

    不含 wheels/（依赖已预装在嵌入式 Python 中）。

    Returns:
        str: 输出文件路径
    """
    log.info("--- 构建知识库扩展包 (BGE-M3 + Reranker) ---")

    manifest = {
        "id": "knowledge",
        "version": "2.0.0",
        "name": "BGE-M3 + Reranker-v2-m3",
        "type": "knowledge",
        "description": "BGE-M3 向量模型 + BGE-Reranker-v2-m3 精排模型",
        "models": {
            "embedding": "models/embedding",
            "reranker": "models/reranker",
        },
        "requires": {
            "python_packages": ["FlagEmbedding>=1.3.0", "sentence-transformers"],
            "description": "依赖已预装在嵌入式 Python 中",
        },
        "note": "Patch5 C1: 纯模型扩展包，不含 wheels/",
    }

    output_path = os.path.join(OUTPUT_DIR, "sidemate-knowledge-bge-m3-v2.0.0.sidemate")
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    start = time.time()
    # ZIP_STORED: 不压缩（模型文件本身已是压缩格式，再压缩浪费时间且无收益）
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_STORED) as zf:
        # manifest.json（放在包根目录）
        manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2)
        zf.writestr("manifest.json", manifest_json)
        log.info("  ✓ manifest.json")

        # 写入模型文件
        _write_dir_to_zip(zf, "models/embedding")
        _write_dir_to_zip(zf, "models/reranker")

    elapsed = time.time() - start
    size_mb = os.path.getsize(output_path) / 1024 / 1024
    log.info("[OK] %s: %.0f MB (%.1fs)", os.path.basename(output_path), size_mb, elapsed)
    return output_path


def build_llm_extension() -> str:
    """构建 LLM 模型扩展包（3 个 Qwen3.5 Q4_K_M 模型）。

    P7-4: 底座已换 llama.cpp，打包格式从 Ollama blobs/manifests 改为裸 GGUF + meta.json。
    包含 models/<model_id>/<gguf_filename> + models/<model_id>/meta.json。

    Returns:
        str: 输出文件路径
    """
    log.info("--- 构建 LLM 扩展包（3 个 Qwen3.5 Q4）---")

    # 模型定义（与 sidemate-cpp/sidemate_cpp_models/ 对应）
    models = [
        {"dir": "qwen3.5-0.8b-q4", "name": "Qwen3.5-0.8B (Q4_K_M)", "size_b": 0.8},
        {"dir": "qwen3.5-2b-q4", "name": "Qwen3.5-2B (Q4_K_M)", "size_b": 2},
        {"dir": "qwen3.5-4b-q4", "name": "Qwen3.5-4B (Q4_K_M)", "size_b": 4},
    ]

    # 模型源目录：主仓的 models/ 目录
    models_src = os.path.join(PROJECT_DIR, "models")

    manifest = {
        "id": "llm",
        "version": "1.0.0",
        "name": "Qwen3.5 三档模型包（0.8B/2B/4B · Q4_K_M）",
        "type": "llm",
        "description": "Qwen3.5 系列 3 个 Q4 量化模型（llama.cpp 格式）",
        "models": {
            "qwen3.5-0.8b-q4": "models/qwen3.5-0.8b-q4",
            "qwen3.5-2b-q4":   "models/qwen3.5-2b-q4",
            "qwen3.5-4b-q4":   "models/qwen3.5-4b-q4",
        },
        "requires": {
            "llamacpp": "llama.cpp 运行时（lib/ollama/llama-server.exe）已随主程序安装",
        },
        "note": "P7-4: 底座替换 llama.cpp，三个模型可单独加载/切换",
    }

    output_path = os.path.join(OUTPUT_DIR, "sidemate-llm-qwen3.5-q4-v1.0.0.sidemate")

    start = time.time()
    total_bytes = 0
    with zipfile.ZipFile(output_path, "w", zipfile.ZIP_STORED) as zf:
        manifest_json = json.dumps(manifest, ensure_ascii=False, indent=2)
        zf.writestr("manifest.json", manifest_json)
        log.info("  ✓ manifest.json")

        # 打包每个模型的 GGUF + meta.json
        for m in models:
            model_dir = os.path.join(models_src, m["dir"])
            meta_path = os.path.join(model_dir, "meta.json")
            if not os.path.isdir(model_dir):
                log.warning("  ⚠ 模型目录不存在: %s（跳过）", model_dir)
                continue
            # 找 GGUF 文件
            gguf_files = [f for f in os.listdir(model_dir) if f.lower().endswith(".gguf")]
            if not gguf_files:
                log.warning("  ⚠ %s 下无 GGUF 文件（跳过）", model_dir)
                continue
            gguf_name = gguf_files[0]
            gguf_path = os.path.join(model_dir, gguf_name)
            gguf_size = os.path.getsize(gguf_path)

            # 写入 GGUF（zip 内路径：models/<model_id>/<filename>.gguf）
            zf.write(gguf_path, f"models/{m['dir']}/{gguf_name}")
            log.info("  ✓ %s (%.1f GB)", gguf_name, gguf_size / 1024**3)
            total_bytes += gguf_size

            # 写入 meta.json（zip 内路径：models/<model_id>/meta.json）
            if os.path.isfile(meta_path):
                zf.write(meta_path, f"models/{m['dir']}/meta.json")
                log.info("  ✓ %s/meta.json", m["dir"])

    elapsed = time.time() - start
    size_mb = os.path.getsize(output_path) / 1024 / 1024
    log.info("[OK] %s: %.0f MB (%.1fs, 原始 %.1f GB)",
             os.path.basename(output_path), size_mb, elapsed, total_bytes / 1024**3)
    return output_path


def main() -> int:
    """主入口：构建所有纯模型扩展包。

    Returns:
        int: 退出码（0=成功）
    """
    log.info("=== Patch5 扩展包构建 (纯模型，无 wheels) ===")
    log.info("项目根目录: %s", PROJECT_DIR)
    log.info("输出目录: %s", OUTPUT_DIR)

    os.makedirs(OUTPUT_DIR, exist_ok=True)

    results = []
    try:
        results.append(build_knowledge_extension())
    except Exception as e:
        log.error("知识库扩展包构建失败: %s", e)

    try:
        results.append(build_llm_extension())
    except Exception as e:
        log.error("LLM 扩展包构建失败: %s", e)

    log.info("=== 完成 ===")
    log.info("共生成 %d 个扩展包", len(results))
    for path in results:
        size_gb = os.path.getsize(path) / 1024 / 1024 / 1024
        log.info("  %s (%.2f GB)", os.path.basename(path), size_gb)

    return 0 if results else 1


if __name__ == "__main__":
    sys.exit(main())
