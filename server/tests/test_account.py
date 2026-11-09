import asyncio
import uuid
from types import SimpleNamespace

import pytest

from app import storage


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(data_dir=str(tmp_path)))
    return tmp_path


async def _upload(client, headers, name):
    response = await client.post(
        "/api/files", headers=headers, files={"file": (name, b"data", "text/plain")}
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_preferences_round_trip(client, create_user):
    _, headers = await create_user()
    initial = (await client.get("/api/preferences", headers=headers)).json()
    assert initial["revision"] == 1

    updated = await client.put(
        "/api/preferences",
        headers=headers,
        json={"baseRevision": 1, "themeId": "ocean-breeze", "mode": "dark"},
    )
    assert updated.status_code == 200
    assert updated.json()["themeId"] == "ocean-breeze"
    assert updated.json()["revision"] == 2

    stale = await client.put(
        "/api/preferences",
        headers=headers,
        json={"baseRevision": 1, "themeId": "mono", "mode": "light"},
    )
    assert stale.status_code == 409


async def test_profile_fields(client, create_user):
    _, headers = await create_user()
    created = await client.put(
        "/api/profile/fields/name",
        headers=headers,
        json={"value": "Alice", "source": "manual", "updatedAt": 1760000000000},
    )
    assert created.status_code == 200
    assert created.json()["updatedAt"] == 1760000000000

    updated = await client.put(
        "/api/profile/fields/name",
        headers=headers,
        json={"value": "Alice Chen", "baseRevision": 1},
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2

    stale = await client.put(
        "/api/profile/fields/name",
        headers=headers,
        json={"value": "Nope", "baseRevision": 1},
    )
    assert stale.status_code == 409

    assert (await client.delete("/api/profile/fields/name", headers=headers)).status_code == 200
    assert (await client.get("/api/profile/fields/name", headers=headers)).status_code == 404


async def test_memories_create_and_archive(client, create_user):
    _, headers = await create_user()
    created = await client.post(
        "/api/memories",
        headers=headers,
        json={"type": "identity", "content": "Prefers Chinese"},
    )
    assert created.status_code == 201
    memory = created.json()
    assert memory["status"] == "active"

    archived = await client.delete(
        f"/api/memories/{memory['id']}?baseRevision={memory['revision']}", headers=headers
    )
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"

    active = (await client.get("/api/memories?status=active", headers=headers)).json()
    assert active["items"] == []


async def test_import_is_idempotent(client, create_user):
    _, headers = await create_user()
    conversation_id = str(uuid.uuid4())
    payload = {
        "schemaVersion": 1,
        "chat": {
            "conversations": [
                {
                    "id": conversation_id,
                    "title": "Imported",
                    "updatedAt": 1760000000000,
                    "contextSummary": {
                        "coveredUntilMessageId": "older-message",
                        "summary": "Imported rolling summary",
                    },
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "hi"},
                        {"id": str(uuid.uuid4()), "role": "assistant", "content": "hello",
                         "activities": [{
                             "id": "call-1", "kind": "fetch", "status": "complete",
                             "url": "https://a.test/x", "urls": ["https://a.test/x"],
                             "title": "A", "tookMs": 9,
                         }],
                         "process": [
                             {"id": "thinking:1:0", "kind": "thinking", "content": "先想",
                              "status": "complete", "startedAt": 1, "endedAt": 2},
                             {"id": "call-1", "kind": "fetch", "status": "complete",
                              "url": "https://a.test/x", "title": "A", "tookMs": 9},
                         ]},
                    ],
                }
            ]
        },
        "appearance": {"themeId": "catppuccin", "mode": "dark"},
        "personalization": {
            "customInstructions": "Be brief",
            "aboutName": "Alice",
            "occupation": "Engineer",
            "aboutMore": "",
        },
    }

    first = await client.post("/api/account/import", headers=headers, json=payload)
    assert first.status_code == 200, first.text
    assert first.json()["imported"] == {"conversations": 1, "messages": 2}

    second = await client.post("/api/account/import", headers=headers, json=payload)
    assert second.status_code == 200
    assert second.json()["imported"] == {"conversations": 0, "messages": 0}
    assert second.json()["skipped"] == 1

    listing = (await client.get("/api/conversations", headers=headers)).json()
    assert len(listing["items"]) == 1
    assert listing["items"][0]["clientId"] == conversation_id
    assert listing["items"][0]["contextSummary"] == {
        "coveredUntilMessageId": "older-message",
        "summary": "Imported rolling summary",
    }
    detail = (await client.get(f"/api/conversations/{listing['items'][0]['id']}", headers=headers)).json()
    assert detail["messages"][1]["activities"] == [{
        "id": "call-1", "kind": "fetch", "status": "complete",
        "url": "https://a.test/x", "urls": ["https://a.test/x"], "title": "A", "tookMs": 9,
    }]
    assert detail["messages"][1]["process"] == [
        {"id": "thinking:1:0", "kind": "thinking", "content": "先想",
         "status": "complete", "startedAt": 1, "endedAt": 2},
        {"id": "call-1", "kind": "fetch", "status": "complete",
         "url": "https://a.test/x", "title": "A", "tookMs": 9},
    ]

    preferences = (await client.get("/api/preferences", headers=headers)).json()
    assert preferences["themeId"] == "catppuccin"
    profile = (await client.get("/api/profile", headers=headers)).json()
    assert profile["customInstructions"] == "Be brief"


async def test_import_preserves_user_steering_flags(client, create_user):
    _, headers = await create_user()
    conversation_id = str(uuid.uuid4())
    payload = {
        "schemaVersion": 1,
        "chat": {
            "conversations": [{
                "id": conversation_id,
                "title": "Steering",
                "updatedAt": 1760000000000,
                "messages": [
                    {"id": str(uuid.uuid4()), "role": "user", "content": "question"},
                    {"id": str(uuid.uuid4()), "role": "user", "content": "supplement", "steering": True},
                    {"id": str(uuid.uuid4()), "role": "assistant", "content": "answer"},
                    {"id": str(uuid.uuid4()), "role": "assistant", "content": "not steering", "steering": True},
                ],
            }]
        },
    }

    imported = await client.post("/api/account/import", headers=headers, json=payload)
    assert imported.status_code == 200, imported.text

    listing = (await client.get("/api/conversations", headers=headers)).json()["items"]
    assert [item["clientId"] for item in listing] == [conversation_id]
    detail = (
        await client.get(f"/api/conversations/{listing[0]['id']}", headers=headers)
    ).json()
    assert [item["steering"] for item in detail["messages"]] == [False, True, False, False]


async def test_import_merges_new_messages_and_settings(client, create_user):
    _, headers = await create_user()
    conversation_id = str(uuid.uuid4())
    first_payload = {
        "schemaVersion": 1,
        "chat": {
            "conversations": [
                {
                    "id": conversation_id,
                    "title": "First title",
                    "updatedAt": 1760000000000,
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "hi"},
                        {"id": str(uuid.uuid4()), "role": "assistant", "content": "hello"},
                    ],
                }
            ]
        },
        "appearance": {"themeId": "catppuccin", "mode": "dark"},
    }
    first = await client.post("/api/account/import", headers=headers, json=first_payload)
    assert first.status_code == 200, first.text

    conversation = (await client.get("/api/conversations", headers=headers)).json()["items"][0]
    follow_up = {
        "schemaVersion": 1,
        "chat": {
            "conversations": [
                {
                    "id": conversation_id,
                    "title": "Renamed on this device",
                    "pinned": True,
                    "updatedAt": 1760000001000,
                    "readState": {"completed": {"state": "unread"}},
                    "messages": [
                        *first_payload["chat"]["conversations"][0]["messages"],
                        {"id": str(uuid.uuid4()), "role": "user", "content": "more"},
                        {"id": str(uuid.uuid4()), "role": "assistant", "content": "sure"},
                    ],
                }
            ]
        },
        "appearance": {"themeId": "twitter", "mode": "light"},
    }

    second = await client.post("/api/account/import", headers=headers, json=follow_up)
    assert second.status_code == 200, second.text
    assert second.json()["imported"] == {"conversations": 0, "messages": 2}
    assert second.json()["updated"] == 1
    assert second.json()["skipped"] == 0

    detail = (
        await client.get(f"/api/conversations/{conversation['id']}", headers=headers)
    ).json()
    assert detail["conversation"]["title"] == "Renamed on this device"
    assert detail["conversation"]["pinned"] is True
    assert detail["conversation"]["readState"]["completed"]["state"] == "unread"
    assert [item["content"] for item in detail["messages"]] == [
        "hi",
        "hello",
        "more",
        "sure",
    ]

    repeat = await client.post("/api/account/import", headers=headers, json=follow_up)
    assert repeat.status_code == 200, repeat.text
    assert repeat.json()["imported"] == {"conversations": 0, "messages": 0}
    assert repeat.json()["updated"] == 0
    assert repeat.json()["skipped"] == 1

    preferences = (await client.get("/api/preferences", headers=headers)).json()
    assert (preferences["themeId"], preferences["mode"]) == ("twitter", "light")


async def test_concurrent_imports_stay_idempotent(client, create_user):
    _, headers = await create_user()
    conversation_id = str(uuid.uuid4())
    payload = {
        "schemaVersion": 1,
        "chat": {
            "conversations": [
                {
                    "id": conversation_id,
                    "title": "Concurrent",
                    "updatedAt": 1760000000000,
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "hi"},
                        {"id": str(uuid.uuid4()), "role": "assistant", "content": "hello"},
                    ],
                }
            ]
        },
        "appearance": {"themeId": "catppuccin", "mode": "dark"},
    }

    responses = await asyncio.gather(*(
        client.post("/api/account/import", headers=headers, json=payload) for _ in range(4)
    ))
    assert all(response.status_code == 200 for response in responses), [item.text for item in responses]
    results = [response.json() for response in responses]
    assert sum(item["imported"]["conversations"] for item in results) == 1
    assert sum(item["imported"]["messages"] for item in results) == 2
    assert sum(item["skipped"] for item in results) == 3

    listing = (await client.get("/api/conversations", headers=headers)).json()["items"]
    assert len(listing) == 1
    detail = (
        await client.get(f"/api/conversations/{listing[0]['id']}", headers=headers)
    ).json()
    assert [item["content"] for item in detail["messages"]] == ["hi", "hello"]


async def test_import_keeps_only_file_ids_the_account_owns(client, create_user):
    _, headers = await create_user()
    owned = await _upload(client, headers, "owned.txt")
    foreign = {"id": str(uuid.uuid4())}
    unknown = str(uuid.uuid4())
    mine = str(uuid.uuid4())
    theirs = str(uuid.uuid4())

    payload = {
        "schemaVersion": 1,
        "chat": {
            "conversations": [
                {
                    "id": str(uuid.uuid4()),
                    "title": "Imported files",
                    "updatedAt": 1760000000000,
                    "messages": [
                        {
                            "id": mine,
                            "role": "user",
                            "content": "mine",
                            "fileIds": [owned["id"], foreign["id"], unknown],
                        },
                        {
                            "id": theirs,
                            "role": "assistant",
                            "content": "theirs",
                            "fileIds": [foreign["id"], unknown],
                        },
                    ],
                }
            ]
        },
    }
    response = await client.post("/api/account/import", headers=headers, json=payload)
    assert response.status_code == 200, response.text

    conversation = (await client.get("/api/conversations", headers=headers)).json()["items"][0]
    detail = (await client.get(f"/api/conversations/{conversation['id']}", headers=headers)).json()
    by_content = {item["content"]: item for item in detail["messages"]}
    assert by_content["mine"]["fileIds"] == [owned["id"]]
    assert [item["filename"] for item in by_content["mine"]["files"]] == ["owned.txt"]
    assert by_content["theirs"]["fileIds"] == []
    assert by_content["theirs"]["files"] == []
