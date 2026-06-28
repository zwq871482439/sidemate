# -*- coding: utf-8 -*-
"""
test_renderer_paths_pure.py — 异步渲染器调用路径静态回归测试

回归背景：
  2026-06-28 用户报 bug——打开历史 chat session，AI 回答中含 ```mermaid 代码块，
  前端页面上始终显示"渲染图表中"占位符，图表实际未渲染。
  根因：chat.js 的 renderMessages 全量重建分支、CardRenderer.finalizeDOM 之后
  都漏调 _renderMermaid()，仅增量追加分支调过，导致历史会话 / 流式完成后
  mermaid 永远停留在占位符。

覆盖：
  1. chat.js renderMessages 函数：两条分支都必须触发 mermaid/html 预览渲染
  2. chat.js CardRenderer.finalizeDOM 调用点：调用之后必须触发 mermaid/html 预览
  3. utils.js _renderMermaid：data-rendered 标记必须在异步 resolve/reject 之后再设
     （否则若 mermaid.render() 内部抛同步异常但已被 try/catch 捕获，标记仍存在，
      后续 _renderMermaid 不会再尝试 → 图表永远停在占位符）

运行：cd server && python -m pytest tests/test_renderer_paths_pure.py -v
"""
import os
import re
import sys

import pytest

# 确保 server/ 在 sys.path
_SERVER_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SERVER_DIR not in sys.path:
    sys.path.insert(0, _SERVER_DIR)

_STATIC_DIR = os.path.join(_SERVER_DIR, "static", "js")


def _read(name: str) -> str:
    path = os.path.join(_STATIC_DIR, name)
    with open(path, "r", encoding="utf-8") as f:
        return f.read()


# ============================================================
# 1. chat.js renderMessages 两条分支都必须触发异步渲染
# ============================================================

class TestRenderMessagesCoverage:
    """确保 renderMessages 不会再次漏调 mermaid/html 预览异步渲染"""

    def setup_method(self):
        self.src = _read("chat.js")

    def _extract_function(self, name: str) -> str:
        """简单提取顶层函数体——从 'function NAME(' 开始到下一个匹配的 '  }' 行"""
        pattern = re.compile(
            r"function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{",
            re.MULTILINE,
        )
        m = pattern.search(self.src)
        assert m, f"未找到函数 {name}"
        # 大括号配对扫描
        i = m.end() - 1  # 当前是 '{'
        depth = 0
        start = i
        while i < len(self.src):
            c = self.src[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return self.src[start : i + 1]
            i += 1
        raise AssertionError(f"函数 {name} 大括号未闭合")

    def test_render_messages_calls_mermaid_in_full_rebuild(self):
        """全量重建分支必须调 _renderMermaid"""
        body = self._extract_function("renderMessages")
        assert "_renderMermaid" in body, (
            "renderMessages 函数体内未发现 _renderMermaid 调用，"
            "历史会话打开后会一直停在'渲染图表中'占位符"
        )

    def test_render_messages_calls_html_preview_in_full_rebuild(self):
        """全量重建分支必须调 _renderHtmlPreview"""
        body = self._extract_function("renderMessages")
        assert "_renderHtmlPreview" in body, (
            "renderMessages 函数体内未发现 _renderHtmlPreview 调用，"
            "历史会话里的 html 代码块预览会一直停在'渲染中'占位符"
        )

    def test_render_messages_has_both_branches(self):
        """函数必须同时包含增量追加分支和全量重建分支（避免有人改写时只保留一个）"""
        body = self._extract_function("renderMessages")
        assert "forceFull" in body, "renderMessages 应支持 forceFull 参数"
        # 增量追加：for (var ni = existingCount; ...)
        assert re.search(r"for\s*\(\s*var\s+ni\s*=\s*existingCount", body), (
            "renderMessages 缺失增量追加分支"
        )
        # 全量重建：el.innerHTML = currentMessages.map
        assert "currentMessages.map" in body, (
            "renderMessages 缺失全量重建分支"
        )

    def test_render_messages_branches_both_call_mermaid(self):
        """两条分支都应该触发 mermaid 渲染——逐分支检查防止有人改一边漏一边"""
        body = self._extract_function("renderMessages")

        # 切分：第一个 if 分支(增量) 和 if 之外的剩余(全量)
        # 用占位符替换剥离 .map(...).join('') 这一段作为分界
        full_marker = "el.innerHTML = currentMessages.map"
        idx = body.find(full_marker)
        assert idx > 0, "找不到全量重建标记"
        inc_branch = body[:idx]
        full_branch = body[idx:]

        # 增量追加分支
        assert "_renderMermaid" in inc_branch, (
            "增量追加分支漏调 _renderMermaid（已修过，不能再退回去）"
        )
        assert "_renderHtmlPreview" in inc_branch, (
            "增量追加分支漏调 _renderHtmlPreview"
        )
        # 全量重建分支
        assert "_renderMermaid" in full_branch, (
            "全量重建分支漏调 _renderMermaid —— 这正是本次 bug 的根因！"
        )
        assert "_renderHtmlPreview" in full_branch, (
            "全量重建分支漏调 _renderHtmlPreview"
        )


# ============================================================
# 2. CardRenderer.finalizeDOM 调用点必须接 mermaid 渲染
# ============================================================

class TestFinalizeDomCoverage:
    """确保 finalizeDOM 调用后立刻触发异步渲染"""

    def setup_method(self):
        self.src = _read("chat.js")

    def test_finalize_dom_calls_followed_by_mermaid_render(self):
        """所有 CardRenderer.finalizeDOM(...) 之后必须有 _renderMermaid(el) 调用"""
        # 找所有调用点
        call_sites = list(re.finditer(r"CardRenderer\.finalizeDOM\s*\(([^)]+)\)", self.src))
        assert call_sites, "未发现 CardRenderer.finalizeDOM 调用点"

        # 对每个调用点：检查其后 500 字符内是否有 _renderMermaid 或 _renderHtmlPreview
        missing = []
        for m in call_sites:
            el_var = m.group(1).strip()
            # 取调用点后的 ~500 字符（同一函数体内）
            tail = self.src[m.end() : m.end() + 800]
            # 必须能查到对同一 el 变量的 _renderMermaid 调用
            # 容许写法：_renderMermaid(streamEl4) / _renderMermaid(streamErrFix)
            pattern_mermaid = re.compile(
                r"_renderMermaid\s*\(\s*" + re.escape(el_var) + r"\s*\)"
            )
            pattern_html = re.compile(
                r"_renderHtmlPreview\s*\(\s*" + re.escape(el_var) + r"\s*\)"
            )
            if not pattern_mermaid.search(tail):
                missing.append(f"{m.group(0)} 之后未调 _renderMermaid({el_var})")
            if not pattern_html.search(tail):
                missing.append(f"{m.group(0)} 之后未调 _renderHtmlPreview({el_var})")

        assert not missing, (
            "CardRenderer.finalizeDOM 调用点未接 mermaid/html 渲染：\n  - "
            + "\n  - ".join(missing)
        )


# ============================================================
# 3. utils.js _renderMermaid 的 data-rendered 标记时序
# ============================================================

class TestMermaidDataRenderedFlag:
    """data-rendered 必须在异步 resolve/reject 之后再设置"""

    def setup_method(self):
        self.src = _read(os.path.join("core", "utils.js"))

    def _extract_function(self, name: str) -> str:
        pattern = re.compile(r"function\s+" + re.escape(name) + r"\s*\([^)]*\)\s*\{", re.MULTILINE)
        m = pattern.search(self.src)
        assert m, f"未找到函数 {name}"
        i = m.end() - 1
        depth = 0
        start = i
        while i < len(self.src):
            c = self.src[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    return self.src[start : i + 1]
            i += 1
        raise AssertionError(f"函数 {name} 大括号未闭合")

    def test_data_rendered_set_after_async_resolve(self):
        """data-rendered 必须在 mermaid.render().then() 内设置，
        而不是在调用前——否则异常路径下占位符永远不会被重试"""
        body = self._extract_function("_renderMermaid")
        # 找 mermaid.render(...) 调用点
        render_match = re.search(r"mermaid\.render\s*\(", body)
        assert render_match, "_renderMermaid 未调 mermaid.render"

        # 检查调用前是否设置 data-rendered
        prefix = body[: render_match.start()]
        # 限制检查：data-rendered 必须在 mermaid.render 之后才设置
        # 用正则找所有 setAttribute('data-rendered',...) 调用
        rendered_sets = list(
            re.finditer(r"setAttribute\s*\(\s*['\"]data-rendered['\"]", body)
        )
        assert rendered_sets, "未发现 setAttribute('data-rendered', ...) 调用"

        first_set = rendered_sets[0]
        # 第一个 setAttribute 必须在 mermaid.render 之后
        assert first_set.start() > render_match.start(), (
            "data-rendered 在 mermaid.render 之前就设置了——"
            "若异步渲染 promise 永远 pending（极少见，但发生过），"
            "该占位符将永远不会被重试。应在 then()/catch() 内设置。"
        )


# ============================================================
# 4. 反向防御：utils.js 必须先初始化 mermaid 才能被调用
# ============================================================

class TestMermaidInitialization:
    """mermaid.initialize 必须在所有 render 调用前就绪"""

    def setup_method(self):
        self.src = _read(os.path.join("core", "utils.js"))

    def test_initialize_runs_at_module_load(self):
        """模块加载时必须尝试 mermaid.initialize，否则裸调 render 会走默认配置（可能不支持 mindmap）"""
        # _renderMermaid 函数前的模块级代码必须有 mermaid.initialize 调用
        render_match = re.search(r"function\s+_renderMermaid\s*\(", self.src)
        assert render_match
        prefix = self.src[: render_match.start()]
        assert "mermaid.initialize" in prefix, (
            "模块加载阶段未调用 mermaid.initialize——"
            "若用户首屏 mermaid 库还在加载，render 会用默认配置，"
            "可能导致 mindmap 等图类型渲染失败"
        )

    def test_initialize_passes_security_level(self):
        """initialize 必须配置 securityLevel 为 'loose'，否则 mindmap 等图无法处理 <br/> 标签"""
        init_match = re.search(
            r"mermaid\.initialize\s*\(\s*\{([^}]+)\}", self.src, re.DOTALL
        )
        assert init_match, "未发现 mermaid.initialize 配置"
        config = init_match.group(1)
        assert "securityLevel" in config, (
            "mermaid.initialize 缺 securityLevel 配置（默认 'strict' 不支持 HTML 标签）"
        )
        # 必须含 loose（用户的 mindmap 代码里用了 <br/>）
        assert re.search(r"securityLevel\s*:\s*['\"]loose['\"]", config), (
            "mermaid.initialize 的 securityLevel 不是 'loose'——"
            "用户 mermaid 代码里的 <br/> 会被 strict 模式拒绝渲染"
        )