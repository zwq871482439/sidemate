# -*- coding: utf-8 -*-
"""
core/gzh_format.py — 公众号排版（0.11 A3）
==========================================

把文章 HTML 转成微信公众号编辑器兼容格式：
  - 样式全部内联（微信粘贴会丢弃 <style> 块与 class）
  - 标签白名单（script/style/div 嵌套结构等一律剥除或解包）
  - 排版规范化：正文 15px / 行距 1.75 / 段距、小标题层级、金句引用块、代码块灰底

输入：模型写的文章 HTML（h1/h2/p/blockquote/ul/li/strong/img 等常见标签）
输出：可直接全选复制 → 粘贴公众号编辑器的 HTML（样式不丢）

确定性：纯函数，无网络无随机。
"""

from __future__ import annotations

import html as _html
import re
from html.parser import HTMLParser

# 白名单标签 → 内联样式模板（%(inner)s 为子内容）
# 样式取公众号主流规范：15px 正文 / 1.75 行距 / #333 墨色 / 576b95 链接蓝
_STYLES = {
    "h1": 'font-size:20px;font-weight:700;color:#1a1a1a;line-height:1.4;'
          'margin:24px 0 12px;text-align:center;',
    "h2": 'font-size:17px;font-weight:700;color:#1a1a1a;line-height:1.5;'
          'margin:22px 0 10px;padding-left:10px;border-left:3px solid #E8B54D;',
    "h3": 'font-size:16px;font-weight:700;color:#1a1a1a;line-height:1.5;margin:18px 0 8px;',
    "h4": 'font-size:15px;font-weight:700;color:#1a1a1a;margin:14px 0 6px;',
    "p": 'font-size:15px;color:#333333;line-height:1.75;letter-spacing:.5px;'
         'margin:10px 0;text-align:justify;',
    "blockquote": 'font-size:14px;color:#888888;line-height:1.75;margin:16px 0;'
                  'padding:10px 14px;background:#f7f7f7;'
                  'border-left:3px solid #E8B54D;border-radius:0 4px 4px 0;',
    "ul": 'font-size:15px;color:#333333;line-height:1.75;margin:10px 0;'
          'padding-left:22px;list-style:disc;',
    "ol": 'font-size:15px;color:#333333;line-height:1.75;margin:10px 0;'
          'padding-left:22px;list-style:decimal;',
    "li": 'font-size:15px;color:#333333;line-height:1.75;margin:4px 0;text-align:justify;',
    "strong": 'font-weight:700;color:#B07E1E;',   # 强调=深金（克制的点睛）
    "b": 'font-weight:700;color:#B07E1E;',
    "em": 'font-style:italic;color:#888888;',
    "i": 'font-style:italic;color:#888888;',
    "a": 'color:#576b95;text-decoration:none;border-bottom:1px solid #576b95;',
    "img": 'max-width:100%;height:auto;display:block;margin:12px auto;border-radius:4px;',
    "hr": 'border:none;border-top:1px solid #eeeeee;margin:20px 0;',
    "code": 'font-family:Consolas,monospace;font-size:13px;color:#c7254e;'
            'background:#f9f2f4;padding:2px 5px;border-radius:3px;',
    "pre": 'font-family:Consolas,monospace;font-size:13px;color:#333;line-height:1.6;'
           'background:#f5f5f5;padding:12px;border-radius:5px;overflow-x:auto;'
           'white-space:pre-wrap;margin:12px 0;',
    "section": '',           # 解包（不保留容器）
    "figure": '',            # 解包
    "figcaption": 'font-size:13px;color:#999999;text-align:center;margin:6px 0 12px;',
    "table": 'border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;',
    "thead": '', "tbody": '', "tr": '',
    "th": 'border:1px solid #dddddd;padding:6px 10px;background:#f7f7f7;'
          'font-weight:700;color:#333333;text-align:left;',
    "td": 'border:1px solid #dddddd;padding:6px 10px;color:#333333;text-align:left;',
}
# 完全丢弃（含内容）的标签
_DROP_WITH_CONTENT = {"script", "style", "noscript"}
# 保留的属性（其余 class/id/onclick 等全部剥除）
_KEEP_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "alt"},
}
_VOID_TAGS = {"img", "hr", "br"}


class _GzhParser(HTMLParser):
    """白名单重建：允许的标签带内联样式重建；不允许的解包（保留文字）。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out: list = []
        self._skip_depth = 0          # drop-with-content 嵌套深度

    # -- 属性处理 --------------------------------------------------------
    def _attrs(self, tag, attrs) -> str:
        keep = _KEEP_ATTRS.get(tag, set())
        parts = []
        for k, v in attrs:
            lk = (k or "").lower()
            if lk in keep and v:
                # 只放行 http(s) 链接，防 javascript: 注入
                if lk in ("href", "src") and not re.match(r"^(https?:)?//|^data:image/", v.strip()):
                    continue
                parts.append(' %s="%s"' % (lk, _html.escape(v, quote=True)))
        return "".join(parts)

    # -- 事件 ------------------------------------------------------------
    def handle_starttag(self, tag, attrs):
        if self._skip_depth:
            if tag in _DROP_WITH_CONTENT:
                self._skip_depth += 1
            return
        if tag in _DROP_WITH_CONTENT:
            self._skip_depth = 1
            return
        if tag == "br":
            self.out.append("<br/>")
            return
        if tag in _STYLES:
            style = _STYLES[tag]
            a = self._attrs(tag, attrs)
            if tag in _VOID_TAGS:
                if tag == "img" and not a:      # 无 src 的图片不留占位
                    return
                self.out.append('<%s%s style="%s"/>' % (tag, a, style))
            else:
                self.out.append('<%s%s style="%s">' % (tag, a, style))
        # 白名单外（div/span/header/footer/nav 等）：解包，子内容自然保留

    def handle_endtag(self, tag):
        if self._skip_depth:
            if tag in _DROP_WITH_CONTENT:
                self._skip_depth -= 1
            return
        if tag in _STYLES and tag not in _VOID_TAGS:
            self.out.append("</%s>" % tag)

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        if tag in _STYLES and tag not in _VOID_TAGS:
            self.out.append("</%s>" % tag)

    def handle_data(self, data):
        if self._skip_depth or not data:
            return
        self.out.append(_html.escape(data, quote=False))


def _extract_body(html_in: str) -> str:
    """取 <body> 内容（无 body 标签则原样）。"""
    m = re.search(r"<body[^>]*>(.*)</body>", html_in, re.DOTALL | re.IGNORECASE)
    return m.group(1) if m else html_in


def _strip_code_fences(html_in: str) -> str:
    """模型常写 ``` 围栏（非 <pre>），包成 <pre> 以免排版散架。"""
    return re.sub(
        r"```(?:[a-zA-Z0-9]*)\n(.*?)```",
        lambda m: "<pre>%s</pre>" % _html.escape(m.group(1), quote=False),
        html_in, flags=re.DOTALL)


def format_gzh_html(html_in: str) -> str:
    """主入口：文章 HTML → 微信编辑器兼容 HTML（全内联样式）。"""
    if not (html_in or "").strip():
        raise ValueError("内容为空")
    src = _strip_code_fences(_extract_body(html_in))
    parser = _GzhParser()
    parser.feed(src)
    parser.close()
    out = "".join(parser.out)
    # 压掉连续空行（解包标签残留的纯空白段落）
    out = re.sub(r"(<p[^>]*>\s*</p>)+", "", out)
    out = re.sub(r"\n{3,}", "\n\n", out).strip()
    if not out:
        raise ValueError("白名单过滤后没有可保留的内容（检查输入是否为有效 HTML）")
    return out
