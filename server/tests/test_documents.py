import sys
from types import SimpleNamespace

import pytest

from app.documents import binaries
from app.documents.process import child_env, run_process
from app.errors import AppError


async def test_run_process_feeds_stdin_and_filters_environment(monkeypatch):
    monkeypatch.setenv("MATRIUS_TEST_SECRET", "leaked")
    code = (
        "import os, sys; "
        "sys.stdout.write(sys.stdin.read() + '|' + os.environ.get('MATRIUS_TEST_SECRET', '')); "
        "sys.stderr.write('stderr')"
    )
    result = await run_process([sys.executable, "-c", code], stdin_bytes=b"payload", timeout_seconds=10)
    assert result.returncode == 0
    assert result.stdout == b"payload|"
    assert result.stderr == b"stderr"
    assert result.truncated is False


async def test_run_process_kills_a_hung_child_on_timeout():
    code = "import time; time.sleep(30)"
    result = await run_process([sys.executable, "-c", code], timeout_seconds=0.5)
    assert result.returncode == -1


async def test_run_process_caps_output():
    code = "import sys; sys.stdout.write('x' * 10000)"
    result = await run_process([sys.executable, "-c", code], timeout_seconds=10, max_output_bytes=100)
    assert result.truncated is True
    assert len(result.stdout) == 100


def test_child_env_only_forwards_the_whitelist(monkeypatch):
    monkeypatch.setenv("MATRIUS_TEST_SECRET", "leaked")
    env = child_env({"EXTRA": "value"})
    assert "MATRIUS_TEST_SECRET" not in env
    assert env["EXTRA"] == "value"
    assert env["LANG"] == "C.UTF-8"


def _settings(**kwargs):
    values = {"officecli_path": "", "libreoffice_path": ""}
    values.update(kwargs)
    return SimpleNamespace(**values)


def _fake_root(tmp_path, digest="0" * 64):
    root = tmp_path / "officecli"
    binary = root / "linux-x64" / "officecli"
    binary.parent.mkdir(parents=True)
    binary.write_bytes(b"fake officecli")
    binary.chmod(0o755)
    (root / "SHA256SUMS").write_text(f"{digest}  linux-x64/officecli\n", encoding="utf-8")
    return root, binary


def test_resolve_officecli_verifies_the_vendored_checksum(tmp_path, monkeypatch):
    root, binary = _fake_root(tmp_path)
    monkeypatch.setattr(binaries, "OFFICECLI_ROOT", root)
    monkeypatch.setattr(binaries, "SUMS_PATH", root / "SHA256SUMS")
    monkeypatch.setattr(binaries, "get_settings", lambda: _settings())
    monkeypatch.setattr(binaries.sys, "platform", "linux")
    import hashlib

    (root / "SHA256SUMS").write_text(
        f"{hashlib.sha256(binary.read_bytes()).hexdigest()}  linux-x64/officecli\n", encoding="utf-8"
    )
    assert binaries.resolve_officecli() == binary


def test_resolve_officecli_rejects_a_tampered_binary(tmp_path, monkeypatch):
    root, _ = _fake_root(tmp_path)
    monkeypatch.setattr(binaries, "OFFICECLI_ROOT", root)
    monkeypatch.setattr(binaries, "SUMS_PATH", root / "SHA256SUMS")
    monkeypatch.setattr(binaries, "get_settings", lambda: _settings())
    monkeypatch.setattr(binaries.sys, "platform", "linux")
    with pytest.raises(AppError) as caught:
        binaries.resolve_officecli()
    assert caught.value.code == "officecli_unavailable"
    assert caught.value.status_code == 503


def test_configured_officecli_outside_vendor_skips_vendored_checksums(tmp_path, monkeypatch):
    external = tmp_path / "custom-officecli"
    external.write_bytes(b"custom")
    external.chmod(0o755)
    monkeypatch.setattr(binaries, "get_settings", lambda: _settings(officecli_path=str(external)))
    assert binaries.resolve_officecli() == external


def test_missing_libreoffice_has_a_distinct_error(monkeypatch):
    monkeypatch.setattr(binaries, "get_settings", lambda: _settings())
    monkeypatch.setattr(binaries, "_candidates", lambda: [])
    with pytest.raises(AppError) as caught:
        binaries.resolve_libreoffice()
    assert caught.value.code == "document_converter_unavailable"


def test_windows_defaults_to_the_win_binary(tmp_path, monkeypatch):
    root = tmp_path / "officecli"
    windows = root / "win-x64" / "officecli.exe"
    windows.parent.mkdir(parents=True)
    windows.write_bytes(b"exe")
    windows.chmod(0o755)
    monkeypatch.setattr(binaries, "OFFICECLI_ROOT", root)
    monkeypatch.setattr(binaries, "SUMS_PATH", root / "SHA256SUMS")
    monkeypatch.setattr(binaries, "get_settings", lambda: _settings())
    monkeypatch.setattr(binaries.sys, "platform", "win32")
    # A missing sums file only logs a warning; the platform still selects the .exe.
    assert binaries.resolve_officecli() == windows
