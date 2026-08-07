from __future__ import annotations

import json
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta

import fakeredis
import httpx
import pytest

from server.entitlements import VerifiedEntitlementCache
from server.revenuecat import (
    EntitlementUnavailable,
    InvalidRevenueCatWebhook,
    RevenueCatClient,
    RevenueCatPlanVerifier,
    RevenueCatWebhook,
)


NOW = datetime(2026, 8, 7, 12, tzinfo=UTC)
API_KEY = "sk_" + "s" * 40
WEBHOOK_SECRET = "w" * 40
APP_ID = "app_resume_ai"
MONTHLY_PRODUCT = "com.avinashamanchi.resumeai.pro.monthly"
ANNUAL_PRODUCT = "com.avinashamanchi.resumeai.pro.annual"


def subscriber(entitlements: dict[str, object]) -> bytes:
    return json.dumps({"subscriber": {"entitlements": entitlements}}).encode()


def pro_entitlement(
    expires_date: str,
    *,
    product_identifier: str = MONTHLY_PRODUCT,
    **future_fields: object,
) -> dict[str, object]:
    return {
        "expires_date": expires_date,
        "grace_period_expires_date": None,
        "product_identifier": product_identifier,
        "purchase_date": "2026-08-01T12:00:00Z",
        **future_fields,
    }


class _SlowRevenueCatStream(httpx.SyncByteStream):
    def __init__(self, clock: list[float], body: bytes) -> None:
        self._clock = clock
        self._body = body

    def __iter__(self):
        midpoint = len(self._body) // 2
        self._clock[0] += 0.6
        yield self._body[:midpoint]
        self._clock[0] += 0.6
        yield self._body[midpoint:]


def client_for(
    handler,
    *,
    now=lambda: NOW,
    monotonic=lambda: 1.0,
) -> RevenueCatClient:
    http_client = httpx.Client(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
    )
    return RevenueCatClient(
        secret_api_key=API_KEY,
        http_client=http_client,
        now=now,
        monotonic=monotonic,
    )


def test_fetch_plan_accepts_documented_active_resume_pro_with_bounded_future_fields():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            content=subscriber(
                {
                    "resume_pro_plus": {"expires_date": "2099-01-01T00:00:00Z"},
                    "resume_pro": pro_entitlement(
                        "2026-09-01T00:00:00Z",
                        future_provider_field={"version": 2, "flags": [True, None]},
                    ),
                }
            ),
        )

    snapshot = client_for(handler).fetch_plan("rai account/opaque", deadline=2.0)

    assert snapshot.kind == "pro"
    assert snapshot.entitlement_expires_at == datetime(2026, 9, 1, tzinfo=UTC)
    assert snapshot.verified_until == NOW + timedelta(hours=25)
    assert len(seen) == 1
    assert str(seen[0].url) == (
        "https://api.revenuecat.com/v1/subscribers/rai%20account%2Fopaque"
    )
    assert seen[0].headers["Authorization"] == f"Bearer {API_KEY}"


def test_missing_or_expired_exact_entitlement_is_verified_free_for_at_most_25_hours():
    payloads = [
        subscriber({"other": {"expires_date": "2099-01-01T00:00:00Z"}}),
        subscriber({"resume_pro": pro_entitlement("2026-08-07T11:59:59Z")}),
    ]
    for payload in payloads:
        snapshot = client_for(
            lambda _request, body=payload: httpx.Response(200, content=body)
        ).fetch_plan("rai_installation_opaque", deadline=1.5)
        assert snapshot.kind == "free"
        assert snapshot.entitlement_expires_at is None
        assert snapshot.verified_until == NOW + timedelta(hours=25)


def test_pro_verification_is_capped_by_entitlement_expiration():
    expiration = NOW + timedelta(hours=2)
    payload = subscriber(
        {"resume_pro": pro_entitlement(expiration.isoformat().replace("+00:00", "Z"))}
    )
    snapshot = client_for(
        lambda _request: httpx.Response(200, content=payload)
    ).fetch_plan("rai_installation_opaque", deadline=1.0)
    assert snapshot.verified_until == expiration


def test_fractional_revenuecat_expiration_and_webhook_timestamp_are_accepted():
    expiration = NOW + timedelta(hours=2, milliseconds=125)
    payload = subscriber(
        {"resume_pro": pro_entitlement(expiration.isoformat().replace("+00:00", "Z"))}
    )
    snapshot = client_for(
        lambda _request: httpx.Response(200, content=payload)
    ).fetch_plan("rai_installation_opaque", deadline=1.0)
    assert snapshot.entitlement_expires_at == expiration

    timestamp_ms = int((NOW + timedelta(milliseconds=321)).timestamp() * 1000)
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        event_body(event_timestamp_ms=timestamp_ms),
    )
    assert decoded.effective_at.microsecond == 321_000

    cache = VerifiedEntitlementCache(
        fakeredis.FakeRedis(),
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW.replace(microsecond=123_000),
    )
    assert cache.claim_webhook_event(
        "evt_fractional", decoded.effective_at, ["rai_installation_opaque"]
    )


@pytest.mark.parametrize("deadline", [0, -1, float("nan"), float("inf"), 2.01, True])
def test_fetch_rejects_invalid_deadlines_without_network(deadline: object):
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, content=subscriber({}))

    with pytest.raises(EntitlementUnavailable):
        client_for(handler).fetch_plan("rai_installation_opaque", deadline=deadline)  # type: ignore[arg-type]
    assert calls == 0


@pytest.mark.parametrize("status", [400, 429, 500, 503])
def test_fetch_makes_one_request_without_retry_and_hides_upstream_failure(status: int):
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(status, content=b"private-upstream-body")

    with pytest.raises(EntitlementUnavailable) as caught:
        client_for(handler).fetch_plan("rai_private_identifier", deadline=1.0)
    assert calls == 1
    assert str(caught.value) == "entitlement_unavailable"
    assert "private" not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_fetch_enforces_declared_and_streamed_body_caps_and_strict_json():
    bad_responses = [
        httpx.Response(200, headers={"Content-Length": str(256 * 1024 + 1)}, content=b"{}"),
        httpx.Response(200, content=b"{" + b"x" * (256 * 1024) + b"}"),
        httpx.Response(200, content=b'{"subscriber":{"entitlements":{},"entitlements":{}}}'),
        httpx.Response(200, content=b'{"subscriber":{"entitlements":NaN}}'),
        httpx.Response(200, content=b"\xff"),
    ]
    for response in bad_responses:
        with pytest.raises(EntitlementUnavailable):
            client_for(lambda _request, value=response: value).fetch_plan(
                "rai_installation_opaque", deadline=1.0
            )


@pytest.mark.parametrize(
    "entitlement",
    [
        {"expires_date": "2026-09-01T00:00:00Z"},
        pro_entitlement("2026-09-01T00:00:00Z", product_identifier="unknown.product"),
        pro_entitlement("2026-09-01T00:00:00Z") | {"store": 123},
        pro_entitlement("2026-09-01T00:00:00Z") | {"future": float("inf")},
    ],
)
def test_fetch_fails_closed_for_missing_or_unknown_product_and_malformed_fields(
    entitlement: dict[str, object],
):
    with pytest.raises(EntitlementUnavailable):
        client_for(
            lambda _request: httpx.Response(
                200, content=subscriber({"resume_pro": entitlement})
            )
        ).fetch_plan("rai_installation_opaque", deadline=1.0)


def test_fetch_rejects_elapsed_wall_deadline_after_body_completion():
    ticks = iter([1.0, 3.1])
    with pytest.raises(EntitlementUnavailable):
        client_for(
            lambda _request: httpx.Response(200, content=subscriber({})),
            monotonic=lambda: next(ticks),
        ).fetch_plan("rai_installation_opaque", deadline=2.0)


def test_fetch_enforces_total_wall_deadline_while_body_is_streaming():
    clock = [10.0]
    body = subscriber({})

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=_SlowRevenueCatStream(clock, body))

    with pytest.raises(EntitlementUnavailable):
        client_for(handler, monotonic=lambda: clock[0]).fetch_plan(
            "rai_installation_opaque", deadline=1.0
        )


def test_client_rejects_redirect_following_and_non_server_credentials():
    redirecting = httpx.Client(
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, content=subscriber({}))
        ),
        follow_redirects=True,
    )
    for key in ("appl_" + "p" * 40, "sk_short", ""):
        with pytest.raises(ValueError):
            RevenueCatClient(secret_api_key=key, http_client=redirecting)
    with pytest.raises(ValueError, match="redirect"):
        RevenueCatClient(secret_api_key=API_KEY, http_client=redirecting)


def event_body(**event_overrides: object) -> bytes:
    event: dict[str, object] = {
        "id": "evt_01",
        "app_id": APP_ID,
        "app_user_id": "rai_account_opaque",
        "original_app_user_id": "rai_installation_opaque",
        "aliases": ["rai_alias_opaque"],
        "transferred_from": ["rai_installation_old"],
        "transferred_to": ["rai_account_opaque"],
        "type": "TRANSFER",
        "product_id": "com.avinashamanchi.resumeai.pro.monthly",
        "entitlement_ids": ["resume_pro"],
        "environment": "PRODUCTION",
        "event_timestamp_ms": int(NOW.timestamp() * 1000),
        "future_provider_field": {"schema": 2, "enabled": True},
    }
    event.update(event_overrides)
    return json.dumps({"api_version": "1.0", "event": event}).encode()


def webhook() -> RevenueCatWebhook:
    return RevenueCatWebhook(
        webhook_secret=WEBHOOK_SECRET,
        app_id=APP_ID,
        now=lambda: NOW,
    )


def test_webhook_validates_bearer_and_decodes_all_affected_identities_without_granting():
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"}, event_body()
    )
    assert decoded.event_id == "evt_01"
    assert decoded.app_user_id == "rai_account_opaque"
    assert decoded.affected_app_user_ids == (
        "rai_account_opaque",
        "rai_installation_opaque",
        "rai_alias_opaque",
        "rai_installation_old",
    )
    assert not hasattr(decoded, "plan")


@pytest.mark.parametrize(
    "authorization",
    [
        "",
        WEBHOOK_SECRET,
        f"bearer {WEBHOOK_SECRET}",
        f"Bearer  {WEBHOOK_SECRET}",
        f"Bearer {WEBHOOK_SECRET},extra",
        "Bearer wrong-secret",
    ],
)
def test_webhook_rejects_every_nonexact_bearer(authorization: str):
    with pytest.raises(InvalidRevenueCatWebhook) as caught:
        webhook().decode({"Authorization": authorization}, event_body())
    assert str(caught.value) == "invalid_revenuecat_webhook"
    assert WEBHOOK_SECRET not in repr(caught.value)


@pytest.mark.parametrize(
    "body",
    [
        json.dumps({"api_version": "2.0", "event": {}}).encode(),
        event_body(app_id="another-app"),
        event_body(event_timestamp_ms=int((NOW + timedelta(minutes=6)).timestamp() * 1000)),
        event_body(product_id="unknown.product"),
        event_body(entitlement_ids=["another_entitlement"]),
        event_body(environment="UNKNOWN"),
        event_body(aliases=["x"] * 33),
        b'{"api_version":"1.0","api_version":"1.0","event":{}}',
    ],
)
def test_webhook_rejects_wrong_envelope_app_skew_bounds_and_duplicate_json(body: bytes):
    with pytest.raises(InvalidRevenueCatWebhook):
        webhook().decode({"Authorization": f"Bearer {WEBHOOK_SECRET}"}, body)


@pytest.mark.parametrize(
    "event_type",
    [
        "INITIAL_PURCHASE",
        "RENEWAL",
        "CANCELLATION",
        "EXPIRATION",
        "REFUND",
    ],
)
def test_webhook_accepts_realistic_lifecycle_events_and_late_delivery(event_type: str):
    event = {
        "id": f"evt_{event_type.lower()}",
        "app_id": APP_ID,
        "app_user_id": "rai_account_opaque",
        "original_app_user_id": "rai_installation_opaque",
        "aliases": ["rai_alias_opaque"],
        "type": event_type,
        "product_id": ANNUAL_PRODUCT,
        "entitlement_ids": ["resume_pro"],
        "environment": "SANDBOX",
        "event_timestamp_ms": int((NOW - timedelta(days=90)).timestamp() * 1000),
        "purchased_at_ms": int((NOW - timedelta(days=120)).timestamp() * 1000),
        "store": "APP_STORE",
        "future_provider_field": {"revision": 4},
    }
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        json.dumps(
            {"api_version": "1.0", "event": event, "future_envelope_field": True}
        ).encode(),
    )
    assert decoded.event_type == event_type
    assert decoded.product_id == ANNUAL_PRODUCT


def test_webhook_accepts_documented_transfer_shape_without_lifecycle_fields():
    event = {
        "id": "evt_transfer",
        "app_id": APP_ID,
        "type": "TRANSFER",
        "transferred_from": ["rai_installation_old"],
        "transferred_to": ["rai_account_opaque"],
        "environment": "PRODUCTION",
        "event_timestamp_ms": int((NOW - timedelta(days=30)).timestamp() * 1000),
        "future_provider_field": "accepted",
    }
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        json.dumps({"api_version": "1.0", "event": event}).encode(),
    )
    assert decoded.event_type == "TRANSFER"
    assert decoded.affected_app_user_ids == (
        "rai_installation_old",
        "rai_account_opaque",
    )
    assert decoded.product_id is None


def test_verified_cache_uses_current_snapshot_during_outage_and_stale_cache_fails_closed():
    redis_client = fakeredis.FakeRedis()
    clock = [NOW]
    cache = VerifiedEntitlementCache(
        redis_client,
        key_secret=b"cache-secret" * 4,
        now=lambda: clock[0],
    )
    fetched = client_for(
        lambda _request: httpx.Response(200, content=subscriber({})),
        now=lambda: clock[0],
    ).fetch_plan("rai_installation_opaque", 1.0)
    cache.put_verified("rai_installation_opaque", fetched, observed_at=NOW)

    calls = 0

    def outage(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        raise httpx.ConnectError("private upstream")

    verifier = RevenueCatPlanVerifier(cache, client_for(outage, now=lambda: clock[0]))
    assert verifier.verify("rai_installation_opaque", deadline=1.0).kind == "free"
    assert calls == 0

    clock[0] += timedelta(hours=25)
    with pytest.raises(EntitlementUnavailable):
        verifier.verify("rai_installation_opaque", deadline=1.0)
    assert calls == 1


def test_every_unique_webhook_invalidates_even_with_equal_or_older_timestamp():
    redis_client = fakeredis.FakeRedis()
    cache = VerifiedEntitlementCache(
        redis_client,
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    snapshot = client_for(
        lambda _request: httpx.Response(200, content=subscriber({}))
    ).fetch_plan("rai_account_private", 1.0)
    cache.put_verified("rai_account_private", snapshot, observed_at=NOW)
    _cached, initial_generation = cache.get_with_generation("rai_account_private")
    assert initial_generation == 0

    assert cache.claim_webhook_event(
        "evt_new", NOW + timedelta(minutes=1), ["rai_account_private"]
    )
    assert cache.get("rai_account_private") is None
    _cached, first_generation = cache.get_with_generation("rai_account_private")
    assert first_generation == 1
    cache.put_verified(
        "rai_account_private", snapshot, observed_at=NOW + timedelta(minutes=2)
    )
    assert cache.claim_webhook_event(
        "evt_old", NOW, ["rai_account_private"]
    )
    assert cache.get("rai_account_private") is None
    _cached, second_generation = cache.get_with_generation("rai_account_private")
    assert second_generation == 2
    assert not cache.claim_webhook_event(
        "evt_old", NOW, ["rai_account_private"]
    )
    _cached, duplicate_generation = cache.get_with_generation("rai_account_private")
    assert duplicate_generation == second_generation
    rendered = repr(redis_client.keys("*") + list(redis_client.mget(redis_client.keys("*"))))
    assert "rai_account_private" not in rendered
    assert "evt_old" not in rendered


@pytest.mark.parametrize(
    ("event_id", "affected_ids"),
    [
        ("evt_blocking_refund", ["rai_account_private"]),
        (
            "evt_blocking_transfer",
            ["rai_installation_private", "rai_account_private"],
        ),
    ],
)
def test_webhook_during_fetch_never_returns_or_caches_stale_pro(
    event_id: str, affected_ids: list[str]
):
    redis_client = fakeredis.FakeRedis()
    cache = VerifiedEntitlementCache(
        redis_client,
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    first_started = threading.Event()
    release_first = threading.Event()
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            first_started.set()
            assert release_first.wait(timeout=5)
            return httpx.Response(
                200,
                content=subscriber(
                    {"resume_pro": pro_entitlement("2026-09-01T00:00:00Z")}
                ),
            )
        return httpx.Response(200, content=subscriber({}))

    verifier = RevenueCatPlanVerifier(cache, client_for(handler))
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            verifier.verify, "rai_account_private", deadline=1.0
        )
        assert first_started.wait(timeout=5)
        assert cache.claim_webhook_event(event_id, NOW, affected_ids)
        release_first.set()
        result = future.result(timeout=5)

    assert result.kind == "free"
    assert calls == 2
    cached = cache.get("rai_account_private")
    assert cached is not None and cached.kind == "free"


def test_two_generation_changes_exhaust_single_refetch_and_fail_closed():
    redis_client = fakeredis.FakeRedis()
    cache = VerifiedEntitlementCache(
        redis_client,
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    started = [threading.Event(), threading.Event()]
    releases = [threading.Event(), threading.Event()]
    call_lock = threading.Lock()
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        with call_lock:
            index = calls
            calls += 1
        started[index].set()
        assert releases[index].wait(timeout=5)
        return httpx.Response(
            200,
            content=subscriber(
                {"resume_pro": pro_entitlement("2026-09-01T00:00:00Z")}
            ),
        )

    verifier = RevenueCatPlanVerifier(cache, client_for(handler))
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(
            verifier.verify, "rai_account_private", deadline=1.0
        )
        for index in range(2):
            assert started[index].wait(timeout=5)
            assert cache.claim_webhook_event(
                f"evt_race_{index}", NOW, ["rai_account_private"]
            )
            releases[index].set()
        with pytest.raises(EntitlementUnavailable):
            future.result(timeout=5)

    assert calls == 2
    assert cache.get("rai_account_private") is None
