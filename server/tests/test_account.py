import uuid


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
                    "messages": [
                        {"id": str(uuid.uuid4()), "role": "user", "content": "hi"},
                        {"id": str(uuid.uuid4()), "role": "assistant", "content": "hello"},
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

    preferences = (await client.get("/api/preferences", headers=headers)).json()
    assert preferences["themeId"] == "catppuccin"
    profile = (await client.get("/api/profile", headers=headers)).json()
    assert profile["customInstructions"] == "Be brief"
