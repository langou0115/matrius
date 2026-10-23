import asyncio
import re
from pathlib import PurePath
from typing import Any

from app.cache import cache_get, cache_set
from app.errors import AppError, invalid
from app.files.parsing import ParseError, extract_text
from app.files.router import load_file_bytes
from app.models import StoredFile

LEGACY_OFFICE = {"doc", "xls", "ppt"}
FILE_TEXT_TTL_SECONDS = 3600


async def file_text(stored: StoredFile) -> str:
    suffix = PurePath(stored.filename).suffix.lower().lstrip(".")
    if suffix in LEGACY_OFFICE:
        raise AppError(415, "unsupported_file_type", "不支持旧版 Office 格式，请另存为 docx/xlsx/pptx。")

    cache_key = f"matrius:filetext:{stored.id}:{stored.sha256}"
    cached = await cache_get(cache_key)
    if cached is not None:
        return cached

    data = await load_file_bytes(stored)
    try:
        text = await asyncio.to_thread(extract_text, stored.filename, data)
    except ParseError as exc:
        raise AppError(422, "parse_failed", "无法解析该文件。") from exc

    await cache_set(cache_key, text, FILE_TEXT_TTL_SECONDS)
    return text


async def read_file_text(
    stored: StoredFile, start: int, end: int | None, max_chars: int
) -> dict[str, Any]:
    text = await file_text(stored)
    lines = text.splitlines()
    total_lines = len(lines)
    if total_lines == 0:
        return {
            "fileId": str(stored.id),
            "filename": stored.filename,
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
    truncated = end_line < last_allowed
    return {
        "fileId": str(stored.id),
        "filename": stored.filename,
        "startLine": start,
        "endLine": end_line,
        "totalLines": total_lines,
        "text": "\n".join(selected),
        "truncated": truncated,
    }


async def grep_file_text(
    stored: StoredFile,
    pattern: str,
    context: int,
    max_matches: int,
) -> dict[str, Any]:
    try:
        compiled = re.compile(pattern)
    except re.error as exc:
        raise invalid("正则表达式不合法。") from exc

    text = await file_text(stored)
    lines = text.splitlines()
    matches: list[dict[str, Any]] = []
    truncated = False

    for index, line in enumerate(lines):
        if not compiled.search(line):
            continue
        if len(matches) >= max_matches:
            truncated = True
            break
        before = lines[max(0, index - context) : index]
        after = lines[index + 1 : index + 1 + context]
        matches.append(
            {
                "line": index + 1,
                "text": line,
                "contextBefore": before,
                "contextAfter": after,
            }
        )

    return {
        "fileId": str(stored.id),
        "filename": stored.filename,
        "matches": matches,
        "totalLines": len(lines),
        "truncated": truncated,
    }
