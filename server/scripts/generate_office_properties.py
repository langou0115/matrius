"""Regenerate ``app/documents/office_properties.json`` from the vendored OfficeCLI.

The document tool validates property names against that file instead of a hand-written
list, so a model that uses a documented engine property (``gradient``, ``lineSpacing``,
``slideSize`` …) is not rejected just because the server list is stale.

Run after upgrading ``server/vendor/officecli``::

    cd server
    uv run --no-sync python scripts/generate_office_properties.py

Properties that can load a local file, a URL or a data URI are removed by
``app.documents.properties.BLOCKED_PROPERTIES``; the tool's contract is "no external
resources". ``officecli help all --json`` is the authoritative engine surface.
"""

from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from app.documents.binaries import OFFICECLI_ROOT, resolve_officecli  # noqa: E402
from app.documents.process import run_process  # noqa: E402
from app.documents.properties import BLOCKED_PROPERTIES  # noqa: E402


async def main() -> None:
    binary = resolve_officecli()
    result = await run_process(
        [str(binary), "help", "all", "--json"],
        timeout_seconds=60,
        env={
            "OFFICECLI_NO_AUTO_RESIDENT": "1",
            "OFFICECLI_NO_AUTO_INSTALL": "1",
            "OFFICECLI_SKIP_UPDATE": "1",
        },
    )
    if result.returncode != 0 or not result.stdout:
        raise SystemExit(f"officecli help all failed with exit code {result.returncode}")
    payload = json.loads(result.stdout.decode("utf-8-sig"))
    rows = payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise SystemExit("unexpected officecli help output")

    accepted: set[str] = set()
    for row in rows:
        if not isinstance(row, dict) or row.get("kind") != "PROP":
            continue
        name = row.get("name")
        ops = row.get("ops") or ""
        if not isinstance(name, str) or not name or name.startswith("effective."):
            continue
        # Only properties the engine can add or set matter; get-only keys are readback.
        if "a" not in ops and "s" not in ops:
            continue
        for item in [name, *(row.get("aliases") or [])]:
            if not isinstance(item, str) or not item.strip():
                continue
            normalized = item.strip().lower()
            if normalized in BLOCKED_PROPERTIES:
                continue
            accepted.add(normalized)

    version = "unknown"
    version_file = OFFICECLI_ROOT / "VERSION"
    if version_file.is_file():
        version = version_file.read_text(encoding="utf-8").strip()

    target = ROOT / "app" / "documents" / "office_properties.json"
    data = {
        "engineVersion": version,
        "generatedBy": "scripts/generate_office_properties.py",
        "normalized": "lowercase, case-insensitive lookup",
        "properties": sorted(accepted),
    }
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(f"Wrote {len(accepted)} property names for OfficeCLI {version} to {target}")


if __name__ == "__main__":
    asyncio.run(main())
