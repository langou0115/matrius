import asyncio

import pytest
from sqlalchemy import func, select

from app.models import Message


def snapshot(client_id="deleted-chat"):
    return {"schemaVersion": 1, "chat": {"conversations": [{
        "id": client_id, "title": "old copy", "updatedAt": 100,
        "messages": [{"id": "old-message", "role": "user", "content": "private text"}],
    }]}}


async def test_sync_deletion_removes_content_and_rejects_stale_reuploads(client, create_user, session_factory):
    _, headers = await create_user()
    payload = snapshot()
    assert (await client.post("/api/account/import", headers=headers, json=payload)).status_code == 200
    delete_payload = {"schemaVersion": 1, "chat": {"deletedConversationIds": ["deleted-chat"]}}
    for _ in range(2):
        response = await client.post("/api/account/import", headers=headers, json=delete_payload)
        assert response.status_code == 200, response.text
    # Newer timestamps and even a combined delete + upload must not revive the identity.
    payload["chat"]["conversations"][0]["updatedAt"] = 9999999999999
    for chat in (payload["chat"], {**payload["chat"], "deletedConversationIds": ["deleted-chat"]}):
        response = await client.post("/api/account/import", headers=headers, json={"schemaVersion": 1, "chat": chat})
        assert response.status_code == 200, response.text
        assert response.json()["imported"]["conversations"] == 0
    assert (await client.get("/api/conversations", headers=headers)).json()["items"] == []
    async with session_factory() as db:
        assert (await db.execute(select(func.count()).select_from(Message))).scalar_one() == 0
    deleted = (await client.get("/api/account/conversation-deletions", headers=headers)).json()["items"]
    assert "deleted-chat" in deleted


async def test_import_deletion_is_durable_and_archived_accounts_are_denied(client, create_user):
    _, alice = await create_user("alice")
    _, bob = await create_user("bob")
    response = await client.post("/api/account/import", headers=alice, json={
        "schemaVersion": 1, "chat": {"deletedConversationIds": ["deleted-chat", "another-chat", "third-chat"]},
    })
    assert response.status_code == 200
    assert (await client.post("/api/account/import", headers=alice, json=snapshot())).json()["skipped"] == 1
    assert (await client.post("/api/account/import", headers=bob, json=snapshot())).status_code == 401
    assert (await client.get("/api/account/conversation-deletions", headers=bob)).status_code == 401
    found = []
    cursor = ""
    while True:
        page = (await client.get(f"/api/account/conversation-deletions?limit=1{cursor}", headers=alice)).json()
        found.extend(page["items"])
        if not page["nextCursor"]:
            break
        cursor = f"&cursor={page['nextCursor']}"
    assert found == ["another-chat", "deleted-chat", "third-chat"]


@pytest.mark.parametrize("delete_first", [True, False])
async def test_concurrent_import_and_deletion_always_leave_deleted(client, create_user, delete_first):
    _, headers = await create_user()
    deletion = {"schemaVersion": 1, "chat": {"deletedConversationIds": ["deleted-chat"]}}
    payloads = [deletion, snapshot()] if delete_first else [snapshot(), deletion]
    responses = await asyncio.gather(*[
        client.post("/api/account/import", headers=headers, json=payload) for payload in payloads
    ])
    assert [response.status_code for response in responses] == [200, 200]
    assert (await client.get("/api/conversations", headers=headers)).json()["items"] == []


async def test_rest_delete_propagates_and_cannot_be_recreated(client, create_user):
    _, headers = await create_user()
    response = await client.post(
        "/api/conversations", headers=headers, json={"clientId": "deleted-chat", "title": "old"}
    )
    created = response.json()
    response = await client.delete(f"/api/conversations/{created['id']}?baseRevision=1", headers=headers)
    assert response.status_code == 200
    assert (await client.post("/api/account/import", headers=headers, json=snapshot())).json()["skipped"] == 1
    for identity in ({"clientId": "deleted-chat"}, {"id": created["id"]}):
        response = await client.post("/api/conversations", headers=headers, json=identity)
        assert response.status_code == 409
    deleted = (await client.get("/api/account/conversation-deletions", headers=headers)).json()["items"]
    assert set(deleted) == {created["id"], "deleted-chat"}
