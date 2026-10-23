"""Filesystem-backed object storage rooted at ``DATA_DIR/files``.

Replaces the previous S3/RustFS client. Object keys are relative POSIX paths,
validated so they can never escape the storage root.
"""

import logging
import os
import tempfile
from pathlib import Path, PurePosixPath

from app.config import get_settings

logger = logging.getLogger(__name__)


def storage_root() -> Path:
    return Path(get_settings().data_dir).expanduser().resolve() / "files"


def ensure_storage() -> Path:
    root = storage_root()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _target(key: str) -> Path:
    if not isinstance(key, str) or not key or "\x00" in key or "\\" in key:
        raise ValueError("Invalid storage key")
    relative = PurePosixPath(key)
    if relative.is_absolute() or any(part in ("", ".", "..") for part in relative.parts):
        raise ValueError("Invalid storage key")
    root = storage_root()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise ValueError("Storage key escapes the data directory")
    return target


def check_storage() -> None:
    root = ensure_storage()
    descriptor, probe = tempfile.mkstemp(prefix=".probe-", dir=root)
    os.close(descriptor)
    os.unlink(probe)


def put_object(key: str, data: bytes, content_type: str) -> None:
    """Write atomically so readers never observe a partial file."""
    target = _target(key)
    target.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".upload-", dir=target.parent)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
    except BaseException:
        try:
            os.unlink(temporary)
        except FileNotFoundError:
            pass
        raise


def get_object(key: str) -> bytes:
    return _target(key).read_bytes()


def delete_object(key: str) -> None:
    try:
        _target(key).unlink()
    except FileNotFoundError:
        pass
    except ValueError:
        logger.warning("Refusing to delete invalid storage key %r", key)
