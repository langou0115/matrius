async def test_instance_features_need_no_credentials(client):
    response = await client.get("/api/features")
    assert response.status_code == 200
    assert {item["id"] for item in response.json()["features"]} == {"files", "usage"}
