from types import SimpleNamespace

import pytest

from app import cache
from app.errors import AppError


@pytest.fixture
def clock(monkeypatch):
    now = [1000.0]
    monkeypatch.setattr(cache, "_now", lambda: now[0])
    return now


async def test_cache_entries_expire(clock):
    await cache.cache_set("key", "value", ttl_seconds=30)
    assert await cache.cache_get("key") == "value"
    clock[0] += 29
    assert await cache.cache_get("key") == "value"
    clock[0] += 2
    assert await cache.cache_get("key") is None


async def test_zero_ttl_is_never_returned(clock):
    await cache.cache_set("key", "value", ttl_seconds=0)
    assert await cache.cache_get("key") is None


async def test_cache_overwrites_and_tracks_bytes(monkeypatch):
    settings = SimpleNamespace(cache_max_entries=100, cache_max_bytes=1000)
    monkeypatch.setattr(cache, "get_settings", lambda: settings)
    await cache.cache_set("key", "longer", ttl_seconds=60)
    await cache.cache_set("key", "x", ttl_seconds=60)
    assert await cache.cache_get("key") == "x"
    assert cache._cache_bytes == len(b"x")
    await cache.cache_set("key", "yy", ttl_seconds=60)
    assert cache._cache_bytes == len(b"yy")


async def test_cache_evicts_oldest_entries_when_full(monkeypatch):
    settings = SimpleNamespace(cache_max_entries=2, cache_max_bytes=10_000)
    monkeypatch.setattr(cache, "get_settings", lambda: settings)
    for key in ("a", "b", "c"):
        await cache.cache_set(key, key, ttl_seconds=60)
    assert await cache.cache_get("a") is None
    assert await cache.cache_get("b") == "b"
    assert await cache.cache_get("c") == "c"


async def test_cache_evicts_oldest_entries_over_the_byte_limit(monkeypatch):
    settings = SimpleNamespace(cache_max_entries=100, cache_max_bytes=5)
    monkeypatch.setattr(cache, "get_settings", lambda: settings)
    await cache.cache_set("a", "1234", ttl_seconds=60)
    await cache.cache_set("b", "5678", ttl_seconds=60)
    assert await cache.cache_get("a") is None
    assert await cache.cache_get("b") == "5678"
    assert cache._cache_bytes == len(b"5678")


async def test_rate_limit_allows_exactly_the_limit_then_resets(clock):
    for _ in range(3):
        await cache.enforce_rate_limit("chat", "user-a", 3)
    with pytest.raises(AppError) as raised:
        await cache.enforce_rate_limit("chat", "user-a", 3)
    assert raised.value.status_code == 429
    assert raised.value.code == "rate_limited"
    assert raised.value.headers == {"Retry-After": "60"}

    # Another identity has its own bucket.
    await cache.enforce_rate_limit("chat", "user-b", 3)

    clock[0] += 60
    await cache.enforce_rate_limit("chat", "user-a", 3)


async def test_concurrency_limit_rejects_extra_inflight_calls_per_identity():
    async with cache.concurrency_limit("tool_search", "alice", 1):
        with pytest.raises(AppError) as raised:
            async with cache.concurrency_limit("tool_search", "alice", 1):
                pass
        assert raised.value.status_code == 429
        assert raised.value.code == "rate_limited"
        assert raised.value.headers == {"Retry-After": "5"}
        # Another account still has its own slot.
        async with cache.concurrency_limit("tool_search", "bob", 1):
            pass

    # The slot is released even after a rejected nested acquisition.
    async with cache.concurrency_limit("tool_search", "alice", 1):
        pass
    assert cache._concurrency == {}


async def test_concurrency_limit_releases_the_slot_when_the_body_raises():
    with pytest.raises(RuntimeError):
        async with cache.concurrency_limit("tool_fetch", "alice", 2):
            raise RuntimeError("boom")
    assert cache._concurrency == {}


async def test_close_cache_clears_all_state():
    await cache.cache_set("key", "value", ttl_seconds=60)
    await cache.enforce_rate_limit("chat", "alice", 5)
    await cache.check_cache()
    await cache.close_cache()
    assert await cache.cache_get("key") is None
    assert cache._cache == {}
    assert cache._rate_windows == {}
    assert cache._cache_bytes == 0
