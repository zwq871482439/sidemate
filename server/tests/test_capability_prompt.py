# -*- coding: utf-8 -*-
"""M2-1a 能力注册表拼装测试（core/agent_tools.get_tools_and_prompt）

覆盖：
- cards fragment（卡片协议）在线 agent 路径恒注入
- create_ppt 启用 → ppt fragment 自动进 prompt；权限禁用 → 自动退出
- fragment 不重复注入（拼装去重）
- 启用工具清单与 fragment 一致（create_ppt schema 与权限档联动）

注意：config.get 用 monkeypatch 控制工具权限档，不碰真实配置。
"""
import core.agent_tools as at


def _prompt(monkeypatch, file_rw=True):
    import config as _cfg
    monkeypatch.setattr(_cfg, "get", lambda k, d=None: False if (k == "tool_enabled_file_rw" and not file_rw) else d)
    tools, prompt = at.get_tools_and_prompt(mode="chat", kb=None, chat_id=None)
    return tools, prompt


class TestCapabilityAssembly:
    def test_cards_fragment_always_on(self, monkeypatch):
        _, prompt = _prompt(monkeypatch)
        assert "可视化卡片" in prompt  # CARD_PROTOCOL_PROMPT 在场

    def test_ppt_fragment_follows_tool(self, monkeypatch):
        tools, prompt = _prompt(monkeypatch, file_rw=True)
        names = [t["function"]["name"] for t in tools]
        assert "create_ppt" in names
        assert "真 PPT 制作" in prompt  # PPT_PROTOCOL_PROMPT 随启用进 prompt

    def test_ppt_fragment_exits_when_disabled(self, monkeypatch):
        tools, prompt = _prompt(monkeypatch, file_rw=False)
        names = [t["function"]["name"] for t in tools]
        assert "create_ppt" not in names  # 权限档关掉，工具本身也下线
        assert "真 PPT 制作" not in prompt  # fragment 同步退出（手工 append 时代做不到）

    def test_fragments_not_duplicated(self, monkeypatch):
        _, prompt = _prompt(monkeypatch)
        assert prompt.count("可视化卡片") == 1
        assert prompt.count("真 PPT 制作") == 1

    def test_fragment_loader_keys_resolvable(self):
        """注册表里挂的 prompt_fragment 都必须有对应 loader（防挂空）。"""
        for name, tool_def in at.TOOL_REGISTRY.items():
            key = tool_def.get("prompt_fragment")
            if key:
                assert key in at._FRAGMENT_LOADERS, "%s 的 fragment %s 无 loader" % (name, key)
                assert callable(at._FRAGMENT_LOADERS[key])
