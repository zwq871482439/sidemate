# -*- coding: utf-8 -*-
"""
core/cloud_profiles.py — 云模型多档案（0.11 B1，PLAN-011 D4）
================================================================

多档案（profiles）+ 顶栏快切。**物化方案**：档案列表存 settings.json，
激活档案切换时把 base_url/api_key/api_format/model 写进传统 cloud_* 配置键
并重置引擎 client 缓存——CloudEngine 零改动（run_with_tools(model=) 已支持
按次覆盖，供每技能绑模型用）。

存储（settings.json）：
    cloud_profiles: [
      {"id": "fast", "name": "快速", "tag": "fast",     # tag: fast|strong
       "base_url": "...", "api_key": "<encoded>", "api_format": "openai",
       "model": "glm-4.7-flash"}
    ]
    cloud_active_profile: "fast"

迁移（首启一次）：cloud_profiles 为空时，把现有 cloud_* 单份配置包装成
「默认」档案；无 key 则给两个未配置的示例档案（快速/深度）。
"""

from __future__ import annotations

import logging
import time
import uuid
from typing import List, Optional

log = logging.getLogger(__name__)

_TAG_VALUES = ("fast", "strong")
_FORMATS = ("openai", "anthropic")


# ============================================================
#  读
# ============================================================

def list_profiles() -> List[dict]:
    """返回档案列表（api_key 脱敏为 preview，附 active 标记）。"""
    from config import get as _cfg
    from core.cloud_engine import CloudEngine
    profiles = _cfg("cloud_profiles", []) or []
    active = _cfg("cloud_active_profile", "")
    out = []
    for p in profiles:
        if not isinstance(p, dict) or not p.get("id"):
            continue
        raw = CloudEngine._decode_api_key(p.get("api_key", ""))
        out.append({
            "id": p["id"],
            "name": str(p.get("name") or p["id"])[:20],
            "tag": p.get("tag") if p.get("tag") in _TAG_VALUES else "",
            "base_url": p.get("base_url", ""),
            "api_key_preview": CloudEngine.mask_api_key(raw),
            "api_key_set": bool(raw),
            "api_format": p.get("api_format", "openai"),
            "model": p.get("model", ""),
            "active": p["id"] == active,
        })
    return out


def get_active_profile() -> Optional[dict]:
    for p in list_profiles():
        if p["active"]:
            return p
    return None


def _find_raw(pid: str) -> Optional[dict]:
    from config import get as _cfg
    for p in (_cfg("cloud_profiles", []) or []):
        if isinstance(p, dict) and p.get("id") == pid:
            return p
    return None


# ============================================================
#  写（增/改/删/切）
# ============================================================

def save_profile(profile: dict) -> dict:
    """新建或更新档案（无 id=新建；api_key 留空=保留原值）。"""
    from config import get as _cfg, save_config
    from core.cloud_engine import CloudEngine
    profiles = [_p for _p in (_cfg("cloud_profiles", []) or []) if isinstance(_p, dict)]

    name = str(profile.get("name") or "").strip()[:20]
    if not name:
        return {"error": "档案名不能为空"}
    tag = profile.get("tag") if profile.get("tag") in _TAG_VALUES else ""
    fmt = profile.get("api_format") or "openai"
    if fmt not in _FORMATS:
        return {"error": "api_format 只支持 openai / anthropic"}
    base_url = (profile.get("base_url") or "").strip()
    model = (profile.get("model") or "").strip()
    if not model:
        return {"error": "模型名不能为空"}

    raw_key = (profile.get("api_key") or "").strip()
    pid = (profile.get("id") or "").strip()

    if pid and _find_raw(pid):
        p = _find_raw(pid)
        was_active = _cfg("cloud_active_profile", "") == pid
        p.update({"name": name, "tag": tag, "base_url": base_url,
                  "api_format": fmt, "model": model})
        if raw_key:
            p["api_key"] = CloudEngine._encode_api_key(raw_key)
        # 编辑的是激活档案 → 物化保持一致
        if was_active:
            profiles = [_p for _p in profiles if isinstance(_p, dict)]
            save_config({"cloud_profiles": profiles})
            return materialize(pid)
    else:
        pid = pid or ("p-" + uuid.uuid4().hex[:6])
        entry = {"id": pid, "name": name, "tag": tag, "base_url": base_url,
                 "api_format": fmt, "model": model,
                 "api_key": CloudEngine._encode_api_key(raw_key) if raw_key else "",
                 "created": time.strftime("%Y-%m-%d")}
        profiles.append(entry)
    save_config({"cloud_profiles": profiles})
    log.info("[PROFILES] 档案已保存: %s(%s)", name, pid)
    return {"ok": True, "id": pid}


def delete_profile(pid: str) -> dict:
    from config import get as _cfg, save_config
    profiles = [_p for _p in (_cfg("cloud_profiles", []) or []) if isinstance(_p, dict)]
    if _cfg("cloud_active_profile", "") == pid:
        return {"error": "不能删除使用中的档案，请先切换到其他档案"}
    rest = [p for p in profiles if p.get("id") != pid]
    if len(rest) == len(profiles):
        return {"error": "档案不存在"}
    save_config({"cloud_profiles": rest})
    return {"ok": True}


def switch_profile(pid: str) -> dict:
    """切换激活档案（物化到 cloud_* 键 + 重置引擎 client）。"""
    if not _find_raw(pid):
        return {"error": "档案不存在"}
    r = materialize(pid)
    if "error" in r:
        return r
    log.info("[PROFILES] 已切换档案: %s", pid)
    return {"ok": True, "id": pid}


def materialize(pid: str) -> dict:
    """把档案写进传统 cloud_* 配置键（引擎零改动的关键）。"""
    from config import save_config
    from core.cloud_engine import CloudEngine
    p = _find_raw(pid)
    if not p:
        return {"error": "档案不存在"}
    updates = {
        "cloud_active_profile": pid,
        "cloud_base_url": p.get("base_url") or "https://api.openai.com/v1",
        "cloud_api_format": p.get("api_format") or "openai",
        "cloud_model": p.get("model") or "gpt-4o-mini",
    }
    raw = CloudEngine._decode_api_key(p.get("api_key", ""))
    if raw:
        updates["cloud_api_key"] = p.get("api_key", "")
    save_config(updates)
    _reset_engine_client()
    return {"ok": True}


def _reset_engine_client():
    """配置变更后清引擎 client 缓存（与 settings_cloud 同款）。

    只在 server 模块已加载（真实运行态）时重置——测试/脚本环境直接跳过，
    避免 import server 触发其顶层初始化副作用。
    """
    import sys
    srv = sys.modules.get("server")
    mgr = getattr(srv, "mgr", None) if srv else None
    if mgr is not None and hasattr(mgr, "_cloud_engine") and mgr._cloud_engine:
        try:
            mgr._cloud_engine._reset_client()
        except Exception:
            pass


def sync_active_from_legacy() -> None:
    """设置页旧表单保存了 cloud_* 键后，把值同步回激活档案（双向一致）。"""
    from config import get as _cfg, save_config
    active = _cfg("cloud_active_profile", "")
    if not active:
        return
    p = _find_raw(active)
    if not p:
        return
    changed = False
    for src, dst in (("cloud_base_url", "base_url"), ("cloud_model", "model"),
                     ("cloud_api_format", "api_format"), ("cloud_api_key", "api_key")):
        v = _cfg(src, None)
        if v and p.get(dst) != v:
            p[dst] = v
            changed = True
    if changed:
        profiles = [_x for _x in (_cfg("cloud_profiles", []) or []) if isinstance(_x, dict)]
        save_config({"cloud_profiles": profiles})


# ============================================================
#  迁移（首启一次）
# ============================================================

def ensure_default_profiles() -> None:
    """cloud_profiles 为空时初始化：包装现有单份配置 / 给两个示例档案。

    0.11.1 v2 上线后（#9-②）：只要 v2 的 cloud_providers_v2 键已存在，
    v2 就是唯一权威来源，本函数直接返回——否则迁移清空的 cloud_profiles
    会在下次启动被这里的「重新包装」写回来，清理只在当次进程里成立。
    """
    from config import get as _cfg, save_config
    try:
        from core.cloud_providers import PROVIDERS_KEY as _V2_KEY
        if _cfg(_V2_KEY, None) is not None:
            return  # v2 已接管，v1 档案不再自动重建
    except Exception:
        pass
    if _cfg("cloud_profiles", None) is not None:  # 键存在（含空列表）= 已初始化
        return
    from core.cloud_engine import CloudEngine
    key = CloudEngine._decode_api_key(_cfg("cloud_api_key", ""))
    model = _cfg("cloud_model", "")
    if key and model:
        profiles = [{
            "id": "default", "name": "默认", "tag": "",
            "base_url": _cfg("cloud_base_url", "https://api.openai.com/v1"),
            "api_key": _cfg("cloud_api_key", ""),
            "api_format": _cfg("cloud_api_format", "openai"),
            "model": model, "created": time.strftime("%Y-%m-%d"),
        }]
        save_config({"cloud_profiles": profiles, "cloud_active_profile": "default"})
        log.info("[PROFILES] 迁移：现有云配置已包装为「默认」档案")
    else:
        profiles = [
            {"id": "fast", "name": "快速", "tag": "fast", "base_url": "",
             "api_key": "", "api_format": "openai", "model": "",
             "created": time.strftime("%Y-%m-%d")},
            {"id": "deep", "name": "深度", "tag": "strong", "base_url": "",
             "api_key": "", "api_format": "openai", "model": "",
             "created": time.strftime("%Y-%m-%d")},
        ]
        save_config({"cloud_profiles": profiles, "cloud_active_profile": "fast"})
        log.info("[PROFILES] 初始化：两个空白示例档案（快速/深度）")


def routing_hint() -> str:
    """agentRouting 提示表（纯提示层，PLAN-011 D4）：档案特点+任务建议。"""
    profiles = list_profiles()
    usable = [p for p in profiles if p["api_key_set"] and p["model"]]
    if len(usable) < 2:
        return ""
    lines = []
    for p in usable[:4]:
        feat = "适合复杂产物（PPT/报告/深度分析）" if p["tag"] == "strong" else "适合日常问答与轻量任务"
        lines.append("- %s（%s）：%s" % (p["name"], p["model"], feat))
    return ("用户已配置多个模型档案，当前使用「%s」。你可以根据任务复杂度"
            "建议用户切换档案（顶栏右侧），但不要假装自己已切换：\n%s"
            % ((get_active_profile() or {}).get("name", "?"), "\n".join(lines)))
