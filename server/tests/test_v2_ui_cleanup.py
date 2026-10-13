# -*- coding: utf-8 -*-
"""v2 设置页/空状态收口守卫（0.11.1 rc.5 重出包批次 · UI 项）

源码文本断言，防止回归。对应缺陷（sidemate-dev）：
- #73 侧栏状态点：无状态不渲染（去 idle 兜底），新消息绿点由 si-badge 承担
- #74 空状态卡片选中态：offline-card/hero-card/scene-card/poster-sub 支持 cur + picked
- #75 场景 tag pill 样式落地（composer 设计注释「金色浅底」规格）
- #79 经典版残留死链清零（settings/index/kb 不再引用 /classic.html）
- #81 记忆/存为技能/标为私密三个设置开关撤下（UI 层撤，config key 保留）
- #82 知识库引擎死控件（kbEngineSel/kbReranker）移除
- #83 模型下载页「使用」按钮（data-use-dl）移除，加载入口只在离线AI页
"""
import os
import unittest

_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_V2_DIR = os.path.join(_SERVER_DIR, "static", "js", "v2")


def _read(name):
    with open(os.path.join(_V2_DIR, name), "r", encoding="utf-8") as f:
        return f.read()


def _css():
    return _read("styles.css")


class TestSidebarDotNoIdleFallback(unittest.TestCase):
    """#73：会话无状态时不渲染状态点"""

    def test_sidebar_no_idle_dot(self):
        self.assertNotIn("si-st idle", _read("sidebar.js"))

    def test_index_poll_removes_dot_when_idle(self):
        src = _read("index.js")
        self.assertNotIn("(st || 'idle')", src)


class TestEmptyStateCardSelected(unittest.TestCase):
    """#74：空状态卡片有选中态"""

    def test_renders_cur_class_and_picked_badge(self):
        src = _read("empty_state.js")
        self.assertIn("currentScene", src)
        self.assertIn("cur", src)
        self.assertIn("picked", src)

    def test_css_has_selected_rules(self):
        css = _css()
        for sel in (".offline-card.cur", ".hero-card.cur", ".scene-card.cur",
                    ".poster-sub.cur", ".picked"):
            self.assertIn(sel, css)

    def test_index_passes_current_scene(self):
        self.assertIn("currentScene", _read("index.js"))


class TestSceneTagPill(unittest.TestCase):
    """#75：场景 tag pill 样式存在"""

    def test_css_defines_pill(self):
        css = _css()
        self.assertIn(".scene-tag {", css)
        self.assertIn(".scene-tag .x", css)


class TestClassicLinksPurged(unittest.TestCase):
    """#79：经典版（0.10.2 已退役）残留入口清零"""

    def test_no_classic_html_refs(self):
        for name in ("settings.js", "index.js", "kb.js"):
            self.assertNotIn("/classic.html", _read(name), name)

    def test_settings_no_classic_ui_copy(self):
        src = _read("settings.js")
        for gone in ("回经典版", "setGoClassic", "需要深色请用经典版", "经典版界面"):
            self.assertNotIn(gone, src)

    def test_kb_empty_state_points_to_v2_settings(self):
        src = _read("kb.js")
        self.assertNotIn("去经典版", src)
        self.assertNotIn("kbGoClassic", src)
        self.assertIn("onGoSettings", src)

    def test_kb_view_wired_to_settings_download(self):
        src = _read("index.js")
        self.assertIn("onGoSettings", src)
        self.assertIn("showSub", src)


class TestFeatureFlagSwitchesRemoved(unittest.TestCase):
    """#81：三开关 UI 撤下（config key 由后端守卫测试覆盖）"""

    def test_settings_no_flag_switches(self):
        src = _read("settings.js")
        for gone in ("cfMemory", "cfDistill", "cfPrivate"):
            self.assertNotIn(gone, src)


class TestKbDeadControlsRemoved(unittest.TestCase):
    """#82：知识库引擎死控件移除（真控件=v2KbAiMode 单选 + 搜索引擎常驻组）"""

    def test_no_dead_ids(self):
        src = _read("settings.js")
        self.assertNotIn("kbEngineSel", src)
        self.assertNotIn('id="kbReranker"', src)

    def test_live_controls_intact(self):
        src = _read("settings.js")
        self.assertIn("v2KbAiMode", src)
        self.assertIn("kbRrResident", src)


class TestDownloadPageNoUseButton(unittest.TestCase):
    """#83：模型下载页无「使用」按钮（使用中徽章保留为被动指示）"""

    def test_no_use_button(self):
        self.assertNotIn("data-use-dl", _read("settings.js"))

    def test_badge_kept(self):
        self.assertIn("使用中", _read("settings.js"))




class TestSessDotLifecycle(unittest.TestCase):
    """rc.6 PM 复扫回归守卫：#33 撤 idle 圆点后 _updateSessDots 必须能「现建」状态点
    （此前只更新/删除既有圆点——生成中金点永远出不来），#71 加载提示的 display
    门控必须把 _loadHint 计入（否则提示写了永不可见）"""

    def test_update_creates_dot_when_status(self):
        src = _read("index.js")
        i = src.index("function _updateSessDots")
        seg = src[i:i + 1800]
        self.assertIn("createElement('span')", seg, "状态出现时要现建 si-st 元素")
        self.assertIn("prepend(dot)", seg)
        self.assertNotIn("if (dot) { if (st)", seg, "旧的只更新不创建写法必须消失")

    def test_load_hint_display_gating(self):
        src = _read("index.js")
        self.assertIn("(st.status || _loadHint) ? '' : 'none'", src,
                      "display 门控必须含 _loadHint，否则冷启动提示不可见")



class TestCloudCtxHintAndSpacing(unittest.TestCase):
    """PM 复查：已填上下文不再提示「请确认」；「离线AI」补空格为「离线 AI」"""

    def test_ctx_label_no_nag_when_filled(self):
        src = _read("settings.js")
        self.assertNotIn("K · 请确认上下文长度", src, "已填值时不得再拼「请确认」")
        self.assertIn("c > 0 ? (Math.round(c / 1000) + 'K') : '请确认上下文长度'", src)

    def test_param_editor_note_conditional(self):
        src = _read("settings.js")
        self.assertIn("${m.ctx > 0 ? '' : '<span class=\"set-note\">请确认上下文长度</span>'}", src,
                      "参数编辑器提示仅未填时显示")

    def test_models_sub_conditional(self):
        src = _read("settings.js")
        self.assertIn("上下文已确认", src)
        self.assertIn("有模型未确认上下文长度", src)

    def test_offline_label_spaced(self):
        src = _read("settings.js")
        self.assertIn("label: '离线 AI'", src)
        self.assertNotIn("label: '离线AI'", src)
        self.assertNotIn("「离线AI」", src, "可见文案（含 tooltip）不得出现无空格「离线AI」")
        idx = _read("index.js")
        self.assertNotIn("（离线AI）", idx)

if __name__ == "__main__":
    unittest.main()
