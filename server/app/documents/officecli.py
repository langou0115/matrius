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
# The vendored engine is version-pinned and hash-verified. Never let its
# background updater replace the binary between document operations.
_ENGINE_ENV = {
    "OFFICECLI_NO_AUTO_RESIDENT": "1",
    "OFFICECLI_SKIP_UPDATE": "1",
    "OFFICECLI_NO_AUTO_INSTALL": "1",
}


def _decode(result: ProcessResult) -> str:
    return result.stdout.decode("utf-8", errors="replace").strip()


def _failure(action: str, envelope: object) -> AppError:
    # Return bounded engine diagnostics, never the echoed command/item or document payload.
    details = []
    if isinstance(envelope, dict):
        data = envelope.get("data")
        results = data.get("results", []) if isinstance(data, dict) else []
        for item in results:
            if not isinstance(item, dict) or item.get("success") is not False:
                continue
            index = item.get("index")
            code = item.get("code")
            if not isinstance(code, str):
                code = ""
            label = f"第 {index + 1} 条命令" if isinstance(index, int) else "命令"
            if code.replace("_", "").isalnum():
                label += f"（{code[:80]}）"
            # These hints contain no document contents or server filesystem paths.
            hint = {
                "duplicate_name": "名称已存在；新建 Excel 已有 Sheet1，请 inspect 后修改已有表或使用其他名称。",
                "not_found": "目标不存在，请先 inspect 确认路径。",
                "invalid_path": "文档路径不合法，请先 inspect 确认路径。",
            }.get(code, "请用 help/inspect 核对本工具支持的元素、属性和目标路径，缩小命令批次后重试。")
            details.append(f"{label}：{hint}")
            if len(details) == 3:
                break
    message = " ".join(details) or "请用 help/inspect 核对元素、属性和路径后重试。"
    return AppError(422, "invalid_document_operation", f"{action}失败。{message}")


def _check(result: ProcessResult, action: str) -> str:
    if result.returncode == -1 and not result.stdout and not result.stderr:
        raise AppError(504, "officecli_timeout", "文档处理超时，请重试。")
    if result.truncated:
        raise AppError(422, "document_too_large", "文档输出过大，请缩小操作范围。")
    text = _decode(result)
    try:
        envelope = json.loads(text)
    except ValueError:
        envelope = None
    if result.returncode != 0:
        raise _failure(action, envelope)
    if not result.stdout:
        raise AppError(502, "document_engine_error", "文档引擎未返回结果。")
    if isinstance(envelope, dict) and envelope.get("success") is False:
        raise _failure(action, envelope)
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
