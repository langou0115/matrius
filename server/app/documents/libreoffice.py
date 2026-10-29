"""Convert legacy Office files (doc/xls/ppt) with a headless LibreOffice.

The converted bytes are temporary: they feed text extraction or an editable
draft, while the original upload keeps its bytes, name and Library row.
"""

import tempfile
from dataclasses import dataclass
from pathlib import Path, PurePath

from app.config import get_settings
from app.documents.binaries import resolve_libreoffice
from app.documents.process import DOCUMENT_SEMAPHORE, run_process
from app.errors import AppError

LEGACY_FORMATS = {"doc": "docx", "xls": "xlsx", "ppt": "pptx"}
FILTERS = {
    "docx": "docx:MS Word 2007 XML",
    "xlsx": "xlsx:Calc MS Excel 2007 XML",
    "pptx": "pptx:Impress MS PowerPoint 2007 XML",
}
ZIP_MAGIC = b"PK\x03\x04"


@dataclass
class ConvertedOffice:
    filename: str
    data: bytes
    format: str


def is_legacy_office(filename: str) -> bool:
    return PurePath(filename).suffix.lower().lstrip(".") in LEGACY_FORMATS


def converted_filename(filename: str) -> str:
    path = PurePath(filename)
    return f"{path.stem}.{LEGACY_FORMATS[path.suffix.lower().lstrip('.')]}"


async def _convert_once(source: Path, output: Path, target: str, profile: Path) -> int:
    settings = get_settings()
    argv = [
        str(resolve_libreoffice()),
        "--headless",
        "--norestore",
        "--nolockcheck",
        "--nodefault",
        "--nofirststartwizard",
        "--invisible",
        f"-env:UserInstallation={profile.as_uri()}",
        "--convert-to",
        FILTERS[target],
        "--outdir",
        str(output),
        str(source),
    ]
    async with DOCUMENT_SEMAPHORE:
        result = await run_process(
            argv,
            timeout_seconds=settings.legacy_conversion_timeout_seconds,
            max_output_bytes=2 * 1024 * 1024,
            cwd=source.parent,
            # Keep the LibreOffice profile inside the throwaway directory.
            env={"HOME": str(profile.parent), "USERPROFILE": str(profile.parent)},
        )
    return result.returncode


async def convert_legacy_office(filename: str, data: bytes) -> ConvertedOffice:
    suffix = PurePath(filename).suffix.lower().lstrip(".")
    target = LEGACY_FORMATS.get(suffix)
    if target is None:
        raise AppError(415, "unsupported_file_type", "不支持的文件类型。")
    if not data:
        raise AppError(422, "document_conversion_failed", "文件为空，无法转换。")

    settings = get_settings()
    with tempfile.TemporaryDirectory(prefix="matrius-conv-") as directory:
        root = Path(directory)
        source = root / f"document.{suffix}"
        output = root / "out"
        profile = root / "profile"
        output.mkdir()
        profile.mkdir()
        source.write_bytes(data)

        code = await _convert_once(source, output, target, profile)
        if code == 81:
            # LibreOffice's profile/lock failure; a fresh profile usually succeeds.
            code = await _convert_once(source, output, target, profile)
        converted = output / f"document.{target}"
        if code != 0 or not converted.is_file():
            raise AppError(422, "document_conversion_failed", "旧版 Office 文件转换失败。")
        result = converted.read_bytes()

    if not 0 < len(result) <= settings.max_upload_bytes:
        raise AppError(422, "document_conversion_failed", "转换结果大小异常。")
    if not result.startswith(ZIP_MAGIC):
        raise AppError(422, "document_conversion_failed", "转换结果不是有效的 Office 文件。")
    return ConvertedOffice(filename=converted_filename(filename), data=result, format=target)


async def convert_if_legacy(filename: str, data: bytes) -> tuple[str, bytes, bool]:
    """Return ``(filename, bytes, converted)``; modern files pass through."""

    if not is_legacy_office(filename):
        return filename, data, False
    converted = await convert_legacy_office(filename, data)
    return converted.filename, converted.data, True
