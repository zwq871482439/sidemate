# -*- coding: utf-8 -*-
"""
routers/settings_cloud.py — 云端 AI 模式管理端点

端点前缀 /api：
  模式管理：/api/mode, /api/mode/switch
  云端配置：/api/cloud/config (GET/POST)
  模型能力：/api/cloud/model-capabilities
  连接测试：/api/cloud/test
"""
import logging

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from routers.deps import get_mgr

router = APIRouter()
log = logging.getLogger("settings.cloud")


# ============================================================
#  云端 AI 模式管理
# ============================================================

@router.get("/api/mode")
def api_mode():
    """返回当前 AI 模式 + 可用模式 + 云端配置状态 + 上下文窗口"""
    from config import get as cfg_get
    ai_mode = cfg_get("ai_mode", "local")
    cloud_api_key = cfg_get("cloud_api_key", "")
    cloud_configured = bool(cloud_api_key)

    context_window = 0
    if ai_mode == "cloud" or cloud_configured:
        try:
            from core.cloud_engine import CloudEngine
            cloud_model = cfg_get("cloud_model", "gpt-4o-mini")
            # 优先用用户手动配置的值
            user_ctx = cfg_get("cloud_context_window", 0)
            if user_ctx and user_ctx > 0:
                context_window = user_ctx
            else:
                _ce = CloudEngine.__new__(CloudEngine)
                context_window = _ce._lookup_capabilities(cloud_model)["context_window"]
        except Exception:
            context_window = 32768

    # 本地模式的 max_history_chars（与 model_manager 一致）
    max_history_chars = 12000
    if ai_mode == "local":
        try:
            from core.model_manager import ModelManager
            mm = ModelManager()
            max_history_chars = getattr(mm, '_max_history_chars', 12000)
        except Exception:
            pass

    return {
        "mode": ai_mode,
        "available": ["local", "cloud"],
        "cloud_configured": cloud_configured,
        "cloud_model": cfg_get("cloud_model", "gpt-4o-mini") if ai_mode == "cloud" or cloud_configured else None,
        "context_window": context_window or 16000,
        "max_history_chars": max_history_chars,
    }


@router.post("/api/mode/switch")
async def api_mode_switch(request: Request):
    """切换 AI 模式（先测试云端连接，失败不允许切换到 cloud）"""
    body = await request.json()
    target = body.get("mode", "local")
    if target not in ("local", "cloud"):
        return JSONResponse({"ok": False, "error": "无效模式，支持: local, cloud"}, status_code=400)

    if target == "cloud":
        from core.cloud_engine import CloudEngine
        engine = CloudEngine(get_mgr())
        ok, latency, error = engine.test_connection()
        if not ok:
            return JSONResponse({
                "ok": False,
                "error": "云端连接测试失败: %s" % (error or "未知错误"),
                "latency_ms": latency,
            }, status_code=400)

    from config import set_value
    set_value("ai_mode", target)
    log.info("[MODE] AI 模式切换为: %s", target)

    # 返回切换后的上下文信息
    from config import get as _cfg_mode, MAX_OUTPUT_TOKENS, MAX_INPUT_TOKENS
    context_window = MAX_INPUT_TOKENS
    max_output_tokens = MAX_OUTPUT_TOKENS
    max_history_chars = int(context_window * 0.75)
    if target == "cloud":
        try:
            from core.cloud_engine import CloudEngine
            cloud_model = _cfg_mode("cloud_model", "gpt-4o-mini")
            _ce = CloudEngine.__new__(CloudEngine)
            caps = _ce._lookup_capabilities(cloud_model)
            context_window = caps["context_window"]
            max_output_tokens = caps["max_output"]
            max_history_chars = int(context_window * 0.75)
        except Exception:
            pass

    return {
        "ok": True,
        "mode": target,
        "context_window": context_window,
        "max_history_chars": max_history_chars,
        "max_output_tokens": max_output_tokens,
    }


@router.get("/api/cloud/config")
def api_cloud_config():
    """获取云端配置（API Key 脱敏显示）"""
    from config import get as cfg_get
    from core.cloud_engine import CloudEngine

    raw_key = CloudEngine._decode_api_key(cfg_get("cloud_api_key", ""))
    masked_key = CloudEngine.mask_api_key(raw_key)

    cloud_model = cfg_get("cloud_model", "gpt-4o-mini")
    _ce = CloudEngine.__new__(CloudEngine)
    caps = _ce._lookup_capabilities(cloud_model)

    # 优先用用户手动配置的值，否则用模型默认值
    user_ctx = cfg_get("cloud_context_window", 0)
    context_window = user_ctx if user_ctx and user_ctx > 0 else caps["context_window"]

    return {
        "base_url": cfg_get("cloud_base_url", "https://api.openai.com/v1"),
        "api_key_set": bool(raw_key),
        "api_key_preview": masked_key,
        "model": cloud_model,
        "context_window": context_window,
        "context_window_user": user_ctx,
        "max_output_tokens": caps["max_output"],
        "context_policy": cfg_get("cloud_context_policy", "full"),
        "slim_history_rounds": cfg_get("cloud_slim_history_rounds", 6),
        "kb_permission": cfg_get("kb_permission", "full"),
        "kb_compare_enabled": cfg_get("kb_compare_enabled", False),
        "kb_compare_privacy_read": cfg_get("kb_compare_privacy_read", False),
    }


@router.post("/api/cloud/config")
async def api_cloud_config_save(request: Request):
    """保存云端配置（API Key base64 编码存储）"""
    body = await request.json()
    from config import save_config
    from core.cloud_engine import CloudEngine

    updates = {}

    if "base_url" in body:
        url = body["base_url"].strip()
        if not url:
            return JSONResponse({"error": "API 地址不能为空"}, status_code=400)
        updates["cloud_base_url"] = url

    if "api_key" in body:
        raw_key = body["api_key"].strip()
        if raw_key:
            updates["cloud_api_key"] = CloudEngine._encode_api_key(raw_key)
        # Patch4 v3.1 BUG#31：api_key 为空时不主动清空（保留原 key）
        # 只有显式传 clear_api_key=true 才清空（避免误覆盖）
        # 之前的 else: updates["cloud_api_key"] = "" 是 key 莫名失效的根因
        elif body.get("clear_api_key") is True:
            updates["cloud_api_key"] = ""

    if "model" in body:
        updates["cloud_model"] = body["model"].strip()

    if "context_window" in body:
        # 兼容旧前端：忽略手动配置，始终使用字典自动值
        pass

    # 模型变更时重置手动上下文窗口为 0（自动模式）
    if "model" in body:
        updates["cloud_context_window"] = 0

    if "context_policy" in body:
        policy = body["context_policy"]
        if policy not in ("full", "current_only", "slim_history"):
            return JSONResponse({"error": "无效的 context_policy"}, status_code=400)
        updates["cloud_context_policy"] = policy

    if "slim_history_rounds" in body:
        try:
            rounds = int(body["slim_history_rounds"])
            if rounds < 1 or rounds > 50:
                raise ValueError
            updates["cloud_slim_history_rounds"] = rounds
        except (ValueError, TypeError):
            return JSONResponse({"error": "slim_history_rounds 必须为 1-50 的整数"}, status_code=400)

    if "kb_permission" in body:
        perm = body["kb_permission"]
        if perm not in ("full", "search-only", "disabled"):
            return JSONResponse({"error": "无效的 kb_permission"}, status_code=400)
        updates["kb_permission"] = perm

    # Patch3: 云端AI知识对比
    if "kb_compare_enabled" in body:
        updates["kb_compare_enabled"] = bool(body["kb_compare_enabled"])

    if "kb_compare_privacy_read" in body:
        updates["kb_compare_privacy_read"] = bool(body["kb_compare_privacy_read"])

    if not updates:
        return JSONResponse({"error": "无有效配置项"}, status_code=400)

    ok = save_config(updates)
    if ok:
        log.info("[CLOUD] 云端配置已更新: %s", list(updates.keys()))

    # 配置变更后清除缓存的 client，下次请求会使用新配置重建
    mgr = get_mgr()
    if hasattr(mgr, '_cloud_engine') and mgr._cloud_engine:
        mgr._cloud_engine._client = None

    # 返回更新后的模型能力信息（优先用用户配置的上下文窗口）
    from config import get as _cfg_save
    cloud_model = updates.get("cloud_model", _cfg_save("cloud_model", "gpt-4o-mini"))
    _ce = CloudEngine.__new__(CloudEngine)
    caps = _ce._lookup_capabilities(cloud_model)
    user_ctx = _cfg_save("cloud_context_window", 0)
    effective_ctx = user_ctx if user_ctx and user_ctx > 0 else caps["context_window"]
    return {"ok": ok, "context_window": effective_ctx, "max_output_tokens": caps["max_output"]}


@router.get("/api/cloud/model-capabilities")
def api_cloud_model_capabilities(model: str = ""):
    """查询模型能力（从字典自动获取，用于前端实时预览）"""
    model = model.strip()
    if not model:
        return {"error": "model 参数为空"}
    from core.cloud_engine import CloudEngine
    _ce = CloudEngine.__new__(CloudEngine)
    caps = _ce._lookup_capabilities(model)
    return {
        "model": model,
        "context_window": caps["context_window"],
        "max_output": caps["max_output"],
    }


@router.post("/api/cloud/test")
async def api_cloud_test(request: Request):
    """测试云端连接（支持传入未保存的表单值）"""
    try:
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass  # 无 body 时使用已保存的配置

        from core.cloud_engine import CloudEngine
        engine = CloudEngine(get_mgr())

        # 优先用表单传入的临时值（用户还没保存时也能测试）
        ok, latency_ms, error = engine.test_connection(
            _temp_api_key=body.get("api_key", ""),
            _temp_base_url=body.get("base_url", ""),
            _temp_model=body.get("model", ""),
        )
        from config import get as _cfg_test
        cloud_model = body.get("model") or _cfg_test("cloud_model", "gpt-4o-mini")
        return {
            "ok": ok,
            "model": cloud_model,
            "latency_ms": latency_ms,
            "error": error,
        }
    except ImportError:
        return JSONResponse({
            "ok": False,
            "latency_ms": 0,
            "error": "openai 包未安装，请运行 pip install openai>=1.30",
        }, status_code=400)
    except Exception as e:
        return JSONResponse({
            "ok": False,
            "latency_ms": 0,
            "error": str(e)[:200],
        }, status_code=500)
