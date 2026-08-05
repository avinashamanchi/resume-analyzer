from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from uuid import UUID

import fakeredis
import pytest
from redis.exceptions import ConnectionError as RedisConnectionError

from server.errors import ErrorCode, PublicServiceError
from server.rate_limit import RateLimiter, RedisRequestLeaseStore


INSTALLATION_ID = UUID("018f6cf8-7af8-7d7d-87c6-70c87ba92878")
OTHER_INSTALLATION_ID = UUID("018f6cf8-7af8-7d7d-87c6-70c87ba92879")
REQUEST_ID = UUID("018f6d01-c1a7-71d0-bdb4-13a419de0f22")
KEY_SECRET = b"k" * 32


@pytest.fixture
def redis_client() -> fakeredis.FakeRedis:
    return fakeredis.FakeRedis(decode_responses=False)


def _limiter(redis_client: fakeredis.FakeRedis, now: list[int]) -> RateLimiter:
    return RateLimiter(
        redis_client,
        key_secret=KEY_SECRET,
        now=lambda: now[0],
        production=True,
    )


def test_analysis_limit_is_ten_per_hour_and_thirty_per_day_per_installation(
    redis_client: fakeredis.FakeRedis,
):
    now = [1_800_000_000]
    limiter = _limiter(redis_client, now)

    assert all(limiter.check(INSTALLATION_ID, "203.0.113.0/24").allowed for _ in range(10))
    hourly_denial = limiter.check(INSTALLATION_ID, "203.0.113.0/24")
    assert hourly_denial.allowed is False
    assert 0 < hourly_denial.retry_after_seconds <= 3_600

    now[0] += 3_600
    assert all(limiter.check(INSTALLATION_ID, "203.0.114.0/24").allowed for _ in range(10))
    now[0] += 3_600
    assert all(limiter.check(INSTALLATION_ID, "203.0.115.0/24").allowed for _ in range(10))
    now[0] += 3_600
    daily_denial = limiter.check(INSTALLATION_ID, "203.0.116.0/24")
    assert daily_denial.allowed is False
    assert 0 < daily_denial.retry_after_seconds <= 86_400


def test_analysis_ip_backstop_is_twenty_per_hour_and_sixty_per_day(
    redis_client: fakeredis.FakeRedis,
):
    now = [1_800_000_000]
    limiter = _limiter(redis_client, now)
    ip_key = "198.51.100.0/24"

    assert all(limiter.check(INSTALLATION_ID, ip_key).allowed for _ in range(10))
    assert all(limiter.check(OTHER_INSTALLATION_ID, ip_key).allowed for _ in range(10))
    assert limiter.check(UUID(int=3), ip_key).allowed is False

    for hour in range(1, 3):
        now[0] += 3_600
        first = UUID(int=10 + hour * 2)
        second = UUID(int=11 + hour * 2)
        assert all(limiter.check(first, ip_key).allowed for _ in range(10))
        assert all(limiter.check(second, ip_key).allowed for _ in range(10))
    now[0] += 3_600
    assert limiter.check(UUID(int=99), ip_key).allowed is False


def test_installation_issuance_is_limited_to_five_per_hour_and_twenty_per_day(
    redis_client: fakeredis.FakeRedis,
):
    now = [1_800_000_000]
    limiter = _limiter(redis_client, now)
    ip_key = "192.0.2.0/24"

    assert all(limiter.check_installation_issue(ip_key).allowed for _ in range(5))
    assert limiter.check_installation_issue(ip_key).allowed is False

    for _ in range(3):
        now[0] += 3_600
        assert all(limiter.check_installation_issue(ip_key).allowed for _ in range(5))
    now[0] += 3_600
    assert limiter.check_installation_issue(ip_key).allowed is False


def test_rate_limit_keys_are_hmac_derived_and_store_only_counters(
    redis_client: fakeredis.FakeRedis,
):
    now = [1_800_000_000]
    raw_ip = "203.0.113.0/24"

    assert _limiter(redis_client, now).check(INSTALLATION_ID, raw_ip).allowed

    keys = list(redis_client.scan_iter())
    joined_keys = b" ".join(keys)
    assert str(INSTALLATION_ID).encode() not in joined_keys
    assert raw_ip.encode() not in joined_keys
    assert keys
    assert {redis_client.type(key) for key in keys} == {b"string"}
    assert {redis_client.get(key) for key in keys} == {b"1"}


def test_concurrent_workers_cannot_exceed_the_atomic_hourly_limit(
    redis_client: fakeredis.FakeRedis,
):
    now = [1_800_000_000]
    limiter = _limiter(redis_client, now)

    with ThreadPoolExecutor(max_workers=20) as workers:
        decisions = list(
            workers.map(
                lambda _: limiter.check(INSTALLATION_ID, "203.0.113.0/24"),
                range(20),
            )
        )

    assert sum(decision.allowed for decision in decisions) == 10


class UnavailableRedis:
    def pipeline(self):
        raise RedisConnectionError("private redis host details")

    def set(self, *args: object, **kwargs: object):
        raise RedisConnectionError("private redis host details")

    def delete(self, *args: object, **kwargs: object):
        raise RedisConnectionError("private redis host details")


def test_redis_outage_fails_closed_in_production_without_private_details():
    limiter = RateLimiter(
        UnavailableRedis(),
        key_secret=KEY_SECRET,
        now=lambda: 1_800_000_000,
        production=True,
    )

    with pytest.raises(PublicServiceError) as caught:
        limiter.check(INSTALLATION_ID, "private-ip-key")

    assert caught.value.code is ErrorCode.SERVICE_UNAVAILABLE
    assert caught.value.retryable is True
    assert str(caught.value) == "service_unavailable"
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None


def test_development_can_use_an_injected_fake_redis(redis_client: fakeredis.FakeRedis):
    limiter = RateLimiter(
        redis_client,
        key_secret=KEY_SECRET,
        now=lambda: 1_800_000_000,
        production=False,
    )

    assert limiter.check(INSTALLATION_ID, "local-development").allowed is True
    assert limiter.check_installation_issue("local-development").allowed is True


def test_duplicate_request_lease_does_not_store_response(
    redis_client: fakeredis.FakeRedis,
):
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)

    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True
    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False

    keys = list(redis_client.scan_iter())
    assert len(keys) == 1
    assert redis_client.ttl(keys[0]) in {44, 45}
    stored = b" ".join(keys) + b" " + b" ".join(
        value for key in keys if (value := redis_client.get(key)) is not None
    )
    assert b"resume" not in stored
    assert str(INSTALLATION_ID).encode() not in stored
    assert str(REQUEST_ID).encode() not in stored


def test_request_lease_release_removes_only_in_flight_marker(
    redis_client: fakeredis.FakeRedis,
):
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45)

    store.release(INSTALLATION_ID, REQUEST_ID)

    assert list(redis_client.scan_iter()) == []
    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45)


@pytest.mark.parametrize(
    "outcome",
    [
        pytest.param(None, id="success"),
        pytest.param(RuntimeError("analysis failed"), id="failure"),
        pytest.param(TimeoutError("analysis timed out"), id="timeout"),
    ],
)
def test_request_lease_context_releases_after_every_request_outcome(
    redis_client: fakeredis.FakeRedis,
    outcome: BaseException | None,
):
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)

    if outcome is None:
        with store.lease(INSTALLATION_ID, REQUEST_ID, 45) as acquired:
            assert acquired is True
    else:
        with pytest.raises(type(outcome), match=str(outcome)):
            with store.lease(INSTALLATION_ID, REQUEST_ID, 45) as acquired:
                assert acquired is True
                raise outcome

    assert list(redis_client.scan_iter()) == []


def test_request_lease_operations_do_not_log_raw_identifiers(
    redis_client: fakeredis.FakeRedis,
    caplog: pytest.LogCaptureFixture,
):
    raw_ip = "sensitive-coarse-ip"
    limiter = RateLimiter(
        redis_client,
        key_secret=KEY_SECRET,
        now=lambda: 1_800_000_000,
        production=True,
    )
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)

    limiter.check(INSTALLATION_ID, raw_ip)
    store.acquire(INSTALLATION_ID, REQUEST_ID, 45)
    store.release(INSTALLATION_ID, REQUEST_ID)

    log_output = caplog.text
    assert raw_ip not in log_output
    assert str(INSTALLATION_ID) not in log_output
    assert str(REQUEST_ID) not in log_output


@pytest.mark.parametrize("ttl_seconds", [0, -1])
def test_request_lease_rejects_non_positive_timeout(
    redis_client: fakeredis.FakeRedis,
    ttl_seconds: int,
):
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)

    with pytest.raises(ValueError, match="ttl_seconds"):
        store.acquire(INSTALLATION_ID, REQUEST_ID, ttl_seconds)
