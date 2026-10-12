# -*- coding: utf-8 -*-
"""rc.6 真装门禁（#84）发现的三个缺陷修复——先红后绿。

- #84 (P0)：/api/load 返回 loaded 但引擎从未启动（mgr.load 是 Ollama 时代
  空壳，只翻标记不启 llama-server）——状态点恒灰直到首条消息；且陈旧标记
  吞 stream_engine 的 mode_hint。修法：load() 内 _boot_engine_async 后台
  拉起引擎（start 幂等）。
- D35：llama-server 端口配置被无视——launcher.json 的 ollama_port（经
  OLLAMA_PORT 环境变量注入）与 settings.json 的 ollama_port 双双不生效，
  OllamaManager 恒用 11434（实测沙盒配 11438 起 11434）。同机多实例引擎
  互相"收养"，真装门禁被邻实例（C 的 rc.5）代答。修法：config.resolve_
  ollama_port()（env > config > 11434），server.py 实例化时传入。
- D36：全新安装零会话直接发消息（API/脚本路径）→ chat_file=None → 收尾
  持久化 os.path(None) 抛 "expected str, bytes or os.PathLike object,
  not NoneType"（done 后 error 事件）。修法：两个入口（/api/chat 与
  /api/chat/stream）None 兜底自动落新会话。
"""
import os
import sys
import unittest

import pytest

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)


def _read(rel):
    with open(os.path.join(_SERVER_DIR, rel), "r", encoding="utf-8") as f:
        return f.read()


class TestLoadBootsEngine(unittest.TestCase):
    """#84：加载即拉起引擎"""

    def test_boot_helper_exists_and_called(self):
        src = _read(os.path.join("core", "model_manager.py"))
        self.assertIn("def _boot_engine_async", src)
        self.assertIn("self._boot_engine_async(matched_name)", src)

    def test_boot_calls_ollama_start(self):
        src = _read(os.path.join("core", "model_manager.py"))
        i = src.index("def _boot_engine_async")
        seg = src[i:i + 2200]
        self.assertIn("ollama_manager as _om", seg)
        self.assertIn("_om.start()", seg)
        self.assertIn("mark_model_loaded", seg)


class TestOllamaPortResolution:
    """D35：端口 env > config > 默认（pytest fixture 风格）"""

    def test_env_wins(self, monkeypatch):
        import config as _cfg
        monkeypatch.setenv("OLLAMA_PORT", "11438")
        assert _cfg.resolve_ollama_port() == 11438

    def test_config_fallback(self, monkeypatch, tmp_path):
        import config as _cfg
        monkeypatch.delenv("OLLAMA_PORT", raising=False)
        fake = tmp_path / "settings.json"
        fake.write_text('{"ollama_port": 11435}', encoding="utf-8")
        monkeypatch.setattr(_cfg, "_CONFIG_FILE", str(fake))
        monkeypatch.setattr(_cfg, "_config_cache", _cfg.load_config())
        assert _cfg.resolve_ollama_port() == 11435

    def test_default_when_unset(self, monkeypatch, tmp_path):
        import config as _cfg
        monkeypatch.delenv("OLLAMA_PORT", raising=False)
        fake = tmp_path / "settings.json"
        fake.write_text("{}", encoding="utf-8")
        monkeypatch.setattr(_cfg, "_CONFIG_FILE", str(fake))
        monkeypatch.setattr(_cfg, "_config_cache", _cfg.load_config())
        assert _cfg.resolve_ollama_port() == 11434

    def test_bad_env_ignored(self, monkeypatch):
        import config as _cfg
        monkeypatch.setenv("OLLAMA_PORT", "not-a-port")
        assert isinstance(_cfg.resolve_ollama_port(), int)

    def test_server_passes_port_to_manager(self):
        src = _read("server.py")
        assert "OllamaManager(port=resolve_ollama_port())" in src


class TestNoneChatFallback(unittest.TestCase):
    """D36：零会话直发不再 os.path(None) 崩溃"""

    def test_both_entries_have_fallback(self):
        src = _read(os.path.join("routers", "chat.py"))
        self.assertIn("_new_chat_file()", src)
        self.assertGreaterEqual(src.count("chat_file = _new_chat_file()"), 2)


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
