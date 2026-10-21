import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.config import get_settings
from app.models import User


@dataclass(frozen=True)
class Feature:
    id: str
    name: str
    description: str
    stage: Literal["preview", "stable"] = "preview"


# Register new functionality here as preview. Promote individual entries to stable
# in the reviewed commit deployed by CD; publishing does not promote everything.
FEATURES = {
    "labs": Feature("labs", "实验功能", "提前体验正在验证的新功能。"),
}


def enabled_features(user: User) -> list[str]:
    if user.disabled_at is not None or user.must_change_password:
        return []
    settings = get_settings()
    preview_user = user.username.casefold() == settings.preview_username.casefold()
    try:
        value = json.loads(Path(settings.feature_releases_file).read_text())
        released = {key for key in value if isinstance(key, str)} if isinstance(value, list) else set()
    except (OSError, ValueError):
        released = set()
    return [
        key for key, feature in FEATURES.items()
        if preview_user or (feature.stage == "stable" and key in released)
    ]
