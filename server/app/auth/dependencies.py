import uuid
from dataclasses import dataclass
from datetime import timedelta

from fastapi import Depends, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.cookies import ADMIN_SESSION_COOKIE, USER_SESSION_COOKIE
from app.auth.security import hash_token
from app.cache import enforce_rate_limit
from app.db import get_db
from app.errors import AppError, unauthorized
from app.models import AuthSession, User
from app.utils import ensure_aware, utcnow

_bearer = HTTPBearer(auto_error=False)
_LAST_SEEN_INTERVAL = timedelta(hours=1)


@dataclass
class AuthContext:
    user: User
    session: AuthSession


def client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> AuthContext:
    if credentials is not None:
        if credentials.scheme.lower() != "bearer":
            raise unauthorized()
        token = credentials.credentials
    else:
        # The web client relies on the HttpOnly cookie; native clients keep using Bearer.
        # Keep the two browser sessions isolated: an admin console login must not also
        # sign the chat UI in as that admin, and vice versa.
        cookie = (
            ADMIN_SESSION_COOKIE
            if request.url.path.startswith("/api/admin/")
            else USER_SESSION_COOKIE
        )
        token = request.cookies.get(cookie)
    if not token:
        raise unauthorized()

    token_hash = hash_token(token)
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(AuthSession.token_hash == token_hash)
        )
    ).first()
    if row is None:
        raise unauthorized("登录已失效，请重新登录。")

    session, user = row
    now = utcnow()
    if session.revoked_at is not None or (
        session.expires_at is not None and ensure_aware(session.expires_at) <= now
    ):
        raise unauthorized("登录已失效，请重新登录。")
    if user.disabled_at is not None:
        raise unauthorized("账号已被停用。")

    if ensure_aware(session.last_seen_at) < now - _LAST_SEEN_INTERVAL:
        session.last_seen_at = now
        await db.commit()

    request.state.user_id = str(user.id)
    # Auth is its own unit of work. Release the pooled connection before the route runs:
    # otherwise a long web search/fetch keeps it checked out for up to fetch_timeout_seconds,
    # and a small SQLite pool (where a single connection is fastest, see
    # doc/performance-multiaccount.md)
    # would serialise every other request behind it. The returned objects are detached but
    # their column values are already loaded; routes that mutate them re-load by id first.
    await db.close()
    return AuthContext(user=user, session=session)


async def require_password_ready(ctx: AuthContext = Depends(get_current_user)) -> AuthContext:
    if ctx.user.must_change_password:
        raise AppError(403, "password_change_required", "请先修改初始密码。")
    return ctx


async def require_admin(ctx: AuthContext = Depends(require_password_ready)) -> AuthContext:
    if not ctx.user.is_admin or ctx.session.scope != "admin":
        raise AppError(403, "forbidden", "需要管理员权限。")
    return ctx


def user_id_of(ctx: AuthContext) -> uuid.UUID:
    return ctx.user.id


async def read_rate_limit(ctx: AuthContext = Depends(require_password_ready)) -> AuthContext:
    await enforce_rate_limit("read", str(ctx.user.id), 240)
    return ctx


async def write_rate_limit(ctx: AuthContext = Depends(require_password_ready)) -> AuthContext:
    await enforce_rate_limit("write", str(ctx.user.id), 120)
    return ctx
