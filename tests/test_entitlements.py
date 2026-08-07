from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID

import fakeredis
import pytest

from server.entitlements import (
    AiAllowanceStore,
    AllowanceUnavailable,
    PlanVerificationUnavailable,
    VerifiedEntitlementCache,
)
from server.plans import (
    CHARGED_MARKER_RESET_BUFFER_SECONDS,
    FREE_AI_LIMIT,
    PRO_AI_LIMIT,
    PlanSnapshot,
    utc_month_window,
)


NOW = datetime(2026, 8, 31, 23, 59, tzinfo=UTC)


def plan(
    kind: str = "free",
    *,
    now: datetime = NOW,
    verified_for: timedelta = timedelta(hours=1),
) -> PlanSnapshot:
    expiration = now + timedelta(days=30) if kind == "pro" else None
    return PlanSnapshot(
        kind=kind,  # type: ignore[arg-type]
        verified_until=now + verified_for,
        entitlement_expires_at=expiration,
    )


def store(
    redis_client: fakeredis.FakeRedis | None = None,
    *,
    clock: list[datetime] | None = None,
) -> AiAllowanceStore:
    current = clock if clock is not None else [NOW]
    return AiAllowanceStore(
        redis_client or fakeredis.FakeRedis(),
        key_secret=b"allowance-key" * 4,
        now=lambda: current[0],
    )


def test_plan_limits_and_utc_month_rollover_are_exact():
    assert FREE_AI_LIMIT == 3
    assert PRO_AI_LIMIT == 100
    assert utc_month_window(NOW) == (
        "2026-08",
        datetime(2026, 9, 1, tzinfo=UTC),
    )
    assert utc_month_window(datetime(2026, 12, 4, 1, tzinfo=UTC)) == (
        "2026-12",
        datetime(2027, 1, 1, tzinfo=UTC),
    )


def test_month_window_normalizes_aware_offsets_and_rejects_naive_values():
    offset = datetime.fromisoformat("2026-09-01T01:30:00+02:00")
    assert utc_month_window(offset)[0] == "2026-08"
    with pytest.raises(ValueError, match="timezone-aware"):
        utc_month_window(datetime(2026, 8, 1))


def test_fractional_aware_clock_is_valid_while_reset_remains_whole_second():
    current = NOW.replace(microsecond=123_456)
    snapshot = PlanSnapshot(
        "free",
        current + timedelta(hours=1, microseconds=111),
        None,
    )
    allowance_store = AiAllowanceStore(
        fakeredis.FakeRedis(),
        key_secret=b"allowance-key" * 4,
        now=lambda: current,
    )
    reservation = allowance_store.reserve(
        "installation:fractional-clock", snapshot, UUID(int=55)
    )
    assert reservation.begin_dispatch().allowance.resets_at == datetime(
        2026, 9, 1, tzinfo=UTC
    )


def test_plan_snapshot_rejects_unknown_or_stale_shapes():
    with pytest.raises(ValueError):
        PlanSnapshot("unknown", NOW + timedelta(hours=1), None)  # type: ignore[arg-type]
    with pytest.raises(ValueError):
        PlanSnapshot("pro", NOW + timedelta(hours=1), None)
    with pytest.raises(ValueError):
        PlanSnapshot(
            "pro",
            NOW + timedelta(days=2),
            NOW + timedelta(days=1),
        )
    with pytest.raises(ValueError):
        PlanSnapshot("free", NOW + timedelta(hours=1), NOW + timedelta(days=1))


@pytest.mark.parametrize(("kind", "limit"), [("free", 3), ("pro", 100)])
def test_reservation_uses_exact_plan_limit(kind: str, limit: int):
    allowance = store().reserve("installation:one", plan(kind), UUID(int=1))
    assert allowance.snapshot().limit == limit
    decision = allowance.begin_dispatch()
    assert decision.disposition == "started"
    assert decision.allowance.used == 1
    assert decision.allowance.limit == limit


def test_upgrade_downgrade_and_reupgrade_preserve_one_authoritative_counter():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    for request_int in (1, 2):
        assert allowance_store.reserve(
            "installation:one", plan("free"), UUID(int=request_int)
        ).begin_dispatch().disposition == "started"

    upgraded = allowance_store.reserve(
        "installation:one", plan("pro"), UUID(int=3)
    )
    assert upgraded.snapshot().used == 2
    assert upgraded.begin_dispatch().allowance.used == 3

    downgraded = allowance_store.reserve(
        "installation:one", plan("free"), UUID(int=4)
    )
    assert downgraded.snapshot().used == 3
    assert downgraded.begin_dispatch().disposition == "quota_exhausted"

    reupgraded = allowance_store.reserve(
        "installation:one", plan("pro"), UUID(int=5)
    )
    assert reupgraded.snapshot().used == 3
    assert reupgraded.begin_dispatch().allowance.used == 4


def test_duplicate_request_charges_once_and_grants_one_dispatch_across_stores():
    redis_client = fakeredis.FakeRedis()
    first_store = store(redis_client)
    second_store = store(redis_client)
    request_id = UUID(int=9)
    reservations = [
        first_store.reserve("installation:one", plan(), request_id),
        second_store.reserve("installation:one", plan(), request_id),
    ]

    with ThreadPoolExecutor(max_workers=2) as executor:
        decisions = list(executor.map(lambda item: item.begin_dispatch(), reservations))

    assert [item.disposition for item in decisions].count("started") == 1
    assert {item.disposition for item in decisions} <= {
        "started",
        "duplicate_in_flight",
        "already_charged",
    }
    assert first_store.reserve(
        "installation:one", plan(), UUID(int=10)
    ).snapshot().used == 1


def test_concurrent_distinct_requests_never_exceed_free_limit():
    redis_client = fakeredis.FakeRedis()
    stores = [store(redis_client) for _ in range(12)]

    def dispatch(index: int) -> str:
        reservation = stores[index].reserve(
            "installation:one", plan(), UUID(int=index + 1)
        )
        return reservation.begin_dispatch().disposition

    with ThreadPoolExecutor(max_workers=12) as executor:
        dispositions = list(executor.map(dispatch, range(12)))

    assert dispositions.count("started") == 3
    assert set(dispositions) == {"started", "quota_exhausted"}


def test_expiry_between_reserve_and_dispatch_releases_without_charge():
    clock = [NOW]
    allowance_store = store(clock=clock)
    reservation = allowance_store.reserve(
        "installation:one",
        plan(verified_for=timedelta(seconds=2)),
        UUID(int=1),
    )
    clock[0] += timedelta(seconds=2)

    with pytest.raises(PlanVerificationUnavailable):
        reservation.begin_dispatch()

    replacement = allowance_store.reserve(
        "installation:one", plan(now=clock[0]), UUID(int=1)
    )
    assert replacement.snapshot().used == 0
    assert replacement.begin_dispatch().allowance.used == 1


def test_pro_entitlement_expiry_between_reserve_and_dispatch_fails_closed():
    clock = [NOW]
    snapshot = PlanSnapshot(
        "pro",
        verified_until=NOW + timedelta(seconds=2),
        entitlement_expires_at=NOW + timedelta(seconds=2),
    )
    reservation = store(clock=clock).reserve(
        "account:one", snapshot, UUID(int=1)
    )
    clock[0] += timedelta(seconds=2)
    with pytest.raises(PlanVerificationUnavailable):
        reservation.begin_dispatch()


def test_release_is_owner_only_and_cannot_uncharge_a_dispatch():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    first = allowance_store.reserve("installation:one", plan(), UUID(int=1))
    duplicate = allowance_store.reserve("installation:one", plan(), UUID(int=1))
    duplicate.release()
    assert first.begin_dispatch().disposition == "started"
    first.release()
    assert allowance_store.reserve(
        "installation:one", plan(), UUID(int=1)
    ).begin_dispatch().disposition == "already_charged"


def test_release_before_dispatch_allows_retry_without_charge():
    allowance_store = store()
    first = allowance_store.reserve("installation:one", plan(), UUID(int=1))
    first.release()
    second = allowance_store.reserve("installation:one", plan(), UUID(int=1))
    assert second.snapshot().used == 0
    assert second.begin_dispatch().allowance.used == 1


def test_cross_midnight_reservation_charges_captured_month_and_blocks_replay():
    clock = [NOW]
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client, clock=clock)
    reservation = allowance_store.reserve(
        "installation:one", plan(verified_for=timedelta(days=2)), UUID(int=1)
    )
    clock[0] = datetime(2026, 9, 1, 0, 0, 1, tzinfo=UTC)
    assert reservation.begin_dispatch().allowance.resets_at == datetime(
        2026, 9, 1, tzinfo=UTC
    )
    duplicate = allowance_store.reserve(
        "installation:one", plan(now=clock[0]), UUID(int=1)
    )
    assert duplicate.begin_dispatch().disposition == "already_charged"
    fresh = allowance_store.reserve(
        "installation:one", plan(now=clock[0]), UUID(int=2)
    )
    assert fresh.snapshot().used == 0


def test_cross_midnight_replay_remains_blocked_after_subject_link():
    clock = [NOW]
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client, clock=clock)
    allowance_store.link_quota_subjects("installation:one", "account:one")
    reservation = allowance_store.reserve(
        "installation:one",
        plan("pro", verified_for=timedelta(days=2)),
        UUID(int=77),
    )
    clock[0] = datetime(2026, 9, 1, 0, 0, 1, tzinfo=UTC)
    assert reservation.begin_dispatch().disposition == "started"
    duplicate = allowance_store.reserve(
        "installation:one", plan("pro", now=clock[0]), UUID(int=77)
    )
    assert duplicate.begin_dispatch().disposition == "already_charged"


def test_subject_link_is_atomic_idempotent_and_preserves_combined_usage():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    allowance_store.reserve(
        "installation:one", plan("pro"), UUID(int=1)
    ).begin_dispatch()
    allowance_store.reserve(
        "account:one", plan("pro"), UUID(int=2)
    ).begin_dispatch()

    allowance_store.link_quota_subjects("installation:one", "account:one")
    allowance_store.link_quota_subjects("installation:one", "account:one")

    installation = allowance_store.reserve(
        "installation:one", plan("pro"), UUID(int=3)
    )
    account = allowance_store.reserve("account:one", plan("pro"), UUID(int=4))
    assert installation.snapshot().used == 2
    assert installation.begin_dispatch().allowance.used == 3
    assert account.snapshot().used == 3
    assert account.begin_dispatch().allowance.used == 4


def test_linked_aliases_share_canonical_request_lease_and_charged_marker():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    allowance_store.link_quota_subjects("installation:one", "account:one")
    request_id = UUID(int=501)

    installation = allowance_store.reserve(
        "installation:one", plan("pro"), request_id
    )
    account = allowance_store.reserve("account:one", plan("pro"), request_id)
    decisions = [installation.begin_dispatch(), account.begin_dispatch()]

    assert [item.disposition for item in decisions].count("started") == 1
    assert {item.disposition for item in decisions} <= {
        "started",
        "duplicate_in_flight",
        "already_charged",
    }
    assert allowance_store.reserve(
        "installation:one", plan("pro"), request_id
    ).begin_dispatch().disposition == "already_charged"


def test_link_between_reserve_and_dispatch_invalidates_old_lease_without_charge():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    request_id = UUID(int=502)
    pre_link = allowance_store.reserve(
        "installation:one", plan("pro"), request_id
    )

    allowance_store.link_quota_subjects("installation:one", "account:one")

    assert pre_link.begin_dispatch().disposition == "identity_changed"
    replacement = allowance_store.reserve("account:one", plan("pro"), request_id)
    assert replacement.snapshot().used == 0
    assert replacement.begin_dispatch().disposition == "started"
    assert allowance_store.reserve(
        "installation:one", plan("pro"), UUID(int=503)
    ).snapshot().used == 1


def test_link_preserves_prelink_charged_request_id_across_both_aliases():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    request_id = UUID(int=5_020)
    assert allowance_store.reserve(
        "installation:one", plan("pro"), request_id
    ).begin_dispatch().disposition == "started"

    allowance_store.link_quota_subjects("installation:one", "account:one")

    duplicate = allowance_store.reserve("account:one", plan("pro"), request_id)
    assert duplicate.snapshot().used == 1
    assert duplicate.begin_dispatch().disposition == "already_charged"


def test_chained_links_resolve_transitively_and_share_request_id():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    allowance_store.reserve(
        "installation:one", plan("pro"), UUID(int=1)
    ).begin_dispatch()
    allowance_store.link_quota_subjects("installation:one", "account:one")
    allowance_store.link_quota_subjects("account:one", "account:two")

    request_id = UUID(int=504)
    first = allowance_store.reserve("installation:one", plan("pro"), request_id)
    second = allowance_store.reserve("account:two", plan("pro"), request_id)
    decisions = [first.begin_dispatch(), second.begin_dispatch()]
    assert [item.disposition for item in decisions].count("started") == 1
    assert allowance_store.reserve(
        "account:one", plan("pro"), UUID(int=505)
    ).snapshot().used == 2


def test_link_after_month_boundary_invalidates_previous_month_lease_and_retries():
    clock = [NOW]
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client, clock=clock)
    request_id = UUID(int=506)
    pending = allowance_store.reserve(
        "installation:one",
        plan("pro", verified_for=timedelta(days=2)),
        request_id,
    )
    clock[0] = datetime(2026, 9, 1, 0, 0, 1, tzinfo=UTC)
    allowance_store.link_quota_subjects("installation:one", "account:one")

    assert pending.begin_dispatch().disposition == "identity_changed"
    current_plan = plan("pro", now=clock[0])
    retried = allowance_store.reserve("account:one", current_plan, request_id)
    decision = retried.begin_dispatch()
    assert decision.disposition == "started"
    assert decision.resets_at == datetime(2026, 10, 1, tzinfo=UTC)


def test_concurrent_link_reserve_and_dispatch_never_charges_detached_counter():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)

    for index in range(12):
        installation = f"installation:race:{index}"
        account = f"account:race:{index}"
        allowance_store.reserve(
            installation, plan("pro"), UUID(int=10_000 + index * 10)
        ).begin_dispatch()
        allowance_store.reserve(
            account, plan("pro"), UUID(int=10_001 + index * 10)
        ).begin_dispatch()
        request_id = UUID(int=10_002 + index * 10)

        def dispatch() -> str:
            return allowance_store.reserve(
                installation, plan("pro"), request_id
            ).begin_dispatch().disposition

        with ThreadPoolExecutor(max_workers=2) as executor:
            link_future = executor.submit(
                allowance_store.link_quota_subjects, installation, account
            )
            dispatch_future = executor.submit(dispatch)
            link_future.result()
            outcome = dispatch_future.result()
        if outcome == "identity_changed":
            assert allowance_store.reserve(
                account, plan("pro"), request_id
            ).begin_dispatch().disposition == "started"
        else:
            assert outcome == "started"
        assert allowance_store.reserve(
            account, plan("pro"), UUID(int=10_003 + index * 10)
        ).snapshot().used == 3


def test_corrupt_or_cyclic_canonical_link_fails_closed():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    first = allowance_store._digest("subject", "installation:cycle")
    second = allowance_store._digest("subject", "account:cycle")
    redis_client.set(allowance_store._root_key(first), second, ex=60)
    redis_client.set(allowance_store._root_key(second), first, ex=60)
    with pytest.raises(AllowanceUnavailable):
        allowance_store.reserve("installation:cycle", plan(), UUID(int=507))

    redis_client.delete(allowance_store._root_key(first))
    redis_client.set(allowance_store._root_key(first), b"not-a-digest", ex=60)
    with pytest.raises(AllowanceUnavailable):
        allowance_store.reserve("installation:cycle", plan(), UUID(int=508))

    redis_client.delete(allowance_store._root_key(first))
    redis_client.set(
        allowance_store._generation_key(first), b"1000000001", ex=60
    )
    with pytest.raises(AllowanceUnavailable):
        allowance_store.reserve("installation:cycle", plan(), UUID(int=509))


def test_link_state_persists_400_days_while_month_state_expires_at_reset_buffer():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    allowance_store.link_quota_subjects("installation:one", "account:one")
    allowance_store.reserve(
        "installation:one", plan(), UUID(int=1)
    ).begin_dispatch()

    expected_max = 60 + CHARGED_MARKER_RESET_BUFFER_SECONDS
    link_ttls = [
        redis_client.ttl(key)
        for key in redis_client.keys("rai:ai:v2:*")
        if b":root:" in key or b":generation:" in key or b":members:" in key
    ]
    month_ttls = [
        redis_client.ttl(key)
        for key in redis_client.keys("rai:ai:v2:*")
        if b":counter:" in key or b":charged:" in key or b":link:" in key
    ]
    assert link_ttls and month_ttls
    assert all(399 * 24 * 60 * 60 < ttl <= 400 * 24 * 60 * 60 for ttl in link_ttls)
    assert all(0 < ttl <= expected_max for ttl in month_ttls)


@pytest.mark.parametrize(
    "subject",
    ["", "x" * 513, "contains\x00nul", "contains\ncontrol"],
)
def test_invalid_subject_material_is_rejected_before_redis(subject: str):
    with pytest.raises(ValueError):
        store().reserve(subject, plan(), UUID(int=1))


def test_redis_contains_no_raw_subject_or_request_material():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    subject = "installation:private-canary"
    request_id = UUID("12345678-1234-1234-1234-123456789abc")
    allowance_store.reserve(subject, plan(), request_id).begin_dispatch()
    allowance_store.link_quota_subjects(subject, "account:private-canary")
    rendered = repr(redis_client.keys("*") + list(redis_client.mget(redis_client.keys("*"))))
    assert "private-canary" not in rendered
    assert str(request_id) not in rendered


def test_webhook_invalidator_limits_unique_identities_after_duplicate_collapse():
    cache = VerifiedEntitlementCache(
        fakeredis.FakeRedis(),
        key_secret=b"cache-secret" * 4,
        now=lambda: NOW,
    )
    duplicate_ids = ["rai_duplicate_identity"] * 65

    assert cache.claim_webhook_event("evt_duplicates", NOW, duplicate_ids)
    _cached, generation = cache.get_with_generation("rai_duplicate_identity")
    assert generation == 1

    with pytest.raises(ValueError, match="affected identity list is invalid"):
        cache.claim_webhook_event(
            "evt_too_many_unique",
            NOW,
            [f"rai_unique_{index:02d}" for index in range(65)],
        )


class BrokenRedis:
    def pipeline(self):
        raise RuntimeError("redis://private-user:private-password@cache")

    def get(self, _key: bytes):
        raise RuntimeError("redis://private-user:private-password@cache")


def test_redis_failure_is_content_free_without_retained_context():
    allowance_store = AiAllowanceStore(
        BrokenRedis(),  # type: ignore[arg-type]
        key_secret=b"allowance-key" * 4,
        now=lambda: NOW,
    )
    with pytest.raises(AllowanceUnavailable) as caught:
        allowance_store.reserve("installation:private", plan(), UUID(int=1))
    assert str(caught.value) == "allowance_unavailable"
    assert "private" not in repr(caught.value)
    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None


def test_corrupt_counter_fails_closed_instead_of_resetting_usage():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    reservation = allowance_store.reserve("installation:one", plan(), UUID(int=1))
    counter_key = next(key for key in redis_client.keys("*") if b":counter:" in key)
    redis_client.set(counter_key, b"not-an-integer")
    with pytest.raises(AllowanceUnavailable):
        reservation.snapshot()
