import asyncio
import hashlib
import json
import logging
import xml.etree.ElementTree as ET
from typing import Any
from urllib.parse import parse_qs, urlsplit

import httpx
from charset_normalizer import from_bytes
from lxml import html as lxml_html

from app.cache import cache_get, cache_set
from app.config import get_settings
from app.errors import AppError
from app.tools.urls import canonical_result_key, normalize_search_url

logger = logging.getLogger(__name__)

SEARCH_ENGINES = "duckduckgo,bing"
CANDIDATE_LIMIT = 20
MAX_PER_DOMAIN = 2
MAX_TITLE_CHARS = 280
MAX_SNIPPET_CHARS = 640
CACHE_TTL_SECONDS = 300
SEARCH_SEMAPHORE = asyncio.Semaphore(4)
# One in-flight task per query: a burst of identical searches (or a cache stampede when an
# entry expires) hits the providers once instead of once per caller.
_search_flights: dict[str, asyncio.Task[list[dict[str, Any]]]] = {}

DUCKDUCKGO_HTML = "https://html.duckduckgo.com/html/"
DUCKDUCKGO_LITE = "https://lite.duckduckgo.com/lite/"
BING_RSS = "https://www.bing.com/search"


def _client() -> httpx.AsyncClient:
    settings = get_settings()
    return httpx.AsyncClient(
        timeout=httpx.Timeout(settings.search_timeout_seconds, connect=5),
        # Bing redirects www.bing.com to the regional host (for example cn.bing.com) with a 302;
        # without following it every direct Bing request looks like an upstream failure.
        follow_redirects=True,
        proxy=settings.web_tool_proxy_url or None,
        headers={
            "User-Agent": settings.search_user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )


def _decode(body: bytes, encoding: str | None) -> str:
    if encoding:
        try:
            return body.decode(encoding)
        except (LookupError, UnicodeDecodeError):
            pass
    best = from_bytes(body).best()
    return str(best) if best is not None else body.decode("utf-8", errors="replace")


async def _request_text(
    client: httpx.AsyncClient,
    method: str,
    url: str,
    *,
    data: dict[str, str] | None = None,
    params: dict[str, str | int] | None = None,
) -> str:
    settings = get_settings()
    async with client.stream(method, url, data=data, params=params) as response:
        if response.status_code >= 300:
            raise RuntimeError(f"{url} returned HTTP {response.status_code}")
        chunks: list[bytes] = []
        total = 0
        async for chunk in response.aiter_bytes():
            total += len(chunk)
            if total > settings.search_max_bytes:
                raise RuntimeError(f"{url} returned more than {settings.search_max_bytes} bytes")
            chunks.append(chunk)
        return _decode(b"".join(chunks), response.charset_encoding)


def _unwrap_duckduckgo(href: str) -> str:
    if href.startswith("//"):
        href = f"https:{href}"
    parts = urlsplit(href)
    host = (parts.hostname or "").lower()
    if host.endswith("duckduckgo.com") and parts.path.startswith("/l/"):
        target = parse_qs(parts.query).get("uddg")
        if target:
            return target[0]
    return href


def _text(node) -> str:
    return " ".join(node.text_content().split()).strip()


def _parse_duckduckgo(html: str) -> list[dict[str, Any]]:
    tree = lxml_html.fromstring(html)
    results: list[dict[str, Any]] = []
    for anchor in tree.xpath("//a[contains(@class, 'result__a')]"):
        containers = anchor.xpath("ancestor::div[contains(@class, 'result')][1]")
        snippet = ""
        if containers:
            snippets = containers[0].xpath(".//*[contains(@class, 'result__snippet')]")
            if snippets:
                snippet = _text(snippets[0])
        results.append(
            {
                "type": "organic",
                "url": _unwrap_duckduckgo(anchor.get("href") or ""),
                "title": _text(anchor),
                "snippet": snippet,
                "engine": "duckduckgo",
                "rank": len(results) + 1,
            }
        )
    return results


def _parse_duckduckgo_lite(html: str) -> list[dict[str, Any]]:
    tree = lxml_html.fromstring(html)
    results: list[dict[str, Any]] = []
    for anchor in tree.xpath("//a[contains(@class, 'result-link')]"):
        rows = anchor.xpath("ancestor::tr[1]/following-sibling::tr[1]")
        snippet = ""
        if rows:
            cells = rows[0].xpath(".//*[contains(@class, 'result-snippet')]")
            if cells:
                snippet = _text(cells[0])
        results.append(
            {
                "type": "organic",
                "url": _unwrap_duckduckgo(anchor.get("href") or ""),
                "title": _text(anchor),
                "snippet": snippet,
                "engine": "duckduckgo",
                "rank": len(results) + 1,
            }
        )
    return results


def _parse_bing_rss(xml: str) -> list[dict[str, Any]]:
    root = ET.fromstring(xml)
    results: list[dict[str, Any]] = []
    for item in root.iter("item"):
        results.append(
            {
                "type": "organic",
                "url": (item.findtext("link") or "").strip(),
                "title": (item.findtext("title") or "").strip(),
                "snippet": " ".join((item.findtext("description") or "").split()),
                "engine": "bing",
                "rank": len(results) + 1,
            }
        )
    return results


async def _duckduckgo(client: httpx.AsyncClient, query: str) -> list[dict[str, Any]]:
    try:
        page = await _request_text(client, "POST", DUCKDUCKGO_HTML, data={"q": query})
        # Parsing large HTML is CPU work; keep it off the event loop so other searches and
        # chat requests keep flowing while this one is being decoded.
        results = await asyncio.to_thread(_parse_duckduckgo, page)
        if results:
            return results
    except Exception as exc:  # noqa: BLE001 - fall through to the lite endpoint
        logger.warning("DuckDuckGo HTML search failed: %s", exc)
    page = await _request_text(client, "POST", DUCKDUCKGO_LITE, data={"q": query})
    return await asyncio.to_thread(_parse_duckduckgo_lite, page)


async def _bing(client: httpx.AsyncClient, query: str) -> list[dict[str, Any]]:
    page = await _request_text(
        client,
        "GET",
        BING_RSS,
        params={"format": "rss", "count": CANDIDATE_LIMIT, "q": query},
    )
    return await asyncio.to_thread(_parse_bing_rss, page)


def _clean_text(value: str) -> str:
    return " ".join(value.split()).strip()


def _truncate(value: str, limit: int) -> str:
    value = _clean_text(value)
    return value if len(value) <= limit else f"{value[:limit].rstrip()}…"


def _rank_of(result: dict[str, Any], fallback: int) -> int:
    rank = result.get("rank")
    if rank is None:
        position = result.get("position")
        if isinstance(position, dict):
            rank = position.get("absolute") or position.get("relative")
        elif isinstance(position, int):
            rank = position
    try:
        return max(1, int(rank))
    except (TypeError, ValueError):
        return fallback


def _normalize_result(result: dict[str, Any], index: int) -> dict[str, Any] | None:
    if result.get("type") not in (None, "organic"):
        return None
    url = normalize_search_url(str(result.get("url") or ""))
    if url is None:
        return None
    hostname = (urlsplit(url).hostname or "").removeprefix("www.")
    title = _truncate(str(result.get("title") or result.get("display_url") or url), MAX_TITLE_CHARS)
    snippet = _truncate(str(result.get("snippet") or result.get("description") or ""), MAX_SNIPPET_CHARS)
    return {
        "title": title,
        "url": url,
        "snippet": snippet,
        "domain": str(result.get("domain") or hostname).removeprefix("www."),
        "engine": str(result.get("engine") or "").strip(),
        "rank": _rank_of(result, index + 1),
    }


def _dedupe(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    for result in results:
        key = canonical_result_key(result["url"])
        existing = merged.get(key)
        if existing is None:
            merged[key] = result
            continue
        engines = {item for item in f"{existing['engine']},{result['engine']}".split(",") if item}
        existing["engine"] = ",".join(sorted(engines))
        existing["rank"] = min(existing["rank"], result["rank"])
        if len(result["snippet"]) > len(existing["snippet"]):
            existing["snippet"] = result["snippet"]
        if len(result["title"]) > len(existing["title"]):
            existing["title"] = result["title"]
        if result["url"].startswith("https://") and not existing["url"].startswith("https://"):
            existing["url"] = result["url"]
    return sorted(merged.values(), key=lambda item: (item["rank"], item["title"]))


def _select_diverse(results: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    selected: list[dict[str, Any]] = []
    deferred: list[dict[str, Any]] = []
    counts: dict[str, int] = {}
    for result in results:
        domain = result["domain"].lower()
        if counts.get(domain, 0) >= MAX_PER_DOMAIN:
            deferred.append(result)
            continue
        selected.append(result)
        counts[domain] = counts.get(domain, 0) + 1
        if len(selected) >= limit:
            return selected
    return [*selected, *deferred][:limit]


async def _run_provider(coro, seconds: float):
    async with asyncio.timeout(seconds):
        return await coro


def _forget_flight(key: str, task: asyncio.Task) -> None:
    if _search_flights.get(key) is task:
        _search_flights.pop(key, None)
    # A cancelled caller can leave the shared task unawaited; retrieve its exception so the
    # event loop does not log an unhandled failure for work that already has other waiters.
    if not task.cancelled():
        task.exception()


async def web_search(query: str, limit: int) -> list[dict[str, Any]]:
    cache_key = "matrius:search:" + hashlib.sha256(f"{query}|{limit}".encode()).hexdigest()
    cached = await cache_get(cache_key)
    if cached is not None:
        try:
            return json.loads(cached)
        except ValueError:
            pass

    flight = _search_flights.get(cache_key)
    if flight is None:
        flight = asyncio.create_task(_search_uncached(query, limit, cache_key))
        _search_flights[cache_key] = flight
        flight.add_done_callback(lambda task, key=cache_key: _forget_flight(key, task))
    # Shield the shared task: one cancelled request must not cancel the search everyone else
    # is waiting on. The task still populates the cache in that case.
    return await asyncio.shield(flight)


async def _search_uncached(query: str, limit: int, cache_key: str) -> list[dict[str, Any]]:
    settings = get_settings()
    async with SEARCH_SEMAPHORE:
        async with _client() as client:
            outcomes = await asyncio.gather(
                _run_provider(_duckduckgo(client, query), settings.search_timeout_seconds),
                _run_provider(_bing(client, query), settings.search_timeout_seconds),
                return_exceptions=True,
            )

    raw_results: list[dict[str, Any]] = []
    failures = 0
    for outcome in outcomes:
        if isinstance(outcome, asyncio.CancelledError):
            raise outcome
        if isinstance(outcome, BaseException):
            failures += 1
            logger.warning("Search provider failed: %s", outcome)
            continue
        raw_results.extend(outcome)

    if failures == len(outcomes):
        raise AppError(502, "upstream_error", "联网服务暂时不可用，请稍后重试。")

    normalized = [
        item
        for index, result in enumerate(raw_results[: CANDIDATE_LIMIT * 2])
        if isinstance(result, dict) and (item := _normalize_result(result, index)) is not None
    ]
    results = _select_diverse(_dedupe(normalized), limit)
    await cache_set(cache_key, json.dumps(results, ensure_ascii=False), CACHE_TTL_SECONDS)
    return results
