from __future__ import annotations

import io
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any
from uuid import UUID

import pytest

from server.admission import AdmissionDecision, AdmissionLease
from server.account_tokens import IssuedAccountToken
from server.app import ServiceRegistry, create_app
from server.apple_identity import AppleIdentity
from server.config import Settings
from server.contracts import AnalysisResponseV2
from server.errors import ErrorCode, PublicServiceError
from server.installations import (
    InstallationClaims,
    InvalidInstallationToken,
    IssuedInstallationV2,
)
from server.pdf_parser import ExtractedResume
from server.plans import AllowanceSnapshot
from server.plans import PlanSnapshot
from server.rate_limit import RateLimitDecision
from server.revenuecat import RevenueCatEvent
from server.scoring import score_resume
from server.telemetry import Telemetry


INSTALLATION_ID = UUID("4de0bc7f-50b2-4e9b-9e36-617d3899cdb6")
REQUEST_ID = UUID("6ef499c6-a2c7-4314-b88b-af45c53da38a")
TOKEN = "signed-installation-token"
REVENUECAT_ID = "rai_installation_" + "a" * 43
RESET = datetime(2026, 9, 1, tzinfo=UTC)
CONSENT_VERSION = "2026-08-04.v1"


def settings() -> Settings:
    return Settings(
        app_env="testing",
        debug=False,
        groq_api_key="",
        groq_model="llama-3.3-70b-versatile",
        installation_signing_key="",
        redis_url="",
        allowed_web_origins=("https://resume.example.com",),
        provider_deadline_seconds=8.0,
        request_deadline_seconds=10.0,
    )


class FakeTokens:
    def __init__(self) -> None:
        self.v2_issues = 0

    def issue_v2(self) -> IssuedInstallationV2:
        self.v2_issues += 1
        return IssuedInstallationV2(TOKEN, REVENUECAT_ID)

    def verify(self, token: str) -> InstallationClaims:
        if token != TOKEN:
            raise InvalidInstallationToken()
        return InstallationClaims(INSTALLATION_ID, 1, 2, 1)

    def installation_digest(self, claims: InstallationClaims) -> str:
        assert claims.installation_id == INSTALLATION_ID
        return "inst_" + "b" * 43

    def revenuecat_app_user_id(self, claims: InstallationClaims) -> str:
        assert claims.installation_id == INSTALLATION_ID
        return REVENUECAT_ID


class FakeAiGateway:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, float]] = []
        self.failure: BaseException | None = None
        self.result: Any | None = None

    def analyze(
        self, resume_text: str, job_description: str | None, deadline: float
    ) -> Any:
        self.calls.append((resume_text, job_description, deadline))
        if self.failure is not None:
            raise self.failure
        if self.result is not None:
            return self.result
        from tests.test_routes import feedback

        return feedback()


class FakePdfParser:
    def __init__(self) -> None:
        self.calls = 0

    def __call__(
        self, stream: io.BytesIO, declared_size: int, filename: str
    ) -> ExtractedResume:
        self.calls += 1
        assert declared_size == len(stream.getbuffer())
        assert filename == "resume.pdf"
        return ExtractedResume(
            text="Summary\nExperience\nBuilt Python APIs for 1,000 users\nSkills",
            page_count=1,
        )


class FakeAllowanceReservation:
    def __init__(self) -> None:
        self.allowance = AllowanceSnapshot(0, 3, RESET)
        self.disposition = "started"
        self.begin_calls = 0
        self.releases = 0

    def snapshot(self) -> AllowanceSnapshot:
        return self.allowance

    def begin_dispatch(self) -> Any:
        self.begin_calls += 1
        charged = AllowanceSnapshot(1, 3, RESET)
        return SimpleNamespace(disposition=self.disposition, allowance=charged)

    def release(self) -> None:
        self.releases += 1


class FakeAdmission:
    def __init__(self, allowance: FakeAllowanceReservation) -> None:
        self.allowance = allowance
        self.ai_status = "admitted"
        self.calls: list[Any] = []

    def admit(self, request: Any) -> AdmissionDecision:
        self.calls.append(request)
        reservation = self.allowance if self.ai_status == "admitted" else None
        snapshot = self.allowance.snapshot() if self.ai_status == "admitted" else None
        return AdmissionDecision(
            self.ai_status,  # type: ignore[arg-type]
            snapshot,
            AdmissionLease(),
            reservation,
        )


class FakeRevenueCat:
    def __init__(self) -> None:
        self.calls: list[tuple[str, float]] = []
        self.plan = PlanSnapshot(
            "free",
            datetime(2026, 8, 10, tzinfo=UTC),
            None,
        )

    def verify(self, app_user_id: str, *, deadline: float) -> PlanSnapshot:
        self.calls.append((app_user_id, deadline))
        return self.plan


class FakeAllowances:
    def __init__(self, reservation: FakeAllowanceReservation) -> None:
        self.reservation = reservation
        self.reserve_calls: list[tuple[str, PlanSnapshot, UUID]] = []
        self.link_calls: list[tuple[str, str]] = []

    def reserve(
        self, subject: str, plan: PlanSnapshot, request_id: UUID
    ) -> FakeAllowanceReservation:
        self.reserve_calls.append((subject, plan, request_id))
        return self.reservation

    def link_quota_subjects(self, installation: str, account: str) -> None:
        self.link_calls.append((installation, account))


class FakeAppleIdentity:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str]] = []

    def verify(self, identity_token: str, nonce: str) -> AppleIdentity:
        self.calls.append((identity_token, nonce))
        return AppleIdentity(
            account_id="acct_" + "c" * 43,
            revenuecat_app_user_id="rai_account_" + "d" * 43,
        )


class FakeAccountTokens:
    def __init__(self) -> None:
        self.issue_calls: list[tuple[str, str, str]] = []

    def issue(
        self, account_id: str, installation_digest: str, app_user_id: str
    ) -> IssuedAccountToken:
        self.issue_calls.append((account_id, installation_digest, app_user_id))
        return IssuedAccountToken("signed-account-token", 1_786_327_300)


class FakeEntitlements:
    def __init__(self) -> None:
        self.claim_calls: list[tuple[str, datetime, tuple[str, ...]]] = []

    def claim_webhook_event(
        self,
        event_id: str,
        effective_at: datetime,
        app_user_ids: tuple[str, ...],
    ) -> bool:
        self.claim_calls.append((event_id, effective_at, app_user_ids))
        return True


class FakeWebhook:
    def __init__(self) -> None:
        self.calls: list[tuple[Any, bytes]] = []
        self.event = RevenueCatEvent(
            event_id="event-1",
            app_user_id=REVENUECAT_ID,
            original_app_user_id=None,
            aliases=(),
            transferred_from=(),
            transferred_to=(),
            event_type="RENEWAL",
            product_id="com.avinashamanchi.resumeai.pro.monthly",
            entitlement_ids=("resume_pro",),
            effective_at=datetime(2026, 8, 9, tzinfo=UTC),
        )

    def decode(self, headers: Any, body: bytes) -> RevenueCatEvent:
        self.calls.append((headers, body))
        return self.event


class Healthy:
    def healthcheck(self) -> bool:
        return True

    def check_installation_issue(self, _key: str) -> RateLimitDecision:
        return RateLimitDecision(allowed=True)


@dataclass
class Harness:
    tokens: FakeTokens
    ai: FakeAiGateway
    pdf: FakePdfParser
    allowance: FakeAllowanceReservation
    admission: FakeAdmission
    revenuecat: FakeRevenueCat
    allowances: FakeAllowances
    apple_identity: FakeAppleIdentity
    account_tokens: FakeAccountTokens
    entitlements: FakeEntitlements
    webhook: FakeWebhook

    def registry(self) -> ServiceRegistry:
        registry = ServiceRegistry(
            pdf_parser=self.pdf,
            scorer=score_resume,
            ai_gateway=self.ai,
            installation_tokens=self.tokens,
            rate_limiter=Healthy(),
            leases=Healthy(),
            admission=self.admission,
            account_tokens=self.account_tokens,
        )
        object.__setattr__(registry, "revenuecat", self.revenuecat)
        object.__setattr__(registry, "allowances", self.allowances)
        object.__setattr__(registry, "apple_identity", self.apple_identity)
        object.__setattr__(registry, "entitlements", self.entitlements)
        object.__setattr__(registry, "revenuecat_webhook", self.webhook)
        return registry


@pytest.fixture
def harness() -> Harness:
    allowance = FakeAllowanceReservation()
    return Harness(
        tokens=FakeTokens(),
        ai=FakeAiGateway(),
        pdf=FakePdfParser(),
        allowance=allowance,
        admission=FakeAdmission(allowance),
        revenuecat=FakeRevenueCat(),
        allowances=FakeAllowances(allowance),
        apple_identity=FakeAppleIdentity(),
        account_tokens=FakeAccountTokens(),
        entitlements=FakeEntitlements(),
        webhook=FakeWebhook(),
    )


@pytest.fixture
def client(harness: Harness) -> Any:
    app = create_app(settings(), harness.registry())
    app.config["TESTING"] = True
    return app.test_client()


def v2_headers(*, source: str = "reviewed_text", ai: str = "requested") -> dict[str, str]:
    return {
        "Authorization": f"Installation {TOKEN}",
        "X-Resume-Source": source,
        "X-Resume-AI": ai,
        "X-Resume-Request-ID": str(REQUEST_ID),
    }


def submit_reviewed_text(client: Any, *, ai: str = "requested", **overrides: Any) -> Any:
    data = {
        "resume_text": "Summary\nExperience\nBuilt Python APIs for 1,000 users\nSkills",
        "job_description": "Python engineer",
        "consent_version": CONSENT_VERSION,
        "request_id": str(REQUEST_ID),
    }
    data.update(overrides)
    return client.post(
        "/v2/analyses",
        data=data,
        content_type="multipart/form-data",
        headers=v2_headers(ai=ai),
    )


def test_v2_emits_fixed_content_free_analysis_admission_and_provider_metrics(
    harness: Harness,
) -> None:
    records: list[dict[str, object]] = []

    class Sink:
        def emit(self, record: dict[str, object]) -> None:
            records.append(record)

    registry = replace(harness.registry(), telemetry=Telemetry(sink=Sink()))
    app = create_app(settings(), registry)
    app.config["TESTING"] = True

    response = submit_reviewed_text(app.test_client())

    assert response.status_code == 200
    counters = {
        (record["name"], tuple(record["labels"].items()))
        for record in records
        if record["kind"] == "counter"
    }
    assert (
        "admission",
        (("source_class", "reviewed_text"), ("admission_outcome", "admitted")),
    ) in counters
    assert (
        "analysis",
        (
            ("source_class", "reviewed_text"),
            ("ai_status", "complete"),
            ("plan_class", "free"),
        ),
    ) in counters
    assert (
        "provider",
        (("provider_outcome", "complete"),),
    ) in counters
    histogram_names = {
        record["name"] for record in records if record["kind"] == "histogram"
    }
    assert {
        "admission_latency_ms",
        "scoring_latency_ms",
        "provider_latency_ms",
        "total_latency_ms",
    } <= histogram_names


@pytest.mark.parametrize(
    ("failure", "expected_status"),
    [
        (PublicServiceError(ErrorCode.AI_TIMEOUT, retryable=True), "timeout"),
        (
            PublicServiceError(ErrorCode.AI_UNAVAILABLE, retryable=True),
            "temporarily_unavailable",
        ),
        (
            PublicServiceError(ErrorCode.INVALID_AI_RESPONSE),
            "invalid_provider_response",
        ),
    ],
)
def test_v2_keeps_deterministic_score_when_ai_fails(
    client: Any,
    harness: Harness,
    failure: PublicServiceError,
    expected_status: str,
) -> None:
    harness.ai.failure = failure

    response = submit_reviewed_text(client)

    assert response.status_code == 200
    parsed = AnalysisResponseV2.model_validate(response.get_json())
    assert parsed.score.readinessScore >= 0
    assert parsed.ai.status == expected_status
    assert parsed.ai.feedback is None
    assert harness.allowance.begin_calls == 1


def test_v2_does_not_charge_or_dispatch_when_quota_is_exhausted(
    client: Any, harness: Harness
) -> None:
    harness.admission.ai_status = "quota_exhausted"

    response = submit_reviewed_text(client)

    assert response.status_code == 200
    parsed = AnalysisResponseV2.model_validate(response.get_json())
    assert parsed.ai.status == "quota_exhausted"
    assert parsed.score.readinessScore >= 0
    assert harness.allowance.begin_calls == 0
    assert harness.ai.calls == []


def test_v2_invalid_gateway_payload_keeps_score_and_hides_payload(
    client: Any, harness: Harness
) -> None:
    harness.ai.result = {"private": "malformed-provider-payload"}

    response = submit_reviewed_text(client)

    assert response.status_code == 200
    parsed = AnalysisResponseV2.model_validate(response.get_json())
    assert parsed.score.readinessScore >= 0
    assert parsed.ai.status == "invalid_provider_response"
    assert parsed.ai.feedback is None
    assert "malformed-provider-payload" not in response.get_data(as_text=True)


def test_v2_not_requested_returns_score_without_allowance_or_provider(
    client: Any, harness: Harness
) -> None:
    harness.admission.ai_status = "not_requested"

    response = submit_reviewed_text(client, ai="not_requested")

    assert response.status_code == 200
    parsed = AnalysisResponseV2.model_validate(response.get_json())
    assert parsed.ai.status == "not_requested"
    assert parsed.ai.allowance is None
    assert harness.allowance.begin_calls == 0
    assert harness.ai.calls == []


def test_v2_rejects_admitted_header_body_source_mismatch_before_processing(
    client: Any, harness: Harness
) -> None:
    response = client.post(
        "/v2/analyses",
        data={
            "resume_pdf": (io.BytesIO(b"%PDF-private"), "resume.pdf", "application/pdf"),
            "consent_version": CONSENT_VERSION,
            "request_id": str(REQUEST_ID),
        },
        headers=v2_headers(source="reviewed_text"),
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "invalid_request"
    assert harness.pdf.calls == 0
    assert harness.allowance.begin_calls == 0
    assert harness.ai.calls == []


def test_v2_rejects_body_request_id_that_differs_from_admitted_header(
    client: Any, harness: Harness
) -> None:
    response = submit_reviewed_text(
        client,
        request_id="f4bdcd53-231d-4cdd-a7db-1e88e9f8d9ba",
    )

    assert response.status_code == 400
    assert response.get_json()["code"] == "invalid_request"
    assert harness.allowance.begin_calls == 0
    assert harness.ai.calls == []


def test_v2_installation_returns_server_bound_revenuecat_identity(
    client: Any, harness: Harness
) -> None:
    response = client.post("/v2/installations")

    assert response.status_code == 201
    assert response.get_json() == {
        "schemaVersion": 2,
        "installationToken": TOKEN,
        "revenueCatAppUserId": REVENUECAT_ID,
    }
    assert response.headers["Cache-Control"] == "no-store"
    assert harness.tokens.v2_issues == 1


def test_v2_entitlement_sync_uses_only_authenticated_server_derived_identity(
    client: Any, harness: Harness
) -> None:
    response = client.post(
        "/v2/entitlements/sync",
        json={},
        headers={"Authorization": f"Installation {TOKEN}"},
    )

    assert response.status_code == 200
    assert response.get_json() == {
        "schemaVersion": 2,
        "plan": "free",
        "verifiedUntil": "2026-08-10T00:00:00Z",
        "entitlementExpiresAt": None,
        "allowance": {"used": 0, "limit": 3, "resetsAt": "2026-09-01T00:00:00Z"},
    }
    assert harness.revenuecat.calls == [(REVENUECAT_ID, 2.0)]
    subject, plan, request_id = harness.allowances.reserve_calls[0]
    assert subject == "inst_" + "b" * 43
    assert plan == harness.revenuecat.plan
    assert isinstance(request_id, UUID)
    assert harness.allowance.releases == 1


def test_v2_entitlement_sync_authenticates_before_parsing_json(
    client: Any, harness: Harness
) -> None:
    response = client.post(
        "/v2/entitlements/sync",
        data=b"{malformed-private-json",
        content_type="application/json",
        headers={"Authorization": "Bearer attacker"},
    )

    assert response.status_code == 401
    assert response.get_json()["code"] == "invalid_installation"
    assert harness.revenuecat.calls == []


def test_v2_entitlement_sync_rejects_oversize_json_before_provider(
    client: Any, harness: Harness
) -> None:
    response = client.post(
        "/v2/entitlements/sync",
        data=b'{' + b'"padding":"' + b"x" * 2_048 + b'"}',
        content_type="application/json",
        headers={"Authorization": f"Installation {TOKEN}"},
    )

    assert response.status_code == 413
    assert response.get_json()["code"] == "file_too_large"
    assert harness.revenuecat.calls == []


def test_v2_apple_identity_is_bound_to_authenticated_installation(
    client: Any, harness: Harness
) -> None:
    response = client.post(
        "/v2/identity/apple",
        json={"identityToken": "apple-identity-token", "nonce": "raw-nonce-123"},
        headers={"Authorization": f"Installation {TOKEN}"},
    )

    assert response.status_code == 200
    assert response.get_json() == {
        "schemaVersion": 2,
        "accountToken": "signed-account-token",
        "expiresAt": "2026-08-10T02:01:40Z",
        "revenueCatAppUserId": "rai_account_" + "d" * 43,
    }
    assert harness.apple_identity.calls == [
        ("apple-identity-token", "raw-nonce-123")
    ]
    assert harness.account_tokens.issue_calls == [
        (
            "acct_" + "c" * 43,
            "inst_" + "b" * 43,
            "rai_account_" + "d" * 43,
        )
    ]


def test_v2_revenuecat_webhook_claims_event_before_acknowledging(
    client: Any, harness: Harness
) -> None:
    body = b'{"private":"provider-body"}'
    response = client.post(
        "/v2/revenuecat/webhook",
        data=body,
        content_type="application/json",
        headers={
            "Authorization": "Bearer configured-secret",
            "X-RevenueCat-Webhook-Signature": "t=1,v1=signature",
        },
    )

    assert response.status_code == 204
    assert response.get_data() == b""
    assert len(harness.webhook.calls) == 1
    assert harness.webhook.calls[0][1] == body
    assert harness.entitlements.claim_calls == [
        (
            "event-1",
            datetime(2026, 8, 9, tzinfo=UTC),
            (REVENUECAT_ID,),
        )
    ]
