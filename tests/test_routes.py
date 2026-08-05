from __future__ import annotations

import asyncio
import io
from contextlib import contextmanager
from dataclasses import dataclass, replace
from typing import Any, Iterator
from uuid import UUID, uuid4

import pytest

from server.app import ServiceRegistry, create_app
from server.config import ConfigurationError, Settings
from server.contracts import AnalysisResponseV1, FeedbackV1, PublicErrorV1
from server.errors import ErrorCode, PublicServiceError
from server.installations import InstallationClaims, InvalidInstallationToken
from server.pdf_parser import ExtractedResume
from server.rate_limit import RateLimitDecision
from server.scoring import score_resume
from werkzeug.datastructures import MultiDict
from werkzeug.test import EnvironBuilder


CONSENT_VERSION = "2026-08-04.v1"
INSTALLATION_ID = UUID("4de0bc7f-50b2-4e9b-9e36-617d3899cdb6")
REQUEST_ID = UUID("6ef499c6-a2c7-4314-b88b-af45c53da38a")
TOKEN = "signed-installation-token"
PRIVATE_RESUME = "private resume /Users/avi/Documents/resume.pdf"


def settings(**overrides: Any) -> Settings:
    values: dict[str, Any] = {
        "app_env": "testing",
        "debug": False,
        "groq_api_key": "",
        "groq_model": "llama-3.3-70b-versatile",
        "installation_signing_key": "",
        "redis_url": "",
        "allowed_web_origins": ("https://resume.example.com",),
        "provider_deadline_seconds": 8.0,
        "request_deadline_seconds": 10.0,
    }
    values.update(overrides)
    return Settings(**values)


def feedback() -> FeedbackV1:
    return FeedbackV1(
        matchedKeywords=["Python"],
        missingKeywords=["Flask"],
        strengths=["Uses measurable outcomes."],
        improvements=["Add one API reliability example."],
        powerBullets=["Built Python services used by 1,000 customers."],
        summary="Clear experience with room for more role-specific detail.",
        simulatedRecruiterComment=(
            "Simulated AI recruiter feedback: The resume shows relevant experience."
        ),
    )


class FakePdfParser:
    def __init__(self) -> None:
        self.calls = 0
        self.stream_types: list[type[object]] = []
        self.raw_inputs: list[bytes] = []
        self.failure: BaseException | None = None

    def __call__(
        self, stream: io.BytesIO, declared_size: int, filename: str
    ) -> ExtractedResume:
        self.calls += 1
        self.stream_types.append(type(stream))
        raw_pdf = stream.read()
        self.raw_inputs.append(raw_pdf)
        if self.failure is not None:
            raise self.failure
        assert declared_size == len(raw_pdf)
        assert filename == "resume.pdf"
        return ExtractedResume(
            text="Summary\nExperience\n- Built Python APIs for 1,000 users\nEducation\nSkills",
            page_count=1,
        )

    def healthcheck(self) -> bool:
        return True


class FakeAiGateway:
    def __init__(self) -> None:
        self.calls: list[tuple[str, str | None, float]] = []
        self.failure: BaseException | None = None

    def analyze(
        self, resume_text: str, job_description: str | None, deadline: float
    ) -> FeedbackV1:
        self.calls.append((resume_text, job_description, deadline))
        if self.failure is not None:
            raise self.failure
        return feedback()

    def healthcheck(self) -> bool:
        return True


class FakeTokens:
    def __init__(self) -> None:
        self.issued = 0
        self.verified: list[str] = []

    def issue(self) -> str:
        self.issued += 1
        return TOKEN

    def verify(self, token: str) -> InstallationClaims:
        self.verified.append(token)
        if token != TOKEN:
            raise InvalidInstallationToken()
        return InstallationClaims(
            installation_id=INSTALLATION_ID,
            issued_at=1,
            expires_at=2,
            version=1,
        )

    def healthcheck(self) -> bool:
        return True


class FakeRateLimiter:
    def __init__(self) -> None:
        self.analysis_decision = RateLimitDecision(allowed=True)
        self.issue_decision = RateLimitDecision(allowed=True)
        self.analysis_checks: list[tuple[UUID, str]] = []
        self.issue_checks: list[str] = []
        self.health_checks = 0

    def check(self, installation_id: UUID, ip_key: str) -> RateLimitDecision:
        self.analysis_checks.append((installation_id, ip_key))
        return self.analysis_decision

    def check_installation_issue(self, ip_key: str) -> RateLimitDecision:
        self.issue_checks.append(ip_key)
        return self.issue_decision

    def healthcheck(self) -> bool:
        self.health_checks += 1
        return True


class FakeLeases:
    def __init__(self) -> None:
        self.acquire_result = True
        self.active = False
        self.entries: list[tuple[UUID, UUID, int]] = []
        self.exits = 0
        self.health_checks = 0

    @contextmanager
    def lease(
        self, installation_id: UUID, request_id: UUID, ttl_seconds: int
    ) -> Iterator[bool]:
        self.entries.append((installation_id, request_id, ttl_seconds))
        acquired = self.acquire_result
        self.active = acquired
        try:
            yield acquired
        finally:
            self.active = False
            if acquired:
                self.exits += 1

    def healthcheck(self) -> bool:
        self.health_checks += 1
        return True


@dataclass
class Harness:
    pdf_parser: FakePdfParser
    ai_gateway: FakeAiGateway
    installation_tokens: FakeTokens
    rate_limiter: FakeRateLimiter
    leases: FakeLeases

    def registry(self) -> ServiceRegistry:
        return ServiceRegistry(
            pdf_parser=self.pdf_parser,
            scorer=score_resume,
            ai_gateway=self.ai_gateway,
            installation_tokens=self.installation_tokens,
            rate_limiter=self.rate_limiter,
            leases=self.leases,
        )


@pytest.fixture
def harness() -> Harness:
    return Harness(
        pdf_parser=FakePdfParser(),
        ai_gateway=FakeAiGateway(),
        installation_tokens=FakeTokens(),
        rate_limiter=FakeRateLimiter(),
        leases=FakeLeases(),
    )


@pytest.fixture
def client(harness: Harness):
    app = create_app(settings(), harness.registry())
    app.config["TESTING"] = True
    return app.test_client()


def authorization(token: str = TOKEN) -> dict[str, str]:
    return {"Authorization": f"Installation {token}"}


def text_form(
    resume_text: str = "Summary\nExperience\n- Built Python APIs for 1,000 users",
    **overrides: object,
) -> dict[str, object]:
    return {
        "resume_text": resume_text,
        "consent_version": CONSENT_VERSION,
        "request_id": str(REQUEST_ID),
    } | overrides


def submit_text(client: Any, resume_text: str = PRIVATE_RESUME, **overrides: object):
    return client.post(
        "/v1/analyses",
        data=text_form(resume_text, **overrides),
        content_type="multipart/form-data",
        headers=authorization(),
    )


def submit_pdf(client: Any, pdf_bytes: bytes = b"%PDF-private-bytes"):
    return client.post(
        "/v1/analyses",
        data={
            "resume_pdf": (io.BytesIO(pdf_bytes), "resume.pdf", "application/pdf"),
            "job_description": "Python API engineer",
            "consent_version": CONSENT_VERSION,
            "request_id": str(REQUEST_ID),
        },
        headers=authorization(),
    )


def parsed_error(response: Any) -> PublicErrorV1:
    return PublicErrorV1.model_validate(response.get_json())


def test_pdf_analysis_returns_combined_score_and_feedback_without_forwarding_pdf(
    client: Any, harness: Harness
):
    raw_pdf = b"%PDF-private-binary"

    response = submit_pdf(client, raw_pdf)

    assert response.status_code == 200
    parsed = AnalysisResponseV1.model_validate(response.get_json())
    assert parsed.sourceType == "pdf"
    assert parsed.score.scoreVersion == "resume-readiness-v1"
    assert parsed.feedback == feedback()
    assert harness.pdf_parser.stream_types == [io.BytesIO]
    ai_resume, ai_job, ai_deadline = harness.ai_gateway.calls[0]
    assert ai_resume == (
        "Summary\nExperience\n- Built Python APIs for 1,000 users\nEducation\nSkills"
    )
    assert raw_pdf not in ai_resume.encode()
    assert ai_job == "Python API engineer"
    assert 0 < ai_deadline <= 8.0


@pytest.mark.parametrize(
    ("source_type", "expected"),
    [(None, "text"), ("text", "text"), ("vision_text", "vision_text")],
)
def test_reviewed_text_has_an_explicit_bounded_source_type(
    client: Any, source_type: str | None, expected: str
):
    overrides = {} if source_type is None else {"source_type": source_type}

    response = submit_text(client, **overrides)

    assert response.status_code == 200
    assert AnalysisResponseV1.model_validate(response.get_json()).sourceType == expected


def test_installation_issue_returns_a_versioned_token_without_caching(
    client: Any, harness: Harness
):
    response = client.post("/v1/installations")

    assert response.status_code == 201
    assert response.get_json() == {"schemaVersion": 1, "installationToken": TOKEN}
    assert harness.installation_tokens.issued == 1
    assert response.headers["Cache-Control"] == "no-store"


@pytest.mark.parametrize(
    ("body", "expected_status", "expected_code"),
    [
        pytest.param(
            b"unexpected",
            400,
            ErrorCode.INVALID_REQUEST,
            id="unexpected-body",
        ),
        pytest.param(
            b"x" * (11 * 1024 * 1024 + 1),
            413,
            ErrorCode.FILE_TOO_LARGE,
            id="body-over-cap",
        ),
    ],
)
def test_installation_issue_rejects_request_bodies_before_rate_or_issuance(
    client: Any,
    harness: Harness,
    body: bytes,
    expected_status: int,
    expected_code: ErrorCode,
):
    response = client.post(
        "/v1/installations",
        data=body,
        content_type="application/octet-stream",
    )

    assert response.status_code == expected_status
    assert parsed_error(response).code is expected_code
    assert harness.rate_limiter.issue_checks == []
    assert harness.installation_tokens.issued == 0


def test_installation_issue_rejects_unknown_length_stream_body_before_mutation(
    client: Any,
    harness: Harness,
):
    observed_input = io.BytesIO(b"private streamed body")
    environ = EnvironBuilder(
        path="/v1/installations",
        method="POST",
        content_type="application/octet-stream",
    ).get_environ()
    environ.pop("CONTENT_LENGTH", None)
    environ["wsgi.input"] = observed_input
    environ["wsgi.input_terminated"] = True

    app_iter, status, headers = client.run_wsgi_app(environ, buffered=True)
    response = client.application.response_class(
        app_iter,
        status=status,
        headers=headers,
    )

    assert response.status_code == 400
    assert parsed_error(response).code is ErrorCode.INVALID_REQUEST
    assert observed_input.tell() == 1
    assert harness.rate_limiter.issue_checks == []
    assert harness.installation_tokens.issued == 0


def test_unknown_length_streamed_analysis_preserves_the_whole_body_cap(
    client: Any,
    harness: Harness,
):
    boundary = "resume-ai-boundary"
    body = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="resume_text"\r\n\r\n'
    ).encode() + b"x" * (11 * 1024 * 1024 + 1)
    observed_input = io.BytesIO(body)
    environ = EnvironBuilder(
        path="/v1/analyses",
        method="POST",
        content_type=f"multipart/form-data; boundary={boundary}",
        headers=authorization(),
    ).get_environ()
    environ.pop("CONTENT_LENGTH", None)
    environ["wsgi.input"] = observed_input
    environ["wsgi.input_terminated"] = True

    app_iter, status, headers = client.run_wsgi_app(environ, buffered=True)
    response = client.application.response_class(
        app_iter,
        status=status,
        headers=headers,
    )

    assert response.status_code == 413
    assert parsed_error(response).code is ErrorCode.FILE_TOO_LARGE
    assert observed_input.tell() <= 11 * 1024 * 1024 + 1
    assert harness.rate_limiter.analysis_checks == []
    assert harness.ai_gateway.calls == []


@pytest.mark.parametrize(
    "header",
    [None, "", "Bearer token", "Installation", "Installation wrong-token"],
)
def test_analysis_rejects_invalid_authorization_before_parsing(
    client: Any, harness: Harness, header: str | None
):
    headers = {} if header is None else {"Authorization": header}

    response = client.post(
        "/v1/analyses",
        data={"resume_pdf": (io.BytesIO(b"%PDF-private"), "resume.pdf")},
        headers=headers,
    )

    assert response.status_code == 401
    assert parsed_error(response).code is ErrorCode.INVALID_INSTALLATION
    assert harness.pdf_parser.calls == 0
    assert harness.rate_limiter.analysis_checks == []


def test_analysis_rejects_non_multipart_content_before_services(
    client: Any, harness: Harness
):
    response = client.post(
        "/v1/analyses",
        json={"resume_text": PRIVATE_RESUME},
        headers=authorization(),
    )

    assert response.status_code == 415
    assert parsed_error(response).code is ErrorCode.INVALID_REQUEST
    assert harness.rate_limiter.analysis_checks == []
    assert harness.pdf_parser.calls == 0
    assert harness.ai_gateway.calls == []


@pytest.mark.parametrize(
    ("overrides", "expected_status"),
    [
        ({"consent_version": "old-consent"}, 400),
        ({"request_id": "not-a-uuid"}, 400),
        ({"source_type": "pdf"}, 400),
        ({"source_type": "other"}, 400),
        ({"unexpected": "field"}, 400),
    ],
)
def test_invalid_multipart_metadata_fails_before_rate_or_expensive_work(
    client: Any,
    harness: Harness,
    overrides: dict[str, object],
    expected_status: int,
):
    response = submit_text(client, **overrides)

    assert response.status_code == expected_status
    assert parsed_error(response).code is ErrorCode.INVALID_REQUEST
    assert harness.rate_limiter.analysis_checks == []
    assert harness.pdf_parser.calls == 0
    assert harness.ai_gateway.calls == []


def test_exactly_one_source_is_required_before_rate_or_expensive_work(
    client: Any, harness: Harness
):
    missing = client.post(
        "/v1/analyses",
        data={
            "consent_version": CONSENT_VERSION,
            "request_id": str(REQUEST_ID),
        },
        content_type="multipart/form-data",
        headers=authorization(),
    )
    both = client.post(
        "/v1/analyses",
        data={
            **text_form(),
            "resume_pdf": (io.BytesIO(b"%PDF-private"), "resume.pdf"),
        },
        headers=authorization(),
    )

    assert missing.status_code == both.status_code == 400
    assert parsed_error(missing).code is ErrorCode.INVALID_REQUEST
    assert parsed_error(both).code is ErrorCode.INVALID_REQUEST
    assert harness.rate_limiter.analysis_checks == []
    assert harness.pdf_parser.calls == 0
    assert harness.ai_gateway.calls == []


def test_field_limits_and_pdf_mime_are_enforced_independently_after_parsing(
    client: Any, harness: Harness
):
    long_resume = submit_text(client, "r" * 30_001)
    long_job = submit_text(client, job_description="j" * 20_001)
    wrong_mime = client.post(
        "/v1/analyses",
        data={
            "resume_pdf": (io.BytesIO(b"%PDF-private"), "resume.pdf", "text/plain"),
            "consent_version": CONSENT_VERSION,
            "request_id": str(REQUEST_ID),
        },
        headers=authorization(),
    )

    assert long_resume.status_code == 413
    assert parsed_error(long_resume).code is ErrorCode.RESUME_TOO_LONG
    assert long_job.status_code == 413
    assert parsed_error(long_job).code is ErrorCode.SCORING_INPUT_LIMIT
    assert wrong_mime.status_code == 415
    assert parsed_error(wrong_mime).code is ErrorCode.UNSUPPORTED_FILE
    assert harness.rate_limiter.analysis_checks == []
    assert harness.pdf_parser.calls == 0
    assert harness.ai_gateway.calls == []


def test_whole_request_body_is_capped_before_multipart_parsing(
    client: Any, harness: Harness
):
    response = client.post(
        "/v1/analyses",
        data=b"x" * (11 * 1024 * 1024 + 1),
        content_type="multipart/form-data; boundary=missing",
        headers=authorization(),
    )

    assert response.status_code == 413
    assert parsed_error(response).code is ErrorCode.FILE_TOO_LARGE
    assert harness.rate_limiter.analysis_checks == []
    assert harness.pdf_parser.calls == 0
    assert harness.ai_gateway.calls == []


def test_rate_limit_prevents_lease_and_processing(client: Any, harness: Harness):
    harness.rate_limiter.analysis_decision = RateLimitDecision(
        allowed=False, retry_after_seconds=37
    )

    response = submit_text(client)

    assert response.status_code == 429
    assert parsed_error(response).code is ErrorCode.RATE_LIMITED
    assert response.headers["Retry-After"] == "37"
    assert harness.leases.entries == []
    assert harness.ai_gateway.calls == []


def test_duplicate_in_flight_request_is_not_processed_or_cached(
    client: Any, harness: Harness
):
    harness.leases.acquire_result = False

    response = submit_text(client)

    assert response.status_code == 409
    assert parsed_error(response).code is ErrorCode.REQUEST_IN_PROGRESS
    assert harness.ai_gateway.calls == []
    assert "analysis" not in response.get_data(as_text=True).casefold()


def test_completed_request_is_not_cached_and_lease_closes_each_time(
    client: Any, harness: Harness
):
    first = submit_text(client)
    second = submit_text(client)

    assert first.status_code == second.status_code == 200
    assert len(harness.ai_gateway.calls) == 2
    assert harness.leases.exits == 2
    assert harness.leases.active is False


def test_raw_exception_is_never_returned_and_lease_closes(
    client: Any, harness: Harness, caplog: pytest.LogCaptureFixture
):
    harness.ai_gateway.failure = RuntimeError(
        f"provider exploded for {PRIVATE_RESUME} token={TOKEN}"
    )

    response = submit_text(client, PRIVATE_RESUME, filename="secret-resume.pdf")

    assert response.status_code == 400  # unknown filename field is rejected first
    assert PRIVATE_RESUME not in response.get_data(as_text=True)
    assert "/Users/" not in response.get_data(as_text=True)
    assert TOKEN not in response.get_data(as_text=True)
    assert harness.leases.active is False

    failure = submit_text(client, PRIVATE_RESUME)
    assert failure.status_code == 503
    body = failure.get_data(as_text=True)
    assert PRIVATE_RESUME not in body
    assert "/Users/" not in body
    assert TOKEN not in body
    assert "provider exploded" not in body
    assert parsed_error(failure).code is ErrorCode.SERVICE_UNAVAILABLE
    assert harness.leases.active is False
    assert harness.leases.exits == 1
    assert PRIVATE_RESUME not in caplog.text
    assert "/Users/" not in caplog.text
    assert TOKEN not in caplog.text
    assert "provider exploded" not in caplog.text


def test_analysis_headers_are_private_and_cors_is_first_party_only(client: Any):
    allowed = client.post(
        "/v1/analyses",
        data=text_form(),
        content_type="multipart/form-data",
        headers=authorization()
        | {"Origin": "https://resume.example.com"},
    )
    denied = client.post(
        "/v1/analyses",
        data=text_form(),
        content_type="multipart/form-data",
        headers=authorization() | {"Origin": "https://evil.example"},
    )

    assert allowed.headers["Access-Control-Allow-Origin"] == (
        "https://resume.example.com"
    )
    assert "Access-Control-Allow-Origin" not in denied.headers
    assert allowed.headers["Cache-Control"] == "no-store"
    assert allowed.headers["X-Content-Type-Options"] == "nosniff"
    assert "default-src 'self'" in allowed.headers["Content-Security-Policy"]
    assert UUID(allowed.headers["X-Request-ID"]) == REQUEST_ID


def test_cors_uses_literal_origin_membership_for_simple_and_preflight_requests(
    client: Any,
):
    allowed_origin = "https://resume.example.com"
    dot_near_match = "https://resumeXexampleXcom"
    host_near_match = "https://resume.example.com.evil"

    allowed = client.get("/healthz", headers={"Origin": allowed_origin})
    near_matches = [
        client.get("/healthz", headers={"Origin": origin})
        for origin in (dot_near_match, host_near_match)
    ]
    allowed_preflight = client.options(
        "/v1/analyses",
        headers={
            "Origin": allowed_origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "Authorization, Content-Type",
        },
    )
    denied_preflight = client.options(
        "/v1/analyses",
        headers={
            "Origin": dot_near_match,
            "Access-Control-Request-Method": "POST",
        },
    )

    assert allowed.headers["Access-Control-Allow-Origin"] == allowed_origin
    assert allowed_preflight.headers["Access-Control-Allow-Origin"] == allowed_origin
    assert "POST" in allowed_preflight.headers["Access-Control-Allow-Methods"]
    assert "Authorization" in allowed_preflight.headers[
        "Access-Control-Allow-Headers"
    ]
    for response in (*near_matches, denied_preflight):
        assert "Access-Control-Allow-Origin" not in response.headers
        assert "Access-Control-Allow-Methods" not in response.headers


def test_health_is_content_free_and_fails_closed_when_a_check_fails(
    harness: Harness,
):
    healthy_app = create_app(settings(), harness.registry())
    healthy_app.config["TESTING"] = True
    healthy = healthy_app.test_client().get("/healthz")

    assert healthy.status_code == 200
    assert healthy.get_json() == {"status": "ok"}
    assert harness.rate_limiter.health_checks == 1
    assert harness.leases.health_checks == 1
    assert "model" not in healthy.get_data(as_text=True).casefold()
    assert "redis" not in healthy.get_data(as_text=True).casefold()

    harness.rate_limiter.healthcheck = lambda: False  # type: ignore[method-assign]
    failed_app = create_app(settings(), harness.registry())
    failed_app.config["TESTING"] = True
    failed = failed_app.test_client().get("/healthz")

    assert failed.status_code == 503
    assert parsed_error(failed).code is ErrorCode.SERVICE_UNAVAILABLE
    assert "redis" not in failed.get_data(as_text=True).casefold()


class MissingHealthcheck:
    pass


class NonCallableHealthcheck:
    healthcheck = True


class NonBooleanHealthcheck:
    def healthcheck(self) -> int:
        return 1


class RaisingHealthcheck:
    def healthcheck(self) -> bool:
        raise RuntimeError("private redis health detail")


@pytest.mark.parametrize("field_name", ["rate_limiter", "leases"])
@pytest.mark.parametrize(
    "unusable_service",
    [
        pytest.param(MissingHealthcheck(), id="missing"),
        pytest.param(NonCallableHealthcheck(), id="non-callable"),
        pytest.param(NonBooleanHealthcheck(), id="non-bool"),
        pytest.param(RaisingHealthcheck(), id="raises"),
    ],
)
def test_health_fails_closed_for_every_unusable_required_check(
    harness: Harness,
    field_name: str,
    unusable_service: object,
):
    registry = replace(harness.registry(), **{field_name: unusable_service})
    app = create_app(settings(), registry)
    app.config["TESTING"] = True

    response = app.test_client().get("/healthz")

    assert response.status_code == 503
    error = parsed_error(response)
    assert error.code is ErrorCode.SERVICE_UNAVAILABLE
    assert "private redis health detail" not in response.get_data(as_text=True)


@pytest.mark.parametrize(
    "origin",
    [
        "*",
        "https://*.example.com",
        "https://(resume|evil).example.com",
        "https://resume|evil.example.com",
        "https://user:password@resume.example.com",
        "https://resume.example.com/",
        "https://resume.example.com/path",
        "https://resume.example.com?preview=true",
    ],
)
def test_app_rejects_a_directly_injected_noncanonical_cors_setting(
    harness: Harness, origin: str
):
    with pytest.raises(ConfigurationError, match="origin|CORS|wildcard"):
        create_app(
            settings(allowed_web_origins=(origin,)),
            harness.registry(),
        )


def test_app_normalizes_directly_injected_origins_before_literal_matching(
    harness: Harness,
):
    app = create_app(
        settings(
            allowed_web_origins=(
                "HTTPS://Resume.Example.COM:443",
                "http://LOCALHOST:80",
            )
        ),
        harness.registry(),
    )

    configured = app.extensions["resume_ai.settings"]
    assert configured.allowed_web_origins == (
        "https://resume.example.com",
        "http://localhost",
    )


@pytest.mark.parametrize(
    "host",
    [
        "999.999.999.999",
        "256.1.1.1",
        "127.1",
        "127.0.0.01",
        "1.2.3.4.5",
        "1234.5678",
    ],
)
def test_app_rejects_direct_malformed_or_ambiguous_dotted_numeric_hosts(
    harness: Harness,
    host: str,
):
    origin = f"https://{host}"

    with pytest.raises(ConfigurationError) as caught:
        create_app(
            settings(allowed_web_origins=(origin,)),
            harness.registry(),
        )

    assert origin not in str(caught.value)


def test_valid_ip_origins_use_exact_literal_cors_membership(harness: Harness):
    ipv4_origin = "https://192.0.2.10"
    ipv6_origin = "https://[2001:db8::1]"
    app = create_app(
        settings(allowed_web_origins=(ipv4_origin, ipv6_origin)),
        harness.registry(),
    )
    client = app.test_client()

    ipv4_allowed = client.get("/healthz", headers={"Origin": ipv4_origin})
    ipv6_allowed = client.get("/healthz", headers={"Origin": ipv6_origin})
    ipv4_near = client.get(
        "/healthz", headers={"Origin": "https://192.0.2.100"}
    )
    ipv6_near = client.get(
        "/healthz", headers={"Origin": "https://[2001:db8::2]"}
    )

    assert ipv4_allowed.headers["Access-Control-Allow-Origin"] == ipv4_origin
    assert ipv6_allowed.headers["Access-Control-Allow-Origin"] == ipv6_origin
    assert "Access-Control-Allow-Origin" not in ipv4_near.headers
    assert "Access-Control-Allow-Origin" not in ipv6_near.headers


def test_direct_production_settings_cannot_bypass_https_origin_policy_by_case(
    harness: Harness,
):
    with pytest.raises(ConfigurationError, match="HTTPS"):
        create_app(
            settings(
                app_env="PRODUCTION",
                allowed_web_origins=("http://resume.example.com",),
            ),
            harness.registry(),
        )


def test_installation_issuance_rate_limit_is_content_free(
    client: Any, harness: Harness
):
    harness.rate_limiter.issue_decision = RateLimitDecision(
        allowed=False, retry_after_seconds=42
    )

    response = client.post("/v1/installations")

    assert response.status_code == 429
    assert parsed_error(response).code is ErrorCode.RATE_LIMITED
    assert response.headers["Retry-After"] == "42"
    assert harness.installation_tokens.issued == 0


def test_scanned_pdf_maps_to_content_free_error_and_releases_lease(
    client: Any, harness: Harness
):
    harness.pdf_parser.failure = PublicServiceError(ErrorCode.SCAN_REQUIRED)

    response = submit_pdf(client)

    assert response.status_code == 422
    assert parsed_error(response).code is ErrorCode.SCAN_REQUIRED
    assert harness.ai_gateway.calls == []
    assert harness.leases.active is False
    assert harness.leases.exits == 1


def test_provider_timeout_maps_to_retryable_gateway_timeout_and_releases_lease(
    client: Any, harness: Harness
):
    harness.ai_gateway.failure = PublicServiceError(
        ErrorCode.AI_TIMEOUT, retryable=True
    )

    response = submit_text(client)

    error = parsed_error(response)
    assert response.status_code == 504
    assert error.code is ErrorCode.AI_TIMEOUT
    assert error.retryable is True
    assert harness.leases.active is False
    assert harness.leases.exits == 1


def test_request_cancellation_propagates_after_owner_safe_cleanup(
    client: Any, harness: Harness
):
    harness.ai_gateway.failure = asyncio.CancelledError()

    with pytest.raises(asyncio.CancelledError):
        submit_text(client)

    assert harness.leases.active is False
    assert harness.leases.exits == 1


def test_duplicate_multipart_members_are_rejected_before_rate_limit(
    client: Any, harness: Harness
):
    fields = MultiDict(
        [
            ("resume_text", "first private resume"),
            ("resume_text", "second private resume"),
            ("consent_version", CONSENT_VERSION),
            ("request_id", str(REQUEST_ID)),
        ]
    )

    response = client.post(
        "/v1/analyses",
        data=fields,
        content_type="multipart/form-data",
        headers=authorization(),
    )

    assert response.status_code == 400
    assert parsed_error(response).code is ErrorCode.INVALID_REQUEST
    assert harness.rate_limiter.analysis_checks == []
    assert harness.ai_gateway.calls == []


@pytest.mark.parametrize(
    ("path", "method", "expected_status"),
    [
        ("/private/unknown", "get", 404),
        ("/healthz", "post", 405),
    ],
)
def test_unknown_routes_and_methods_never_become_false_service_outages(
    client: Any, path: str, method: str, expected_status: int
):
    response = getattr(client, method)(path)

    assert response.status_code == expected_status
    assert parsed_error(response).code is ErrorCode.INVALID_REQUEST
