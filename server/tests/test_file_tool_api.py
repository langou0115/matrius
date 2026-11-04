"""End-to-end checks for ``POST /api/tools/file``.

The endpoint is a stateless REST surface for the browser-side agent: these tests
cover auth/feature gates, request validation, drafts, saving and the limit
between uploaded files and generated ones.
"""

import shutil
from types import SimpleNamespace

import pytest

from app import storage
from app.documents import drafts as drafts_module
from app.documents.drafts import drafts


@pytest.fixture(autouse=True)
def draft_data_dir(tmp_path, monkeypatch):
    settings = SimpleNamespace(
        data_dir=str(tmp_path),
        max_upload_bytes=20 * 1024 * 1024,
        document_draft_ttl_seconds=30 * 60,
        document_draft_max_per_user=10,
        document_draft_user_bytes=60 * 1024 * 1024,
    )
    monkeypatch.setattr(storage, "get_settings", lambda: settings)
    monkeypatch.setattr(drafts_module, "get_settings", lambda: settings)
    drafts._drafts.clear()
    yield tmp_path
    drafts._drafts.clear()
    shutil.rmtree(tmp_path / "drafts", ignore_errors=True)


async def _call(client, headers, **payload):
    return await client.post("/api/tools/file", headers=headers, json=payload)


async def _upload(client, headers, name, data, content_type="text/plain", **form):
    response = await client.post(
        "/api/files",
        headers=headers,
        files={"file": (name, data, content_type)},
        data=form,
    )
    assert response.status_code == 201, response.text
    return response.json()


async def test_requires_authentication(client, create_user):
    anonymous = await client.post("/api/tools/file", json={"operation": "list"})
    assert anonymous.status_code == 401

    _, headers = await create_user()
    allowed = await _call(client, headers, operation="list")
    assert allowed.status_code == 200, allowed.text
    assert allowed.json() == {"operation": "list", "files": []}


async def test_create_inspect_save_edit_pdf_round_trip(client, create_user):
    _, headers = await create_user("regular")

    created = await _call(
        client,
        headers,
        operation="create",
        format="pdf",
        filename="周报.pdf",
        pdfChanges=[
            {"operation": "draw_text", "page": 1, "text": "你好，世界", "x": 72, "y": 72, "size": 16}
        ],
    )
    assert created.status_code == 200, created.text
    draft = created.json()["draft"]
    assert draft["filename"] == "周报.pdf"
    assert draft["id"].startswith("draft:")
    assert draft["conversationId"] is None

    inspected = await _call(client, headers, operation="inspect", fileId=draft["id"])
    assert inspected.status_code == 200, inspected.text
    body = inspected.json()
    assert body["format"] == "pdf"
    assert '"pageCount": 1' in body["text"]
    assert "你好，世界" in body["text"]

    saved = await _call(client, headers, operation="save", fileId=draft["id"])
    assert saved.status_code == 200, saved.text
    file = saved.json()["file"]
    assert file["filename"] == "周报.pdf"
    assert file["contentType"] == "application/pdf"
    assert file["revision"] == 1

    download = await client.get(f"/api/files/{file['id']}/content", headers=headers)
    assert download.status_code == 200
    assert download.content.startswith(b"%PDF")

    edited = await _call(
        client,
        headers,
        operation="edit",
        fileId=file["id"],
        save=True,
        pdfChanges=[
            {"operation": "add_page", "text": "第二页", "x": 72, "y": 72, "size": 14}
        ],
    )
    assert edited.status_code == 200, edited.text
    updated = edited.json()
    # `save: true` returns the operation name plus the freshly written file.
    assert updated["operation"] == "edit"
    assert updated["file"]["id"] == file["id"]
    assert updated["file"]["revision"] == 2

    inspected = await _call(client, headers, operation="inspect", fileId=file["id"])
    assert '"pageCount": 2' in inspected.json()["text"]

    usage = (await client.get("/api/files/usage", headers=headers)).json()
    assert usage["used"] == updated["file"]["size"]


async def test_create_edit_and_save_office_document(client, create_user):
    _, headers = await create_user("regular")

    created = await _call(
        client, headers, operation="create", format="docx", filename="报告.docx"
    )
    assert created.status_code == 200, created.text
    draft = created.json()["draft"]

    edited = await _call(
        client,
        headers,
        operation="edit",
        fileId=draft["id"],
        commands=[
            {"command": "add", "parent": "/", "type": "paragraph", "props": {"text": "第一段"}}
        ],
        save=True,
    )
    assert edited.status_code == 200, edited.text
    file = edited.json()["file"]
    assert file["filename"] == "报告.docx"
    assert file["revision"] == 1

    read = await _call(client, headers, operation="read", fileId=file["id"])
    assert read.status_code == 200, read.text
    assert "第一段" in read.json()["text"]


async def test_docx_markdown_section_expands_in_one_command(client, create_user):
    _, headers = await create_user("regular")

    created = await _call(client, headers, operation="create", format="docx", filename="方案.docx")
    draft = created.json()["draft"]

    edited = await _call(
        client,
        headers,
        operation="edit",
        fileId=draft["id"],
        commands=[
            {
                "command": "add",
                "parent": "/body",
                "type": "markdown",
                "props": {"markdown": "# 背景\n\n- 第一点\n- 第二点\n"},
            }
        ],
        save=True,
    )
    assert edited.status_code == 200, edited.text

    read = await _call(client, headers, operation="read", fileId=edited.json()["file"]["id"])
    assert read.status_code == 200, read.text
    text = read.json()["text"]
    assert "背景" in text
    assert "第一点" in text


async def test_pptx_textbox_accepts_a_body_text_shape(client, create_user):
    _, headers = await create_user("regular")

    created = await _call(client, headers, operation="create", format="pptx", filename="演示.pptx")
    draft = created.json()["draft"]

    edited = await _call(
        client,
        headers,
        operation="edit",
        fileId=draft["id"],
        commands=[
            {"command": "add", "parent": "/", "type": "slide"},
            {
                "command": "add",
                "parent": "/slide[1]",
                "type": "textbox",
                "props": {"text": "封面标题", "x": "2cm", "y": "2cm", "width": "20cm", "height": "3cm"},
            },
        ],
        save=True,
    )
    assert edited.status_code == 200, edited.text

    read = await _call(client, headers, operation="read", fileId=edited.json()["file"]["id"])
    assert read.status_code == 200, read.text
    assert "封面标题" in read.json()["text"]


async def test_read_and_grep_uploaded_text(client, create_user):
    _, headers = await create_user("regular")
    file = await _upload(client, headers, "notes.txt", b"alpha\nbeta\ngamma\n")

    read = await _call(client, headers, operation="read", fileId=file["id"], start=2, end=2)
    assert read.status_code == 200, read.text
    assert read.json()["text"] == "beta"
    assert read.json()["startLine"] == 2
    assert read.json()["totalLines"] == 3

    grep = await _call(client, headers, operation="grep", fileId=file["id"], pattern="^(alpha|gamma)$")
    assert grep.status_code == 200, grep.text
    assert [match["line"] for match in grep.json()["matches"]] == [1, 3]

    bad_regex = await _call(client, headers, operation="grep", fileId=file["id"], pattern="(")
    assert bad_regex.status_code == 422


async def test_list_returns_uploads_and_drafts_then_filters_conversations(client, create_user):
    import uuid

    _, headers = await create_user("regular")
    conversation = (
        await client.post(
            "/api/conversations",
            headers=headers,
            json={"clientId": str(uuid.uuid4()), "title": "Docs"},
        )
    ).json()
    attached = await _upload(
        client,
        headers,
        "attached.txt",
        b"hi",
        conversationId=conversation["id"],
    )

    created = await _call(
        client,
        headers,
        operation="create",
        format="pdf",
        filename="draft.pdf",
        conversationId=conversation["id"],
    )
    draft = created.json()["draft"]

    listing = (await _call(client, headers, operation="list", conversationId=conversation["id"])).json()
    ids = {item["id"] for item in listing["files"]}
    assert ids == {attached["id"], draft["id"]}
    by_id = {item["id"]: item for item in listing["files"]}
    assert by_id[attached["id"]]["draft"] is False
    assert by_id[draft["id"]]["draft"] is True

    empty = (
        await _call(client, headers, operation="list", conversationId=str(uuid.uuid4()))
    ).json()
    assert empty["files"] == []


async def test_client_conversation_id_is_resolved_before_saving(client, create_user):
    import uuid

    _, headers = await create_user("regular")
    conversation = (
        await client.post(
            "/api/conversations",
            headers=headers,
            json={"clientId": str(uuid.uuid4()), "title": "Docs"},
        )
    ).json()

    # The chat client only knows its own conversation id; the draft and the saved file
    # must both carry the server id, or the foreign key rejects the save.
    created = await _call(
        client,
        headers,
        operation="create",
        format="pdf",
        filename="client.pdf",
        conversationId=conversation["clientId"],
    )
    assert created.status_code == 200, created.text
    draft = created.json()["draft"]
    assert draft["conversationId"] == conversation["id"]

    saved = await _call(client, headers, operation="save", fileId=draft["id"])
    assert saved.status_code == 200, saved.text
    file = saved.json()["file"]
    assert file["conversationId"] == conversation["id"]

    listing = (
        await _call(client, headers, operation="list", conversationId=conversation["clientId"])
    ).json()
    assert [item["id"] for item in listing["files"]] == [file["id"]]


async def test_saved_generated_file_can_be_edited_in_place(client, create_user):
    _, headers = await create_user("regular")
    created = await _call(
        client, headers, operation="create", format="pdf", filename="doc.pdf", save=True
    )
    file = created.json()["file"]

    first = await _call(
        client,
        headers,
        operation="edit",
        fileId=file["id"],
        save=True,
        pdfChanges=[{"operation": "add_page", "text": "A"}],
    )
    assert first.status_code == 200, first.text
    assert first.json()["file"]["revision"] == 2

    stale = await _call(
        client,
        headers,
        operation="edit",
        fileId=file["id"],
        save=True,
        pdfChanges=[{"operation": "add_page", "text": "B"}],
    )
    assert stale.status_code == 200, stale.text
    assert stale.json()["file"]["revision"] == 3

    files = (await client.get("/api/files", headers=headers)).json()["items"]
    assert len(files) == 1
    assert files[0]["revision"] == 3


async def test_validation_rejects_unknown_operations_and_unsafe_paths(client, create_user):
    _, headers = await create_user("regular")

    cases = [
        {"operation": "delete_all"},
        {"operation": "delete"},
        {"operation": "create"},
        {"operation": "create", "fileId": "draft:abc", "format": "pdf"},
        {"operation": "edit", "fileId": "draft:abc"},
        {"operation": "edit", "fileId": "draft:abc", "commands": [], "pdfChanges": []},
        {"operation": "save", "fileId": "not-a-draft"},
        {"operation": "read"},
        {"operation": "grep", "fileId": "draft:abc", "pattern": "  "},
        {"operation": "help"},
    ]
    for payload in cases:
        response = await _call(client, headers, **payload)
        assert response.status_code == 422, (payload, response.text)

    unsafe = await _call(
        client,
        headers,
        operation="create",
        format="pdf",
        commands=[
            {"command": "add", "parent": "/../etc", "type": "paragraph", "props": {"text": "x"}}
        ],
    )
    assert unsafe.status_code == 422

    unknown_prop = await _call(
        client,
        headers,
        operation="create",
        format="pdf",
        commands=[
            {"command": "set", "path": "/body", "props": {"macro": "rm -rf"}}
        ],
    )
    assert unknown_prop.status_code == 422

    bad_change_mix = await _call(
        client,
        headers,
        operation="edit",
        fileId="draft:abc",
        commands=[{"command": "remove", "path": "/body"}],
        pdfChanges=[{"operation": "add_page"}],
    )
    assert bad_change_mix.status_code == 422


async def test_missing_and_foreign_files_are_not_found(client, create_user):
    _, headers = await create_user("regular")
    file = await _upload(client, headers, "notes.txt", b"secret")

    missing = await _call(client, headers, operation="read", fileId=str(__import__("uuid").uuid4()))
    assert missing.status_code == 404

    invalid_id = await _call(client, headers, operation="read", fileId="not-a-uuid")
    assert invalid_id.status_code == 422

    # A second user can call the tool but cannot read the first user's file.
    _, other_headers = await create_user("other")

    foreign = await _call(client, other_headers, operation="read", fileId=file["id"])
    assert foreign.status_code == 404

    listing = (await _call(client, other_headers, operation="list")).json()
    assert listing["files"] == []


async def test_delete_removes_library_files_and_drafts(client, create_user):
    _, headers = await create_user("regular")
    uploaded = await _upload(client, headers, "obsolete.txt", b"old")

    _, other_headers = await create_user("other")
    foreign = await _call(client, other_headers, operation="delete", fileId=uploaded["id"])
    assert foreign.status_code == 404

    deleted = await _call(client, headers, operation="delete", fileId=uploaded["id"])
    assert deleted.status_code == 200, deleted.text
    assert deleted.json() == {
        "operation": "delete", "fileId": uploaded["id"], "filename": "obsolete.txt",
    }
    assert (await client.get("/api/files", headers=headers)).json()["items"] == []
    assert (await client.get(f"/api/files/{uploaded['id']}/content", headers=headers)).status_code == 404

    created = await _call(
        client, headers, operation="create", format="pdf", filename="scratch.pdf"
    )
    draft_id = created.json()["draft"]["id"]
    removed = await _call(client, headers, operation="delete", fileId=draft_id)
    assert removed.status_code == 200, removed.text
    assert removed.json()["draft"] is True
    assert removed.json()["filename"] == "scratch.pdf"
    gone = await _call(client, headers, operation="save", fileId=draft_id)
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "draft_not_found"


async def test_drafts_are_private_and_expire_after_save(client, create_user):
    _, headers = await create_user("regular")
    created = await _call(
        client, headers, operation="create", format="pdf", filename="private.pdf"
    )
    draft_id = created.json()["draft"]["id"]

    _, other_headers = await create_user("other")
    foreign = await _call(client, other_headers, operation="inspect", fileId=draft_id)
    assert foreign.status_code == 404

    # Back to the original account: saving consumes the draft.
    saved = await _call(client, headers, operation="save", fileId=draft_id)
    assert saved.status_code == 200

    gone = await _call(client, headers, operation="save", fileId=draft_id)
    assert gone.status_code == 404
    assert gone.json()["error"]["code"] == "draft_not_found"


async def test_edit_requires_the_matching_change_payload(client, create_user):
    _, headers = await create_user("regular")
    created = await _call(
        client,
        headers,
        operation="create",
        format="pptx",
        filename="deck.pptx",
        save=True,
    )
    assert created.status_code == 200, created.text
    file = created.json()["file"]

    wrong_kind = await _call(
        client,
        headers,
        operation="edit",
        fileId=file["id"],
        commands=[{"command": "remove", "path": "/slide[1]"}],
    )
    assert wrong_kind.status_code == 422

    # Legacy conversion failures and engine errors are surfaced as documented codes,
    # but a well-formed PDF change on a PPTX is simply unsupported.
    pdf_change = await _call(
        client,
        headers,
        operation="edit",
        fileId=file["id"],
        pdfChanges=[{"operation": "rotate_page", "page": 1, "degrees": 90}],
    )
    assert pdf_change.status_code == 422
