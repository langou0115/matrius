import sys
from types import SimpleNamespace

import pytest

from app.documents import binaries
from app.documents.process import child_env, run_process
from app.errors import AppError


def test_officecli_batch_errors_explain_repair_without_echoing_document_content():
    import json

    from app.documents.officecli import _check
    from app.documents.process import ProcessResult

    result = ProcessResult(1, json.dumps({"success": False, "data": {"results": [{
        "index": 2, "success": False, "code": "duplicate_name",
        "error": "private document content", "item": {"props": {"text": "private"}},
    }]}}).encode(), b"private stderr")
    with pytest.raises(AppError) as caught:
        _check(result, "编辑文档")
    assert caught.value.code == "invalid_document_operation"
    assert "第 3 条命令" in caught.value.message
    assert "Sheet1" in caught.value.message
    assert "private" not in caught.value.message


def test_officecli_structural_errors_reach_the_model():
    import json

    from app.documents.officecli import _check
    from app.documents.process import ProcessResult

    missing = ProcessResult(1, json.dumps({"success": False, "error": {
        "error": "Slide 1 not found (total: 0)",
        "code": "not_found",
        "suggestion": "No Slide elements exist. Add one first.",
    }}).encode(), b"")
    with pytest.raises(AppError) as caught:
        _check(missing, "查看文档结构")
    assert "Slide 1 not found (total: 0)" in caught.value.message
    assert "Add one first." in caught.value.message

    bad_parent = ProcessResult(1, json.dumps({"success": False, "data": {"results": [{
        "index": 0, "success": False, "code": "invalid_value",
        "error": "Invalid parent '/presentation' for --type slide: a slide can only be added at '/'.",
    }]}}).encode(), b"")
    with pytest.raises(AppError) as caught:
        _check(bad_parent, "编辑文档")
    assert "can only be added at '/'" in caught.value.message


def test_office_properties_follow_the_engine_schema_and_block_resource_loads():
    from pydantic import ValidationError

    from app.documents.schemas import OfficeSetCommand

    accepted = OfficeSetCommand(
        command="set",
        path="/slide[1]/shape[1]",
        props={"lineSpacing": "1.5x", "GRADIENT": "FF0000-0000FF-45", "slideSize": "widescreen"},
    )
    assert accepted.props["lineSpacing"] == "1.5x"

    radial = OfficeSetCommand(
        command="set", path="/slide[1]", props={"background": "radial:FF0000-0000FF-tr"}
    )
    assert radial.props["background"].startswith("radial:")

    with pytest.raises(ValidationError, match="不支持的文档属性：macro"):
        OfficeSetCommand(command="set", path="/body", props={"macro": "rm -rf"})
    for blocked in ("data", "src", "image", "password", "mermaid"):
        with pytest.raises(ValidationError):
            OfficeSetCommand(command="set", path="/slide[1]", props={blocked: "x"})
    with pytest.raises(ValidationError, match="不支持图片、文件或 URL 引用"):
        OfficeSetCommand(command="set", path="/slide[1]", props={"background": "image:/etc/passwd"})


def test_compact_help_keeps_only_paths_and_writable_properties():
    import json

    from app.documents.officecli import _compact_help

    raw = json.dumps({
        "format": "pptx",
        "element": "shape",
        "parent": "slide",
        "paths": {"positional": ["/slide[N]/shape[@id=ID]", "/slide[N]/shape[N]"]},
        "note": "A floating shape.",
        "properties": {
            "text": {"type": "string", "add": True, "set": True, "description": "plain text"},
            "lineSpacing": {"type": "string", "add": True, "set": True, "aliases": ["linespacing"]},
            "effective.size": {"type": "length", "add": False, "set": False, "get": True},
            "src": {"type": "string", "add": True, "set": True},
        },
    })
    text = _compact_help("pptx", "shape", raw)
    assert "paths: /slide[N]/shape[@id=ID]" in text
    assert "text (string)" in text
    assert "lineSpacing (string)" in text
    assert "effective.size" not in text
    assert "src" not in text
    assert len(text) < 2_000


async def test_office_property_allowlist_is_in_sync_with_the_vendored_engine():
    """Regression guard: a stale hand-written list rejected documented engine props."""

    import json

    from app.documents.officecli import _ENGINE_ENV
    from app.documents.properties import BLOCKED_PROPERTIES, load_property_names

    try:
        binary = binaries.resolve_officecli()
    except AppError:
        pytest.skip("no vendored OfficeCLI for this platform")
    # Use the app's bounded runner: it disables the engine's resident/updater (which would
    # keep the stdout pipe open) and kills the process group on timeout.
    result = await run_process(
        [str(binary), "help", "all", "--json"], timeout_seconds=60, env=_ENGINE_ENV
    )
    assert result.returncode == 0, result.stderr
    rows = json.loads(result.stdout.decode("utf-8-sig"))["data"]

    expected: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") != "PROP":
            continue
        name = row.get("name")
        ops = row.get("ops") or ""
        if not isinstance(name, str) or not name or name.startswith("effective."):
            continue
        if "a" not in ops and "s" not in ops:
            continue
        for item in [name, *(row.get("aliases") or [])]:
            normalized = str(item).strip().lower()
            if normalized and normalized not in BLOCKED_PROPERTIES:
                expected.add(normalized)

    assert load_property_names() == expected, (
        "office_properties.json is out of date; run scripts/generate_office_properties.py"
    )


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


async def test_officecli_disables_background_resident_update_and_install(monkeypatch):
    from app.documents import officecli
    from app.documents.process import ProcessResult

    captured = {}

    async def fake_run(argv, **kwargs):
        captured.update(kwargs)
        return ProcessResult(0, b'{"success": true}', b"")

    monkeypatch.setattr(officecli, "resolve_officecli", lambda: "officecli")
    monkeypatch.setattr(officecli, "run_process", fake_run)
    await officecli.office_help("xlsx")
    assert captured["env"] == {
        "OFFICECLI_NO_AUTO_RESIDENT": "1",
        "OFFICECLI_SKIP_UPDATE": "1",
        "OFFICECLI_NO_AUTO_INSTALL": "1",
    }


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
