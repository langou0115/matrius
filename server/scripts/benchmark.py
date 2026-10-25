"""Local single-worker HTTP benchmark; isolated migrated SQLite, no real accounts/services.

Run from server/: .venv/Scripts/python scripts/benchmark.py
"""

import argparse
import asyncio
import itertools
import json
import math
import os
import platform
import re
import secrets
import socket
import subprocess
import sys
import tempfile
import time
import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))


async def seed(users):
    from app.auth.security import hash_password, hash_token
    from app.db import SessionLocal, engine
    from app.models import AuthSession, Conversation, Message, User

    credentials = []
    password = secrets.token_urlsafe(20)
    password_hash = hash_password(password)
    async with SessionLocal() as db:
        for index in range(users):
            user_id, conversation_id = uuid.uuid4(), uuid.uuid4()
            token = secrets.token_urlsafe(32)
            db.add(User(id=user_id, username=f"bench_{index}", password_hash=password_hash))
            await db.flush()
            db.add(AuthSession(user_id=user_id, token_hash=hash_token(token),
                               expires_at=datetime.now(UTC) + timedelta(hours=2)))
            for item in range(10):
                db.add(Conversation(id=conversation_id if item == 0 else uuid.uuid4(),
                                    user_id=user_id, title=f"Benchmark conversation {item}"))
            await db.flush()
            for position in range(1, 21):
                db.add(Message(user_id=user_id, conversation_id=conversation_id, position=position,
                               role="user" if position % 2 else "assistant", content="benchmark " * 100))
            credentials.append((token, str(conversation_id)))
        await db.commit()
    await engine.dispose()
    return credentials, password


def summarize(samples, statuses, elapsed, **extra):
    ordered = sorted(samples)

    def percentile(p):
        return round(ordered[max(0, math.ceil(len(ordered) * p) - 1)], 2) if ordered else None

    success = sum(value for key, value in statuses.items() if str(key).startswith("2"))
    return {**extra, "requests": len(samples), "seconds": round(elapsed, 2),
            "successful_rps": round(success / elapsed, 2), "statuses": dict(statuses),
            "p50_ms": percentile(.5), "p95_ms": percentile(.95), "p99_ms": percentile(.99)}


async def exercise(client, credentials, scenario, concurrency, duration):
    counter = itertools.count()
    samples, statuses = [], Counter()
    started = time.perf_counter()

    async def worker():
        while time.perf_counter() - started < duration:
            index = next(counter)
            token, conversation_id = credentials[index % len(credentials)]
            # 80% reads (list/detail alternating), 20% realistic 1 KB message writes.
            write = scenario == "write" or (scenario == "mixed" and index % 5 == 4)
            path = f"/api/conversations/{conversation_id}/messages" if write else (
                "/api/conversations" if index % 2 == 0 else f"/api/conversations/{conversation_id}")
            tick = time.perf_counter()
            try:
                response = await client.request("POST" if write else "GET", path,
                                                headers={"Authorization": f"Bearer {token}"},
                                                **({"json": {"role": "user", "content": "benchmark " * 100}}
                                                   if write else {}))
                statuses[str(response.status_code)] += 1
            except httpx.HTTPError as exc:
                statuses[type(exc).__name__] += 1
            samples.append((time.perf_counter() - tick) * 1000)

    await asyncio.gather(*(worker() for _ in range(concurrency)))
    return summarize(samples, statuses, time.perf_counter() - started,
                     scenario=scenario, concurrency=concurrency)


async def special_cases(client, credentials, password):
    # Deliberate same-conversation collision; below the unmodified 120/min/user limit.
    token, conversation_id = credentials[0]
    headers = {"Authorization": f"Bearer {token}"}

    async def burst(method, path, payload):
        samples, statuses = [], Counter()
        start = time.perf_counter()

        async def request():
            tick = time.perf_counter()
            response = await client.request(method, path, headers=headers, json=payload)
            samples.append((time.perf_counter() - tick) * 1000)
            statuses[str(response.status_code)] += 1

        await asyncio.gather(*(request() for _ in range(25)))
        return summarize(samples, statuses, time.perf_counter() - start, concurrency=25)

    path = f"/api/conversations/{conversation_id}"
    result = await burst("POST", f"{path}/messages", {"role": "user", "content": "collision probe"})
    result["scenario"] = "same_conversation_burst"
    before = (await client.get(path, headers=headers)).json()["conversation"]["revision"]
    revision_result = await burst("PATCH", path, {"baseRevision": before, "title": "revision collision probe"})
    revision_result.update(scenario="same_revision_burst", initial_revision=before,
                           final_revision=(await client.get(path, headers=headers)).json()["conversation"]["revision"])
    tick = time.perf_counter()
    login_samples, health_samples, statuses = [], [], Counter()

    async def login(index):
        start = time.perf_counter()
        response = await client.post("/api/auth/login", json={"username": f"bench_{index}", "password": password})
        statuses[str(response.status_code)] += 1
        login_samples.append((time.perf_counter() - start) * 1000)

    done = asyncio.Event()

    async def health():
        while not done.is_set():
            start = time.perf_counter()
            await client.get("/api/health")
            health_samples.append((time.perf_counter() - start) * 1000)
            await asyncio.sleep(.02)

    monitor = asyncio.create_task(health())
    try:
        await asyncio.gather(*(login(index) for index in range(10)))
    finally:
        done.set()
        await monitor
    return [result, revision_result, summarize(login_samples, statuses, time.perf_counter() - tick,
                              scenario="login_burst", concurrency=10,
                              health_max_ms=round(max(health_samples), 2))]


async def run(args, directory, output):
    credentials, password = await seed(args.users)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    log_path = directory / "api.log"
    with log_path.open("w", encoding="utf-8") as log:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
            "--port", str(port), "--no-access-log", cwd=SERVER, stdout=log, stderr=log,
        )
        try:
            async with httpx.AsyncClient(base_url=f"http://127.0.0.1:{port}", timeout=60,
                                         limits=httpx.Limits(max_connections=250, max_keepalive_connections=250),
                                         trust_env=False) as client:
                for _ in range(150):
                    try:
                        response = await client.get("/api/health/ready")
                        if response.status_code == 200:
                            break
                    except httpx.HTTPError:
                        pass
                    await asyncio.sleep(.2)
                else:
                    raise RuntimeError(f"Benchmark API not ready: {log_path}")
                report = {"timestamp": datetime.now(UTC).isoformat(), "platform": platform.platform(),
                          "cpu": platform.processor(), "logical_cpus": os.cpu_count(),
                          "python": platform.python_version(), "users": args.users,
                          "seed_conversations": args.users * 10, "seed_messages": args.users * 20,
                          "duration_per_stage": args.seconds, "single_worker": True,
                          "rate_limits": "unchanged", "results": []}
                # Warm pools and serialization outside the measured interval.
                await exercise(client, credentials, "read", 5, 1)
                for scenario in ([] if args.special_only else ["read", "mixed", "write"]):
                    for concurrency in args.levels:
                        result = await exercise(client, credentials, scenario, concurrency, args.seconds)
                        report["results"].append(result)
                        output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                        print(json.dumps(result), flush=True)
                report["results"].extend(await special_cases(client, credentials, password))
                log_text = log_path.read_text(encoding="utf-8", errors="replace")
                report["server_error_counts"] = {
                    phrase: log_text.count(phrase) for phrase in
                    ["database is locked", "QueuePool limit", "UNIQUE constraint failed", "MissingGreenlet"]
                }
                report["server_errors"] = sorted(set(re.findall(
                    r"(?:sqlite3|sqlalchemy.exc)\.(?:OperationalError|IntegrityError|MissingGreenlet): ([^\n]+)",
                    log_text,
                )))
                output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                print(json.dumps(report["results"][-3:]), flush=True)
        finally:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=15)
            except TimeoutError:
                process.kill()
                await process.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--users", type=int, default=500)
    parser.add_argument("--levels", type=int, nargs="+", default=[1, 10, 25, 50, 100, 200])
    parser.add_argument("--special-only", action="store_true", help="Only run contention and login probes")
    parser.add_argument("--output", type=Path, default=SERVER.parent / "doc/benchmark-results.json")
    args = parser.parse_args()
    if args.seconds <= 0 or args.users < 25 or any(level < 1 or level > 200 for level in args.levels):
        parser.error("seconds > 0, users >= 25, levels between 1 and 200 required")
    data = SERVER / ".data"
    data.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="benchmark-", dir=data) as temporary:
        directory = Path(temporary).resolve()
        os.environ.update(DATABASE_URL=f"sqlite+aiosqlite:///{directory.as_posix()}/bench.db",
                          DATA_DIR=str(directory), LOG_LEVEL="INFO", APP_ENV="development",
                          INITIAL_ADMIN_USERNAME="", INITIAL_ADMIN_PASSWORD="")
        subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=SERVER, check=True)
        asyncio.run(run(args, directory, args.output.resolve()))


if __name__ == "__main__":
    main()
