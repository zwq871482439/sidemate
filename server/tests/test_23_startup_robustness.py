# -*- coding: utf-8 -*-
"""#23：启动健壮性四件套的回归护栏。

- resolve_site_packages：Windows 嵌入式布局优先（逐字不变）/ sysconfig
  回退（Linux venv）/ 双无回退嵌入式路径
- 全局 JSON 处理器：服务端内部读坏磁盘 JSON 也走同一处理器 → 400 +
  日志有路径与 traceback（文案中性，不咬定是请求体问题）
- ppt_master 两处 subprocess 的解码兜底（errors=replace）源码级护栏
- server.py 非法转义 \"\/\" 清除的源码级护栏
"""
import json
import logging
import os
import sys

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from common.json_body import register_json_error_handler


class TestResolveSitePackages:
    def test_embedded_layout_wins(self, tmp_path):
        from core.deps_check import resolve_site_packages
        embedded = tmp_path / "Lib" / "site-packages"
        embedded.mkdir(parents=True)
        assert resolve_site_packages(str(tmp_path)) == str(embedded)

    def test_venv_fallback_when_embedded_absent(self, tmp_path, monkeypatch):
        from core import deps_check
        purelib = tmp_path / "venv-lib"
        purelib.mkdir()
        monkeypatch.setattr("sysconfig.get_paths", lambda: {"purelib": str(purelib)})
        assert deps_check.resolve_site_packages(str(tmp_path / "nope")) == str(purelib)

    def test_neither_returns_embedded_path(self, tmp_path, monkeypatch):
        from core import deps_check
        monkeypatch.setattr("sysconfig.get_paths", lambda: {"purelib": str(tmp_path / "no-lib")})
        got = deps_check.resolve_site_packages(str(tmp_path))
        assert got.endswith(os.path.join("Lib", "site-packages"))

    def test_real_runtime_embedded_layout_unchanged(self):
        """验收要求：Windows 嵌入式布局取到的路径不变（rt 嵌入式 python 实测）。"""
        from core.deps_check import resolve_site_packages
        got = resolve_site_packages(os.path.dirname(sys.executable))
        assert got == os.path.join(os.path.dirname(sys.executable), "Lib", "site-packages")


class TestJsonHandlerLogging:
    def _app(self, broken_file):
        app = FastAPI()
        register_json_error_handler(app)

        @app.post("/read-disk-json")
        async def read_disk(request: Request):
            # 模拟服务端读坏掉的磁盘 JSON（meta/settings）——与请求体无关
            return {"data": json.loads(open(broken_file, encoding="utf-8").read())}

        return app

    def test_internal_json_error_logged_with_traceback(self, tmp_path, caplog):
        broken = tmp_path / "meta.json"
        broken.write_text("{broken", encoding="utf-8")
        client = TestClient(self._app(str(broken)))
        with caplog.at_level(logging.WARNING):
            r = client.post("/read-disk-json", json={"x": 1})
        assert r.status_code == 400, "内部 JSONDecodeError 也应被处理器接住（400 不 500）"
        assert "JSON 解析失败" in r.json()["error"]
        recs = [x for x in caplog.records if "解码失败" in x.getMessage()]
        assert recs, "处理器必须落日志"
        assert "read-disk-json" in recs[0].getMessage(), "日志要带请求路径"
        assert recs[0].exc_info, "日志要带 traceback（区分请求体 vs 磁盘 JSON）"

    def test_neutral_message_not_blaming_request(self, tmp_path):
        """文案中性：不能断言是请求体问题（可能是磁盘 JSON 坏了）。"""
        broken = tmp_path / "meta.json"
        broken.write_text("[", encoding="utf-8")
        client = TestClient(self._app(str(broken)))
        r = client.post("/read-disk-json", json={"x": 1})
        assert "请求体" not in r.json()["error"]


class TestSourceGuards:
    """源码级护栏（无法稳定复现 GBK 输出/启动解释器，用字节级断言钉住修复）。"""

    def test_ppt_subprocess_has_decode_fallback(self):
        base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                            "vendor", "ppt_master", "svg_to_pptx", "pptx_package")
        builder = open(os.path.join(base, "builder.py"), encoding="utf-8").read()
        narration = open(os.path.join(base, "narration.py"), encoding="utf-8").read()
        assert "errors='replace'" in builder, "icacls 调用必须 errors=replace（#23 GBK 读线程崩溃）"
        assert 'errors="replace"' in narration, "ffprobe 调用必须 errors=replace"

    def test_server_py_no_illegal_escape(self):
        src = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "server.py")
        content = open(src, encoding="utf-8").read()
        assert '"\\/"' not in content, "server.py 不得再出现非法转义 \\/（Py3.14 SyntaxWarning）"
