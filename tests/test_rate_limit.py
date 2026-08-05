from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from contextvars import Context
from uuid import UUID

import fakeredis
import pytest
from redis.exceptions import ConnectionError as RedisConnectionError
from redis.exceptions import WatchError

import server.rate_limit as rate_limit_module
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

    def ping(self):
        raise RedisConnectionError("private redis host details")


def test_health_checks_verify_the_shared_store_without_exposing_outage_details(
    redis_client: fakeredis.FakeRedis,
):
    limiter = RateLimiter(
        redis_client,
        key_secret=KEY_SECRET,
        now=lambda: 1_800_000_000,
    )
    leases = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    unavailable_limiter = RateLimiter(
        UnavailableRedis(),
        key_secret=KEY_SECRET,
        now=lambda: 1_800_000_000,
    )
    unavailable_leases = RedisRequestLeaseStore(
        UnavailableRedis(), key_secret=KEY_SECRET
    )

    assert limiter.healthcheck() is True
    assert leases.healthcheck() is True
    assert unavailable_limiter.healthcheck() is False
    assert unavailable_leases.healthcheck() is False


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


def test_each_successful_lease_uses_a_fresh_content_free_owner_nonce(
    redis_client: fakeredis.FakeRedis,
):
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True
    key = next(redis_client.scan_iter())
    first_owner = redis_client.get(key)
    store.release(INSTALLATION_ID, REQUEST_ID)

    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True
    second_owner = redis_client.get(key)

    assert isinstance(first_owner, bytes)
    assert isinstance(second_owner, bytes)
    assert len(first_owner) == 64
    assert len(second_owner) == 64
    assert set(first_owner + second_owner) <= set(b"0123456789abcdef")
    assert first_owner != second_owner


@pytest.mark.parametrize("decode_responses", [False, True])
def test_rightful_owner_release_allows_immediate_reacquire(
    decode_responses: bool,
):
    redis_client = fakeredis.FakeRedis(decode_responses=decode_responses)
    store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45)

    store.release(INSTALLATION_ID, REQUEST_ID)

    assert list(redis_client.scan_iter()) == []
    assert store.acquire(INSTALLATION_ID, REQUEST_ID, 45)


@pytest.mark.parametrize("decode_responses", [False, True])
def test_stale_lease_owner_cannot_release_a_new_owner_after_ttl_expiry(
    decode_responses: bool,
):
    redis_client = fakeredis.FakeRedis(decode_responses=decode_responses)
    owner_a = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    owner_b = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    contender_c = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)

    assert owner_a.acquire(INSTALLATION_ID, REQUEST_ID, 1) is True
    time.sleep(1.05)
    assert owner_b.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True

    owner_a.release(INSTALLATION_ID, REQUEST_ID)

    assert contender_c.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False
    owner_b.release(INSTALLATION_ID, REQUEST_ID)
    assert contender_c.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True


@pytest.mark.parametrize("decode_responses", [False, True])
def test_release_from_non_owning_store_is_a_no_op(decode_responses: bool):
    redis_client = fakeredis.FakeRedis(decode_responses=decode_responses)
    owner = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    non_owner = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    contender = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    assert owner.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True

    non_owner.release(INSTALLATION_ID, REQUEST_ID)

    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False
    owner.release(INSTALLATION_ID, REQUEST_ID)
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True


@pytest.mark.parametrize(
    "malformed_owner",
    [
        pytest.param("g" * 64, id="non-hex-ascii"),
        pytest.param("é" * 64, id="non-ascii"),
        pytest.param("abc", id="wrong-length"),
    ],
)
def test_malformed_text_owner_is_never_accepted_for_release(
    malformed_owner: str,
):
    redis_client = fakeredis.FakeRedis(decode_responses=True)
    owner = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    contender = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    assert owner.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True
    key = next(redis_client.scan_iter())
    redis_client.set(key, malformed_owner, ex=45)

    owner.release(INSTALLATION_ID, REQUEST_ID)

    assert redis_client.get(key) == malformed_owner
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False


def test_release_from_non_owning_execution_context_is_a_no_op(
    redis_client: fakeredis.FakeRedis,
):
    shared_store = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    contender = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    owner_context = Context()
    non_owner_context = Context()
    assert owner_context.run(
        shared_store.acquire,
        INSTALLATION_ID,
        REQUEST_ID,
        45,
    ) is True

    non_owner_context.run(shared_store.release, INSTALLATION_ID, REQUEST_ID)

    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False
    owner_context.run(shared_store.release, INSTALLATION_ID, REQUEST_ID)
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True


def test_release_redis_outage_fails_closed_and_preserves_the_owner():
    fake_server = fakeredis.FakeServer()
    redis_client = fakeredis.FakeRedis(server=fake_server, decode_responses=False)
    owner = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    contender = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    assert owner.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True
    fake_server.connected = False

    with pytest.raises(PublicServiceError) as caught:
        owner.release(INSTALLATION_ID, REQUEST_ID)

    assert caught.value.code is ErrorCode.SERVICE_UNAVAILABLE
    assert caught.value.retryable is True
    assert str(caught.value) == "service_unavailable"
    assert caught.value.__context__ is None
    assert caught.value.__cause__ is None
    fake_server.connected = True
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False
    owner.release(INSTALLATION_ID, REQUEST_ID)
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True


class ConflictingPipeline:
    def __init__(self, redis_client: fakeredis.FakeRedis) -> None:
        self._pipeline = redis_client.pipeline()

    def __enter__(self) -> ConflictingPipeline:
        self._pipeline.__enter__()
        return self

    def __exit__(self, *args: object) -> None:
        self._pipeline.__exit__(*args)

    def watch(self, *keys: str) -> None:
        self._pipeline.watch(*keys)

    def get(self, key: str) -> bytes | None:
        return self._pipeline.get(key)

    def unwatch(self) -> None:
        self._pipeline.unwatch()

    def multi(self) -> None:
        self._pipeline.multi()

    def delete(self, key: str) -> None:
        self._pipeline.delete(key)

    def execute(self) -> None:
        raise WatchError("private conflict details")


class ConflictInjectingRedis:
    def __init__(self, redis_client: fakeredis.FakeRedis) -> None:
        self._redis = redis_client
        self.conflicting = True

    def set(self, *args: object, **kwargs: object) -> object:
        return self._redis.set(*args, **kwargs)

    def pipeline(self) -> object:
        if self.conflicting:
            return ConflictingPipeline(self._redis)
        return self._redis.pipeline()


def test_release_retry_exhaustion_fails_closed_without_deleting_owner(
    redis_client: fakeredis.FakeRedis,
    monkeypatch: pytest.MonkeyPatch,
):
    conflicting_redis = ConflictInjectingRedis(redis_client)
    owner = RedisRequestLeaseStore(conflicting_redis, key_secret=KEY_SECRET)
    contender = RedisRequestLeaseStore(redis_client, key_secret=KEY_SECRET)
    monkeypatch.setattr(rate_limit_module, "_MAX_TRANSACTION_RETRIES", 2)
    assert owner.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True

    with pytest.raises(PublicServiceError) as caught:
        owner.release(INSTALLATION_ID, REQUEST_ID)

    assert caught.value.code is ErrorCode.SERVICE_UNAVAILABLE
    assert caught.value.retryable is True
    assert str(caught.value) == "service_unavailable"
    assert caught.value.__context__ is None
    assert "private conflict details" not in repr(caught.value)
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is False
    conflicting_redis.conflicting = False
    owner.release(INSTALLATION_ID, REQUEST_ID)
    assert contender.acquire(INSTALLATION_ID, REQUEST_ID, 45) is True


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
