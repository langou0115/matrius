"""Office property names accepted by the document tool.

The allowlist is generated from the vendored OfficeCLI schema so a documented
property (``gradient``, ``lineSpacing``, ``slideSize`` …) is not rejected just
because a hand-written list went stale. ``office_properties.json`` is produced by
``scripts/generate_office_properties.py``; property names are matched
case-insensitively because the engine itself matches them that way.

Properties that can make the engine read a local file, a URL or a data URI are
removed both when generating and when loading, so a regenerated file can never
widen the "no external resources" contract.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path

PROPERTIES_FILE = Path(__file__).with_name("office_properties.json")

# Image/media/OLE sources, CSV/Markdown file inputs, macro-ish protection switches,
# and diagram sources that would launch a headless browser. Keep this list lowercase:
# every lookup normalizes the property name first.
BLOCKED_PROPERTIES = frozenset(
    """
    src path image image.relid data render poster mediatype contenttype olekind relid
    password passwordhash workbook.password workbookpassword protect formprot
    protection.algorithm protection.hash protection.salt protection.spincount
    lock locked lockstructure lockwindows trackchanges trackrevisions
    removepersonalinfo removepersonalinfoonsave removepersonalinformation
    mermaid dsl md source
    """.split()
)


@lru_cache(maxsize=1)
def load_property_names() -> frozenset[str]:
    """Return the normalized allowlist, or fail loudly when the data file is absent."""

    try:
        payload = json.loads(PROPERTIES_FILE.read_text(encoding="utf-8"))
    except OSError as exc:
        raise RuntimeError(
            f"缺少 {PROPERTIES_FILE.name}；请运行 server/scripts/generate_office_properties.py。"
        ) from exc
    names = payload.get("properties") if isinstance(payload, dict) else None
    if not isinstance(names, list) or not names:
        raise RuntimeError(
            "office_properties.json 格式不正确；请运行 server/scripts/generate_office_properties.py。"
        )
    normalized = {str(name).strip().lower() for name in names if str(name).strip()}
    return frozenset(normalized - BLOCKED_PROPERTIES)


def is_allowed_property(name: str) -> bool:
    return name.strip().lower() in load_property_names()
