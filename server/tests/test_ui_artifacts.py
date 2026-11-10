async def test_ui_snapshot_round_trip_and_revision_conflict(client, create_instance):
    _, headers = await create_instance()
    conversation = await client.post("/api/conversations", headers=headers, json={"title": "UI"})
    conversation_id = conversation.json()["id"]
    artifact = {
        "id": "ui-1",
        "name": "generateSandboxedUi",
        "props": {
            "initialHeight": 300,
            "placeholderMessages": [],
            "css": "",
            "html": "<button>Run</button>",
            "jsFunctions": "",
            "jsExpressions": "",
        },
    }
    created = await client.post(
        f"/api/conversations/{conversation_id}/messages",
        headers=headers,
        json={"role": "assistant", "content": "", "uiArtifacts": [artifact]},
    )
    assert created.status_code == 201, created.text
    message = created.json()
    assert message["uiArtifacts"] == [artifact]
    loaded = await client.get(f"/api/conversations/{conversation_id}", headers=headers)
    assert loaded.json()["messages"][0]["uiArtifacts"] == [artifact]
    updated = await client.patch(
        f"/api/messages/{message['id']}", headers=headers, json={"baseRevision": message["revision"], "uiArtifacts": []}
    )
    assert updated.status_code == 200
    assert updated.json()["uiArtifacts"] is None
    stale = await client.patch(
        f"/api/messages/{message['id']}",
        headers=headers,
        json={"baseRevision": message["revision"], "uiArtifacts": [artifact]},
    )
    assert stale.status_code == 409


async def test_ui_rejects_invalid_and_oversized_payloads(client, create_instance):
    _, headers = await create_instance()
    conversation = await client.post("/api/conversations", headers=headers, json={"title": "UI"})
    path = f"/api/conversations/{conversation.json()['id']}/messages"
    invalid = await client.post(
        path,
        headers=headers,
        json={"role": "assistant", "uiArtifacts": [{"id": "bad", "name": "generateSandboxedUi", "props": {}}]},
    )
    assert invalid.status_code == 422
    oversized = {
        "id": "large",
        "name": "generateSandboxedUi",
        "props": {
            "initialHeight": 300,
            "placeholderMessages": [],
            "css": "",
            "html": "x" * 100001,
            "jsFunctions": "",
            "jsExpressions": "",
        },
    }
    result = await client.post(path, headers=headers, json={"role": "assistant", "uiArtifacts": [oversized]})
    assert result.status_code == 422
