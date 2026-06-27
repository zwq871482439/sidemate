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


# ============================================================
# SSRF 防护：URL 分类（供 agent_loop.fetch_url 调用前校验）
# ============================================================

import ipaddress
from urllib.parse import urlparse

# 协议白名单（拒绝 file:///、gopher://、ftp://、dict:// 等）
_ALLOWED_SCHEMES = ("http", "https")


def classify_url(url):
    """对 fetch_url 的目标 URL 做 SSRF 分类。

    解析 URL → 校验协议 → DNS 解析拿到 IP → 按 IP 类型分类。
    防 DNS rebinding：本函数只做解析，实际请求时应禁止跟随重定向到新主机
    （search_engine._http_get 用 allow_redirects=True，但目标已在此处锁定）。

    Returns:
        tuple(category, detail):
          category: "public"   公网，安全放行
                    "private"  回环/私网（127/10/172.16-31/192.168），需用户授权
                    "blocked"  链路本地(169.254，含云元数据)/非法协议/解析失败，硬拒绝
          detail:  人类可读原因（用于日志和拒绝提示）
    """
    try:
        parsed = urlparse(url)
    except Exception as e:
        return "blocked", "URL 解析失败: %s" % str(e)[:60]

    scheme = (parsed.scheme or "").lower()
    if scheme not in _ALLOWED_SCHEMES:
        return "blocked", "仅允许 http/https，拒绝 %s" % (scheme or "空协议")

    host = parsed.hostname
    if not host:
        return "blocked", "URL 缺少主机名"

    # 解析主机名为 IP（DNS 查询，可能返回多个 A 记录）
    import socket
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return "blocked", "无法解析主机名: %s" % host

    ips = set(info[4][0] for info in infos)
    if not ips:
        return "blocked", "主机名未解析到任何 IP: %s" % host

    # 按所有解析出的 IP 分类，取最严格的类别
    # （任一 IP 是私网/回环/链路本地，就按对应类别处理，防 DNS rebinding 多记录投毒）
    for ip_str in ips:
        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            return "blocked", "非法 IP 地址: %s" % ip_str

        if ip.is_loopback:
            return "private", "回环地址 %s" % ip_str
        if ip.is_link_local:
            # 169.254.x.x 含云元数据端点（169.254.169.254），无合法用途，硬拒绝
            return "blocked", "链路本地地址 %s（可能为云元数据端点，已拒绝）" % ip_str
        if ip.is_private:
            return "private", "私网地址 %s" % ip_str
        if ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return "blocked", "保留/组播地址 %s" % ip_str

    return "public", "公网"


def _check_url_allowed(url):
    """对单个 URL 应用 SSRF 策略，返回 (allowed: bool, reason: str)。

    供 fetch 的逐跳重定向校验复用，与 agent_loop.fetch_url 的首跳决策保持一致：
      - blocked（链路本地/非法协议/解析失败）→ 拒绝
      - private（回环/内网）→ 默认拒绝；仅当 confirm_external_read=False（完全信任）放行
      - public → 放行
    """
    category, detail = classify_url(url)
    if category == "blocked":
        return False, detail
    if category == "private":
        try:
            from config import get as _cfg
            trust = not _cfg("confirm_external_read", True)
        except Exception:
            trust = False
        if trust:
            return True, detail
        return False, "内网地址受保护（%s）" % detail
    return True, detail


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
            # BUG-4：SSRF 安全抓取——禁用自动重定向，逐跳 classify_url 后再跟随，
            # 防止公网 URL 经 3xx 跳到内网/回环/云元数据端点。
            try:
                html = self._http_get_safe(url)
            except PermissionError as pe:
                log.warning("[SEARCH] fetch 被 SSRF 策略拒绝: %s（%s）", url[:80], str(pe)[:80])
                return {"title": "", "text": "[该地址被禁止访问：%s]" % str(pe)[:100], "url": url}
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

    def _request(self, url: str, params: dict = None, allow_redirects: bool = True) -> dict:
        """底层 HTTP GET（curl_cffi 优先，httpx fallback）。

        Returns:
            dict: {"status": int, "headers": dict, "text": str}；请求失败时 status=0。
        """
        if _USE_CURL_CFFI:
            try:
                with _CurlSession(impersonate="chrome") as session:
                    resp = session.get(
                        url, params=params, headers=_HEADERS,
                        timeout=15, allow_redirects=allow_redirects,
                    )
                    return {"status": resp.status_code,
                            "headers": dict(resp.headers or {}),
                            "text": resp.text}
            except Exception as e:
                log.warning("[SEARCH] curl_cffi 请求失败，fallback httpx: %s", str(e)[:80])

        # Fallback: httpx
        try:
            import httpx
        except ImportError:
            log.error("[SEARCH] 缺少 httpx 库，无法请求")
            return {"status": 0, "headers": {}, "text": ""}

        try:
            resp = httpx.get(url, params=params, headers=_HEADERS,
                             timeout=15.0, follow_redirects=allow_redirects)
            return {"status": resp.status_code,
                    "headers": dict(resp.headers or {}),
                    "text": resp.text}
        except Exception as e:
            log.error("[SEARCH] httpx 请求失败: %s", str(e)[:200])
            return {"status": 0, "headers": {}, "text": ""}

    def _http_get(self, url: str, params: dict = None) -> str:
        """搜索用 GET（固定 Bing，允许自动重定向）。失败返回空字符串。"""
        r = self._request(url, params=params, allow_redirects=True)
        if r["status"] == 200:
            return r["text"]
        if r["status"]:
            log.warning("[SEARCH] HTTP %d", r["status"])
        return ""

    def _http_get_safe(self, url: str, max_redirects: int = 5) -> str:
        """SSRF 安全 GET（fetch 用）：禁用自动重定向，逐跳 classify_url 后再跟随。

        每一跳（含首跳）都过 _check_url_allowed；命中内网/回环/元数据/非法协议即抛
        PermissionError。注意：classify 解析 DNS 与实际请求解析之间仍存在 DNS rebinding
        的理论窗口（需 IP 锁定才能根除），但逐跳校验已堵住绝大多数重定向型 SSRF。

        Returns:
            str: 最终页面 HTML；非 200/3xx 或请求失败时返回空字符串。
        Raises:
            PermissionError: 任一跳被 SSRF 策略拒绝，或重定向次数超限。
        """
        from urllib.parse import urljoin
        current = url
        for hop in range(max_redirects + 1):
            allowed, reason = _check_url_allowed(current)
            if not allowed:
                raise PermissionError(reason)
            r = self._request(current, allow_redirects=False)
            st = r["status"]
            if st in (301, 302, 303, 307, 308):
                loc = r["headers"].get("location") or r["headers"].get("Location")
                if not loc:
                    return r["text"]
                current = urljoin(current, loc)
                log.info("[SEARCH] 重定向跟随(%d/%d) -> %s", hop + 1, max_redirects, current[:80])
                continue
            if st == 200:
                return r["text"]
            if st:
                log.warning("[SEARCH] fetch HTTP %d: %s", st, current[:80])
            return ""
        raise PermissionError("重定向次数过多（>%d）" % max_redirects)

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
