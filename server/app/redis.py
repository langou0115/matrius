import logging
import time
import uuid
from typing import Any

from redis.asyncio import Redis

from app.config import get_settings
from app.errors import AppError

logger = logging.getLogger(__name__)

_client: Redis | None = None


def get_redis() -> Redis:
    global _client
    if _client is None:
        _client = Redis.from_url(get_settings().redis_url, decode_responses=True)
    return _client


async def close_redis() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


async def check_redis() -> None:
    await get_redis().ping()


async def cache_get(key: str) -> str | None:
    try:
        return await get_redis().get(key)
    except Exception:  # noqa: BLE001 - cache failures must not break requests
        logger.warning("Redis read failed", exc_info=True)
        return None


async def cache_set(key: str, value: str, ttl_seconds: int) -> None:
    try:
        await get_redis().set(key, value, ex=ttl_seconds)
    except Exception:  # noqa: BLE001
        logger.warning("Redis write failed", exc_info=True)


async def enforce_rate_limit(
    name: str,
    identity: str,
    limit: int,
    window_seconds: int = 60,
    *,
    fail_closed: bool = False,
) -> None:
    """Sliding-window limiter backed by a Redis sorted set."""
    key = f"matrius:rl:{name}:{identity}"
    now = time.time()
    member = f"{now}:{uuid.uuid4().hex}"
    try:
        pipe = get_redis().pipeline()
        pipe.zremrangebyscore(key, 0, now - window_seconds)
        pipe.zadd(key, {member: now})
        pipe.zcard(key)
        pipe.expire(key, window_seconds + 1)
        results: list[Any] = await pipe.execute()
        count = int(results[2])
    except Exception as exc:  # noqa: BLE001
        logger.warning("Rate limiter unavailable", exc_info=True)
        if fail_closed:
            raise AppError(503, "rate_limit_unavailable", "服务暂时不可用，请稍后重试。") from exc
        return

    if count > limit:
        raise AppError(
            429,
            "rate_limited",
            "请求过于频繁，请稍后重试。",
            headers={"Retry-After": str(window_seconds)},
        )


async def record_login_failure(username: str) -> None:
    key = f"matrius:login:fail:{username.lower()}"
    try:
        count = await get_redis().incr(key)
        if count == 1:
            await get_redis().expire(key, 900)
    except Exception:  # noqa: BLE001
        logger.warning("Unable to record login failure", exc_info=True)


async def assert_login_not_locked(username: str) -> None:
    key = f"matrius:login:fail:{username.lower()}"
    try:
        count = int(await get_redis().get(key) or 0)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Login lockout check unavailable", exc_info=True)
        raise AppError(503, "rate_limit_unavailable", "服务暂时不可用，请稍后重试。") from exc
    if count >= 15:
        raise AppError(429, "login_locked", "登录失败次数过多，请 15 分钟后再试。")


async def clear_login_failures(username: str) -> None:
    try:
        await get_redis().delete(f"matrius:login:fail:{username.lower()}")
    except Exception:  # noqa: BLE001
        logger.warning("Unable to clear login failures", exc_info=True)
