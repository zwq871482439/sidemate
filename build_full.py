#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
build_full.py — Sidemate 全量打包构建脚本

功能：
  1. 将全量依赖（KB + 纪要）安装到嵌入式 Python 的 site-packages/
  2. 验证所有依赖可正常 import
  3. 生成构建报告（体积、包列表、版本）

使用方法：
  cd C:\\Sidemate
  python build_full.py

前置条件：
  - dist/ 目录下有 KB 和纪要 .sidemate 扩展包（包含 wheels/）
  - 嵌入式 Python 在 python/ 目录

v1.0 — 2026-06-05
"""

import os
import subprocess
import sys
import zipfile
import shutil
import json
import tempfile
from pathlib import Path
from datetime import datetime

# ── 路径配置 ──────────────────────────────────────────────────
PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
PYTHON_DIR = os.path.join(PROJECT_DIR, "python")
PYTHON_EXE = os.path.join(PYTHON_DIR, "python.exe")
SITE_PACKAGES = os.path.join(PYTHON_DIR, "Lib", "site-packages")
DIST_DIR = os.path.join(PROJECT_DIR, "dist")
REPORT_FILE = os.path.join(PROJECT_DIR, "build_report.json")

# 全量依赖清单
REQUIRED_DEPS = {
    "kb": [
        "sentence_transformers",
        "torch",
        "transformers",
        "scipy",
        "sklearn",        # pip 名 scikit-learn，import 名 sklearn
        "faiss",
    ],
    "recorder": [
        "faster_whisper",
    ],
}


def log(msg: str):
    print("[BUILD] %s" % msg)


def check_prerequisites():
    """检查构建前置条件"""
    if not os.path.isfile(PYTHON_EXE):
        log("❌ 嵌入式 Python 不存在: %s" % PYTHON_EXE)
        sys.exit(1)
    if not os.path.isdir(DIST_DIR):
        log("❌ dist/ 目录不存在: %s" % DIST_DIR)
        sys.exit(1)

    # 检查 .sidemate 文件
    sidemate_files = [f for f in os.listdir(DIST_DIR) if f.endswith(".sidemate")]
    if not sidemate_files:
        log("❌ dist/ 目录下没有 .sidemate 文件")
        sys.exit(1)

    log("前置条件检查通过")
    log("  Python: %s" % PYTHON_EXE)
    log("  dist/: %d 个 .sidemate 文件" % len(sidemate_files))


def extract_all_wheels() -> str:
    """从所有 .sidemate 扩展包中提取 wheels 到临时目录"""
    tmp_dir = os.path.join(PROJECT_DIR, "_build_wheels_tmp")
    if os.path.isdir(tmp_dir):
        shutil.rmtree(tmp_dir)
    os.makedirs(tmp_dir, exist_ok=True)

    total_wheels = 0
    for fname in os.listdir(DIST_DIR):
        if not fname.endswith(".sidemate"):
            continue
        fpath = os.path.join(DIST_DIR, fname)
        try:
            zf = zipfile.ZipFile(fpath)
            wheels = [n for n in zf.namelist() if n.startswith("wheels/") and n.endswith(".whl")]
            if wheels:
                log("  从 %s 提取 %d 个 wheels" % (fname, len(wheels)))
                for w in wheels:
                    zf.extract(w, tmp_dir)
                    total_wheels += 1
            zf.close()
        except Exception as e:
            log("  ⚠️ 读取 %s 失败: %s" % (fname, str(e)[:80]))

    wheels_dir = os.path.join(tmp_dir, "wheels")
    if total_wheels == 0:
        log("⚠️ 没有找到任何 wheel 文件")
        return ""

    log("共提取 %d 个 wheels 到 %s" % (total_wheels, wheels_dir))
    return wheels_dir


def install_wheels(wheels_dir: str):
    """用 pip install --no-deps 逐个安装 wheels（避免批量安装时一个失败全部中断）"""
    if not wheels_dir or not os.path.isdir(wheels_dir):
        log("⚠️ 无 wheels 目录，跳过安装")
        return

    wheel_files = sorted([
        os.path.join(wheels_dir, f) for f in os.listdir(wheels_dir)
        if f.endswith(".whl")
    ])

    if not wheel_files:
        log("⚠️ wheels 目录为空")
        return

    log("逐个安装 %d 个 wheels..." % len(wheel_files))
    success_count = 0
    skip_count = 0
    fail_count = 0
    for wf in wheel_files:
        pkg_name = os.path.basename(wf).split("-")[0]
        pip_args = [PYTHON_EXE, "-m", "pip", "install", "--no-index", "--no-deps", wf]
        try:
            result = subprocess.run(pip_args, capture_output=True, text=True, timeout=120)
            if result.returncode != 0:
                # 检查是否 "already installed"（非错误）
                if "already installed" in (result.stdout + result.stderr):
                    skip_count += 1
                else:
                    fail_count += 1
                    log("  ⚠️ %s 失败: %s" % (pkg_name, (result.stderr or result.stdout)[:100]))
            else:
                success_count += 1
        except Exception as e:
            fail_count += 1
            log("  ❌ %s 异常: %s" % (pkg_name, str(e)[:100]))

    log("安装完成: ✅ %d 安装, ⏭️ %d 跳过, ❌ %d 失败" % (success_count, skip_count, fail_count))


def verify_imports() -> dict:
    """验证所有依赖可正常 import"""
    results = {}
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"
    env["HF_HUB_OFFLINE"] = "1"

    for category, deps in REQUIRED_DEPS.items():
        for mod_name in deps:
            try:
                result = subprocess.run(
                    [PYTHON_EXE, "-c", "import %s; print('OK')" % mod_name],
                    capture_output=True, text=True, timeout=15,
                    env=env,
                )
                ok = result.returncode == 0 and "OK" in result.stdout
                results[mod_name] = {"ok": ok, "category": category}
                status = "✅" if ok else "❌"
                log("  %s %s (%s)" % (status, mod_name, category))
            except Exception as e:
                results[mod_name] = {"ok": False, "category": category, "error": str(e)[:80]}
                log("  ❌ %s — %s" % (mod_name, str(e)[:80]))

    return results


def get_package_versions() -> dict:
    """获取所有已安装包的版本"""
    versions = {}
    env = os.environ.copy()
    env["PYTHONNOUSERSITE"] = "1"

    try:
        result = subprocess.run(
            [PYTHON_EXE, "-m", "pip", "list", "--format=json"],
            capture_output=True, text=True, timeout=30,
            env=env,
        )
        if result.returncode == 0:
            for pkg in json.loads(result.stdout):
                versions[pkg["name"]] = pkg["version"]
    except Exception:
        pass

    return versions


def get_dir_size(path: str) -> int:
    """计算目录总大小（字节）"""
    total = 0
    for dirpath, dirnames, filenames in os.walk(path):
        for f in filenames:
            fp = os.path.join(dirpath, f)
            try:
                total += os.path.getsize(fp)
            except OSError:
                pass
    return total


def generate_report(import_results: dict, versions: dict):
    """生成构建报告"""
    sp_size = get_dir_size(SITE_PACKAGES)
    python_size = get_dir_size(PYTHON_DIR)

    report = {
        "build_time": datetime.now().isoformat(),
        "python_dir": PYTHON_DIR,
        "site_packages_size_mb": round(sp_size / 1024 / 1024, 1),
        "python_total_size_mb": round(python_size / 1024 / 1024, 1),
        "imports": import_results,
        "total_packages": len(versions),
        "key_versions": {},
    }

    # 提取关键包版本
    key_pkgs = [
        "torch", "transformers", "sentence-transformers", "scipy",
        "scikit-learn", "faiss-cpu", "faster-whisper", "numpy",
        "fastapi", "httpx", "uvicorn", "pydantic",
        "tokenizers", "huggingface-hub",
    ]
    for pkg in key_pkgs:
        if pkg in versions:
            report["key_versions"][pkg] = versions[pkg]

    with open(REPORT_FILE, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    log("构建报告已保存到: %s" % REPORT_FILE)
    log("")
    log("=== 构建报告 ===")
    log("  site-packages: %.1f MB" % report["site_packages_size_mb"])
    log("  Python 总计: %.1f MB" % report["python_total_size_mb"])
    log("  已安装包: %d 个" % report["total_packages"])
    log("")
    log("  关键包版本:")
    for pkg, ver in report["key_versions"].items():
        log("    %s: %s" % (pkg, ver))
    log("")
    failed = [k for k, v in import_results.items() if not v["ok"]]
    if failed:
        log("  ❌ 验证失败的依赖: %s" % ", ".join(failed))
    else:
        log("  ✅ 全部依赖验证通过")


def main():
    print("=" * 60)
    print("  Sidemate v0.9 全量打包构建")
    print("  %s" % datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print("=" * 60)
    print()

    # 1. 检查前置条件
    log("Step 1/5: 检查前置条件...")
    check_prerequisites()
    print()

    # 2. 提取 wheels
    log("Step 2/5: 提取 wheels...")
    wheels_dir = extract_all_wheels()
    print()

    # 3. 安装 wheels
    log("Step 3/5: 安装依赖到嵌入式 Python...")
    if wheels_dir:
        install_wheels(wheels_dir)
    else:
        log("无 wheels 可安装，跳过（依赖可能已预装）")
    print()

    # 4. 验证
    log("Step 4/5: 验证依赖完整性...")
    import_results = verify_imports()
    print()

    # 5. 生成报告
    log("Step 5/5: 生成构建报告...")
    versions = get_package_versions()
    generate_report(import_results, versions)
    print()

    # 清理
    tmp_dir = os.path.join(PROJECT_DIR, "_build_wheels_tmp")
    if os.path.isdir(tmp_dir):
        shutil.rmtree(tmp_dir)
        log("临时文件已清理")

    # 结果
    failed = [k for k, v in import_results.items() if not v["ok"]]
    if failed:
        print()
        log("⚠️ 构建完成但有 %d 个依赖验证失败: %s" % (len(failed), ", ".join(failed)))
        log("   请检查 wheels 是否完整，或手动安装缺失依赖")
        sys.exit(1)
    else:
        print()
        log("🎉 全量构建完成！所有依赖验证通过 ✅")
        log("   现在可以用 Inno Setup 编译 setup.iss 生成安装包")


if __name__ == "__main__":
    main()
