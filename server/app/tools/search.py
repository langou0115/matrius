import asyncio
import hashlib
import json
import logging
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.config import get_settings
from app.errors import AppError
from app.redis import cache_get, cache_set
from app.tools.urls import canonical_result_key, normalize_search_url

logger = logging.getLogger(__name__)

SEARCH_ENGINES = "duckduckgo,bing,baidu"
CANDIDATE_LIMIT = 20
MAX_PER_DOMAIN = 2
MAX_TITLE_CHARS = 280
MAX_SNIPPET_CHARS = 640
CACHE_TTL_SECONDS = 300
SEARCH_SEMAPHORE = asyncio.Semaphore(4)


def _headers() -> dict[str, str]:
    settings = get_settings()
    headers = {"Accept": "application/json"}
    if settings.openserp_proxy_url:
        headers["X-Proxy-URL"] = settings.openserp_proxy_url
    elif settings.openserp_proxy_tag:
        headers["X-Use-Proxy"] = settings.openserp_proxy_tag
    return headers


async def request_openserp(path: str, params: dict[str, Any]) -> Any:
    settings = get_settings()
    url = f"{settings.openserp_url.rstrip('/')}{path}"
    try:
        async with httpx.AsyncClient(timeout=45) as client:
            response = await client.get(url, params=params, headers=_headers())
    except httpx.HTTPError as exc:
        logger.warning("OpenSERP request failed: %s", path, exc_info=True)
        raise AppError(502, "upstream_error", "联网服务暂时不可用，请稍后重试。") from exc

    if response.status_code >= 400:
        logger.warning(
            "OpenSERP returned %s for %s: %s", response.status_code, path, response.text[:500]
        )
        raise AppError(502, "upstream_error", "联网服务暂时不可用，请稍后重试。")
    try:
        return response.json()
    except ValueError as exc:
        raise AppError(502, "upstream_error", "联网服务返回了无效数据。") from exc


def _truncate(value: str, limit: int) -> str:
    value = depth_clean(value)
    return value if len(value) <= limit else f"{value[:limit].rstrip()}…"


def depth_clean(value: str) -> str:
    return " ".join(value.split()).strip()


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


async def web_search(query: str, limit: int) -> list[dict[str, Any]]:
    cache_key = "matrius:search:" + hashlib.sha256(f"{query}|{limit}".encode()).hexdigest()
    cached = await cache_get(cache_key)
    if cached is not None:
        try:
            return json.loads(cached)
        except ValueError:
            pass

    params = {
        "dedupe": "true",
        "engines": SEARCH_ENGINES,
        "features": "false",
        "format": "json",
        "limit": CANDIDATE_LIMIT,
        "merge": "false",
        "mode": "any",
        "text": query,
    }
    async with SEARCH_SEMAPHORE:
        payload = await request_openserp("/mega/search", params)

    raw_results = payload.get("results") if isinstance(payload, dict) else payload
    if not isinstance(raw_results, list):
        raise AppError(502, "upstream_error", "联网服务返回了无效数据。")

    normalized = [
        item
        for index, result in enumerate(raw_results)
        if isinstance(result, dict) and (item := _normalize_result(result, index)) is not None
    ]
    results = _select_diverse(_dedupe(normalized), limit)
    await cache_set(cache_key, json.dumps(results, ensure_ascii=False), CACHE_TTL_SECONDS)
    return results
