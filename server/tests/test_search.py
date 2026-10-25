import asyncio
import hashlib
from types import SimpleNamespace

import pytest

from app import cache
from app.errors import AppError
from app.tools import search

DUCKDUCKGO_HTML = """
<html><body>
  <div class="result results_links">
    <a class="result__a"
       href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&amp;rut=abc">Python Docs</a>
    <a class="result__snippet"> The official <b>Python</b> documentation. </a>
  </div>
  <div class="result results_links">
    <a class="result__a" href="https://example.com/direct">Direct result</a>
    <div class="result__snippet">A direct link.</div>
  </div>
</body></html>
"""

DUCKDUCKGO_LITE = """
<html><body><table>
  <tr><td><a rel="nofollow" class="result-link" href="https://example.com/a">Example A</a></td></tr>
  <tr><td class="result-snippet">Snippet for A.</td></tr>
  <tr><td><a rel="nofollow" class="result-link" href="https://example.com/b">Example B</a></td></tr>
  <tr><td class="result-snippet">Snippet for B.</td></tr>
</table></body></html>
"""

BING_RSS = """
<rss><channel>
  <item><title>Bing Result</title><link>https://example.org/page</link>
    <description>Some   spaced description</description></item>
  <item><title>Second</title><link>https://example.net/other</link><description>Other</description></item>
</channel></rss>
"""


class FakeClient:
    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


def test_duckduckgo_html_parser_unwraps_redirects_and_reads_snippets():
    results = search._parse_duckduckgo(DUCKDUCKGO_HTML)
    assert [item["url"] for item in results] == ["https://docs.python.org/3/", "https://example.com/direct"]
    assert results[0]["title"] == "Python Docs"
    assert results[0]["snippet"] == "The official Python documentation."
    assert results[0]["engine"] == "duckduckgo"
    assert [item["rank"] for item in results] == [1, 2]


def test_duckduckgo_lite_parser_reads_the_snippet_row():
    results = search._parse_duckduckgo_lite(DUCKDUCKGO_LITE)
    assert [(item["title"], item["url"], item["snippet"]) for item in results] == [
        ("Example A", "https://example.com/a", "Snippet for A."),
        ("Example B", "https://example.com/b", "Snippet for B."),
    ]


def test_bing_rss_parser_collapses_whitespace():
    results = search._parse_bing_rss(BING_RSS)
    assert [(item["title"], item["url"], item["snippet"]) for item in results] == [
        ("Bing Result", "https://example.org/page", "Some spaced description"),
        ("Second", "https://example.net/other", "Other"),
    ]
    assert all(item["engine"] == "bing" for item in results)


def test_duckduckgo_unwrapping_only_touches_redirect_paths():
    assert search._unwrap_duckduckgo(
        "//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F%3Fq%3D1"
    ) == "https://example.com/?q=1"
    assert search._unwrap_duckduckgo("https://example.com/keep") == "https://example.com/keep"


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


async def test_search_degrades_when_one_provider_fails(monkeypatch):
    monkeypatch.setattr(search, "_client", FakeClient)

    async def duckduckgo(_client, _query):
        return [
            {"type": "organic", "url": "http://example.com/a", "title": "A", "snippet": "",
             "engine": "duckduckgo", "rank": 1},
            {"type": "organic", "url": "https://example.org/b", "title": "B", "snippet": "",
             "engine": "duckduckgo", "rank": 2},
        ]

    async def bing(_client, _query):
        raise RuntimeError("bing is unavailable")

    monkeypatch.setattr(search, "_duckduckgo", duckduckgo)
    monkeypatch.setattr(search, "_bing", bing)

    results = await search.web_search("python", 5)
    assert [item["title"] for item in results] == ["A", "B"]
    assert results[0]["url"] == "http://example.com/a"


async def test_search_uses_the_in_process_cache(monkeypatch):
    calls = 0

    async def duckduckgo(_client, _query):
        nonlocal calls
        calls += 1
        return [{"type": "organic", "url": "https://example.com/a", "title": "A", "snippet": "",
                 "engine": "duckduckgo", "rank": 1}]

    async def bing(_client, _query):
        return []

    monkeypatch.setattr(search, "_client", FakeClient)
    monkeypatch.setattr(search, "_duckduckgo", duckduckgo)
    monkeypatch.setattr(search, "_bing", bing)

    first = await search.web_search("cached query", 3)
    assert calls == 1
    assert await cache.cache_get(search_cache_key("cached query", 3)) is not None

    def fail_client():
        raise AssertionError("providers must not run on a cache hit")

    monkeypatch.setattr(search, "_client", fail_client)
    assert await search.web_search("cached query", 3) == first
    assert calls == 1


def search_cache_key(query: str, limit: int) -> str:
    return "matrius:search:" + hashlib.sha256(f"{query}|{limit}".encode()).hexdigest()


async def test_search_fails_with_502_only_when_every_provider_fails(monkeypatch):
    monkeypatch.setattr(search, "_client", FakeClient)

    async def failing(_client, _query):
        raise RuntimeError("down")

    monkeypatch.setattr(search, "_duckduckgo", failing)
    monkeypatch.setattr(search, "_bing", failing)
    with pytest.raises(AppError) as raised:
        await search.web_search("anything", 3)
    assert raised.value.status_code == 502
    assert raised.value.code == "upstream_error"


async def test_identical_searches_share_one_inflight_task(monkeypatch):
    calls = 0
    gate = asyncio.Event()

    async def uncached(query, _limit, _cache_key):
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


async def test_cancelling_one_waiter_does_not_cancel_the_shared_search(monkeypatch):
    calls = 0
    gate = asyncio.Event()

    async def uncached(query, _limit, _cache_key):
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


async def test_search_with_no_usable_results_is_empty_not_an_error(monkeypatch):
    monkeypatch.setattr(search, "_client", FakeClient)

    async def duckduckgo(_client, _query):
        return [{"type": "ads", "url": "https://example.com/ad"}]

    async def bing(_client, _query):
        return [{"type": "organic", "url": "ftp://example.com/file"}]

    monkeypatch.setattr(search, "_duckduckgo", duckduckgo)
    monkeypatch.setattr(search, "_bing", bing)
    assert await search.web_search("nothing usable", 3) == []


async def test_duckduckgo_success_never_calls_bing(monkeypatch):
    calls = []
    monkeypatch.setattr(search, "_client", FakeClient)

    async def primary(_client, _query):
        calls.append("duckduckgo")
        return [{"url": "https://docs.python.org/3/", "title": "Python docs", "engine": "duckduckgo"}]

    async def fallback(_client, _query):
        calls.append("bing")
        return []

    monkeypatch.setattr(search, "_duckduckgo", primary)
    monkeypatch.setattr(search, "_bing", fallback)
    results = await search.web_search("Python docs", 8)
    assert calls == ["duckduckgo"]
    assert results[0]["engine"] == "duckduckgo"


@pytest.mark.parametrize("primary_result", [None, [], [{"url": "ftp://example.com/file"}]])
async def test_bing_only_follows_unusable_duckduckgo(monkeypatch, primary_result):
    calls = []
    monkeypatch.setattr(search, "_client", FakeClient)

    async def primary(_client, _query):
        calls.append("duckduckgo")
        if primary_result is None:
            raise TimeoutError()
        return primary_result

    async def fallback(_client, _query):
        calls.append("bing")
        return [{"url": "https://example.com/answer", "title": "Answer", "engine": "bing"}]

    monkeypatch.setattr(search, "_duckduckgo", primary)
    monkeypatch.setattr(search, "_bing", fallback)
    assert (await search.web_search("fallback", 3))[0]["engine"] == "bing"
    assert calls == ["duckduckgo", "bing"]


async def test_challenge_is_an_error_instead_of_empty_results(monkeypatch):
    async def request(*_args, **_kwargs):
        return '<html><form id="challenge-form">Verify you are human</form></html>'

    monkeypatch.setattr(search, "_request_text", request)
    with pytest.raises(RuntimeError, match="verification challenge"):
        await search._duckduckgo(None, "test")


async def test_html_timeout_leaves_time_for_lite(monkeypatch):
    calls = []

    async def request(_client, _method, url, **_kwargs):
        calls.append(url)
        if url == search.DUCKDUCKGO_HTML:
            await asyncio.sleep(10)
        return DUCKDUCKGO_LITE

    monkeypatch.setattr(search, "get_settings", lambda: SimpleNamespace(search_timeout_seconds=0.2))
    monkeypatch.setattr(search, "_request_text", request)
    results = await asyncio.wait_for(search._duckduckgo(None, "test"), timeout=1)
    assert len(results) == 2
    assert calls == [search.DUCKDUCKGO_HTML, search.DUCKDUCKGO_LITE]


def test_nested_result_body_preserves_the_snippet():
    page = '<div class="result"><div class="result__body"><h2 class="result__title">'
    page += '<a class="result__a" href="https://example.com">Title</a></h2>'
    page += '<a class="result__snippet">Useful snippet</a></div></div>'
    assert search._parse_duckduckgo(page)[0]["snippet"] == "Useful snippet"


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


async def test_degraded_empty_search_is_not_cached(monkeypatch):
    monkeypatch.setattr(search, "_client", FakeClient)

    async def primary(_client, _query):
        raise TimeoutError()

    async def fallback(_client, _query):
        return []

    monkeypatch.setattr(search, "_duckduckgo", primary)
    monkeypatch.setattr(search, "_bing", fallback)
    with pytest.raises(AppError):
        await search.web_search("transient", 3)
    assert await cache.cache_get(search_cache_key("transient", 3)) is None
