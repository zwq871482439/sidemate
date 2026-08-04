#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
envsetup.py — Sidemate Development Environment Setup
====================================================
One-script setup for Sidemate development environment on Windows.

What it does:
  1. Checks prerequisites (Python, Git)
  2. Downloads and configures embedded Python 3.14
  3. Installs pip dependencies (~150 packages)
  4. Downloads llama-server (llama.cpp Vulkan build)
  5. Builds Sidemate.exe (Go Launcher, optional)

Usage:
  python envsetup.py [target_dir]

If target_dir is omitted, defaults to the script's own directory.
"""

import os
import sys
import ssl
import json
import shutil
import zipfile
import hashlib
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

# ====================================================================
# Config
# ====================================================================

PYTHON_VERSION = "3.14.5"
PYTHON_EMBED_URL = "https://www.python.org/ftp/python/%s/python-%s-embed-amd64.zip"

GET_PIP_URL = "https://bootstrap.pypa.io/get-pip.py"

# Pinned SHA256 for downloaded artifacts (supply-chain verification).
# 注意：升级 PYTHON_VERSION 或 LLAMA_TAG 时必须同步更新对应哈希，
# 否则下载会因校验失败而终止。重新计算方式见文件底部注释。
ARTIFACT_SHA256 = {
    "python-3.14.5-embed-amd64.zip": "ba6bd811c4eedb19195cf275770ef127e893d63701e24152606e2cb76f6d876a",
    "llama-b9585-bin-win-vulkan-x64.zip": "af6b1b94377b9f78dbb2285b878fb696d36766391499d65e055ecd622b69018a",
}

# llama.cpp release tag (Vulkan build for Windows x64)
# This is a known-stable release. Update periodically.
LLAMA_TAG = "b9585"
LLAMA_URL = "https://github.com/ggml-org/llama.cpp/releases/download/%s/llama-%s-bin-win-vulkan-x64.zip"

# pip dependencies (uses requirements.txt from the repo)
REQUIREMENTS_FILE = "requirements.txt"

# PyTorch CPU index (required for torch+cpu wheel)
TORCH_INDEX = "https://download.pytorch.org/whl/cpu"

# Go build command
GO_VERSION_MIN = "1.22"

# ====================================================================
# i18n
# ====================================================================

LANG = "en"  # set by user

MSG = {
    "en": {
        "title": "Sidemate Dev Environment Setup",
        "lang_prompt": "Select language:",
        "dir_prompt": "Target directory (press Enter for default): ",
        "dir_default": "(default: %s)",
        "step1": "Checking prerequisites",
        "step2": "Setting up embedded Python",
        "step3": "Installing pip dependencies",
        "step4": "Downloading llama-server",
        "step5": "Building Sidemate.exe (Go Launcher)",
        "checking": "  Checking %s...",
        "found": "Found: %s",
        "not_found": "Not found",
        "not_found_optional": "Not found (optional, skipping)",
        "already_exists": "Already exists, skipping",
        "downloading": "  Downloading %s...",
        "extracting": "  Extracting...",
        "configuring": "  Configuring site-packages...",
        "installing_pip": "  Installing pip...",
        "installing_deps": "  Installing dependencies (this may take 5-15 minutes)...",
        "building": "  Building...",
        "go_missing": "  Go not installed. Build Sidemate.exe manually later,",
        "go_missing2": "  or install Go from https://go.dev/dl/",
        "go_prompt": "  Go is required to build Sidemate.exe. Install now? (y/N): ",
        "go_download": "  Please install Go from https://go.dev/dl/ then re-run this script.",
        "complete": "Setup Complete!",
        "next_steps": "Next steps:",
        "next1": "  1. Launch Sidemate.exe",
        "next2": "  2. Go to Settings -> Model Download",
        "next3": "  3. Download an LLM model (4B recommended)",
        "skipped": "Skipped",
        "failed": "FAILED",
        "ok": "OK",
        "error_download": "Download failed: %s",
        "error_extract": "Extract failed: %s",
        "version_extract": "  Extracting version from config.py...",
    },
    "zh": {
        "title": "Sidemate 开发环境部署",
        "lang_prompt": "选择语言：",
        "dir_prompt": "目标目录（回车使用默认）：",
        "dir_default": "（默认：%s）",
        "step1": "检查前置环境",
        "step2": "配置嵌入式 Python",
        "step3": "安装 pip 依赖",
        "step4": "下载 llama-server 推理引擎",
        "step5": "编译 Sidemate.exe（Go Launcher）",
        "checking": "  检查 %s...",
        "found": "已安装：%s",
        "not_found": "未找到",
        "not_found_optional": "未找到（可选，跳过）",
        "already_exists": "已存在，跳过",
        "downloading": "  下载 %s...",
        "extracting": "  解压中...",
        "configuring": "  配置 site-packages...",
        "installing_pip": "  安装 pip...",
        "installing_deps": "  安装依赖中（约需 5-15 分钟）...",
        "building": "  编译中...",
        "go_missing": "  未安装 Go。稍后可手动编译 Sidemate.exe，",
        "go_missing2": "  或从 https://go.dev/dl/ 安装 Go",
        "go_prompt": "  编译 Sidemate.exe 需要 Go。现在安装吗？(y/N)：",
        "go_download": "  请从 https://go.dev/dl/ 安装 Go 后重新运行此脚本。",
        "complete": "部署完成！",
        "next_steps": "后续步骤：",
        "next1": "  1. 启动 Sidemate.exe",
        "next2": "  2. 进入 设置 → 模型下载",
        "next3": "  3. 下载 LLM 模型（推荐 4B）",
        "skipped": "跳过",
        "failed": "失败",
        "ok": "成功",
        "error_download": "下载失败：%s",
        "error_extract": "解压失败：%s",
        "version_extract": "  从 config.py 提取版本号...",
    },
}


def t(key, *args):
    s = MSG[LANG].get(key, key)
    return s % args if args else s


# ====================================================================
# Progress bar
# ====================================================================

def download_with_progress(url, dest_path):
    """Download a file with a progress bar.

    P8-4 供应链加固：默认启用 SSL 验证 + 下载后 SHA256 校验（ARTIFACT_SHA256）。
    SSL 验证失败时需用户显式确认才降级（老机器 certifi 过期场景），不再静默跳过。
    """
    ctx = ssl.create_default_context()  # 默认即验证证书+主机名

    req = urllib.request.Request(url, headers={"User-Agent": "Sidemate-Setup/1.0"})
    try:
        resp = urllib.request.urlopen(req, timeout=60, context=ctx)
    except (urllib.error.URLError, ssl.SSLError) as e:
        # 不在 try 里静默降级：明确告知风险，由用户决定是否继续
        print("\n  ⚠️  SSL 证书验证失败: %s" % str(e)[:120])
        print("  ⚠️  继续下载将不校验服务器身份（仅建议在确认网络可信时继续）")
        ans = input("  仍要继续吗？(y/N): ").strip().lower()
        if ans != "y":
            raise RuntimeError("SSL 验证失败，用户取消下载: %s" % url)
        resp = urllib.request.urlopen(req, timeout=60)

    total = int(resp.headers.get("Content-Length", 0))
    downloaded = 0
    chunk_size = 1024 * 64  # 64KB
    hasher = hashlib.sha256()

    with open(dest_path, "wb") as f:
        while True:
            chunk = resp.read(chunk_size)
            if not chunk:
                break
            f.write(chunk)
            hasher.update(chunk)
            downloaded += len(chunk)
            if total > 0:
                pct = downloaded * 100 // total
                bar_len = 20
                filled = pct * bar_len // 100
                bar = "=" * filled + " " * (bar_len - filled)
                speed = downloaded / 1024 / 1024  # rough MB
                print("\r  [%s] %3d%% (%.1fMB)" % (bar, pct, speed), end="", flush=True)
            else:
                print("\r  %d bytes" % downloaded, end="", flush=True)
    print()  # newline after progress

    # SHA256 校验（钉扎表内有此文件才校验；不匹配即终止并删除文件）
    fname = os.path.basename(dest_path)
    expected = ARTIFACT_SHA256.get(fname)
    if expected:
        actual = hasher.hexdigest()
        if actual != expected:
            try:
                os.remove(dest_path)
            except OSError:
                pass
            raise RuntimeError(
                "SHA256 校验失败: %s\n  期望: %s\n  实际: %s\n"
                "  文件可能损坏或被篡改，已删除。若是官方更新，请同步更新 ARTIFACT_SHA256。"
                % (fname, expected, actual))
        print("  SHA256 verified: %s" % fname)


# ====================================================================
# Step implementations
# ====================================================================

def check_prerequisites(target_dir):
    """Step 1: Check prerequisites."""
    print("\n[1/5] %s" % t("step1"))

    # Check Python (system)
    print(t("checking", "Python"))
    try:
        result = subprocess.run(
            [sys.executable, "--version"],
            capture_output=True, text=True, timeout=10
        )
        py_ver = result.stdout.strip()
        print("  [%s] Python: %s" % (t("ok"), py_ver))
    except Exception:
        print("  [%s] Python %s" % (t("failed"), t("not_found")))
        return False

    # Check Git
    print(t("checking", "Git"))
    try:
        result = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=10)
        git_ver = result.stdout.strip()
        print("  [%s] %s" % (t("ok"), git_ver))
    except Exception:
        print("  [%s] Git %s" % (t("failed"), t("not_found")))

    return True


def setup_embedded_python(target_dir):
    """Step 2: Download and configure embedded Python."""
    print("\n[2/5] %s" % t("step2"))

    python_dir = target_dir / "python"
    if (python_dir / "python.exe").exists():
        print("  %s" % t("already_exists"))
        return True

    # Download embeddable package
    url = PYTHON_EMBED_URL % (PYTHON_VERSION, PYTHON_VERSION)
    zip_path = target_dir / "python_embed.zip"
    print(t("downloading", "Python %s" % PYTHON_VERSION))
    try:
        download_with_progress(url, str(zip_path))
    except Exception as e:
        print("  [%s] %s" % (t("failed"), t("error_download", e)))
        return False

    # Extract
    print(t("extracting"))
    python_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            zf.extractall(str(python_dir))
    except Exception as e:
        print("  [%s] %s" % (t("failed"), t("error_extract", e)))
        return False
    finally:
        zip_path.unlink(missing_ok=True)

    # Configure _pth file
    print(t("configuring"))
    pth_files = list(python_dir.glob("python*._pth"))
    if pth_files:
        pth_file = pth_files[0]
        pth_content = pth_file.read_text(encoding="utf-8")
        # Ensure site-packages is enabled
        lines = pth_content.split("\n")
        new_lines = []
        has_site = False
        has_lib = False
        has_sp = False
        import_site_done = False
        for line in lines:
            stripped = line.strip()
            if stripped == "Lib":
                has_lib = True
            if stripped == "Lib/site-packages":
                has_sp = True
            if stripped == "import site":
                import_site_done = True
                new_lines.append(line)  # keep it
                continue
            if stripped.startswith("#") and "import site" in stripped:
                new_lines.append("import site")
                import_site_done = True
                continue
            new_lines.append(line)

        if not has_lib:
            new_lines.append("Lib")
        if not has_sp:
            new_lines.append("Lib/site-packages")
        if not import_site_done:
            new_lines.append("import site")

        pth_file.write_text("\n".join(new_lines), encoding="utf-8")

    # Create site-packages directory
    sp_dir = python_dir / "Lib" / "site-packages"
    sp_dir.mkdir(parents=True, exist_ok=True)

    # Install pip
    print(t("installing_pip"))
    get_pip_path = python_dir / "get-pip.py"
    try:
        download_with_progress(GET_PIP_URL, str(get_pip_path))
    except Exception as e:
        print("  [%s] %s: %s" % (t("failed"), "get-pip.py", e))
        return False

    python_exe = str(python_dir / "python.exe")
    try:
        subprocess.run(
            [python_exe, str(get_pip_path), "--no-warn-script-location"],
            check=True, capture_output=True, text=True, timeout=120
        )
    except subprocess.CalledProcessError as e:
        print("  [%s] pip install: %s" % (t("failed"), e.stderr[:200] if e.stderr else "unknown"))
        return False

    # Keep get-pip.py for reference (launcher may use it)
    print("  [%s] pip installed" % t("ok"))
    return True


def install_pip_deps(target_dir):
    """Step 3: Install pip dependencies."""
    print("\n[3/5] %s" % t("step3"))

    python_exe = str(target_dir / "python" / "python.exe")
    req_file = target_dir / REQUIREMENTS_FILE

    if not req_file.exists():
        print("  [%s] %s not found" % (t("failed"), REQUIREMENTS_FILE))
        return False

    print(t("installing_deps"))

    # Install torch first (needs special index for CPU build)
    torch_installed = False
    try:
        result = subprocess.run(
            [python_exe, "-c", "import torch; print(torch.__version__)"],
            capture_output=True, text=True, timeout=10
        )
        torch_installed = result.returncode == 0
    except Exception:
        pass

    if not torch_installed:
        print("  Installing torch (CPU)...")
        try:
            subprocess.run(
                [python_exe, "-m", "pip", "install", "torch", "--index-url", TORCH_INDEX,
                 "--no-warn-script-location"],
                check=True, capture_output=True, text=True, timeout=600
            )
            print("  [%s] torch installed" % t("ok"))
        except subprocess.CalledProcessError:
            print("  [%s] torch install failed, continuing without it" % t("failed"))

    # Install remaining dependencies
    try:
        proc = subprocess.run(
            [python_exe, "-m", "pip", "install", "-r", str(req_file),
             "--no-warn-script-location"],
            cwd=str(target_dir),
            timeout=1200  # 20 min timeout
        )
        if proc.returncode == 0:
            print("  [%s] All dependencies installed" % t("ok"))
            return True
        else:
            print("  [%s] pip install returned %d" % (t("failed"), proc.returncode))
            return False
    except subprocess.TimeoutExpired:
        print("  [%s] pip install timed out" % t("failed"))
        return False


def download_llama_server(target_dir):
    """Step 4: Download llama-server (llama.cpp Vulkan build)."""
    print("\n[4/5] %s" % t("step4"))

    lib_dir = target_dir / "lib" / "ollama"
    if (lib_dir / "llama-server.exe").exists():
        print("  %s" % t("already_exists"))
        return True

    url = LLAMA_URL % (LLAMA_TAG, LLAMA_TAG)
    zip_path = target_dir / "llama_server.zip"
    print(t("downloading", "llama-server (%s)" % LLAMA_TAG))
    try:
        download_with_progress(url, str(zip_path))
    except Exception as e:
        print("  [%s] %s" % (t("failed"), t("error_download", e)))
        print("  %s" % t("go_download"))
        return False

    # Extract — llama.cpp zip has files at root, we put them in lib/ollama/
    print(t("extracting"))
    lib_dir.mkdir(parents=True, exist_ok=True)
    try:
        with zipfile.ZipFile(str(zip_path), "r") as zf:
            zf.extractall(str(lib_dir))
    except Exception as e:
        print("  [%s] %s" % (t("failed"), t("error_extract", e)))
        return False
    finally:
        zip_path.unlink(missing_ok=True)

    # Verify key files
    if (lib_dir / "llama-server.exe").exists():
        print("  [%s] llama-server.exe installed" % t("ok"))
        return True
    else:
        print("  [%s] llama-server.exe not found after extraction" % t("failed"))
        return False


def build_launcher(target_dir):
    """Step 5: Build Sidemate.exe (Go Launcher)."""
    print("\n[5/5] %s" % t("step5"))

    # Check if already built
    exe_path = target_dir / "Sidemate.exe"
    if exe_path.exists():
        print("  %s" % t("already_exists"))
        return True

    # Check Go
    go_cmd = shutil.which("go")
    if not go_cmd:
        print("  %s" % t("go_missing"))
        print("  %s" % t("go_missing2"))
        return True  # Not a failure, just skipped

    # Get version from config.py
    config_path = target_dir / "server" / "config.py"
    version = "0.9.8"  # fallback
    if config_path.exists():
        try:
            content = config_path.read_text(encoding="utf-8")
            import re
            m = re.search(r'"version":\s*"([\d.]+)"', content)
            if m:
                version = m.group(1)
        except Exception:
            pass

    print(t("building"))
    launcher_dir = target_dir / "launcher"
    try:
        result = subprocess.run(
            ["go", "build",
             "-ldflags", "-H windowsgui -X main.AppVersion=v%s" % version,
             "-o", str(exe_path), "."],
            cwd=str(launcher_dir),
            capture_output=True, text=True, timeout=120
        )
        if result.returncode == 0 and exe_path.exists():
            size_mb = exe_path.stat().st_size / (1024 * 1024)
            print("  [%s] Sidemate.exe v%s (%.1fMB)" % (t("ok"), version, size_mb))
            return True
        else:
            print("  [%s] Build error: %s" % (t("failed"), result.stderr[:200]))
            return False
    except Exception as e:
        print("  [%s] %s" % (t("failed"), str(e)[:200]))
        return False


# ====================================================================
# Main
# ====================================================================

def main():
    print("=" * 50)
    print("  %s" % t("title"))
    print("=" * 50)
    print()

    # Language selection
    global LANG
    print("%s" % t("lang_prompt"))
    print("  [1] English")
    print("  [2] 中文")
    try:
        choice = input("> ").strip()
        if choice == "2":
            LANG = "zh"
    except (EOFError, KeyboardInterrupt):
        pass

    print()

    # Target directory
    script_dir = Path(__file__).resolve().parent
    default_dir = script_dir
    print("%s" % t("dir_prompt"))
    print("  %s" % t("dir_default", str(default_dir)))
    try:
        user_dir = input("> ").strip()
    except (EOFError, KeyboardInterrupt):
        user_dir = ""

    target_dir = Path(user_dir) if user_dir else default_dir
    target_dir = target_dir.resolve()
    print("\n  -> %s\n" % target_dir)

    # Run steps
    ok = check_prerequisites(target_dir)
    if not ok:
        print("\n[%s] Prerequisites not met." % t("failed"))
        sys.exit(1)

    setup_embedded_python(target_dir)
    install_pip_deps(target_dir)
    download_llama_server(target_dir)
    build_launcher(target_dir)

    # Done
    print("\n" + "=" * 50)
    print("  %s" % t("complete"))
    print("=" * 50)
    print()
    print("%s" % t("next_steps"))
    print(t("next1"))
    print(t("next2"))
    print(t("next3"))
    print()


if __name__ == "__main__":
    main()
