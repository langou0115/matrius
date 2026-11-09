"""``POST /api/tools/file`` — the only document-related tool endpoint.

The agent runs in the browser, so this route is a stateless REST surface: it
does not run an agent loop and keeps no conversation state. Drafts are the one
piece of server state, and they are scoped per user and expire.
"""

from typing import Any

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.cache import concurrency_limit, enforce_rate_limit
from app.config import get_settings
from app.db import get_db
from app.documents.schemas import FileToolRequest
from app.documents.service import run
from app.features.dependencies import require_feature
from app.instance.dependencies import InstanceContext

router = APIRouter(prefix="/api/tools", tags=["tools"])

READ_OPERATIONS = frozenset({"list", "read", "grep", "help", "inspect"})


@router.post("/file")
async def file_tool(
    payload: FileToolRequest,
    ctx: InstanceContext = Depends(require_feature("files")),
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    settings = get_settings()
    instance_id = str(ctx.instance_id)
    if payload.operation in READ_OPERATIONS:
        await enforce_rate_limit("tool_file_read", instance_id, settings.document_read_calls_per_minute)
    else:
        await enforce_rate_limit("tool_file_write", instance_id, settings.document_write_calls_per_minute)
    async with concurrency_limit("tool_file", instance_id, settings.document_tool_concurrency):
        return await run(db, ctx.instance_id, payload)
