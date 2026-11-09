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
        json={"newPassword": "x"},
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


async def test_initial_password_cannot_be_reused_without_current_password(client, create_user):
    _, headers = await create_user(must_change_password=True)
    response = await client.post(
        "/api/auth/change-password", headers=headers, json={"newPassword": "password123"}
    )
    assert response.status_code == 422
    assert (await client.get("/api/auth/me", headers=headers)).json()["mustChangePassword"] is True


async def test_normal_password_change_requires_current_password(client, create_user):
    _, headers = await create_user()
    for payload in ({"newPassword": "replacement"}, {"currentPassword": "wrong", "newPassword": "replacement"}):
        response = await client.post("/api/auth/change-password", headers=headers, json=payload)
        assert response.status_code == 401
    response = await client.post(
        "/api/auth/change-password", headers=headers,
        json={"currentPassword": "password123", "newPassword": "replacement"},
    )
    assert response.status_code == 200


async def test_initial_password_change_requires_a_session(client):
    response = await client.post("/api/auth/change-password", json={"newPassword": "replacement"})
    assert response.status_code == 401


async def test_management_endpoints_are_removed(client, create_user):
    _, headers = await create_user()
    for path in ("/api/admin/users", "/api/admin/auth/me", "/api/admin/auth/login"):
        response = await client.request("POST" if path.endswith("login") else "GET", path, headers=headers)
        assert response.status_code == 404


async def test_legacy_account_cannot_login_or_use_an_old_token(client, create_user):
    await create_user("owner")
    _, archived = await create_user("archived")
    response = await client.post("/api/auth/login", json={"username": "archived", "password": "password123"})
    assert response.status_code == 401
    for path in ("/api/auth/me", "/api/conversations", "/api/files", "/api/features"):
        assert (await client.get(path, headers=archived)).status_code == 401


async def test_owner_has_no_administrator_role(client, create_user):
    _, headers = await create_user()
    assert "isAdmin" not in (await client.get("/api/auth/me", headers=headers)).json()
