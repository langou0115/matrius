from app.models import Instance


async def test_instance_access_without_credentials(client, session_factory):
    async with session_factory() as db:
        db.add(Instance(id=1))
        await db.commit()
    response = await client.get("/api/features")
    assert response.status_code == 200
    assert "files" in [item["id"] for item in response.json()["features"]]
    assert (await client.post("/api/auth/login", json={})).status_code == 404
    assert (await client.get("/api/auth/me")).status_code == 404
    assert (await client.post("/api/auth/change-password", json={})).status_code == 404
