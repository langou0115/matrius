from dataclasses import replace

from app.config import get_settings
from app.features.registry import FEATURES
from app.features.release import publish
from app.models import User
from app.utils import utcnow


async def test_preview_is_granted_by_authenticated_account_not_admin_role(client, create_user):
    _, regular = await create_user("regular")
    _, admin = await create_user("admin", is_admin=True)
    _, preview = await create_user("admin_test")

    for headers in (regular, admin):
        me = await client.get("/api/auth/me", headers=headers)
        assert me.json()["features"] == []
        assert me.headers["cache-control"] == "no-store"
        assert (await client.get("/api/features", headers=headers)).json() == {"features": []}
        blocked = await client.get("/api/features/labs?username=admin_test", headers={
            **headers, "X-Username": "admin_test", "X-Feature": "labs",
        })
        assert blocked.status_code == 403
        assert blocked.json()["error"]["code"] == "feature_unavailable"

    me = (await client.get("/api/auth/me", headers=preview)).json()
    assert me["features"] == ["labs"]
    assert me["isAdmin"] is False
    enabled = await client.get("/api/features/labs", headers=preview)
    assert enabled.status_code == 200
    assert enabled.json()["features"][0]["stage"] == "preview"
    assert enabled.headers["cache-control"] == "no-store"
    assert (await client.get("/api/features/labs")).status_code == 401


async def test_first_password_change_is_required_before_features(client, create_user):
    _, headers = await create_user("ADMIN_TEST", must_change_password=True)
    assert (await client.get("/api/auth/me", headers=headers)).json()["features"] == []
    assert (await client.get("/api/features/labs", headers=headers)).status_code == 403
    response = await client.post("/api/auth/change-password", headers=headers, json={
        "currentPassword": "password123", "newPassword": "another-password",
    })
    assert response.status_code == 200
    assert (await client.get("/api/auth/me", headers=headers)).json()["features"] == ["labs"]


async def test_release_and_retraction_apply_to_existing_sessions(client, create_user, monkeypatch, tmp_path):
    manifest = tmp_path / "features.json"
    monkeypatch.setattr(get_settings(), "feature_releases_file", str(manifest))
    _, headers = await create_user()
    assert (await client.get("/api/features/labs", headers=headers)).status_code == 403
    preview = FEATURES["labs"]
    monkeypatch.setitem(FEATURES, "labs", replace(preview, stage="stable"))
    publish(manifest)
    assert (await client.get("/api/auth/me", headers=headers)).json()["features"] == ["labs"]
    assert (await client.get("/api/features/labs", headers=headers)).status_code == 200
    monkeypatch.setitem(FEATURES, "labs", preview)
    assert (await client.get("/api/features/labs", headers=headers)).status_code == 403
    await client.post("/api/auth/logout", headers=headers)
    assert (await client.get("/api/features/labs", headers=headers)).status_code == 401


async def test_disabled_preview_account_loses_access(client, create_user, session_factory):
    user_id, headers = await create_user("admin_test")
    async with session_factory() as db:
        user = await db.get(User, user_id)
        user.disabled_at = utcnow()
        await db.commit()
    assert (await client.get("/api/features/labs", headers=headers)).status_code == 401


async def test_remote_does_not_promote_a_feature_until_successful_publication(
    client, create_user, monkeypatch, tmp_path
):
    manifest = tmp_path / "releases" / "features.json"
    monkeypatch.setattr(get_settings(), "feature_releases_file", str(manifest))
    _, regular = await create_user("regular")
    _, preview = await create_user("admin_test")
    monkeypatch.setitem(FEATURES, "labs", replace(FEATURES["labs"], stage="stable"))
    assert (await client.get("/api/features/labs", headers=regular)).status_code == 403
    assert (await client.get("/api/features/labs", headers=preview)).status_code == 200
    publish(manifest)
    assert (await client.get("/api/features/labs", headers=regular)).status_code == 200
    manifest.write_text('invalid-json')
    assert (await client.get("/api/features/labs", headers=regular)).status_code == 403
