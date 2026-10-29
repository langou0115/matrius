"""Locate the vendored OfficeCLI binary and a system LibreOffice.

The same checkout serves Linux and Windows development, so both binaries are
vendored under ``server/vendor/officecli``. Production Docker only ships the
Linux x64 build; Windows users get ``win-x64/officecli.exe``. macOS has no
vendored build and must set ``OFFICECLI_PATH`` explicitly.
"""

import hashlib
import logging
import os
import shutil
import sys
from functools import lru_cache
from pathlib import Path

from app.config import get_settings
from app.errors import AppError

logger = logging.getLogger(__name__)

VENDOR_ROOT = Path(__file__).resolve().parents[2] / "vendor"
OFFICECLI_ROOT = VENDOR_ROOT / "officecli"
FONT_PATH = VENDOR_ROOT / "fonts" / "NotoSansSC.ttf"
SUMS_PATH = OFFICECLI_ROOT / "SHA256SUMS"


def _platform_binary() -> Path | None:
    if sys.platform == "win32":
        return OFFICECLI_ROOT / "win-x64" / "officecli.exe"
    if sys.platform.startswith("linux"):
        return OFFICECLI_ROOT / "linux-x64" / "officecli"
    return None


def _read_sums() -> dict[str, str]:
    if not SUMS_PATH.is_file():
        return {}
    sums: dict[str, str] = {}
    for line in SUMS_PATH.read_text(encoding="utf-8").splitlines():
        parts = line.split()
        if len(parts) != 2:
            continue
        digest, name = parts
        sums[name.lstrip("*").replace("\\", "/")] = digest.lower()
    return sums


@lru_cache(maxsize=8)
def _digest(path: str, size: int, mtime_ns: int) -> str:
    # ``size``/``mtime_ns`` are part of the cache key so a replaced binary is re-hashed.
    del size, mtime_ns
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_digest(path: Path) -> None:
    expected = _read_sums().get(path.relative_to(OFFICECLI_ROOT).as_posix())
    if expected is None:
        logger.warning("No SHA-256 recorded for %s; skipping verification", path)
        return
    info = path.stat()
    actual = _digest(str(path), info.st_size, info.st_mtime_ns)
    if actual != expected:
        raise AppError(503, "officecli_unavailable", "文档引擎校验失败，请重新部署。")


def resolve_officecli() -> Path:
    settings = get_settings()
    configured = settings.officecli_path.strip()
    path = Path(configured).expanduser() if configured else _platform_binary()
    if path is None:
        raise AppError(
            503,
            "officecli_unavailable",
            "当前平台未内置 Office 文档引擎，请设置 OFFICECLI_PATH。",
        )
    if not path.is_file():
        raise AppError(503, "officecli_unavailable", "未找到 Office 文档引擎。")
    if os.name != "nt" and not os.access(path, os.X_OK):
        raise AppError(503, "officecli_unavailable", "Office 文档引擎不可执行。")
    if path.is_relative_to(OFFICECLI_ROOT):
        _verify_digest(path)
    return path


def _candidates() -> list[Path]:
    configured = get_settings().libreoffice_path.strip()
    if configured:
        return [Path(configured).expanduser()]
    found = shutil.which("soffice") or shutil.which("libreoffice")
    candidates = [Path(found)] if found else []
    if sys.platform == "win32":
        for variable in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
            base = os.environ.get(variable)
            if base:
                candidates.append(Path(base) / "LibreOffice" / "program" / "soffice.exe")
    elif sys.platform == "darwin":
        candidates.append(Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"))
    else:
        candidates.extend(
            [
                Path("/usr/bin/libreoffice"),
                Path("/usr/bin/soffice"),
                Path("/usr/lib/libreoffice/program/soffice.bin"),
                Path("/opt/libreoffice/program/soffice"),
            ]
        )
    return candidates


def resolve_libreoffice() -> Path:
    for candidate in _candidates():
        if candidate.is_file():
            return candidate
    raise AppError(
        503,
        "document_converter_unavailable",
        "未找到 LibreOffice，无法处理旧版 Office 文件。",
    )


def font_path() -> Path:
    if not FONT_PATH.is_file():
        raise AppError(503, "document_engine_error", "缺少中文字体文件。")
    return FONT_PATH


def document_engine_status() -> dict[str, str]:
    """Cheap status for readiness checks. Never launches a child process."""

    status: dict[str, str] = {}
    for name, resolver in (("officecli", resolve_officecli), ("libreoffice", resolve_libreoffice)):
        try:
            path = resolver()
        except AppError as exc:
            status[name] = exc.code
        else:
            status[name] = f"ok:{path.name}"
    return status
