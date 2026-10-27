import logging
import re
import time
import uuid
from datetime import datetime
from typing import Any, Literal

from fastapi import APIRouter, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.cookies import ADMIN_SESSION_COOKIE, clear_session_cookie, set_session_cookie
from app.auth.dependencies import AuthContext, client_ip, require_admin
from app.auth.router import _authenticate, _issue_session, user_out
from app.auth.schemas import LoginRequest, LoginResponse, UserOut
from app.auth.security import hash_password, hash_token
from app.cache import concurrency_limit, enforce_rate_limit
from app.config import get_settings
from app.db import get_db
from app.errors import AppError, invalid, not_found
from app.models import AuthSession, User
from app.tools.search import web_search
from app.tools.web_fetch import web_fetch
from app.utils import utcnow

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/admin", tags=["admin"])

USERNAME_RE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,64}$")
DEFAULT_PASSWORD_SUFFIX = "@123"


class AdminUserOut(BaseModel):
    id: uuid.UUID
    username: str
    isAdmin: bool
    mustChangePassword: bool
    disabledAt: datetime | None
    createdAt: datetime


class AdminUserList(BaseModel):
    items: list[AdminUserOut]


class CreateUserRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    isAdmin: bool = False


class ResetPasswordResponse(BaseModel):
    password: str


class UpdateUserRequest(BaseModel):
    disabled: bool


class ToolTestRequest(BaseModel):
    kind: Literal["search", "fetch"]
    query: str | None = Field(default=None, max_length=500)
    url: str | None = Field(default=None, max_length=2000)
    mode: Literal["fast", "full"] = "fast"


def admin_user_out(user: User) -> AdminUserOut:
    return AdminUserOut(
        id=user.id,
        username=user.username,
        isAdmin=user.is_admin,
        mustChangePassword=user.must_change_password,
        disabledAt=user.disabled_at,
        createdAt=user.created_at,
    )


def _default_password(username: str) -> str:
    return f"{username}{DEFAULT_PASSWORD_SUFFIX}"


async def _get_user(db: AsyncSession, user_id: uuid.UUID) -> User:
    user = (await db.execute(select(User).where(User.id == user_id))).scalar_one_or_none()
    if user is None:
        raise not_found("用户不存在。")
    return user


@router.post("/auth/login", response_model=LoginResponse)
async def admin_login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> LoginResponse:
    await enforce_rate_limit("login_ip", client_ip(request), 10, fail_closed=True)
    user = await _authenticate(payload.username, payload.password, admin_only=True, db=db)
    token = await _issue_session(user, scope="admin", db=db)
    set_session_cookie(request, response, token, scope="admin")
    return LoginResponse(token=token, user=user_out(user))


@router.get("/auth/me", response_model=UserOut)
async def admin_me(
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(require_admin),
) -> UserOut:
    cookie = request.cookies.get(ADMIN_SESSION_COOKIE)
    if cookie and hash_token(cookie) == ctx.session.token_hash:
        set_session_cookie(request, response, cookie, scope="admin")
    return user_out(ctx.user)


@router.post("/auth/logout")
async def admin_logout(
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    # get_current_user closes its session, so ctx.session is detached: re-load before mutating.
    session = await db.get(AuthSession, ctx.session.id)
    if session is not None:
        session.revoked_at = utcnow()
        await db.commit()
    clear_session_cookie(request, response, scope="admin")
    return {"ok": True}


@router.get("/users", response_model=AdminUserList)
async def list_users(
    _: AuthContext = Depends(require_admin), db: AsyncSession = Depends(get_db)
) -> AdminUserList:
    users = (await db.execute(select(User).order_by(User.created_at))).scalars().all()
    return AdminUserList(items=[admin_user_out(user) for user in users])


@router.post("/users", response_model=ResetPasswordResponse, status_code=201)
async def create_user(
    payload: CreateUserRequest,
    _: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> ResetPasswordResponse:
    username = payload.username.strip()
    if not USERNAME_RE.fullmatch(username):
        raise AppError(422, "invalid", "用户名必须是 1–64 个不含空白或控制字符的字符。")

    existing = (
        await db.execute(select(User.id).where(func.lower(User.username) == username.lower()))
    ).scalar_one_or_none()
    if existing is not None:
        raise AppError(409, "conflict", "用户名已存在。")

    password = _default_password(username)
    db.add(
        User(
            username=username,
            password_hash=hash_password(password),
            is_admin=payload.isAdmin,
            must_change_password=True,
        )
    )
    try:
        await db.commit()
    except IntegrityError as exc:
        raise AppError(409, "conflict", "用户名已存在。") from exc
    return ResetPasswordResponse(password=password)


@router.post("/users/{user_id}/reset-password", response_model=ResetPasswordResponse)
async def reset_password(
    user_id: uuid.UUID,
    _: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> ResetPasswordResponse:
    user = await _get_user(db, user_id)
    password = _default_password(user.username)
    user.password_hash = hash_password(password)
    user.must_change_password = True
    user.updated_at = utcnow()
    await db.commit()
    return ResetPasswordResponse(password=password)


@router.patch("/users/{user_id}", response_model=AdminUserOut)
async def update_user(
    user_id: uuid.UUID,
    payload: UpdateUserRequest,
    ctx: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserOut:
    user = await _get_user(db, user_id)

    if payload.disabled:
        if user.id == ctx.user.id:
            raise AppError(400, "invalid", "不能停用自己的账号。")
        if user.is_admin and user.disabled_at is None:
            active_admins = (
                await db.execute(
                    select(func.count(User.id)).where(User.is_admin.is_(True), User.disabled_at.is_(None))
                )
            ).scalar_one()
            if active_admins <= 1:
                raise AppError(400, "invalid", "不能停用最后一个管理员。")
        user.disabled_at = utcnow()
    else:
        user.disabled_at = None

    user.updated_at = utcnow()
    await db.commit()
    return admin_user_out(user)


@router.post("/tools/test")
async def test_web_tool(
    payload: ToolTestRequest,
    ctx: AuthContext = Depends(require_admin),
) -> dict[str, Any]:
    """Run one real web tool call from the admin console.

    The same provider, cache and single-flight path as chat is used, so a passing test means
    the deployed API can actually search and extract pages. The admin session is rate-limited
    separately from user chat traffic.
    """
    await enforce_rate_limit("admin_tool_test", str(ctx.user.id), 20)
    started = time.perf_counter()
    using_proxy = bool(get_settings().web_tool_proxy_url)
    try:
        async with concurrency_limit("admin_tool_test", str(ctx.user.id), 2):
            if payload.kind == "search":
                query = (payload.query or "").strip()
                if not query:
                    raise invalid("请输入搜索内容。")
                trace: dict[str, Any] = {}
                results = await web_search(query, 8, trace=trace)
                return {
                    "result": {
                        "kind": "search",
                        "query": query,
                        "tookMs": round((time.perf_counter() - started) * 1000),
                        "proxy": using_proxy,
                        "diagnostics": trace,
                        "results": results,
                    }
                }

            url = (payload.url or "").strip()
            if not url:
                raise invalid("请输入网页地址。")
            trace = {}
            page = await web_fetch(url, payload.mode, trace=trace)
            return {
                "result": {
                    "kind": "fetch",
                    "tookMs": round((time.perf_counter() - started) * 1000),
                    "proxy": using_proxy,
                    "diagnostics": trace,
                    **page,
                }
            }
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001 - keep the admin UI on the normal error contract
        logger.exception("Admin web tool test failed")
        raise AppError(502, "upstream_error", "联网工具测试失败，请稍后重试。") from exc


@router.get("/users/{user_id}", response_model=AdminUserOut)
async def get_user(
    user_id: uuid.UUID,
    _: AuthContext = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> AdminUserOut:
    return admin_user_out(await _get_user(db, user_id))
