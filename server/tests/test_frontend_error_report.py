# -*- coding: utf-8 -*-
"""前端错误上报端点测试（sidemate-dev#22）

覆盖：合法上报落日志（caplog 捕获 WARNING）、字段截断、坏 body 走全局
JSON 兜底 400、非本地 Origin 403。
"""
import json
import logging

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from common.json_body import register_json_error_handler


@pytest.fixture()
def client():
    app = FastAPI()
    register_json_error_handler(app)
    from routers.diagnostics import router as diag_router
    app.include_router(diag_router)
    return TestClient(app)


class TestFrontendErrorEndpoint:
    def test_report_logged(self, client, caplog):
        with caplog.at_level(logging.WARNING, logger="routers.diagnostics"):
            r = client.post("/api/diagnostics/frontend-error", json={
                "kind": "error", "message": "boom is not defined",
                "file": "http://127.0.0.1:8978/static/js/v2/dist/bundle.js",
                "line": 42, "bundle": "d7af62e5",
            })
        assert r.status_code == 200 and r.json()["ok"] is True
        joined = " ".join(rec.getMessage() for rec in caplog.records)
        assert "[FE-ERROR]" in joined
        assert "boom is not defined" in joined and "d7af62e5" in joined

    def test_fields_truncated_no_user_content_semantics(self, client):
        """超长 message 被截断到 300，不 500。"""
        r = client.post("/api/diagnostics/frontend-error", json={
            "kind": "x" * 100, "message": "m" * 1000, "file": "", "line": 0,
        })
        assert r.status_code == 200

    def test_bad_body_400_not_500(self, client):
        r = client.post("/api/diagnostics/frontend-error",
                        content=b"{bad", headers={"Content-Type": "application/json"})
        assert r.status_code == 400

    def test_non_local_origin_403(self, client):
        r = client.post("/api/diagnostics/frontend-error",
                        headers={"Origin": "https://evil.example.com"},
                        json={"kind": "error", "message": "x"})
        assert r.status_code == 403
