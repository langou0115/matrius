import asyncio
import json
import logging
from typing import Any
from urllib.parse import urljoin

import httpx
import trafilatura
from charset_normalizer import from_bytes
from lxml import html as lxml_html

from app.config import get_settings
from app.errors import AppError, invalid
from app.tools.urls import FETCH_TIMEOUT_SECONDS, validate_fetch_url

logger = logging.getLogger(__name__)

FETCH_SEMAPHORE = asyncio.Semaphore(4)
MAX_TITLE_CHARS = 280
MAX_REDIRECTS = 5
REDIRECT_STATUSES = {301, 302, 303, 307, 308}
TEXTUAL_CONTENT_TYPES = (
    "text/",
    "application/xhtml+xml",
    "application/xml",
    "application/json",
    "application/rss+xml",
    "application/atom+xml",
)


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


def _is_textual(content_type: str) -> bool:
    lowered = content_type.split(";", 1)[0].strip().lower()
    if not lowered:
        return True
    return lowered.startswith(TEXTUAL_CONTENT_TYPES)


async def _download(url: str) -> tuple[str, str, bool]:
    """Return (final_url, body, truncated), re-validating every redirect hop."""
    settings = get_settings()
    current = await validate_fetch_url(url)
    timeout = httpx.Timeout(FETCH_TIMEOUT_SECONDS, connect=10)
    async with httpx.AsyncClient(
        timeout=timeout,
        follow_redirects=False,
        headers={
            "User-Agent": _user_agent(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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

                if response.status_code >= 400:
                    raise AppError(502, "upstream_error", f"网页返回了 HTTP {response.status_code}。")
                if not _is_textual(response.headers.get("content-type", "")):
                    raise AppError(422, "unsupported_content", "该地址不是可提取的文本网页。")

                limit = settings.fetch_max_bytes
                chunks: list[bytes] = []
                total = 0
                truncated = False
                async for chunk in response.aiter_bytes():
                    remaining = limit - total
                    if len(chunk) >= remaining:
                        chunks.append(chunk[:remaining])
                        total = limit
                        truncated = True
                        break
                    chunks.append(chunk)
                    total += len(chunk)
                return current, _decode(b"".join(chunks), response.charset_encoding), truncated

    raise AppError(502, "upstream_error", "网页重定向次数过多。")


def _extract_with_lxml(body: str, url: str) -> tuple[str, str]:
    tree = lxml_html.fromstring(body)
    for node in tree.xpath("//script|//style|//noscript|//template"):
        node.drop_tree()
    titles = tree.xpath("//title")
    title = " ".join(titles[0].text_content().split()) if titles else url
    return title, " ".join(tree.text_content().split())


def _extract_with_trafilatura(body: str, url: str, mode: str) -> tuple[str, str] | None:
    output = trafilatura.extract(
        body,
        url=url,
        output_format="json",
        with_metadata=True,
        include_comments=False,
        include_tables=mode == "full",
        favor_precision=mode == "fast",
        favor_recall=mode == "full",
        deduplicate=True,
    )
    if not output:
        return None
    try:
        payload = json.loads(output)
    except ValueError:
        return None
    text = payload.get("text") or payload.get("raw_text") or ""
    title = payload.get("title") or ""
    return str(title), str(text)


def _extract(body: str, url: str, mode: str) -> tuple[str, str]:
    if mode == "full" or "<" in body:
        try:
            extracted = _extract_with_trafilatura(body, url, mode)
            if extracted and extracted[1].strip():
                return extracted
        except Exception as exc:  # noqa: BLE001 - fall back to plain text extraction
            logger.warning("trafilatura extraction failed for %s: %s", url, exc)
    try:
        return _extract_with_lxml(body, url)
    except Exception as exc:  # noqa: BLE001
        logger.warning("lxml extraction failed for %s: %s", url, exc)
        return url, " ".join(body.split())


async def web_fetch(url: str, mode: str = "fast") -> dict[str, Any]:
    ensure_mode(mode)
    async with FETCH_SEMAPHORE:
        final_url, body, truncated = await _download(url)

    title, text = await asyncio.to_thread(_extract, body, final_url, mode)
    if not text.strip():
        raise AppError(502, "fetch_empty", "未能提取到网页正文。")

    limit = get_settings().fetch_max_chars
    truncated = truncated or len(text) > limit
    text = text[:limit]
    return {
        "title": (title.strip() or final_url)[:MAX_TITLE_CHARS],
        "url": final_url,
        "text": text,
        "truncated": truncated,
        "chars": len(text),
    }


def ensure_mode(mode: str) -> str:
    if mode not in ("fast", "full"):
        raise invalid("mode 只能是 fast 或 full。")
    return mode
