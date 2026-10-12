# -*- coding: utf-8 -*-
"""rc.5 重出包 · 行为批（#70/#71/#72/#77）先红后绿——main 上全部必红。

#70 (P0) 过滤器误杀：markdown 列表结构（\n*  等高频 4-gram）被当前缀累积
      重复 → 整篇 1764 字被替换成最后一句 17 字（PM 沙盒实测，最小复现
      984→31 字）。修法：结构白名单 + 累积链证据护栏；真累积不受影响。
#71 (P1) 懒启动零反馈：LlamaCppManager.stop() 在 _do_stop() 之后才读
      ownership（已被 finally 清成 None）→ 真停止也返回 not_running →
      IDLE-UNLOAD 巡检走「不清理加载标记」分支 → _loaded 陈旧 → 下一条
      离线消息跳过懒加载分支（无 mode_hint、直打死引擎）。
#72 (P0) 策略误路由："帮我写一篇防诈骗指南"命中 _CODE_PHRASES 且无创作
      词 → code 档注入编程 persona。修法：文档名词信号排除 code 道。
#77 (P0) 看门狗误杀：看门狗/面板轮询重 IO 的 /api/status（llama HTTP×2
      + registry 全盘扫描，同步端点抢 4 worker 线程池）→ 生成期线程池
      饥饿 → 2×30s 超时硬杀 Python、该轮生成全丢。修法：零 IO 的
      /api/health（async）供看门狗/面板；status() 探测加 TTL 缓存。
"""
import os
import sys

import pytest
import unittest

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)


# ============================== #70 过滤器误杀 ==============================

def _pm_list_text(n=24):
    """PM 案例同构：markdown 无序列表，每条内容互不相同（合法长答案）"""
    tips = [
        "接到自称公检法要求转账的电话，先挂断再拨打官方号码核实",
        "收到中奖信息要先交手续费的，一律按诈骗处理",
        "冒充熟人借钱的，务必回拨本人常用号码确认",
        "网络刷单返利本身就是违法行为，别碰",
        "高收益理财稳赚不赔的说法都是骗局的开始",
        "客服主动来电要求退款操作的多半是假冒",
        "不明链接和二维码不要点，输入卡号就晚了",
        "保健品免费体验讲座专门针对老年人设局",
        "网恋对象带着投资的多是杀猪盘剧本",
        "快递丢失主动理赔的要先去官方渠道查证",
        "公检法机关不会通过电话视频办案转账",
        "遇到拿不准的事，先给家人打个电话商量",
    ]
    parts = ["防诈骗沟通指南要点："]
    for i in range(n):
        parts.append("\n*  %s。" % tips[i % len(tips)])
    return "".join(parts)


def _true_accumulation_text():
    """真前缀累积（Qwen 病态模式1）：句子逐条扩展前一条"""
    parts = ["我可以", "我可以协助", "我可以协助处理", "我可以协助处理文档",
             "我可以协助处理文档编辑", "我可以协助处理文档编辑、数据整理",
             "我可以协助处理文档编辑、数据整理与分析",
             "我可以协助处理文档编辑、数据整理与分析等工作",
             "我可以协助处理文档编辑、数据整理与分析等高价值工作",
             "我可以协助处理文档编辑、数据整理与分析等高价值日常办公工作"]
    return "。".join(parts) + "。"


class TestFilterMarkdownWhitelist(unittest.TestCase):
    def test_list_structure_not_detected(self):
        from intelligence.response_filter import detect_prefix_accumulation
        detected, _ = detect_prefix_accumulation(_pm_list_text())
        assert detected is False, "markdown 列表结构不应被判为前缀累积（#70 误杀根因）"

    def test_list_text_clean_unchanged(self):
        from intelligence.response_filter import clean_prefix_accumulation
        t = _pm_list_text()
        out = clean_prefix_accumulation(t)
        assert out == t[:2000], "合法列表文本清理后必须原样保留"

    def test_structure_4gram_whitelisted(self):
        from intelligence.response_filter import _is_markdown_structure_4gram
        for g in ("\n*  ", "\n- ", "\n1. ", "\n## ", "\n> ", "\n| ", "\n**"):
            assert _is_markdown_structure_4gram(g), g
        assert not _is_markdown_structure_4gram("我是办公")
        assert not _is_markdown_structure_4gram("the ")


class TestFilterTruePositiveKept(unittest.TestCase):
    def test_accumulation_still_detected(self):
        from intelligence.response_filter import detect_prefix_accumulation
        detected, _ = detect_prefix_accumulation(_true_accumulation_text())
        assert detected is True, "真前缀累积仍须被检出（护栏不能杀真阳性）"

    def test_accumulation_cleaned_to_last_sentence(self):
        from intelligence.response_filter import clean_prefix_accumulation
        out = clean_prefix_accumulation(_true_accumulation_text())
        assert "高价值日常办公工作" in out and len(out) < len(_true_accumulation_text())


# ============================== #71 stop() 返回值 ==============================

class _FakeProc:
    def terminate(self): pass
    def wait(self, timeout=None): pass
    def kill(self): pass


class TestLlamaStopOwnership(unittest.TestCase):
    def test_managed_stop_reports_stopped(self):
        from core.llamacpp_backend.manager import LlamaCppManager
        m = LlamaCppManager.__new__(LlamaCppManager)
        m._watchdog_stop = __import__("threading").Event()
        m._ownership = "MANAGED"
        m._process = _FakeProc()
        m._running = True
        m._current_model = "qwen"
        r = m.stop()
        assert r.get("status") == "stopped", "真停止必须返回 stopped（IDLE-UNLOAD 据此清 _loaded）"
        assert m._process is None and m._running is False

    def test_external_stop_not_managed(self):
        from core.llamacpp_backend.manager import LlamaCppManager
        m = LlamaCppManager.__new__(LlamaCppManager)
        m._watchdog_stop = __import__("threading").Event()
        m._ownership = "EXTERNAL"
        m._process = None
        r = m.stop()
        assert r.get("status") == "external_not_managed"


# ============================== #72 策略误路由 ==============================

class TestClassifierDocSignal(unittest.TestCase):
    def test_doc_request_not_code(self):
        from intelligence.task_classifier import resolve_strategy
        assert resolve_strategy("帮我写一篇防诈骗指南")["type"] != "code"

    def test_doc_plan_not_code(self):
        from intelligence.task_classifier import resolve_strategy
        assert resolve_strategy("帮我写一份数字化应用方案")["type"] != "code"

    def test_code_request_still_code(self):
        from intelligence.task_classifier import resolve_strategy
        assert resolve_strategy("帮我写一个Python爬虫脚本")["type"] == "code"
        assert resolve_strategy("写个函数实现快速排序")["type"] == "code"

    def test_creative_still_creative(self):
        from intelligence.task_classifier import resolve_strategy
        assert resolve_strategy("帮我写一个科幻故事")["type"] == "creative"


# ============================== D33 静默截断（总调度评审 #34） ==============================

def _long_unique_list_text():
    """总调度复现规格：60 条互不重复的列表文本，总长 > 2000 字（目标 ~2800）"""
    subjects = ["陌生来电", "中奖短信", "可疑链接", "来路不明二维码", "冒充客服",
                "退款操作", "高息投资", "刷单返利", "注销贷款", "征信洗白"]
    actions = ["挂断后拨打官方电话核实", "直接删除不要点开", "和家人核对后再处理",
               "去营业厅当面确认", "在官方应用内查询", "拨打96110反诈专线咨询",
               "不予理会并加入黑名单", "保存证据后报警"]
    cautions = ["绝不透露验证码", "绝不向陌生账户转账", "绝不共享手机屏幕",
                "绝不点击陌生链接", "绝不透露银行卡号", "绝不在电话里当场做决定"]
    parts = ["老年人防诈骗要点汇总（六十条）："]
    n = 0
    for s in subjects:
        for a in actions:
            if n >= 60:
                break
            parts.append("\n*  第%d条：遇到%s类情况，正确做法是%s，切记%s。\n"
                         % (n + 1, s, a, cautions[n % len(cautions)]))
            n += 1
    parts.append("以上要点请转告家中老人，反复演练；如遇诈骗请立即拨打96110报警求助。\n")
    return "".join(parts)


class TestD33SilentTruncation:
    """总调度 D33：>2000 字的合法回答被 clean 的「不处理」分支静默截成 2000 字"""

    def test_long_unique_text_passes_filter_intact(self):
        from intelligence.response_filter import filter_response
        t = _long_unique_list_text()
        assert len(t) > 2000, "测试样本必须超过 2000 字（当前 %d）" % len(t)
        out = filter_response(t)
        assert out["cleaned"] == t, "无重复长文必须原样通过（D33：静默截断）"

    def test_pm_repro_passes_filter_intact(self):
        from intelligence.response_filter import filter_response
        out = filter_response(_pm_list_text())
        assert out["cleaned"] == _pm_list_text()

    def test_true_accumulation_still_cleaned_via_filter(self):
        from intelligence.response_filter import filter_response
        out = filter_response(_true_accumulation_text())
        assert "高价值日常办公工作" in out["cleaned"]
        assert len(out["cleaned"]) < len(_true_accumulation_text())

    def test_clean_noop_branches_return_full_text(self):
        """clean 的所有「不处理」分支原样返回（含 >2000 字场景）"""
        from intelligence.response_filter import clean_prefix_accumulation
        t = _long_unique_list_text()
        assert clean_prefix_accumulation(t) == t


# ============================== #81 加固：三开关服务端强制 False ==============================

class TestFeatureFlagsForcedOff:
    """总调度决定：记忆/存为技能/标为私密在服务端一律视为关，不读配置"""

    def test_get_forces_false_even_if_config_true(self, tmp_path, monkeypatch):
        import config as _cfgmod
        fake = tmp_path / "settings.json"
        fake.write_text('{"feature_memory": true, "feature_distill_skill": true,'
                        ' "feature_mark_private": true}', encoding="utf-8")
        monkeypatch.setattr(_cfgmod, "_CONFIG_FILE", str(fake))
        monkeypatch.setattr(_cfgmod, "_config_cache", _cfgmod.load_config())  # 缓存在 import 时已建，须重建
        # （红阶段已验证：无强制时该配置读出 True，用例不空转）
        assert _cfgmod._config_cache.get("feature_memory") is True, "缓存重建必须吃到 true"
        for k in ("feature_memory", "feature_distill_skill", "feature_mark_private"):
            assert _cfgmod.get(k, False) is False, "%s 必须强制 False" % k

    def test_memory_card_prompt_suppressed(self, tmp_path, monkeypatch):
        import config as _cfgmod
        fake = tmp_path / "settings.json"
        fake.write_text('{"feature_memory": true}', encoding="utf-8")
        monkeypatch.setattr(_cfgmod, "_CONFIG_FILE", str(fake))
        monkeypatch.setattr(_cfgmod, "_config_cache", _cfgmod.load_config())
        assert _cfgmod._config_cache.get("feature_memory") is True, "缓存重建必须吃到 true"
        from prompts import card_protocol_prompt, CARD_PROTOCOL_PROMPT
        assert card_protocol_prompt() == CARD_PROTOCOL_PROMPT, \
            "feature_memory=True 配置下记忆卡协议段也必须被抑制（强制 False）"


# ============================== #77 看门狗健康端点 ==============================

_LAUNCHER = os.path.join(os.path.dirname(_SERVER_DIR), "launcher")


def _go(name):
    with open(os.path.join(_LAUNCHER, name), "r", encoding="utf-8") as f:
        return f.read()


class TestWatchdogHealthEndpoint(unittest.TestCase):
    def test_health_endpoint_exists_async_zero_io(self):
        src = open(os.path.join(_SERVER_DIR, "routers", "settings_system.py"),
                   encoding="utf-8").read()
        assert '"/api/health"' in src
        assert "async def api_health" in src, "必须 async（事件循环直出，免疫线程池饥饿）"
        # 版本号必须从 config 取：import server 模块带进程级看门狗副作用，
        # 非 --serve 环境（测试/工具）导入即 sys.exit —— 功能实测曾踩中
        self.assertIn("from config import __version__", src)

    def test_health_endpoint_functional(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        from routers.settings_system import router
        app = FastAPI()
        app.include_router(router)
        r = TestClient(app).get("/api/health")
        assert r.status_code == 200
        body = r.json()
        assert body.get("ok") is True and body.get("version")

    def test_watchdog_uses_health_not_status(self):
        src = _go("watchdog.go")
        assert "/api/health" in src
        assert 'pythonURL := fmt.Sprintf("http://127.0.0.1:%d/api/status"' not in src

    def test_panel_uses_health_not_status(self):
        src = _go("panel_windows.go")
        assert "/api/health" in src
        assert "/api/status" not in src, "面板 2s 轮询也不应打重 IO 端点"

    def test_startup_ready_poll_keeps_status(self):
        src = _go("main.go")
        assert "/api/status" in src, "启动 ready 轮询仍需 /api/status 的 ready 字段"

    def test_status_probe_cached(self):
        src = open(os.path.join(_SERVER_DIR, "core", "model_manager.py"),
                   encoding="utf-8").read()
        assert "_llm_probe_cache" in src, "status() 的 llama 探测需 TTL 缓存（#77 生成期减负）"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
