import asyncio
import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.cache import check_cache
from app.db import engine
from app.schema import schema_status
from app.storage import check_storage

router = APIRouter(prefix="/api/health", tags=["health"])
logger = logging.getLogger(__name__)


async def _check_db() -> None:
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))


async def _check_schema() -> None:
    ok, detail = await schema_status()
    if not ok:
        raise RuntimeError(detail)


@router.get("")
async def health() -> JSONResponse:
    try:
        await asyncio.wait_for(_check_db(), timeout=5)
    except Exception:  # noqa: BLE001 - health must not leak internals
        return JSONResponse({"service": "matrius", "status": "error"}, status_code=503)
    try:
        await asyncio.wait_for(_check_schema(), timeout=5)
    except Exception as error:  # noqa: BLE001 - keep the response generic, log the reason
        logger.error("Database schema check failed: %s", error)
        return JSONResponse({"service": "matrius", "status": "error"}, status_code=503)
    return JSONResponse({"service": "matrius", "status": "ok"})


@router.get("/ready")
async def readiness() -> JSONResponse:
    checks = {
        "database": _check_db(),
        "schema": _check_schema(),
        "cache": check_cache(),
        "storage": asyncio.to_thread(check_storage),
    }
    outcomes = await asyncio.gather(
        *(asyncio.wait_for(check, timeout=5) for check in checks.values()),
        return_exceptions=True,
    )
    results = {
        name: "error" if isinstance(outcome, BaseException) else "ok"
        for name, outcome in zip(checks, outcomes, strict=True)
    }
    healthy = all(value == "ok" for value in results.values())
    return JSONResponse(
        {"service": "matrius", "status": "ok" if healthy else "degraded", "checks": results},
        status_code=200 if healthy else 503,
    )
