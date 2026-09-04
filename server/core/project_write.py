# -*- coding: utf-8 -*-
"""
core/project_write.py — 项目目录写权限（M2-3，PLAN 五点五-4 M2 段 + ②+++ 三件套）
================================================================================

安全基线（V1）：
- 写操作限定在项目目录内（规范化后校验前缀，防穿越；禁绝对路径/..）
- .sidemate/ 是系统管理区（log/versions/manifest/handoff），AI 不可写
- AI 不删文件（无 delete 动作）
- 覆盖已有文件前自动备份到 .sidemate/versions/<路径>/<时间戳>（可撤销）
- 计划/执行双模式：meta.exec_mode 默认 plan——plan 模式下 project_write
  只登记不执行（进 pending_plan），用户确认后才真正落盘

三件套：
- .sidemate/log.jsonl      AI 每次写/改的 commit 式记录（追加式）
- .sidemate/versions/      写前备份（撤销的数据源）
- .sidemate/manifest.json  文件清单（size/mtime），AI 写入即更新 →
                           scan_changes 的 diff 天然只剩外部改动

任务目标机制：meta.goal（set_goal 工具写入），进 prompt 注入与 handoff 取材。
"""

from __future__ import annotations

import json
import logging
import os
import time

log = logging.getLogger(__name__)

MAX_FILE_BYTES = 5 * 1024 * 1024   # 单次写入上限 5MB
MAX_SCAN_FILES = 2000              # 变更感知扫描文件数上限
MAX_VERSIONS_PER_FILE = 10         # 单文件备份保留份数
MAX_PENDING_PLAN = 20              # 待执行计划条目上限


# ---------- 基础解析 ----------

def _resolve(chat_name):
    """解析会话的项目目录。返回 dict（legacy/dir/status…）。"""
    from session import projects
    return projects.resolve_chat_project(chat_name)


def _read_meta(chat_name):
    from session.chat_store import read_meta
    return read_meta(chat_name)


def _write_meta(chat_name, meta):
    # 走 chat_store 的 CHAT_DIR（测试可隔离），不直取 config
    from session import chat_store as _cs
    from common.utils import atomic_write_json
    meta["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    atomic_write_json(os.path.join(_cs.CHAT_DIR, chat_name, "meta.json"), meta)


def get_harness_state(chat_name):
    """会话 harness 状态（视窗会话 tab 信息卡 + prompt 注入共用）。

    Returns:
        dict: {exec_mode, goal, pending_plan, legacy, dir}
    """
    meta = _read_meta(chat_name) or {}
    proj = _resolve(chat_name)
    return {
        "exec_mode": meta.get("exec_mode") or "plan",
        "goal": meta.get("goal") or "",
        "pending_plan": meta.get("pending_plan") or [],
        "legacy": proj.get("legacy", True),
        "dir": proj.get("dir"),
        "status": proj.get("status"),
    }


def set_exec_mode(chat_name, mode):
    """切换计划/执行模式（计划=默认，执行=真正落盘）。"""
    if mode not in ("plan", "execute"):
        return {"ok": False, "error": "bad_mode", "message": "mode 只支持 plan/execute"}
    meta = _read_meta(chat_name)
    if not meta:
        return {"ok": False, "error": "no_meta"}
    meta["exec_mode"] = mode
    _write_meta(chat_name, meta)
    log.info("[PWRITE] %s exec_mode → %s", chat_name, mode)
    return {"ok": True, "exec_mode": mode}


def set_goal(chat_name, goal):
    """记一句话任务目标（任务目标机制；注入 prompt + handoff 取材）。"""
    goal = (goal or "").strip()[:100]
    meta = _read_meta(chat_name)
    if not meta:
        return {"ok": False, "error": "no_meta"}
    meta["goal"] = goal
    _write_meta(chat_name, meta)
    return {"ok": True, "goal": goal}


# ---------- 路径防穿越 ----------

def _safe_rel(rel_path):
    """校验并规范化项目内相对路径。返回 (ok, rel 或 error_msg)。

    规则：禁绝对路径/盘符、禁 .. 穿越、禁写入 .sidemate/ 系统区、
    禁空路径；统一为正斜杠相对路径。
    """
    if not rel_path or not isinstance(rel_path, str):
        return False, "路径为空"
    p = rel_path.replace("\\", "/").strip()
    if p.startswith("/") or (len(p) > 1 and p[1] == ":"):
        return False, "不允许绝对路径"
    parts = [seg for seg in p.split("/") if seg not in ("", ".")]
    if not parts:
        return False, "路径为空"
    if any(seg == ".." for seg in parts):
        return False, "不允许 .. 穿越"
    if parts[0] == ".sidemate":
        return False, ".sidemate 是系统管理区，不可直接写入"
    return True, "/".join(parts)


def _abs_in_project(proj_dir, rel):
    """拼绝对路径并二次校验前缀（规范化后必须仍在项目目录内）。"""
    target = os.path.normpath(os.path.join(proj_dir, rel.replace("/", os.sep)))
    root = os.path.normpath(proj_dir)
    if not (target == root or target.startswith(root + os.sep)):
        return None
    return target


# ---------- 三件套：log / versions / manifest ----------

def _sidemate_dir(proj_dir):
    d = os.path.join(proj_dir, ".sidemate")
    return d


def _append_log(proj_dir, entry):
    """log.jsonl 追加一条 commit 式记录（②+++ 三件套①；handoff 生成读它当素材）。"""
    try:
        sd = _sidemate_dir(proj_dir)
        os.makedirs(sd, exist_ok=True)
        entry = dict(entry)
        entry["ts"] = time.strftime("%Y-%m-%d %H:%M:%S")
        with open(os.path.join(sd, "log.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception as e:
        log.warning("[PWRITE] log.jsonl 追加失败: %s", str(e)[:100])


def _manifest_path(proj_dir):
    return os.path.join(_sidemate_dir(proj_dir), "manifest.json")


def _read_manifest(proj_dir):
    try:
        with open(_manifest_path(proj_dir), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_manifest(proj_dir, m):
    try:
        sd = _sidemate_dir(proj_dir)
        os.makedirs(sd, exist_ok=True)
        from common.utils import atomic_write_json
        atomic_write_json(_manifest_path(proj_dir), m)
    except Exception:
        pass


def _update_manifest_entry(proj_dir, rel, abs_path):
    """AI 写入后同步 manifest——scan_changes 的 diff 因此只反映外部改动。"""
    m = _read_manifest(proj_dir)
    try:
        st = os.stat(abs_path)
        m[rel] = {"size": st.st_size, "mtime": int(st.st_mtime)}
    except OSError:
        m.pop(rel, None)
    _write_manifest(proj_dir, m)


def _backup_existing(proj_dir, rel, abs_path):
    """覆盖前备份旧版到 .sidemate/versions/<路径>/<时间戳>。返回备份相对信息或 None。"""
    if not os.path.isfile(abs_path):
        return None
    ts = time.strftime("%Y%m%d-%H%M%S")
    vdir = os.path.join(_sidemate_dir(proj_dir), "versions", rel.replace("/", "__"))
    os.makedirs(vdir, exist_ok=True)
    dst = os.path.join(vdir, ts)
    import shutil
    shutil.copy2(abs_path, dst)
    # 滚动保留最近 N 份
    try:
        versions = sorted(os.listdir(vdir))
        while len(versions) > MAX_VERSIONS_PER_FILE:
            os.remove(os.path.join(vdir, versions.pop(0)))
    except OSError:
        pass
    return {"dir": vdir, "file": ts}


# ---------- 主动作：写文件（计划/执行双模式入口） ----------

def write_file(chat_name, rel_path, content, note=""):
    """写项目目录文件。

    plan 模式：只登记进 pending_plan（不落盘），返回待确认说明；
    execute 模式：防穿越校验 → 覆盖则写前备份 → 落盘 → log + manifest。

    Returns:
        dict: {ok, ...}（ok=False 时 error+message 指导模型下一步）
    """
    proj = _resolve(chat_name)
    if proj.get("legacy") or not proj.get("dir") or proj.get("status") != "ok":
        return {"ok": False, "error": "no_project",
                "message": "本会话没有可用的项目目录（旧版会话或目录丢失）"}
    ok, rel_or_err = _safe_rel(rel_path)
    if not ok:
        return {"ok": False, "error": "path_violation", "message": "路径不安全：%s" % rel_or_err}
    rel = rel_or_err
    if not isinstance(content, str):
        return {"ok": False, "error": "bad_content", "message": "content 必须是字符串"}
    if len(content.encode("utf-8")) > MAX_FILE_BYTES:
        return {"ok": False, "error": "too_large",
                "message": "内容超过 %dMB 上限" % (MAX_FILE_BYTES // 1048576)}

    meta = _read_meta(chat_name) or {}
    exec_mode = meta.get("exec_mode") or "plan"
    abs_path = _abs_in_project(proj["dir"], rel)
    if not abs_path:
        return {"ok": False, "error": "path_violation", "message": "路径越出项目目录"}
    will_overwrite = os.path.isfile(abs_path)

    # ---- 计划模式：登记不执行 ----
    if exec_mode != "execute":
        pending = meta.get("pending_plan") or []
        pending = [p for p in pending if p.get("path") != rel]
        pending.append({"path": rel, "overwrite": will_overwrite,
                        "bytes": len(content.encode("utf-8")),
                        "note": (note or "")[:80],
                        "ts": time.strftime("%H:%M:%S")})
        meta["pending_plan"] = pending[-MAX_PENDING_PLAN:]
        if meta:
            _write_meta(chat_name, meta)
        return {
            "ok": False, "error": "plan_mode", "pending": True,
            "planned_path": rel, "overwrite": will_overwrite,
            "message": ("当前是【计划模式】，写入未执行。已登记：%s%s。"
                        "请先把完整写入计划列给用户确认（用 ask 卡列出文件清单，"
                        "覆盖已有文件的标红提示），用户确认后调 set_exec_mode"
                        "(\"execute\") 再重新执行这些写入"
                        % (rel, "（将覆盖已有文件！）" if will_overwrite else "")),
        }

    # ---- 执行模式：真写 ----
    backup = _backup_existing(proj["dir"], rel, abs_path)
    os.makedirs(os.path.dirname(abs_path), exist_ok=True)
    with open(abs_path, "w", encoding="utf-8") as f:
        f.write(content)
    _update_manifest_entry(proj["dir"], rel, abs_path)
    _append_log(proj["dir"], {
        "chat": chat_name, "goal": meta.get("goal") or "",
        "action": "write", "path": rel,
        "bytes": len(content.encode("utf-8")),
        "overwrite": bool(will_overwrite),
        "backup": backup, "note": (note or "")[:80],
    })
    # 写成功 → 从待执行计划移除
    pending = [p for p in (meta.get("pending_plan") or []) if p.get("path") != rel]
    if len(pending) != len(meta.get("pending_plan") or []):
        meta["pending_plan"] = pending
        _write_meta(chat_name, meta)
    log.info("[PWRITE] %s 写入 %s（%dB，覆盖=%s，备份=%s）",
             chat_name, rel, len(content), will_overwrite, bool(backup))
    return {
        "ok": True, "path": rel, "bytes": len(content.encode("utf-8")),
        "overwritten": bool(will_overwrite), "backed_up": bool(backup),
        "message": "已写入 %s（%dB）%s" % (
            rel, len(content.encode("utf-8")),
            "；旧版已备份，可在会话信息卡撤销" if will_overwrite else ""),
    }


def discard_plan(chat_name):
    """清空待执行计划（用户取消时模型调用）。"""
    meta = _read_meta(chat_name)
    if not meta:
        return {"ok": False, "error": "no_meta"}
    n = len(meta.get("pending_plan") or [])
    meta["pending_plan"] = []
    _write_meta(chat_name, meta)
    return {"ok": True, "cleared": n}


# ---------- 撤销 ----------

def undo_last_write(chat_name):
    """撤销最近一次 AI 写入：有备份恢复旧版，无备份（新建文件）则移除。

    Returns:
        dict: {ok, path, restored|removed, message}
    """
    proj = _resolve(chat_name)
    if proj.get("legacy") or not proj.get("dir"):
        return {"ok": False, "error": "no_project", "message": "无项目目录"}
    log_path = os.path.join(_sidemate_dir(proj["dir"]), "log.jsonl")
    try:
        lines = open(log_path, encoding="utf-8").read().splitlines()
    except OSError:
        return {"ok": False, "error": "no_log", "message": "还没有可撤销的写入记录"}
    last = None
    for ln in reversed(lines):
        try:
            e = json.loads(ln)
        except ValueError:
            continue
        if e.get("action") == "write":
            last = e
            break
    if not last:
        return {"ok": False, "error": "no_log", "message": "还没有可撤销的写入记录"}
    rel = last.get("path", "")
    ok, rel_or_err = _safe_rel(rel)
    if not ok:
        return {"ok": False, "error": "path_violation", "message": rel_or_err}
    abs_path = _abs_in_project(proj["dir"], rel_or_err)
    backup = last.get("backup")
    import shutil
    if backup and os.path.isfile(os.path.join(backup["dir"], backup["file"])):
        shutil.copy2(os.path.join(backup["dir"], backup["file"]), abs_path)
        action = "restored"
        msg = "已恢复 %s 到写入前的版本" % rel_or_err
    else:
        # 新建文件的撤销 = 移除（恢复「不存在」状态；这是撤销 AI 自己的动作，
        # 不违反「AI 不删文件」——删除主体是系统的撤销功能）
        try:
            os.remove(abs_path)
            action = "removed"
            msg = "已移除新建文件 %s" % rel_or_err
        except OSError:
            return {"ok": False, "error": "undo_failed", "message": "撤销失败：文件已不在"}
    _update_manifest_entry(proj["dir"], rel_or_err, abs_path)
    _append_log(proj["dir"], {"chat": chat_name, "action": "undo",
                              "path": rel_or_err, "result": action})
    log.info("[PWRITE] %s 撤销 %s（%s）", chat_name, rel_or_err, action)
    return {"ok": True, "path": rel_or_err, "result": action, "message": msg}


# ---------- 变更感知（hash 清单三件套③） ----------

def scan_changes(chat_name):
    """扫描项目目录，对比 manifest 找出外部改动（新增/修改/删除）。

    AI 自己的写入已实时同步进 manifest，diff 天然只剩外部改动。
    扫描完成后更新 manifest（下次只报新变化）。

    Returns:
        dict: {changed: [...], added: [...], removed: [...]} 或 None（不可用）
    """
    proj = _resolve(chat_name)
    if proj.get("legacy") or not proj.get("dir") or proj.get("status") != "ok":
        return None
    root = os.path.normpath(proj["dir"])
    manifest = _read_manifest(root)
    current = {}
    count = 0
    for dirpath, dirnames, filenames in os.walk(root):
        # 跳过 .sidemate 系统区与隐藏目录
        dirnames[:] = [d for d in dirnames if d != ".sidemate" and not d.startswith(".")]
        for fn in filenames:
            if count >= MAX_SCAN_FILES:
                break
            fp = os.path.join(dirpath, fn)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            rel = os.path.relpath(fp, root).replace(os.sep, "/")
            current[rel] = {"size": st.st_size, "mtime": int(st.st_mtime)}
            count += 1
    changed = sorted(r for r in current
                     if r in manifest and current[r] != manifest[r])
    added = sorted(r for r in current if r not in manifest)
    removed = sorted(r for r in manifest if r not in current)
    _write_manifest(root, current)
    if not changed and not added and not removed:
        return None
    return {"changed": changed[:20], "added": added[:20], "removed": removed[:20],
            "total": len(changed) + len(added) + len(removed)}
