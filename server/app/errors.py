from typing import Any

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse


class AppError(Exception):
    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        *,
        details: Any = None,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.details = details
        self.headers = headers


def unauthorized(message: str = "请先登录。") -> AppError:
    return AppError(401, "unauthorized", message, headers={"WWW-Authenticate": "Bearer"})


def not_found(message: str = "资源不存在。") -> AppError:
    return AppError(404, "not_found", message)


def conflict(message: str, current: Any = None) -> AppError:
    details = {"current": current} if current is not None else None
    return AppError(409, "conflict", message, details=details)


def invalid(message: str, details: Any = None) -> AppError:
    return AppError(422, "invalid", message, details=details)


async def app_error_handler(_: Request, exc: AppError) -> JSONResponse:
    body: dict[str, Any] = {"error": {"code": exc.code, "message": exc.message}}
    if isinstance(exc.details, dict):
        body["error"].update(exc.details)
    elif exc.details is not None:
        body["error"]["details"] = exc.details
    return JSONResponse(body, status_code=exc.status_code, headers=exc.headers)


async def validation_error_handler(_: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        {
            "error": {
                "code": "validation_error",
                "message": "请求参数不合法。",
                "details": exc.errors(),
            }
        },
        status_code=422,
    )
