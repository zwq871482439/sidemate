# -*- coding: utf-8 -*-
"""F7：环境诊断 llama-server 查找序测试（sidemate-dev#8，先红后绿）

三种情况：lib 下存在；lib 下不存在但 PATH 里有；都没有（ok=False + 明确文案）。
"""
import os

import pytest

import routers.settings_system as ss


@pytest.fixture()
def isolated_env(monkeypatch, tmp_path):
    """ROOT_DIR 指到临时目录（lib 不存在）；shutil.which 默认无命中。"""
    import config
    import shutil
    monkeypatch.setattr(config, "ROOT_DIR", str(tmp_path))
    monkeypatch.setattr(shutil, "which", lambda name: None)
    return tmp_path


class TestDiagnoseLlamaServer:
    def test_lib_hit(self, isolated_env, monkeypatch):
        lib = isolated_env / "lib" / "ollama"
        lib.mkdir(parents=True)
        exe = lib / "llama-server.exe"
        exe.write_bytes(b"x")
        r = ss._diagnose_llama_server()
        assert r["ok"] is True
        assert os.path.normcase(r["path"]) == os.path.normcase(str(exe))
        assert "note" not in r

    def test_path_fallback_when_lib_missing(self, isolated_env, monkeypatch):
        """红点：修复前只查 lib 固定路径，PATH 里的 llama-server 被误报失败。"""
        import shutil
        fake = str(isolated_env / "bin" / "llama-server.exe")
        monkeypatch.setattr(shutil, "which", lambda name: fake if name == "llama-server" else None)
        os.makedirs(os.path.dirname(fake), exist_ok=True)
        open(fake, "wb").write(b"x")
        r = ss._diagnose_llama_server()
        assert r["ok"] is True, "PATH 里能找到就不应误报失败"
        assert os.path.normcase(r["path"]) == os.path.normcase(fake)

    def test_all_missing_gives_clear_note(self, isolated_env):
        r = ss._diagnose_llama_server()
        assert r["ok"] is False
        assert "未找到" in r.get("note", ""), "都找不到时应给明确文案"
        assert r["path"], "仍应回显候选路径供用户对照"
