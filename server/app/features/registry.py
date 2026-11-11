from dataclasses import dataclass


@dataclass(frozen=True)
class Feature:
    id: str
    name: str
    description: str


# Register gated functionality here. The instance receives every
# entry; there is no preview allow-list. Keep the list intentional: a feature is
# only added here when its API routes need `require_feature` and the client needs
# `useFeature`.
FEATURES = {
    "files": Feature("files", "文件与资料库", "上传文档、让模型读取或生成 Office/PDF 文件。"),
    "usage": Feature("usage", "Token 用量", "查看实例的模型 token 使用量与每日趋势。"),
}


def enabled_features() -> list[str]:
    return list(FEATURES)
