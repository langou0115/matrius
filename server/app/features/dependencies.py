from collections.abc import Callable

from fastapi import Depends

from app.errors import AppError
from app.features.registry import enabled_features
from app.instance.dependencies import InstanceContext, get_instance


def require_feature(feature_id: str) -> Callable:
    async def check(ctx: InstanceContext = Depends(get_instance)) -> InstanceContext:
        if feature_id not in enabled_features():
            raise AppError(403, "feature_unavailable", "当前实例尚未开放此功能。")
        return ctx

    return check
