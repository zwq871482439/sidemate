# -*- coding: utf-8 -*-
"""
routers/skill.py -- Action 管理 Router

端点前缀:
  /api/action:
    GET    /api/action/list        -- 列出所有 Action（内置+扩展）
    DELETE /api/action/{action_id} -- 卸载扩展 Action
"""
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

router = APIRouter()
log = logging.getLogger("action")

# (Skill /api/skill/* 端点已在 Patch11 拆除，此文件保留为占位)


# ============================================================
# Action 管理（Patch11：能力 = Action 注册表）
# ============================================================

@router.get("/api/action/list")
def api_action_list():
    """列出所有可用 Action（内置 + 扩展安装的）"""
    from intelligence.action_registry import get_available_actions
    actions = get_available_actions()
    return {"actions": actions, "total": len(actions)}


@router.delete("/api/action/{action_id}")
def api_action_uninstall(action_id: str):
    """卸载扩展 Action（内置不可卸载）"""
    from intelligence.action_registry import unregister_action
    ok = unregister_action(action_id)
    if ok:
        return {"success": True, "message": "已卸载 Action: %s" % action_id}
    return JSONResponse({"error": "无法卸载（内置 Action 或不存在）"}, status_code=400)
