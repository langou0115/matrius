import asyncio
import io
import uuid
from types import SimpleNamespace

import pytest
from docx import Document

from app.errors import AppError
from app.files.parsing import extract_text
from app.tools import files as tools_files
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


async def test_four_fetch_endpoints_download_pages_concurrently(client, create_instance, monkeypatch):
    _, headers = await create_instance()
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
