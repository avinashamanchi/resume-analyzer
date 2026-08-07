from __future__ import annotations

import hashlib
import hmac
import json
import math
import re
import secrets
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Callable, Literal
from uuid import UUID

from redis.exceptions import WatchError

from .plans import (
    CHARGED_MARKER_RESET_BUFFER_SECONDS,
    RESERVATION_TTL_SECONDS,
    AllowanceSnapshot,
    PlanSnapshot,
    allowance_limit,
    utc_month_window,
    PLAN_CACHE_MAX_SECONDS,
)


_MAX_TRANSACTION_ATTEMPTS = 16
_OPAQUE_DIGEST = re.compile(rb"[0-9a-f]{64}")


class AllowanceUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("allowance_unavailable")


class PlanVerificationUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("plan_verification_unavailable")


class NonceReplayRejected(RuntimeError):
    def __init__(self) -> None:
        super().__init__("nonce_replay_rejected")


@dataclass(frozen=True, slots=True)
class DispatchDecision:
    disposition: Literal[
        "started", "duplicate_in_flight", "already_charged", "quota_exhausted"
    ]
    allowance: AllowanceSnapshot

    @property
    def used(self) -> int:
        return self.allowance.used

    @property
    def limit(self) -> int:
        return self.allowance.limit

    @property
    def resets_at(self) -> datetime:
        return self.allowance.resets_at


class AiAllowanceStore:
    """Atomic, content-free provider-dispatch accounting backed only by Redis."""

    def __init__(
        self,
        redis_client: Any,
        *,
        key_secret: bytes,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not isinstance(key_secret, bytes) or len(key_secret) < 32:
            raise ValueError("key_secret must contain at least 32 bytes")
        self._redis = redis_client
        self._key_secret = key_secret
        self._now = now

    def reserve(
        self,
        subject_key: str,
        plan: PlanSnapshot,
        request_id: UUID,
    ) -> AiAllowanceReservation:
        self._validate_subject(subject_key)
        if not isinstance(request_id, UUID):
            raise TypeError("request_id must be a UUID")
        current = self._current_time()
        self._require_plan(plan, current)
        period, resets_at = utc_month_window(current)
        subject_digest = self._digest("subject", subject_key)
        canonical = self._canonical_subject(subject_digest, period)
        counter_key = self._counter_key(canonical, period)
        lease_key = self._request_key("lease", subject_digest, request_id)
        charged_key = self._request_key("charged", subject_digest, request_id)
        owner = secrets.token_hex(16).encode("ascii")
        ttl = self._period_ttl(resets_at, current)

        def operation() -> tuple[str, bytes | None]:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(charged_key, lease_key, counter_key)
                        charged = pipe.get(charged_key)
                        existing_owner = pipe.get(lease_key)
                        counter = pipe.get(counter_key)
                        if counter is not None:
                            self._decode_counter(counter)
                        if charged is not None:
                            return "already_charged", None
                        if existing_owner is not None:
                            return "duplicate_in_flight", None
                        pipe.multi()
                        if counter is None:
                            pipe.set(counter_key, b"0", ex=ttl, nx=True)
                        pipe.set(lease_key, owner, ex=RESERVATION_TTL_SECONDS, nx=True)
                        results = pipe.execute()
                        if results[-1]:
                            return "owner", owner
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        state, owned_nonce = self._redis_call(operation)
        return AiAllowanceReservation(
            _store=self,
            _plan=plan,
            _period=period,
            _resets_at=resets_at,
            _counter_key=counter_key,
            _lease_key=lease_key,
            _charged_key=charged_key,
            _owner_nonce=owned_nonce,
            _initial_state=state,
        )

    def link_quota_subjects(
        self,
        installation_subject: str,
        account_subject: str,
    ) -> None:
        self._validate_subject(installation_subject)
        self._validate_subject(account_subject)
        current = self._current_time()
        period, resets_at = utc_month_window(current)
        ttl = self._period_ttl(resets_at, current)
        installation_digest = self._digest("subject", installation_subject)
        account_digest = self._digest("subject", account_subject)
        installation_map = self._mapping_key(installation_digest, period)
        account_map = self._mapping_key(account_digest, period)
        marker = self._link_marker_key(installation_digest, account_digest, period)

        def operation() -> None:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(installation_map, account_map, marker)
                        installation_canonical = self._decode_digest(
                            pipe.get(installation_map), installation_digest
                        )
                        account_canonical = self._decode_digest(
                            pipe.get(account_map), account_digest
                        )
                        installation_counter = self._counter_key(
                            installation_canonical, period
                        )
                        account_counter = self._counter_key(account_canonical, period)
                        pipe.watch(installation_counter, account_counter)
                        already_linked = pipe.get(marker) is not None
                        installation_used = self._decode_counter(
                            pipe.get(installation_counter)
                        )
                        account_used = self._decode_counter(pipe.get(account_counter))
                        combined = account_used
                        if not already_linked and installation_counter != account_counter:
                            combined = installation_used + account_used
                        pipe.multi()
                        pipe.set(installation_map, account_canonical, ex=ttl)
                        pipe.set(account_map, account_canonical, ex=ttl)
                        if not already_linked:
                            pipe.set(account_counter, str(combined).encode("ascii"), ex=ttl)
                            pipe.set(marker, b"1", ex=ttl, nx=True)
                        pipe.execute()
                        return
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        self._redis_call(operation)

    def _canonical_subject(self, subject_digest: bytes, period: str) -> bytes:
        key = self._mapping_key(subject_digest, period)
        return self._redis_call(
            lambda: self._decode_digest(self._redis.get(key), subject_digest)
        )

    def _mapping_key(self, subject_digest: bytes, period: str) -> bytes:
        return self._key("map", self._digest("map-key", subject_digest, period))

    def _counter_key(self, canonical: bytes, period: str) -> bytes:
        return self._key("counter", self._digest("month-counter", canonical, period))

    def _request_key(self, purpose: str, canonical: bytes, request_id: UUID) -> bytes:
        return self._key(
            purpose,
            self._digest(f"request-{purpose}", canonical, str(request_id)),
        )

    def _link_marker_key(
        self, installation_digest: bytes, account_digest: bytes, period: str
    ) -> bytes:
        return self._key(
            "link",
            self._digest("subject-link", installation_digest, account_digest, period),
        )

    @staticmethod
    def _key(kind: str, digest: bytes) -> bytes:
        return b"rai:ai:v2:" + kind.encode("ascii") + b":" + digest

    def _digest(self, purpose: str, *parts: object) -> bytes:
        message = bytearray(purpose.encode("ascii"))
        for part in parts:
            if isinstance(part, bytes):
                encoded = part
            else:
                encoded = str(part).encode("utf-8")
            message.extend(b"\x00")
            message.extend(str(len(encoded)).encode("ascii"))
            message.extend(b":")
            message.extend(encoded)
        return hmac.digest(self._key_secret, bytes(message), hashlib.sha256).hex().encode(
            "ascii"
        )

    @staticmethod
    def _decode_digest(value: object, default: bytes) -> bytes:
        if value is None:
            return default
        if isinstance(value, str):
            value = value.encode("ascii")
        if not isinstance(value, bytes) or _OPAQUE_DIGEST.fullmatch(value) is None:
            raise ValueError("corrupt opaque digest")
        return value

    @staticmethod
    def _decode_counter(value: object) -> int:
        if value is None:
            return 0
        if isinstance(value, bytes):
            raw = value
        elif isinstance(value, str):
            raw = value.encode("ascii")
        else:
            raise ValueError("corrupt allowance counter")
        if not raw.isdigit() or len(raw) > 9:
            raise ValueError("corrupt allowance counter")
        parsed = int(raw)
        if parsed < 0 or parsed > 1_000_000:
            raise ValueError("corrupt allowance counter")
        return parsed

    @staticmethod
    def _validate_subject(subject: str) -> None:
        if (
            not isinstance(subject, str)
            or not subject
            or len(subject) > 512
            or any(ord(character) < 32 or ord(character) == 127 for character in subject)
        ):
            raise ValueError("subject material is invalid")

    def _current_time(self) -> datetime:
        value = self._now()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError("clock must return a timezone-aware datetime")
        converted = value.astimezone(UTC)
        return converted

    @staticmethod
    def _require_plan(plan: PlanSnapshot, now: datetime) -> None:
        if not isinstance(plan, PlanSnapshot):
            raise TypeError("plan must be a verified snapshot")
        try:
            plan.require_current(now)
        except ValueError:
            raise PlanVerificationUnavailable() from None

    @staticmethod
    def _period_ttl(resets_at: datetime, now: datetime) -> int:
        seconds = math.ceil((resets_at - now).total_seconds())
        return max(1, seconds + CHARGED_MARKER_RESET_BUFFER_SECONDS)

    @staticmethod
    def _redis_call(operation: Callable[[], Any]) -> Any:
        failed = False
        try:
            return operation()
        except (AllowanceUnavailable, PlanVerificationUnavailable):
            raise
        except Exception:
            failed = True
        if failed:
            raise AllowanceUnavailable()
        raise AssertionError("unreachable")


class VerifiedEntitlementCache:
    """HMAC-keyed verified plan cache and atomic webhook invalidation boundary."""

    def __init__(
        self,
        redis_client: Any,
        *,
        key_secret: bytes,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not isinstance(key_secret, bytes) or len(key_secret) < 32:
            raise ValueError("key_secret must contain at least 32 bytes")
        self._redis = redis_client
        self._key_secret = key_secret
        self._now = now

    def get(self, app_user_id: str) -> PlanSnapshot | None:
        self._validate_identifier(app_user_id)
        key = self._cache_key(app_user_id)
        current = self.current_time()

        def operation() -> PlanSnapshot | None:
            value = self._redis.get(key)
            if value is None:
                return None
            snapshot, _observed_at = self._decode_cache_value(value)
            try:
                snapshot.require_current(current)
            except ValueError:
                self._redis.delete(key)
                return None
            return snapshot

        return AiAllowanceStore._redis_call(operation)

    def put_verified(
        self,
        app_user_id: str,
        snapshot: PlanSnapshot,
        *,
        observed_at: datetime,
    ) -> None:
        self._validate_identifier(app_user_id)
        if not isinstance(snapshot, PlanSnapshot):
            raise TypeError("snapshot must be a PlanSnapshot")
        observed = self._aware_second(observed_at)
        current = self.current_time()
        try:
            snapshot.require_current(current)
        except ValueError:
            raise ValueError("cannot cache stale verification") from None
        cache_key = self._cache_key(app_user_id)
        watermark_key = self._watermark_key(app_user_id)
        ttl = max(1, math.ceil((snapshot.verified_until - current).total_seconds()))
        encoded = self._encode_cache_value(snapshot, observed)

        def operation() -> None:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(cache_key, watermark_key)
                        watermark = self._decode_epoch(pipe.get(watermark_key))
                        existing = pipe.get(cache_key)
                        existing_observed = -1
                        if existing is not None:
                            _existing_snapshot, existing_time = self._decode_cache_value(
                                existing
                            )
                            existing_observed = self._epoch_millis(existing_time)
                        observed_epoch = self._epoch_millis(observed)
                        if observed_epoch < max(watermark, existing_observed):
                            return
                        pipe.multi()
                        pipe.set(cache_key, encoded, ex=ttl)
                        pipe.execute()
                        return
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        AiAllowanceStore._redis_call(operation)

    def claim_webhook_event(
        self,
        event_id: str,
        effective_at: datetime,
        affected_app_user_ids: list[str] | tuple[str, ...],
    ) -> bool:
        self._validate_identifier(event_id)
        if not affected_app_user_ids or len(affected_app_user_ids) > 64:
            raise ValueError("affected identity list is invalid")
        unique_ids = tuple(dict.fromkeys(affected_app_user_ids))
        for app_user_id in unique_ids:
            self._validate_identifier(app_user_id)
        effective = self._aware_second(effective_at)
        effective_epoch = self._epoch_millis(effective)
        event_key = self._event_key(event_id)
        cache_keys = [self._cache_key(value) for value in unique_ids]
        watermark_keys = [self._watermark_key(value) for value in unique_ids]
        retention = PLAN_CACHE_MAX_SECONDS + CHARGED_MARKER_RESET_BUFFER_SECONDS

        def operation() -> bool:
            watched = [event_key, *cache_keys, *watermark_keys]
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(*watched)
                        if pipe.get(event_key) is not None:
                            return False
                        watermarks = [
                            self._decode_epoch(pipe.get(key)) for key in watermark_keys
                        ]
                        pipe.multi()
                        pipe.set(event_key, b"1", ex=retention, nx=True)
                        for cache_key, watermark_key, watermark in zip(
                            cache_keys, watermark_keys, watermarks, strict=True
                        ):
                            if effective_epoch > watermark:
                                pipe.delete(cache_key)
                                pipe.set(
                                    watermark_key,
                                    str(effective_epoch).encode("ascii"),
                                    ex=retention,
                                )
                        results = pipe.execute()
                        return bool(results[0])
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        return AiAllowanceStore._redis_call(operation)

    def current_time(self) -> datetime:
        return self._aware_second(self._now())

    def _cache_key(self, app_user_id: str) -> bytes:
        return self._key("plan", "entitlement-cache", app_user_id)

    def _watermark_key(self, app_user_id: str) -> bytes:
        return self._key("watermark", "webhook-watermark", app_user_id)

    def _event_key(self, event_id: str) -> bytes:
        return self._key("event", "webhook-event", event_id)

    def _key(self, kind: str, purpose: str, value: str) -> bytes:
        digest = hmac.digest(
            self._key_secret,
            purpose.encode("ascii") + b"\x00" + value.encode("utf-8"),
            hashlib.sha256,
        ).hex()
        return f"rai:ai:v2:{kind}:{digest}".encode("ascii")

    @staticmethod
    def _encode_cache_value(snapshot: PlanSnapshot, observed_at: datetime) -> bytes:
        payload = {
            "entitlement_expires_at": (
                VerifiedEntitlementCache._epoch_millis(
                    snapshot.entitlement_expires_at
                )
                if snapshot.entitlement_expires_at is not None
                else None
            ),
            "kind": snapshot.kind,
            "observed_at": VerifiedEntitlementCache._epoch_millis(observed_at),
            "verified_until": VerifiedEntitlementCache._epoch_millis(
                snapshot.verified_until
            ),
        }
        return json.dumps(payload, sort_keys=True, separators=(",", ":")).encode(
            "ascii"
        )

    @classmethod
    def _decode_cache_value(cls, value: object) -> tuple[PlanSnapshot, datetime]:
        if isinstance(value, bytes):
            raw = value
        elif isinstance(value, str):
            raw = value.encode("ascii")
        else:
            raise ValueError("corrupt entitlement cache")
        if len(raw) > 512:
            raise ValueError("corrupt entitlement cache")
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != {
            "entitlement_expires_at",
            "kind",
            "observed_at",
            "verified_until",
        }:
            raise ValueError("corrupt entitlement cache")
        observed = cls._datetime_from_epoch(payload["observed_at"])
        verified = cls._datetime_from_epoch(payload["verified_until"])
        expiration_value = payload["entitlement_expires_at"]
        expiration = (
            None
            if expiration_value is None
            else cls._datetime_from_epoch(expiration_value)
        )
        return PlanSnapshot(payload["kind"], verified, expiration), observed

    @staticmethod
    def _datetime_from_epoch(value: object) -> datetime:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError("corrupt entitlement cache")
        return datetime.fromtimestamp(value / 1000, tz=UTC)

    @staticmethod
    def _decode_epoch(value: object) -> int:
        if value is None:
            return -1
        if isinstance(value, bytes):
            raw = value
        elif isinstance(value, str):
            raw = value.encode("ascii")
        else:
            raise ValueError("corrupt webhook watermark")
        if not raw.isdigit() or len(raw) > 15:
            raise ValueError("corrupt webhook watermark")
        return int(raw)

    @staticmethod
    def _validate_identifier(value: str) -> None:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > 512
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
        ):
            raise ValueError("opaque identifier is invalid")

    @staticmethod
    def _aware_second(value: datetime) -> datetime:
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError("timestamp must be timezone-aware")
        converted = value.astimezone(UTC)
        return converted

    @staticmethod
    def _epoch_millis(value: datetime) -> int:
        return int(value.timestamp() * 1000)


class NonceReplayStore:
    """Atomic one-use Apple nonce marker using only an HMAC Redis key."""

    def __init__(
        self,
        redis_client: Any,
        *,
        key_secret: bytes,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not isinstance(key_secret, bytes) or len(key_secret) < 32:
            raise ValueError("key_secret must contain at least 32 bytes")
        self._redis = redis_client
        self._key_secret = key_secret
        self._now = now

    def consume(self, raw_nonce: str, expires_at: datetime) -> None:
        if (
            not isinstance(raw_nonce, str)
            or not raw_nonce
            or len(raw_nonce) > 256
            or any(ord(character) < 32 or ord(character) == 127 for character in raw_nonce)
        ):
            raise ValueError("nonce is invalid")
        current = VerifiedEntitlementCache._aware_second(self._now())
        expiration = VerifiedEntitlementCache._aware_second(expires_at)
        ttl = math.ceil((expiration - current).total_seconds())
        if ttl <= 0:
            raise NonceReplayRejected()
        digest = hmac.digest(
            self._key_secret,
            b"apple-nonce-replay-v1\x00" + raw_nonce.encode("utf-8"),
            hashlib.sha256,
        ).hex()
        key = f"rai:ai:v2:nonce:{digest}".encode("ascii")
        accepted = AiAllowanceStore._redis_call(
            lambda: self._redis.set(key, b"1", ex=ttl, nx=True)
        )
        if not accepted:
            raise NonceReplayRejected()


@dataclass(slots=True, repr=False)
class AiAllowanceReservation:
    _store: AiAllowanceStore = field(repr=False)
    _plan: PlanSnapshot
    _period: str
    _resets_at: datetime
    _counter_key: bytes = field(repr=False)
    _lease_key: bytes = field(repr=False)
    _charged_key: bytes = field(repr=False)
    _owner_nonce: bytes | None = field(repr=False)
    _initial_state: str

    def snapshot(self) -> AllowanceSnapshot:
        used = self._store._redis_call(
            lambda: self._store._decode_counter(
                self._store._redis.get(self._counter_key)
            )
        )
        limit = allowance_limit(self._plan)
        return AllowanceSnapshot(
            used=min(used, limit),
            limit=limit,
            resets_at=self._resets_at,
        )

    def begin_dispatch(self) -> DispatchDecision:
        if self._initial_state != "owner" or self._owner_nonce is None:
            disposition = (
                "already_charged"
                if self._initial_state == "already_charged"
                else "duplicate_in_flight"
            )
            return DispatchDecision(disposition, self.snapshot())

        current = self._store._current_time()
        try:
            self._store._require_plan(self._plan, current)
        except PlanVerificationUnavailable:
            self.release()
            raise
        ttl = self._store._period_ttl(self._resets_at, current)
        limit = allowance_limit(self._plan)

        def operation() -> DispatchDecision:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._store._redis.pipeline() as pipe:
                    try:
                        pipe.watch(
                            self._lease_key,
                            self._charged_key,
                            self._counter_key,
                        )
                        lease_owner = pipe.get(self._lease_key)
                        charged = pipe.get(self._charged_key)
                        used = self._store._decode_counter(pipe.get(self._counter_key))
                        if charged is not None:
                            return DispatchDecision(
                                "already_charged",
                                AllowanceSnapshot(min(used, limit), limit, self._resets_at),
                            )
                        if lease_owner != self._owner_nonce:
                            return DispatchDecision(
                                "duplicate_in_flight",
                                AllowanceSnapshot(min(used, limit), limit, self._resets_at),
                            )
                        if used >= limit:
                            pipe.multi()
                            pipe.delete(self._lease_key)
                            pipe.execute()
                            return DispatchDecision(
                                "quota_exhausted",
                                AllowanceSnapshot(limit, limit, self._resets_at),
                            )
                        next_used = used + 1
                        pipe.multi()
                        pipe.set(
                            self._counter_key,
                            str(next_used).encode("ascii"),
                            ex=ttl,
                        )
                        pipe.set(self._charged_key, b"1", ex=ttl, nx=True)
                        pipe.delete(self._lease_key)
                        results = pipe.execute()
                        if results[1]:
                            return DispatchDecision(
                                "started",
                                AllowanceSnapshot(next_used, limit, self._resets_at),
                            )
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        decision = self._store._redis_call(operation)
        if decision.disposition == "started":
            self._initial_state = "already_charged"
        return decision

    def release(self) -> None:
        if self._initial_state != "owner" or self._owner_nonce is None:
            return

        def operation() -> None:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._store._redis.pipeline() as pipe:
                    try:
                        pipe.watch(self._lease_key)
                        if pipe.get(self._lease_key) != self._owner_nonce:
                            return
                        pipe.multi()
                        pipe.delete(self._lease_key)
                        pipe.execute()
                        self._initial_state = "released"
                        return
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        self._store._redis_call(operation)
