import uuid
from types import SimpleNamespace

import pytest

from app import storage


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(data_dir=str(tmp_path)))
    return tmp_path


async def test_upload_download_delete_round_trip(client, create_user, data_dir):
    _, headers = await create_user()

    response = await client.post(
        "/api/files",
        headers=headers,
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 201, response.text
    file_id = response.json()["id"]
    assert (data_dir / "files" / file_id / "note.txt").read_bytes() == b"hello"

    response = await client.get(f"/api/files/{file_id}/content", headers=headers)
    assert response.status_code == 200
    assert response.content == b"hello"

    response = await client.delete(f"/api/files/{file_id}", headers=headers)
    assert response.status_code == 200

    response = await client.get(f"/api/files/{file_id}", headers=headers)
    assert response.status_code == 404


async def _upload(client, headers, name, data=b"x", content_type="text/plain", **form):
    response = await client.post(
        "/api/files",
        headers=headers,
        files={"file": (name, data, content_type)},
        data=form,
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_library_lists_filters_search_and_paginates(client, create_user):
    _, headers = await create_user()
    for name, content_type in (
        ("a.txt", "text/plain"),
        ("b.png", "image/png"),
        ("c.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        ("d.doc", "application/msword"),
        ("e.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"),
    ):
        await _upload(client, headers, name, b"payload", content_type)

    listing = (await client.get("/api/files", headers=headers)).json()
    assert {item["filename"] for item in listing["items"]} == {"a.txt", "b.png", "c.docx", "d.doc", "e.xlsx"}
    assert listing["nextCursor"] is None

    images = (await client.get("/api/files?kind=image", headers=headers)).json()
    assert [item["filename"] for item in images["items"]] == ["b.png"]

    documents = (await client.get("/api/files?kind=document&sort=name&order=asc", headers=headers)).json()
    assert [item["filename"] for item in documents["items"]] == ["c.docx", "d.doc", "e.xlsx"]

    files = (await client.get("/api/files?kind=file&sort=name&order=asc", headers=headers)).json()
    assert [item["filename"] for item in files["items"]] == ["a.txt", "c.docx", "d.doc", "e.xlsx"]

    texts = (await client.get("/api/files?kind=text", headers=headers)).json()
    assert [item["filename"] for item in texts["items"]] == ["a.txt"]

    search = (await client.get("/api/files?query=DOCX", headers=headers)).json()
    assert [item["filename"] for item in search["items"]] == ["c.docx"]

    # LIKE wildcards in the search term are escaped, not interpreted.
    assert (await client.get("/api/files?query=%25", headers=headers)).json()["items"] == []

    seen: list[str] = []
    cursor = None
    while True:
        params = {"sort": "name", "order": "asc", "limit": 2}
        if cursor:
            params["cursor"] = cursor
        page = (await client.get("/api/files", headers=headers, params=params)).json()
        seen.extend(item["filename"] for item in page["items"])
        cursor = page["nextCursor"]
        if cursor is None:
            break
    assert seen == ["a.txt", "b.png", "c.docx", "d.doc", "e.xlsx"]

    bad_kind = await client.get("/api/files?kind=video", headers=headers)
    assert bad_kind.status_code == 422
    bad_order = await client.get("/api/files?order=sideways", headers=headers)
    assert bad_order.status_code == 422
    bad_cursor = await client.get("/api/files?cursor=not-a-cursor", headers=headers)
    assert bad_cursor.status_code == 422


async def test_library_filters_by_conversation(client, create_user):
    _, headers = await create_user()
    client_id = str(uuid.uuid4())
    conversation = (
        await client.post(
            "/api/conversations",
            headers=headers,
            json={"clientId": client_id, "title": "Files"},
        )
    ).json()
    # The chat client only knows its own id, so uploads and filters may send either form.
    attached = await _upload(client, headers, "attached.txt", b"a", conversationId=client_id)
    await _upload(client, headers, "loose.txt", b"b")

    assert attached["conversationId"] == conversation["id"]

    for identity in (client_id, conversation["id"]):
        scoped = (
            await client.get(f"/api/files?conversationId={identity}", headers=headers)
        ).json()
        assert [item["id"] for item in scoped["items"]] == [attached["id"]]
        assert scoped["items"][0]["conversationId"] == conversation["id"]

    unknown = await client.get(f"/api/files?conversationId={uuid.uuid4()}", headers=headers)
    assert unknown.json()["items"] == []


async def test_usage_splits_images_from_files(client, create_user):
    _, headers = await create_user()
    await _upload(client, headers, "notes.txt", b"12345", "text/plain")
    await _upload(client, headers, "photo.png", b"123", "image/png")

    usage = (await client.get("/api/files/usage", headers=headers)).json()
    assert usage["used"] == 8
    assert usage["files"] == {"bytes": 5, "count": 1}
    assert usage["images"] == {"bytes": 3, "count": 1}


async def test_usage_and_bulk_delete(client, create_user):
    _, headers = await create_user()
    first = await _upload(client, headers, "one.txt", b"12345")
    second = await _upload(client, headers, "two.txt", b"6789")

    usage = (await client.get("/api/files/usage", headers=headers)).json()
    assert usage["used"] == 9
    assert usage["quota"] > 0

    foreign = {"id": str(uuid.uuid4())}

    response = await client.post(
        "/api/files/bulk-delete",
        headers=headers,
        json={"ids": [first["id"], first["id"], foreign["id"]]},
    )
    assert response.status_code == 200, response.text
    assert response.json() == {"deleted": 1}

    usage = (await client.get("/api/files/usage", headers=headers)).json()
    assert usage["used"] == 4
    remaining = (await client.get("/api/files", headers=headers)).json()["items"]
    assert [item["id"] for item in remaining] == [second["id"]]

    assert (await client.get(f"/api/files/{foreign['id']}", headers=headers)).status_code == 404

    too_many = await client.post(
        "/api/files/bulk-delete",
        headers=headers,
        json={"ids": [str(uuid.uuid4()) for _ in range(101)]},
    )
    assert too_many.status_code == 422


async def test_rename_rejects_extension_change_and_cross_account(client, create_user, data_dir):
    _, headers = await create_user()
    file = await _upload(client, headers, "old.txt", b"x")

    renamed = await client.patch(
        f"/api/files/{file['id']}", headers=headers, json={"filename": "new name.txt"}
    )
    assert renamed.status_code == 200, renamed.text
    assert renamed.json()["filename"] == "new name.txt"
    assert renamed.json()["revision"] == file["revision"] + 1
    assert (data_dir / "files" / file["id"] / "new name.txt").read_bytes() == b"x"
    assert not (data_dir / "files" / file["id"] / "old.txt").exists()

    changed_extension = await client.patch(
        f"/api/files/{file['id']}", headers=headers, json={"filename": "new.md"}
    )
    assert changed_extension.status_code == 422

    blank = await client.patch(f"/api/files/{file['id']}", headers=headers, json={"filename": "   "})
    assert blank.status_code == 422

    _, other_headers = await create_user("other")
    foreign = await client.patch(
        f"/api/files/{file['id']}", headers=other_headers, json={"filename": "stolen.txt"}
    )
    assert foreign.status_code == 401


async def test_upload_accepts_legacy_office_and_images_but_not_unknown_types(client, create_user):
    _, headers = await create_user()
    for name in ("legacy.doc", "legacy.xls", "legacy.ppt", "photo.png", "note.md"):
        await _upload(client, headers, name, b"PK\x03\x04")

    response = await client.post(
        "/api/files",
        headers=headers,
        files={"file": ("payload.exe", b"MZ", "application/octet-stream")},
    )
    assert response.status_code == 415
    assert response.json()["error"]["code"] == "unsupported_file_type"


async def test_files_are_not_visible_across_accounts(client, create_user):
    _, owner_headers = await create_user("owner")
    _, other_headers = await create_user("other")

    response = await client.post(
        "/api/files",
        headers=owner_headers,
        files={"file": ("note.txt", b"private", "text/plain")},
    )
    assert response.status_code == 201, response.text
    file_id = response.json()["id"]

    for method, path in (
        ("GET", f"/api/files/{file_id}"),
        ("GET", f"/api/files/{file_id}/content"),
        ("DELETE", f"/api/files/{file_id}"),
    ):
        response = await client.request(method, path, headers=other_headers)
        assert response.status_code == 401, (method, response.text)
