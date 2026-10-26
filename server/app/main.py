import asyncio
import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.account.router import router as account_router
from app.admin.router import router as admin_router
from app.auth.router import router as auth_router
from app.cache import close_cache
from app.config import get_settings
from app.conversations.router import router as conversations_router
from app.db import dispose_engine, ensure_data_dir
from app.errors import AppError, app_error_handler, validation_error_handler
from app.features.router import router as features_router
from app.files.router import router as files_router
from app.health import router as health_router
from app.logging import configure_logging
from app.tools.router import router as tools_router
from app.tools.search import close_bing_client

logger = logging.getLogger(__name__)

MAX_IMPORT_BODY = 8 * 1024 * 1024


@asynccontextmanager
async def lifespan(_: FastAPI):
    try:
        await asyncio.to_thread(ensure_data_dir)
    except Exception:  # noqa: BLE001 - readiness reports the failure
        logger.warning("Data directory is not available at startup", exc_info=True)
    yield
    await close_cache()
    await close_bing_client()
    await dispose_engine()


def create_app() -> FastAPI:
    configure_logging()
    settings = get_settings()
    app = FastAPI(
        title="Matrius API",
        version="0.1.0",
        lifespan=lifespan,
        docs_url=None if settings.app_env == "production" else "/docs",
        redoc_url=None,
    )

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=False,
            allow_methods=["*"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            expose_headers=["X-Request-ID"],
        )

    app.add_exception_handler(AppError, app_error_handler)
    app.add_exception_handler(RequestValidationError, validation_error_handler)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex
        request.state.request_id = request_id

        content_length = request.headers.get("content-length")
        if request.url.path == "/api/account/import" and content_length is not None:
            try:
                if int(content_length) > MAX_IMPORT_BODY:
                    return JSONResponse(
                        {
                            "error": {
                                "code": "payload_too_large",
                                "message": "导入数据超过单批 8 MiB 限制。",
                            }
                        },
                        status_code=413,
                        headers={"X-Request-ID": request_id},
                    )
            except ValueError:
                pass

        started = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - started) * 1000, 2)
        response.headers["X-Request-ID"] = request_id
        if request.url.path.startswith(("/api/auth/", "/api/admin/auth/", "/api/features")):
            response.headers["Cache-Control"] = "no-store"
        logger.info(
            "request",
            extra={
                "request_id": request_id,
                "user_id": getattr(request.state, "user_id", None),
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": duration_ms,
            },
        )
        return response

    app.include_router(health_router)
    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(conversations_router)
    app.include_router(account_router)
    app.include_router(files_router)
    app.include_router(tools_router)
    app.include_router(features_router)
    return app


app = create_app()
