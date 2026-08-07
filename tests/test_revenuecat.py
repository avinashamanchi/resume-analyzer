from __future__ import annotations

import json
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


def subscriber(entitlements: dict[str, object]) -> bytes:
    return json.dumps({"subscriber": {"entitlements": entitlements}}).encode()


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


def test_fetch_plan_accepts_only_exact_active_resume_pro_and_fixed_encoded_url():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(
            200,
            content=subscriber(
                {
                    "resume_pro_plus": {"expires_date": "2099-01-01T00:00:00Z"},
                    "resume_pro": {"expires_date": "2026-09-01T00:00:00Z"},
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
        subscriber({"resume_pro": {"expires_date": "2026-08-07T11:59:59Z"}}),
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
        {"resume_pro": {"expires_date": expiration.isoformat().replace("+00:00", "Z")}}
    )
    snapshot = client_for(
        lambda _request: httpx.Response(200, content=payload)
    ).fetch_plan("rai_installation_opaque", deadline=1.0)
    assert snapshot.verified_until == expiration


def test_fractional_revenuecat_expiration_and_webhook_timestamp_are_accepted():
    expiration = NOW + timedelta(hours=2, milliseconds=125)
    payload = subscriber(
        {"resume_pro": {"expires_date": expiration.isoformat().replace("+00:00", "Z")}}
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


def test_fetch_rejects_elapsed_wall_deadline_after_body_completion():
    ticks = iter([1.0, 3.1])
    with pytest.raises(EntitlementUnavailable):
        client_for(
            lambda _request: httpx.Response(200, content=subscriber({})),
            monotonic=lambda: next(ticks),
        ).fetch_plan("rai_installation_opaque", deadline=2.0)


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
        "event_timestamp_ms": int(NOW.timestamp() * 1000),
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
        event_body(event_timestamp_ms=int((NOW - timedelta(hours=2)).timestamp() * 1000)),
        event_body(aliases=["x"] * 33),
        b'{"api_version":"1.0","api_version":"1.0","event":{}}',
    ],
)
def test_webhook_rejects_wrong_envelope_app_skew_bounds_and_duplicate_json(body: bytes):
    with pytest.raises(InvalidRevenueCatWebhook):
        webhook().decode({"Authorization": f"Bearer {WEBHOOK_SECRET}"}, body)


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


def test_webhook_claim_is_atomic_hmac_only_and_out_of_order_does_not_invalidate_newer_state():
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

    assert cache.claim_webhook_event(
        "evt_new", NOW + timedelta(minutes=1), ["rai_account_private"]
    )
    assert cache.get("rai_account_private") is None
    cache.put_verified(
        "rai_account_private", snapshot, observed_at=NOW + timedelta(minutes=2)
    )
    assert cache.claim_webhook_event(
        "evt_old", NOW, ["rai_account_private"]
    )
    assert cache.get("rai_account_private") is not None
    assert not cache.claim_webhook_event(
        "evt_old", NOW, ["rai_account_private"]
    )
    rendered = repr(redis_client.keys("*") + list(redis_client.mget(redis_client.keys("*"))))
    assert "rai_account_private" not in rendered
    assert "evt_old" not in rendered
