"""Persistent HttpOnly session cookies for the browser clients."""

from fastapi import Request, Response

from app.config import get_settings

USER_SESSION_COOKIE = "matrius_session"


def _secure(request: Request) -> bool:
    forwarded = request.headers.get("x-forwarded-proto", "").split(",")[0].strip().lower()
    return forwarded == "https" or request.url.scheme == "https"


def set_session_cookie(
    request: Request, response: Response, token: str, *, scope: str
) -> None:
    """Keep the browser signed in across restarts. SameSite=Lax still blocks
    cross-site form POSTs, and logout/revocation remains the way to end a session."""
    settings = get_settings()
    name = USER_SESSION_COOKIE
    response.set_cookie(
        name,
        token,
        max_age=settings.auth_cookie_seconds,
        httponly=True,
        secure=_secure(request),
        samesite="lax",
        path="/",
    )


def clear_session_cookie(request: Request, response: Response, *, scope: str) -> None:
    """Clear the instance session cookie."""
    name = USER_SESSION_COOKIE
    response.delete_cookie(
        name,
        path="/",
        httponly=True,
        secure=_secure(request),
        samesite="lax",
    )
