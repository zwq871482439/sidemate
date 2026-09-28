# -*- coding: utf-8 -*-
"""
core/curated_memory.py — Agent 策展记忆（0.11 C3，PLAN-011 D5）
=================================================================

替换/升级 handoff.md 同文件夹继承机制：Agent 主动整理结构化知识，
跨会话检索注入，而不只是被动聊天摘要。

结构（markdown 三节，项目级优先）：
    <project>/.sidemate/memory.md
        ## 偏好        —— 用户交付/风格/沟通偏好
        ## 项目上下文  —— 项目背景、约定、术语
        ## 常用操作    —— 用户反复让 AI 做的事及其参数

    无项目会话 fallback：data/memory/{chat_id}.md

边界（与经验沉淀的分工——PLAN-011 三）：记忆回答「这个用户/项目是谁」，
技能回答「这类事怎么干」。写入一律经确认卡（save_memory 工具描述强制）。

handoff 迁移：memory.md 不存在且项目有 handoff.md → 其正文作为
「项目上下文」初始条目（一次性；旧机制 0.12 下线）。
"""

from __future__ import annotations

import logging
import os
import re
from typing import List, Optional

log = logging.getLogger(__name__)

SECTIONS = ("偏好", "项目上下文", "常用操作")
_HEADER = "# 项目记忆（桌伴策展）"
_MAX_ENTRIES_PER_SECTION = 50      # 单节条目上限（防无限膨胀）
_INJECT_MAX_LINES = 8             # system prompt 注入上限（token 防线）


# ============================================================
#  存储位置
# ============================================================

def _memory_path(chat_id: str) -> str:
    """项目级优先：会话所属项目 .sidemate/memory.md；无项目 → data/memory/{chat_id}.md"""
    chat_id = (chat_id or "").strip()
    if chat_id:
        try:
            from session.projects import resolve_chat_project
            pd = resolve_chat_project(chat_id) or {}
            if pd.get("dir") and os.path.isdir(pd["dir"]):
                return os.path.join(pd["dir"], ".sidemate", "memory.md")
        except Exception:
            pass
    from config import DATA_DIR
    return os.path.join(DATA_DIR, "memory", "%s.md" % (chat_id or "_global"))


# ============================================================
#  读写
# ============================================================

def read_memory(chat_id: str) -> dict:
    """读记忆 → {sections: {节名: [条目]}, path}（不存在返回空结构）。"""
    p = _memory_path(chat_id)
    out = {s: [] for s in SECTIONS}
    if not os.path.isfile(p):
        return {"sections": out, "path": p, "exists": False}
    try:
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
    except OSError:
        return {"sections": out, "path": p, "exists": False}
    cur = None
    for line in content.split("\n"):
        m = re.match(r"^##\s*(.+)$", line.strip())
        if m:
            name = m.group(1).strip()
            cur = name if name in SECTIONS else None
            continue
        if cur and line.strip().startswith("- "):
            out[cur].append(line.strip()[2:].strip())
    return {"sections": out, "path": p, "exists": True}


def save_entry(chat_id: str, section: str, text: str) -> dict:
    """追加一条记忆（去重 + 单节上限）。返回 {ok} 或 {error}。"""
    section = (section or "").strip()
    if section not in SECTIONS:
        return {"error": "无效分节：%r（支持：%s）" % (section, "/".join(SECTIONS))}
    text = re.sub(r"\s+", " ", (text or "").strip())
    if not text:
        return {"error": "记忆内容为空"}
    if len(text) > 200:
        text = text[:200]
    mem = read_memory(chat_id)
    entries = mem["sections"][section]
    # 去重：完全相同或被现有条目包含 → 跳过
    if any(text == e or text in e for e in entries):
        return {"ok": True, "deduped": True, "section": section}
    if len(entries) >= _MAX_ENTRIES_PER_SECTION:
        return {"error": "「%s」节已满（%d 条），请先在记忆里精简旧条目" % (section, _MAX_ENTRIES_PER_SECTION)}
    p = mem["path"]
    os.makedirs(os.path.dirname(p), exist_ok=True)
    # 文件不存在 → 建头；存在但无该节 → 追加节
    if not mem["exists"]:
        with open(p, "w", encoding="utf-8") as f:
            f.write("%s\n\n## %s\n- %s\n" % (_HEADER, section, text))
    else:
        with open(p, "r", encoding="utf-8") as f:
            content = f.read()
        if re.search(r"^##\s*%s\s*$" % re.escape(section), content, re.M):
            # 在该节末尾（下一节前）插入
            content = re.sub(
                r"(^##\s*%s\s*\n(?:.*\n)*?)(?=^##\s|\Z)" % re.escape(section),
                lambda m: m.group(1).rstrip("\n") + "\n- %s\n\n" % text,
                content, count=1, flags=re.M)
        else:
            content = content.rstrip("\n") + "\n\n## %s\n- %s\n" % (section, text)
        with open(p, "w", encoding="utf-8") as f:
            f.write(content)
    log.info("[MEMORY] 已写入[%s]: %s", section, text[:60])
    return {"ok": True, "section": section, "text": text}


# ============================================================
#  检索与注入
# ============================================================

def recall(chat_id: str, query: str) -> dict:
    """关键词检索：query 分词（2+ 字段），任一命中即返回该条。"""
    mem = read_memory(chat_id)
    q = (query or "").strip()
    if not q:
        # 空查询：返回概览
        return {"sections": {k: len(v) for k, v in mem["sections"].items() if v},
                "path": mem["path"], "exists": mem["exists"]}
    # 中文按 2 字滑窗 + 英文按词
    terms = set(re.findall(r"[A-Za-z0-9_\-]{2,}", q))
    for i in range(len(q) - 1):
        terms.add(q[i:i + 2])
    hits = []
    for sec, entries in mem["sections"].items():
        for e in entries:
            if any(t.lower() in e.lower() for t in terms if len(t) >= 2):
                hits.append("[%s] %s" % (sec, e))
    return {"hits": hits[:20], "total": len(hits), "path": mem["path"],
            "exists": mem["exists"]}


def inject_hint(chat_id: str) -> str:
    """system prompt 注入块：记忆概要 + 偏好条目（v1 关键词级，v2 向量化在 0.12）。"""
    if not (chat_id or "").strip():
        return ""
    try:
        mem = read_memory(chat_id)
    except Exception:
        return ""
    if not mem["exists"]:
        # 一次性迁移：项目 handoff.md → 项目上下文节
        _migrate_handoff_once(chat_id, mem["path"])
        mem = read_memory(chat_id)
        if not mem["exists"]:
            return ""
    lines = []
    prefs = mem["sections"]["偏好"][:_INJECT_MAX_LINES]
    for p in prefs:
        lines.append("- %s" % p)
    for sec in ("项目上下文", "常用操作"):
        entries = mem["sections"][sec]
        if entries:
            lines.append("- [%s] 共 %d 条（recall_memory 查询「%s」可展开）" % (sec, len(entries), sec))
    if not lines:
        return ""
    return ("[长期记忆]\n以下是从跨会话记忆里读到的用户偏好与项目背景，"
            "遵循其约定（完整条目用 recall_memory 检索）：\n" + "\n".join(lines) + "\n")


def _migrate_handoff_once(chat_id: str, mem_path: str):
    """项目有 handoff.md 而无 memory.md → 交接正文作为「项目上下文」初始条目。"""
    try:
        from session.projects import resolve_chat_project
        pd = resolve_chat_project(chat_id) or {}
        pdir = pd.get("dir")
        if not pdir:
            return
        handoff = os.path.join(pdir, ".sidemate", "handoff.md")
        if not os.path.isfile(handoff) or os.path.isfile(mem_path):
            return
        with open(handoff, "r", encoding="utf-8") as f:
            raw = f.read()
        # 剥注释头与历史区，取正文前 800 字
        body = re.sub(r"^<!--.*?-->\s*", "", raw, flags=re.S)
        body = body.split("\n---\n## 历史")[0].strip()[:800]
        if body:
            os.makedirs(os.path.dirname(mem_path), exist_ok=True)
            with open(mem_path, "w", encoding="utf-8") as f:
                f.write("%s\n\n## 项目上下文\n- %s\n" % (_HEADER, body.replace("\n", " ")))
            log.info("[MEMORY] handoff.md 已迁移为项目记忆（%s）", mem_path)
    except Exception as e:
        log.warning("[MEMORY] handoff 迁移失败: %s", str(e)[:80])
