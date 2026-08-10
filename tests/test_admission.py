from __future__ import annotations

import importlib
import importlib.util
import inspect
from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import fakeredis
import pytest
from redis.exceptions import ConnectionError as RedisConnectionError
from werkzeug.test import EnvironBuilder
from werkzeug.wrappers import Response

from server.app import ServiceRegistry, create_app
from server.config import Settings
from server.errors import ErrorCode
from server.installations import InstallationClaims


def test_admission_module_exposes_the_capacity_contract():
    specification = importlib.util.find_spec("server.admission")
    assert specification is not None, "server.admission is missing"
    module = importlib.import_module("server.admission")
    for name in (
        "AdmissionController",
        "AdmissionDecision",
        "AdmissionLease",
        "AdmissionRejected",
        "AdmissionRequest",
        "RedisCapacityStore",
    ):
        assert hasattr(module, name), f"{name} is missing"


def _admission_types():
    module = importlib.import_module("server.admission")
    return (
        module.AdmissionController,
        module.AdmissionRejected,
        module.AdmissionRequest,
        module.RedisCapacityStore,
    )


def _request(
    index: int,
    *,
    source: str = "reviewed_text",
    ai_requested: bool = False,
    content_length: int = 2_048,
):
    _controller, _rejected, request_type, _store = _admission_types()
    parameters = inspect.signature(request_type).parameters
    for name in (
        "installation_id",
        "account_id",
        "request_id",
        "source",
        "ai_requested",
        "content_length",
    ):
        assert name in parameters, f"AdmissionRequest.{name} is missing"
    return request_type(
        installation_id=UUID(int=index + 1),
        account_id=None,
        request_id=UUID(int=10_000 + index),
        source=source,
        ai_requested=ai_requested,
        content_length=content_length,
    )


def _capacity(clock: list[float], redis_client=None):
    _controller, _rejected, _request_type, store_type = _admission_types()
    assert hasattr(store_type, "reserve_provider"), "provider reservation is missing"
    return store_type(
        redis_client or fakeredis.FakeRedis(decode_responses=False),
        key_secret=b"admission-capacity-key" * 2,
        now=lambda: clock[0],
    )


def test_full_provider_breaker_degrades_before_content_work():
    controller_type, _rejected, _request_type, _store_type = _admission_types()
    clock = [1_800_000_000.0]
    capacity = _capacity(clock)
    blockers = [capacity.reserve_provider() for _ in range(48)]
    assert all(blockers)
    assert capacity.reserve_provider() is None

    decision = controller_type(capacity).admit(_request(99, ai_requested=True))

    assert decision.ai_status == "temporarily_unavailable"
    assert decision.allowance is None
    decision.lease.release()
    for blocker in blockers:
        blocker.release()


def test_global_pdf_breaker_refuses_the_ninth_pdf_across_processes():
    controller_type, rejected_type, _request_type, _store_type = _admission_types()
    clock = [1_800_000_000.0]
    capacity = _capacity(clock)
    controllers = [controller_type(capacity) for _ in range(5)]
    admitted = [
        controllers[index // 2].admit(_request(index, source="pdf"))
        for index in range(8)
    ]

    with pytest.raises(rejected_type) as caught:
        controllers[4].admit(_request(9, source="pdf"))

    assert caught.value.code is ErrorCode.CAPACITY_LIMITED
    assert caught.value.retry_after_seconds >= 1
    for decision in admitted:
        decision.lease.release()


def test_process_pdf_count_and_bytes_are_released_exactly_once():
    controller_type, rejected_type, _request_type, _store_type = _admission_types()
    clock = [1_800_000_000.0]
    controller = controller_type(_capacity(clock))
    first = controller.admit(
        _request(1, source="pdf", content_length=10_500_000)
    )
    with pytest.raises(rejected_type) as caught:
        controller.admit(_request(2, source="pdf", content_length=10_500_000))
    assert caught.value.code is ErrorCode.CAPACITY_LIMITED

    first.lease.release()
    first.lease.release()
    replacement = controller.admit(
        _request(3, source="pdf", content_length=10_500_000)
    )
    replacement.lease.release()


def test_global_token_bucket_is_atomic_at_twenty_request_burst():
    controller_type, rejected_type, _request_type, _store_type = _admission_types()
    clock = [1_800_000_000.0]
    redis_client = fakeredis.FakeRedis(decode_responses=False)
    controllers = [controller_type(_capacity(clock, redis_client)) for _ in range(40)]

    def admit(index: int) -> bool:
        try:
            decision = controllers[index].admit(_request(index))
            decision.lease.release()
            return True
        except rejected_type as error:
            assert error.code is ErrorCode.CAPACITY_LIMITED
            return False

    with ThreadPoolExecutor(max_workers=40) as workers:
        results = list(workers.map(admit, range(40)))

    assert sum(results) == 20


def test_one_hundred_installations_behind_shared_nat_are_not_denied_by_ip():
    controller_type, _rejected, _request_type, _store_type = _admission_types()
    clock = [1_800_000_000.0]
    controller = controller_type(_capacity(clock))
    decisions = []
    for index in range(100):
        if index and index % 5 == 0:
            clock[0] += 1
        decision = controller.admit(_request(index))
        decisions.append(decision)
        decision.lease.release()
    assert len(decisions) == 100


class _UnavailableRedis:
    def pipeline(self):
        raise RedisConnectionError("private redis address")


def test_redis_outage_allows_only_two_reviewed_text_scores_per_process_second():
    controller_type, rejected_type, _request_type, store_type = _admission_types()
    clock = [1_800_000_000.0]
    capacity = store_type(
        _UnavailableRedis(),
        key_secret=b"admission-capacity-key" * 2,
        now=lambda: clock[0],
    )
    controller = controller_type(capacity, now=lambda: clock[0])

    first = controller.admit(_request(1))
    second = controller.admit(_request(2, ai_requested=True))
    assert first.ai_status == "not_requested"
    assert second.ai_status == "temporarily_unavailable"
    with pytest.raises(rejected_type) as third:
        controller.admit(_request(3))
    with pytest.raises(rejected_type) as pdf:
        controller.admit(_request(4, source="pdf"))
    assert third.value.code is ErrorCode.CAPACITY_LIMITED
    assert pdf.value.code is ErrorCode.CAPACITY_LIMITED
    first.lease.release()
    second.lease.release()


def test_identity_rate_limit_rejects_analysis_but_provider_limit_degrades_only_ai():
    controller_type, _rejected, _request_type, _store_type = _admission_types()
    assert "rate_limiter" in inspect.signature(controller_type).parameters
    clock = [1_800_000_000.0]

    class Decision:
        def __init__(self, analysis: bool, provider: bool) -> None:
            self.analysis_allowed = analysis
            self.provider_allowed = provider
            self.retry_after_seconds = 17

    class Limiter:
        decision = Decision(True, False)

        def check_v2_analysis(self, *_args, **_kwargs):
            return self.decision

    limiter = Limiter()
    controller = controller_type(_capacity(clock), rate_limiter=limiter)
    degraded = controller.admit(_request(20, ai_requested=True))
    assert degraded.ai_status == "temporarily_unavailable"
    degraded.lease.release()

    limiter.decision = Decision(False, False)
    with pytest.raises(Exception) as caught:
        controller.admit(_request(21))
    assert caught.value.code is ErrorCode.RATE_LIMITED
    assert caught.value.retry_after_seconds == 17


def test_flask_admits_v2_from_headers_without_reading_body_and_releases_teardown():
    assert "admission" in inspect.signature(ServiceRegistry).parameters
    module = importlib.import_module("server.admission")
    body_reads = [0]

    class UnreadBody:
        def read(self, *_args, **_kwargs):
            body_reads[0] += 1
            raise AssertionError("multipart body read before admission")

        readline = read
        readinto = read

        def seek(self, *_args, **_kwargs):
            return 0

        def tell(self):
            return 0

    released = [0]

    class Marker:
        def release(self):
            released[0] += 1

    class Tokens:
        def verify(self, token: str):
            assert token == "signed-installation"
            return InstallationClaims(UUID(int=7), 1, 2_000_000_000, 1)

        def installation_digest(self, _claims):
            return "inst_" + "a" * 43

    class Admission:
        def __init__(self):
            self.requests = []

        def admit(self, request):
            assert body_reads[0] == 0
            self.requests.append(request)
            lease = module.AdmissionLease()
            lease.add(Marker())
            return module.AdmissionDecision("not_requested", None, lease)

    admission = Admission()
    registry = ServiceRegistry(
        pdf_parser=None,
        scorer=None,
        ai_gateway=None,
        installation_tokens=Tokens(),
        rate_limiter=None,
        leases=None,
        admission=admission,
        account_tokens=None,
    )
    settings = Settings(
        app_env="testing",
        debug=False,
        groq_api_key="",
        groq_model="llama-3.3-70b-versatile",
        installation_signing_key="",
        redis_url="",
        allowed_web_origins=("http://localhost:3000",),
        provider_deadline_seconds=8,
        request_deadline_seconds=10,
    )
    app = create_app(settings, registry)
    request_id = "00000000-0000-4000-8000-000000000123"
    environment = EnvironBuilder(
        path="/v2/analyses",
        method="POST",
        headers={
            "Authorization": "Installation signed-installation",
            "Content-Type": "multipart/form-data; boundary=fixture",
            "X-Resume-Source": "reviewed_text",
            "X-Resume-AI": "not_requested",
            "X-Resume-Request-ID": request_id,
        },
        input_stream=UnreadBody(),
    ).get_environ()
    environment["CONTENT_LENGTH"] = "2048"

    response = Response.from_app(app, environment)

    assert response.status_code == 404
    assert body_reads == [0]
    assert len(admission.requests) == 1
    assert admission.requests[0].request_id == UUID(request_id)
    assert admission.requests[0].content_length == 2_048
    assert released == [1]


@pytest.mark.parametrize(
    ("header_name", "header_value"),
    [
        ("X-Resume-Source", "raw_pdf"),
        ("X-Resume-AI", "yes"),
        ("X-Resume-AI", None),
        ("X-Resume-Request-ID", "NOT-A-UUID"),
        ("X-Resume-Request-ID", "00000000-0000-4000-8000-000000000ABC"),
    ],
)
def test_invalid_v2_admission_headers_are_rejected_without_reading_body(
    header_name: str,
    header_value: str | None,
):
    body_reads = [0]

    class UnreadBody:
        def read(self, *_args, **_kwargs):
            body_reads[0] += 1
            raise AssertionError("invalid request body was read")

        readline = read
        readinto = read

        def seek(self, *_args, **_kwargs):
            return 0

        def tell(self):
            return 0

    class Tokens:
        def verify(self, _token: str):
            return InstallationClaims(UUID(int=8), 1, 2_000_000_000, 1)

    class NeverAdmit:
        def admit(self, _request):
            raise AssertionError("invalid headers reached admission")

    registry = ServiceRegistry(
        pdf_parser=None,
        scorer=None,
        ai_gateway=None,
        installation_tokens=Tokens(),
        rate_limiter=None,
        leases=None,
        admission=NeverAdmit(),
    )
    app = create_app(
        Settings(
            app_env="testing",
            debug=False,
            groq_api_key="",
            groq_model="llama-3.3-70b-versatile",
            installation_signing_key="",
            redis_url="",
            allowed_web_origins=("http://localhost:3000",),
            provider_deadline_seconds=8,
            request_deadline_seconds=10,
        ),
        registry,
    )
    headers = {
        "Authorization": "Installation signed-installation",
        "Content-Type": "multipart/form-data; boundary=fixture",
        "X-Resume-Source": "reviewed_text",
        "X-Resume-AI": "not_requested",
        "X-Resume-Request-ID": "00000000-0000-4000-8000-000000000123",
    }
    if header_value is None:
        del headers[header_name]
    else:
        headers[header_name] = header_value
    environment = EnvironBuilder(
        path="/v2/analyses",
        method="POST",
        headers=headers,
        input_stream=UnreadBody(),
    ).get_environ()
    environment["CONTENT_LENGTH"] = "2048"

    response = Response.from_app(app, environment)

    assert response.status_code == 400
    assert response.get_json()["code"] == ErrorCode.INVALID_REQUEST
    assert body_reads == [0]


def test_v2_account_token_is_bound_to_the_verified_installation_before_admission():
    module = importlib.import_module("server.admission")
    verified = []
    admitted_accounts = []

    class Tokens:
        def verify(self, _token: str):
            return InstallationClaims(UUID(int=9), 1, 2_000_000_000, 1)

        def installation_digest(self, claims):
            assert claims.installation_id == UUID(int=9)
            return "inst_" + "b" * 43

    class AccountClaims:
        account_id = "acct_bound_identity_0009"

    class AccountTokens:
        def verify(self, token: str, digest: str):
            verified.append((token, digest))
            return AccountClaims()

    class Admission:
        def admit(self, admission_request):
            admitted_accounts.append(admission_request.account_id)
            return module.AdmissionDecision(
                "not_requested",
                None,
                module.AdmissionLease(),
            )

    app = create_app(
        Settings(
            app_env="testing",
            debug=False,
            groq_api_key="",
            groq_model="llama-3.3-70b-versatile",
            installation_signing_key="",
            redis_url="",
            allowed_web_origins=("http://localhost:3000",),
            provider_deadline_seconds=8,
            request_deadline_seconds=10,
        ),
        ServiceRegistry(
            pdf_parser=None,
            scorer=None,
            ai_gateway=None,
            installation_tokens=Tokens(),
            rate_limiter=None,
            leases=None,
            admission=Admission(),
            account_tokens=AccountTokens(),
        ),
    )
    response = app.test_client().post(
        "/v2/analyses",
        data=b"fixture",
        headers={
            "Authorization": "Installation signed-installation",
            "Content-Type": "multipart/form-data; boundary=fixture",
            "X-Resume-Source": "reviewed_text",
            "X-Resume-AI": "not_requested",
            "X-Resume-Request-ID": "00000000-0000-4000-8000-000000000123",
            "X-Resume-Account": "signed-account-token",
        },
    )

    assert response.status_code == 404
    assert verified == [("signed-account-token", "inst_" + "b" * 43)]
    assert admitted_accounts == ["acct_bound_identity_0009"]
