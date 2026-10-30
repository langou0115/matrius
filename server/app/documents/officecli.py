"""Thin, validated wrapper around the vendored OfficeCLI binary."""

import asyncio
import json
import tempfile
from pathlib import Path

from app.config import get_settings
from app.documents.binaries import resolve_officecli
from app.documents.process import DOCUMENT_SEMAPHORE, ProcessResult, run_process
from app.documents.schemas import OfficeCommand
from app.errors import AppError

MAX_TEXT_CHARS = 30_000

# Every call works on a throwaway temp file, so the resident cache buys nothing.
# Worse, under uvloop the resident inherits the child's stdout/stderr pipes and keeps
# them open after `create` exits, so run_process never sees EOF and hits its timeout.
_ENGINE_ENV = {"OFFICECLI_NO_AUTO_RESIDENT": "1"}


def _decode(result: ProcessResult) -> str:
    return result.stdout.decode("utf-8", errors="replace").strip()


def _check(result: ProcessResult, action: str) -> str:
    if result.returncode == -1 and not result.stdout and not result.stderr:
        raise AppError(504, "officecli_timeout", "文档处理超时，请重试。")
    if result.truncated:
        raise AppError(422, "document_too_large", "文档输出过大，请缩小操作范围。")
    if result.returncode != 0:
        raise AppError(422, "invalid_document_operation", f"{action}失败，请检查文档操作后重试。")
    if not result.stdout:
        raise AppError(502, "document_engine_error", "文档引擎未返回结果。")
    text = _decode(result)
    if text.startswith("{"):
        try:
            envelope = json.loads(text)
        except ValueError:
            envelope = None
        # Exit code 2 means "ran with caveats"; `success: false` still signals a failure.
        if isinstance(envelope, dict) and envelope.get("success") is False:
            raise AppError(422, "invalid_document_operation", f"{action}失败，请检查文档操作后重试。")
    return text


def truncate(text: str) -> str:
    return text if len(text) <= MAX_TEXT_CHARS else text[:MAX_TEXT_CHARS] + "\n…（输出已截断）"


async def _run(argv: list[str], *, stdin: bytes | None = None, cwd: Path | None = None) -> ProcessResult:
    settings = get_settings()
    async with DOCUMENT_SEMAPHORE:
        return await run_process(
            argv,
            stdin_bytes=stdin,
            timeout_seconds=settings.officecli_timeout_seconds,
            max_output_bytes=settings.officecli_max_output_bytes,
            cwd=cwd,
            env=_ENGINE_ENV,
        )


async def office_help(fmt: str, element: str | None = None) -> str:
    argv = [str(resolve_officecli()), "help", fmt]
    if element:
        argv.append(element)
    argv.append("--json")
    return truncate(_check(await _run(argv), "读取帮助"))


async def office_view_text(filename: str, data: bytes) -> str:
    with tempfile.TemporaryDirectory(prefix="matrius-doc-") as directory:
        path = Path(directory) / f"document{Path(filename).suffix.lower()}"
        path.write_bytes(data)
        result = await _run([str(resolve_officecli()), "view", str(path), "text"], cwd=Path(directory))
    return truncate(_check(result, "读取文档"))


async def office_inspect(fmt: str, data: bytes, path: str = "/") -> str:
    suffix = f".{fmt}" if not fmt.startswith(".") else fmt
    with tempfile.TemporaryDirectory(prefix="matrius-doc-") as directory:
        target = Path(directory) / f"document{suffix}"
        target.write_bytes(data)
        result = await _run(
            [
                str(resolve_officecli()),
                "get",
                str(target),
                path,
                "--depth",
                "3",
                "--json",
            ],
            cwd=Path(directory),
        )
    return truncate(_check(result, "查看文档结构"))


async def office_create(fmt: str) -> bytes:
    with tempfile.TemporaryDirectory(prefix="matrius-doc-") as directory:
        target = Path(directory) / f"document.{fmt}"
        result = await _run(
            [
                str(resolve_officecli()),
                "create",
                str(target),
                "--type",
                fmt,
                "--locale",
                "zh-CN",
                "--json",
            ],
            cwd=Path(directory),
        )
        _check(result, "创建文档")
        return await _read_verified(fmt, target, directory)


async def office_edit(fmt: str, data: bytes, commands: list[OfficeCommand]) -> bytes:
    with tempfile.TemporaryDirectory(prefix="matrius-doc-") as directory:
        target = Path(directory) / f"document.{fmt}"
        target.write_bytes(data)
        # batch reads a bare JSON array from stdin (not an object wrapper).
        payload = json.dumps(
            [command.model_dump(mode="json") for command in commands],
            ensure_ascii=False,
        ).encode("utf-8")
        result = await _run(
            [
                str(resolve_officecli()),
                "batch",
                str(target),
                "--stop-on-error",
                "--json",
            ],
            stdin=payload,
            cwd=Path(directory),
        )
        _check(result, "编辑文档")
        return await _read_verified(fmt, target, directory)


def _read_bytes(target: Path) -> bytes:
    if not target.is_file() or target.stat().st_size == 0:
        raise AppError(502, "document_engine_error", "文档引擎没有生成文件。")
    return target.read_bytes()


async def _read_verified(fmt: str, target: Path, directory: str) -> bytes:
    verify = await _run(
        [
            str(resolve_officecli()),
            "get",
            str(target),
            "/",
            "--depth",
            "0",
            "--json",
        ],
        cwd=Path(directory),
    )
    _check(verify, "校验文档")
    # Auto-resident is disabled, so this is normally a no-op. Keep it as a backstop:
    # if an engine build ignores the switch, `close` flushes and releases the handle
    # before TemporaryDirectory cleanup (which fails on Windows otherwise).
    await _run([str(resolve_officecli()), "close", str(target), "--json"], cwd=Path(directory))
    return await asyncio.to_thread(_read_bytes, target)
