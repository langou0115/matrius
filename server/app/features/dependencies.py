from collections.abc import Callable

from fastapi import Depends

from app.auth.dependencies import AuthContext, require_password_ready
from app.errors import AppError
from app.features.registry import enabled_features


def require_feature(feature_id: str) -> Callable:
    async def check(ctx: AuthContext = Depends(require_password_ready)) -> AuthContext:
        if feature_id not in enabled_features(ctx.user):
            raise AppError(403, "feature_unavailable", "当前账号尚未开放此功能。")
        return ctx

    return check
