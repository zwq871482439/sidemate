"""
deps_check.py — 启动时依赖健康检查 + 完整性验证

核心思路：
  1. 检查关键依赖（base/kb/recorder/cloud）是否可正常 import
  2. 首次启动生成 manifest（包名+版本+SHA256）
  3. 日常启动通过 SHA256 抽检验证 site-packages 完整性
  4. 发现损坏时记录日志，不阻断启动（嵌入式 python/ 已包含完整依赖）

v2.0 — 2026-06-12（精简版，移除 wheels/snapshot/repair 体系）
"""

import hashlib
import importlib
import json
import logging
import os
import random
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Tuple

log = logging.getLogger("deps_check")

# ── 依赖清单 ──────────────────────────────────────────────────
# 每组：(import_name, pip_name, category)
# import_name: 实际 import 的模块名
# pip_name: pip install 时用的包名（用于日志显示）
# category: "base" / "kb" / "recorder" / "cloud"

REQUIRED_DEPS: List[Tuple[str, str, str]] = [
    # ── 基础依赖（核心功能） ──
    ("docx", "python_docx", "base"),
    ("psutil", "psutil", "base"),
    ("openai", "openai", "cloud"),  # 云端 AI 模式依赖
    # ── KB 依赖 ──
    ("torch", "torch", "kb"),
    ("transformers", "transformers", "kb"),
    ("sentence_transformers", "sentence_transformers", "kb"),
    ("scipy", "scipy", "kb"),
    ("sklearn", "scikit_learn", "kb"),
    ("faiss", "faiss_cpu", "kb"),
    ("rank_bm25", "rank_bm25", "kb"),  # Hybrid Search BM25 检索
    ("jieba", "jieba", "kb"),  # BM25 中文分词
    # ── 纪要依赖 ──
    ("faster_whisper", "faster_whisper", "recorder"),
]


def _import_check(import_name: str) -> bool:
    """检查单个依赖是否可 import"""
    try:
        importlib.import_module(import_name)
        return True
    except (ImportError, ModuleNotFoundError):
        return False
    except Exception as e:
        log.warning("[DEPS] import %s 时出现异常: %s", import_name, str(e)[:100])
        return False


def check_all() -> Dict[str, List[Tuple[str, str]]]:
    """
    检查所有依赖，返回 {category: [(import_name, pip_name), ...]} 缺失列表。
    """
    missing: Dict[str, List[Tuple[str, str]]] = {}
    for import_name, pip_name, category in REQUIRED_DEPS:
        if not _import_check(import_name):
            missing.setdefault(category, []).append((import_name, pip_name))
            log.warning("[DEPS] 缺失: %s (%s, category=%s)", import_name, pip_name, category)
    return missing


def check_deps(server_dir: str = "") -> Dict:
    """
    主入口：检查依赖完整性，返回结果。
    不做修复（嵌入式 python/ 已包含完整依赖，损坏时应重新安装）。

    Returns:
        {
            "all_ok": bool,
            "missing": {...},  # {category: [import_name, ...]}
        }
    """
    log.info("[DEPS] 开始依赖健康检查...")

    missing = check_all()
    if not missing:
        log.info("[DEPS] 全部依赖就绪 ✅")
        return {"all_ok": True, "missing": {}}

    all_missing_names = []
    for cat, items in missing.items():
        names = [i[0] for i in items]
        all_missing_names.extend(names)
        log.warning("[DEPS] %s 类别缺失: %s", cat, names)

    log.warning("[DEPS] 共 %d 个缺失依赖（部分功能可能不可用）", len(all_missing_names))
    return {
        "all_ok": False,
        "missing": {k: [i[0] for i in v] for k, v in missing.items()},
    }


# ── P4-B3: 依赖安全网（manifest + SHA256 验证） ─────────────

# 核心包集合：SHA256 抽检时全量检查
CORE_PACKAGES = frozenset({"torch", "transformers", "sentence_transformers", "numpy", "faiss"})


def sha256_file(filepath: str) -> str:
    """计算文件的 SHA256 哈希值。"""
    h = hashlib.sha256()
    with open(filepath, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def _extract_version(pkg_dir: str) -> str:
    """从 METADATA 或 __init__.py 提取版本号。"""
    parent_dir = os.path.dirname(pkg_dir)
    pkg_basename = os.path.basename(pkg_dir).replace("_", "-").lower()

    # 优先从 .dist-info/METADATA 读取
    if os.path.isdir(parent_dir):
        for item in os.listdir(parent_dir):
            if item.endswith(".dist-info") and pkg_basename in item.lower():
                metadata_path = os.path.join(parent_dir, item, "METADATA")
                if os.path.isfile(metadata_path):
                    try:
                        with open(metadata_path, "r", encoding="utf-8", errors="replace") as f:
                            for line in f:
                                if line.startswith("Version:"):
                                    return line.split(":", 1)[1].strip()
                    except Exception:
                        pass

    # fallback: 从 __init__.py 读取 __version__
    init_file = os.path.join(pkg_dir, "__init__.py")
    if os.path.isfile(init_file):
        try:
            with open(init_file, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    if "__version__" in line and "=" in line:
                        parts = line.split("=")
                        if len(parts) >= 2:
                            return parts[-1].strip().strip("'\"")
        except Exception:
            pass

    return "unknown"


def generate_manifest(site_packages: str) -> dict:
    """扫描 site-packages/ 目录，为每个包生成 manifest 条目。"""
    manifest = {
        "version": "1.0",
        "generated_at": datetime.now().isoformat(),
        "packages": {}
    }

    if not os.path.isdir(site_packages):
        log.warning("[MANIFEST] site-packages 不存在: %s", site_packages)
        return manifest

    for item in os.listdir(site_packages):
        item_path = os.path.join(site_packages, item)
        if not os.path.isdir(item_path):
            continue
        # 跳过 __pycache__ 和 .dist-info
        if item.startswith("__") or item.endswith(".dist-info"):
            continue

        init_file = os.path.join(item_path, "__init__.py")
        if not os.path.isfile(init_file):
            continue  # 不是 Python 包

        # 读取版本
        version = _extract_version(item_path)

        # SHA256
        sha = sha256_file(init_file)

        # 记录
        manifest["packages"][item] = {
            "version": version,
            "sha256": sha,
            "init_file": init_file,
        }

    log.info("[MANIFEST] 扫描完成，共 %d 个包", len(manifest["packages"]))
    return manifest


def save_manifest(manifest: dict, path: str):
    """保存 manifest 到 JSON 文件。"""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
    log.info("[MANIFEST] 已保存到 %s", path)


def load_manifest(path: str) -> dict:
    """加载 manifest JSON 文件。"""
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def verify_manifest(site_packages: str, manifest: dict) -> list:
    """SHA256 抽检已安装包的完整性。

    检查策略：
    - CORE_PACKAGES（torch, transformers, sentence_transformers, numpy, faiss）全检
    - 其他包 20% 随机抽检

    Returns:
        损坏的包名列表（空列表表示全部通过）。
    """
    broken = []
    packages = manifest.get("packages", {})
    if not packages:
        return broken

    check_set = set()
    for pkg_name in packages:
        if pkg_name in CORE_PACKAGES:
            check_set.add(pkg_name)
        elif random.random() < 0.2:
            check_set.add(pkg_name)

    for pkg_name in check_set:
        info = packages[pkg_name]
        pkg_dir = os.path.join(site_packages, pkg_name.replace("-", "_"))
        if not os.path.isdir(pkg_dir):
            broken.append(pkg_name)
            log.warning("[VERIFY] 包目录不存在: %s", pkg_name)
            continue

        init_file = os.path.join(pkg_dir, "__init__.py")
        if os.path.isfile(init_file):
            actual = sha256_file(init_file)
            expected = info.get("sha256", "")
            if expected and actual != expected:
                broken.append(pkg_name)
                log.warning("[VERIFY] SHA256 不匹配: %s (expected=%s, actual=%s)",
                            pkg_name, expected[:12], actual[:12])
        else:
            broken.append(pkg_name)
            log.warning("[VERIFY] __init__.py 不存在: %s", pkg_name)

    if broken:
        log.warning("[VERIFY] 发现 %d 个损坏包: %s", len(broken), broken)
    else:
        log.info("[VERIFY] 抽检通过（检查了 %d 个包）", len(check_set))

    return broken


# ── 环境指纹（Launcher 启动前快速校验用） ─────────────

# 用于 fingerprint 校验的核心包（5 个大包，覆盖 90% 的体积）
FINGERPRINT_CORE_PKGS = ["torch", "transformers", "sentence_transformers", "numpy", "faiss"]


def generate_fingerprint(python_dir: str) -> dict:
    """
    生成 site-packages 环境指纹，供 Go Launcher 启动前快速校验。

    指纹内容：
      - total_files: site-packages 下文件总数
      - total_bytes: site-packages 下文件总大小（字节）
      - core_hashes: {包名: __init__.py 的 SHA256}（5 个核心包）
      - generated_at: 生成时间

    Args:
        python_dir: python/ 目录路径（python_dir/Lib/site-packages）

    Returns:
        指纹 dict
    """
    site_packages = os.path.join(python_dir, "Lib", "site-packages")
    if not os.path.isdir(site_packages):
        log.warning("[FINGERPRINT] site-packages 不存在: %s", site_packages)
        return {}

    # 1. 统计文件数和总大小
    total_files = 0
    total_bytes = 0
    for root, dirs, files in os.walk(site_packages):
        for f in files:
            fp = os.path.join(root, f)
            try:
                total_bytes += os.path.getsize(fp)
                total_files += 1
            except OSError:
                pass

    # 2. 核心包 __init__.py SHA256
    core_hashes = {}
    for pkg in FINGERPRINT_CORE_PKGS:
        init_file = os.path.join(site_packages, pkg, "__init__.py")
        if os.path.isfile(init_file):
            core_hashes[pkg] = sha256_file(init_file)
        else:
            core_hashes[pkg] = ""

    fingerprint = {
        "total_files": total_files,
        "total_bytes": total_bytes,
        "core_hashes": core_hashes,
        "generated_at": datetime.now().isoformat(),
    }

    # 3. 写入 .fingerprint 文件
    fp_path = os.path.join(python_dir, ".fingerprint")
    with open(fp_path, "w", encoding="utf-8") as f:
        json.dump(fingerprint, f, indent=2)
    log.info("[FINGERPRINT] 已生成: %d 文件, %.1f MB, %d 核心包 hash",
             total_files, total_bytes / (1024 * 1024), len(core_hashes))

    return fingerprint
