import asyncio
import json
from types import SimpleNamespace

import pytest

from app.errors import AppError, invalid
from app.tools import web_fetch

PAGE = """<!doctype html>
<html><head><title>Fixture page</title></head>
<body><article><h1>Heading</h1><p>Hello world from the fixture article.</p></article></body></html>
"""


class FakeResponse:
    def __init__(self, status_code=200, *, headers=None, chunks=(), charset=None):
        self.status_code = status_code
        self.headers = headers or {}
        self._chunks = list(chunks)
        self.charset_encoding = charset

    async def aiter_bytes(self):
        for chunk in self._chunks:
            yield chunk

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False


class FakeClient:
    def __init__(self, responses):
        self.responses = responses
        self.requested = []

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    def stream(self, _method, url):
        self.requested.append(url)
        return self.responses[url]


@pytest.fixture
def fetched(monkeypatch):
    settings = SimpleNamespace(
        search_user_agent="Matrius test",
        fetch_max_bytes=1024 * 1024,
        fetch_max_chars=10_000,
    )
    monkeypatch.setattr(web_fetch, "get_settings", lambda: settings)
    return settings


def patch_download(monkeypatch, responses, validate=None):
    client = FakeClient(responses)
    monkeypatch.setattr(web_fetch, "httpx", SimpleNamespace(
        AsyncClient=lambda **_kwargs: client,
        Timeout=lambda *args, **kwargs: (args, kwargs),
    ))

    async def allow(url):
        return url

    monkeypatch.setattr(web_fetch, "validate_fetch_url", validate or allow)
    return client


async def test_download_uses_the_configured_proxy(fetched, monkeypatch):
    fetched.web_tool_proxy_url = "http://proxy.internal:3128"
    seen = {}

    class ProxyClient(FakeClient):
        def __init__(self, **kwargs):
            super().__init__({"https://example.com/page": FakeResponse(chunks=[b"hello"], charset="utf-8")})
            seen.update(kwargs)

    monkeypatch.setattr(web_fetch, "httpx", SimpleNamespace(
        AsyncClient=lambda **kwargs: ProxyClient(**kwargs),
        Timeout=lambda *args, **kwargs: (args, kwargs),
    ))

    async def allow(url):
        return url

    monkeypatch.setattr(web_fetch, "validate_fetch_url", allow)
    assert await web_fetch._download("https://example.com/page") == (
        "https://example.com/page", "hello", False, ""
    )
    assert seen["proxy"] == "http://proxy.internal:3128"


async def test_download_connects_directly_without_a_proxy(fetched, monkeypatch):
    fetched.web_tool_proxy_url = ""
    seen = {}

    class ProxyClient(FakeClient):
        def __init__(self, **kwargs):
            super().__init__({"https://example.com/page": FakeResponse(chunks=[b"hello"], charset="utf-8")})
            seen.update(kwargs)

    monkeypatch.setattr(web_fetch, "httpx", SimpleNamespace(
        AsyncClient=lambda **kwargs: ProxyClient(**kwargs),
        Timeout=lambda *args, **kwargs: (args, kwargs),
    ))

    async def allow(url):
        return url

    monkeypatch.setattr(web_fetch, "validate_fetch_url", allow)
    assert await web_fetch._download("https://example.com/page") == (
        "https://example.com/page", "hello", False, ""
    )
    assert seen["proxy"] is None


async def test_download_returns_decoded_text(fetched, monkeypatch):
    patch_download(monkeypatch, {
        "https://example.com/page": FakeResponse(chunks=[b"hello ", b"world"], charset="utf-8"),
    })
    assert await web_fetch._download("https://example.com/page") == (
        "https://example.com/page", "hello world", False, ""
    )


async def test_download_truncates_oversized_bodies(fetched, monkeypatch):
    fetched.fetch_max_bytes = 5
    patch_download(monkeypatch, {
        "https://example.com/page": FakeResponse(chunks=[b"12345", b"6789"]),
    })
    url, body, truncated, _content_type = await web_fetch._download("https://example.com/page")
    assert (url, body, truncated) == ("https://example.com/page", "12345", True)


async def test_download_rejects_non_textual_content(fetched, monkeypatch):
    patch_download(monkeypatch, {
        "https://example.com/file.pdf": FakeResponse(headers={"content-type": "application/pdf"}),
    })
    with pytest.raises(AppError) as raised:
        await web_fetch._download("https://example.com/file.pdf")
    assert raised.value.status_code == 422
    assert raised.value.code == "unsupported_content"


async def test_download_reports_upstream_http_errors(fetched, monkeypatch):
    patch_download(monkeypatch, {
        "https://example.com/missing": FakeResponse(404),
    })
    with pytest.raises(AppError) as raised:
        await web_fetch._download("https://example.com/missing")
    assert raised.value.code == "fetch_not_found"
    assert raised.value.status_code == 422
    assert "404" in raised.value.message


async def test_download_follows_redirects_and_revalidates_every_hop(fetched, monkeypatch):
    seen = []

    async def validate(url):
        seen.append(url)
        if "127.0.0.1" in url:
            raise invalid("出于安全原因，不能读取本机或内网地址。")
        return url

    patch_download(monkeypatch, {
        "https://example.com/start": FakeResponse(302, headers={"location": "/next"}),
        "https://example.com/next": FakeResponse(302, headers={"location": "http://127.0.0.1/secret"}),
    }, validate=validate)
    with pytest.raises(AppError) as raised:
        await web_fetch._download("https://example.com/start")
    assert raised.value.code == "invalid"
    assert seen == ["https://example.com/start", "https://example.com/next", "http://127.0.0.1/secret"]


async def test_download_requires_a_redirect_location(fetched, monkeypatch):
    patch_download(monkeypatch, {
        "https://example.com/start": FakeResponse(301),
    })
    with pytest.raises(AppError) as raised:
        await web_fetch._download("https://example.com/start")
    assert raised.value.code == "upstream_error"
    assert "重定向" in raised.value.message


async def test_download_stops_after_five_redirects(fetched, monkeypatch):
    client = patch_download(monkeypatch, {
        "https://example.com/loop": FakeResponse(302, headers={"location": "https://example.com/loop"}),
    })
    with pytest.raises(AppError) as raised:
        await web_fetch._download("https://example.com/loop")
    assert "重定向次数过多" in raised.value.message
    assert len(client.requested) == web_fetch.MAX_REDIRECTS + 1


async def test_web_fetch_extracts_article_text(fetched, monkeypatch):
    async def download(_url):
        return "https://example.com/page", PAGE, False, "text/html"

    monkeypatch.setattr(web_fetch, "_download", download)
    result = await web_fetch.web_fetch("https://example.com/page")
    assert result["url"] == "https://example.com/page"
    assert "Hello world" in result["text"]
    assert result["title"] in ("Fixture page", "Heading", "https://example.com/page")
    assert result["chars"] == len(result["text"])
    assert result["truncated"] is False


async def test_web_fetch_applies_the_character_limit(fetched, monkeypatch):
    fetched.fetch_max_chars = 12

    async def download(_url):
        return "https://example.com/page", PAGE, False, "text/html"

    monkeypatch.setattr(web_fetch, "_download", download)
    result = await web_fetch.web_fetch("https://example.com/page")
    assert len(result["text"]) == 12
    assert result["truncated"] is True


async def test_identical_fetches_share_one_inflight_task_and_cache(fetched, monkeypatch):
    calls = 0
    gate = asyncio.Event()

    async def uncached(url, _mode, cache_key):
        nonlocal calls
        calls += 1
        await gate.wait()
        result = {"title": "Shared", "url": url, "text": "body", "truncated": False, "chars": 4}
        await web_fetch.cache_set(cache_key, json.dumps(result), 60)
        return result

    monkeypatch.setattr(web_fetch, "_fetch_uncached", uncached)
    first = asyncio.create_task(web_fetch.web_fetch("https://example.com/page"))
    second = asyncio.create_task(web_fetch.web_fetch("https://example.com/page"))
    for _ in range(10):
        if calls == 1 and len(web_fetch._fetch_flights) == 1:
            break
        await asyncio.sleep(0)
    gate.set()

    expected = {"title": "Shared", "url": "https://example.com/page", "text": "body", "truncated": False, "chars": 4}
    assert await asyncio.gather(first, second) == [expected, expected]
    assert calls == 1
    assert web_fetch._fetch_flights == {}
    # The completed result is also reused by the next caller without another upstream fetch.
    assert await web_fetch.web_fetch("https://example.com/page") == expected
    assert calls == 1


async def test_web_fetch_rejects_an_empty_extraction(fetched, monkeypatch):
    fetched.fetch_max_chars = 100

    async def download(_url):
        return "https://example.com/page", "<html><body><script>let x = 1;</script></body></html>", False, "text/html"

    monkeypatch.setattr(web_fetch, "_download", download)
    with pytest.raises(AppError) as raised:
        await web_fetch.web_fetch("https://example.com/page")
    assert raised.value.code == "fetch_empty"


def test_only_fast_and_full_modes_are_accepted():
    assert web_fetch.ensure_mode("fast") == "fast"
    assert web_fetch.ensure_mode("full") == "full"
    with pytest.raises(AppError):
        web_fetch.ensure_mode("slow")


def test_textual_content_types():
    assert web_fetch._is_textual("text/html; charset=utf-8")
    assert web_fetch._is_textual("application/json")
    assert web_fetch._is_textual("")
    assert not web_fetch._is_textual("application/pdf")
    assert not web_fetch._is_textual("image/png")


def test_plain_markdown_json_and_code_preserve_structure():
    markdown = "# Title\n\n[Docs](https://example.com)\n\n```cpp\nif (a < b) {\n  return;\n}\n```"
    assert web_fetch._extract(markdown, "https://example.com", "fast", "text/markdown")[1] == markdown
    data = '{"example": "<article>not HTML</article>"}'
    assert web_fetch._extract(data, "https://example.com", "fast", "application/json")[1] == data
    assert web_fetch._extract("a < b\n  keep indentation", "https://example.com", "fast", "text/plain")[1] == (
        "a < b\n  keep indentation"
    )


def test_html_fallback_keeps_headings_links_code_and_tables(monkeypatch):
    monkeypatch.setattr(web_fetch, "_extract_with_trafilatura", lambda *_args: None)
    body = """<html><head><title>Reference</title></head><body><nav>Ignore navigation</nav><main>
      <h1>API</h1><p>Read <a href="/guide">the guide</a>.</p><pre>if x:\n  print(x)</pre>
      <table><tr><th>Name</th><th>Value</th></tr><tr><td>A</td><td>1</td></tr></table>
      <script>secretScript()</script></main></body></html>"""
    title, text = web_fetch._extract(body, "https://example.com/api", "fast")
    assert title == "Reference"
    assert "# API" in text
    assert "[the guide](https://example.com/guide)" in text
    assert "```\nif x:\n  print(x)\n```" in text
    assert "| Name | Value |" in text
    assert "Ignore navigation" not in text and "secretScript" not in text


def test_challenge_page_is_not_cached_as_evidence():
    with pytest.raises(AppError) as raised:
        web_fetch._extract("<html><title>Just a moment...</title><body>Checking your browser</body></html>",
                           "https://example.com", "fast")
    assert raised.value.code == "fetch_blocked"


def test_javascript_only_shell_is_reported_explicitly():
    with pytest.raises(AppError) as raised:
        web_fetch._extract('<html><div id="root"></div><noscript>You need to enable JavaScript.</noscript></html>',
                           "https://example.com", "fast")
    assert raised.value.code == "fetch_requires_browser"


async def test_exact_download_limit_is_not_mislabeled_truncated(fetched, monkeypatch):
    fetched.fetch_max_bytes = 5
    patch_download(monkeypatch, {"https://example.com/exact": FakeResponse(chunks=[b"12345"])})
    assert (await web_fetch._download("https://example.com/exact"))[2] is False


@pytest.mark.parametrize("status,code", [(403, "fetch_blocked"), (410, "fetch_not_found"), (429, "fetch_rate_limited")])
async def test_download_reports_actionable_permanent_and_transient_failures(fetched, monkeypatch, status, code):
    patch_download(monkeypatch, {"https://example.com/page": FakeResponse(status, headers={"retry-after": "2"})})
    with pytest.raises(AppError) as raised:
        await web_fetch._download("https://example.com/page")
    assert raised.value.code == code
    if status == 429:
        assert raised.value.headers["Retry-After"] == "2"


async def test_total_fetch_deadline_includes_slow_response_body(fetched, monkeypatch):
    class SlowResponse(FakeResponse):
        async def aiter_bytes(self):
            yield b"first chunk"
            await asyncio.sleep(10)
            yield b"never arrive"

    patch_download(monkeypatch, {"https://example.com/slow": SlowResponse()})
    monkeypatch.setattr(web_fetch, "FETCH_TIMEOUT_SECONDS", 0.03)
    with pytest.raises(AppError) as raised:
        await web_fetch.web_fetch("https://example.com/slow")
    assert raised.value.code == "fetch_timeout"
    assert raised.value.status_code == 504


async def test_total_fetch_deadline_includes_waiting_for_a_global_slot(fetched, monkeypatch):
    monkeypatch.setattr(web_fetch, "FETCH_SEMAPHORE", asyncio.Semaphore(0))
    monkeypatch.setattr(web_fetch, "FETCH_TIMEOUT_SECONDS", 0.01)
    with pytest.raises(AppError) as raised:
        await web_fetch.web_fetch("https://example.com/queued")
    assert raised.value.code == "fetch_timeout"
