# -*- coding: utf-8 -*-
"""rc.5 记忆下线增量（#28 之上的协议文本层）——先红后绿，#28 的 main 上必红。

#28 已做：feature_memory 默认关 → 工具不注册、handler 拒绝、注入关、输出卡 strip。
本增量：记忆确认卡**协议文本**不再常驻 prompt——
1. CARD_PROTOCOL_PROMPT 常量不含记忆段（防其它消费方直接 import 常量带出）
2. card_protocol_prompt() 默认（feature_memory=False）不含记忆段
3. feature_memory=True 时记忆段恢复（0.12 重开路径完整）
4. 两个消费方（agent_tools _FRAGMENT_LOADERS / cloud_engine）都改走函数
"""
import pytest


def _set_feature_memory(monkeypatch, on):
    import config
    cache = dict(config._config_cache)
    cache["feature_memory"] = on
    monkeypatch.setattr(config, "_config_cache", cache)
    # rc.6 #81 强制关豁免：这些用例守 0.12 重开后仍需有效的机制
    # （prompt 拼接 / 工具注册接线），临时清空强制集让 flag 可开
    if on:
        monkeypatch.setattr(config, "_FORCED_OFF_KEYS", frozenset())


class TestProtocolTextTakedown:
    def test_constant_has_no_memory_section(self):
        from prompts import CARD_PROTOCOL_PROMPT
        assert "记忆确认卡" not in CARD_PROTOCOL_PROMPT
        assert "memory_save" not in CARD_PROTOCOL_PROMPT
        assert "同意写入" not in CARD_PROTOCOL_PROMPT
        # 卡片协议本体仍在
        assert "可视化卡片" in CARD_PROTOCOL_PROMPT

    def test_card_prompt_off_by_default(self):
        from prompts import card_protocol_prompt
        p = card_protocol_prompt()
        assert "可视化卡片" in p
        assert "记忆确认卡" not in p

    def test_card_prompt_restored_when_flag_on(self, monkeypatch):
        _set_feature_memory(monkeypatch, True)
        from prompts import card_protocol_prompt
        p = card_protocol_prompt()
        assert "记忆确认卡" in p
        assert '["同意写入", "不用记"]' in p

    def test_fragment_loader_uses_gate(self):
        import core.agent_tools as at
        src = at._FRAGMENT_LOADERS["cards"]()
        assert "可视化卡片" in src
        assert "记忆确认卡" not in src

    def test_cloud_engine_consumes_function(self):
        import inspect
        from core import cloud_engine as ce
        src = inspect.getsource(ce)
        assert "card_protocol_prompt" in src
        assert "from prompts import CARD_PROTOCOL_PROMPT" not in src

    def test_flag_off_tools_absent_and_flag_on_present(self, tmp_path, monkeypatch):
        """开关联动回归：flag 关 → 工具不注册（#28 行为不因本增量回退）。"""
        import core.agent_tools as at
        tools, _ = at.get_tools_and_prompt(mode="chat", chat_id=None)
        names = [t["function"]["name"] for t in tools]
        assert "save_memory" not in names and "recall_memory" not in names
        _set_feature_memory(monkeypatch, True)
        tools, _ = at.get_tools_and_prompt(mode="chat", chat_id=None)
        names = [t["function"]["name"] for t in tools]
        assert "save_memory" in names and "recall_memory" in names
