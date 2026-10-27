import asyncio
import uuid


async def _create_conversation(client, headers, *, client_id=None, title="Hello"):
    response = await client.post(
        "/api/conversations",
        headers=headers,
        json={"clientId": client_id or str(uuid.uuid4()), "title": title},
    )
    assert response.status_code == 201, response.text
    return response.json()


async def _post_message(client, headers, conversation_id, role, content, **extra):
    return await client.post(
        f"/api/conversations/{conversation_id}/messages",
        headers=headers,
        json={"role": role, "content": content, "status": "complete", **extra},
    )


async def test_create_is_idempotent_by_client_id(client, create_user):
    _, headers = await create_user()
    client_id = str(uuid.uuid4())
    first = await _create_conversation(client, headers, client_id=client_id)
    second = await _create_conversation(client, headers, client_id=client_id)
    assert first["id"] == second["id"]

    listing = (await client.get("/api/conversations", headers=headers)).json()
    assert len(listing["items"]) == 1


async def test_message_positions_and_read_state(client, create_user):
    _, headers = await create_user()
    conversation = await _create_conversation(client, headers)

    user_message = await _post_message(client, headers, conversation["id"], "user", "hi")
    assistant = await _post_message(
        client, headers, conversation["id"], "assistant", "hello", reasoning="thinking"
    )
    assert user_message.status_code == 201
    assert assistant.status_code == 201
    assert user_message.json()["position"] == 1
    assert assistant.json()["position"] == 2

    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    assert [item["position"] for item in detail["messages"]] == [1, 2]
    assert detail["conversation"]["readState"]["completed"]["state"] == "unread"

    patched = await client.patch(
        f"/api/conversations/{conversation['id']}",
        headers=headers,
        json={
            "baseRevision": detail["conversation"]["revision"],
            "readState": {"completed": {"state": "read"}},
        },
    )
    assert patched.status_code == 200
    body = patched.json()
    assert body["readState"]["completed"]["state"] == "read"
    assert isinstance(body["readState"]["completed"]["readAt"], int)
    assert body["revision"] == detail["conversation"]["revision"] + 1

    stale = await client.patch(
        f"/api/conversations/{conversation['id']}",
        headers=headers,
        json={"baseRevision": detail["conversation"]["revision"], "title": "stale"},
    )
    assert stale.status_code == 409
    assert stale.json()["error"]["current"]["revision"] == body["revision"]


async def test_steering_flag_round_trips_and_is_limited_to_user_messages(client, create_user):
    _, headers = await create_user()
    conversation = await _create_conversation(client, headers)

    await _post_message(client, headers, conversation["id"], "user", "question")
    reply = await _post_message(client, headers, conversation["id"], "assistant", "answer")
    steering = await _post_message(
        client, headers, conversation["id"], "user", "please adjust", steering=True
    )
    assistant_steering = await _post_message(
        client, headers, conversation["id"], "assistant", "next", steering=True
    )

    assert reply.json()["steering"] is False
    assert steering.json()["steering"] is True
    assert assistant_steering.json()["steering"] is False

    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    assert [item["steering"] for item in detail["messages"]] == [False, False, True, False]


async def test_list_pagination(client, create_user):
    _, headers = await create_user()
    for index in range(3):
        await _create_conversation(client, headers, title=f"Conversation {index}")
        await asyncio.sleep(0.01)

    first_page = (await client.get("/api/conversations?limit=2", headers=headers)).json()
    assert len(first_page["items"]) == 2
    assert first_page["nextCursor"]

    second_page = (
        await client.get(
            f"/api/conversations?limit=2&cursor={first_page['nextCursor']}", headers=headers
        )
    ).json()
    assert len(second_page["items"]) == 1
    ids = {item["id"] for item in first_page["items"]} | {
        item["id"] for item in second_page["items"]
    }
    assert len(ids) == 3


async def test_message_pagination(client, create_user):
    _, headers = await create_user()
    conversation = await _create_conversation(client, headers)
    for index in range(5):
        await _post_message(client, headers, conversation["id"], "user", f"message {index}")

    latest = (
        await client.get(f"/api/conversations/{conversation['id']}?messageLimit=2", headers=headers)
    ).json()
    assert [item["content"] for item in latest["messages"]] == ["message 3", "message 4"]
    assert latest["nextCursor"]

    older = (
        await client.get(
            f"/api/conversations/{conversation['id']}?messageLimit=10&before={latest['nextCursor']}",
            headers=headers,
        )
    ).json()
    assert [item["content"] for item in older["messages"]] == ["message 0", "message 1", "message 2"]
    assert older["nextCursor"] is None


async def test_other_users_cannot_read_or_delete(client, create_user):
    _, alice = await create_user(username="alice")
    _, bob = await create_user(username="bob")
    conversation = await _create_conversation(client, alice)

    assert (
        await client.get(f"/api/conversations/{conversation['id']}", headers=bob)
    ).status_code == 404
    assert (
        await client.delete(
            f"/api/conversations/{conversation['id']}?baseRevision=1", headers=bob
        )
    ).status_code == 404


async def test_delete_cascades_messages(client, create_user, session_factory):
    from sqlalchemy import func, select

    from app.models import Message

    _, headers = await create_user()
    conversation = await _create_conversation(client, headers)
    await _post_message(client, headers, conversation["id"], "user", "hello")
    deleted = await client.delete(
        f"/api/conversations/{conversation['id']}?baseRevision=1", headers=headers
    )
    assert deleted.status_code == 200
    assert (
        await client.get(f"/api/conversations/{conversation['id']}", headers=headers)
    ).status_code == 404

    async with session_factory() as session:
        count = (await session.execute(select(func.count(Message.id)))).scalar_one()
    assert count == 0


async def test_rejects_duplicate_user_message_id(client, create_user):
    _, headers = await create_user()
    conversation = await _create_conversation(client, headers)
    message_id = str(uuid.uuid4())
    first = await client.post(
        f"/api/conversations/{conversation['id']}/messages",
        headers=headers,
        json={"id": message_id, "role": "user", "content": "once", "status": "complete"},
    )
    second = await client.post(
        f"/api/conversations/{conversation['id']}/messages",
        headers=headers,
        json={"id": message_id, "role": "user", "content": "once", "status": "complete"},
    )
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["position"] == 1


async def test_message_patch_can_clear_optional_fields(client, create_user):
    _, headers = await create_user()
    conversation = await _create_conversation(client, headers)
    created = await _post_message(
        client, headers, conversation["id"], "assistant", "partial",
        feedback="bad", quote="old quote", reasoning="old reasoning", thinkingMs=5,
        error="old error",
    )
    message = created.json()
    cleared = await client.patch(
        f"/api/messages/{message['id']}", headers=headers,
        json={"baseRevision": message["revision"], "feedback": None, "quote": None,
              "reasoning": None, "thinkingMs": None, "error": None},
    )
    assert cleared.status_code == 200, cleared.text
    for key in ("feedback", "quote", "reasoning", "thinkingMs", "error"):
        assert cleared.json()[key] is None
    assert cleared.json()["content"] == "partial"
    for key in ("content", "status"):
        invalid = await client.patch(
            f"/api/messages/{message['id']}", headers=headers,
            json={"baseRevision": cleared.json()["revision"], key: None},
        )
        assert invalid.status_code == 422, invalid.text
