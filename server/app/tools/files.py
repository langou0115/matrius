import asyncio
import re
from pathlib import PurePath
from typing import Any

from app.cache import cache_get, cache_set
from app.documents.libreoffice import is_legacy_office
from app.errors import AppError, invalid
from app.files.parsing import ParseError, extract_text
from app.files.router import load_file_bytes
from app.models import StoredFile

LEGACY_OFFICE = {"doc", "xls", "ppt"}
FILE_TEXT_TTL_SECONDS = 3600
# Bumped whenever extraction gains a new engine, so old cache entries are not reused.
EXTRACTOR_VERSION = "v2"


async def extract_document_text(filename: str, data: bytes) -> str:
    """Extract text from modern or legacy Office files.

    Legacy files are converted in a temporary directory; the uploaded bytes are
    never modified.
    """

    if is_legacy_office(filename):
        from app.documents.libreoffice import convert_legacy_office

        converted = await convert_legacy_office(filename, data)
        filename, data = converted.filename, converted.data
    try:
        return await asyncio.to_thread(extract_text, filename, data)
    except ParseError as exc:
        raise AppError(422, "parse_failed", "无法解析该文件。") from exc


async def file_text(stored: StoredFile) -> str:
    suffix = PurePath(stored.filename).suffix.lower().lstrip(".")
    # Images are handled as attachments, never decoded as text.
    if _is_image(suffix):
        raise AppError(415, "unsupported_file_type", "图片不支持文本读取。")

    cache_key = f"matrius:filetext:{stored.id}:{stored.sha256}:{EXTRACTOR_VERSION}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    data = await load_file_bytes(stored)
    text = await extract_document_text(stored.filename, data)
    await cache_set(cache_key, text, FILE_TEXT_TTL_SECONDS)
    return text


def _is_image(suffix: str) -> bool:
    return suffix in {"png", "jpg", "jpeg", "webp", "gif"}


def slice_text(
    file_id: str, filename: str, text: str, start: int, end: int | None, max_chars: int
) -> dict[str, Any]:
    lines = text.splitlines()
    total_lines = len(lines)
    if total_lines == 0:
        return {
            "fileId": file_id,
            "filename": filename,
            "startLine": 0,
            "endLine": 0,
            "totalLines": 0,
            "text": "",
            "truncated": False,
        }

    start = max(1, min(start, total_lines))
    last_allowed = total_lines if end is None else max(start, min(end, total_lines))

    selected: list[str] = []
    used = 0
    for index in range(start - 1, last_allowed):
        line = lines[index]
        cost = len(line) + (1 if selected else 0)
        if used + cost > max_chars:
            break
        selected.append(line)
        used += cost

    end_line = start + len(selected) - 1 if selected else start - 1
    return {
        "fileId": file_id,
        "filename": filename,
        "startLine": start,
        "endLine": end_line,
        "totalLines": total_lines,
        "text": "\n".join(selected),
        "truncated": end_line < last_allowed,
    }


def grep_text(
    file_id: str, filename: str, text: str, pattern: str, context: int, max_matches: int
) -> dict[str, Any]:
    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise invalid("正则表达式不合法。") from exc

    lines = text.splitlines()
    matches: list[dict[str, Any]] = []
    truncated = False

    for index, line in enumerate(lines):
        if not compiled.search(line):
            continue
        if len(matches) >= max_matches:
            truncated = True
            break
        matches.append(
            {
                "line": index + 1,
                "text": line,
                "contextBefore": lines[max(0, index - context) : index],
                "contextAfter": lines[index + 1 : index + 1 + context],
            }
        )

    return {
        "fileId": file_id,
        "filename": filename,
        "matches": matches,
        "totalLines": len(lines),
        "truncated": truncated,
    }


async def read_file_text(
    stored: StoredFile, start: int, end: int | None, max_chars: int
) -> dict[str, Any]:
    text = await file_text(stored)
    return slice_text(str(stored.id), stored.filename, text, start, end, max_chars)


async def grep_file_text(
    stored: StoredFile,
    pattern: str,
    context: int,
    max_matches: int,
) -> dict[str, Any]:
    text = await file_text(stored)
    return grep_text(str(stored.id), stored.filename, text, pattern, context, max_matches)
