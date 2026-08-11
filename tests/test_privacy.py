from __future__ import annotations

from dataclasses import replace
import json
from uuid import UUID

import pytest

from server.errors import ErrorCode
from server.app import create_app
from server.privacy import coarse_ip_key, public_error
from server.telemetry import Telemetry
from scripts.verify_no_sensitive_retention import verify_artifacts
from tests.test_routes import (
    FakeAiGateway,
    FakeLeases,
    FakePdfParser,
    FakeRateLimiter,
    FakeTokens,
    Harness,
    settings,
    submit_text,
)


REQUEST_ID = UUID("6ef499c6-a2c7-4314-b88b-af45c53da38a")


@pytest.mark.parametrize(
    "raw_address, expected",
    [
        ("203.0.113.97", "203.0.113.0/24"),
        ("2001:db8:abcd:12:ffff::1", "2001:db8:abcd:12::/64"),
        (None, "unknown"),
        ("not-an-ip token=private", "unknown"),
    ],
)
def test_ip_rate_key_is_coarse_and_never_retains_invalid_input(
    raw_address: str | None, expected: str
):
    result = coarse_ip_key(raw_address)

    assert result == expected
    assert "token" not in result


@pytest.mark.parametrize("code", list(ErrorCode))
def test_public_errors_are_versioned_bounded_and_content_free(code: ErrorCode):
    error = public_error(code, REQUEST_ID, retryable=False)
    serialized = error.model_dump(mode="json")

    assert serialized["schemaVersion"] == 1
    assert serialized["code"] == code.value
    assert serialized["requestId"] == str(REQUEST_ID)
    assert 0 < len(serialized["message"]) <= 240
    rendered = str(serialized)
    for private_fragment in (
        "/Users/avi",
        "resume_text",
        "job_description",
        "filename",
        "signed-installation-token",
        "203.0.113.97",
        "llama-3.3-70b-versatile",
        "provider exploded",
    ):
        assert private_fragment not in rendered


def test_public_error_retryability_is_explicit_not_inferred_from_private_state():
    transient = public_error(ErrorCode.AI_TIMEOUT, REQUEST_ID, retryable=True)
    permanent = public_error(ErrorCode.AI_TIMEOUT, REQUEST_ID, retryable=False)

    assert transient.retryable is True
    assert permanent.retryable is False


def test_sensitive_fixture_markers_never_reach_telemetry_sink():
    records: list[dict[str, object]] = []

    class Sink:
        def emit(self, record: dict[str, object]) -> None:
            records.append(record)

    harness = Harness(
        pdf_parser=FakePdfParser(),
        ai_gateway=FakeAiGateway(),
        installation_tokens=FakeTokens(),
        rate_limiter=FakeRateLimiter(),
        leases=FakeLeases(),
    )
    services = replace(harness.registry(), telemetry=Telemetry(sink=Sink()))
    client = create_app(settings(), services).test_client()

    response = submit_text(client, "PRIVATE_MARKER_7f82")

    assert response.status_code == 200
    rendered = json.dumps(records, sort_keys=True)
    assert records
    assert "PRIVATE_MARKER_7f82" not in rendered
    assert "resume_text" not in rendered
    assert "installation_id" not in rendered


def test_external_log_metric_and_load_artifact_scan_is_content_aware(tmp_path):
    safe = tmp_path / "safe.jsonl"
    safe.write_text(
        '{"name":"http_requests","labels":{"route":"analyses_v2","status_class":"2xx"}}\n'
        '{"principalCount":25000,"identityPrincipalsSeen":25000}\n'
    )
    unsafe = tmp_path / "unsafe.log"
    unsafe.write_text(
        'PRIVATE_MARKER_7f82 resume_text=/Users/private/resume.pdf '
        'installation_id=signed-installation-token\n'
    )

    assert verify_artifacts((safe,), forbidden_values=()) == ()
    findings = verify_artifacts((unsafe,), forbidden_values=("signed-installation-token",))
    assert "sensitive-field-name" in findings
    assert "fixture-marker" in findings
    assert "absolute-path" in findings
    assert "forbidden-value" in findings
