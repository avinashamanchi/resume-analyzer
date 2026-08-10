from __future__ import annotations

import hashlib
import hmac
import math
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Literal, Protocol
from uuid import UUID

from redis.exceptions import RedisError, WatchError

from .entitlements import PlanVerificationUnavailable
from .errors import ErrorCode, PublicServiceError
from .plans import AllowanceSnapshot
from .request import MAX_REQUEST_BYTES


GLOBAL_RATE_PER_SECOND = 5
GLOBAL_BURST = 20
PROVIDER_CONCURRENCY = 48
RESERVATION_TTL_SECONDS = 15
PDF_GLOBAL_CONCURRENCY = 8
PDF_PROCESS_CONCURRENCY = 2
PDF_PROCESS_BYTES = 20 * 1024 * 1024
EMERGENCY_SCORE_RATE = 2
_TRANSACTION_ATTEMPTS = 32

AiAdmissionStatus = Literal[
    "admitted",
    "not_requested",
    "quota_exhausted",
    "plan_verification_unavailable",
    "temporarily_unavailable",
]


class CapacityUnavailable(RuntimeError):
    pass


class _Releasable(Protocol):
    def release(self) -> None: ...


class AdmissionRejected(PublicServiceError):
    def __init__(self, retry_after_seconds: int = 1) -> None:
        self.retry_after_seconds = max(1, int(retry_after_seconds))
        super().__init__(ErrorCode.CAPACITY_LIMITED, retryable=True)


class AdmissionRateLimited(PublicServiceError):
    def __init__(self, retry_after_seconds: int) -> None:
        self.retry_after_seconds = max(1, int(retry_after_seconds))
        super().__init__(ErrorCode.RATE_LIMITED, retryable=True)


@dataclass(frozen=True, slots=True)
class AdmissionRequest:
    installation_id: UUID
    account_id: str | None
    request_id: UUID
    source: Literal["reviewed_text", "pdf"]
    ai_requested: bool
    content_length: int

    def __post_init__(self) -> None:
        if not isinstance(self.installation_id, UUID):
            raise TypeError("installation_id must be a UUID")
        if not isinstance(self.request_id, UUID):
            raise TypeError("request_id must be a UUID")
        if self.account_id is not None and (
            not isinstance(self.account_id, str)
            or not self.account_id.startswith("acct_")
            or len(self.account_id) > 160
        ):
            raise ValueError("account_id is invalid")
        if self.source not in ("reviewed_text", "pdf"):
            raise ValueError("source is invalid")
        if type(self.ai_requested) is not bool:
            raise TypeError("ai_requested must be a boolean")
        if (
            isinstance(self.content_length, bool)
            or not isinstance(self.content_length, int)
            or self.content_length <= 0
            or self.content_length > MAX_REQUEST_BYTES
        ):
            raise ValueError("content_length is invalid")


@dataclass(slots=True)
class AdmissionLease:
    _reservations: list[_Releasable] = field(default_factory=list, repr=False)
    _released: bool = field(default=False, init=False, repr=False)
    _lock: threading.Lock = field(
        default_factory=threading.Lock,
        init=False,
        repr=False,
    )

    def add(self, reservation: _Releasable) -> None:
        with self._lock:
            if self._released:
                reservation.release()
                return
            self._reservations.append(reservation)

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self._released = True
            reservations = tuple(reversed(self._reservations))
            self._reservations.clear()
        failure: Exception | None = None
        for reservation in reservations:
            try:
                reservation.release()
            except Exception as error:
                failure = failure or error
        if failure is not None:
            raise failure


@dataclass(frozen=True, slots=True)
class AdmissionDecision:
    ai_status: AiAdmissionStatus
    allowance: AllowanceSnapshot | None
    lease: AdmissionLease
    allowance_reservation: Any | None = field(default=None, repr=False)


@dataclass(slots=True)
class _CapacityReservation:
    store: RedisCapacityStore
    resource: Literal["provider", "pdf"]
    owner: bytes = field(repr=False)
    _released: bool = field(default=False, init=False, repr=False)
    _lock: threading.Lock = field(
        default_factory=threading.Lock,
        init=False,
        repr=False,
    )

    def release(self) -> None:
        with self._lock:
            if self._released:
                return
            self.store._release(self.resource, self.owner)
            self._released = True


class RedisCapacityStore:
    """Atomic global token and expiring concurrency reservations."""

    def __init__(
        self,
        redis_client: Any,
        *,
        key_secret: bytes,
        now: Callable[[], int | float] = time.time,
    ) -> None:
        if not isinstance(key_secret, bytes) or len(key_secret) < 32:
            raise ValueError("key_secret must contain at least 32 bytes")
        self._redis = redis_client
        self._key_secret = key_secret
        self._now = now

    def admit_global(self) -> int | None:
        now = self._timestamp()
        key = self._key("global-token-bucket")
        try:
            for _ in range(_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(key)
                        tokens, updated_at = self._decode_bucket(pipe.get(key), now)
                        elapsed = max(0.0, now - updated_at)
                        available = min(
                            float(GLOBAL_BURST),
                            tokens + elapsed * GLOBAL_RATE_PER_SECOND,
                        )
                        if available < 1.0:
                            pipe.unwatch()
                            return max(
                                1,
                                math.ceil(
                                    (1.0 - available) / GLOBAL_RATE_PER_SECOND
                                ),
                            )
                        pipe.multi()
                        pipe.set(
                            key,
                            f"{available - 1.0:.6f}|{now:.6f}".encode("ascii"),
                            ex=60,
                        )
                        pipe.execute()
                        return None
                    except WatchError:
                        continue
        except RedisError:
            pass
        raise CapacityUnavailable()

    def reserve_provider(self) -> _CapacityReservation | None:
        return self._reserve("provider", PROVIDER_CONCURRENCY)

    def reserve_pdf(self) -> _CapacityReservation | None:
        return self._reserve("pdf", PDF_GLOBAL_CONCURRENCY)

    def _reserve(
        self,
        resource: Literal["provider", "pdf"],
        limit: int,
    ) -> _CapacityReservation | None:
        now = self._timestamp()
        expires_at = now + RESERVATION_TTL_SECONDS
        key = self._key(f"{resource}-reservations")
        owner = secrets.token_hex(32).encode("ascii")
        try:
            for _ in range(_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(key)
                        active = int(pipe.zcount(key, f"({now}", "+inf"))
                        if active >= limit:
                            pipe.unwatch()
                            return None
                        pipe.multi()
                        pipe.zremrangebyscore(key, "-inf", now)
                        pipe.zadd(key, {owner: expires_at})
                        pipe.expire(key, RESERVATION_TTL_SECONDS + 1)
                        pipe.execute()
                        return _CapacityReservation(self, resource, owner)
                    except WatchError:
                        continue
        except RedisError:
            pass
        raise CapacityUnavailable()

    def _release(
        self,
        resource: Literal["provider", "pdf"],
        owner: bytes,
    ) -> None:
        key = self._key(f"{resource}-reservations")
        try:
            self._redis.zrem(key, owner)
            return
        except RedisError:
            raise CapacityUnavailable() from None

    def _key(self, purpose: str) -> str:
        digest = hmac.new(
            self._key_secret,
            f"admission-v1\0{purpose}".encode("ascii"),
            hashlib.sha256,
        ).hexdigest()
        return f"rai:admission:v1:{digest}"

    def _timestamp(self) -> float:
        value = self._now()
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value < 0
        ):
            raise CapacityUnavailable()
        return float(value)

    @staticmethod
    def _decode_bucket(value: object, now: float) -> tuple[float, float]:
        if value is None:
            return float(GLOBAL_BURST), now
        if isinstance(value, bytes):
            raw = value
        elif isinstance(value, str):
            raw = value.encode("ascii")
        else:
            raise CapacityUnavailable()
        try:
            token_text, timestamp_text = raw.decode("ascii").split("|", 1)
            tokens = float(token_text)
            timestamp = float(timestamp_text)
        except (UnicodeError, ValueError):
            raise CapacityUnavailable() from None
        if (
            not math.isfinite(tokens)
            or not math.isfinite(timestamp)
            or tokens < 0
            or tokens > GLOBAL_BURST
            or timestamp < 0
        ):
            raise CapacityUnavailable()
        return tokens, timestamp


@dataclass(slots=True)
class _LocalPdfReservation:
    controller: AdmissionController
    byte_count: int
    _released: bool = field(default=False, init=False, repr=False)

    def release(self) -> None:
        if self._released:
            return
        self.controller._release_local_pdf(self.byte_count)
        self._released = True


class AdmissionController:
    def __init__(
        self,
        capacity: RedisCapacityStore,
        *,
        allowance_reserver: Callable[[AdmissionRequest], Any] | None = None,
        rate_limiter: Any | None = None,
        now: Callable[[], int | float] = time.time,
    ) -> None:
        if not isinstance(capacity, RedisCapacityStore):
            raise TypeError("capacity must be a RedisCapacityStore")
        self._capacity = capacity
        self._allowance_reserver = allowance_reserver
        self._rate_limiter = rate_limiter
        self._now = now
        self._local_lock = threading.Lock()
        self._local_pdf_count = 0
        self._local_pdf_bytes = 0
        self._emergency_second: int | None = None
        self._emergency_count = 0

    def admit(self, request: AdmissionRequest) -> AdmissionDecision:
        if not isinstance(request, AdmissionRequest):
            raise TypeError("request must be an AdmissionRequest")
        try:
            retry_after = self._capacity.admit_global()
            if retry_after is not None:
                raise AdmissionRejected(retry_after)
            return self._admit_with_store(request)
        except AdmissionRejected:
            raise
        except PublicServiceError as error:
            if error.code is not ErrorCode.SERVICE_UNAVAILABLE:
                raise
            return self._admit_emergency(request)
        except CapacityUnavailable:
            return self._admit_emergency(request)

    def _admit_with_store(self, request: AdmissionRequest) -> AdmissionDecision:
        lease = AdmissionLease()
        try:
            provider_allowed = request.ai_requested
            if self._rate_limiter is not None:
                rate_decision = self._rate_limiter.check_v2_analysis(
                    request.installation_id,
                    account_id=request.account_id,
                    provider_requested=request.ai_requested,
                )
                if rate_decision.analysis_allowed is not True:
                    raise AdmissionRateLimited(
                        rate_decision.retry_after_seconds
                    )
                provider_allowed = rate_decision.provider_allowed is True
            if request.source == "pdf":
                local_pdf = self._reserve_local_pdf(request.content_length)
                if local_pdf is None:
                    raise AdmissionRejected()
                lease.add(local_pdf)
                global_pdf = self._capacity.reserve_pdf()
                if global_pdf is None:
                    raise AdmissionRejected()
                lease.add(global_pdf)

            if not request.ai_requested:
                return AdmissionDecision("not_requested", None, lease)
            if not provider_allowed:
                return AdmissionDecision(
                    "temporarily_unavailable",
                    None,
                    lease,
                )
            provider = self._capacity.reserve_provider()
            if provider is None:
                return AdmissionDecision(
                    "temporarily_unavailable",
                    None,
                    lease,
                )

            if self._allowance_reserver is None:
                lease.add(provider)
                return AdmissionDecision("admitted", None, lease)
            try:
                allowance_reservation = self._allowance_reserver(request)
                allowance = allowance_reservation.snapshot()
            except PlanVerificationUnavailable:
                provider.release()
                return AdmissionDecision(
                    "plan_verification_unavailable",
                    None,
                    lease,
                )
            if not isinstance(allowance, AllowanceSnapshot):
                provider.release()
                raise CapacityUnavailable()
            if allowance.used >= allowance.limit:
                allowance_reservation.release()
                provider.release()
                return AdmissionDecision(
                    "quota_exhausted",
                    allowance,
                    lease,
                )
            lease.add(provider)
            lease.add(allowance_reservation)
            return AdmissionDecision(
                "admitted",
                allowance,
                lease,
                allowance_reservation,
            )
        except Exception:
            lease.release()
            raise

    def _admit_emergency(self, request: AdmissionRequest) -> AdmissionDecision:
        if request.source != "reviewed_text" or not self._take_emergency_score():
            raise AdmissionRejected()
        return AdmissionDecision(
            "temporarily_unavailable" if request.ai_requested else "not_requested",
            None,
            AdmissionLease(),
        )

    def _take_emergency_score(self) -> bool:
        value = self._now()
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
            return False
        second = int(value)
        with self._local_lock:
            if self._emergency_second != second:
                self._emergency_second = second
                self._emergency_count = 0
            if self._emergency_count >= EMERGENCY_SCORE_RATE:
                return False
            self._emergency_count += 1
            return True

    def _reserve_local_pdf(self, byte_count: int) -> _LocalPdfReservation | None:
        with self._local_lock:
            if (
                self._local_pdf_count >= PDF_PROCESS_CONCURRENCY
                or self._local_pdf_bytes + byte_count > PDF_PROCESS_BYTES
            ):
                return None
            self._local_pdf_count += 1
            self._local_pdf_bytes += byte_count
        return _LocalPdfReservation(self, byte_count)

    def _release_local_pdf(self, byte_count: int) -> None:
        with self._local_lock:
            if self._local_pdf_count <= 0 or self._local_pdf_bytes < byte_count:
                raise CapacityUnavailable()
            self._local_pdf_count -= 1
            self._local_pdf_bytes -= byte_count
