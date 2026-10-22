#!/usr/bin/env python3
"""Print reachable PyPI indexes, fastest first.

Candidates come from PYPI_INDEX_CANDIDATES (comma- or space-separated) and
default to the official index plus the Tsinghua mirror. Pass --all to print
the configured candidates without probing.
"""

from __future__ import annotations

import http.client
import os
import ssl
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urlsplit

DEFAULT_CANDIDATES = (
    "https://pypi.org/simple",
    "https://pypi.tuna.tsinghua.edu.cn/simple",
)


def configured_candidates() -> list[str]:
    configured = os.environ.get("PYPI_INDEX_CANDIDATES", "")
    raw = configured.replace(",", " ").split() if configured else list(DEFAULT_CANDIDATES)
    candidates: list[str] = []
    for item in raw:
        url = item.rstrip("/")
        if url and url not in candidates:
            candidates.append(url)
    return candidates


def probe_once(url: str, timeout: float) -> float | None:
    # Download part of a real package page instead of only measuring the
    # handshake: a nearby CDN edge can answer quickly while the actual
    # package payload is still slow. A wall-clock deadline keeps a trickling
    # connection from outliving the socket timeout.
    target = urlsplit(f"{url}/fastapi/")
    path = target.path or "/"
    if target.query:
        path = f"{path}?{target.query}"

    if target.scheme == "https":
        connection: http.client.HTTPConnection = http.client.HTTPSConnection(
            target.hostname,
            target.port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
    elif target.scheme == "http":
        connection = http.client.HTTPConnection(target.hostname, target.port, timeout=timeout)
    else:
        return None

    deadline = time.monotonic() + timeout
    started = time.monotonic()
    try:
        connection.request(
            "GET",
            path,
            headers={
                "User-Agent": "matrius-index-probe/1.0",
                "Accept-Encoding": "identity",
            },
        )
        response = connection.getresponse()
        if response.status != 200:
            return None

        received = 0
        while received < 65536:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            if connection.sock is not None:
                connection.sock.settimeout(remaining)
            chunk = response.read(8192)
            if not chunk:
                break
            received += len(chunk)
        if received == 0:
            return None
        return time.monotonic() - started
    except (OSError, http.client.HTTPException, ValueError):
        return None
    finally:
        connection.close()


def probe(url: str) -> float | None:
    try:
        timeout = float(os.environ.get("PYPI_PROBE_TIMEOUT", "6"))
    except ValueError:
        timeout = 6.0

    # A single fast sample can be a burst on an otherwise slow route, so
    # compare the slowest successful sample of three. A dropped sample does
    # not disqualify the index: mirror edges occasionally reset a connection,
    # and aborting the whole build for one blip is worse than one slow request.
    samples: list[float] = []
    for _ in range(3):
        sample = probe_once(url, timeout)
        if sample is not None:
            samples.append(sample)
    return max(samples) if samples else None


def main() -> int:
    urls = configured_candidates()
    if not urls:
        print("No PyPI indexes configured.", file=sys.stderr)
        return 1

    # --all prints the configured candidates without probing. The install
    # script uses it to retry an install when a transient failure makes every
    # probe look unreachable.
    if "--all" in sys.argv[1:]:
        for url in urls:
            print(url)
        return 0

    with ThreadPoolExecutor(max_workers=len(urls)) as executor:
        latencies = list(executor.map(probe, urls))

    reachable = sorted(
        (latency, url)
        for url, latency in zip(urls, latencies, strict=True)
        if latency is not None
    )
    if not reachable:
        print("No PyPI index is reachable.", file=sys.stderr)
        return 1

    for _, url in reachable:
        print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
