from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.dependencies import AuthContext, read_rate_limit
from app.cache import concurrency_limit, enforce_rate_limit
from app.config import get_settings
from app.db import get_db
from app.errors import invalid
from app.files.router import get_owned_file
from app.tools.files import grep_file_text, read_file_text
from app.tools.schemas import FetchRequest, FileGrepRequest, FileReadRequest, SearchRequest
from app.tools.search import web_search
from app.tools.web_fetch import web_fetch

router = APIRouter(prefix="/api/tools", tags=["tools"])


@router.post("/search")
async def search_web(
    payload: SearchRequest,
    ctx: AuthContext = Depends(read_rate_limit),
) -> dict[str, Any]:
    await enforce_rate_limit("tool_search", str(ctx.user.id), 30)
    query = payload.query.strip()
    if not query:
        raise invalid("搜索关键词不能为空。")
    async with concurrency_limit("tool_search", str(ctx.user.id), get_settings().tool_user_concurrency):
        results = await web_search(query, payload.limit)
    return {"query": query, "results": results}


@router.post("/fetch")
async def fetch_web(
    payload: FetchRequest,
    ctx: AuthContext = Depends(read_rate_limit),
) -> dict[str, Any]:
    await enforce_rate_limit("tool_fetch", str(ctx.user.id), 30)
    async with concurrency_limit("tool_fetch", str(ctx.user.id), get_settings().tool_user_concurrency):
        return await web_fetch(payload.url, payload.mode)


@router.post("/files/read")
async def read_file(
    payload: FileReadRequest,
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await enforce_rate_limit("tool_file_read", str(ctx.user.id), 60)
    stored = await get_owned_file(db, ctx.user.id, payload.fileId)
    # Extraction can take seconds; do not pin a pool connection to it.
    await db.close()
    max_chars = min(payload.maxChars, get_settings().fetch_max_chars)
    return await read_file_text(stored, payload.start, payload.end, max_chars)


@router.post("/files/grep")
async def grep_file(
    payload: FileGrepRequest,
    ctx: AuthContext = Depends(read_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    await enforce_rate_limit("tool_file_grep", str(ctx.user.id), 60)
    stored = await get_owned_file(db, ctx.user.id, payload.fileId)
    # RegExp scanning and extraction run outside the DB; release the connection first.
    await db.close()
    return await grep_file_text(stored, payload.pattern, payload.context, payload.maxMatches)
