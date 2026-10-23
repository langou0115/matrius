from dataclasses import dataclass
from typing import Literal

from app.config import get_settings
from app.models import User


@dataclass(frozen=True)
class Feature:
    id: str
    name: str
    description: str
    stage: Literal["preview", "stable"] = "preview"


# Register new functionality here as preview. Promoting an entry to stable ships it
# to every account with the next deployment.
FEATURES = {
    "labs": Feature("labs", "实验功能", "提前体验正在验证的新功能。"),
}


def enabled_features(user: User) -> list[str]:
    if user.disabled_at is not None or user.must_change_password:
        return []
    settings = get_settings()
    preview_user = user.username.casefold() == settings.preview_username.casefold()
    return [
        key for key, feature in FEATURES.items()
        if preview_user or feature.stage == "stable"
    ]
