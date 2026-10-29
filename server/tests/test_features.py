from app.models import User
from app.utils import utcnow


async def test_features_are_available_to_every_password_ready_account(client, create_user):
    _, regular = await create_user("regular")
    _, admin = await create_user("admin", is_admin=True)

    for headers in (regular, admin):
        me = await client.get("/api/auth/me", headers=headers)
        assert me.json()["features"] == ["files"]
        assert me.headers["cache-control"] == "no-store"

        response = await client.get("/api/features", headers=headers)
        features = response.json()["features"]
        assert [item["id"] for item in features] == ["files"]
        assert response.headers["cache-control"] == "no-store"

        # Client-provided identity never changes the feature list.
        spoofed = await client.get("/api/features", headers={
            **headers, "X-Username": "someone-else", "X-Feature": "files",
        })
        assert [item["id"] for item in spoofed.json()["features"]] == ["files"]

    client.cookies.clear()
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get("/api/features")).status_code == 401


async def test_first_password_change_is_required_before_features(client, create_user):
    _, headers = await create_user("regular", must_change_password=True)
    assert (await client.get("/api/auth/me", headers=headers)).json()["features"] == []
    blocked = await client.get("/api/features", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "password_change_required"

    response = await client.post("/api/auth/change-password", headers=headers, json={
        "currentPassword": "password123", "newPassword": "another-password",
    })
    assert response.status_code == 200
    assert (await client.get("/api/auth/me", headers=headers)).json()["features"] == ["files"]


async def test_disabled_account_loses_features(client, create_user, session_factory):
    user_id, headers = await create_user("regular")
    async with session_factory() as db:
        user = await db.get(User, user_id)
        user.disabled_at = utcnow()
        await db.commit()

    assert (await client.get("/api/features", headers=headers)).status_code == 401
    assert (await client.post("/api/tools/file", headers=headers,
                              json={"operation": "list"})).status_code == 401
