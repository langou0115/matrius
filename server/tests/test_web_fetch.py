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


async def test_download_returns_decoded_text(fetched, monkeypatch):
    patch_download(monkeypatch, {
        "https://example.com/page": FakeResponse(chunks=[b"hello ", b"world"], charset="utf-8"),
    })
    assert await web_fetch._download("https://example.com/page") == (
        "https://example.com/page", "hello world", False
    )


async def test_download_truncates_oversized_bodies(fetched, monkeypatch):
    fetched.fetch_max_bytes = 5
    patch_download(monkeypatch, {
        "https://example.com/page": FakeResponse(chunks=[b"12345", b"6789"]),
    })
    url, body, truncated = await web_fetch._download("https://example.com/page")
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
    assert raised.value.code == "upstream_error"
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
        return "https://example.com/page", PAGE, False

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
        return "https://example.com/page", PAGE, False

    monkeypatch.setattr(web_fetch, "_download", download)
    result = await web_fetch.web_fetch("https://example.com/page")
    assert len(result["text"]) == 12
    assert result["truncated"] is True


async def test_web_fetch_rejects_an_empty_extraction(fetched, monkeypatch):
    fetched.fetch_max_chars = 100

    async def download(_url):
        return "https://example.com/page", "<html><body><script>let x = 1;</script></body></html>", False

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
