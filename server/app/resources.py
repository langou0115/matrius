"""Disk capacity of the filesystem backing persistent instance data."""

import shutil
from pathlib import Path

from app.config import get_settings


def disk_usage() -> dict[str, int]:
    target = Path(get_settings().data_dir).resolve()
    # Configuration can be read before bootstrap creates the data directory.
    while not target.exists() and target != target.parent:
        target = target.parent
    usage = shutil.disk_usage(target)
    return {"total": usage.total, "used": usage.used, "free": usage.free}
