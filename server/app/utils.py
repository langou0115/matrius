import base64
import binascii
import re
from datetime import UTC, datetime

from app.errors import invalid

CLIENT_ID_RE = re.compile(r"^[^\s\x00-\x1f\x7f]{1,128}$")


def utcnow() -> datetime:
    return datetime.now(UTC)


def ensure_aware(value: datetime) -> datetime:
    """SQLite drops tzinfo; normalise before comparing with aware timestamps."""
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def to_ms(value: datetime | None) -> int | None:
    # SQLite returns naive UTC values; ensure_aware prevents a local-time shift.
    return int(ensure_aware(value).timestamp() * 1000) if value is not None else None


def validate_client_id(value: str | None) -> str | None:
    if value is None:
        return None
    value = value.strip()
    if not CLIENT_ID_RE.fullmatch(value):
        raise invalid("clientId 必须是 1–128 个不含空白或控制字符的字符。")
    return value


def encode_cursor(*parts: str) -> str:
    raw = "|".join(parts).encode()
    return base64.urlsafe_b64encode(raw).decode().rstrip("=")


def decode_cursor(value: str, expected_parts: int) -> list[str]:
    try:
        padded = value + "=" * (-len(value) % 4)
        raw = base64.urlsafe_b64decode(padded.encode()).decode()
    except (binascii.Error, UnicodeDecodeError) as exc:
        raise invalid("分页游标无效。") from exc
    parts = raw.split("|")
    if len(parts) != expected_parts:
        raise invalid("分页游标无效。")
    return parts


def clamp_page_size(limit: int, *, default: int = 50, maximum: int = 100) -> int:
    if limit < 1:
        raise invalid("limit 必须大于 0。")
    return min(limit, maximum)
