#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
tools/deploy_dev.py — 开发仓库 → 本机安装版快速部署（0.11 起用）

场景：日常开发在 C:\\deskware\\sidemate，实际验收/使用跑的是安装版
（C:\\Users\\slow\\AppData\\Local\\Sidemate，launcher + 独立 python）。
本脚本把 server/ 变更同步过去并（可选）重启其 server 进程。

用法：
    python tools/deploy_dev.py            # 同步代码 + 重启安装版 server
    python tools/deploy_dev.py --no-restart   # 只同步不重启

注意：
    - 只覆盖代码/静态产物，绝不碰安装目录的 data/（用户会话与 Key）
    - 重启 = 结束现有 server.py --serve 进程后从安装目录重新拉起
"""
import argparse
import os
import shutil
import subprocess
import sys
import time

SRC = os.path.normpath(os.path.join(os.path.dirname(__file__), "..", "server"))
DST = os.path.normpath(os.path.join(
    os.environ.get("LOCALAPPDATA", ""), "Sidemate", "server"))

# 0.10.2 → 0.11 起的变更清单（后续迭代在此追加；也可改成 git diff 自动化）
FILES = [
    "config.py", "server.py", "index.html",
    "core/skill_loader.py", "core/cloud_profiles.py", "core/curated_memory.py",
    "core/skill_installer.py", "core/poster_render.py", "core/gzh_format.py",
    "core/agent_tools.py", "core/agent_loop.py", "core/mcp_client.py", "core/cloud_providers.py",
    "routers/chat.py", "routers/kb.py", "routers/settings_cloud.py", "routers/settings_system.py",
    "pipelines/cloud_pipeline.py", "pipelines/_base.py",
    "prompts.py", "core/d2_render.py", "core/svg_lint.py", "routers/download.py",
    "static/js/v2/dist/bundle.js", "static/js/v2/dist/bundle.css", "static/js/v2/tour.js",
]
DIRS = ["skills-default", "static/dna"]


def deploy():
    if not os.path.isdir(DST):
        print("[DEPLOY] 安装目录不存在：%s" % DST)
        sys.exit(1)
    n = 0
    for f in FILES:
        s, d = os.path.join(SRC, f), os.path.join(DST, f)
        if not os.path.isfile(s):
            print("[DEPLOY] 跳过（源缺失）: %s" % f)
            continue
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
        n += 1
    for d in DIRS:
        sd = os.path.join(DST, d)
        if os.path.isdir(sd):
            shutil.rmtree(sd)
        shutil.copytree(os.path.join(SRC, d), sd)
        n += 1
    print("[DEPLOY] 已同步 %d 项 → %s" % (n, DST))


def restart():
    # 1) 结束现有 server 进程（python server.py --serve）
    r = subprocess.run(
        ["powershell", "-NoProfile", "-Command",
         "Get-CimInstance Win32_Process | Where-Object {$_.CommandLine -match 'server.py --serve'}"
         " | ForEach-Object { Stop-Process -Id $_.ProcessId -Force; $_.ProcessId }"],
        capture_output=True, text=True)
    killed = [x.strip() for x in (r.stdout or "").split() if x.strip()]
    print("[RESTART] 结束旧进程: %s" % (killed or "无"))
    time.sleep(2)
    # 2) 从安装目录重新拉起（detached，不随本脚本退出）
    subprocess.Popen(
        [os.path.join(os.path.dirname(DST), "python", "python.exe"), "-u", "server.py", "--serve"],
        cwd=DST,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "DETACHED_PROCESS", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0),
    )
    print("[RESTART] 已拉起 0.11 server（http://127.0.0.1:8976/）")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-restart", action="store_true")
    args = ap.parse_args()
    deploy()
    if not args.no_restart:
        restart()
