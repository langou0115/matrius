import asyncio
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from app import storage


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(data_dir=str(tmp_path)))
    return tmp_path


async def _upload(client, headers, name, data=b"x", **form):
    response = await client.post(
        "/api/files",
        headers=headers,
        files={"file": (name, data, "text/plain")},
        data=form,
    )
    assert response.status_code == 201, response.text
    return response.json()


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


async def test_create_is_idempotent_by_client_id(client, create_instance):
    _, headers = await create_instance()
    client_id = str(uuid.uuid4())
    first = await _create_conversation(client, headers, client_id=client_id)
    second = await _create_conversation(client, headers, client_id=client_id)
    assert first["id"] == second["id"]

    listing = (await client.get("/api/conversations", headers=headers)).json()
    assert len(listing["items"]) == 1


async def test_message_positions_and_read_state(client, create_instance):
    _, headers = await create_instance()
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


async def test_message_process_round_trips_and_can_be_cleared(client, create_instance):
    _, headers = await create_instance()
    conversation = await _create_conversation(client, headers)
    process = [
        {"id": "thinking:1:0", "kind": "thinking", "content": "先想一下", "status": "complete",
         "startedAt": 1, "endedAt": 2},
        {"id": "call-1", "kind": "search", "status": "complete", "query": "资料",
         "results": [{"title": "A", "url": "https://a.test/x", "domain": "a.test", "rank": 1}]},
    ]
    created = await _post_message(
        client, headers, conversation["id"], "assistant", "回答", reasoning="先想一下", process=process
    )
    assert created.status_code == 201, created.text
    assert created.json()["process"] == process

    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    assert detail["messages"][0]["process"] == process

    patched = await client.patch(
        f"/api/messages/{created.json()['id']}",
        headers=headers,
        json={
            "baseRevision": created.json()["revision"],
            "process": [{"id": "thinking:2:0", "kind": "thinking", "content": "再想一下", "status": "complete"}],
        },
    )
    assert patched.status_code == 200, patched.text
    assert [step["kind"] for step in patched.json()["process"]] == ["thinking"]
    assert patched.json()["process"][0]["content"] == "再想一下"

    cleared = await client.patch(
        f"/api/messages/{created.json()['id']}",
        headers=headers,
        json={"baseRevision": patched.json()["revision"], "process": []},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["process"] is None


async def test_steering_flag_round_trips_and_is_limited_to_user_messages(client, create_instance):
    _, headers = await create_instance()
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


async def test_context_summary_round_trips_and_can_be_cleared(client, create_instance):
    _, headers = await create_instance()
    summary = {"coveredUntilMessageId": "message-1", "summary": "Older turns in brief"}
    created = await client.post(
        "/api/conversations",
        headers=headers,
        json={"clientId": str(uuid.uuid4()), "title": "Summarized", "contextSummary": summary},
    )
    assert created.status_code == 201, created.text
    conversation = created.json()
    assert conversation["contextSummary"] == summary

    updated_summary = {"coveredUntilMessageId": "message-3", "summary": "Updated brief"}
    updated = await client.patch(
        f"/api/conversations/{conversation['id']}",
        headers=headers,
        json={"baseRevision": conversation["revision"], "contextSummary": updated_summary},
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["contextSummary"] == updated_summary

    cleared = await client.patch(
        f"/api/conversations/{conversation['id']}",
        headers=headers,
        json={"baseRevision": updated.json()["revision"], "contextSummary": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["contextSummary"] is None

    empty = await client.patch(
        f"/api/conversations/{conversation['id']}",
        headers=headers,
        json={
            "baseRevision": cleared.json()["revision"],
            "contextSummary": {"coveredUntilMessageId": "", "summary": ""},
        },
    )
    assert empty.status_code == 422, empty.text


async def test_list_pagination(client, create_instance):
    _, headers = await create_instance()
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


async def test_message_pagination(client, create_instance):
    _, headers = await create_instance()
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



async def test_delete_cascades_messages(client, create_instance, session_factory):
    from sqlalchemy import func, select

    from app.models import Message

    _, headers = await create_instance()
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


async def test_rejects_duplicate_user_message_id(client, create_instance):
    _, headers = await create_instance()
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


async def test_message_patch_can_clear_optional_fields(client, create_instance):
    _, headers = await create_instance()
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


async def test_web_activity_steps_round_trip_and_clear(client, create_instance):
    _, headers = await create_instance()
    conversation = await _create_conversation(client, headers)
    activities = [{
        "id": "call-1", "kind": "search", "status": "complete", "query": "资料",
        "results": [{"title": "A", "url": "https://a.test/x", "domain": "a.test", "rank": 1}],
        "tookMs": 12,
    }]
    created = await _post_message(
        client, headers, conversation["id"], "assistant", "answer", activities=activities
    )
    assert created.status_code == 201, created.text
    message = created.json()
    assert message["activities"] == activities

    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    assert detail["messages"][0]["activities"] == activities

    cleared = await client.patch(
        f"/api/messages/{message['id']}", headers=headers,
        json={"baseRevision": message["revision"], "activities": None},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["activities"] is None


async def test_web_activity_urls_must_be_http(client, create_instance):
    _, headers = await create_instance()
    conversation = await _create_conversation(client, headers)
    response = await _post_message(
        client, headers, conversation["id"], "assistant", "answer",
        activities=[{"id": "call-1", "kind": "fetch", "status": "complete",
                     "url": "javascript:alert(1)"}],
    )
    assert response.status_code == 422, response.text


async def test_message_file_metadata_round_trips(client, create_instance):
    _, headers = await create_instance()
    conversation = await _create_conversation(client, headers)
    first = await _upload(client, headers, "report.txt", b"hello world")
    second = await _upload(client, headers, "chart.txt", b"data")

    created = await _post_message(
        client, headers, conversation["id"], "user", "see attached",
        fileIds=[first["id"], second["id"]],
    )
    assert created.status_code == 201, created.text
    message = created.json()
    assert message["fileIds"] == [first["id"], second["id"]]
    assert [item["filename"] for item in message["files"]] == ["report.txt", "chart.txt"]
    assert [item["size"] for item in message["files"]] == [11, 4]
    assert all(item["revision"] == 1 for item in message["files"])

    # Attaching to a message binds unowned uploads to its conversation.
    scoped = (
        await client.get(f"/api/files?conversationId={conversation['id']}", headers=headers)
    ).json()["items"]
    assert {item["id"] for item in scoped} == {first["id"], second["id"]}

    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    assert detail["messages"][0]["files"] == message["files"]

    # A missing file is filtered from `files` but the reference is preserved, so the
    # client can render a "file deleted" placeholder instead of losing the id.
    deleted = await client.delete(f"/api/files/{first['id']}", headers=headers)
    assert deleted.status_code == 200
    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    assert detail["messages"][0]["fileIds"] == [first["id"], second["id"]]
    assert [item["id"] for item in detail["messages"][0]["files"]] == [second["id"]]


async def test_message_patch_replaces_files_and_checks_ownership(client, create_instance):
    _, headers = await create_instance()
    conversation = await _create_conversation(client, headers)
    other_conversation = await _create_conversation(client, headers, title="Other")
    first = await _upload(client, headers, "one.txt")
    second = await _upload(client, headers, "two.txt")
    elsewhere = await _upload(client, headers, "elsewhere.txt", conversationId=other_conversation["id"])

    created = await _post_message(
        client, headers, conversation["id"], "assistant", "draft",
        fileIds=[first["id"]],
    )
    message = created.json()

    patched = await client.patch(
        f"/api/messages/{message['id']}", headers=headers,
        json={"baseRevision": message["revision"], "fileIds": [second["id"], second["id"]]},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["fileIds"] == [second["id"]]
    assert [item["filename"] for item in patched.json()["files"]] == ["two.txt"]

    cleared = await client.patch(
        f"/api/messages/{message['id']}", headers=headers,
        json={"baseRevision": patched.json()["revision"], "fileIds": []},
    )
    assert cleared.status_code == 200, cleared.text
    assert cleared.json()["fileIds"] == []
    assert cleared.json()["files"] == []

    wrong_conversation = await client.patch(
        f"/api/messages/{message['id']}", headers=headers,
        json={"baseRevision": cleared.json()["revision"], "fileIds": [elsewhere["id"]]},
    )
    assert wrong_conversation.status_code == 422

    foreign = {"id": str(uuid.uuid4())}
    not_owned = await client.patch(
        f"/api/messages/{message['id']}", headers=headers,
        json={"baseRevision": cleared.json()["revision"], "fileIds": [foreign["id"]]},
    )
    assert not_owned.status_code == 422


async def test_get_conversation_loads_files_once_per_page(client, create_instance, engine):
    _, headers = await create_instance()
    conversation = await _create_conversation(client, headers)
    first = await _upload(client, headers, "one.txt")
    second = await _upload(client, headers, "two.txt")
    for content, file_id in (("a", first["id"]), ("b", second["id"])):
        response = await _post_message(
            client, headers, conversation["id"], "user", content, fileIds=[file_id]
        )
        assert response.status_code == 201, response.text

    statements: list[str] = []

    @event.listens_for(engine.sync_engine, "before_cursor_execute")
    def capture(_conn, _cursor, statement, _parameters, _context, _executemany):
        if "FROM files" in statement:
            statements.append(statement)

    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    event.remove(engine.sync_engine, "before_cursor_execute", capture)

    assert len(statements) == 1, statements
    assert [item["files"][0]["filename"] for item in detail["messages"]] == ["one.txt", "two.txt"]
