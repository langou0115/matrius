"""Bounded child-process execution for OfficeCLI and LibreOffice.

Rules enforced here:

* no shell, the argv list is passed as-is;
* only a whitelist of environment variables reaches the child;
* stdout/stderr are capped while streaming, so a runaway process cannot exhaust memory;
* a timeout kills the whole process group on POSIX and the process on Windows.
"""

import asyncio
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path

# OfficeCLI/LibreOffice are memory hungry; two concurrent conversions is the
# documented ceiling for a single-container deployment.
DOCUMENT_SEMAPHORE = asyncio.Semaphore(2)

_ENV_KEYS = {
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "SYSTEMROOT",
    "WINDIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
}


@dataclass
class ProcessResult:
    returncode: int
    stdout: bytes
    stderr: bytes
    truncated: bool = False


def child_env(extra: dict[str, str] | None = None) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if key.upper() in _ENV_KEYS}
    env.setdefault("LANG", "C.UTF-8")
    env.setdefault("LC_ALL", "C.UTF-8")
    if extra:
        env.update(extra)
    return env


def _kill(process: asyncio.subprocess.Process) -> None:
    if process.returncode is not None:
        return
    try:
        if sys.platform == "win32":
            process.kill()
        else:
            os.killpg(os.getpgid(process.pid), signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        try:
            process.kill()
        except ProcessLookupError:
            pass


async def run_process(
    argv: list[str],
    *,
    stdin_bytes: bytes | None = None,
    timeout_seconds: int = 60,
    max_output_bytes: int = 16 * 1024 * 1024,
    cwd: Path | None = None,
    env: dict[str, str] | None = None,
) -> ProcessResult:
    kwargs: dict[str, object] = {}
    if sys.platform == "win32":
        import subprocess

        kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(
            subprocess, "CREATE_NO_WINDOW", 0
        )
    else:
        kwargs["start_new_session"] = True

    process = await asyncio.create_subprocess_exec(
        *argv,
        stdin=asyncio.subprocess.PIPE if stdin_bytes is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=str(cwd) if cwd else None,
        env=child_env(env),
        **kwargs,
    )
    state = {"size": 0, "truncated": False}

    async def read(stream: asyncio.StreamReader | None) -> bytes:
        if stream is None:
            return b""
        chunks: list[bytes] = []
        while True:
            chunk = await stream.read(64 * 1024)
            if not chunk:
                return b"".join(chunks)
            remaining = max_output_bytes - state["size"]
            if remaining <= 0:
                state["truncated"] = True
                return b"".join(chunks)
            if len(chunk) > remaining:
                state["truncated"] = True
                chunks.append(chunk[:remaining])
                state["size"] += remaining
                return b"".join(chunks)
            state["size"] += len(chunk)
            chunks.append(chunk)

    async def feed() -> None:
        if stdin_bytes is None or process.stdin is None:
            return
        try:
            process.stdin.write(stdin_bytes)
            await process.stdin.drain()
        except (BrokenPipeError, ConnectionResetError):
            # The child may reject the input and exit before reading all of it.
            pass
        finally:
            process.stdin.close()

    async def collect() -> tuple[bytes, bytes]:
        writer = asyncio.create_task(feed())
        out, err = await asyncio.gather(read(process.stdout), read(process.stderr))
        await writer
        await process.wait()
        return out, err

    task = asyncio.create_task(collect())
    try:
        stdout, stderr = await asyncio.wait_for(task, timeout_seconds)
    except TimeoutError:
        _kill(process)
        task.cancel()
        try:
            await task
        except (asyncio.CancelledError, ProcessLookupError):
            pass
        await process.wait()
        return ProcessResult(-1, b"", b"", truncated=state["truncated"])
    except BaseException:
        _kill(process)
        task.cancel()
        raise
    return ProcessResult(process.returncode or 0, stdout, stderr, truncated=state["truncated"])
