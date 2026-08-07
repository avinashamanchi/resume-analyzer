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


def test_link_state_and_month_state_expire_at_reset_plus_buffer():
    redis_client = fakeredis.FakeRedis()
    allowance_store = store(redis_client)
    allowance_store.link_quota_subjects("installation:one", "account:one")
    allowance_store.reserve(
        "installation:one", plan(), UUID(int=1)
    ).begin_dispatch()

    expected_max = 60 + CHARGED_MARKER_RESET_BUFFER_SECONDS
    ttls = [redis_client.ttl(key) for key in redis_client.keys("rai:ai:v2:*")]
    assert ttls
    assert all(0 < ttl <= expected_max for ttl in ttls)


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
    rendered = repr(redis_client.keys("*") + list(redis_client.mget(redis_client.keys("*"))))
    assert "private-canary" not in rendered
    assert str(request_id) not in rendered


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
