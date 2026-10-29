from dataclasses import asdict

from fastapi import APIRouter, Depends, Response

from app.auth.dependencies import AuthContext, require_password_ready
from app.features.registry import FEATURES, enabled_features

router = APIRouter(prefix="/api/features", tags=["features"])


@router.get("")
async def available_features(
    response: Response, ctx: AuthContext = Depends(require_password_ready)
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {"features": [asdict(FEATURES[key]) for key in enabled_features(ctx.user)]}
