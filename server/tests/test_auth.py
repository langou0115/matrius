async def test_login_and_me(client, create_user):
    _, headers = await create_user()
    response = await client.get("/api/auth/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["username"] == "alice"


async def test_login_rejects_bad_password(client, create_user):
    await create_user()
    response = await client.post(
        "/api/auth/login", json={"username": "alice", "password": "wrong-password"}
    )
    assert response.status_code == 401


async def test_logout_revokes_token(client, create_user):
    _, headers = await create_user()
    assert (await client.post("/api/auth/logout", headers=headers)).status_code == 200
    assert (await client.get("/api/auth/me", headers=headers)).status_code == 401


async def test_browser_login_uses_a_persistent_http_only_cookie(client, create_user):
    await create_user()
    client.cookies.clear()
    login = await client.post(
        "/api/auth/login", json={"username": "alice", "password": "password123"}
    )
    assert login.status_code == 200
    cookie = login.headers.get("set-cookie", "").lower()
    assert "matrius_session=" in cookie
    assert "httponly" in cookie
    assert "samesite=lax" in cookie
    assert "max-age=" in cookie

    # No Authorization header: the cookie alone restores the account.
    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["username"] == "alice"
    assert "matrius_session=" in me.headers.get("set-cookie", ""), "the cookie slides on each check"

    logout = await client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert "matrius_session=" in logout.headers.get("set-cookie", "")
    assert (await client.get("/api/auth/me")).status_code == 401


async def test_admin_login_sets_a_separate_cookie(client, create_user):
    await create_user(username="admin", is_admin=True)
    client.cookies.clear()
    login = await client.post(
        "/api/admin/auth/login", json={"username": "admin", "password": "password123"}
    )
    assert login.status_code == 200
    assert "matrius_admin_session=" in login.headers.get("set-cookie", "")
    me = await client.get("/api/admin/auth/me")
    assert me.status_code == 200
    assert "matrius_admin_session=" in me.headers.get("set-cookie", "")


async def test_account_and_admin_cookies_coexist_and_logout_independently(client, create_user):
    await create_user("alice")
    await create_user("admin", is_admin=True)
    # Both cookies are present; each route picks its own scope.
    assert (await client.get("/api/admin/auth/me")).status_code == 200
    assert (await client.get("/api/auth/me")).json()["username"] == "alice"

    assert (await client.post("/api/auth/logout")).status_code == 200
    assert (await client.get("/api/auth/me")).status_code == 401
    assert (await client.get("/api/admin/auth/me")).status_code == 200

    assert (await client.post("/api/admin/auth/logout")).status_code == 200
    assert (await client.get("/api/admin/auth/me")).status_code == 401


async def test_new_sessions_have_no_expiry(client, create_user, session_factory):
    from sqlalchemy import select

    from app.models import AuthSession

    await create_user()
    async with session_factory() as session:
        rows = (await session.execute(select(AuthSession))).scalars().all()
    assert rows
    assert all(row.expires_at is None for row in rows)


async def test_must_change_password_accepts_short_password_and_unblocks_data(client, create_user):
    _, headers = await create_user(must_change_password=True)
    blocked = await client.get("/api/conversations", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "password_change_required"

    changed = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"currentPassword": "password123", "newPassword": "x"},
    )
    assert changed.status_code == 200
    assert (await client.get("/api/conversations", headers=headers)).status_code == 200
    login = await client.post("/api/auth/login", json={"username": "alice", "password": "x"})
    assert login.status_code == 200
    assert login.json()["user"]["mustChangePassword"] is False


async def test_password_change_rejects_empty_and_unchanged_passwords(client, create_user):
    _, headers = await create_user(password="x")
    for new_password in ("", "x"):
        response = await client.post(
            "/api/auth/change-password",
            headers=headers,
            json={"currentPassword": "x", "newPassword": new_password},
        )
        assert response.status_code == 422
    assert (
        await client.post("/api/auth/login", json={"username": "alice", "password": "x"})
    ).status_code == 200


async def test_admin_can_create_and_disable_user(client, create_user):
    _, admin_headers = await create_user(username="admin", is_admin=True)

    created = await client.post(
        "/api/admin/users", headers=admin_headers, json={"username": "bob"}
    )
    assert created.status_code == 201
    password = created.json()["password"]
    assert password == "bob@123"

    login = await client.post(
        "/api/admin/auth/login", json={"username": "bob", "password": password}
    )
    assert login.status_code == 403

    normal_login = await client.post(
        "/api/auth/login", json={"username": "bob", "password": password}
    )
    assert normal_login.status_code == 200

    users = (await client.get("/api/admin/users", headers=admin_headers)).json()["items"]
    bob = next(item for item in users if item["username"] == "bob")

    disabled = await client.patch(
        f"/api/admin/users/{bob['id']}", headers=admin_headers, json={"disabled": True}
    )
    assert disabled.status_code == 200

    rejected = await client.post(
        "/api/auth/login", json={"username": "bob", "password": password}
    )
    assert rejected.status_code == 403


async def test_admin_session_requires_admin_scope(client, create_user):
    _, user_headers = await create_user("alice")
    assert (await client.get("/api/admin/auth/me", headers=user_headers)).status_code == 403

    _, admin_headers = await create_user("admin", is_admin=True)
    me = await client.get("/api/admin/auth/me", headers=admin_headers)
    assert me.status_code == 200
    assert me.json()["isAdmin"] is True


async def test_admin_cannot_disable_self(client, create_user):
    user_id, headers = await create_user(username="admin", is_admin=True)
    response = await client.patch(
        f"/api/admin/users/{user_id}", headers=headers, json={"disabled": True}
    )
    assert response.status_code == 400
