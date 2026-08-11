from __future__ import annotations

from dataclasses import replace
import hashlib

from server.app import create_app
from tests.test_routes import (
    FakeAiGateway,
    FakeLeases,
    FakePdfParser,
    FakeRateLimiter,
    FakeTokens,
    Harness,
    authorization,
    settings,
)


MARKER = "one-run-staging-marker-value-that-is-not-committed"


class LoadAdmission:
    def capacity_snapshot(self) -> dict[str, int]:
        return {
            "provider_slots": 3,
            "pdf_slots": 1,
            "local_pdf_slots": 1,
            "local_declared_pdf_bytes": 2_048,
        }


def _harness() -> Harness:
    return Harness(
        pdf_parser=FakePdfParser(),
        ai_gateway=FakeAiGateway(),
        installation_tokens=FakeTokens(),
        rate_limiter=FakeRateLimiter(),
        leases=FakeLeases(),
    )


def _headers(marker: str = MARKER) -> dict[str, str]:
    return authorization() | {
        "Origin": "https://resume.example.com",
        "X-Resume-Load-Marker": marker,
    }


def test_load_routes_are_absent_without_an_explicit_one_run_marker():
    client = create_app(settings(), _harness().registry()).test_client()

    identity = client.get("/v2/load/identity-canary", headers=_headers())
    capacity = client.get("/v2/load/capacity-snapshot", headers=_headers())

    assert identity.status_code == capacity.status_code == 404
    assert "X-Resume-AI-Staging" not in identity.headers


def test_marker_proof_and_identity_canary_require_exact_marker_and_origin():
    configured = settings(load_test_staging_marker=MARKER)
    client = create_app(configured, _harness().registry()).test_client()

    wrong_marker = client.get(
        "/v2/load/identity-canary",
        headers=_headers("wrong-marker-value-that-is-long-enough-000"),
    )
    wrong_origin = client.get(
        "/v2/load/identity-canary",
        headers=_headers() | {"Origin": "https://other.example.com"},
    )
    accepted = client.get("/v2/load/identity-canary", headers=_headers())

    assert wrong_marker.status_code == wrong_origin.status_code == 404
    assert accepted.status_code == 204
    assert accepted.headers["X-Resume-AI-Staging"] == hashlib.sha256(
        MARKER.encode("utf-8")
    ).hexdigest()
    assert MARKER not in str(accepted.headers)


def test_protected_capacity_snapshot_has_only_fixed_content_free_gauges():
    configured = settings(load_test_staging_marker=MARKER)
    services = replace(_harness().registry(), admission=LoadAdmission())
    client = create_app(configured, services).test_client()

    response = client.get("/v2/load/capacity-snapshot", headers=_headers())

    assert response.status_code == 200
    assert response.headers["X-Resume-AI-Staging"] == hashlib.sha256(
        MARKER.encode("utf-8")
    ).hexdigest()
    assert response.get_json() == {
        "schemaVersion": 1,
        "provider_slots": 3,
        "pdf_slots": 1,
        "local_pdf_slots": 1,
        "local_declared_pdf_bytes": 2_048,
    }
