import uuid
from datetime import UTC, date, datetime, timedelta
from types import SimpleNamespace

from app.usage.estimate import estimate_conversation, estimate_text_tokens
from app.utils import utcnow

EMPTY_LIFETIME = {
    "input": 0,
    "output": 0,
    "cacheRead": 0,
    "cacheWrite": 0,
    "requests": 0,
    "total": 0,
}


async def test_usage_accumulates_by_local_day(client, create_user):
    _, headers = await create_user()
    today = utcnow().date()
    for payload in (
        {"date": today.isoformat(), "inputTokens": 1000, "outputTokens": 500},
        {
            "date": today.isoformat(),
            "inputTokens": 200,
            "outputTokens": 100,
            "cacheReadTokens": 300,
        },
    ):
        response = await client.post("/api/usage", headers=headers, json=payload)
        assert response.status_code == 200, response.text

    response = await client.get("/api/usage", headers=headers)
    assert response.status_code == 200, response.text
    assert response.json() == {
        "items": [
            {
                "date": today.isoformat(),
                "input": 1200,
                "output": 600,
                "cacheRead": 300,
                "cacheWrite": 0,
                "estimated": False,
                "total": 2100,
                "requests": 2,
            }
        ],
        "lifetime": {
            "input": 1200,
            "output": 600,
            "cacheRead": 300,
            "cacheWrite": 0,
            "requests": 2,
            "total": 2100,
        },
        "estimated": {"input": 0, "output": 0, "requests": 0, "total": 0},
        "backfilled": False,
    }


async def test_usage_is_scoped_to_the_logged_in_account(client, create_user):
    _, alice = await create_user()
    _, bob = await create_user(username="bob")
    today = utcnow().date().isoformat()
    assert (
        await client.post("/api/usage", headers=alice, json={"date": today, "inputTokens": 50})
    ).status_code == 200
    assert (
        await client.post("/api/usage", headers=bob, json={"date": today, "outputTokens": 70})
    ).status_code == 200

    alice_usage = (await client.get("/api/usage", headers=alice)).json()
    bob_usage = (await client.get("/api/usage", headers=bob)).json()
    assert alice_usage["lifetime"]["total"] == 50
    assert alice_usage["items"] == [{
        "date": today,
        "input": 50,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0,
        "estimated": False,
        "total": 50,
        "requests": 1,
    }]
    assert bob_usage["lifetime"]["total"] == 70
    assert bob_usage["items"][0]["output"] == 70


async def test_usage_rejects_skewed_dates_negative_counts_and_anonymous_callers(
    client, create_user
):
    _, headers = await create_user()
    future = (utcnow().date() + timedelta(days=5)).isoformat()
    response = await client.post(
        "/api/usage", headers=headers, json={"date": future, "inputTokens": 1}
    )
    assert response.status_code == 422

    response = await client.post("/api/usage", headers=headers, json={"inputTokens": -1})
    assert response.status_code == 422

    # The login above also set a session cookie, so drop it before checking anonymous access.
    client.cookies.clear()
    response = await client.post("/api/usage", json={"inputTokens": 1})
    assert response.status_code == 401
    response = await client.get("/api/usage")
    assert response.status_code == 401


async def test_usage_window_starts_at_the_requested_day(client, create_user):
    _, headers = await create_user()
    today = utcnow().date()
    yesterday = (today - timedelta(days=1)).isoformat()
    response = await client.post(
        "/api/usage",
        headers=headers,
        json={"date": yesterday, "inputTokens": 40, "outputTokens": 60},
    )
    assert response.status_code == 200

    empty_window = (await client.get("/api/usage?days=1", headers=headers)).json()
    assert empty_window["items"] == []
    assert empty_window["lifetime"]["total"] == 100

    full_window = (await client.get("/api/usage?days=2", headers=headers)).json()
    assert [item["date"] for item in full_window["items"]] == [yesterday]


async def test_usage_ignores_empty_reports(client, create_user):
    _, headers = await create_user()
    response = await client.post(
        "/api/usage", headers=headers, json={"inputTokens": 0, "outputTokens": 0}
    )
    assert response.status_code == 200
    usage = (await client.get("/api/usage", headers=headers)).json()
    assert usage["items"] == []
    assert usage["lifetime"] == EMPTY_LIFETIME


async def test_usage_requires_the_account_feature(client, create_user, monkeypatch):
    from app.usage import router as usage_router_module

    _, headers = await create_user()
    monkeypatch.setattr(usage_router_module, "enabled_features", lambda _user: [])
    assert (await client.get("/api/usage", headers=headers)).status_code == 403
    response = await client.post("/api/usage", headers=headers, json={"inputTokens": 1})
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "feature_unavailable"


def test_estimate_conversation_bills_context_per_reply():
    moment = datetime(2026, 11, 5, 17, 30, tzinfo=UTC)  # 2026-11-06 01:30 at UTC+8.
    messages = [
        SimpleNamespace(role="user", content="你好", quote=None, file_ids=[], created_at=moment),
        SimpleNamespace(
            role="assistant", content="你好，有什么可以帮你？", reasoning="先确认需求",
            file_ids=[], created_at=moment, process=[{"kind": "thinking", "content": "想一想"}],
        ),
        SimpleNamespace(role="user", content="继续", quote=None, file_ids=[], created_at=moment),
        SimpleNamespace(
            role="assistant", content="好的。", reasoning="", file_ids=[],
            created_at=moment, process=None,
        ),
    ]
    buckets = estimate_conversation(messages, utc_offset_minutes=-480)
    input_tokens, output_tokens, requests = buckets[date(2026, 11, 6)]
    assert requests == 2
    # The second reply is billed the first exchange as part of its prompt.
    assert input_tokens > 2 * 900
    assert output_tokens > estimate_text_tokens("你好，有什么可以帮你？")
    assert estimate_text_tokens("hello") == 2


async def _seed_history(client, headers):
    conversation = (
        await client.post(
            "/api/conversations",
            headers=headers,
            json={"clientId": str(uuid.uuid4()), "title": "历史对话"},
        )
    ).json()
    path = f"/api/conversations/{conversation['id']}/messages"
    for payload in (
        {"role": "user", "content": "你好，请帮我写一段产品介绍。", "status": "complete"},
        {
            "role": "assistant",
            "content": "当然可以。这是一段介绍文字，包含产品定位和主要能力。",
            "reasoning": "先分析用户需求，再给出简洁的介绍。",
            "status": "complete",
        },
        {"role": "user", "content": "再短一点。", "status": "complete"},
        {"role": "assistant", "content": "更短的版本：轻量、可自部署的 AI 对话应用。", "status": "complete"},
    ):
        response = await client.post(path, headers=headers, json=payload)
        assert response.status_code == 201, response.text
    return conversation


async def test_backfill_estimates_history_once_and_merges_with_reports(client, create_user):
    _, headers = await create_user()
    await _seed_history(client, headers)

    response = await client.post("/api/usage/backfill", headers=headers, json={})
    assert response.status_code == 200, response.text
    assert response.json()["total"] > 0
    assert (await client.get("/api/usage", headers=headers)).json()["backfilled"] is True

    usage = (await client.get("/api/usage", headers=headers)).json()
    assert usage["estimated"]["total"] == usage["lifetime"]["total"]
    assert usage["estimated"]["requests"] == 2
    assert usage["items"][0]["estimated"] is True

    # The one-time estimate is idempotent and never doubles history.
    again = await client.post("/api/usage/backfill", headers=headers, json={})
    assert again.json()["skipped"] is True
    after = (await client.get("/api/usage", headers=headers)).json()
    assert after["lifetime"]["total"] == usage["lifetime"]["total"]

    today = utcnow().date().isoformat()
    assert (
        await client.post(
            "/api/usage",
            headers=headers,
            json={"date": today, "inputTokens": 10, "outputTokens": 5},
        )
    ).status_code == 200
    merged = (await client.get("/api/usage", headers=headers)).json()
    assert merged["lifetime"]["total"] == usage["lifetime"]["total"] + 15
    assert merged["estimated"]["total"] == usage["estimated"]["total"]
    day = next(item for item in merged["items"] if item["date"] == today)
    assert day["total"] == (next(item for item in usage["items"] if item["date"] == today)["total"] + 15)
    assert day["estimated"] is True
    assert merged["lifetime"]["requests"] == usage["lifetime"]["requests"] + 1


async def test_backfill_marks_empty_history_without_rows(client, create_user):
    _, headers = await create_user()
    response = await client.post("/api/usage/backfill", headers=headers, json={})
    assert response.status_code == 200
    assert response.json() == {"backfilled": True, "skipped": False, "days": 0, "requests": 0, "total": 0}
    usage = (await client.get("/api/usage", headers=headers)).json()
    assert usage["backfilled"] is True
    assert usage["items"] == []
    assert usage["estimated"]["total"] == 0
