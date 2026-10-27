from types import SimpleNamespace

import pytest

from app import storage


@pytest.fixture(autouse=True)
def data_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(storage, "get_settings", lambda: SimpleNamespace(data_dir=str(tmp_path)))
    return tmp_path


async def test_upload_download_delete_round_trip(client, create_user):
    _, headers = await create_user()

    response = await client.post(
        "/api/files",
        headers=headers,
        files={"file": ("note.txt", b"hello", "text/plain")},
    )
    assert response.status_code == 201, response.text
    file_id = response.json()["id"]

    response = await client.get(f"/api/files/{file_id}/content", headers=headers)
    assert response.status_code == 200
    assert response.content == b"hello"

    response = await client.delete(f"/api/files/{file_id}", headers=headers)
    assert response.status_code == 200

    response = await client.get(f"/api/files/{file_id}", headers=headers)
    assert response.status_code == 404


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
        assert response.status_code == 404, (method, response.text)
