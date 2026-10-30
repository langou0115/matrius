import asyncio
import io
import uuid
from types import SimpleNamespace

import pytest
from docx import Document

from app.auth.cookies import USER_SESSION_COOKIE
from app.config import get_settings
from app.errors import AppError
from app.files.parsing import extract_text
from app.tools import files as tools_files
from app.tools import router as tools_router_module
from app.tools import web_fetch as web_fetch_module
from app.tools.urls import canonical_result_key, normalize_search_url, validate_fetch_url


def test_extract_plain_text():
    assert extract_text("notes.txt", "你好，世界".encode()) == "你好，世界"


def test_extract_docx():
    document = Document()
    document.add_paragraph("First paragraph")
    buffer = io.BytesIO()
    document.save(buffer)
    assert "First paragraph" in extract_text("report.docx", buffer.getvalue())


async def test_read_file_text(monkeypatch):
    stored = SimpleNamespace(id=uuid.uuid4(), filename="notes.txt", sha256="abc")
    _patch_file_bytes(monkeypatch, "one\ntwo\nthree\nfour")

    result = await tools_files.read_file_text(stored, 2, 3, 50_000)
    assert result["text"] == "two\nthree"
    assert result["startLine"] == 2
    assert result["endLine"] == 3
    assert result["truncated"] is False


async def test_read_file_text_max_chars(monkeypatch):
    stored = SimpleNamespace(id=uuid.uuid4(), filename="notes.txt", sha256="abc")
    _patch_file_bytes(monkeypatch, "aaaa\nbbbb\ncccc")

    result = await tools_files.read_file_text(stored, 1, None, 9)
    assert result["text"] == "aaaa\nbbbb"
    assert result["truncated"] is True


async def test_grep_file_text(monkeypatch):
    stored = SimpleNamespace(id=uuid.uuid4(), filename="notes.txt", sha256="abc")
    content = "alpha\nneedle one\nbeta\nneedle two\ngamma"
    _patch_file_bytes(monkeypatch, content)

    result = await tools_files.grep_file_text(stored, "needle", 1, 10)
    assert [match["line"] for match in result["matches"]] == [2, 4]
    assert result["matches"][0]["contextBefore"] == ["alpha"]
    assert result["matches"][0]["contextAfter"] == ["beta"]


async def test_grep_rejects_invalid_pattern(monkeypatch):
    stored = SimpleNamespace(id=uuid.uuid4(), filename="notes.txt", sha256="abc")
    _patch_file_bytes(monkeypatch, "x")
    with pytest.raises(AppError):
        await tools_files.grep_file_text(stored, "(", 1, 10)


@pytest.mark.parametrize(
    "url",
    ["file:///etc/passwd", "ftp://example.com/a", "http://localhost/a", "http://127.0.0.1/a"],
)
async def test_fetch_rejects_unsafe_urls(url):
    with pytest.raises(AppError):
        await validate_fetch_url(url)


async def test_four_fetch_endpoints_download_pages_concurrently(client, create_user, monkeypatch):
    _, headers = await create_user()
    all_started = asyncio.Event()
    started = []

    async def download(url, _deadline):
        started.append(url)
        if len(started) == 4:
            all_started.set()
        await all_started.wait()
        return url, "Synthetic page text", False, "text/plain"

    monkeypatch.setattr(web_fetch_module, "_download", download)
    monkeypatch.setattr(web_fetch_module, "_extract", lambda body, _url, _mode, _mime: ("Page", body, "raw"))
    urls = [f"https://example.com/parallel-{index}" for index in range(4)]
    async with asyncio.timeout(3):
        responses = await asyncio.gather(*(
            client.post("/api/tools/fetch", json={"url": url}, headers=headers) for url in urls
        ))
    assert set(started) == set(urls)
    assert [response.status_code for response in responses] == [200] * 4
    assert [response.json()["url"] for response in responses] == urls


async def test_web_tools_work_without_a_session(client, monkeypatch):
    """Local mode has no account: web tools must still answer and key limits by IP."""
    seen: list[tuple[str, str, int]] = []

    async def fake_limit(name, identity, limit, *args, **kwargs):
        seen.append((name, identity, limit))

    async def fake_search(query, limit):
        return [{"title": query, "url": "https://example.com", "snippet": "ok"}]

    async def fake_fetch(url, _mode):
        return {"url": url, "title": "Page", "text": "ok", "truncated": False, "chars": 2}

    monkeypatch.setattr(tools_router_module, "enforce_rate_limit", fake_limit)
    monkeypatch.setattr(tools_router_module, "web_search", fake_search)
    monkeypatch.setattr(tools_router_module, "web_fetch", fake_fetch)

    search = await client.post("/api/tools/search", json={"query": "matrius"})
    fetch = await client.post("/api/tools/fetch", json={"url": "https://example.com"})

    assert search.status_code == 200
    assert search.json()["results"][0]["title"] == "matrius"
    assert fetch.status_code == 200
    assert fetch.json()["text"] == "ok"
    anonymous_limit = get_settings().anonymous_tool_calls_per_minute
    assert [(name, limit) for name, _, limit in seen] == [
        ("tool_search", anonymous_limit),
        ("tool_fetch", anonymous_limit),
    ]
    assert all(identity.startswith("ip:") for _, identity, _ in seen)


async def test_stale_session_cookie_falls_back_to_anonymous_tools(client, monkeypatch):
    """A revoked cookie left in the browser must not break local-mode tools."""
    async def fake_fetch(url, _mode):
        return {"url": url, "title": "Page", "text": "ok", "truncated": False, "chars": 2}

    monkeypatch.setattr(tools_router_module, "web_fetch", fake_fetch)

    response = await client.post(
        "/api/tools/fetch",
        json={"url": "https://example.com"},
        cookies={USER_SESSION_COOKIE: "expired-or-revoked"},
    )

    assert response.status_code == 200


async def test_password_change_gate_still_blocks_tools(client, create_user):
    _, headers = await create_user(must_change_password=True)
    response = await client.post(
        "/api/tools/fetch", json={"url": "https://example.com"}, headers=headers
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "password_change_required"


def test_normalize_search_url_strips_tracking():
    normalized = normalize_search_url("https://Example.com/a?utm_source=x&id=2#frag")
    assert normalized == "https://example.com/a?id=2"


def test_canonical_result_key_ignores_www_and_trailing_slash():
    assert canonical_result_key("https://www.example.com/a/?b=1&a=2") == canonical_result_key(
        "https://example.com/a?a=2&b=1"
    )


def _patch_file_bytes(monkeypatch, value: str) -> None:
    async def fake_load(_stored):
        return value.encode()

    monkeypatch.setattr(tools_files, "load_file_bytes", fake_load)
