import asyncio
from typing import Any

from app.config import get_settings
from app.errors import AppError, invalid
from app.tools.search import request_openserp
from app.tools.urls import validate_fetch_url

FETCH_SEMAPHORE = asyncio.Semaphore(4)
MAX_TITLE_CHARS = 280


async def web_fetch(url: str, mode: str = "fast") -> dict[str, Any]:
    validated_url = await validate_fetch_url(url)
    async with FETCH_SEMAPHORE:
        payload = await request_openserp(
            "/extract",
            {
                "clean": "true",
                "format": "json",
                "mode": mode,
                "url": validated_url,
                "use_llms_txt": "true",
            },
        )

    if not isinstance(payload, dict):
        raise AppError(502, "upstream_error", "联网服务返回了无效数据。")
    if isinstance(payload.get("result"), dict):
        payload = payload["result"]

    text = payload.get("markdown") or payload.get("text") or payload.get("content") or ""
    if not isinstance(text, str) or not text.strip():
        raise AppError(502, "fetch_empty", "未能提取到网页正文。")

    limit = get_settings().fetch_max_chars
    truncated = len(text) > limit
    title = str(payload.get("title") or validated_url).strip()[:MAX_TITLE_CHARS]
    return {
        "title": title,
        "url": str(payload.get("url") or validated_url),
        "text": text[:limit],
        "truncated": truncated,
        "chars": min(len(text), limit),
    }


def ensure_mode(mode: str) -> str:
    if mode not in ("fast", "full"):
        raise invalid("mode 只能是 fast 或 full。")
    return mode
