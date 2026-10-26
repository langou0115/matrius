import logging
import os
import time

import pytest

from app import config


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    for name in ("WEBTOOL_PROXY_URL", "SEARCH_TIMEOUT_SECONDS", "MATRIUS_DEV_ENV_FILE"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setattr(config, "_settings", None)
    monkeypatch.setattr(config, "_settings_stamp", None)
    yield


def write_env(path, text: str) -> None:
    path.write_text(text, encoding="utf-8")
    # Make the change visible even on filesystems with coarse timestamps.
    stamp = time.time_ns() + 1_000_000_000
    os.utime(path, ns=(stamp, stamp))


def use_dev_file(monkeypatch, path) -> None:
    monkeypatch.setenv("MATRIUS_DEV_ENV_FILE", str(path))


def test_development_env_file_hot_reloads_runtime_settings(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    write_env(path, "WEBTOOL_PROXY_URL=http://127.0.0.1:7890\nSEARCH_TIMEOUT_SECONDS=8\n")
    use_dev_file(monkeypatch, path)

    first = config.get_settings()
    assert first.web_tool_proxy_url == "http://127.0.0.1:7890"
    assert first.search_timeout_seconds == 8

    write_env(path, "WEBTOOL_PROXY_URL=http://127.0.0.1:7891\nSEARCH_TIMEOUT_SECONDS=10\n")
    second = config.get_settings()
    assert second is not first
    assert second.web_tool_proxy_url == "http://127.0.0.1:7891"
    assert second.search_timeout_seconds == 10


def test_real_environment_overrides_the_dev_file(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    write_env(path, "WEBTOOL_PROXY_URL=http://127.0.0.1:7890\n")
    use_dev_file(monkeypatch, path)
    monkeypatch.setenv("WEBTOOL_PROXY_URL", "http://127.0.0.1:9999")

    assert config.get_settings().web_tool_proxy_url == "http://127.0.0.1:9999"


def test_production_never_reads_the_dev_file(tmp_path, monkeypatch):
    path = tmp_path / ".env.local"
    write_env(path, "WEBTOOL_PROXY_URL=http://127.0.0.1:7890\nSEARCH_TIMEOUT_SECONDS=10\n")
    use_dev_file(monkeypatch, path)
    monkeypatch.setenv("APP_ENV", "production")

    settings = config.get_settings()
    assert settings.web_tool_proxy_url == ""
    assert settings.search_timeout_seconds == 8


def test_invalid_edit_keeps_the_previous_settings(tmp_path, monkeypatch, caplog):
    path = tmp_path / ".env.local"
    write_env(path, "SEARCH_TIMEOUT_SECONDS=10\n")
    use_dev_file(monkeypatch, path)
    assert config.get_settings().search_timeout_seconds == 10

    write_env(path, "SEARCH_TIMEOUT_SECONDS=not-a-number\n")
    with caplog.at_level(logging.WARNING):
        assert config.get_settings().search_timeout_seconds == 10
    assert "keeping the previous settings" in caplog.text
