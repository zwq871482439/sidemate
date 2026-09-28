# -*- coding: utf-8 -*-
"""
core/skill_loader.py — SKILL.md 文件解析与注册（0.11 schema v2）
=================================================================

兼容行业格式 SKILL.md（Claude Code / ZCode / 社区生态通用）。

格式（YAML frontmatter + markdown 正文）：
    ---
    name: 写作-商务报告
    description: 商务报告写作技巧与模板（自动触发匹配用——写清楚"何时用"）
    trigger: scene            # scene=仅场景卡显式 | auto=仅自动匹配 | both（默认 both）
    pipeline_types: [docx, report]   # 可选：挂载的产物管线
    model: null               # 可选：该技能建议绑定的模型档案（0.11-B 生效）
    priority: 20              # 可选：越小越先注入；简表排序用
    ---

    # 正文 = prompt_fragment（注入产物管线/对话上下文的文本）

目录：
  用户 skill 目录：data/skills/（每 skill 一个 .md 文件或子目录含 SKILL.md）
  预装 skill 目录：server/skills-default/（首启拷入 data/skills/，只补不覆盖）

0.11 双通道挂载（PLAN-011 D1）：
  - 显式通道：场景卡发 [场景：x] → chat.py 解析 → get_scene_skill(x) → 注入 system prompt
  - 自动通道：get_auto_skill_summary() 简表进 system prompt + mount_skill 工具懒加载正文
"""

from __future__ import annotations

import json
import logging
import os
import re
import shutil
import threading
import time
from typing import List, Optional

log = logging.getLogger(__name__)

SKILLS_DIR_NAME = "skills"
SKILLS_DEFAULT_DIR_NAME = "skills-default"   # 仓库内预装（随安装包分发）

# 自动触发总开关（技能页金色开关，D-4 默认开）
SKILL_AUTO_TRIGGER_CONFIG = "skill_auto_trigger"
# 同任务挂载上限（D-6：超出仅记日志不注入）
SKILL_MOUNT_LIMIT = 3
# 简表每条 description 截断（token 防线）
_SUMMARY_DESC_MAX = 80
# 挂载日志保留条数
MOUNT_LOG_KEEP = 50
MOUNT_LOG_FILE = "skill_mount_log.json"


def _skills_dir() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, SKILLS_DIR_NAME)


def _skills_default_dir() -> str:
    # server/core/skill_loader.py → server/skills-default/
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                        SKILLS_DEFAULT_DIR_NAME)


# ============================================================
#  解析（schema v2：新增 trigger / model 字段，向后兼容 v1）
# ============================================================

_VALID_TRIGGERS = ("scene", "auto", "both")


def parse_skill_md(filepath: str) -> Optional[dict]:
    """解析一个 SKILL.md 文件，返回 skill dict 或 None（格式不合法）。"""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return None

    # YAML frontmatter（--- ... ---）
    meta = {}
    body = content
    fm_match = re.match(r"^---\s*\n(.*?)\n---\s*\n", content, re.DOTALL)
    if fm_match:
        # 简易 YAML 解析（不引入 yaml 依赖）
        for line in fm_match.group(1).split("\n"):
            m = re.match(r"^(\w+):\s*(.*)$", line.strip())
            if m:
                key, val = m.group(1), m.group(2).strip()
                # 列表解析 [a, b] → ["a", "b"]
                list_m = re.match(r"^\[(.*)\]$", val)
                if list_m:
                    val = [v.strip().strip("'\"") for v in list_m.group(1).split(",") if v.strip()]
                meta[key] = val
        body = content[fm_match.end():]
    else:
        # 无 frontmatter：从文件名取 name
        meta["name"] = os.path.splitext(os.path.basename(filepath))[0]

    if not meta.get("name"):
        return None

    trigger = str(meta.get("trigger", "both")).strip().lower()
    if trigger not in _VALID_TRIGGERS:
        trigger = "both"

    try:
        priority = int(meta.get("priority", 50))
    except (TypeError, ValueError):
        priority = 50

    return {
        "name": str(meta.get("name", "")),
        "description": str(meta.get("description", "")),
        "trigger": trigger,
        "pipeline_types": meta.get("pipeline_types", []),
        "model": str(meta.get("model")) if meta.get("model") else "",
        "priority": priority,
        "prompt_fragment": body.strip(),
        "source_file": filepath,
    }


# ============================================================
#  发现（mtime 缓存：改 SKILL.md 即刻生效不重启）
# ============================================================

_cache_lock = threading.Lock()
_cache: dict = {"key": None, "skills": []}


def _dir_cache_key(root: str) -> str:
    """目录指纹：所有 SKILL.md 的 (路径, mtime, size)。"""
    parts = []
    for base, _dirs, files in os.walk(root):
        for fn in files:
            if fn.endswith(".md"):
                p = os.path.join(base, fn)
                try:
                    st = os.stat(p)
                    parts.append("%s:%d:%d" % (p, int(st.st_mtime), st.st_size))
                except OSError:
                    pass
    return "|".join(parts)


def discover_skills(force: bool = False) -> List[dict]:
    """扫描 skills 目录，解析所有 SKILL.md（mtime 缓存，文件变了自动失效）。"""
    root = _skills_dir()
    if not os.path.isdir(root):
        return []
    key = _dir_cache_key(root)
    with _cache_lock:
        if not force and _cache["key"] == key:
            return _cache["skills"]
    skills = []
    for entry in sorted(os.listdir(root)):
        path = os.path.join(root, entry)
        if entry.endswith(".md"):
            sk = parse_skill_md(path)
            if sk:
                skills.append(sk)
        elif os.path.isdir(path):
            # 子目录形式：dir/SKILL.md
            sm = os.path.join(path, "SKILL.md")
            if os.path.isfile(sm):
                sk = parse_skill_md(sm)
                if sk:
                    skills.append(sk)
    skills.sort(key=lambda x: (x["priority"], x["name"]))
    with _cache_lock:
        _cache["key"] = key
        _cache["skills"] = skills
    return skills


def get_skill_by_name(name: str) -> Optional[dict]:
    """按 name 精确查找一个 skill。"""
    for sk in discover_skills():
        if sk["name"] == name:
            return sk
    return None


# ============================================================
#  显式通道：场景卡路由（[场景：x] → SKILL.md 正文）
# ============================================================

# poster 子场景 → poster 技能 + 风格提示（场景卡拆 3 张子卡，PLAN-011 A3）
_POSTER_STYLE_HINT = {
    "poster-typo": "文字排版海报（大字层级 + 金色点睛，适合金句/宣言/活动通知）",
    "poster-image": "图文海报（左图右文版式，适合产品与人物介绍）",
    "poster-data": "数据海报（大数字 + 条形对比，适合战报/榜单）",
}


def get_scene_skill(scene: str) -> Optional[dict]:
    """场景卡显式路由：scene 名 → skill dict（正文待注入）。

    解析顺序：精确 name 匹配 → poster-* 子场景（带风格提示）→ None（无技能，退化为纯意图标记）。
    """
    scene = (scene or "").strip()
    if not scene:
        return None
    # poster 子场景：挂 poster 技能 + 追加风格行
    if scene in _POSTER_STYLE_HINT:
        base = get_skill_by_name("poster")
        if base:
            sk = dict(base)
            sk["scene_hint"] = "用户已选定风格：%s。请按此风格收集内容并调用 create_poster（style 参数对应选用）。" % _POSTER_STYLE_HINT[scene]
            return sk
        return None
    return get_skill_by_name(scene)


# ============================================================
#  自动通道：简表 + 懒加载
# ============================================================

def auto_trigger_enabled() -> bool:
    """自动触发总开关（技能页金色开关）。"""
    try:
        from config import get as _cfg
        return bool(_cfg(SKILL_AUTO_TRIGGER_CONFIG, True))
    except Exception:
        return True


def get_auto_skills() -> List[dict]:
    """参与自动匹配的 skill（trigger ∈ {auto, both}）。"""
    return [sk for sk in discover_skills() if sk["trigger"] in ("auto", "both")]


def get_auto_skill_summary(max_entries: int = 8) -> str:
    """自动通道简表（name + description ≤2 行/条，注入 system prompt）。

    只给名字和一句话描述——正文经 mount_skill 工具按需取（渐进披露，token 防线）。
    """
    skills = get_auto_skills()
    if not skills:
        return ""
    lines = []
    for sk in skills[:max_entries]:
        desc = (sk["description"] or "").strip().replace("\n", " ")
        if len(desc) > _SUMMARY_DESC_MAX:
            desc = desc[:_SUMMARY_DESC_MAX] + "…"
        lines.append("- %s：%s" % (sk["name"], desc))
    return "\n".join(lines)


def get_skill_body(name: str) -> Optional[str]:
    """mount_skill 工具取正文（懒加载）。"""
    sk = get_skill_by_name(name)
    if not sk or not sk["prompt_fragment"]:
        return None
    return sk["prompt_fragment"]


# ============================================================
#  挂载日志（技能页展示：命中/跳过）
# ============================================================

def _mount_log_path() -> str:
    from config import DATA_DIR
    return os.path.join(DATA_DIR, MOUNT_LOG_FILE)


def append_mount_log(skill: str, hit: bool, detail: str = "", chat_id: str = ""):
    """追加一条挂载日志（保留最近 MOUNT_LOG_KEEP 条，写失败静默）。"""
    entry = {
        "ts": time.strftime("%Y-%m-%d %H:%M:%S"),
        "skill": skill,
        "hit": bool(hit),
        "detail": (detail or "")[:120],
        "chat": (chat_id or "")[:40],
    }
    try:
        logs = []
        p = _mount_log_path()
        if os.path.isfile(p):
            with open(p, "r", encoding="utf-8") as f:
                logs = json.load(f)
        logs.append(entry)
        logs = logs[-MOUNT_LOG_KEEP:]
        with open(p, "w", encoding="utf-8") as f:
            json.dump(logs, f, ensure_ascii=False, indent=1)
    except Exception as e:
        log.warning("[SKILL] 挂载日志写入失败: %s", str(e)[:80])


def read_mount_log(limit: int = 20) -> List[dict]:
    """读最近 limit 条挂载日志（新的在前）。"""
    try:
        p = _mount_log_path()
        if not os.path.isfile(p):
            return []
        with open(p, "r", encoding="utf-8") as f:
            logs = json.load(f)
        return list(reversed(logs[-limit:]))
    except Exception:
        return []


# ============================================================
#  预装分发（skills-default → data/skills，只补不覆盖）
# ============================================================

def ensure_default_skills() -> int:
    """把 server/skills-default/ 下的预装 skill 拷入 data/skills/。

    规则（PLAN-011 D1）：
      - 目标不存在才拷（用户改过/删过的绝不覆盖——升级只补不删）
      - 返回本次新拷贝的数量
    """
    src_root = _skills_default_dir()
    dst_root = _skills_dir()
    if not os.path.isdir(src_root):
        return 0
    copied = 0
    try:
        os.makedirs(dst_root, exist_ok=True)
        for entry in sorted(os.listdir(src_root)):
            s = os.path.join(src_root, entry)
            d = os.path.join(dst_root, entry)
            if os.path.isdir(s):
                if os.path.isdir(d):
                    continue
                shutil.copytree(s, d)
                copied += 1
            elif entry.endswith(".md"):
                if os.path.isfile(d):
                    continue
                shutil.copy2(s, d)
                copied += 1
        if copied:
            log.info("[SKILL] 预装技能已分发 %d 个 → %s", copied, dst_root)
    except Exception as e:
        log.warning("[SKILL] 预装技能分发失败: %s", str(e)[:100])
    return copied


# ============================================================
#  产物管线挂载（0.10 v1 机制保留：pipeline_types 有值的挂管线）
# ============================================================

def register_user_skills():
    """把用户 skill 注册进 pipeline_skills（有 pipeline_types 的才挂管线）。"""
    from core.pipeline_skills import register_skill
    skills = discover_skills()
    registered = 0
    for sk in skills:
        types = sk["pipeline_types"]
        if isinstance(types, str):
            types = [types]
        if types and sk["prompt_fragment"]:
            register_skill(
                name=sk["name"],
                pipeline_types=types,
                prompt_fragment=sk["prompt_fragment"],
                priority=sk["priority"],
            )
            registered += 1
            log.info("[SKILL] 已注册: %s → %s", sk["name"], types)
    if registered:
        log.info("[SKILL] 用户 skill 加载完成: %d 个", registered)
    return registered


def list_user_skills() -> List[dict]:
    """列出用户 skill（设置页展示用，含 trigger 字段）。"""
    return discover_skills()
