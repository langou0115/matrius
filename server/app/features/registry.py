from dataclasses import dataclass

from app.models import User


@dataclass(frozen=True)
class Feature:
    id: str
    name: str
    description: str


# Register gated functionality here. Every password-ready account receives every
# entry; there is no preview allow-list. Keep the list intentional: a feature is
# only added here when its API routes need `require_feature` and the client needs
# `useFeature`.
FEATURES = {
    "files": Feature("files", "文件与资料库", "上传文档、让模型读取或生成 Office/PDF 文件。"),
}


def enabled_features(user: User) -> list[str]:
    if user.disabled_at is not None or user.must_change_password:
        return []
    return list(FEATURES)
