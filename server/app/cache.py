"""In-process cache, rate limiting and login lockout.

The backend runs as a single uvicorn process (SQLite has a single writer), so
module-level state is enough. All helpers are async to keep the call sites
identical to the previous Redis implementation, but no operation awaits: the
event loop serialises them, so no lock is required.

State is intentionally lost on restart. Sessions live in the database, and
rate-limit counters are expected to reset.
"""

import logging
import time
from collections import deque
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from app.config import get_settings
from app.errors import AppError

logger = logging.getLogger(__name__)

LOGIN_FAILURE_LIMIT = 15
LOGIN_FAILURE_WINDOW_SECONDS = 900
_SWEEP_EVERY = 256
# Every caller currently uses a 60s window; an hour is a safe retention bound.
_RATE_BUCKET_TTL_SECONDS = 3600

# key -> (expires_at, value, byte size)
_cache: dict[str, tuple[float, str, int]] = {}
_cache_bytes = 0
# key -> monotonic timestamps inside the current window
_rate_windows: dict[str, deque[float]] = {}
# username -> (failures, window_expires_at)
_login_failures: dict[str, tuple[int, float]] = {}
# name:identity -> number of calls currently holding a slot
_concurrency: dict[str, int] = {}
_operations = 0


def _now() -> float:
    return time.monotonic()


def _sweep(now: float) -> None:
    global _operations
    _operations += 1
    if _operations % _SWEEP_EVERY:
        return
    for key in [key for key, (expires, _, _) in _cache.items() if expires <= now]:
        _remove_cached(key)
    for key, bucket in list(_rate_windows.items()):
        while bucket and bucket[0] <= now - _RATE_BUCKET_TTL_SECONDS:
            bucket.popleft()
        if not bucket:
            _rate_windows.pop(key, None)
    for key in [key for key, (_, expires) in _login_failures.items() if expires <= now]:
        _login_failures.pop(key, None)


def _remove_cached(key: str) -> None:
    global _cache_bytes
    entry = _cache.pop(key, None)
    if entry is not None:
        _cache_bytes -= entry[2]


def _evict() -> None:
    settings = get_settings()
    while _cache and (
        len(_cache) > settings.cache_max_entries or _cache_bytes > settings.cache_max_bytes
    ):
        # Insertion order is the eviction order (oldest first).
        _remove_cached(next(iter(_cache)))


async def cache_get(key: str) -> str | None:
    now = _now()
    entry = _cache.get(key)
    if entry is None:
        _sweep(now)
        return None
    expires, value, _ = entry
    if expires <= now:
        _remove_cached(key)
        return None
    return value


async def cache_set(key: str, value: str, ttl_seconds: int) -> None:
    global _cache_bytes
    _remove_cached(key)
    encoded_size = len(value.encode("utf-8"))
    _cache[key] = (_now() + max(0, ttl_seconds), value, encoded_size)
    _cache_bytes += encoded_size
    _evict()
    _sweep(_now())


async def enforce_rate_limit(
    name: str,
    identity: str,
    limit: int,
    window_seconds: int = 60,
    *,
    fail_closed: bool = False,
) -> None:
    """Sliding-window limiter. ``fail_closed`` is kept for call-site compatibility."""
    key = f"{name}:{identity}"
    now = _now()
    cutoff = now - window_seconds
    bucket = _rate_windows.setdefault(key, deque())
    while bucket and bucket[0] <= cutoff:
        bucket.popleft()
    if len(bucket) >= limit:
        raise AppError(
            429,
            "rate_limited",
            "请求过于频繁，请稍后重试。",
            headers={"Retry-After": str(window_seconds)},
        )
    bucket.append(now)
    _sweep(now)


@asynccontextmanager
async def concurrency_limit(name: str, identity: str, limit: int) -> AsyncIterator[None]:
    """Per-user in-flight cap, checked before queuing on the global upstream semaphore.

    Without it one account can occupy every provider slot and make everyone else wait. The
    limit rejects immediately instead of queueing, so a runaway agent loop is visible to that
    user rather than silently consuming the shared capacity.
    """
    key = f"{name}:{identity}"
    current = _concurrency.get(key, 0)
    if current >= limit:
        raise AppError(
            429,
            "rate_limited",
            "同时进行的联网请求过多，请稍后重试。",
            headers={"Retry-After": "5"},
        )
    _concurrency[key] = current + 1
    try:
        yield
    finally:
        remaining = _concurrency.get(key, 1) - 1
        if remaining > 0:
            _concurrency[key] = remaining
        else:
            _concurrency.pop(key, None)


async def record_login_failure(username: str) -> None:
    key = username.lower()
    now = _now()
    count, expires = _login_failures.get(key, (0, now + LOGIN_FAILURE_WINDOW_SECONDS))
    if expires <= now:
        count, expires = 0, now + LOGIN_FAILURE_WINDOW_SECONDS
    _login_failures[key] = (count + 1, expires)


async def assert_login_not_locked(username: str) -> None:
    key = username.lower()
    now = _now()
    entry = _login_failures.get(key)
    if entry is None:
        return
    count, expires = entry
    if expires <= now:
        _login_failures.pop(key, None)
        return
    if count >= LOGIN_FAILURE_LIMIT:
        raise AppError(429, "login_locked", "登录失败次数过多，请 15 分钟后再试。")


async def clear_login_failures(username: str) -> None:
    _login_failures.pop(username.lower(), None)


async def check_cache() -> None:
    """The in-process cache cannot be unavailable; kept for readiness checks."""
    return None


async def close_cache() -> None:
    reset_cache()


def reset_cache() -> None:
    global _cache_bytes, _operations
    _cache.clear()
    _rate_windows.clear()
    _login_failures.clear()
    _concurrency.clear()
    _cache_bytes = 0
    _operations = 0
