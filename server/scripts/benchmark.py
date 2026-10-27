"""Local single-worker HTTP benchmark; isolated migrated SQLite, no real accounts/services.

Two modes:

- ``rotate`` (default): the original per-request account rotation. Good for aggregate capacity.
- ``pinned``: each virtual user is pinned to one account, with per-account pacing, per-account
  concurrency, fairness, a health probe and process-level CPU/RSS/WAL samples.

Run from server/: .venv/bin/python scripts/benchmark.py --mode pinned
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
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx

SERVER = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVER))

# Keep pinned pacing below the unchanged per-user limits: read 240/min, write 120/min.
RATE_CAPS = {"read": 3.5, "mixed": 3.0, "write": 1.5}
DEFAULT_TARGET_RATES = {"read": 200.0, "mixed": 150.0, "write": 100.0}
DEFAULT_MATRIX = "50:1,5,10;200:1,5;500:1"
MAX_PER_ACCOUNT_CONCURRENCY = 10
HEALTH_PROBE_INTERVAL = 0.1


@dataclass(frozen=True)
class Account:
    token: str
    conversations: tuple[str, ...]

    @property
    def conversation_id(self) -> str:
        return self.conversations[0]


async def seed(users):
    from app.auth.security import hash_password, hash_token
    from app.db import SessionLocal, engine
    from app.models import AuthSession, Conversation, Message, User

    credentials = []
    password = secrets.token_urlsafe(20)
    password_hash = hash_password(password)
    async with SessionLocal() as db:
        for index in range(users):
            user_id = uuid.uuid4()
            token = secrets.token_urlsafe(32)
            # Ten conversations per account let every pinned worker use a different one,
            # so this benchmark measures account-level contention rather than the known
            # same-conversation position race.
            conversation_ids = [uuid.uuid4() for _ in range(10)]
            db.add(User(id=user_id, username=f"bench_{index}", password_hash=password_hash))
            await db.flush()
            db.add(AuthSession(user_id=user_id, token_hash=hash_token(token),
                               expires_at=datetime.now(UTC) + timedelta(hours=2)))
            for item, conversation_id in enumerate(conversation_ids):
                db.add(Conversation(id=conversation_id, user_id=user_id,
                                    title=f"Benchmark conversation {item}"))
            await db.flush()
            for position in range(1, 21):
                db.add(Message(user_id=user_id, conversation_id=conversation_ids[0], position=position,
                               role="user" if position % 2 else "assistant", content="benchmark " * 100))
            credentials.append(Account(token=token,
                                       conversations=tuple(str(item) for item in conversation_ids)))
        await db.commit()
    await engine.dispose()
    return credentials, password


def percentile_of(ordered, p):
    return round(ordered[max(0, math.ceil(len(ordered) * p) - 1)], 2) if ordered else None


def summarize(samples, statuses, elapsed, **extra):
    ordered = sorted(samples)
    success = sum(value for key, value in statuses.items() if str(key).startswith("2"))
    return {
        **extra,
        "requests": len(samples),
        "seconds": round(elapsed, 2),
        "successful_rps": round(success / elapsed, 2) if elapsed else None,
        "errors": len(samples) - success,
        "statuses": dict(statuses),
        "p50_ms": percentile_of(ordered, .5),
        "p95_ms": percentile_of(ordered, .95),
        "p99_ms": percentile_of(ordered, .99),
    }


class Pacer:
    """One account-level request budget shared by its in-flight workers.

    Requests are spaced at ``1/rate`` per account. ``phase`` spreads accounts over one
    interval so they do not all fire on the same tick. When the server is slow the pacer
    naturally stops catching up, so the observed rate reflects backpressure rather than a
    synthetic burst.
    """

    def __init__(self, rate, phase=0.0):
        self.interval = 1.0 / rate if rate > 0 else 0.0
        self.next_at = time.perf_counter() + phase
        self._lock = asyncio.Lock()

    async def wait(self, deadline=None):
        if not self.interval:
            return
        async with self._lock:
            now = time.perf_counter()
            if self.next_at < now:
                self.next_at = now
            delay = self.next_at - now
            self.next_at += self.interval
        if delay > 0:
            if deadline is not None:
                # Do not sleep past the stage; workers that queued far ahead would otherwise
                # keep the measured interval open after the deadline.
                delay = min(delay, max(0.0, deadline - time.perf_counter()))
            if delay > 0:
                await asyncio.sleep(delay)


class ServerSampler:
    """Reads the API process from /proc; silently returns None on non-Linux hosts."""

    def __init__(self, pid, wal_path=None):
        self.pid = pid
        self.wal_path = Path(wal_path) if wal_path is not None else None
        clk_tck = getattr(os, "sysconf", None)
        self.clk_tck = clk_tck("SC_CLK_TCK") if clk_tck else 100

    def _cpu_seconds(self):
        try:
            text = Path(f"/proc/{self.pid}/stat").read_text(encoding="utf-8")
            fields = text.rpartition(")")[2].split()
            # After the comm field, utime and stime are fields 14 and 15 overall.
            return (int(fields[11]) + int(fields[12])) / self.clk_tck
        except (OSError, IndexError, ValueError):
            return None

    def _rss_bytes(self):
        try:
            text = Path(f"/proc/{self.pid}/status").read_text(encoding="utf-8")
        except OSError:
            return None
        match = re.search(r"^VmRSS:\s+(\d+)\s+kB", text, re.MULTILINE)
        return int(match.group(1)) * 1024 if match else None

    def _wal_bytes(self):
        if self.wal_path is None:
            return None
        try:
            return self.wal_path.stat().st_size
        except OSError:
            return None

    def sample(self):
        return {"cpu_seconds": self._cpu_seconds(), "rss_bytes": self._rss_bytes(),
                "wal_bytes": self._wal_bytes()}

    def delta(self, start, end, elapsed):
        cpu_percent = None
        if start["cpu_seconds"] is not None and end["cpu_seconds"] is not None and elapsed > 0:
            cpu_percent = round((end["cpu_seconds"] - start["cpu_seconds"]) / elapsed * 100, 1)
        return {
            "cpu_percent": cpu_percent,
            "rss_mib": round(end["rss_bytes"] / 1048576, 1) if end["rss_bytes"] is not None else None,
            "wal_mib": round(end["wal_bytes"] / 1048576, 2) if end["wal_bytes"] is not None else None,
        }


def parse_matrix(value):
    combos = []
    for part in value.split(";"):
        part = part.strip()
        if not part:
            continue
        accounts_raw, levels_raw = part.split(":")
        levels = [int(item) for item in levels_raw.split(",") if item.strip()]
        combos.append((int(accounts_raw), levels))
    return combos


def parse_target_rates(value):
    rates = dict(DEFAULT_TARGET_RATES)
    for part in value.split(","):
        name, raw = part.split("=")
        rates[name.strip()] = float(raw)
    return rates


async def exercise(client, credentials, scenario, concurrency, duration):
    counter = itertools.count()
    samples, statuses = [], Counter()
    started = time.perf_counter()

    async def worker():
        while time.perf_counter() - started < duration:
            index = next(counter)
            account = credentials[index % len(credentials)]
            # 80% reads (list/detail alternating), 20% realistic 1 KB message writes.
            write = scenario == "write" or (scenario == "mixed" and index % 5 == 4)
            path = f"/api/conversations/{account.conversation_id}/messages" if write else (
                "/api/conversations" if index % 2 == 0 else f"/api/conversations/{account.conversation_id}")
            tick = time.perf_counter()
            try:
                response = await client.request("POST" if write else "GET", path,
                                                headers={"Authorization": f"Bearer {account.token}"},
                                                **({"json": {"role": "user", "content": "benchmark " * 100}}
                                                   if write else {}))
                statuses[str(response.status_code)] += 1
            except httpx.HTTPError as exc:
                statuses[type(exc).__name__] += 1
            samples.append((time.perf_counter() - tick) * 1000)

    await asyncio.gather(*(worker() for _ in range(concurrency)))
    return summarize(samples, statuses, time.perf_counter() - started,
                     scenario=scenario, concurrency=concurrency)


async def pinned_exercise(client, accounts, scenario, per_account, duration, target_aggregate, base_url):
    """Account-pinned workers, paced per account, with fairness and health metrics."""
    accounts = list(accounts)
    account_count = len(accounts)
    per_account_rate = min(RATE_CAPS[scenario], target_aggregate / max(1, account_count))
    phase_span = (1.0 / per_account_rate) if per_account_rate else 0.0
    pacers = [Pacer(per_account_rate, phase=index / max(1, account_count) * phase_span)
              for index in range(account_count)]
    counters = [itertools.count() for _ in accounts]
    # Decide the read/write mix globally: at low per-account rates a per-worker counter
    # can finish the stage before ever reaching its write slot, turning "mixed" into
    # pure reads and inflating the result.
    mix_counter = itertools.count()
    samples = []
    statuses = Counter()
    per_account_samples = [[] for _ in accounts]
    per_account_statuses = [Counter() for _ in accounts]
    inflight = [0] * account_count
    max_inflight_per_account = [0] * account_count
    global_inflight = 0
    max_inflight_global = 0
    health_samples = []
    health_errors = 0
    stop_probe = asyncio.Event()

    async def probe():
        nonlocal health_errors
        async with httpx.AsyncClient(base_url=base_url, timeout=10, trust_env=False) as probe_client:
            while not stop_probe.is_set():
                tick = time.perf_counter()
                try:
                    response = await probe_client.get("/api/health")
                    if response.status_code == 200:
                        health_samples.append((time.perf_counter() - tick) * 1000)
                    else:
                        health_errors += 1
                except httpx.HTTPError:
                    health_errors += 1
                try:
                    await asyncio.wait_for(stop_probe.wait(), timeout=HEALTH_PROBE_INTERVAL)
                except TimeoutError:
                    pass

    async def worker(account_index, worker_index):
        nonlocal global_inflight, max_inflight_global
        account = accounts[account_index]
        conversation_id = account.conversations[worker_index % len(account.conversations)]
        headers = {"Authorization": f"Bearer {account.token}"}
        while time.perf_counter() < deadline:
            await pacers[account_index].wait(deadline)
            if time.perf_counter() >= deadline:
                break
            index = next(counters[account_index])
            mix_index = next(mix_counter)
            write = scenario == "write" or (scenario == "mixed" and mix_index % 5 == 4)
            path = f"/api/conversations/{conversation_id}/messages" if write else (
                "/api/conversations" if index % 2 == 0 else f"/api/conversations/{conversation_id}")
            inflight[account_index] += 1
            global_inflight += 1
            max_inflight_per_account[account_index] = max(
                max_inflight_per_account[account_index], inflight[account_index])
            max_inflight_global = max(max_inflight_global, global_inflight)
            tick = time.perf_counter()
            try:
                response = await client.request(
                    "POST" if write else "GET", path, headers=headers,
                    **({"json": {"role": "user", "content": "benchmark " * 100}} if write else {}),
                )
                statuses[str(response.status_code)] += 1
                per_account_statuses[account_index][str(response.status_code)] += 1
            except httpx.HTTPError as exc:
                key = type(exc).__name__
                statuses[key] += 1
                per_account_statuses[account_index][key] += 1
            finally:
                latency = (time.perf_counter() - tick) * 1000
                samples.append(latency)
                per_account_samples[account_index].append(latency)
                inflight[account_index] -= 1
                global_inflight -= 1

    probe_task = asyncio.create_task(probe())
    started = time.perf_counter()
    deadline = started + duration
    try:
        await asyncio.gather(*(worker(index, slot) for index in range(account_count)
                               for slot in range(per_account)))
    finally:
        stop_probe.set()
        await probe_task
    elapsed = time.perf_counter() - started

    account_p95 = []
    request_counts = []
    for account_samples in per_account_samples:
        request_counts.append(len(account_samples))
        if account_samples:
            ordered = sorted(account_samples)
            account_p95.append(percentile_of(ordered, .95))
    fairness = {}
    if account_p95:
        ordered_p95 = sorted(account_p95)
        ordered_counts = sorted(request_counts)
        median = ordered_p95[len(ordered_p95) // 2]
        fairness = {
            "accounts_measured": len(ordered_p95),
            "account_p95_min_ms": ordered_p95[0],
            "account_p95_median_ms": median,
            "account_p95_p95_ms": percentile_of(ordered_p95, .95),
            "account_p95_max_ms": ordered_p95[-1],
            "max_over_median": round(ordered_p95[-1] / median, 2) if median else None,
            "account_requests_min": ordered_counts[0],
            "account_requests_median": ordered_counts[len(ordered_counts) // 2],
            "account_requests_max": ordered_counts[-1],
        }
    health = {}
    if health_samples:
        ordered_health = sorted(health_samples)
        health = {
            "samples": len(ordered_health),
            "errors": health_errors,
            "p50_ms": percentile_of(ordered_health, .5),
            "p95_ms": percentile_of(ordered_health, .95),
            "max_ms": round(ordered_health[-1], 2),
        }
    result = summarize(
        samples, statuses, elapsed,
        scenario=scenario,
        accounts=account_count,
        per_account_concurrency=per_account,
        per_account_rate=round(per_account_rate, 3),
        aggregate_target_rps=target_aggregate,
        max_inflight_global=max_inflight_global,
        max_inflight_per_account=max(max_inflight_per_account) if max_inflight_per_account else 0,
        fairness=fairness,
        health_probe=health,
        account_errors={str(index): dict(counter) for index, counter in enumerate(per_account_statuses)
                        if any(not key.startswith("2") for key in counter)},
    )
    # A stage that cannot reach 95% of its target is a saturation point: its latency is
    # mostly queueing, so compare its throughput with the other stages, not its p50.
    result["target_met"] = result["successful_rps"] >= target_aggregate * 0.95
    result["saturation_ratio"] = (
        round(result["successful_rps"] / target_aggregate, 3) if target_aggregate else None
    )
    return result


async def isolation_probe(client, accounts):
    """A must never read or write B's conversation, even while all accounts are active."""
    statuses = Counter()
    probes = min(10, max(0, len(accounts) - 1))
    for index in range(probes):
        owner, other = accounts[index], accounts[index + 1]
        headers = {"Authorization": f"Bearer {owner.token}"}
        target = other.conversation_id
        response = await client.get(f"/api/conversations/{target}", headers=headers)
        statuses[f"read_other_{response.status_code}"] += 1
        response = await client.patch(f"/api/conversations/{target}", headers=headers,
                                      json={"baseRevision": 1, "title": "isolation probe"})
        statuses[f"write_other_{response.status_code}"] += 1
    return {"pairs": probes, "results": dict(statuses)}


async def special_cases(client, credentials, password):
    # Deliberate same-conversation collision; below the unmodified 120/min/user limit.
    account = credentials[0]
    conversation_id = account.conversation_id
    headers = {"Authorization": f"Bearer {account.token}"}

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
                              health_max_ms=percentile_of(sorted(health_samples), 1))]


async def run(args, directory, output):
    credentials, password = await seed(args.accounts)
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    log_path = directory / "api.log"
    base_url = f"http://127.0.0.1:{port}"
    with log_path.open("w", encoding="utf-8") as log:
        process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1",
            "--port", str(port), "--no-access-log", cwd=SERVER, stdout=log, stderr=log,
        )
        sampler = ServerSampler(process.pid, directory / "bench.db-wal")
        # The load generator shares the host; its CPU tells whether a flat stage is
        # server-side or client-side saturation.
        client_sampler = ServerSampler(os.getpid())
        try:
            async with httpx.AsyncClient(base_url=base_url, timeout=60,
                                         limits=httpx.Limits(max_connections=1024, max_keepalive_connections=1024),
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
                report = {
                    "timestamp": datetime.now(UTC).isoformat(),
                    "platform": platform.platform(),
                    "cpu": platform.processor(),
                    "logical_cpus": os.cpu_count(),
                    "python": platform.python_version(),
                    "mode": args.mode,
                    "accounts_seeded": args.accounts,
                    "seed_conversations": args.accounts * 10,
                    "seed_messages": args.accounts * 20,
                    "duration_per_stage": args.seconds,
                    "single_worker": True,
                    "db_pool": (
                        "sqlalchemy AsyncAdaptedQueuePool "
                        f"pool_size={os.environ.get('DB_POOL_SIZE', 'auto:2 (sqlite)')} "
                        f"max_overflow={os.environ.get('DB_MAX_OVERFLOW', 'auto:0 (sqlite)')}"
                    ),
                    "results": [],
                }
                if args.mode == "rotate":
                    report["rate_limits"] = "unchanged"
                    # Warm pools and serialization outside the measured interval.
                    await exercise(client, credentials, "read", 5, 1)
                    for scenario in ([] if args.special_only else args.scenarios):
                        for concurrency in args.levels:
                            client_start = client_sampler.sample()
                            result = await exercise(client, credentials, scenario, concurrency, args.seconds)
                            result["client"] = client_sampler.delta(
                                client_start, client_sampler.sample(), result["seconds"])
                            report["results"].append(result)
                            output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                            print(json.dumps(result), flush=True)
                    if not args.special_only and not args.no_special:
                        report["results"].extend(await special_cases(client, credentials, password))
                else:
                    report["rate_limits"] = (
                        "unchanged; per-account pacing stays below 240 read/min and 120 write/min"
                    )
                    report["target_rates"] = args.target_rates
                    report["matrix"] = args.matrix
                    await pinned_exercise(client, credentials[:min(10, len(credentials))],
                                          "read", 1, 1.0, 5.0, base_url)
                    for accounts_count, levels in parse_matrix(args.matrix):
                        if not 1 <= accounts_count <= len(credentials):
                            raise ValueError(f"matrix account count {accounts_count} is outside 1..{len(credentials)}")
                        subset = credentials[:accounts_count]
                        for per_account in levels:
                            for scenario in args.scenarios:
                                start = sampler.sample()
                                client_start = client_sampler.sample()
                                result = await pinned_exercise(
                                    client, subset, scenario, per_account, args.seconds,
                                    args.target_rates[scenario], base_url)
                                end = sampler.sample()
                                result["server"] = sampler.delta(start, end, result["seconds"])
                                result["client"] = client_sampler.delta(
                                    client_start, client_sampler.sample(), result["seconds"])
                                report["results"].append(result)
                                output.write_text(json.dumps(report, indent=2), encoding="utf-8")
                                print(json.dumps(result), flush=True)
                    report["isolation_probe"] = await isolation_probe(
                        client, credentials[:min(11, len(credentials))])
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
    parser.add_argument("--mode", choices=["rotate", "pinned"], default="rotate")
    parser.add_argument("--seconds", type=float, default=8)
    parser.add_argument("--accounts", "--users", dest="accounts", type=int, default=500)
    parser.add_argument("--levels", type=int, nargs="+", default=[1, 10, 25, 50, 100, 200])
    parser.add_argument("--matrix", default=DEFAULT_MATRIX,
                        help="pinned mode: 'accounts:k1,k2;accounts:k1' (default: %(default)s)")
    parser.add_argument("--target-rates", default="read=200,mixed=150,write=100",
                        help="pinned mode aggregate requests/s, split across accounts")
    parser.add_argument("--scenarios", nargs="+", choices=["read", "mixed", "write"],
                        default=["read", "mixed", "write"],
                        help="Scenarios to run in each stage (default: all three)")
    parser.add_argument("--special-only", action="store_true", help="Only run contention and login probes")
    parser.add_argument("--no-special", action="store_true", help="Skip contention and login probes")
    parser.add_argument("--output", type=Path, default=SERVER.parent / "doc/benchmark-results.json")
    args = parser.parse_args()
    args.target_rates = parse_target_rates(args.target_rates)
    if args.seconds <= 0 or args.accounts < 10:
        parser.error("seconds > 0 and accounts >= 10 required")
    if args.mode == "rotate" and any(level < 1 or level > 200 for level in args.levels):
        parser.error("rotate levels must be between 1 and 200")
    if args.mode == "pinned":
        for _, levels in parse_matrix(args.matrix):
            if any(level < 1 or level > MAX_PER_ACCOUNT_CONCURRENCY for level in levels):
                parser.error(f"pinned per-account concurrency must be between 1 and {MAX_PER_ACCOUNT_CONCURRENCY}")
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
