import asyncio

import httpx
from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.config import get_settings
from app.db import engine
from app.redis import check_redis
from app.storage import check_storage

router = APIRouter(prefix="/api/health", tags=["health"])


async def _check_db() -> None:
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))


async def _check_openserp() -> None:
    async with httpx.AsyncClient(timeout=5) as client:
        response = await client.get(f"{get_settings().openserp_url.rstrip('/')}/health")
        response.raise_for_status()


@router.get("")
async def health() -> JSONResponse:
    try:
        await asyncio.wait_for(_check_db(), timeout=5)
    except Exception:  # noqa: BLE001 - health must not leak internals
        return JSONResponse({"service": "matrius", "status": "error"}, status_code=503)
    return JSONResponse({"service": "matrius", "status": "ok"})


@router.get("/ready")
async def readiness() -> JSONResponse:
    checks = {
        "database": _check_db(),
        "redis": check_redis(),
        "storage": asyncio.to_thread(check_storage),
        "search": _check_openserp(),
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
