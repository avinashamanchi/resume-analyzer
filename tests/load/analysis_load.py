#!/usr/bin/env python3
from __future__ import annotations

import argparse
import asyncio
from collections import Counter
from dataclasses import dataclass
import hashlib
import hmac
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
import time
from typing import Awaitable, Callable, Mapping, Sequence
from urllib.parse import urlsplit
from uuid import UUID, uuid4

import httpx


_EMAIL = re.compile(r"(?i)(?:^|\s)[^\s@]+@[^\s@]+\.[^\s@]+(?:$|\s)")
_PHONE = re.compile(r"(?<!\w)(?:\+?\d[\d(). -]{7,}\d)(?!\w)")
_ABSOLUTE_PATH = re.compile(r"(?:^|\s)(?:/[^\s]+|[A-Za-z]:\\[^\s]+)")
_HEX_DIGEST = re.compile(r"[0-9a-f]{64}")
_ALLOWED_PHASES = frozenset({"identity", "sustained", "burst", "ai", "pdf"})
_ALLOWED_ROUTES = frozenset(
    {
        "identity_canary_v2",
        "analyses_v2",
        "capacity_snapshot_v2",
        "entitlements_sync_v2",
        "installations_v2",
    }
)
_EXPECTED_STATUSES = frozenset({200, 201, 204, 429, 503})
_CAPACITY_LIMITS = {
    "provider_slots": 48,
    "pdf_slots": 8,
    "local_pdf_slots": 2,
    "local_declared_pdf_bytes": 20 * 1024 * 1024,
}


class LoadContractError(ValueError):
    pass


@dataclass(frozen=True, slots=True)
class LoadObservation:
    phase: str
    route: str
    status: int
    latency_ms: float
    principal_index: int
    analysis_id: str | None
    concurrency: int
    cross_subject_leak: bool = False

    def __post_init__(self) -> None:
        if self.phase not in _ALLOWED_PHASES or self.route not in _ALLOWED_ROUTES:
            raise LoadContractError("load observation uses an unknown bounded class")
        if isinstance(self.status, bool) or not isinstance(self.status, int) or not 100 <= self.status <= 599:
            raise LoadContractError("load observation status is invalid")
        if not isinstance(self.latency_ms, (int, float)) or isinstance(self.latency_ms, bool):
            raise LoadContractError("load observation latency is invalid")
        if not math.isfinite(float(self.latency_ms)) or not 0 <= float(self.latency_ms) <= 120_000:
            raise LoadContractError("load observation latency is invalid")
        if isinstance(self.principal_index, bool) or not isinstance(self.principal_index, int) or self.principal_index < 0:
            raise LoadContractError("load observation principal index is invalid")
        if isinstance(self.concurrency, bool) or not isinstance(self.concurrency, int) or not 0 <= self.concurrency <= 1_000:
            raise LoadContractError("load observation concurrency is invalid")
        if self.analysis_id is not None and (
            not isinstance(self.analysis_id, str)
            or not 1 <= len(self.analysis_id) <= 160
            or any(ord(character) < 33 or ord(character) == 127 for character in self.analysis_id)
        ):
            raise LoadContractError("load observation analysis id is invalid")
        if type(self.cross_subject_leak) is not bool:
            raise LoadContractError("load observation leak marker is invalid")


@dataclass(frozen=True, slots=True)
class LoadConfig:
    origin: str
    allowed_origins: tuple[str, ...]
    token_file: Path
    marker_file: Path
    principal_count: int
    identity_rate: float
    sustained_rate: float
    sustained_seconds: float
    burst_rate: float
    burst_width_seconds: float
    burst_period_seconds: float
    burst_duration_seconds: float
    fixture: Path
    output: Path
    max_connections: int = 100
    timeout_seconds: float = 15.0

    def __post_init__(self) -> None:
        if (
            not isinstance(self.origin, str)
            or not isinstance(self.allowed_origins, tuple)
            or not self.allowed_origins
            or any(not isinstance(value, str) for value in self.allowed_origins)
        ):
            raise LoadContractError("load target configuration is invalid")
        if (
            isinstance(self.principal_count, bool)
            or not isinstance(self.principal_count, int)
            or not 1 <= self.principal_count <= 25_000
        ):
            raise LoadContractError("principal count is invalid")
        for value in (
            self.identity_rate,
            self.sustained_rate,
            self.sustained_seconds,
            self.burst_rate,
            self.burst_width_seconds,
            self.burst_period_seconds,
            self.burst_duration_seconds,
            self.timeout_seconds,
        ):
            if (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
                or value <= 0
            ):
                raise LoadContractError("load rates and durations must be finite and positive")
        if self.burst_width_seconds > self.burst_period_seconds:
            raise LoadContractError("burst width cannot exceed its period")
        if self.identity_rate > 1_000 or self.sustained_rate > 100 or self.burst_rate > 100:
            raise LoadContractError("configured request rate exceeds the safety bound")
        if self.sustained_seconds > 7_200 or self.burst_duration_seconds > 3_600:
            raise LoadContractError("configured load duration exceeds the safety bound")
        if (
            isinstance(self.max_connections, bool)
            or not isinstance(self.max_connections, int)
            or not 1 <= self.max_connections <= 200
        ):
            raise LoadContractError("connection pool size is invalid")


def validate_target(
    origin: str,
    *,
    allowed_origins: Sequence[str],
    expected_marker_digest: str,
    observed_marker_digest: str,
) -> str:
    if not isinstance(origin, str) or origin not in allowed_origins:
        raise LoadContractError("target is not in the explicit staging allowlist")
    parsed = urlsplit(origin)
    try:
        port = parsed.port
    except ValueError:
        raise LoadContractError("target origin is invalid") from None
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path
        or parsed.query
        or parsed.fragment
        or port == 0
        or origin.rstrip("/") != origin
    ):
        raise LoadContractError("target must be a canonical HTTPS origin")
    if (
        not isinstance(expected_marker_digest, str)
        or not isinstance(observed_marker_digest, str)
        or _HEX_DIGEST.fullmatch(expected_marker_digest) is None
        or _HEX_DIGEST.fullmatch(observed_marker_digest) is None
        or not hmac.compare_digest(expected_marker_digest, observed_marker_digest)
    ):
        raise LoadContractError("server did not prove the one-run staging marker")
    return origin


def validate_fixture(repository_root: Path, fixture: Path) -> str:
    root = repository_root.resolve(strict=True)
    fixture_root = (root / "tests" / "fixtures").resolve(strict=True)
    candidate = fixture.resolve(strict=True)
    try:
        candidate.relative_to(fixture_root)
    except ValueError:
        raise LoadContractError("load fixture must be below tests/fixtures") from None
    if not candidate.is_file() or candidate.stat().st_size > 128 * 1024:
        raise LoadContractError("load fixture is not a bounded regular file")
    try:
        text = candidate.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        raise LoadContractError("load fixture is not strict UTF-8 text") from None
    if (
        not text.strip()
        or "\x00" in text
        or _EMAIL.search(text) is not None
        or _PHONE.search(text) is not None
        or _ABSOLUTE_PATH.search(text) is not None
    ):
        raise LoadContractError("load fixture appears to contain personal or path data")
    return text


def _percentile(values: Sequence[float], percentile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(float(value) for value in values)
    index = max(0, math.ceil(percentile * len(ordered)) - 1)
    return round(ordered[index], 3)


def _capacity(value: Mapping[str, int], *, final: bool) -> dict[str, int]:
    if not isinstance(value, Mapping) or set(value) != set(_CAPACITY_LIMITS):
        raise LoadContractError("capacity snapshot does not match the fixed schema")
    result: dict[str, int] = {}
    for name, limit in _CAPACITY_LIMITS.items():
        candidate = value[name]
        maximum = limit if final else max(limit, candidate if isinstance(candidate, int) else limit)
        if isinstance(candidate, bool) or not isinstance(candidate, int) or not 0 <= candidate <= maximum + 1_000:
            raise LoadContractError("capacity snapshot contains an invalid value")
        result[name] = candidate
    return result


def build_summary(
    observations: Sequence[LoadObservation],
    *,
    principal_count: int,
    capacity_maxima: Mapping[str, int],
    final_capacity: Mapping[str, int],
) -> dict[str, object]:
    if isinstance(principal_count, bool) or not isinstance(principal_count, int) or not 1 <= principal_count <= 25_000:
        raise LoadContractError("principal count is invalid")
    if len(observations) > 1_000_000:
        raise LoadContractError("load observation set is not bounded")
    if any(observation.principal_index >= principal_count for observation in observations):
        raise LoadContractError("load observation references an unknown principal")

    identities = {
        observation.principal_index
        for observation in observations
        if observation.phase == "identity" and observation.status == 204
    }
    analysis_ids = [
        observation.analysis_id
        for observation in observations
        if observation.analysis_id is not None
    ]
    duplicate_ids = len(analysis_ids) - len(set(analysis_ids))
    route_counts = dict(sorted(Counter(item.route for item in observations).items()))
    status_counts = dict(
        sorted((str(key), value) for key, value in Counter(item.status for item in observations).items())
    )
    phase_counts = dict(sorted(Counter(item.phase for item in observations).items()))
    deterministic_latencies = [
        float(item.latency_ms)
        for item in observations
        if item.phase in {"sustained", "burst"} and item.route == "analyses_v2"
    ]
    ai_latencies = [
        float(item.latency_ms)
        for item in observations
        if item.phase == "ai" and item.route == "analyses_v2"
    ]
    unexpected_statuses = sum(item.status not in _EXPECTED_STATUSES for item in observations)
    phase_success_percent: dict[str, float] = {}
    for phase in ("sustained", "burst", "ai", "pdf"):
        phase_items = [
            item
            for item in observations
            if item.phase == phase and item.route == "analyses_v2"
        ]
        if phase_items:
            accepted = sum(item.status == 200 for item in phase_items)
            phase_success_percent[phase] = round(100 * accepted / len(phase_items), 3)
    return {
        "schemaVersion": 1,
        "principalCount": principal_count,
        "identityPrincipalsSeen": len(identities),
        "observationCount": len(observations),
        "phaseCounts": phase_counts,
        "routeCounts": route_counts,
        "statusCounts": status_counts,
        "unexpectedStatusCount": unexpected_statuses,
        "duplicateAnalysisIds": duplicate_ids,
        "crossSubjectLeakCount": sum(item.cross_subject_leak for item in observations),
        "phaseSuccessPercent": phase_success_percent,
        "peakConcurrency": max((item.concurrency for item in observations), default=0),
        "deterministicLatencyMs": {
            "p50": _percentile(deterministic_latencies, 0.50),
            "p95": _percentile(deterministic_latencies, 0.95),
            "p99": _percentile(deterministic_latencies, 0.99),
        },
        "aiLatencyMs": {
            "p50": _percentile(ai_latencies, 0.50),
            "p95": _percentile(ai_latencies, 0.95),
            "p99": _percentile(ai_latencies, 0.99),
        },
        "capacityMaxima": _capacity(capacity_maxima, final=False),
        "finalCapacity": _capacity(final_capacity, final=True),
    }


def release_gate_failures(summary: Mapping[str, object]) -> list[str]:
    failures: list[str] = []
    principal_count = summary.get("principalCount")
    identity_count = summary.get("identityPrincipalsSeen")
    if identity_count != principal_count:
        failures.append("not every principal passed the identity canary")
    if summary.get("unexpectedStatusCount") != 0:
        failures.append("unexpected response statuses were observed")
    if summary.get("duplicateAnalysisIds") != 0:
        failures.append("duplicate analysis dispatch receipts were observed")
    if summary.get("crossSubjectLeakCount") != 0:
        failures.append("cross-subject response leakage was observed")
    phase_success = summary.get("phaseSuccessPercent")
    if not isinstance(phase_success, Mapping):
        failures.append("phase success evidence is malformed")
    else:
        for phase in ("sustained", "burst", "ai", "pdf"):
            value = phase_success.get(phase)
            if value is not None and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or value < 99
            ):
                failures.append(f"{phase} success was below 99 percent")

    deterministic = summary.get("deterministicLatencyMs")
    if isinstance(deterministic, Mapping):
        p95 = deterministic.get("p95")
        if p95 is not None and (not isinstance(p95, (int, float)) or p95 >= 1_000):
            failures.append("deterministic p95 was not below one second")
    else:
        failures.append("deterministic latency evidence is malformed")
    ai = summary.get("aiLatencyMs")
    if isinstance(ai, Mapping):
        p95 = ai.get("p95")
        if p95 is not None and (not isinstance(p95, (int, float)) or p95 >= 10_000):
            failures.append("AI p95 was not below ten seconds")
    else:
        failures.append("AI latency evidence is malformed")

    maxima = summary.get("capacityMaxima")
    if not isinstance(maxima, Mapping):
        failures.append("capacity maxima evidence is malformed")
    else:
        for name, limit in _CAPACITY_LIMITS.items():
            value = maxima.get(name)
            if not isinstance(value, int) or isinstance(value, bool) or value > limit:
                failures.append(f"capacity maximum exceeded for {name}")
    final = summary.get("finalCapacity")
    if not isinstance(final, Mapping) or any(final.get(name) != 0 for name in _CAPACITY_LIMITS):
        failures.append("final capacity leases were not zero")
    return failures


def _read_private_file(path: Path, *, maximum_bytes: int) -> bytes:
    candidate = path.expanduser()
    try:
        metadata = candidate.lstat()
    except OSError:
        raise LoadContractError("private load material is unavailable") from None
    if (
        not stat.S_ISREG(metadata.st_mode)
        or metadata.st_mode & 0o777 != 0o600
        or metadata.st_size <= 0
        or metadata.st_size > maximum_bytes
    ):
        raise LoadContractError("private load material must be a bounded mode-0600 file")
    flags = os.O_RDONLY
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(candidate, flags)
        try:
            observed = os.fstat(descriptor)
            if (
                not stat.S_ISREG(observed.st_mode)
                or observed.st_mode & 0o777 != 0o600
                or (observed.st_dev, observed.st_ino) != (metadata.st_dev, metadata.st_ino)
            ):
                raise LoadContractError("private load material changed while opening")
            content = os.read(descriptor, maximum_bytes + 1)
        finally:
            os.close(descriptor)
    except OSError:
        raise LoadContractError("private load material could not be read safely") from None
    if not content or len(content) > maximum_bytes:
        raise LoadContractError("private load material is invalid")
    return content


def _load_tokens(path: Path, expected_count: int) -> tuple[str, ...]:
    raw = _read_private_file(path, maximum_bytes=32 * 1024 * 1024)
    try:
        payload = json.loads(raw)
    except (UnicodeError, json.JSONDecodeError):
        raise LoadContractError("token file is not strict JSON") from None
    if not isinstance(payload, dict) or set(payload) != {"schemaVersion", "principalCount", "tokens"}:
        raise LoadContractError("token file schema is invalid")
    tokens = payload.get("tokens")
    if (
        payload.get("schemaVersion") != 1
        or payload.get("principalCount") != expected_count
        or not isinstance(tokens, list)
        or len(tokens) != expected_count
    ):
        raise LoadContractError("token file principal count is invalid")
    normalized: list[str] = []
    for token in tokens:
        if (
            not isinstance(token, str)
            or not 1 <= len(token) <= 1_024
            or any(ord(character) < 33 or ord(character) == 127 for character in token)
        ):
            raise LoadContractError("token file contains an invalid token")
        normalized.append(token)
    if len(set(normalized)) != expected_count:
        raise LoadContractError("token file principals are not unique")
    return tuple(normalized)


def _load_marker(path: Path) -> tuple[str, str]:
    raw = _read_private_file(path, maximum_bytes=258)
    if raw.endswith(b"\n"):
        raw = raw[:-1]
    try:
        marker = raw.decode("utf-8")
    except UnicodeError:
        raise LoadContractError("staging marker is not UTF-8") from None
    if (
        not 32 <= len(marker) <= 256
        or any(ord(character) < 33 or ord(character) == 127 for character in marker)
    ):
        raise LoadContractError("staging marker is invalid")
    return marker, hashlib.sha256(marker.encode("utf-8")).hexdigest()


def _write_summary(path: Path, summary: Mapping[str, object]) -> None:
    rendered = json.dumps(
        summary,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=True,
        allow_nan=False,
    ).encode("ascii")
    if len(rendered) > 128 * 1024:
        raise LoadContractError("load summary is not bounded")
    output = path.expanduser().resolve(strict=False)
    output.parent.resolve(strict=True)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL
    if hasattr(os, "O_NOFOLLOW"):
        flags |= os.O_NOFOLLOW
    try:
        descriptor = os.open(output, flags, 0o600)
        try:
            os.write(descriptor, rendered)
            os.fsync(descriptor)
        finally:
            os.close(descriptor)
    except OSError:
        raise LoadContractError("load summary could not be written safely") from None
    if os.stat(output, follow_symlinks=False).st_mode & 0o777 != 0o600:
        raise LoadContractError("load summary permissions are not mode 0600")


@dataclass(slots=True)
class _Concurrency:
    active: int = 0

    def begin(self) -> int:
        self.active += 1
        return self.active

    def end(self) -> None:
        self.active = max(0, self.active - 1)


async def _paced(
    count: int,
    rate: float,
    send: Callable[[int], Awaitable[LoadObservation]],
    *,
    maximum_pending: int,
) -> list[LoadObservation]:
    if count <= 0:
        return []
    loop = asyncio.get_running_loop()
    started = loop.time()
    pending: set[asyncio.Task[LoadObservation]] = set()
    results: list[LoadObservation] = []
    for index in range(count):
        target = started + index / rate
        delay = target - loop.time()
        if delay > 0:
            await asyncio.sleep(delay)
        pending.add(asyncio.create_task(send(index)))
        if len(pending) >= maximum_pending:
            completed, pending = await asyncio.wait(
                pending,
                return_when=asyncio.FIRST_COMPLETED,
            )
            results.extend(task.result() for task in completed)
    if pending:
        results.extend(await asyncio.gather(*pending))
    return results


async def run_load(
    config: LoadConfig,
    *,
    transport: httpx.AsyncBaseTransport | None = None,
) -> dict[str, object]:
    if not isinstance(config, LoadConfig):
        raise LoadContractError("load configuration is invalid")
    repository_root = Path(__file__).resolve().parents[2]
    fixture_text = validate_fixture(repository_root, config.fixture)
    tokens = _load_tokens(config.token_file, config.principal_count)
    marker, expected_marker_digest = _load_marker(config.marker_file)
    concurrency = _Concurrency()
    observations: list[LoadObservation] = []
    capacity_maxima = {name: 0 for name in _CAPACITY_LIMITS}
    final_capacity = {name: limit + 1 for name, limit in _CAPACITY_LIMITS.items()}
    common_headers = {"Origin": config.origin}
    limits = httpx.Limits(
        max_connections=config.max_connections,
        max_keepalive_connections=config.max_connections,
    )
    timeout = httpx.Timeout(config.timeout_seconds)

    async with httpx.AsyncClient(
        base_url=config.origin,
        headers=common_headers,
        limits=limits,
        timeout=timeout,
        follow_redirects=False,
        transport=transport,
    ) as client:
        async def identity(principal_index: int) -> LoadObservation:
            token = tokens[principal_index]
            active = concurrency.begin()
            started = time.perf_counter()
            status = 599
            observed_digest = ""
            try:
                response = await client.get(
                    "/v2/load/identity-canary",
                    headers={
                        "Authorization": f"Installation {token}",
                        "X-Resume-Load-Marker": marker,
                    },
                )
                status = response.status_code
                observed_digest = response.headers.get("X-Resume-AI-Staging", "")
            except httpx.HTTPError:
                pass
            finally:
                concurrency.end()
            latency = min(120_000, max(0, (time.perf_counter() - started) * 1_000))
            if status == 204:
                validate_target(
                    config.origin,
                    allowed_origins=config.allowed_origins,
                    expected_marker_digest=expected_marker_digest,
                    observed_marker_digest=observed_digest,
                )
            return LoadObservation(
                "identity",
                "identity_canary_v2",
                status,
                latency,
                principal_index,
                None,
                active,
            )

        handshake = await identity(0)
        if handshake.status != 204:
            raise LoadContractError("staging identity handshake failed")

        async def capacity() -> dict[str, int]:
            try:
                response = await client.get(
                    "/v2/load/capacity-snapshot",
                    headers={
                        "Authorization": f"Installation {tokens[0]}",
                        "X-Resume-Load-Marker": marker,
                    },
                )
                validate_target(
                    config.origin,
                    allowed_origins=config.allowed_origins,
                    expected_marker_digest=expected_marker_digest,
                    observed_marker_digest=response.headers.get("X-Resume-AI-Staging", ""),
                )
                payload = response.json()
                if response.status_code != 200 or not isinstance(payload, dict):
                    raise LoadContractError("capacity endpoint failed")
                if set(payload) != {"schemaVersion", *_CAPACITY_LIMITS} or payload.get("schemaVersion") != 1:
                    raise LoadContractError("capacity endpoint schema is invalid")
                return _capacity(
                    {name: payload[name] for name in _CAPACITY_LIMITS},
                    final=False,
                )
            except (httpx.HTTPError, json.JSONDecodeError, KeyError, LoadContractError, ValueError, TypeError):
                return {name: limit + 1 for name, limit in _CAPACITY_LIMITS.items()}

        initial_capacity = await capacity()
        for name in capacity_maxima:
            capacity_maxima[name] = max(capacity_maxima[name], initial_capacity[name])
        stop_polling = asyncio.Event()

        async def poll_capacity() -> None:
            while not stop_polling.is_set():
                snapshot = await capacity()
                for name in capacity_maxima:
                    capacity_maxima[name] = max(capacity_maxima[name], snapshot[name])
                try:
                    await asyncio.wait_for(stop_polling.wait(), timeout=0.05)
                except TimeoutError:
                    pass

        poller = asyncio.create_task(poll_capacity())
        try:
            observations.extend(
                await _paced(
                    config.principal_count,
                    config.identity_rate,
                    identity,
                    maximum_pending=config.max_connections,
                )
            )

            run_id = uuid4()

            async def analysis(phase: str, sequence: int) -> LoadObservation:
                principal_index = sequence % config.principal_count
                token = tokens[principal_index]
                request_id = str(UUID(int=(run_id.int + sequence + 1) % (1 << 128)))
                active = concurrency.begin()
                started = time.perf_counter()
                status = 599
                analysis_id: str | None = None
                leak = False
                try:
                    response = await client.post(
                        "/v2/analyses",
                        data={
                            "resume_text": fixture_text,
                            "consent_version": "2026-08-04.v1",
                            "request_id": request_id,
                        },
                        headers={
                            "Authorization": f"Installation {token}",
                            "X-Resume-Source": "reviewed_text",
                            "X-Resume-AI": "not_requested",
                            "X-Resume-Request-ID": request_id,
                        },
                    )
                    status = response.status_code
                    body = response.content[:65_537]
                    leak = (
                        len(response.content) > 65_536
                        or token.encode("utf-8") in body
                        or b"rai_installation_" in body
                        or b"rai_account_" in body
                        or b"inst_" in body
                        or b"acct_" in body
                    )
                    if status == 200 and not leak:
                        try:
                            payload = response.json()
                            candidate = payload.get("analysisId") if isinstance(payload, dict) else None
                            if isinstance(candidate, str):
                                parsed_id = UUID(candidate)
                                if str(parsed_id) == candidate:
                                    analysis_id = candidate
                        except (ValueError, json.JSONDecodeError):
                            pass
                        if analysis_id is None:
                            status = 598
                except httpx.HTTPError:
                    pass
                finally:
                    concurrency.end()
                latency = min(120_000, max(0, (time.perf_counter() - started) * 1_000))
                return LoadObservation(
                    phase,
                    "analyses_v2",
                    status,
                    latency,
                    principal_index,
                    analysis_id,
                    active,
                    leak,
                )

            sustained_count = max(1, math.ceil(config.sustained_rate * config.sustained_seconds))
            observations.extend(
                await _paced(
                    sustained_count,
                    config.sustained_rate,
                    lambda index: analysis("sustained", index),
                    maximum_pending=config.max_connections,
                )
            )

            burst_windows = max(1, math.ceil(config.burst_duration_seconds / config.burst_period_seconds))
            requests_per_window = max(1, math.ceil(config.burst_rate * config.burst_width_seconds))
            burst_started = asyncio.get_running_loop().time()
            sequence = sustained_count
            for window in range(burst_windows):
                delay = burst_started + window * config.burst_period_seconds - asyncio.get_running_loop().time()
                if delay > 0:
                    await asyncio.sleep(delay)
                base = sequence
                observations.extend(
                    await _paced(
                        requests_per_window,
                        config.burst_rate,
                        lambda index, base=base: analysis("burst", base + index),
                        maximum_pending=config.max_connections,
                    )
                )
                sequence += requests_per_window
        finally:
            stop_polling.set()
            await poller

        final_capacity = await capacity()
        for name in capacity_maxima:
            capacity_maxima[name] = max(capacity_maxima[name], final_capacity[name])

    summary = build_summary(
        observations,
        principal_count=config.principal_count,
        capacity_maxima=capacity_maxima,
        final_capacity=final_capacity,
    )
    _write_summary(config.output, summary)
    return summary


def _arguments() -> LoadConfig:
    parser = argparse.ArgumentParser(description="Run the privacy-safe Resume.AI staging load gate.")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--allow-origin", action="append", required=True)
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--staging-marker-file", required=True, type=Path)
    parser.add_argument("--principals", required=True, type=int)
    parser.add_argument("--identity-rate", type=float, default=100)
    parser.add_argument("--rate", required=True, type=float)
    parser.add_argument("--seconds", required=True, type=float)
    parser.add_argument("--burst-rate", required=True, type=float)
    parser.add_argument("--burst-width-seconds", required=True, type=float)
    parser.add_argument("--burst-period-seconds", required=True, type=float)
    parser.add_argument("--burst-duration-seconds", required=True, type=float)
    parser.add_argument("--fixture", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-connections", type=int, default=100)
    values = parser.parse_args()
    return LoadConfig(
        origin=values.origin,
        allowed_origins=tuple(values.allow_origin),
        token_file=values.token_file,
        marker_file=values.staging_marker_file,
        principal_count=values.principals,
        identity_rate=values.identity_rate,
        sustained_rate=values.rate,
        sustained_seconds=values.seconds,
        burst_rate=values.burst_rate,
        burst_width_seconds=values.burst_width_seconds,
        burst_period_seconds=values.burst_period_seconds,
        burst_duration_seconds=values.burst_duration_seconds,
        fixture=values.fixture,
        output=values.output,
        max_connections=values.max_connections,
    )


def main() -> int:
    try:
        summary = asyncio.run(run_load(_arguments()))
        failures = release_gate_failures(summary)
    except (LoadContractError, OSError, RuntimeError, ValueError):
        print("Resume.AI staging load gate failed.", file=sys.stderr)
        return 1
    if failures:
        print(f"Resume.AI staging load gate failed with {len(failures)} bounded checks.", file=sys.stderr)
        return 1
    print("Resume.AI staging load gate passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
