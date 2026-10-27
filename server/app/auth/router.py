from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.cookies import USER_SESSION_COOKIE, clear_session_cookie, set_session_cookie
from app.auth.dependencies import AuthContext, client_ip, get_current_user
from app.auth.schemas import ChangePasswordRequest, LoginRequest, LoginResponse, UserOut
from app.auth.security import (
    DUMMY_HASH,
    generate_token,
    hash_password,
    hash_token,
    verify_password,
)
from app.cache import (
    assert_login_not_locked,
    clear_login_failures,
    enforce_rate_limit,
    record_login_failure,
)
from app.db import get_db
from app.errors import AppError, unauthorized
from app.features.registry import enabled_features
from app.models import AuthSession, User
from app.utils import utcnow

router = APIRouter(prefix="/api/auth", tags=["auth"])


def user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        username=user.username,
        isAdmin=user.is_admin,
        mustChangePassword=user.must_change_password,
        features=enabled_features(user),
    )


async def _authenticate(
    username: str, password: str, *, admin_only: bool, db: AsyncSession
) -> User:
    normalized = username.strip()
    await assert_login_not_locked(normalized)
    await enforce_rate_limit("login_user", normalized.lower(), 5, fail_closed=True)

    user = (
        await db.execute(select(User).where(func.lower(User.username) == normalized.lower()))
    ).scalar_one_or_none()

    password_hash = user.password_hash if user is not None else DUMMY_HASH
    valid = verify_password(password_hash, password)
    if user is None or not valid:
        await record_login_failure(normalized)
        raise unauthorized("用户名或密码错误。")

    if user.disabled_at is not None:
        await record_login_failure(normalized)
        raise AppError(403, "account_disabled", "账号已被停用。")
    if admin_only and not user.is_admin:
        await record_login_failure(normalized)
        raise AppError(403, "forbidden", "需要管理员权限。")

    await clear_login_failures(normalized)
    return user


async def _issue_session(user: User, *, scope: str, db: AsyncSession) -> str:
    token = generate_token()
    db.add(
        AuthSession(
            user_id=user.id,
            token_hash=hash_token(token),
            scope=scope,
            expires_at=None,
        )
    )
    await db.commit()
    return token


@router.post("/login", response_model=LoginResponse)
async def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> LoginResponse:
    await enforce_rate_limit("login_ip", client_ip(request), 10, fail_closed=True)
    user = await _authenticate(payload.username, payload.password, admin_only=False, db=db)
    token = await _issue_session(user, scope="user", db=db)
    set_session_cookie(request, response, token, scope="user")
    return LoginResponse(token=token, user=user_out(user))


@router.get("/me", response_model=UserOut)
async def me(
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(get_current_user),
) -> UserOut:
    # Slide the browser cookie forward on each account check so an active user is not
    # signed out when the original Max-Age elapses.
    cookie = request.cookies.get(USER_SESSION_COOKIE)
    if cookie and hash_token(cookie) == ctx.session.token_hash:
        set_session_cookie(request, response, cookie, scope="user")
    return user_out(ctx.user)


@router.post("/logout")
async def logout(
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    # get_current_user closes its session, so ctx.session is detached: re-load before mutating.
    session = await db.get(AuthSession, ctx.session.id)
    if session is not None:
        session.revoked_at = utcnow()
        await db.commit()
    clear_session_cookie(request, response, scope=ctx.session.scope)
    return {"ok": True}


@router.post("/change-password")
async def change_password(
    payload: ChangePasswordRequest,
    ctx: AuthContext = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> dict[str, bool]:
    # get_current_user closes its session, so ctx.user is detached: re-load before mutating.
    user = await db.get(User, ctx.user.id)
    if user is None:
        raise unauthorized("登录已失效，请重新登录。")
    if not verify_password(user.password_hash, payload.currentPassword):
        raise unauthorized("当前密码不正确。")
    if payload.currentPassword == payload.newPassword:
        raise AppError(422, "invalid", "新密码不能与当前密码相同。")
    user.password_hash = hash_password(payload.newPassword)
    user.must_change_password = False
    user.updated_at = utcnow()
    await db.commit()
    return {"ok": True}
