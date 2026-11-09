from collections import namedtuple
from types import SimpleNamespace

from app import resources


def test_disk_usage_uses_data_filesystem(tmp_path, monkeypatch):
    target = tmp_path / "data"
    target.mkdir()
    monkeypatch.setattr(resources, "get_settings", lambda: SimpleNamespace(data_dir=str(target)))
    calls = []

    def read_disk(path):
        calls.append(path)
        return namedtuple("usage", "total used free")(10000, 6000, 4000)

    monkeypatch.setattr(resources.shutil, "disk_usage", read_disk)
    assert resources.disk_usage() == {"total": 10000, "used": 6000, "free": 4000}
    assert calls == [target.resolve()]


async def test_storage_reports_server_capacity_separately_from_files(client, create_instance, monkeypatch):
    await create_instance()
    from app.files import router

    monkeypatch.setattr(router, "disk_usage", lambda: {"total": 10000, "used": 6000, "free": 4000})
    response = await client.get("/api/files/usage")
    assert response.status_code == 200
    result = response.json()
    assert result["disk"] == {"total": 10000, "used": 6000, "free": 4000}
    assert result["used"] == 0
    assert "quota" not in result
