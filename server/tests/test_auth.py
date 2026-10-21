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


async def test_must_change_password_blocks_data_endpoints(client, create_user):
    _, headers = await create_user(must_change_password=True)
    blocked = await client.get("/api/conversations", headers=headers)
    assert blocked.status_code == 403
    assert blocked.json()["error"]["code"] == "password_change_required"

    changed = await client.post(
        "/api/auth/change-password",
        headers=headers,
        json={"currentPassword": "password123", "newPassword": "new-password123"},
    )
    assert changed.status_code == 200
    assert (await client.get("/api/conversations", headers=headers)).status_code == 200


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
