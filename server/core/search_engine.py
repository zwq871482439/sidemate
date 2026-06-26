# -*- coding: utf-8 -*-
"""
core/search_engine.py — 搜索引擎封装（本机直搜 Bing + 网页正文抓取）
======================================================================

零配置联网搜索：直接请求 Bing 搜索页，解析 HTML 提取结果。
无需任何 API Key。

依赖：
  - curl_cffi（TLS 指纹伪装，优先）或 httpx（fallback）
  - readability-lxml（网页正文提取，可选）
"""

import re
import logging

log = logging.getLogger(__name__)

# 优先使用 curl_cffi（TLS 指纹伪装），不可用时 fallback 到 httpx
try:
    from curl_cffi.requests import Session as _CurlSession
    _USE_CURL_CFFI = True
    log.info("[SEARCH] 使用 curl_cffi（TLS 指纹伪装）")
except ImportError:
    _USE_CURL_CFFI = False
    log.warning("[SEARCH] curl_cffi 不可用，搜索将使用 httpx（无 TLS 指纹伪装，部分网站可能拦截）")

# Bing 搜索结果条目的正则（<li class="b_algo"> 块）
_BING_RESULT_BLOCK = re.compile(
    r'<li\s+class="b_algo"[^>]*>(.*?)</li>',
    re.IGNORECASE | re.DOTALL,
)
# 提取 <a href="URL">
_HREF_PATTERN = re.compile(r'<a\s+[^>]*href="(https?://[^"]+)"[^>]*>(.*?)</a>', re.IGNORECASE | re.DOTALL)
# 提取摘要（<p> 或 class 含 snippet/caption 的 div）
_SNIPPET_PATTERN = re.compile(
    r'<(?:p|div)\s[^>]*class="[^"]*(?:b_caption|b_line)[^"]*"[^>]*>(.*?)</(?:p|div)>',
    re.IGNORECASE | re.DOTALL,
)
_FALLBACK_SNIPPET = re.compile(r'<p[^>]*>(.*?)</p>', re.IGNORECASE | re.DOTALL)

# 请求头（模拟浏览器）
_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)
_HEADERS = {
    "User-Agent": _UA,
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Referer": "https://www.google.com/",
    "DNT": "1",
}


def _strip_tags(html: str) -> str:
    """去除 HTML 标签，清理空白"""
    text = re.sub(r'<[^>]+>', '', html)
    text = text.replace('&amp;', '&').replace('&lt;', '<').replace('&gt;', '>')
    text = text.replace('&quot;', '"').replace('&#39;', "'")
    text = re.sub(r'\s+', ' ', text).strip()
    return text


class SearchEngine:
    """搜索引擎封装 — 本机直搜 Bing + 网页正文抓取（零配置）"""

    def __init__(self):
        """无需 API Key，直接初始化"""
        pass

    def search(self, query: str, count: int = 10):
        """本机直搜 Bing 搜索结果页，解析 HTML 提取结果

        Args:
            query: 搜索关键词
            count: 返回结果数量（最大 10）

        Returns:
            list[dict]: 搜索结果列表，每项包含 title, url, snippet
        """
        url = "https://www.bing.com/search"
        params = {
            "q": query,
            "count": min(count, 10),
            "setmkt": "zh-CN",
            "setlang": "zh-CN",
        }

        try:
            html = self._http_get(url, params=params)
            if not html:
                return []

            results = []

            blocks = _BING_RESULT_BLOCK.findall(html)
            for block in blocks[:count]:
                # 提取链接和标题
                href_match = _HREF_PATTERN.search(block)
                if not href_match:
                    continue
                link = href_match.group(1)
                title = _strip_tags(href_match.group(2))
                if not title:
                    continue

                # 提取摘要
                snippet = ""
                snippet_match = _SNIPPET_PATTERN.search(block)
                if snippet_match:
                    snippet = _strip_tags(snippet_match.group(1))
                if not snippet:
                    # 回退：找第一个 <p>
                    p_match = _FALLBACK_SNIPPET.search(block)
                    if p_match:
                        snippet = _strip_tags(p_match.group(1))

                # 过滤 Bing 内部链接
                if "bing.com" in link or "microsoft.com" in link:
                    continue

                results.append({
                    "title": title[:200],
                    "url": link,
                    "snippet": snippet[:500],
                })

            log.info("[SEARCH] 搜索 '%s' 返回 %d 条结果", query[:50], len(results))
            return results

        except Exception as e:
            log.error("[SEARCH] 搜索请求失败: %s", str(e)[:200])
            return []

    def fetch(self, url: str):
        """抓取网页正文

        使用 curl_cffi（优先）或 httpx 获取 HTML，再用 readability 提取正文。
        如果 readability 不可用，则返回截断的纯文本。

        Args:
            url: 目标网页 URL

        Returns:
            dict: {"title": ..., "text": ..., "url": url}
        """
        try:
            html = self._http_get(url)
            if not html:
                return {"title": "", "text": "[HTTP 请求失败]", "url": url}

            title = self._extract_title(html)

            # 尝试 readability-lxml 提取正文
            text = self._extract_with_readability(html)
            if not text:
                text = self._extract_fallback(html)

            # 截断过长内容（从 8000 提升到 12000，给 Agent 更多上下文）
            if len(text) > 12000:
                text = text[:12000] + "\n\n... [内容过长，已截断]"

            log.info("[SEARCH] 抓取 %s 成功: %d 字", url[:80], len(text))
            return {"title": title, "text": text, "url": url}

        except Exception as e:
            log.warning("[SEARCH] 抓取 %s 失败: %s", url[:80], str(e)[:100])
            return {"title": "", "text": "[抓取失败: %s]" % str(e)[:80], "url": url}

    def _http_get(self, url: str, params: dict = None) -> str:
        """HTTP GET 请求（curl_cffi 优先，httpx fallback）

        Args:
            url: 目标 URL
            params: 查询参数（可选）

        Returns:
            str: 响应文本，失败返回空字符串
        """
        if _USE_CURL_CFFI:
            try:
                with _CurlSession(impersonate="chrome") as session:
                    resp = session.get(
                        url, params=params, headers=_HEADERS,
                        timeout=15, allow_redirects=True,
                    )
                    if resp.status_code == 200:
                        return resp.text
                    log.warning("[SEARCH] curl_cffi 返回 %d: %s",
                                resp.status_code, str(resp.text)[:200])
                    return ""
            except Exception as e:
                log.warning("[SEARCH] curl_cffi 请求失败，fallback httpx: %s", str(e)[:80])

        # Fallback: httpx
        try:
            import httpx
        except ImportError:
            log.error("[SEARCH] 缺少 httpx 库，无法搜索")
            return ""

        try:
            resp = httpx.get(url, params=params, headers=_HEADERS,
                             timeout=15.0, follow_redirects=True)
            if resp.status_code != 200:
                log.warning("[SEARCH] httpx 返回 %d", resp.status_code)
                return ""
            return resp.text
        except Exception as e:
            log.error("[SEARCH] httpx 请求失败: %s", str(e)[:200])
            return ""

    def _extract_title(self, html: str) -> str:
        """从 HTML 中提取 title"""
        m = re.search(r'<title[^>]*>(.*?)</title>', html, re.IGNORECASE | re.DOTALL)
        if m:
            return _strip_tags(m.group(1))[:200]
        return ""

    def _extract_with_readability(self, html: str) -> str:
        """使用 readability-lxml 提取正文"""
        try:
            from readability import Document
            doc = Document(html)
            summary = doc.summary()
            # 去除 HTML 标签 + 清理空白（_strip_tags 含实体解码）
            return _strip_tags(summary)
        except ImportError:
            return ""
        except Exception as e:
            log.debug("[SEARCH] readability 提取失败: %s", str(e)[:80])
            return ""

    def _extract_fallback(self, html: str) -> str:
        """readability 不可用时的轻量级正文提取

        算法：
        1. 去除 script/style/nav/header/footer/aside 等非正文区块
        2. 按 <div>/<section>/<article> 分块
        3. 对每个块计算文本密度（文本长度 / 标签数量），选密度最高的块
        4. 从该块中提取 <p> 段落文本，拼接返回
        """
        # Step 1: 去除非正文区块
        clean = html
        for tag in ('script', 'style', 'nav', 'header', 'footer', 'aside',
                     'noscript', 'iframe', 'form', 'svg'):
            clean = re.sub(
                r'<%s[^>]*>.*?</%s>' % (tag, tag),
                '', clean, flags=re.IGNORECASE | re.DOTALL,
            )
        # 去除 HTML 注释
        clean = re.sub(r'<!--.*?-->', '', clean, flags=re.DOTALL)

        # Step 2: 尝试找 <article> 标签（最可能是正文）
        article_match = re.search(
            r'<article[^>]*>(.*?)</article>', clean,
            re.IGNORECASE | re.DOTALL,
        )
        if article_match:
            return self._extract_paragraphs(article_match.group(1))

        # Step 3: 按 <div>/<section> 分块，找文本密度最高的块
        blocks = re.findall(
            r'<(?:div|section)[^>]*>(.*?)</(?:div|section)>',
            clean, re.IGNORECASE | re.DOTALL,
        )

        if not blocks:
            # 没有 div/section 块，直接提取所有 <p>
            return self._extract_paragraphs(clean)

        best_block = ""
        best_density = -1

        for block in blocks:
            # 只看内容足够长的块（太短的不可能是正文）
            plain_len = len(re.sub(r'<[^>]+>', '', block).strip())
            if plain_len < 50:
                continue
            # 计算标签数量
            tag_count = len(re.findall(r'<[^>]+>', block))
            # 文本密度 = 纯文本长度 / (标签数 + 1)
            density = plain_len / (tag_count + 1)
            if density > best_density:
                best_density = density
                best_block = block

        if best_block:
            return self._extract_paragraphs(best_block)

        # 兜底：从整个页面提取段落
        return self._extract_paragraphs(clean)

    def _extract_paragraphs(self, html: str) -> str:
        """从 HTML 片段中提取 <p> 段落文本"""
        paragraphs = re.findall(
            r'<p[^>]*>(.*?)</p>', html,
            re.IGNORECASE | re.DOTALL,
        )
        if not paragraphs:
            # 没有 <p> 标签，fallback 到去标签
            text = re.sub(r'<[^>]+>', ' ', html)
            text = re.sub(r'\s+', ' ', text).strip()
            return text[:5000]

        result = []
        for p in paragraphs:
            # 去内联标签
            text = re.sub(r'<[^>]+>', '', p).strip()
            # 过滤太短的段落（通常是导航链接、版权声明等）
            if len(text) < 15:
                continue
            result.append(text)

        text = '\n\n'.join(result)
        return text[:8000]
