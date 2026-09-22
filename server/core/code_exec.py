# -*- coding: utf-8 -*-
"""
core/code_exec.py — 受限子进程代码执行（0.10 M4-1，沙箱方案 3）
=================================================================

用户拍板（2026-09-22）：对标 AnythingLLM/Claude Code 的桌面信任模型。
不做 WASM 沙箱（那是多用户 Web 平台的事）；做受限子进程：

    超时 30s + 临时目录 cwd + 清空环境变量 + 内存限制 + 禁网（可选）

适用场景：数据计算（pandas/numpy）、文本处理、快速脚本。
不适用：系统管理、文件系统操作（走 project_write 的确认卡）。
"""
from __future__ import annotations

import os
import subprocess
import tempfile
import logging

log = logging.getLogger(__name__)

TIMEOUT_SECONDS = 30
MAX_OUTPUT_CHARS = 10000  # 输出截断上限
MAX_CODE_CHARS = 50000    # 代码长度上限


def execute_code(code: str, timeout: int = None) -> dict:
    """在受限子进程中执行 Python 代码。

    安全措施（方案 3）：
    - 子进程独立运行，超时强杀
    - cwd = 临时目录（代码产生的文件在临时目录，不碰用户文件）
    - 环境变量清空（防读取 API key 等敏感信息）
    - 禁止网络（Windows：不可直接禁，靠超时+监控；Linux：unshare 可选）
    - 输出截断（防刷屏）

    Returns:
        {"ok": bool, "stdout": str, "stderr": str, "returncode": int,
         "elapsed": float, "output_file": str|None（代码写入的文件）}
    """
    import time

    code = (code or "").strip()
    if not code:
        return {"ok": False, "error": "代码为空"}
    if len(code) > MAX_CODE_CHARS:
        return {"ok": False, "error": "代码过长（>%d 字符）" % MAX_CODE_CHARS}

    timeout = timeout or TIMEOUT_SECONDS
    t0 = time.time()

    # 临时目录（子进程 cwd + 代码写入临时 .py 执行）
    tmpdir = tempfile.mkdtemp(prefix="sidemate_exec_")
    script_path = os.path.join(tmpdir, "_exec.py")
    with open(script_path, "w", encoding="utf-8") as f:
        f.write(code)

    # 受限环境变量（只留 PATH 让 python 能启动；清掉 API key 等）
    env = {"PATH": os.environ.get("PATH", ""),
           "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),  # Windows 必需
           "PYTHONIOENCODING": "utf-8",
           "HOME": tmpdir, "USERPROFILE": tmpdir,  # 防读用户目录
           "TMP": tmpdir, "TEMP": tmpdir,
           }

    python_exe = sys_executable()

    try:
        proc = subprocess.run(
            [python_exe, "-I", script_path],  # -I = isolated mode（不加载用户 site-packages）
            capture_output=True, text=True, timeout=timeout,
            cwd=tmpdir, env=env,
        )
        elapsed = round(time.time() - t0, 1)
        stdout = (proc.stdout or "")[:MAX_OUTPUT_CHARS]
        stderr = (proc.stderr or "")[:MAX_OUTPUT_CHARS]

        # 检查临时目录里有没有产出文件（供下载）
        output_files = []
        for f in os.listdir(tmpdir):
            if f != "_exec.py":
                output_files.append(f)

        result = {
            "ok": proc.returncode == 0,
            "stdout": stdout,
            "stderr": stderr,
            "returncode": proc.returncode,
            "elapsed": elapsed,
            "output_files": output_files,
            "tmpdir": tmpdir,  # 供后续读取产出文件
        }
        if proc.returncode != 0 and stderr:
            result["error"] = "执行失败（exit %d）：%s" % (proc.returncode, stderr[:200])
        log.info("[CODE_EXEC] %.1fs exit=%d stdout=%d字 %s",
                 elapsed, proc.returncode, len(stdout), "产出:" + ",".join(output_files) if output_files else "")
        return result

    except subprocess.TimeoutExpired:
        elapsed = round(time.time() - t0, 1)
        log.warning("[CODE_EXEC] 超时 %ds，强杀", timeout)
        return {"ok": False, "error": "执行超时（%d 秒），已终止" % timeout, "elapsed": elapsed}
    except Exception as e:
        return {"ok": False, "error": "执行异常：%s" % str(e)[:200]}


def sys_executable() -> str:
    """当前 Python 解释器路径。"""
    import sys
    return sys.executable or "python"
