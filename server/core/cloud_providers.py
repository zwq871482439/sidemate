# -*- coding: utf-8 -*-
"""
core/cloud_providers.py — 在线模型服务 v2（服务商 → 多模型，0.11.1）
====================================================================

行业模式（Cherry Studio / ChatBox / Claude 官方模型菜单）：
一个服务商（API 地址 + Key + 协议）下挂多个模型；每模型独立参数
（标签快/强、默认思考档、上下文窗口）；聊天区随时切换模型与思考强度。

存储（settings.json）：
    cloud_providers_v2: [
      {"id": "pv-xx", "name": "DeepSeek", "base_url": "https://api.deepseek.com",
       "api_key": "<encoded>", "api_format": "openai", "proxy_mode": "system",
       "models": [
         {"id": "m-xx", "model": "deepseek-v4-flash", "label": "",
          "tag": "fast"|"strong"|"",          # 标签：快/强/无
          "thinking": "high"|"low"|"off"|"",  # 默认思考档（空=不改当前）
          "ctx": 0}                            # 上下文窗口 tokens（0=按模型自动）
       ]}
    ]
    cloud_active_v2: {"provider": "pv-xx", "model": "m-xx"}

激活即物化（与 0.11 档案同款机制，CloudEngine 零改动）：
    cloud_base_url / cloud_api_key / cloud_api_format / cloud_model
    cloud_context_window（模型 ctx>0 时）/ cloud_thinking_level（模型 thinking 非空时）
    cloud_proxy_mode（服务商级）→ _reset_engine_client()

迁移：cloud_providers_v2 为空且旧 cloud_profiles 非空时，按
(base_url, api_format) 归组为服务商，每档案的 model 变成模型条目
（tag 继承；thinking/ctx 取当前全局值）。
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import List, Optional

log = logging.getLogger(__name__)

_FORMATS = ("openai", "anthropic")
_TAGS = ("fast", "strong", "")
_THINKS = ("high", "low", "off", "")
PROVIDERS_KEY = "cloud_providers_v2"
ACTIVE_KEY = "cloud_active_v2"


# ============================================================
#  基础读写
# ============================================================

def _raw_providers() -> List[dict]:
    from config import get as _cfg
    return [p for p in (_cfg(PROVIDERS_KEY, []) or []) if isinstance(p, dict) and p.get("id")]


def _save_providers(providers: List[dict]) -> None:
    from config import save_config
    save_config({PROVIDERS_KEY: providers})


def _find_provider(pid: str) -> Optional[dict]:
    for p in _raw_providers():
        if p["id"] == pid:
            return p
    return None


def _mask(raw: str) -> str:
    from core.cloud_engine import CloudEngine
    return CloudEngine.mask_api_key(raw)


def _decode(encoded: str) -> str:
    from core.cloud_engine import CloudEngine
    return CloudEngine._decode_api_key(encoded or "")


def _encode(raw: str) -> str:
    from core.cloud_engine import CloudEngine
    return CloudEngine._encode_api_key(raw)


def list_providers() -> List[dict]:
    """返回服务商列表（Key 脱敏；附当前激活模型标记）。"""
    from config import get as _cfg
    migrate_from_profiles()
    active = _cfg(ACTIVE_KEY, {}) or {}
    out = []
    for p in _raw_providers():
        raw = _decode(p.get("api_key", ""))
        models = []
        for m in (p.get("models") or []):
            if not isinstance(m, dict) or not m.get("model"):
                continue
            models.append({
                "id": m.get("id") or ("m-" + uuid.uuid4().hex[:6]),
                "model": str(m["model"])[:80],
                "label": str(m.get("label") or "")[:20],
                "tag": m.get("tag") if m.get("tag") in ("fast", "strong") else "",
                "thinking": m.get("thinking") if m.get("thinking") in ("high", "low", "off") else "",
                "ctx": int(m.get("ctx") or 0),
                "active": active.get("provider") == p["id"] and active.get("model") == (m.get("id") or m.get("model")),
            })
        out.append({
            "id": p["id"],
            "name": str(p.get("name") or p["id"])[:24],
            "base_url": p.get("base_url", ""),
            "api_format": p.get("api_format", "openai"),
            "proxy_mode": p.get("proxy_mode", "system"),
            "api_key_preview": _mask(raw),
            "api_key_set": bool(raw),
            "models": models,
            "active": active.get("provider") == p["id"],
        })
    return out


def get_active() -> Optional[dict]:
    """{"provider": {...}, "model": {...}}（含原始 Key 供引擎用）。"""
    from config import get as _cfg
    active = _cfg(ACTIVE_KEY, {}) or {}
    p = _find_provider(active.get("provider") or "")
    if not p:
        return None
    mid = active.get("model") or ""
    m = next((x for x in (p.get("models") or []) if (x.get("id") or x.get("model")) == mid), None)
    return {"provider": p, "model": m} if m else None


# ============================================================
#  服务商 CRUD
# ============================================================

def save_provider(data: dict) -> dict:
    """新建/更新服务商（api_key 留空=保留原值）。"""
    name = str(data.get("name") or "").strip()[:24]
    base_url = str(data.get("base_url") or "").strip()
    if not name:
        return {"error": "服务商名称不能为空"}
    if not base_url:
        return {"error": "API 地址不能为空"}
    fmt = data.get("api_format") or "openai"
    if fmt not in _FORMATS:
        return {"error": "协议只支持 openai / anthropic"}
    proxy = data.get("proxy_mode") or "system"
    if proxy not in ("system", "direct"):
        proxy = "system"
    pid = (data.get("id") or "").strip()
    raw_key = str(data.get("api_key") or "").strip()
    providers = _raw_providers()

    if pid and _find_provider(pid):
        p = _find_provider(pid)
        p.update({"name": name, "base_url": base_url.rstrip("/"),
                  "api_format": fmt, "proxy_mode": proxy})
        if raw_key:
            p["api_key"] = _encode(raw_key)
        _save_providers(providers)
        was_active = _is_active_provider(pid)
        if was_active:
            return materialize(pid, None)  # 地址/Key 变了 → 重物化（保持当前模型）
        return {"ok": True, "id": pid}

    pid = pid or ("pv-" + uuid.uuid4().hex[:6])
    providers.append({
        "id": pid, "name": name, "base_url": base_url.rstrip("/"),
        "api_format": fmt, "proxy_mode": proxy,
        "api_key": _encode(raw_key) if raw_key else "",
        "models": [], "created": time.strftime("%Y-%m-%d"),
    })
    _save_providers(providers)
    log.info("[PROVIDERS] 新增服务商: %s(%s)", name, pid)
    return {"ok": True, "id": pid}


def delete_provider(pid: str) -> dict:
    from config import get as _cfg
    active = _cfg(ACTIVE_KEY, {}) or {}
    if active.get("provider") == pid:
        return {"error": "不能删除使用中的服务商"}
    providers = [p for p in _raw_providers() if p["id"] != pid]
    if len(providers) == len(_raw_providers()):
        return {"error": "服务商不存在"}
    _save_providers(providers)
    return {"ok": True}


# ============================================================
#  模型 CRUD（服务商内）
# ============================================================

def save_model(pid: str, data: dict) -> dict:
    """新建/更新模型条目（mid 空=新建）。"""
    p = _find_provider(pid)
    if not p:
        return {"error": "服务商不存在"}
    model = str(data.get("model") or "").strip()[:80]
    if not model:
        return {"error": "模型 ID 不能为空"}
    entry = {
        "model": model,
        "label": str(data.get("label") or "").strip()[:20],
        "tag": data.get("tag") if data.get("tag") in ("fast", "strong") else "",
        "thinking": data.get("thinking") if data.get("thinking") in ("high", "low", "off") else "",
        "ctx": max(0, min(int(data.get("ctx") or 0), 2 * 1024 * 1024)),
    }
    mid = (data.get("id") or "").strip()
    models = [m for m in (p.get("models") or []) if isinstance(m, dict)]
    if mid:
        for i, m in enumerate(models):
            if (m.get("id") or m.get("model")) == mid:
                mid = m.get("id") or mid
                entry["id"] = mid
                models[i] = entry
                break
        else:
            return {"error": "模型不存在"}
    else:
        # 同名去重：直接更新已有
        existed = next((m for m in models if m.get("model") == model), None)
        if existed:
            entry["id"] = existed.get("id") or ("m-" + uuid.uuid4().hex[:6])
            models[models.index(existed)] = entry
        else:
            entry["id"] = "m-" + uuid.uuid4().hex[:6]
            mid = entry["id"]
            models.append(entry)
    p["models"] = models
    _save_providers(_raw_providers())
    # 编辑的是激活模型 → 重物化（参数可能变了）
    if _is_active_model(pid, entry["id"]):
        materialize(pid, entry["id"])
    return {"ok": True, "id": entry["id"]}


def delete_model(pid: str, mid: str) -> dict:
    from config import get as _cfg
    p = _find_provider(pid)
    if not p:
        return {"error": "服务商不存在"}
    active = _cfg(ACTIVE_KEY, {}) or {}
    if active.get("provider") == pid and active.get("model") == mid:
        return {"error": "不能删除使用中的模型"}
    models = [m for m in (p.get("models") or []) if (m.get("id") or m.get("model")) != mid]
    if len(models) == len(p.get("models") or []):
        return {"error": "模型不存在"}
    p["models"] = models
    _save_providers(_raw_providers())
    return {"ok": True}


def add_models_bulk(pid: str, model_ids: List[str]) -> dict:
    """从 API 拉取后批量加入（已存在的跳过）。"""
    p = _find_provider(pid)
    if not p:
        return {"error": "服务商不存在"}
    models = [m for m in (p.get("models") or []) if isinstance(m, dict)]
    have = {m.get("model") for m in models}
    added = 0
    for mid in (model_ids or []):
        mid = str(mid).strip()[:80]
        if mid and mid not in have:
            models.append({"id": "m-" + uuid.uuid4().hex[:6], "model": mid,
                           "label": "", "tag": "", "thinking": "", "ctx": 0})
            have.add(mid)
            added += 1
    p["models"] = models
    _save_providers(_raw_providers())
    return {"ok": True, "added": added}


# ============================================================
#  激活（物化）
# ============================================================

def _is_active_provider(pid: str) -> bool:
    from config import get as _cfg
    return (_cfg(ACTIVE_KEY, {}) or {}).get("provider") == pid


def _is_active_model(pid: str, mid: str) -> bool:
    from config import get as _cfg
    a = _cfg(ACTIVE_KEY, {}) or {}
    return a.get("provider") == pid and a.get("model") == mid


def select(pid: str, mid: str) -> dict:
    """选择模型（物化到 cloud_* + 重置引擎 client）。"""
    p = _find_provider(pid)
    if not p:
        return {"error": "服务商不存在"}
    m = next((x for x in (p.get("models") or []) if (x.get("id") or x.get("model")) == mid), None)
    if not m:
        return {"error": "模型不存在"}
    return materialize(pid, mid)


def materialize(pid: str, mid: Optional[str]) -> dict:
    """把 (服务商, 模型) 写进传统 cloud_* 键——引擎零改动的关键。"""
    from config import get as _cfg, save_config
    p = _find_provider(pid)
    if not p:
        return {"error": "服务商不存在"}
    if mid is None:
        from config import get as _g
        mid = (_g(ACTIVE_KEY, {}) or {}).get("model") or ""
    m = next((x for x in (p.get("models") or []) if (x.get("id") or x.get("model")) == mid), None)
    if not m:
        return {"error": "模型不存在"}

    updates = {
        ACTIVE_KEY: {"provider": pid, "model": m.get("id") or m["model"]},
        "cloud_base_url": p.get("base_url") or "https://api.openai.com/v1",
        "cloud_api_format": p.get("api_format") or "openai",
        "cloud_model": m["model"],
        "cloud_proxy_mode": p.get("proxy_mode") or "system",
        # Key 总是用目标服务商的覆盖：目标没有 Key 就写空。
        # 此前留旧值 → 切到无 Key 服务商（本地网关）时，上一家的 Key
        # 会随 Authorization 头发到新服务商的 base_url（跨主机串用，#9-①）。
        "cloud_api_key": p.get("api_key", ""),
        # ctx=0 表示「按模型自动」——必须显式复位，否则残留上一个模型的
        # 手动窗口值，预算/截断口径全错（#9-①）。
        "cloud_context_window": int(m.get("ctx") or 0),
    }
    if m.get("thinking") in ("high", "low", "off"):
        updates["cloud_thinking_level"] = m["thinking"]
    save_config(updates)
    _reset_engine_client()
    log.info("[PROVIDERS] 已切换模型: %s / %s", p.get("name"), m["model"])
    return {"ok": True, "model": m["model"]}


def _reset_engine_client():
    """配置变更后清引擎 client 缓存（与 cloud_profiles/settings_cloud 同款）。

    引擎实例挂在 server 顶层全局 mgr._cloud_engine 上——旧实现却在
    server 模块上找 cloud_engine/cloud/engine 属性、还要求引擎带根本
    不存在的缓存字典，跨服务商切换后请求仍发往上一家服务商、带着上一家
    的 Key（#30，P0）。只在 server 模块已加载（真实运行态）时重置；
    测试/脚本环境直接跳过。
    """
    import sys
    srv = sys.modules.get("server")
    mgr = getattr(srv, "mgr", None) if srv else None
    if mgr is not None and hasattr(mgr, "_cloud_engine") and mgr._cloud_engine:
        try:
            mgr._cloud_engine._reset_client()
        except Exception:
            pass


# ============================================================
#  从 API 拉取模型列表（GET {base}/models）
# ============================================================

def fetch_remote_models(base_url: str, api_key: str, fmt: str = "openai",
                        proxy_mode: str = "system") -> dict:
    """拉取服务商的可用模型 ID 列表（供「从 API 获取」按钮）。

    - openai 协议：GET {base}/v1/models + Authorization: Bearer
    - anthropic 协议：GET {base}/v1/models + x-api-key + anthropic-version
      （此前误用 Bearer 且端点缺 /v1，anthropic 服务商必报错，#9-②）
    - proxy_mode=direct → trust_env=False，不走系统代理（与服务商直连语义一致）
    """
    import httpx
    base = (base_url or "").strip().rstrip("/")
    if not base:
        return {"error": "缺少 API 地址"}
    url = base + ("/models" if base.endswith("/v1") else "/v1/models")
    if fmt == "anthropic":
        headers = {"anthropic-version": "2023-06-01"}
        if api_key:
            headers["x-api-key"] = api_key
    else:
        headers = {"Authorization": "Bearer " + api_key} if api_key else {}
    try:
        with httpx.Client(timeout=15, verify=True,
                          trust_env=(proxy_mode != "direct")) as c:
            r = c.get(url, headers=headers)
        if r.status_code != 200:
            return {"error": "HTTP %d：%s" % (r.status_code, r.text[:120])}
        data = r.json()
        ids = sorted({str(x.get("id")) for x in (data.get("data") or data.get("models") or [])
                      if isinstance(x, dict) and x.get("id")})
        return {"ok": True, "models": ids[:200]}
    except Exception as e:
        return {"error": "连接失败：%s" % str(e)[:120]}


# ============================================================
#  迁移（旧 cloud_profiles → v2，首访一次）
# ============================================================

def migrate_from_profiles() -> None:
    from config import get as _cfg, save_config
    # 幂等按「键是否存在」判定，不能用真值：providers 为空列表（用户删光了
    # 服务商）也是已迁移态，真值判断会重跑迁移、把旧 cloud_profiles 里的
    # 档案复活（#9-②）
    if _cfg(PROVIDERS_KEY, None) is not None:
        return
    from core.cloud_profiles import list_profiles as _lp
    profiles = _lp()
    if not profiles:
        # 无旧档案：包装当前 cloud_* 单份配置为默认服务商
        base = _cfg("cloud_base_url", "")
        model = _cfg("cloud_model", "")
        if base and model:
            providers = [{"id": "pv-default", "name": "默认服务商", "base_url": base,
                          "api_key": _cfg("cloud_api_key", ""),
                          "api_format": _cfg("cloud_api_format", "openai"),
                          "proxy_mode": _cfg("cloud_proxy_mode", "system"),
                          "models": [{"id": "m-default", "model": model, "label": "默认",
                                      "tag": "", "thinking": _cfg("cloud_thinking_level", "high"),
                                      "ctx": int(_cfg("cloud_context_window", 0) or 0)}],
                          "created": time.strftime("%Y-%m-%d")}]
            save_config({PROVIDERS_KEY: providers,
                         ACTIVE_KEY: {"provider": "pv-default", "model": "m-default"}})
            log.info("[PROVIDERS] 迁移：cloud_* 单份 → 默认服务商")
        return

    # 档案 → 按 (base_url, api_format) 归组
    def _host_name(url: str) -> str:
        try:
            from urllib.parse import urlparse
            h = urlparse(url).hostname or ""
            h = h.removeprefix("www.").removeprefix("api.")
            return (h.split(".")[0] or "服务商").capitalize()
        except Exception:
            return "服务商"

    groups = {}
    order = []
    for pr in profiles:
        k = (pr.get("base_url", ""), pr.get("api_format", "openai"))
        if k not in groups:
            groups[k] = {"id": "pv-" + uuid.uuid4().hex[:6],
                         "name": _host_name(k[0]) if k[0] else (pr.get("name") or "服务商"),
                         "base_url": k[0], "api_format": k[1],
                         "proxy_mode": _cfg("cloud_proxy_mode", "system"),
                         "api_key": _find_profile_key(pr), "models": []}
            order.append(k)
        g = groups[k]
        if pr.get("active"):
            g["_active_model_candidate"] = pr.get("model")
        g["models"].append({
            "id": "m-" + uuid.uuid4().hex[:6],
            "model": pr.get("model", ""),
            "label": pr.get("name", ""),
            "tag": pr.get("tag", ""),
            "thinking": _cfg("cloud_thinking_level", "high") if pr.get("active") else "",
            "ctx": int(_cfg("cloud_context_window", 0) or 0) if pr.get("active") else 0,
        })
    providers = []
    active = {}
    for k in order:
        g = groups[k]
        cand = g.pop("_active_model_candidate", None)
        if cand:
            for m in g["models"]:
                if m["model"] == cand:
                    active = {"provider": g["id"], "model": m["id"]}
        g.setdefault("created", time.strftime("%Y-%m-%d"))
        providers.append(g)
    if active:
        cur_model = _cfg("cloud_model", "")
        if cur_model and not any(m["model"] == cur_model for g in providers for m in g["models"]):
            # 当前 cloud_model 不在档案里 → 补一条避免激活悬空
            if providers:
                providers[0]["models"].append(
                    {"id": "m-" + uuid.uuid4().hex[:6], "model": cur_model,
                     "label": "当前", "tag": "", "thinking": "", "ctx": 0})
    # 单次写入：providers + active + 清理旧档案。分多次写在中间崩溃会留下
    # 半迁移态；旧 cloud_profiles 不清理则永远是复活源（#9-②）
    updates = {PROVIDERS_KEY: providers, "cloud_profiles": []}
    if active:
        updates[ACTIVE_KEY] = active
    save_config(updates)
    log.info("[PROVIDERS] 迁移：%d 个档案 → %d 个服务商", len(profiles), len(providers))


def _find_profile_key(pr: dict) -> str:
    """旧档案 Key 是脱敏的——从原始 cloud_profiles 里找编码 Key。"""
    from config import get as _cfg
    for p in (_cfg("cloud_profiles", []) or []):
        if isinstance(p, dict) and p.get("id") == pr.get("id"):
            return p.get("api_key", "")
    return ""
