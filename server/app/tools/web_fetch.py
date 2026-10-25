import asyncio
import hashlib
import json
import logging
import re
from typing import Any
from urllib.parse import urljoin

import httpx
import trafilatura
from charset_normalizer import from_bytes
from lxml import html as lxml_html

from app.cache import cache_get, cache_set
from app.config import get_settings
from app.errors import AppError, invalid
from app.tools.html_markdown import extract_markdown
from app.tools.urls import FETCH_TIMEOUT_SECONDS, validate_fetch_url

logger = logging.getLogger(__name__)

FETCH_SEMAPHORE = asyncio.Semaphore(4)
# Research replies frequently read the same page more than once. Share one in-flight fetch
# per URL and keep the extracted result briefly, instead of hitting the origin each time.
_fetch_flights: dict[str, asyncio.Task[dict[str, Any]]] = {}
MAX_TITLE_CHARS = 280
MAX_REDIRECTS = 5
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
TEXTUAL_CONTENT_TYPES = (
    "text/",
    "application/xhtml+xml",
    "application/xml",
    "application/json",
    "application/rss+xml",
    "application/atom+xml",
)


def _user_agent() -> str:
    return get_settings().search_user_agent


def _decode(body: bytes, encoding: str | None) -> str:
    if encoding:
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            pass
    best = from_bytes(body).best()
    return str(best) if best is not None else body.decode("utf-8", errors="replace")


def _is_textual(content_type: str) -> bool:
    lowered = content_type.split(";", 1)[0].strip().lower()
    if not lowered:
        return True
    return lowered.startswith(TEXTUAL_CONTENT_TYPES) or lowered.endswith(("+json", "+xml"))


async def _download(url: str) -> tuple[str, str, bool, str]:
    """Return (final_url, body, truncated, content_type), re-validating redirect hops."""
    settings = get_settings()
    current = await validate_fetch_url(url)
    timeout = httpx.Timeout(FETCH_TIMEOUT_SECONDS, connect=10)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        # Page fetching shares the configured upstream proxy with web search. URL validation
        # still happens locally before the request and on every redirect hop.
        proxy=getattr(settings, "web_tool_proxy_url", "") or None,
        headers={
            "User-Agent": _user_agent(),
            "Accept": ("text/markdown,text/x-markdown;q=0.95,text/plain;q=0.9,"
                       "text/html;q=0.85,application/xhtml+xml;q=0.8,*/*;q=0.1"),
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    ) as client:
        for hop in range(MAX_REDIRECTS + 1):
            async with client.stream("GET", current) as response:
                if response.status_code in REDIRECT_STATUSES:
                    location = response.headers.get("location")
                    if not location:
                        raise AppError(502, "upstream_error", "网页重定向缺少目标地址。")
                    current = await validate_fetch_url(urljoin(current, location))
                    if hop == MAX_REDIRECTS:
                        raise AppError(502, "upstream_error", "网页重定向次数过多。")
                    continue

                if response.status_code in (401, 403):
                    raise AppError(422, "fetch_blocked", "该网页拒绝自动访问或需要登录，请尝试其他公开来源。")
                if response.status_code in (404, 410):
                    raise AppError(422, "fetch_not_found", f"网页不存在或已删除（HTTP {response.status_code}）。")
                if response.status_code == 429:
                    retry_after = response.headers.get("retry-after", "5")
                    raise AppError(503, "fetch_rate_limited", "目标网站暂时限流，请稍后读取或更换来源。",
                                   headers={"Retry-After": retry_after})
                if response.status_code >= 400:
                    raise AppError(502, "fetch_upstream_error", f"目标网站返回 HTTP {response.status_code}。")
                if not _is_textual(response.headers.get("content-type", "")):
                    raise AppError(422, "unsupported_content", "该地址不是可提取的文本网页。")

                limit = settings.fetch_max_bytes
                chunks: list[bytes] = []
                total = 0
                truncated = False
                async for chunk in response.aiter_bytes():
                    remaining = limit - total
                    if len(chunk) > remaining:
                        chunks.append(chunk[:remaining])
                        total = limit
                        truncated = True
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                return (current, _decode(b"".join(chunks), response.charset_encoding), truncated,
                        response.headers.get("content-type", ""))

    raise AppError(502, "upstream_error", "网页重定向次数过多。")


def _extract_with_lxml(body: str, url: str) -> tuple[str, str]:
    tree = lxml_html.fromstring(body)
    for node in tree.xpath("//script|//style|//noscript|//template"):
        node.drop_tree()
    titles = tree.xpath("//title")
    title = " ".join(titles[0].text_content().split()) if titles else url
    return title, " ".join(tree.text_content().split())


def _extract_with_trafilatura(body: str, url: str, mode: str) -> tuple[str, str] | None:
    output = trafilatura.extract(
        body,
        url=url,
        output_format="markdown",
        with_metadata=False,
        include_comments=False,
        include_tables=True,
        include_links=True,
        favor_precision=mode == "fast",
        favor_recall=mode == "full",
        deduplicate=True,
    )
    if not output:
        return None
    tree = lxml_html.fromstring(body)
    titles = tree.xpath("//title|//h1")
    title = " ".join(titles[0].text_content().split()) if titles else url
    return title, output


def _extract(body: str, url: str, mode: str, content_type: str = "text/html") -> tuple[str, str]:
    if not body.strip():
        return url, ""
    mime = content_type.split(";", 1)[0].strip().lower()
    if mime and mime not in ("text/html", "application/xhtml+xml"):
        return url, body.strip()
    if not mime and not re.search(r"<(?:html|head|body|main|article|div|p|h[1-6])(?:\s|>)", body, re.I):
        return url, body.strip()
    title_match = re.search(r"<title[^>]*>(.*?)</title>", body, re.I | re.S)
    title_text = title_match.group(1).strip().lower() if title_match else ""
    visible = re.sub(r"<[^>]+>", " ", body)
    short_page = len(" ".join(visible.split())) < 2000
    if (re.match(r"^(?:just a moment|attention required)", title_text)
            or (short_page and title_text.rstrip(".! ") in ("access denied", "security check"))
            or ("cf-chl-" in body and len(body) < 20_000)):
        raise AppError(422, "fetch_blocked", "该网页返回了验证或访问限制页面，未作为正文读取。")
    if ("<noscript" in body.lower() and len(" ".join(visible.split())) < 500
            and re.search(r"(?:enable|requires?|need)[^<\n]{0,50}javascript|启用\s*javascript", visible, re.I)):
        raise AppError(422, "fetch_requires_browser",
                       "该网页需要 JavaScript 渲染，当前读取器无法取得正文，请更换公开来源。")
    if mode == "full" or "<" in body:
        try:
            extracted = _extract_with_trafilatura(body, url, mode)
            if extracted and extracted[1].strip():
                return extracted
        except Exception as exc:  # noqa: BLE001 - fall back to plain text extraction
            logger.warning("trafilatura extraction failed for %s: %s", url, exc)
    try:
        return extract_markdown(body, url, main_only=mode == "fast")
    except Exception as exc:  # noqa: BLE001
        logger.warning("lxml extraction failed for %s: %s", url, exc)
        return _extract_with_lxml(body, url)


def _forget_flight(key: str, task: asyncio.Task) -> None:
    if _fetch_flights.get(key) is task:
        _fetch_flights.pop(key, None)
    if not task.cancelled():
        task.exception()


async def web_fetch(url: str, mode: str = "fast") -> dict[str, Any]:
    ensure_mode(mode)
    cache_key = "matrius:fetch:v2:" + hashlib.sha256(f"{url}|{mode}".encode()).hexdigest()
    cached = await cache_get(cache_key)
    if cached is not None:
        try:
            return json.loads(cached)
        except ValueError:
            pass

    flight = _fetch_flights.get(cache_key)
    if flight is None:
        flight = asyncio.create_task(_fetch_uncached(url, mode, cache_key))
        _fetch_flights[cache_key] = flight
        flight.add_done_callback(lambda task, key=cache_key: _forget_flight(key, task))
    return await asyncio.shield(flight)


async def _fetch_uncached(url: str, mode: str, cache_key: str) -> dict[str, Any]:
    settings = get_settings()
    # Extraction is CPU-bound too, so it stays inside the slot: four concurrent pages are
    # already the limit for both downloading and parsing.
    try:
        # A single deadline covers queueing, redirects, response body and extraction.
        async with asyncio.timeout(FETCH_TIMEOUT_SECONDS):
            async with FETCH_SEMAPHORE:
                final_url, body, truncated, content_type = await _download(url)
                title, text = await asyncio.to_thread(_extract, body, final_url, mode, content_type)
    except TimeoutError:
        raise AppError(504, "fetch_timeout", "网页读取超时，已停止等待该页面。") from None
    except AppError:
        raise
    except httpx.TimeoutException:
        raise AppError(504, "fetch_timeout", "目标网页连接或传输超时。") from None
    except httpx.TransportError:
        raise AppError(502, "fetch_network_error", "无法连接目标网页，请稍后读取或更换来源。") from None
    if not text.strip():
        raise AppError(502, "fetch_empty", "未能提取到网页正文。")

    limit = settings.fetch_max_chars
    truncated = truncated or len(text) > limit
    text = text[:limit]
    result = {
        "title": (title.strip() or final_url)[:MAX_TITLE_CHARS],
        "url": final_url,
        "text": text,
        "truncated": truncated,
        "chars": len(text),
    }
    ttl = getattr(settings, "fetch_cache_ttl_seconds", 300)
    await cache_set(cache_key, json.dumps(result, ensure_ascii=False), ttl)
    return result


def ensure_mode(mode: str) -> str:
    if mode not in ("fast", "full"):
        raise invalid("mode 只能是 fast 或 full。")
    return mode
