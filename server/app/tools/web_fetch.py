import asyncio
import hashlib
import json
import logging
import re
import time
from html import unescape
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
from app.tools.urls import validate_fetch_url

logger = logging.getLogger(__name__)

FETCH_SEMAPHORE = asyncio.Semaphore(4)
# Research replies frequently read the same page more than once. Share one in-flight fetch
# per URL and keep the extracted result briefly, instead of hitting the origin each time.
_fetch_flights: dict[str, asyncio.Task[dict[str, Any]]] = {}
MAX_TITLE_CHARS = 280
MAX_REDIRECTS = 5
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
SNIFF_BYTES = 4096
HTML_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
TEXTUAL_CONTENT_TYPES = (
    "text/",
    "application/javascript",
    "application/x-javascript",
    "application/ecmascript",
    "application/json",
    "application/xml",
    "application/rss+xml",
    "application/atom+xml",
)
BINARY_CONTENT_TYPES = (
    "image/",
    "audio/",
    "video/",
    "font/",
    "application/pdf",
    "application/zip",
    "application/gzip",
    "application/x-gzip",
    "application/x-tar",
    "application/x-7z-compressed",
    "application/x-rar-compressed",
    "application/msword",
    "application/vnd.",
    "application/wasm",
)
BINARY_MAGIC = (
    b"%PDF-",
    b"PK\x03\x04",
    b"\x89PNG\r\n\x1a\n",
    b"\xff\xd8\xff",
    b"GIF87a",
    b"GIF89a",
    b"\x7fELF",
    b"MZ",
    b"\x1f\x8b",
    b"7z\xbc\xaf\x27\x1c",
    b"Rar!\x1a\x07",
    b"OggS",
    b"ID3",
    b"fLaC",
)
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


class _RetryableFetch(Exception):
    """A failed download that may succeed on a second attempt."""

    def __init__(self, error: AppError, delay: float = 0.25):
        super().__init__(str(error))
        self.error = error
        self.delay = delay


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


def _sanitize_markup(body: str) -> str:
    return CONTROL_CHARS.sub("", body)


def _mime_of(content_type: str) -> str:
    return content_type.split(";", 1)[0].strip().lower()


def _unsupported() -> AppError:
    return AppError(422, "unsupported_content", "该地址不是可提取的文本网页。")


def _sniff_mime(body: bytes) -> str:
    """Classify a response that the server did not label usefully."""
    prefix = body[:SNIFF_BYTES]
    if not prefix:
        return "text/plain"
    if b"\x00" in prefix or any(prefix.startswith(magic) for magic in BINARY_MAGIC):
        raise _unsupported()
    stripped = prefix.lstrip(b"\xef\xbb\xbf \t\r\n").lower()
    if stripped.startswith((b"<!doctype html", b"<html", b"<head", b"<body", b"<main", b"<article")):
        return "text/html"
    if stripped.startswith((b"{", b"[")):
        return "application/json"
    try:
        sample = prefix.decode("utf-8")
    except UnicodeDecodeError:
        best = from_bytes(prefix).best()
        if best is None:
            raise _unsupported() from None
        sample = str(best)
    printable = sum(1 for char in sample if char.isprintable() or char in "\t\r\n")
    if not sample or printable / len(sample) < 0.85:
        raise _unsupported()
    return "text/plain"


def _resolve_mime(content_type: str, body: bytes) -> str:
    mime = _mime_of(content_type)
    # +json / +xml types (for example application/vnd.api+json) are textual even when the
    # vendor prefix would otherwise look binary.
    if mime.endswith(("+json", "+xml")):
        return mime
    if mime in HTML_CONTENT_TYPES or mime.startswith(TEXTUAL_CONTENT_TYPES):
        return mime
    if mime.startswith(BINARY_CONTENT_TYPES):
        raise _unsupported()
    # application/octet-stream, an unknown application/* type, or a missing header: look at
    # the bytes instead of rejecting a page that is actually HTML.
    return _sniff_mime(body)


def _retry_after(value: str | None) -> float:
    if not value:
        return 5.0
    try:
        return max(0.0, float(value))
    except ValueError:
        return 5.0


async def _read_body(response: httpx.Response, limit: int) -> tuple[bytes, bool]:
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
    return b"".join(chunks), truncated


async def _download(url: str, deadline: float) -> tuple[str, str, bool, str]:
    """Return (final_url, body, truncated, mime), re-validating redirect hops."""
    settings = get_settings()
    current = await validate_fetch_url(url)
    remaining = max(0.5, deadline - time.monotonic())
    timeout = httpx.Timeout(remaining, connect=min(10.0, remaining))
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        # Page fetching shares the configured upstream proxy with web search. URL validation
        # still happens locally before the request and on every redirect hop.
        proxy=settings.web_tool_proxy_url or None,
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
                    retry_after = _retry_after(response.headers.get("retry-after"))
                    error = AppError(
                        503,
                        "fetch_rate_limited",
                        "目标网站暂时限流，请稍后读取或更换来源。",
                        headers={"Retry-After": str(int(retry_after))},
                    )
                    if retry_after <= 5:
                        raise _RetryableFetch(error, delay=retry_after)
                    raise error
                if response.status_code >= 500:
                    raise _RetryableFetch(
                        AppError(502, "fetch_upstream_error", f"目标网站返回 HTTP {response.status_code}。")
                    )
                if response.status_code >= 400:
                    raise AppError(502, "fetch_upstream_error", f"目标网站返回 HTTP {response.status_code}。")

                body, truncated = await _read_body(response, settings.fetch_max_bytes)
                mime = _resolve_mime(response.headers.get("content-type", ""), body)
                return current, _decode(body, response.charset_encoding), truncated, mime

    raise AppError(502, "upstream_error", "网页重定向次数过多。")


def _extract_with_lxml(body: str, url: str) -> tuple[str, str]:
    tree = lxml_html.fromstring(body)
    for node in tree.xpath("//script|//style|//noscript|//template"):
        node.drop_tree()
    titles = tree.xpath("//title")
    title = " ".join(titles[0].text_content().split()) if titles else url
    return title, " ".join(tree.text_content().split())


def _extract_title(body: str, url: str) -> str:
    match = re.search(r"<title[^>]*>(.*?)</title>", body, re.I | re.S)
    if match:
        title = " ".join(unescape(re.sub(r"<[^>]+>", " ", match.group(1))).split())
        if title:
            return title
    try:
        tree = lxml_html.fromstring(body)
        headings = tree.xpath("//h1")
        if headings:
            title = " ".join(headings[0].text_content().split())
            if title:
                return title
    except Exception:  # noqa: BLE001 - a malformed heading must not fail the page
        pass
    return url


def _extract_with_trafilatura(body: str, url: str, *, recall: bool) -> tuple[str, str] | None:
    output = trafilatura.extract(
        body,
        url=url,
        output_format="markdown",
        with_metadata=False,
        include_comments=False,
        include_tables=True,
        include_links=True,
        favor_precision=not recall,
        favor_recall=recall,
        deduplicate=True,
    )
    if not output or not output.strip():
        return None
    return _extract_title(body, url), output


def _extract(body: str, url: str, mode: str, content_type: str = "text/html") -> tuple[str, str, str]:
    if not body.strip():
        return url, "", "none"
    mime = _mime_of(content_type)
    if mime and mime not in HTML_CONTENT_TYPES:
        return url, body.strip(), "raw"

    body = _sanitize_markup(body)
    title_text = ""
    match = re.search(r"<title[^>]*>(.*?)</title>", body, re.I | re.S)
    if match:
        title_text = unescape(re.sub(r"<[^>]+>", " ", match.group(1))).strip().lower()
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

    # trafilatura is precise but can return nothing on sparse pages. Retry with the opposite
    # bias before leaving the library; Hacker News is a real example where fast/precision is
    # empty while recall extracts the full page.
    for recall in ((False, True) if mode == "fast" else (True, False)):
        try:
            extracted = _extract_with_trafilatura(body, url, recall=recall)
            if extracted and extracted[1].strip():
                return extracted[0], extracted[1], "trafilatura"
        except Exception as exc:  # noqa: BLE001 - fall through to the next extractor
            logger.warning("trafilatura extraction failed for %s: %s", url, exc)

    try:
        title, text = extract_markdown(body, url, main_only=mode == "fast")
        if text.strip():
            return title, text, "html_markdown"
    except Exception as exc:  # noqa: BLE001
        logger.warning("html_markdown extraction failed for %s: %s", url, exc)

    try:
        title, text = _extract_with_lxml(body, url)
        if text.strip():
            return title, text, "lxml"
    except Exception as exc:  # noqa: BLE001
        logger.warning("lxml extraction failed for %s: %s", url, exc)
    return url, "", "none"


def _forget_flight(key: str, task: asyncio.Task) -> None:
    if _fetch_flights.get(key) is task:
        _fetch_flights.pop(key, None)
    if not task.cancelled():
        task.exception()


async def web_fetch(
    url: str,
    mode: str = "fast",
    *,
    trace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    ensure_mode(mode)
    cache_key = "matrius:fetch:v3:" + hashlib.sha256(f"{url}|{mode}".encode()).hexdigest()
    # The admin test needs real extractor and retry information, so it bypasses the cache.
    if trace is None:
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
    return await _fetch_uncached(url, mode, None, trace)


async def _fetch_uncached(
    url: str,
    mode: str,
    cache_key: str | None,
    trace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    settings = get_settings()
    deadline = time.monotonic() + settings.fetch_timeout_seconds
    max_attempts = max(1, settings.fetch_max_attempts)
    attempts = 0
    final_url = url
    truncated = False
    content_type = ""
    extractor = ""
    # Extraction is CPU-bound too, so it stays inside the slot: four concurrent pages are
    # already the limit for both downloading and parsing.
    try:
        # A single deadline covers queueing, redirects, response body and extraction.
        async with asyncio.timeout(settings.fetch_timeout_seconds):
            async with FETCH_SEMAPHORE:
                while True:
                    attempts += 1
                    try:
                        final_url, body, truncated, content_type = await _download(url, deadline)
                        break
                    except _RetryableFetch as exc:
                        if attempts >= max_attempts or deadline - time.monotonic() < 5:
                            raise exc.error from None
                        delay = min(1.0, max(0.25, exc.delay))
                        if deadline - time.monotonic() <= delay:
                            raise exc.error from None
                        await asyncio.sleep(delay)
                title, text, extractor = await asyncio.to_thread(_extract, body, final_url, mode, content_type)
    except TimeoutError:
        raise AppError(504, "fetch_timeout", "网页读取超时，已停止等待该页面。") from None
    except AppError:
        raise
    except httpx.ProxyError:
        raise AppError(502, "fetch_proxy_error", "上游代理不可用，请检查网络代理配置。") from None
    except httpx.TimeoutException:
        raise AppError(504, "fetch_timeout", "目标网页连接或传输超时。") from None
    except httpx.TransportError:
        raise AppError(502, "fetch_network_error", "无法连接目标网页，请稍后读取或更换来源。") from None

    if trace is not None:
        trace.update(
            {
                "attempts": attempts,
                "contentType": content_type,
                "finalUrl": final_url,
                "truncated": truncated,
                "extractor": extractor,
            }
        )
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
    if cache_key is not None:
        await cache_set(cache_key, json.dumps(result, ensure_ascii=False), ttl)
    return result


def ensure_mode(mode: str) -> str:
    if mode not in ("fast", "full"):
        raise invalid("mode 只能是 fast 或 full。")
    return mode
