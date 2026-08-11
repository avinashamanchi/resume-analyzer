from __future__ import annotations

import os
import secrets
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from uuid import UUID

import pytest
import redis

from server.entitlements import AiAllowanceStore
from server.plans import PlanSnapshot


TEST_REDIS_URL = os.environ.get("TEST_REDIS_URL")
pytestmark = pytest.mark.skipif(
    not TEST_REDIS_URL,
    reason="local real Redis gate unavailable; CI provides TEST_REDIS_URL",
)
NOW = datetime(2026, 8, 31, 23, 59, tzinfo=UTC)


def snapshot(kind: str = "free") -> PlanSnapshot:
    return PlanSnapshot(
        kind=kind,  # type: ignore[arg-type]
        verified_until=NOW + timedelta(days=3),
        entitlement_expires_at=(NOW + timedelta(days=30) if kind == "pro" else None),
    )


@pytest.fixture
def redis_clients():
    assert TEST_REDIS_URL is not None
    clients = [
        redis.Redis.from_url(
            TEST_REDIS_URL,
            decode_responses=False,
            socket_connect_timeout=2,
            socket_timeout=2,
        )
        for _ in range(4)
    ]
    before = set(clients[0].scan_iter(match=b"rai:ai:v2:*"))
    yield clients
    after = set(clients[0].scan_iter(match=b"rai:ai:v2:*"))
    owned = list(after - before)
    if owned:
        clients[0].delete(*owned)
    for client in clients:
        client.close()


def stores(redis_clients, count: int = 4) -> list[AiAllowanceStore]:
    secret = secrets.token_bytes(32)
    return [
        AiAllowanceStore(
            redis_clients[index % len(redis_clients)],
            key_secret=secret,
            now=lambda: NOW,
        )
        for index in range(count)
    ]


@pytest.mark.parametrize(("kind", "expected"), [("free", 3), ("pro", 100)])
def test_real_redis_concurrent_distinct_requests_never_exceed_limit(
    redis_clients, kind: str, expected: int
):
    allowance_stores = stores(redis_clients, expected + 12)

    def dispatch(index: int) -> str:
        return allowance_stores[index].reserve(
            "installation:shared", snapshot(kind), UUID(int=index + 1)
        ).begin_dispatch().disposition

    with ThreadPoolExecutor(max_workers=32) as executor:
        results = list(executor.map(dispatch, range(len(allowance_stores))))

    assert results.count("started") == expected
    assert set(results) == {"started", "quota_exhausted"}


def test_real_redis_duplicate_grants_one_dispatch_and_shared_counter(redis_clients):
    allowance_stores = stores(redis_clients, 16)
    request_id = UUID(int=7)

    def dispatch(index: int) -> str:
        return allowance_stores[index].reserve(
            "installation:shared", snapshot(), request_id
        ).begin_dispatch().disposition

    with ThreadPoolExecutor(max_workers=16) as executor:
        results = list(executor.map(dispatch, range(16)))

    assert results.count("started") == 1
    assert set(results) <= {"started", "duplicate_in_flight", "already_charged"}
    assert allowance_stores[-1].reserve(
        "installation:shared", snapshot(), UUID(int=8)
    ).snapshot().used == 1


def test_real_redis_stale_owner_cannot_delete_replacement_and_ttls_are_bounded(
    redis_clients,
):
    allowance_store = stores(redis_clients, 1)[0]
    reservation = allowance_store.reserve(
        "installation:shared", snapshot(), UUID(int=1)
    )
    redis_client = redis_clients[0]
    replacement = b"replacement-owner-nonce"
    redis_client.set(reservation._lease_key, replacement, ex=15)
    reservation.release()
    assert redis_client.get(reservation._lease_key) == replacement
    ttls = [redis_client.ttl(key) for key in redis_client.scan_iter(match=b"rai:ai:v2:*")]
    assert ttls and all(0 < ttl <= 172_860 for ttl in ttls)


def test_real_redis_cross_month_replay_and_subject_link_are_atomic(redis_clients):
    clock = [NOW]
    secret = secrets.token_bytes(32)
    allowance_stores = [
        AiAllowanceStore(client, key_secret=secret, now=lambda: clock[0])
        for client in redis_clients
    ]
    reservation = allowance_stores[0].reserve(
        "installation:shared", snapshot("pro"), UUID(int=1)
    )
    clock[0] = datetime(2026, 9, 1, 0, 0, 1, tzinfo=UTC)
    assert reservation.begin_dispatch().allowance.resets_at == datetime(
        2026, 9, 1, tzinfo=UTC
    )
    assert allowance_stores[1].reserve(
        "installation:shared",
        PlanSnapshot("pro", clock[0] + timedelta(days=2), clock[0] + timedelta(days=30)),
        UUID(int=1),
    ).begin_dispatch().disposition == "already_charged"

    current_plan = PlanSnapshot(
        "pro", clock[0] + timedelta(days=2), clock[0] + timedelta(days=30)
    )
    allowance_stores[0].reserve(
        "installation:shared", current_plan, UUID(int=2)
    ).begin_dispatch()
    allowance_stores[1].reserve(
        "account:shared", current_plan, UUID(int=3)
    ).begin_dispatch()
    with ThreadPoolExecutor(max_workers=4) as executor:
        list(
            executor.map(
                lambda value: value.link_quota_subjects(
                    "installation:shared", "account:shared"
                ),
                allowance_stores,
            )
        )
    assert allowance_stores[2].reserve(
        "account:shared", current_plan, UUID(int=4)
    ).snapshot().used == 2


def test_real_redis_link_invalidates_pending_lease_and_canonicalizes_request(redis_clients):
    allowance_stores = stores(redis_clients, 4)
    request_id = UUID(int=900)
    pending = allowance_stores[0].reserve(
        "installation:pending", snapshot("pro"), request_id
    )

    with ThreadPoolExecutor(max_workers=4) as executor:
        list(
            executor.map(
                lambda value: value.link_quota_subjects(
                    "installation:pending", "account:pending"
                ),
                allowance_stores,
            )
        )

    assert pending.begin_dispatch().disposition == "identity_changed"
    reservations = [
        value.reserve("account:pending", snapshot("pro"), request_id)
        for value in allowance_stores
    ]
    with ThreadPoolExecutor(max_workers=4) as executor:
        outcomes = list(executor.map(lambda value: value.begin_dispatch(), reservations))
    assert [value.disposition for value in outcomes].count("started") == 1
    assert allowance_stores[0].reserve(
        "installation:pending", snapshot("pro"), request_id
    ).begin_dispatch().disposition == "already_charged"
