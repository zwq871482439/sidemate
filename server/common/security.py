# -*- coding: utf-8 -*-
"""
common/security.py — 本地源校验（防止第三方网页静默调用高危 API）

使用场景：
  在修改配置、删除数据、安装扩展、调用 pip 等高危端点中，
  校验请求是否来自 Sidemate 自己的前端页面。

注意：
  - 不是认证机制，而是 CORS 严格模式失效时的兜底。
  - 对正常本地调用（前端 fetch、后端内部调用）无影响。
"""

from fastapi import Request


_ALLOWED_ORIGINS = {
    "http://localhost:8976",
    "http://127.0.0.1:8976",
    "https://localhost:8976",
    "https://127.0.0.1:8976",
}


def check_local_origin(request: Request) -> bool:
    """校验请求来源是否为本地 Sidemate 前端。

    Returns:
        True: 允许（本地调用或 Origin 缺失）
        False: 拒绝（跨域/非法来源）
    """
    origin = (request.headers.get("origin") or "").strip().lower()
    # 无 Origin 头：通常是本地脚本、curl、后端内部调用，允许
    if not origin:
        return True
    # 允许本地 Sidemate 前端
    if origin in _ALLOWED_ORIGINS:
        return True
    # 其余来源拒绝
    return False


def local_origin_error() -> dict:
    """返回统一的非法来源错误响应。"""
    return {"error": "非法来源：该操作仅允许从 Sidemate 前端发起"}
