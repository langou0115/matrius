"""Record the stable feature set only after successful production publication."""

import json
import os
import tempfile
from pathlib import Path

from app.features.registry import FEATURES


def publish(destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", dir=destination.parent, delete=False) as file:
            temporary = file.name
            json.dump([key for key, feature in FEATURES.items() if feature.stage == "stable"], file)
        os.chmod(temporary, 0o644)
        os.replace(temporary, destination)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)


if __name__ == "__main__":
    publish(Path("/releases/features.json"))
