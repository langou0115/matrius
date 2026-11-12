import asyncio
import hashlib
import json
import time
from types import SimpleNamespace

import httpx
import pytest
from ddgs.engines import ENGINES
from ddgs.exceptions import RatelimitException, TimeoutException
from pydantic import ValidationError

from app import cache
from app.errors import AppError
from app.tools import search
from app.tools.schemas import SearchRequest

BING_RSS = """
<rss><channel>
  <item><title>Bing Result</title><link>https://example.org/page</link>
    <description>Some   spaced description</description></item>
  <item><title>Second</title><link>https://example.net/other</link><description>Other</description></item>
</channel></rss>
"""


def make_settings(**overrides):
    values = {
        "search_timeout_seconds": 8,
        "search_ddgs_timeout_seconds": 4,
        "search_max_attempts": 2,
        "search_fallback": True,
        "search_breaker_failures": 3,
        "search_breaker_cooldown_seconds": 60,
        "search_max_bytes": 2 * 1024 * 1024,
        "web_tool_proxy_url": "",
        "search_user_agent": "Matrius test",
    }
    values.update(overrides)
    return SimpleNamespace(**values)


@pytest.fixture(autouse=True)
def reset_breaker():
    search._ddg_breaker.failures = 0
    search._ddg_breaker.open_until = 0.0
    yield
    search._ddg_breaker.failures = 0
    search._ddg_breaker.open_until = 0.0


@pytest.fixture(autouse=True)
def reset_bing_client():
    # Each test runs in its own event loop, so a pooled client cannot be reused across tests.
    search._bing_client = None
    search._bing_client_proxy = ""
    search._bing_client_loop = None
    yield
    search._bing_client = None
    search._bing_client_proxy = ""
    search._bing_client_loop = None


@pytest.fixture
def settings(monkeypatch):
    current = make_settings()
    monkeypatch.setattr(search, "get_settings", lambda: current)
    return current


def ddg_result(title="Python docs", url="https://docs.python.org/3/", body="Official documentation"):
    return {"title": title, "href": url, "body": body}


def test_ddgs_results_map_title_href_and_body():
    results = search._normalize_ddgs_results([
        ddg_result(),
        {"title": "Example", "href": "https://example.com/page", "body": "Snippet"},
        "not a mapping",
    ])
    assert results == [
        {"type": "organic", "url": "https://docs.python.org/3/", "title": "Python docs",
         "snippet": "Official documentation", "engine": "duckduckgo", "rank": 1},
        {"type": "organic", "url": "https://example.com/page", "title": "Example",
         "snippet": "Snippet", "engine": "duckduckgo", "rank": 2},
    ]


def test_ddgs_redirect_links_are_unwrapped():
    results = search._normalize_ddgs_results([
        {"title": "Target", "href": "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fid%3D1&rut=abc"},
        {"title": "Absolute", "href": "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fother"},
        {"title": "Plain", "href": "//example.net/plain"},
    ])
    assert [item["url"] for item in results] == [
        "https://example.com/page?id=1",
        "https://example.org/other",
        "https://example.net/plain",
    ]


def test_bing_rss_parser_collapses_whitespace():
    results = search._parse_bing_rss(BING_RSS)
    assert [(item["title"], item["url"], item["snippet"]) for item in results] == [
        ("Bing Result", "https://example.org/page", "Some spaced description"),
        ("Second", "https://example.net/other", "Other"),
    ]
    assert all(item["engine"] == "bing" for item in results)


async def test_bing_retries_a_transient_transport_failure(settings, monkeypatch):
    calls = []

    async def flaky(_client, _method, _url, **_kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise httpx.ConnectError("proxy tunnel dropped")
        return BING_RSS

    monkeypatch.setattr(search, "_request_text", flaky)
    outcome = await search._bing_search("python", time.monotonic() + 8)

    assert outcome.status == "ok"
    assert outcome.attempts == 2
    assert len(calls) == 2


async def test_bing_does_not_retry_an_http_error(settings, monkeypatch):
    calls = []

    async def fail(*_args, **_kwargs):
        calls.append(1)
        raise RuntimeError("https://www.bing.com/search returned HTTP 404")

    monkeypatch.setattr(search, "_request_text", fail)
    outcome = await search._bing_search("python", time.monotonic() + 8)

    assert outcome.status == "error"
    assert outcome.attempts == 1
    assert "HTTP 404" in outcome.error
    assert len(calls) == 1


def test_bing_connect_timeout_uses_the_remaining_budget():
    request_timeout = search._request_timeout(7.5)
    assert request_timeout.connect == 7.5
    assert request_timeout.read == 7.5


async def test_bing_timeout_without_a_message_is_still_traceable(settings, monkeypatch):
    async def fail(*_args, **_kwargs):
        raise httpx.ConnectTimeout("")

    monkeypatch.setattr(search, "_request_text", fail)
    outcome = await search._bing_search("python", time.monotonic() + 8)

    assert outcome.status == "timeout"
    assert outcome.error == "ConnectTimeout"


@pytest.mark.parametrize("error,status", [
    (RatelimitException("slow down"), "blocked"),
    (RuntimeError("unusual traffic detected"), "blocked"),
    (RuntimeError("DuckDuckGo returned HTTP 202"), "blocked"),
    (TimeoutException("request timed out"), "timeout"),
    (TimeoutError(), "timeout"),
    (RuntimeError("No results found."), "empty"),
    (RuntimeError("tls handshake eof"), "error"),
])
def test_ddgs_errors_are_classified(error, status):
    assert search._classify_ddgs_error(error) == status


def test_ddgs_client_uses_the_configured_proxy(settings, monkeypatch):
    settings.web_tool_proxy_url = "http://proxy.internal:3128"
    captured = {}

    class FakeDDGS:
        def __init__(self, **kwargs):
            captured["init"] = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def text(self, query, **kwargs):
            captured["text"] = (query, kwargs)
            return [ddg_result()]

    monkeypatch.setattr(search, "DDGS", FakeDDGS)
    results = search._ddgs_sync("python docs", 5)

    assert results == [ddg_result()]
    assert captured["init"] == {"proxy": "http://proxy.internal:3128", "timeout": 5}
    query, kwargs = captured["text"]
    assert query == "python docs"
    assert kwargs["backend"] == "duckduckgo"
    assert kwargs["region"] == search.SEARCH_REGION
    assert kwargs["safesearch"] == search.SEARCH_SAFESEARCH
    assert kwargs["max_results"] == search.CANDIDATE_LIMIT


def test_ddgs_client_connects_directly_without_a_proxy(settings, monkeypatch):
    captured = {}

    class FakeDDGS:
        def __init__(self, **kwargs):
            captured["init"] = kwargs

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def text(self, *_args, **_kwargs):
            return []

    monkeypatch.setattr(search, "DDGS", FakeDDGS)
    search._ddgs_sync("python docs", 5)
    assert captured["init"]["proxy"] is None


def test_duckduckgo_engine_uses_get():
    # DuckDuckGo returns HTTP 202 anomaly pages for POSTs from many proxies but still answers
    # GET on the same endpoint.
    engine = ENGINES["text"]["duckduckgo"]
    assert engine is search._DuckDuckGoGet
    assert engine.search_method == "GET"


def test_duckduckgo_202_is_reported_as_blocked():
    class Response:
        status_code = 202
        text = "anomaly"

    class FakeHttpClient:
        def request(self, *_args, **_kwargs):
            return Response()

    engine = search._DuckDuckGoGet(timeout=1)
    engine.http_client = FakeHttpClient()
    with pytest.raises(RatelimitException, match="HTTP 202"):
        engine.request("GET", "https://html.duckduckgo.com/html/")


def test_normalization_rejects_non_web_results_and_strips_tracking():
    result = search._normalize_result({
        "type": "organic",
        "url": "https://www.example.com/page?utm_source=feed&id=1",
        "title": "  Title   with space ",
        "snippet": "Snippet",
        "engine": "duckduckgo",
        "rank": 4,
    }, 0)
    assert result == {
        "title": "Title with space",
        "url": "https://www.example.com/page?id=1",
        "snippet": "Snippet",
        "domain": "example.com",
        "engine": "duckduckgo",
        "rank": 4,
    }
    assert search._normalize_result({"type": "ads", "url": "https://example.com"}, 0) is None
    assert search._normalize_result({"url": "ftp://example.com/file"}, 0) is None


def test_dedupe_merges_engines_and_prefers_https():
    merged = search._dedupe([
        {"title": "Short", "url": "http://example.com/a", "snippet": "", "domain": "example.com",
         "engine": "duckduckgo", "rank": 3},
        {"title": "A longer title", "url": "https://example.com/a/", "snippet": "More detail",
         "domain": "example.com", "engine": "bing", "rank": 1},
    ])
    assert merged == [{
        "title": "A longer title",
        "url": "https://example.com/a/",
        "snippet": "More detail",
        "domain": "example.com",
        "engine": "bing,duckduckgo",
        "rank": 1,
    }]


def test_diverse_selection_defers_repeated_domains():
    results = [
        {"title": "A1", "url": "https://a.com/1", "snippet": "", "domain": "a.com", "engine": "ddg", "rank": 1},
        {"title": "A2", "url": "https://a.com/2", "snippet": "", "domain": "a.com", "engine": "ddg", "rank": 2},
        {"title": "A3", "url": "https://a.com/3", "snippet": "", "domain": "a.com", "engine": "ddg", "rank": 3},
        {"title": "B1", "url": "https://b.com/1", "snippet": "", "domain": "b.com", "engine": "ddg", "rank": 4},
    ]
    assert [item["title"] for item in search._select_diverse(results, 4)] == ["A1", "A2", "B1", "A3"]
    assert [item["title"] for item in search._select_diverse(results, 2)] == ["A1", "A2"]


@pytest.mark.parametrize("query,title", [
    ("Python asyncio TaskGroup", "Python asyncio TaskGroup documentation"),
    ("如何配置联网搜索", "配置联网搜索的说明"),
])
def test_relevant_document_beats_generic_homepage(query, title):
    results = [
        {"title": "Python homepage", "snippet": "Downloads", "domain": "python.org", "rank": 1},
        {"title": title, "snippet": "", "domain": "docs.example.com", "rank": 5},
    ]
    assert search._rank_relevant(query, results)[0]["title"] == title


async def test_fast_ddgs_failure_is_retried(settings, monkeypatch):
    settings.search_max_attempts = 2
    calls = []

    def fail(_query, _timeout):
        calls.append(1)
        raise RuntimeError("tls handshake eof")

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    outcome = await search._ddg_search("python", time.monotonic() + 8)

    assert outcome.status == "error"
    assert outcome.attempts == 2
    assert len(calls) == 2


async def test_blocked_ddgs_is_not_retried(settings, monkeypatch):
    settings.search_max_attempts = 3
    calls = []

    def fail(_query, _timeout):
        calls.append(1)
        raise RatelimitException("slow down")

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    outcome = await search._ddg_search("python", time.monotonic() + 8)

    assert outcome.status == "blocked"
    assert outcome.attempts == 1
    assert len(calls) == 1


async def test_ddgs_is_skipped_when_the_budget_is_too_small(settings, monkeypatch):
    called = []
    monkeypatch.setattr(search, "_ddgs_sync", lambda *_args: called.append(1))
    outcome = await search._ddg_search("python", time.monotonic() + 0.2)

    assert outcome.status == "timeout"
    assert outcome.attempts == 0
    assert called == []


async def test_breaker_skips_ddgs_after_consecutive_failures(settings, monkeypatch):
    settings.search_max_attempts = 1
    settings.search_breaker_failures = 2
    calls = []

    def fail(_query, _timeout):
        calls.append(1)
        raise RuntimeError("tls handshake eof")

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    for _ in range(2):
        outcome = await search._ddg_search("python", time.monotonic() + 8)
        assert outcome.status == "error"
    assert search._ddg_breaker.open_until > time.monotonic()

    skipped = await search._ddg_search("python", time.monotonic() + 8)
    assert skipped.status == "skipped"
    assert skipped.attempts == 0
    assert len(calls) == 2


async def test_empty_ddgs_response_resets_the_breaker(settings, monkeypatch):
    search._ddg_breaker.failures = 2
    search._ddg_breaker.open_until = time.monotonic() + 60

    def empty(_query, _timeout):
        raise RuntimeError("No results found.")

    monkeypatch.setattr(search, "_ddgs_sync", empty)
    # Open circuits short-circuit before calling the provider; close it to exercise recovery.
    search._ddg_breaker.open_until = 0.0
    outcome = await search._ddg_search("python", time.monotonic() + 8)

    assert outcome.status == "empty"
    assert search._ddg_breaker.failures == 0
    assert search._ddg_breaker.open_until == 0.0


async def test_successful_ddgs_never_calls_bing(settings, monkeypatch):
    calls = []
    monkeypatch.setattr(search, "_ddgs_sync", lambda *_args: [ddg_result()])

    async def bing(_query, _deadline):
        calls.append("bing")
        return search.ProviderOutcome("bing", "ok", [])

    monkeypatch.setattr(search, "_bing_search", bing)
    results = await search._search_uncached("python docs", 5, None)

    assert calls == []
    assert results[0]["engine"] == "duckduckgo"
    assert results[0]["url"] == "https://docs.python.org/3/"


async def test_empty_ddgs_falls_back_to_bing(settings, monkeypatch):
    monkeypatch.setattr(search, "_ddgs_sync", lambda *_args: [])
    fallback = search.ProviderOutcome("bing", "ok", [
        {"type": "organic", "url": "https://example.com/answer", "title": "Answer",
         "snippet": "From Bing", "engine": "bing", "rank": 1},
    ])

    async def bing(_query, _deadline):
        return fallback

    monkeypatch.setattr(search, "_bing_search", bing)
    results = await search._search_uncached("fallback", 3, None)

    assert [(item["title"], item["engine"]) for item in results] == [("Answer", "bing")]


async def test_failed_ddgs_falls_back_to_bing(settings, monkeypatch):
    settings.search_max_attempts = 1

    def fail(_query, _timeout):
        raise RuntimeError("tls handshake eof")

    monkeypatch.setattr(search, "_ddgs_sync", fail)

    async def bing(_query, _deadline):
        return search.ProviderOutcome("bing", "ok", [
            {"type": "organic", "url": "https://example.com/answer", "title": "Answer",
             "snippet": "", "engine": "bing", "rank": 1},
        ])

    monkeypatch.setattr(search, "_bing_search", bing)
    results = await search._search_uncached("fallback", 3, None)
    assert [item["engine"] for item in results] == ["bing"]


async def test_ddgs_failure_with_empty_bing_is_empty_not_502(settings, monkeypatch):
    settings.search_max_attempts = 1

    def fail(_query, _timeout):
        raise RuntimeError("tls handshake eof")

    async def bing(_query, _deadline):
        return search.ProviderOutcome("bing", "empty", [])

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    monkeypatch.setattr(search, "_bing_search", bing)
    assert await search._search_uncached("nothing", 3, None) == []


async def test_all_providers_failing_raises_502(settings, monkeypatch):
    settings.search_max_attempts = 1

    def fail(_query, _timeout):
        raise RuntimeError("tls handshake eof")

    async def bing(_query, _deadline):
        return search.ProviderOutcome("bing", "error", [])

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    monkeypatch.setattr(search, "_bing_search", bing)
    with pytest.raises(AppError) as raised:
        await search._search_uncached("anything", 3, None)
    assert raised.value.status_code == 502
    assert raised.value.code == "upstream_error"


async def test_trace_reports_the_fallback(settings, monkeypatch):
    settings.search_max_attempts = 1

    def fail(_query, _timeout):
        raise RuntimeError("tls handshake eof")

    async def bing(_query, _deadline):
        return search.ProviderOutcome("bing", "empty", [], attempts=1, elapsed_ms=12)

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    monkeypatch.setattr(search, "_bing_search", bing)
    trace = {}
    await search._search_uncached("fallback", 3, None, trace)

    assert trace["provider"] == "duckduckgo"
    assert trace["status"] == "error"
    assert trace["fallback"] is True
    assert trace["fallbackStatus"] == "empty"
    assert trace["fallbackAttempts"] == 1
    assert trace["fallbackElapsedMs"] == 12
    assert "handshake" in trace["error"]


async def test_web_search_uses_the_in_process_cache(settings, monkeypatch):
    calls = 0
    monkeypatch.setattr(search, "_ddgs_sync", lambda *_args: [ddg_result()])

    async def uncached(query, _limit, cache_key, _trace=None):
        nonlocal calls
        calls += 1
        result = [{"title": query, "url": "https://example.com/a"}]
        await cache.cache_set(cache_key, json.dumps(result), 60)
        return result

    monkeypatch.setattr(search, "_search_uncached", uncached)
    first = await search.web_search("cached query", 3)
    assert calls == 1
    assert await cache.cache_get(search_cache_key("cached query", 3)) is not None

    monkeypatch.setattr(search, "_search_uncached", lambda *_args, **_kwargs: pytest.fail(
        "the cache must answer without a provider call"
    ))
    assert await search.web_search("cached query", 3) == first
    assert calls == 1


def search_cache_key(query: str, limit: int) -> str:
    return "matrius:search:v2:" + hashlib.sha256(f"{query}|{limit}".encode()).hexdigest()


async def test_identical_searches_share_one_inflight_task(settings, monkeypatch):
    calls = 0
    gate = asyncio.Event()

    async def uncached(query, _limit, _cache_key, _trace=None):
        nonlocal calls
        calls += 1
        await gate.wait()
        return [{"title": query, "url": "https://example.com/a"}]

    monkeypatch.setattr(search, "_search_uncached", uncached)
    first = asyncio.create_task(search.web_search("shared query", 3))
    second = asyncio.create_task(search.web_search("shared query", 3))
    for _ in range(10):
        if calls == 1 and len(search._search_flights) == 1:
            break
        await asyncio.sleep(0)
    gate.set()

    assert await asyncio.gather(first, second) == [
        [{"title": "shared query", "url": "https://example.com/a"}],
        [{"title": "shared query", "url": "https://example.com/a"}],
    ]
    assert calls == 1
    assert search._search_flights == {}


async def test_cancelling_one_waiter_does_not_cancel_the_shared_search(settings, monkeypatch):
    calls = 0
    gate = asyncio.Event()

    async def uncached(query, _limit, _cache_key, _trace=None):
        nonlocal calls
        calls += 1
        await gate.wait()
        return [{"title": query, "url": "https://example.com/a"}]

    monkeypatch.setattr(search, "_search_uncached", uncached)
    cancelled = asyncio.create_task(search.web_search("shielded query", 3))
    survivor = asyncio.create_task(search.web_search("shielded query", 3))
    for _ in range(10):
        if calls == 1 and len(search._search_flights) == 1:
            break
        await asyncio.sleep(0)
    cancelled.cancel()
    with pytest.raises(asyncio.CancelledError):
        await cancelled
    gate.set()

    assert await survivor == [{"title": "shielded query", "url": "https://example.com/a"}]
    assert calls == 1


async def test_degraded_empty_search_is_not_cached(settings, monkeypatch):
    settings.search_max_attempts = 1

    def fail(_query, _timeout):
        raise RuntimeError("tls handshake eof")

    async def bing(_query, _deadline):
        return search.ProviderOutcome("bing", "empty", [])

    monkeypatch.setattr(search, "_ddgs_sync", fail)
    monkeypatch.setattr(search, "_bing_search", bing)
    assert await search.web_search("transient", 3) == []
    assert await cache.cache_get(search_cache_key("transient", 3)) is None


def test_search_request_normalizes_query_forms():
    request = SearchRequest(queries=[" alpha ", "beta", "alpha"])
    assert request.queries == ["alpha", "beta"]
    assert request.query == "alpha"
    with pytest.raises(ValidationError):
        SearchRequest()
    with pytest.raises(ValidationError):
        SearchRequest(queries=["one", "two", "three", "four", "five"])


def _search_hit(title: str, url: str) -> dict:
    return {"title": title, "url": url, "snippet": title, "domain": "example.com", "engine": "test", "rank": 1}


async def test_multi_query_search_merges_and_dedupes(monkeypatch):
    calls: list[tuple[str, int]] = []

    async def fake_web_search(query, limit, *, trace=None):
        calls.append((query, limit))
        if query == "alpha":
            return [_search_hit("Alpha", "https://example.com/a"), _search_hit("Shared old", "https://example.com/shared")]
        return [_search_hit("Shared newer and longer", "https://example.com/shared"), _search_hit("Beta", "https://example.com/b")]

    monkeypatch.setattr(search, "web_search", fake_web_search)
    results = await search.web_search_many(["alpha", "beta"], 10)
    assert sorted(calls) == [("alpha", 10), ("beta", 10)]
    assert {item["url"] for item in results} == {
        "https://example.com/a",
        "https://example.com/b",
        "https://example.com/shared",
    }
    shared = next(item for item in results if item["url"] == "https://example.com/shared")
    assert shared["title"] == "Shared newer and longer"


async def test_multi_query_search_keeps_partial_results(monkeypatch):
    async def fake_web_search(query, _limit, *, trace=None):
        if query == "broken":
            raise AppError(502, "upstream_error", "temporary")
        return [_search_hit("Good", "https://example.com/good")]

    monkeypatch.setattr(search, "web_search", fake_web_search)
    results = await search.web_search_many(["broken", "good"], 10)
    assert [item["url"] for item in results] == ["https://example.com/good"]


async def test_multi_query_search_raises_when_every_query_fails(monkeypatch):
    async def fake_web_search(_query, _limit, *, trace=None):
        raise AppError(502, "upstream_error", "temporary")

    monkeypatch.setattr(search, "web_search", fake_web_search)
    with pytest.raises(AppError):
        await search.web_search_many(["alpha", "beta"], 10)
