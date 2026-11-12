from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache import concurrency_limit, enforce_rate_limit
from app.config import get_settings
from app.db import get_db
from app.errors import invalid
from app.files.router import get_owned_file
from app.instance.dependencies import InstanceContext, ToolCaller, get_tool_caller, read_rate_limit
from app.tools.files import grep_file_text, read_file_text
from app.tools.schemas import FetchRequest, FileGrepRequest, FileReadRequest, SearchRequest
from app.tools.search import web_search
from app.tools.web_fetch import web_fetch

router = APIRouter(prefix="/api/tools", tags=["tools"])


def _tool_budget(caller: ToolCaller) -> tuple[int, int]:
    """Per-minute call budget and in-flight cap for the instance owner."""
    settings = get_settings()
    return 60, settings.tool_concurrency


@router.post("/search")
async def search_web(
    payload: SearchRequest,
    caller: ToolCaller = Depends(get_tool_caller),
) -> dict[str, Any]:
    calls_per_minute, concurrency = _tool_budget(caller)
    await enforce_rate_limit("tool_search", caller.identity, calls_per_minute)
    query = payload.query.strip()
    if not query:
        raise invalid("搜索关键词不能为空。")
    async with concurrency_limit("tool_search", caller.identity, concurrency):
        results = await web_search(query, payload.limit)
    return {"query": query, "results": results}


@router.post("/fetch")
async def fetch_web(
    payload: FetchRequest,
    caller: ToolCaller = Depends(get_tool_caller),
) -> dict[str, Any]:
    calls_per_minute, concurrency = _tool_budget(caller)
    await enforce_rate_limit("tool_fetch", caller.identity, calls_per_minute)
    async with concurrency_limit("tool_fetch", caller.identity, concurrency):
        return await web_fetch(payload.url, payload.mode)


@router.post("/files/read")
async def read_file(
    payload: FileReadRequest,
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await enforce_rate_limit("tool_file_read", str(ctx.instance_id), 60)
    stored = await get_owned_file(db, ctx.instance_id, payload.fileId)
    # Extraction can take seconds; do not pin a pool connection to it.
    await db.close()
    max_chars = min(payload.maxChars, get_settings().fetch_max_chars)
    return await read_file_text(stored, payload.start, payload.end, max_chars)


@router.post("/files/grep")
async def grep_file(
    payload: FileGrepRequest,
    ctx: InstanceContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await enforce_rate_limit("tool_file_grep", str(ctx.instance_id), 60)
    stored = await get_owned_file(db, ctx.instance_id, payload.fileId)
    # RegExp scanning and extraction run outside the DB; release the connection first.
    await db.close()
    return await grep_file_text(stored, payload.pattern, payload.context, payload.maxMatches)
