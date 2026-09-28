# -*- coding: utf-8 -*-
"""
core/skill_installer.py — AI 自装 Skill（0.11 B3）
====================================================

install_skill 工具的后端实现：本地 zip/目录 → 解包暂存 → 安全校验 →
用户确认卡 → 落 data/skills/ → 注册生效。全程不联网（无市场依赖）。

安全校验（全部通过才允许安装）：
  1. 来源必须存在且为 zip 文件或目录
  2. 体积 ≤ 200KB（解包后总量）
  3. 顶层（或唯一子目录）必须有合法 SKILL.md（frontmatter 含 name）
  4. 无可执行文件（.exe/.bat/.cmd/.ps1/.sh/.dll/.so/.pyc）与脚本引用
  5. 无外链脚本标签（<script src=）、无 http 链接的自动加载

流程（两步确认）：
  validate_and_stage(source) → 校验 + 暂存到 data/cache/skill_staging/<name>/
  install_staged(name)       → 确认后拷入 data/skills/<name>/（已存在则拒绝）
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import tempfile
import zipfile
from typing import Optional

log = logging.getLogger(__name__)

MAX_TOTAL_BYTES = 200 * 1024          # 解包后总量上限
FORBIDDEN_EXT = {".exe", ".bat", ".cmd", ".ps1", ".sh", ".dll", ".so", ".pyc", ".msi", ".scr", ".vbs"}


def _staging_root() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, "cache", "skill_staging")


def _skills_root() -> str:
    from core.skill_loader import _skills_dir
    return _skills_dir()


def _validate_tree(root: str) -> dict:
    """校验已解包目录：返回 {ok, skill_name, files, checks, reason}。"""
    checks = []

    # 找 SKILL.md：顶层 或 唯一子目录
    skill_md = os.path.join(root, "SKILL.md")
    sub_dir = None
    if not os.path.isfile(skill_md):
        subs = [d for d in os.listdir(root)
                if os.path.isdir(os.path.join(root, d))]
        if len(subs) == 1:
            cand = os.path.join(root, subs[0], "SKILL.md")
            if os.path.isfile(cand):
                skill_md = cand
                sub_dir = subs[0]
    if not os.path.isfile(skill_md):
        return {"ok": False, "reason": "未找到 SKILL.md（顶层或唯一子目录）", "checks": checks}
    checks.append("frontmatter 文件存在（SKILL.md）")

    # 解析 frontmatter（复用 skill_loader 的解析器）
    from core.skill_loader import parse_skill_md
    sk = parse_skill_md(skill_md)
    if not sk or not sk.get("name"):
        return {"ok": False, "reason": "SKILL.md frontmatter 不合法（缺 name）", "checks": checks}
    name = sk["name"]
    if not re.match(r"^[A-Za-z0-9_\-\u4e00-\u9fff]{1,40}$", name):
        return {"ok": False, "reason": "技能名含非法字符（只允许中英文/数字/-_，≤40 字）", "checks": checks}
    checks.append("frontmatter 合法（name=%s）" % name)

    # 遍历：体积 + 可执行 + 外链脚本
    total = 0
    files = []
    for base, dirs, fnames in os.walk(root):
        # 跳过隐藏目录（.git 等）
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for fn in fnames:
            p = os.path.join(base, fn)
            rel = os.path.relpath(p, root)
            ext = os.path.splitext(fn)[1].lower()
            if ext in FORBIDDEN_EXT:
                return {"ok": False, "reason": "包含可执行文件：%s" % rel, "checks": checks}
            try:
                sz = os.path.getsize(p)
            except OSError:
                sz = 0
            total += sz
            files.append(rel)
            if total > MAX_TOTAL_BYTES:
                return {"ok": False, "reason": "解包后超体积上限（200KB）", "checks": checks}
            # 文本文件里查外链脚本
            if ext in (".md", ".txt", ".json", ".html", ".css", ".js") and sz < 100 * 1024:
                try:
                    with open(p, "r", encoding="utf-8", errors="ignore") as f:
                        txt = f.read()
                    if re.search(r"<script[^>]+src\s*=\s*[\"']https?://", txt, re.I):
                        return {"ok": False, "reason": "%s 引用外链脚本（<script src=http>）" % rel, "checks": checks}
                except Exception:
                    pass
    checks.append("无可执行文件 · 无外链脚本")
    checks.append("体积合规（%dKB / 200KB）" % (total // 1024))

    return {"ok": True, "skill_name": name, "description": sk.get("description", ""),
            "files": files[:20], "file_count": len(files), "checks": checks,
            "sub_dir": sub_dir}


def validate_and_stage(source: str) -> dict:
    """校验来源并暂存。返回给工具的完整信息（含 reason / 元信息）。"""
    src = (source or "").strip()
    if not src or not os.path.exists(src):
        return {"ok": False, "reason": "来源不存在：%r（只支持本机 zip 文件或目录）" % src[:120]}

    # zip 或目录 → 统一解到临时目录
    tmp = tempfile.mkdtemp(prefix="skill_in_")
    try:
        if os.path.isfile(src):
            if not src.lower().endswith(".zip"):
                return {"ok": False, "reason": "文件来源只支持 .zip（目录来源直接传目录路径）"}
            try:
                with zipfile.ZipFile(src, "r") as z:
                    # zip slip 防护：成员路径不得越出解包目录
                    for m in z.namelist():
                        tp = os.path.realpath(os.path.join(tmp, m))
                        if not tp.startswith(os.path.realpath(tmp) + os.sep):
                            return {"ok": False, "reason": "zip 内路径越界（zip slip），已拒绝"}
                    z.extractall(tmp)
            except zipfile.BadZipFile:
                return {"ok": False, "reason": "zip 文件损坏或不是有效压缩包"}
        else:
            shutil.copytree(src, tmp, dirs_exist_ok=True)

        r = _validate_tree(tmp)
        if not r.get("ok"):
            shutil.rmtree(tmp, ignore_errors=True)
            return r

        # 暂存（校验通过才落 staging；同名覆盖旧暂存）
        name = r["skill_name"]
        stage = os.path.join(_staging_root(), name)
        os.makedirs(_staging_root(), exist_ok=True)
        if os.path.isdir(stage):
            shutil.rmtree(stage, ignore_errors=True)
        src_tree = tmp if not r.get("sub_dir") else os.path.join(tmp, r["sub_dir"])
        shutil.copytree(src_tree, stage)
        r["staged"] = True
        r["source"] = os.path.basename(src)
        r["source_bytes"] = os.path.getsize(src) if os.path.isfile(src) else -1
        log.info("[SKILL-INSTALL] 校验通过并暂存: %s（%d 文件）", name, r["file_count"])
        return r
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def install_staged(name: str) -> dict:
    """把已暂存的技能装入 data/skills/（用户确认后调用）。"""
    stage = os.path.join(_staging_root(), name or "")
    if not name or not os.path.isdir(stage):
        return {"error": "暂存不存在（可能已过期，请重新让 AI 校验）"}
    dest = os.path.join(_skills_root(), name)
    if os.path.isdir(dest):
        return {"error": "已存在同名技能 %r——如需覆盖请先在技能页删除旧版" % name}
    os.makedirs(_skills_root(), exist_ok=True)
    shutil.copytree(stage, dest)
    shutil.rmtree(stage, ignore_errors=True)
    log.info("[SKILL-INSTALL] 已安装: %s → %s", name, dest)
    return {"ok": True, "name": name, "path": dest}


def cancel_staged(name: str):
    """用户拒绝安装 → 清掉暂存。"""
    try:
        stage = os.path.join(_staging_root(), name or "")
        if name and os.path.isdir(stage):
            shutil.rmtree(stage, ignore_errors=True)
    except Exception:
        pass
