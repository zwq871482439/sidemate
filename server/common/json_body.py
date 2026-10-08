# -*- coding: utf-8 -*-
"""请求体 JSON 容错（0.11.1 F3 扩面，sidemate-dev#6）。

背景：routers 里有 ~60 处裸 ``body = await request.json()``——空 body 或坏
JSON 会抛 ``json.JSONDecodeError`` 直接 500。前端真有空 body 调用（模型下载
取消按钮），其余端点也可能被脚本/旧前端撞上。

做法：全局异常处理器统一兜底（坏/空 JSON → 400 + 可读错误），调用点零改动。
需要空 body 特殊语义的端点（如下载取消 = 取消全部）自行用 ``request.body()``
解析，不走此兜底。非 dict 的合法 JSON（如数组）在各端点的 ``body.get`` 处
仍会 AttributeError，属另一类问题，不在本兜底范围。
"""
import json

from fastapi.responses import JSONResponse


def register_json_error_handler(app) -> None:
    """把 request.json() 的解码错误统一转成 400（而不是 500）。"""

    @app.exception_handler(json.JSONDecodeError)
    async def _json_decode_error(request, exc):
        return JSONResponse({"error": "请求体不是合法 JSON（可能为空 body）"}, status_code=400)
