from __future__ import annotations

import hashlib
import hmac
import math
import secrets
import time
from collections.abc import Callable, Sequence
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Iterator, Protocol
from uuid import UUID

from redis import Redis
from redis.exceptions import RedisError, WatchError

from .errors import ErrorCode, PublicServiceError


HOUR_SECONDS = 60 * 60
DAY_SECONDS = 24 * HOUR_SECONDS

DEFAULT_ANALYSIS_INSTALLATION_HOURLY_LIMIT = 10
DEFAULT_ANALYSIS_INSTALLATION_DAILY_LIMIT = 30
DEFAULT_ANALYSIS_IP_HOURLY_LIMIT = 20
DEFAULT_ANALYSIS_IP_DAILY_LIMIT = 60
DEFAULT_INSTALLATION_ISSUE_IP_HOURLY_LIMIT = 5
DEFAULT_INSTALLATION_ISSUE_IP_DAILY_LIMIT = 20

_MAX_TRANSACTION_RETRIES = 100
_OWNER_NONCE_BYTES = 64
_OWNER_NONCE_ALPHABET = frozenset(b"0123456789abcdef")


def build_redis_client(url: str, **options: object) -> Redis:
    """Create the shared Redis client inside the audited durable boundary."""
    return Redis.from_url(url, **options)


@dataclass(frozen=True, slots=True)
class RateLimitDecision:
    allowed: bool
    retry_after_seconds: int = 0


class RequestLeaseStore(Protocol):
    def acquire(
        self,
        installation_id: UUID,
        request_id: UUID,
        ttl_seconds: int,
    ) -> bool: ...

    def release(self, installation_id: UUID, request_id: UUID) -> None: ...

    def lease(
        self,
        installation_id: UUID,
        request_id: UUID,
        ttl_seconds: int,
    ) -> Iterator[bool]: ...


@dataclass(frozen=True, slots=True)
class _Limit:
    key: str
    maximum: int
    window_seconds: int


class RateLimiter:
    """Shared fixed-window limits committed atomically in Redis."""

    def __init__(
        self,
        redis_client: Any,
        *,
        key_secret: bytes,
        now: Callable[[], int | float] = time.time,
        production: bool = True,
        analysis_installation_hourly_limit: int = DEFAULT_ANALYSIS_INSTALLATION_HOURLY_LIMIT,
        analysis_installation_daily_limit: int = DEFAULT_ANALYSIS_INSTALLATION_DAILY_LIMIT,
        analysis_ip_hourly_limit: int = DEFAULT_ANALYSIS_IP_HOURLY_LIMIT,
        analysis_ip_daily_limit: int = DEFAULT_ANALYSIS_IP_DAILY_LIMIT,
        installation_issue_ip_hourly_limit: int = DEFAULT_INSTALLATION_ISSUE_IP_HOURLY_LIMIT,
        installation_issue_ip_daily_limit: int = DEFAULT_INSTALLATION_ISSUE_IP_DAILY_LIMIT,
    ) -> None:
        _validate_secret(key_secret)
        self._redis = redis_client
        self._key_secret = key_secret
        self._now = now
        self._production = production
        self._analysis_installation_limits = (
            _validated_limit(analysis_installation_hourly_limit, HOUR_SECONDS),
            _validated_limit(analysis_installation_daily_limit, DAY_SECONDS),
        )
        self._analysis_ip_limits = (
            _validated_limit(analysis_ip_hourly_limit, HOUR_SECONDS),
            _validated_limit(analysis_ip_daily_limit, DAY_SECONDS),
        )
        self._installation_issue_ip_limits = (
            _validated_limit(installation_issue_ip_hourly_limit, HOUR_SECONDS),
            _validated_limit(installation_issue_ip_daily_limit, DAY_SECONDS),
        )

    def healthcheck(self) -> bool:
        """Verify shared-store reachability without exposing connection details."""
        try:
            return self._redis.ping() is True
        except RedisError:
            return False

    def check(self, installation_id: UUID, ip_key: str) -> RateLimitDecision:
        _validate_uuid(installation_id, "installation_id")
        _validate_ip_key(ip_key)
        timestamp = _timestamp(self._now)
        installation_digest = self._digest(
            "analysis-installation", str(installation_id)
        )
        ip_digest = self._digest("analysis-ip", ip_key)
        limits = self._window_limits(
            "analysis-installation",
            installation_digest,
            self._analysis_installation_limits,
            timestamp,
        ) + self._window_limits(
            "analysis-ip",
            ip_digest,
            self._analysis_ip_limits,
            timestamp,
        )
        return self._atomic_check(limits, timestamp)

    def check_installation_issue(self, ip_key: str) -> RateLimitDecision:
        _validate_ip_key(ip_key)
        timestamp = _timestamp(self._now)
        digest = self._digest("installation-issue-ip", ip_key)
        limits = self._window_limits(
            "installation-issue-ip",
            digest,
            self._installation_issue_ip_limits,
            timestamp,
        )
        return self._atomic_check(limits, timestamp)

    def _window_limits(
        self,
        scope: str,
        subject_digest: str,
        configured_limits: Sequence[tuple[int, int]],
        timestamp: int,
    ) -> tuple[_Limit, ...]:
        return tuple(
            _Limit(
                key=(
                    f"rai:rate-limit:v1:{scope}:{subject_digest}:"
                    f"{window_seconds}:{timestamp // window_seconds}"
                ),
                maximum=maximum,
                window_seconds=window_seconds,
            )
            for maximum, window_seconds in configured_limits
        )

    def _atomic_check(
        self,
        limits: Sequence[_Limit],
        timestamp: int,
    ) -> RateLimitDecision:
        keys = [limit.key for limit in limits]
        try:
            for _ in range(_MAX_TRANSACTION_RETRIES):
                with self._redis.pipeline() as transaction:
                    try:
                        transaction.watch(*keys)
                        raw_counts = transaction.mget(keys)
                        counts = [_counter_value(value) for value in raw_counts]
                        blocked_windows = [
                            limit.window_seconds
                            for limit, count in zip(limits, counts, strict=True)
                            if count >= limit.maximum
                        ]
                        if blocked_windows:
                            transaction.unwatch()
                            retry_after = max(
                                window - (timestamp % window)
                                for window in blocked_windows
                            )
                            return RateLimitDecision(
                                allowed=False,
                                retry_after_seconds=retry_after,
                            )

                        transaction.multi()
                        for limit in limits:
                            transaction.incr(limit.key)
                            transaction.expire(
                                limit.key,
                                limit.window_seconds - (timestamp % limit.window_seconds),
                            )
                        transaction.execute()
                        return RateLimitDecision(allowed=True)
                    except WatchError:
                        continue
        except RedisError:
            pass
        return self._redis_unavailable()

    def _redis_unavailable(self) -> RateLimitDecision:
        if not self._production:
            raise RedisError("rate-limit store unavailable")
        raise PublicServiceError(
            ErrorCode.SERVICE_UNAVAILABLE,
            retryable=True,
        )

    def _digest(self, scope: str, raw_identifier: str) -> str:
        return hmac.new(
            self._key_secret,
            f"{scope}\0{raw_identifier}".encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()


class RedisRequestLeaseStore:
    """Store only expiring in-flight markers, never request or response content."""

    def __init__(
        self,
        redis_client: Any,
        *,
        key_secret: bytes,
        production: bool = True,
    ) -> None:
        _validate_secret(key_secret)
        self._redis = redis_client
        self._key_secret = key_secret
        self._production = production
        self._owned_leases: ContextVar[dict[str, bytes] | None] = ContextVar(
            f"redis_request_lease_owners_{id(self)}",
            default=None,
        )

    def healthcheck(self) -> bool:
        """Verify shared-store reachability without mutating lease state."""
        try:
            return self._redis.ping() is True
        except RedisError:
            return False

    def acquire(
        self,
        installation_id: UUID,
        request_id: UUID,
        ttl_seconds: int,
    ) -> bool:
        _validate_uuid(installation_id, "installation_id")
        _validate_uuid(request_id, "request_id")
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
            raise TypeError("ttl_seconds must be an integer")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be greater than zero")
        key = self._key(installation_id, request_id)
        owner_nonce = secrets.token_hex(32).encode("ascii")
        acquired: bool | None = None
        try:
            acquired = bool(
                self._redis.set(key, owner_nonce, nx=True, ex=ttl_seconds)
            )
        except RedisError:
            pass
        if acquired is None:
            self._raise_unavailable()
        if acquired:
            self._remember_owner(key, owner_nonce)
        return acquired

    def release(self, installation_id: UUID, request_id: UUID) -> None:
        _validate_uuid(installation_id, "installation_id")
        _validate_uuid(request_id, "request_id")
        key = self._key(installation_id, request_id)
        owner_nonce = self._owner_for(key)
        if owner_nonce is None:
            return

        compared = False
        try:
            for _ in range(_MAX_TRANSACTION_RETRIES):
                with self._redis.pipeline() as transaction:
                    try:
                        transaction.watch(key)
                        stored_owner = _canonical_owner_nonce(transaction.get(key))
                        if stored_owner is None or not hmac.compare_digest(
                            stored_owner,
                            owner_nonce,
                        ):
                            transaction.unwatch()
                            compared = True
                            break
                        transaction.multi()
                        transaction.delete(key)
                        transaction.execute()
                        compared = True
                        break
                    except WatchError:
                        continue
        except RedisError:
            pass
        if not compared:
            self._raise_unavailable()
        self._forget_owner(key, owner_nonce)

    @contextmanager
    def lease(
        self,
        installation_id: UUID,
        request_id: UUID,
        ttl_seconds: int,
    ) -> Iterator[bool]:
        acquired = self.acquire(installation_id, request_id, ttl_seconds)
        try:
            yield acquired
        finally:
            if acquired:
                self.release(installation_id, request_id)

    def _key(self, installation_id: UUID, request_id: UUID) -> str:
        digest = hmac.new(
            self._key_secret,
            f"request-lease\0{installation_id}\0{request_id}".encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        return f"rai:request-lease:v1:{digest}"

    def _owner_for(self, key: str) -> bytes | None:
        owners = self._owned_leases.get()
        return None if owners is None else owners.get(key)

    def _remember_owner(self, key: str, owner_nonce: bytes) -> None:
        owners = dict(self._owned_leases.get() or {})
        owners[key] = owner_nonce
        self._owned_leases.set(owners)

    def _forget_owner(self, key: str, owner_nonce: bytes) -> None:
        owners = self._owned_leases.get()
        if owners is None or owners.get(key) != owner_nonce:
            return
        remaining_owners = dict(owners)
        del remaining_owners[key]
        self._owned_leases.set(remaining_owners or None)

    def _raise_unavailable(self) -> None:
        if not self._production:
            raise RedisError("request lease store unavailable")
        raise PublicServiceError(
            ErrorCode.SERVICE_UNAVAILABLE,
            retryable=True,
        )


def _validated_limit(maximum: int, window_seconds: int) -> tuple[int, int]:
    if isinstance(maximum, bool) or not isinstance(maximum, int):
        raise TypeError("rate limits must be integers")
    if maximum <= 0:
        raise ValueError("rate limits must be greater than zero")
    return maximum, window_seconds


def _validate_secret(secret: bytes) -> None:
    if not isinstance(secret, bytes) or len(secret) < 32:
        raise ValueError("key_secret must contain at least 32 bytes")


def _validate_uuid(value: UUID, name: str) -> None:
    if not isinstance(value, UUID):
        raise TypeError(f"{name} must be a UUID")


def _validate_ip_key(ip_key: str) -> None:
    if not isinstance(ip_key, str) or not ip_key or len(ip_key) > 256:
        raise ValueError("ip_key must be a non-empty coarse identifier")


def _timestamp(now: Callable[[], int | float]) -> int:
    value = now()
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError("clock must return a finite timestamp")
    if not math.isfinite(value):
        raise ValueError("clock must return a finite timestamp")
    return int(value)


def _counter_value(value: bytes | str | None) -> int:
    if value is None:
        return 0
    try:
        count = int(value)
    except (TypeError, ValueError):
        raise RedisError("invalid rate-limit counter") from None
    if count < 0:
        raise RedisError("invalid rate-limit counter")
    return count


def _canonical_owner_nonce(value: object) -> bytes | None:
    if isinstance(value, str):
        try:
            encoded_value = value.encode("ascii", errors="strict")
        except UnicodeEncodeError:
            return None
    elif isinstance(value, bytes):
        encoded_value = value
    else:
        return None
    if (
        len(encoded_value) != _OWNER_NONCE_BYTES
        or not set(encoded_value) <= _OWNER_NONCE_ALPHABET
    ):
        return None
    return encoded_value
