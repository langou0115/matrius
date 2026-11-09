from dataclasses import asdict

from fastapi import APIRouter, Depends, Response

from app.features.registry import FEATURES, enabled_features
from app.instance.dependencies import InstanceContext, get_instance

router = APIRouter(prefix="/api/features", tags=["features"])


@router.get("")
async def available_features(
    response: Response, ctx: InstanceContext = Depends(get_instance)
) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return {"features": [asdict(FEATURES[key]) for key in enabled_features()]}
