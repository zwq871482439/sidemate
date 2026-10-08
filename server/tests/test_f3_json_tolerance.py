# -*- coding: utf-8 -*-
"""F3 及同类端点的 JSON 容错测试（sidemate-dev#6，先红后绿）

覆盖：
- 全局兜底机制（common.json_body.register_json_error_handler）：
  裸 request.json() 的端点收到坏 JSON / 空 body → 400 + 可读错误，不再 500
- 真实路由挂载后按 router 抽样：chats/switch（#3 发现的同款 500）、
  cloud v2 providers、kb 文档删除等用户入口坏 body → 400
- 下载取消（F3 本体）：空 body / {} → 取消全部运行中任务（200 + cancelled 列表）；
  未知 task_id → 404；有效 task_id → 取消成功
"""
import json

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from common.json_body import register_json_error_handler


def _mini_app():
    """最小应用：注册全局兜底 + 一个裸 request.json() 的端点（生产代码同款写法）。"""
    app = FastAPI()
    register_json_error_handler(app)

    @app.post("/bare")
    async def bare(request: Request):
        body = await request.json()
        return {"got": body}

    return app


def _routers_app():
    """真实路由挂载 + 全局兜底（与 server.py 的注册方式一致）。"""
    app = FastAPI()
    register_json_error_handler(app)
    from routers.chat import router as chat_router
    from routers.settings_cloud import router as cloud_router
    app.include_router(chat_router)
    app.include_router(cloud_router)
    return app


class TestGlobalJsonErrorHandler:
    """红点：修复前（无兜底）坏 JSON / 空 body 直接 500。"""

    def test_server_py_registers_handler(self):
        """护栏：server.py 必须注册全局兜底（机制测试自注册不覆盖真实装配）。"""
        import os
        src = open(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "server.py"), encoding="utf-8").read()
        assert "register_json_error_handler(app)" in src, "server.py 缺少全局 JSON 兜底注册"

    def test_bad_json_returns_400(self):
        c = TestClient(_mini_app())
        r = c.post("/bare", content=b"{not json", headers={"Content-Type": "application/json"})
        assert r.status_code == 400, f"坏 JSON 应回 400，实际 {r.status_code}"
        assert "JSON" in r.json()["error"]

    def test_empty_body_returns_400(self):
        c = TestClient(_mini_app())
        r = c.post("/bare", content=b"", headers={"Content-Type": "application/json"})
        assert r.status_code == 400

    def test_valid_json_passes_through(self):
        c = TestClient(_mini_app())
        r = c.post("/bare", json={"a": 1})
        assert r.status_code == 200 and r.json() == {"got": {"a": 1}}


class TestRealRoutersBadBody:
    """抽样真实用户入口：坏 body 不得 500（全局兜底覆盖所有裸调用点）。"""

    @pytest.fixture()
    def client(self):
        return TestClient(_routers_app())

    def test_chats_switch_bad_body(self, client):
        # sidemate-dev#3 实锤：/api/chats/switch 坏 JSON 曾 500
        r = client.post("/api/chats/switch", content=b"{bad",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400, f"chats/switch 坏 body 实际 {r.status_code}"

    def test_chats_switch_empty_body(self, client):
        r = client.post("/api/chats/switch", content=b"",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400  # 兜底 400（而不是 500）；缺 path 的业务 400 另算

    def test_cloud_v2_providers_bad_body(self, client):
        r = client.post("/api/cloud/v2/providers", content=b"{bad",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400

    def test_cloud_v2_select_bad_body(self, client):
        r = client.post("/api/cloud/v2/select", content=b"[1,2",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 400


class TestDownloadCancel:
    """F3 本体：空 body = 取消全部；带 task_id = 原语义。"""

    @pytest.fixture()
    def client(self):
        app = FastAPI()
        register_json_error_handler(app)
        from routers.download import router as dl_router
        app.include_router(dl_router)
        return TestClient(app)

    @staticmethod
    def _inject(task_id, status="running"):
        from core import download_engine as de
        t = de.DownloadTask(task_id, "llm", "测试任务")
        t.status = status
        with de._tasks_lock:
            de._tasks[task_id] = t
        return t

    @staticmethod
    def _clear():
        from core import download_engine as de
        with de._tasks_lock:
            de._tasks.clear()

    def setup_method(self):
        self._clear()

    def teardown_method(self):
        self._clear()

    def test_empty_body_cancels_all(self, client):
        """红点：空 body（前端取消按钮的真实形态）此前 500。"""
        t1 = self._inject("tk-1")
        t2 = self._inject("tk-2", status="pending")
        self._inject("tk-done", status="done")  # 已结束的不动
        r = client.post("/api/models/download/cancel", content=b"",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 200, f"空 body 实际 {r.status_code}"
        assert r.json()["ok"] is True
        assert sorted(r.json()["cancelled"]) == ["tk-1", "tk-2"]
        assert t1.status == "cancelled" and t2.status == "cancelled"
        assert not client.post("/api/models/download/cancel",
                               content=b"").json()["cancelled"], "重复取消不应再返回已结束任务"

    def test_empty_object_cancels_all(self, client):
        self._inject("tk-3")
        r = client.post("/api/models/download/cancel", json={})
        assert r.status_code == 200
        assert r.json()["cancelled"] == ["tk-3"]

    def test_bad_json_still_cancels_all(self, client):
        self._inject("tk-4")
        r = client.post("/api/models/download/cancel", content=b"{bad",
                        headers={"Content-Type": "application/json"})
        assert r.status_code == 200, "取消端点坏 JSON 不应卡住取消动作"
        assert r.json()["cancelled"] == ["tk-4"]

    def test_unknown_task_id_404(self, client):
        r = client.post("/api/models/download/cancel", json={"task_id": "no-such"})
        assert r.status_code == 404

    def test_valid_task_id_cancelled(self, client):
        t = self._inject("tk-5")
        r = client.post("/api/models/download/cancel", json={"task_id": "tk-5"})
        assert r.status_code == 200
        assert r.json() == {"ok": True, "cancelled": ["tk-5"]}
        assert t.status == "cancelled"
        ev = t.queue.get_nowait()
        assert ev["cancelled"] is True and ev["done"] is True
