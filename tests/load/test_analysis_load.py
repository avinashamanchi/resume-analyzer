from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from uuid import uuid4

import httpx
import pytest

from tests.load.analysis_load import (
    LoadConfig,
    LoadContractError,
    LoadObservation,
    build_summary,
    release_gate_failures,
    run_load,
    validate_fixture,
    validate_target,
)
from tests.load.generate_installation_tokens import write_installation_tokens


ROOT = Path(__file__).resolve().parents[2]


def test_target_requires_https_exact_allowlist_and_server_marker_proof():
    origin = "https://resume-ai-staging.example.com"

    assert validate_target(
        origin,
        allowed_origins=(origin,),
        expected_marker_digest="a" * 64,
        observed_marker_digest="a" * 64,
    ) == origin
    for values in (
        {"origin": "http://resume-ai-staging.example.com"},
        {"allowed_origins": ("https://other.example.com",)},
        {"observed_marker_digest": "b" * 64},
    ):
        arguments = {
            "origin": origin,
            "allowed_origins": (origin,),
            "expected_marker_digest": "a" * 64,
            "observed_marker_digest": "a" * 64,
        } | values
        with pytest.raises(LoadContractError):
            validate_target(**arguments)


def test_fixture_gate_accepts_only_non_personal_fixture_text_below_tests_fixtures():
    safe = ROOT / "tests" / "fixtures" / "load" / "resume-safe.txt"
    assert "Backend engineer" in validate_fixture(ROOT, safe)

    with pytest.raises(LoadContractError):
        validate_fixture(ROOT, ROOT / "README.md")
    with pytest.raises(LoadContractError):
        validate_fixture(ROOT, ROOT / "tests" / "fixtures" / "resumes" / "strong.txt")


def test_token_generator_writes_unique_content_to_mode_0600_without_key_material(tmp_path: Path):
    destination = tmp_path / "installation-tokens.json"
    key = b"one-run-staging-signing-key-32-bytes-minimum"

    write_installation_tokens(destination, count=4, signing_key=key, repository_root=ROOT)

    assert os.stat(destination).st_mode & 0o777 == 0o600
    payload = json.loads(destination.read_text())
    assert payload["schemaVersion"] == 1
    assert payload["principalCount"] == 4
    assert len(payload["tokens"]) == len(set(payload["tokens"])) == 4
    assert key.decode() not in destination.read_text()


def test_summary_is_bounded_content_free_and_requires_every_identity():
    observations = [
        LoadObservation("identity", "identity_canary_v2", 204, 4.0, index, None, 2)
        for index in range(3)
    ] + [
        LoadObservation("sustained", "analyses_v2", 200, 80.0, 0, "analysis-a", 3),
        LoadObservation("sustained", "analyses_v2", 200, 120.0, 1, "analysis-b", 4),
        LoadObservation("burst", "analyses_v2", 200, 20.0, 2, "analysis-c", 5),
    ]

    summary = build_summary(
        observations,
        principal_count=3,
        capacity_maxima={
            "provider_slots": 2,
            "pdf_slots": 0,
            "local_pdf_slots": 0,
            "local_declared_pdf_bytes": 0,
        },
        final_capacity={
            "provider_slots": 0,
            "pdf_slots": 0,
            "local_pdf_slots": 0,
            "local_declared_pdf_bytes": 0,
        },
    )

    assert summary["identityPrincipalsSeen"] == 3
    assert summary["routeCounts"] == {"analyses_v2": 3, "identity_canary_v2": 3}
    assert summary["peakConcurrency"] == 5
    assert summary["duplicateAnalysisIds"] == 0
    assert summary["finalCapacity"]["provider_slots"] == 0
    assert "token" not in json.dumps(summary).casefold()
    assert release_gate_failures(summary) == []


def test_gate_fails_missing_principals_duplicate_dispatch_and_nonzero_leases():
    observations = [
        LoadObservation("identity", "identity_canary_v2", 204, 1.0, 0, None, 1),
        LoadObservation("sustained", "analyses_v2", 200, 1.0, 0, "same", 1),
        LoadObservation("sustained", "analyses_v2", 200, 1.0, 1, "same", 1),
    ]
    summary = build_summary(
        observations,
        principal_count=2,
        capacity_maxima={
            "provider_slots": 49,
            "pdf_slots": 0,
            "local_pdf_slots": 0,
            "local_declared_pdf_bytes": 0,
        },
        final_capacity={
            "provider_slots": 1,
            "pdf_slots": 0,
            "local_pdf_slots": 0,
            "local_declared_pdf_bytes": 0,
        },
    )

    failures = release_gate_failures(summary)
    assert any("principal" in failure for failure in failures)
    assert any("duplicate" in failure for failure in failures)
    assert any("capacity" in failure for failure in failures)


def test_async_runner_proves_marker_pages_all_principals_and_records_no_content(
    tmp_path: Path,
):
    token_file = tmp_path / "tokens.json"
    token_file.write_text(json.dumps({
        "schemaVersion": 1,
        "principalCount": 2,
        "tokens": ["staging-token-a", "staging-token-b"],
    }))
    os.chmod(token_file, 0o600)
    marker = "unit-staging-marker-value-that-is-at-least-32-bytes"
    marker_file = tmp_path / "marker.txt"
    marker_file.write_text(marker)
    os.chmod(marker_file, 0o600)
    output = tmp_path / "result.json"
    analysis_ids = iter(str(uuid4()) for _ in range(20))

    async def handler(request: httpx.Request) -> httpx.Response:
        assert request.headers["Origin"] == "https://staging.example.com"
        staging_headers = {
            "X-Resume-AI-Staging": __import__("hashlib").sha256(marker.encode()).hexdigest()
        }
        if request.url.path == "/v2/load/identity-canary":
            assert request.headers["X-Resume-Load-Marker"] == marker
            return httpx.Response(204, headers=staging_headers)
        if request.url.path == "/v2/load/capacity-snapshot":
            assert request.headers["X-Resume-Load-Marker"] == marker
            return httpx.Response(200, headers=staging_headers, json={
                "schemaVersion": 1,
                "provider_slots": 0,
                "pdf_slots": 0,
                "local_pdf_slots": 0,
                "local_declared_pdf_bytes": 0,
            })
        assert request.url.path == "/v2/analyses"
        assert "X-Resume-Load-Marker" not in request.headers
        return httpx.Response(200, headers=staging_headers, json={
            "schemaVersion": 2,
            "analysisId": next(analysis_ids),
            "sourceType": "reviewed_text",
            "score": {},
            "ai": {"status": "not_requested", "feedback": None, "allowance": None},
        })

    config = LoadConfig(
        origin="https://staging.example.com",
        allowed_origins=("https://staging.example.com",),
        token_file=token_file,
        marker_file=marker_file,
        principal_count=2,
        identity_rate=1_000,
        sustained_rate=100,
        sustained_seconds=0.01,
        burst_rate=100,
        burst_width_seconds=0.01,
        burst_period_seconds=0.01,
        burst_duration_seconds=0.01,
        fixture=ROOT / "tests" / "fixtures" / "load" / "resume-safe.txt",
        output=output,
        max_connections=4,
    )

    summary = asyncio.run(run_load(config, transport=httpx.MockTransport(handler)))

    assert summary["identityPrincipalsSeen"] == 2
    assert summary["phaseCounts"]["sustained"] >= 1
    assert summary["phaseCounts"]["burst"] >= 1
    assert release_gate_failures(summary) == []
    rendered = output.read_text()
    assert "staging-token" not in rendered
    assert marker not in rendered
    assert os.stat(output).st_mode & 0o777 == 0o600
