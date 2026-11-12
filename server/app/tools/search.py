import asyncio
import hashlib
import json
import logging
import re
import time
import unicodedata
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qsl, urlsplit

import httpx
from charset_normalizer import from_bytes
from ddgs import DDGS
from ddgs.engines import ENGINES
from ddgs.engines.duckduckgo import Duckduckgo
from ddgs.exceptions import RatelimitException, TimeoutException

from app.cache import cache_get, cache_set
from app.config import get_settings
from app.errors import AppError
from app.tools.urls import canonical_result_key, normalize_search_url

logger = logging.getLogger(__name__)

CANDIDATE_LIMIT = 20
MAX_PER_DOMAIN = 2
MAX_TITLE_CHARS = 280
MAX_SNIPPET_CHARS = 640
CACHE_TTL_SECONDS = 300
SEARCH_SEMAPHORE = asyncio.Semaphore(4)
SEARCH_REGION = "wt-wt"
SEARCH_SAFESEARCH = "moderate"
# One in-flight task per query: a burst of identical searches (or a cache stampede when an
# entry expires) hits the providers once instead of once per caller.
_search_flights: dict[str, asyncio.Task[list[dict[str, Any]]]] = {}

BING_RSS = "https://www.bing.com/search"
BING_HEADERS = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
}

# A single client keeps the proxy tunnel and its TLS session alive between Bing requests. A
# fresh connection through the proxy can spend several seconds on the TLS handshake alone.
_bing_client: httpx.AsyncClient | None = None
_bing_client_proxy = ""
_bing_client_loop: asyncio.AbstractEventLoop | None = None


class _DuckDuckGoGet(Duckduckgo):
    """DuckDuckGo answers POSTs from many proxy addresses with HTTP 202 anomaly pages, while
    the same HTML endpoint still returns results for GET. Keep ddgs for proxying, parsing and
    ranking and only change the request method."""

    search_method = "GET"

    def request(self, *args: Any, **kwargs: Any) -> Any:  # noqa: ANN401
        response = self.http_client.request(*args, **kwargs)
        if response.status_code == 200:
            return response.text
        # 202 is DuckDuckGo's anomaly page, not a genuine empty result set.
        if response.status_code in (202, 403, 429):
            raise RatelimitException(f"DuckDuckGo returned HTTP {response.status_code}")
        return None


# ddgs freezes its engine registry at import time; replace the stock POST engine in this process.
ENGINES["text"]["duckduckgo"] = _DuckDuckGoGet


@dataclass
class ProviderOutcome:
    name: str
    status: str
    results: list[dict[str, Any]]
    attempts: int = 0
    elapsed_ms: int = 0
    error: str = ""


@dataclass
class _Breaker:
    failures: int = 0
    open_until: float = 0.0


# DuckDuckGo is a single process-wide dependency. After a few consecutive transport failures
# every search would otherwise spend its full ddgs budget before falling back to Bing.
_ddg_breaker = _Breaker()


def _bing_http_client() -> httpx.AsyncClient:
    global _bing_client, _bing_client_proxy, _bing_client_loop
    settings = get_settings()
    proxy = settings.web_tool_proxy_url or ""
    loop = asyncio.get_running_loop()
    if (
        _bing_client is None
        or _bing_client.is_closed
        or _bing_client_proxy != proxy
        or _bing_client_loop is not loop
    ):
        # A pooled connection belongs to the loop that opened it. Tests and a reload use a new
        # loop, so discard the old client instead of reusing its pool across loops.
        _bing_client = httpx.AsyncClient(
            timeout=httpx.Timeout(10.0, connect=5.0),
            # Bing redirects www.bing.com to the regional host (for example cn.bing.com) with
            # a 302; without following it every direct Bing request looks like a failure.
            follow_redirects=True,
            proxy=proxy or None,
            limits=httpx.Limits(
                max_connections=4,
                max_keepalive_connections=2,
                keepalive_expiry=300.0,
            ),
            headers={"User-Agent": settings.search_user_agent, **BING_HEADERS},
        )
        _bing_client_proxy = proxy
        _bing_client_loop = loop
    return _bing_client


async def close_bing_client() -> None:
    global _bing_client, _bing_client_proxy, _bing_client_loop
    client, _bing_client = _bing_client, None
    _bing_client_proxy = ""
    _bing_client_loop = None
    if client is not None and not client.is_closed:
        await client.aclose()


def _request_timeout(remaining: float) -> httpx.Timeout:
    total = max(0.5, remaining)
    # Through a proxy the TLS handshake alone can take several seconds. The surrounding
    # asyncio timeout already bounds the attempt, so let connect use the same budget instead
    # of a shorter cap that would reject an otherwise healthy cold connection.
    return httpx.Timeout(total)


def _exception_text(exc: BaseException) -> str:
    message = str(exc).strip()
    return f"{type(exc).__name__}: {message}" if message else type(exc).__name__


def _is_timeout_error(exc: BaseException) -> bool:
    return isinstance(exc, (TimeoutError, httpx.TimeoutException)) or "timed out" in str(exc).lower()


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
    request_timeout: httpx.Timeout,
    data: dict[str, str] | None = None,
    params: dict[str, str | int] | None = None,
) -> str:
    settings = get_settings()
    async with client.stream(method, url, data=data, params=params, timeout=request_timeout) as response:
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


def _ddgs_sync(query: str, timeout_seconds: int) -> list[dict[str, Any]]:
    settings = get_settings()
    # ddgs is synchronous and uses primp under the hood. It is called through to_thread.
    with DDGS(proxy=settings.web_tool_proxy_url or None, timeout=timeout_seconds) as client:
        return client.text(
            query,
            backend="duckduckgo",
            region=SEARCH_REGION,
            safesearch=SEARCH_SAFESEARCH,
            max_results=CANDIDATE_LIMIT,
        )


def _classify_ddgs_error(exc: BaseException) -> str:
    message = str(exc).lower()
    if isinstance(exc, RatelimitException) or any(
        token in message
        for token in (
            "rate limit", "ratelimit", "captcha", "challenge", "blocked", "unusual traffic",
            "anomaly", "http 202", "http 403", "http 429",
        )
    ):
        return "blocked"
    if isinstance(exc, TimeoutException) or isinstance(exc, TimeoutError) or "timed out" in message:
        return "timeout"
    if "no results found" in message:
        return "empty"
    return "error"


def _unwrap_ddg_url(raw: str) -> str:
    """Unwrap DuckDuckGo's protocol-relative /l/?uddg=... redirect links.

    ddgs usually returns the target URL, but the HTML endpoint sometimes returns
    //duckduckgo.com/l/?uddg=<target>. Without unwrapping, every such result fails URL
    normalization and the whole DuckDuckGo response looks empty.
    """
    value = raw.strip()
    if not value:
        return value
    parts = urlsplit(value if "://" in value else f"https:{value}")
    host = (parts.hostname or "").lower()
    is_duckduckgo = host == "duckduckgo.com" or host.endswith(".duckduckgo.com")
    if is_duckduckgo and parts.path.startswith("/l/"):
        target = dict(parse_qsl(parts.query)).get("uddg")
        if target:
            return target
    return f"https:{value}" if value.startswith("//") else value


def _normalize_ddgs_results(items: list[dict[str, Any]]) -> list[dict[str, Any]]:
    results: list[dict[str, Any]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        results.append(
            {
                "type": "organic",
                "url": _unwrap_ddg_url(str(item.get("href") or item.get("url") or "")),
                "title": str(item.get("title") or ""),
                "snippet": str(item.get("body") or item.get("snippet") or ""),
                "engine": "duckduckgo",
                "rank": len(results) + 1,
            }
        )
    return results


def _record_ddg_failure() -> None:
    settings = get_settings()
    if settings.search_breaker_failures <= 0:
        return
    _ddg_breaker.failures += 1
    if _ddg_breaker.failures >= settings.search_breaker_failures:
        _ddg_breaker.open_until = time.monotonic() + settings.search_breaker_cooldown_seconds


def _record_ddg_success() -> None:
    # An empty result set is still a successful upstream response.
    _ddg_breaker.failures = 0
    _ddg_breaker.open_until = 0.0


async def _ddg_search(query: str, deadline: float) -> ProviderOutcome:
    settings = get_settings()
    started = time.monotonic()
    if settings.search_breaker_failures > 0 and _ddg_breaker.open_until > started:
        return ProviderOutcome("duckduckgo", "skipped", [])

    max_attempts = max(1, settings.search_max_attempts)
    attempts = 0
    status = "timeout"
    error = ""

    while attempts < max_attempts:
        remaining = deadline - time.monotonic()
        # Keep a couple of seconds for Bing when the fallback is enabled.
        reserve = 2.0 if settings.search_fallback else 0.0
        cap = min(float(settings.search_ddgs_timeout_seconds), remaining - reserve)
        if cap < 1.0:
            error = "no time left for DuckDuckGo"
            break

        attempts += 1
        attempt_started = time.monotonic()
        try:
            raw = await asyncio.wait_for(
                asyncio.to_thread(_ddgs_sync, query, max(1, int(cap))),
                # The outer guard is bounded by the overall deadline as well.
                timeout=max(0.5, min(cap + 0.5, remaining)),
            )
        except Exception as exc:  # noqa: BLE001 - ddgs raises several transport types
            status = _classify_ddgs_error(exc)
            error = _exception_text(exc)
            elapsed = time.monotonic() - attempt_started
            if status == "empty":
                _record_ddg_success()
                return ProviderOutcome(
                    "duckduckgo", "empty", [], attempts,
                    round((time.monotonic() - started) * 1000),
                )
            # A timed-out to_thread cannot be stopped; retrying immediately would leave more
            # orphaned requests behind. Only a fast transport failure is worth one retry.
            if status == "blocked" or attempts >= max_attempts:
                break
            if elapsed >= 2.0 or (deadline - time.monotonic()) < 4.0:
                break
            continue

        results = _normalize_ddgs_results(raw)
        _record_ddg_success()
        return ProviderOutcome(
            "duckduckgo",
            "ok" if results else "empty",
            results,
            attempts,
            round((time.monotonic() - started) * 1000),
        )

    _record_ddg_failure()
    return ProviderOutcome(
        "duckduckgo", status, [], attempts,
        round((time.monotonic() - started) * 1000), error,
    )


async def _bing_search(query: str, deadline: float) -> ProviderOutcome:
    settings = get_settings()
    started = time.monotonic()
    max_attempts = max(1, settings.search_max_attempts)
    attempts = 0
    status = "timeout"
    error = ""

    while attempts < max_attempts:
        remaining = deadline - time.monotonic()
        if remaining < 0.5:
            error = error or "no time left for Bing"
            break
        attempts += 1
        try:
            async with asyncio.timeout(remaining):
                page = await _request_text(
                    _bing_http_client(),
                    "GET",
                    BING_RSS,
                    request_timeout=_request_timeout(remaining),
                    params={"format": "rss", "count": CANDIDATE_LIMIT, "q": query},
                )
                results = await asyncio.to_thread(_parse_bing_rss, page)
        except Exception as exc:  # noqa: BLE001 - the fallback never blocks the primary result
            status = "timeout" if _is_timeout_error(exc) else "error"
            error = _exception_text(exc)
            remaining = deadline - time.monotonic()
            # A dropped proxy connection is often transient. Retry only transport failures and
            # only when the remaining budget can fit another attempt.
            if not isinstance(exc, (TimeoutError, httpx.TransportError)):
                break
            if attempts >= max_attempts or remaining < 1.0:
                break
            await asyncio.sleep(min(0.25 * attempts, 0.5, remaining - 0.5))
            continue
        return ProviderOutcome(
            "bing",
            "ok" if results else "empty",
            results,
            attempts,
            round((time.monotonic() - started) * 1000),
        )

    return ProviderOutcome(
        "bing", status, [], attempts,
        round((time.monotonic() - started) * 1000), error,
    )


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


def _query_terms(query: str) -> list[str]:
    query = unicodedata.normalize("NFKC", query).casefold()
    query = re.sub(r"(?:^|\s)(?:site|filetype|inurl|intitle):\S+", " ", query)
    stop_words = {"the", "what", "how", "when", "where", "which", "who", "about", "latest"}
    terms = []
    for word in re.findall(r"[a-z0-9][a-z0-9_.+-]*|[\u3400-\u9fff]+", query):
        if len(word) < 2 or word in stop_words:
            continue
        # Chinese queries rarely have spaces; adjacent pairs preserve subject overlap
        # without adding a tokenizer dependency or treating a whole sentence as one term.
        terms.extend([word] if word.isascii() or len(word) <= 2 else
                     [word[index:index + 2] for index in range(len(word) - 1)])
    return list(dict.fromkeys(terms))[:32]


def _rank_relevant(query: str, results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    terms = _query_terms(query)
    if not terms:
        return results

    def score(result: dict[str, Any]) -> int:
        title, domain, snippet = (
            unicodedata.normalize("NFKC", result[key]).casefold() for key in ("title", "domain", "snippet")
        )
        return sum(3 if term in title else 2 if term in domain else 1 if term in snippet else 0 for term in terms)

    # Stable ties keep provider ranking; lexical overlap is advisory, not proof.
    return sorted(results, key=score, reverse=True)


def _prepare(query: str, raw_results: list[dict[str, Any]], limit: int) -> list[dict[str, Any]]:
    normalized = [
        item
        for index, result in enumerate(raw_results[:CANDIDATE_LIMIT])
        if isinstance(result, dict) and (item := _normalize_result(result, index)) is not None
    ]
    return _select_diverse(_rank_relevant(query, _dedupe(normalized)), limit)


def _forget_flight(key: str, task: asyncio.Task) -> None:
    if _search_flights.get(key) is task:
        _search_flights.pop(key, None)
    # A cancelled caller can leave the shared task unawaited; retrieve its exception so the
    # event loop does not log an unhandled failure for work that already has other waiters.
    if not task.cancelled():
        task.exception()


async def web_search(
    query: str,
    limit: int,
    *,
    trace: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    cache_key = "matrius:search:v2:" + hashlib.sha256(f"{query}|{limit}".encode()).hexdigest()
    # The admin test needs real provider timings, so a trace request bypasses the cache and
    # the shared single-flight task. Normal tool calls keep both.
    if trace is None:
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
    return await _search_uncached(query, limit, None, trace)


async def web_search_many(
    queries: list[str],
    limit: int,
    *,
    trace: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Search several related queries in one tool call and merge the unique results.

    A single query keeps the exact old path (and cache key). Multiple queries run concurrently;
    the merged list is deduplicated by canonical URL and re-ranked against all query terms so
    one call can supply enough candidates for a batch page read.
    """
    normalized: list[str] = []
    seen: set[str] = set()
    for query in queries:
        value = query.strip()
        if value and value not in seen:
            seen.add(value)
            normalized.append(value)
    if not normalized:
        return []
    if len(normalized) == 1:
        return await web_search(normalized[0], limit, trace=trace)

    per_query_limit = max(10, min(CANDIDATE_LIMIT, limit))
    settled = await asyncio.gather(
        *(web_search(query, per_query_limit) for query in normalized),
        return_exceptions=True,
    )
    merged: list[dict[str, Any]] = []
    failures: list[BaseException] = []
    for outcome in settled:
        if isinstance(outcome, BaseException):
            failures.append(outcome)
        else:
            merged.extend(outcome)

    if not merged and failures and len(failures) == len(normalized):
        raise failures[0]

    if trace is not None:
        trace.update({"queries": normalized, "failedQueries": len(failures)})
    return _select_diverse(_rank_relevant(" ".join(normalized), _dedupe(merged)), limit)


async def _search_uncached(
    query: str,
    limit: int,
    cache_key: str | None,
    trace: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    settings = get_settings()
    results: list[dict[str, Any]] = []
    outcomes: list[ProviderOutcome] = []

    async with SEARCH_SEMAPHORE:
        # Queueing for a global slot does not consume the upstream budget.
        deadline = time.monotonic() + settings.search_timeout_seconds
        primary = await _ddg_search(query, deadline)
        outcomes.append(primary)
        if primary.status == "ok":
            results = _prepare(query, primary.results, limit)
        # Bing only runs when DuckDuckGo failed, was skipped, or produced no usable results.
        if not results and settings.search_fallback and time.monotonic() < deadline - 0.5:
            fallback = await _bing_search(query, deadline)
            outcomes.append(fallback)
            if fallback.status == "ok":
                results = _prepare(query, fallback.results, limit)

    if trace is not None:
        primary = outcomes[0]
        fallback = outcomes[1] if len(outcomes) > 1 else None
        trace.update(
            {
                "provider": primary.name,
                "status": primary.status,
                "attempts": primary.attempts,
                "elapsedMs": primary.elapsed_ms,
                "fallback": fallback is not None,
                "fallbackStatus": fallback.status if fallback else None,
                "fallbackAttempts": fallback.attempts if fallback else 0,
                "fallbackElapsedMs": fallback.elapsed_ms if fallback else 0,
            }
        )
        if primary.error:
            trace["error"] = primary.error[:300]
        if fallback is not None and fallback.error:
            trace["fallbackError"] = fallback.error[:300]

    if not results:
        # A reachable provider that simply returned nothing is not an outage. Only an outage
        # when every source we actually tried failed; the old logic raised 502 here whenever
        # one source failed and another returned zero results.
        if any(outcome.status in ("ok", "empty") for outcome in outcomes):
            return []
        raise AppError(502, "upstream_error", "联网服务暂时不可用，请稍后重试。")

    # A degraded empty response may be transient; do not poison the next search for 5 minutes.
    if cache_key is not None:
        await cache_set(cache_key, json.dumps(results, ensure_ascii=False), CACHE_TTL_SECONDS)
    return results
