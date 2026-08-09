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
        self.yielded = 0

    def __iter__(self):
        first = len(self._body) // 3
        second = first * 2
        for chunk in (
            self._body[:first],
            self._body[first:second],
            self._body[second:],
        ):
            self._clock[0] += 0.6
            self.yielded += 1
            yield chunk


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
    assert seen[0].headers["Accept-Encoding"] == "identity"


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


@pytest.mark.parametrize(
    ("grace_expiration", "expected_verified_until"),
    [
        (NOW + timedelta(hours=2), NOW + timedelta(hours=2)),
        (NOW + timedelta(days=2), NOW + timedelta(hours=25)),
    ],
)
def test_documented_future_grace_period_keeps_matching_pro_entitlement_active(
    grace_expiration: datetime,
    expected_verified_until: datetime,
):
    entitlement = pro_entitlement(
        (NOW - timedelta(minutes=1)).isoformat().replace("+00:00", "Z"),
        grace_period_expires_date=grace_expiration.isoformat().replace("+00:00", "Z"),
    )
    snapshot = client_for(
        lambda _request: httpx.Response(
            200,
            content=subscriber({"resume_pro": entitlement}),
        )
    ).fetch_plan("rai_account_opaque", deadline=1.0)

    assert snapshot.kind == "pro"
    assert snapshot.entitlement_expires_at == grace_expiration
    assert snapshot.verified_until == expected_verified_until


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
        pro_entitlement(
            "2026-08-07T11:59:00Z",
            grace_period_expires_date="not-a-timestamp",
        ),
        pro_entitlement(
            "2026-08-07T11:59:00Z",
            product_identifier="unknown.product",
            grace_period_expires_date="2026-08-07T14:00:00Z",
        ),
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
    stream = _SlowRevenueCatStream(clock, body)

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=stream)

    with pytest.raises(EntitlementUnavailable):
        client_for(handler, monotonic=lambda: clock[0]).fetch_plan(
            "rai_installation_opaque", deadline=1.0
        )
    assert stream.yielded == 2


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


def lifecycle_event(**event_overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "id": "evt_01",
        "app_id": APP_ID,
        "app_user_id": "rai_account_opaque",
        "original_app_user_id": "rai_installation_opaque",
        "aliases": ["rai_alias_opaque"],
        "type": "INITIAL_PURCHASE",
        "product_id": MONTHLY_PRODUCT,
        "period_type": "NORMAL",
        "purchased_at_ms": int((NOW - timedelta(days=1)).timestamp() * 1000),
        "expiration_at_ms": int((NOW + timedelta(days=30)).timestamp() * 1000),
        "entitlement_id": "resume_pro",
        "entitlement_ids": ["resume_pro"],
        "environment": "PRODUCTION",
        "event_timestamp_ms": int(NOW.timestamp() * 1000),
        "presented_offering_id": "default",
        "transaction_id": "transaction_opaque",
        "original_transaction_id": "original_transaction_opaque",
        "is_family_share": False,
        "country_code": "US",
        "store": "APP_STORE",
    }
    event.update(event_overrides)
    return event


def transfer_event(**event_overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "id": "evt_transfer",
        "app_id": APP_ID,
        "type": "TRANSFER",
        "transferred_from": ["rai_installation_old"],
        "transferred_to": ["rai_account_opaque"],
        "event_timestamp_ms": int(NOW.timestamp() * 1000),
    }
    event.update(event_overrides)
    return event


def temporary_grant_event(**event_overrides: object) -> dict[str, object]:
    event: dict[str, object] = {
        "id": "evt_temporary_grant",
        "app_id": APP_ID,
        "app_user_id": "rai_temporary_grant_opaque",
        "type": "TEMPORARY_ENTITLEMENT_GRANT",
        "event_timestamp_ms": int(NOW.timestamp() * 1000),
        "store": "APP_STORE",
    }
    event.update(event_overrides)
    return event


def encoded_event(event: dict[str, object]) -> bytes:
    return json.dumps({"api_version": "1.0", "event": event}).encode()


def event_body(**event_overrides: object) -> bytes:
    return encoded_event(lifecycle_event(**event_overrides))


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
        event_body(type="REFUND"),
        encoded_event(transfer_event(environment="UNKNOWN")),
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
        "SUBSCRIPTION_EXTENDED",
        "REFUND_REVERSED",
    ],
)
def test_webhook_accepts_realistic_lifecycle_events_and_late_delivery(event_type: str):
    event = lifecycle_event(
        id=f"evt_{event_type.lower()}",
        type=event_type,
        product_id=ANNUAL_PRODUCT,
        environment="SANDBOX",
        event_timestamp_ms=int((NOW - timedelta(days=90)).timestamp() * 1000),
        purchased_at_ms=int((NOW - timedelta(days=120)).timestamp() * 1000),
        future_provider_field={"revision": 4},
    )
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        json.dumps(
            {"api_version": "1.0", "event": event, "future_envelope_field": True}
        ).encode(),
    )
    assert decoded.event_type == event_type
    assert decoded.product_id == ANNUAL_PRODUCT


def test_webhook_accepts_documented_transfer_shape_without_lifecycle_fields():
    event = transfer_event(
        event_timestamp_ms=int((NOW - timedelta(days=30)).timestamp() * 1000),
        future_provider_field="accepted",
    )
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


def test_temporary_entitlement_grant_invalidates_its_reduced_identity_shape():
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        encoded_event(temporary_grant_event()),
    )
    assert decoded.event_type == "TEMPORARY_ENTITLEMENT_GRANT"
    assert decoded.affected_app_user_ids == ("rai_temporary_grant_opaque",)
    assert decoded.product_id is None
    assert decoded.entitlement_ids == ()
    assert not hasattr(decoded, "plan")

    cache = VerifiedEntitlementCache(
        fakeredis.FakeRedis(),
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    snapshot = client_for(
        lambda _request: httpx.Response(
            200,
            content=subscriber(
                {"resume_pro": pro_entitlement("2026-09-01T00:00:00Z")}
            ),
        )
    ).fetch_plan("rai_temporary_grant_opaque", deadline=1.0)
    cache.put_verified("rai_temporary_grant_opaque", snapshot, observed_at=NOW)

    assert cache.claim_webhook_event(
        decoded.event_id,
        decoded.effective_at,
        decoded.affected_app_user_ids,
    )
    assert cache.get("rai_temporary_grant_opaque") is None


@pytest.mark.parametrize("event_type", ["CANCELLATION", "REFUND_REVERSED"])
def test_webhook_accepts_documented_null_entitlements_for_lifecycle_invalidation(
    event_type: str,
):
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        encoded_event(lifecycle_event(type=event_type, entitlement_ids=None)),
    )
    assert decoded.event_type == event_type
    assert decoded.entitlement_ids == ()
    assert decoded.affected_app_user_ids == (
        "rai_account_opaque",
        "rai_installation_opaque",
        "rai_alias_opaque",
    )
    assert not hasattr(decoded, "plan")


@pytest.mark.parametrize(
    ("app_user_id", "original_app_user_id", "affected"),
    [
        ("rai_account_opaque", None, ("rai_account_opaque",)),
        (None, "rai_installation_opaque", ("rai_installation_opaque",)),
    ],
)
def test_lifecycle_null_always_fields_accept_partial_identity_for_invalidation_only(
    app_user_id: str | None,
    original_app_user_id: str | None,
    affected: tuple[str, ...],
):
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        encoded_event(
            lifecycle_event(
                type="CANCELLATION",
                app_user_id=app_user_id,
                original_app_user_id=original_app_user_id,
                aliases=None,
                product_id=None,
                entitlement_ids=None,
                environment=None,
            )
        ),
    )

    assert decoded.affected_app_user_ids == affected
    assert decoded.product_id is None
    assert decoded.entitlement_ids == ()
    assert not hasattr(decoded, "plan")


def test_lifecycle_null_always_fields_still_require_an_affected_identity():
    with pytest.raises(InvalidRevenueCatWebhook):
        webhook().decode(
            {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
            encoded_event(
                lifecycle_event(
                    type="CANCELLATION",
                    app_user_id=None,
                    original_app_user_id=None,
                    aliases=None,
                    product_id=None,
                    entitlement_ids=None,
                    environment=None,
                )
            ),
        )


@pytest.mark.parametrize("missing", ["product_id", "entitlement_ids", "environment"])
def test_lifecycle_webhooks_require_documented_product_entitlement_and_environment(
    missing: str,
):
    event = lifecycle_event()
    del event[missing]
    with pytest.raises(InvalidRevenueCatWebhook):
        webhook().decode(
            {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
            encoded_event(event),
        )


def test_webhook_accepts_64_unique_lifecycle_identities_and_collapses_duplicates():
    aliases = ["rai_account_opaque", "rai_installation_opaque"] + [
        f"rai_alias_{index:02d}" for index in range(62)
    ]
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        encoded_event(lifecycle_event(aliases=aliases)),
    )
    assert len(decoded.affected_app_user_ids) == 64
    assert decoded.affected_app_user_ids[:2] == (
        "rai_account_opaque",
        "rai_installation_opaque",
    )


def test_webhook_rejects_65_unique_transfer_identities_across_lists():
    event = transfer_event(
        transferred_from=[f"rai_from_{index:02d}" for index in range(33)],
        transferred_to=[f"rai_to_{index:02d}" for index in range(32)],
    )
    with pytest.raises(InvalidRevenueCatWebhook):
        webhook().decode(
            {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
            encoded_event(event),
        )


def test_webhook_collapses_cross_list_transfer_duplicates_before_64_identity_limit():
    identities = [f"rai_shared_{index:02d}" for index in range(64)]
    decoded = webhook().decode(
        {"Authorization": f"Bearer {WEBHOOK_SECRET}"},
        encoded_event(
            transfer_event(
                transferred_from=identities,
                transferred_to=identities,
            )
        ),
    )
    assert decoded.affected_app_user_ids == tuple(identities)


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
        first_started.set()
        assert release_first.wait(timeout=5)
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
        assert first_started.wait(timeout=5)
        assert cache.claim_webhook_event(event_id, NOW, affected_ids)
        release_first.set()
        with pytest.raises(EntitlementUnavailable):
            future.result(timeout=5)

    assert calls == 1
    assert cache.get("rai_account_private") is None


def test_webhook_churn_uses_one_provider_request_and_stays_within_total_deadline():
    redis_client = fakeredis.FakeRedis()
    clock = [10.0]
    cache = VerifiedEntitlementCache(
        redis_client,
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        clock[0] += 0.8
        assert cache.claim_webhook_event(
            f"evt_race_{calls}", NOW, ["rai_account_private"]
        )
        return httpx.Response(
            200,
            content=subscriber(
                {"resume_pro": pro_entitlement("2026-09-01T00:00:00Z")}
            ),
        )

    verifier = RevenueCatPlanVerifier(
        cache,
        client_for(handler, monotonic=lambda: clock[0]),
        monotonic=lambda: clock[0],
    )
    with pytest.raises(EntitlementUnavailable):
        verifier.verify("rai_account_private", deadline=1.0)

    assert calls == 1
    assert clock[0] - 10.0 <= 1.0
    assert cache.get("rai_account_private") is None


def test_verifier_subtracts_cache_latency_from_the_single_provider_deadline():
    clock = [20.0]
    cache = VerifiedEntitlementCache(
        fakeredis.FakeRedis(),
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    original_get = cache.get_with_generation

    def delayed_get(app_user_id: str):
        clock[0] += 0.7
        return original_get(app_user_id)

    cache.get_with_generation = delayed_get  # type: ignore[method-assign]
    calls = 0
    transport_timeouts: list[float] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        transport_timeouts.append(request.extensions["timeout"]["read"])
        clock[0] += 0.4
        return httpx.Response(200, content=subscriber({}))

    verifier = RevenueCatPlanVerifier(
        cache,
        client_for(handler, monotonic=lambda: clock[0]),
        monotonic=lambda: clock[0],
    )
    with pytest.raises(EntitlementUnavailable):
        verifier.verify("rai_account_private", deadline=1.0)

    assert calls == 1
    assert 0 < transport_timeouts[0] <= 0.300_001
    assert clock[0] - 20.0 <= 1.1
