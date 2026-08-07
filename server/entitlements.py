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
_MAX_CANONICAL_DEPTH = 16
_MAX_CANONICAL_MEMBERS = 64
MAX_AFFECTED_APP_USER_IDS = 64
_CANONICAL_LINK_TTL_SECONDS = 400 * 24 * 60 * 60
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


def unique_affected_app_user_ids(
    values: list[str] | tuple[str, ...],
) -> tuple[str, ...]:
    if not isinstance(values, (list, tuple)) or not values:
        raise ValueError("affected identity list is invalid")
    if any(not isinstance(value, str) or not value for value in values):
        raise ValueError("affected identity list is invalid")
    unique_ids = tuple(dict.fromkeys(values))
    if len(unique_ids) > MAX_AFFECTED_APP_USER_IDS:
        raise ValueError("affected identity list is invalid")
    return unique_ids


@dataclass(frozen=True, slots=True, repr=False)
class _ResolvedIdentity:
    root: bytes = field(repr=False)
    versions: tuple[tuple[bytes, int], ...] = field(repr=False)


@dataclass(frozen=True, slots=True)
class DispatchDecision:
    disposition: Literal[
        "started",
        "duplicate_in_flight",
        "already_charged",
        "quota_exhausted",
        "identity_changed",
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
        owner = secrets.token_hex(16).encode("ascii")
        ttl = self._period_ttl(resets_at, current)

        def operation() -> tuple[
            str,
            bytes | None,
            _ResolvedIdentity,
            bytes,
            bytes,
            bytes,
        ]:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        resolved = self._watch_resolve(pipe, subject_digest)
                        members = self._watch_members(pipe, resolved.root)
                        counter_key = self._counter_key(resolved.root, period)
                        lease_key = self._request_key(
                            "lease", resolved.root, request_id
                        )
                        charged_key = self._request_key(
                            "charged", resolved.root, request_id
                        )
                        lease_keys = tuple(
                            self._request_key("lease", member, request_id)
                            for member in members
                        )
                        charged_keys = tuple(
                            self._request_key("charged", member, request_id)
                            for member in members
                        )
                        pipe.watch(*charged_keys, *lease_keys, counter_key)
                        charged = any(pipe.get(key) is not None for key in charged_keys)
                        existing_owner = any(
                            pipe.get(key) is not None for key in lease_keys
                        )
                        counter = pipe.get(counter_key)
                        if counter is not None:
                            self._decode_counter(counter)
                        if charged:
                            return (
                                "already_charged",
                                None,
                                resolved,
                                counter_key,
                                lease_key,
                                charged_key,
                            )
                        if existing_owner:
                            return (
                                "duplicate_in_flight",
                                None,
                                resolved,
                                counter_key,
                                lease_key,
                                charged_key,
                            )
                        pipe.multi()
                        if counter is None:
                            pipe.set(counter_key, b"0", ex=ttl, nx=True)
                        pipe.set(lease_key, owner, ex=RESERVATION_TTL_SECONDS, nx=True)
                        results = pipe.execute()
                        if results[-1]:
                            return (
                                "owner",
                                owner,
                                resolved,
                                counter_key,
                                lease_key,
                                charged_key,
                            )
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        (
            state,
            owned_nonce,
            resolved,
            counter_key,
            lease_key,
            charged_key,
        ) = self._redis_call(operation)
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
            _subject_digest=subject_digest,
            _canonical_root=resolved.root,
            _identity_versions=resolved.versions,
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

        def operation() -> None:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        installation_identity = self._watch_resolve(
                            pipe, installation_digest
                        )
                        account_identity = self._watch_resolve(pipe, account_digest)
                        installation_canonical = installation_identity.root
                        account_canonical = account_identity.root
                        installation_members = self._watch_members(
                            pipe, installation_canonical
                        )
                        account_members = self._watch_members(pipe, account_canonical)
                        merged_members = {
                            *installation_members,
                            *account_members,
                            *(digest for digest, _generation in installation_identity.versions),
                            *(digest for digest, _generation in account_identity.versions),
                        }
                        if len(merged_members) > _MAX_CANONICAL_MEMBERS:
                            raise ValueError("opaque identity group is too large")
                        member_identities: list[_ResolvedIdentity] = []
                        expected_roots = {
                            installation_canonical,
                            account_canonical,
                        }
                        for member in sorted(merged_members):
                            identity = self._watch_resolve(pipe, member)
                            if identity.root not in expected_roots:
                                raise ValueError("corrupt opaque identity group")
                            member_identities.append(identity)
                        identities = self._merge_identity_versions(
                            installation_identity,
                            account_identity,
                            *member_identities,
                        )
                        merged_members.update(
                            digest for digest, _generation in identities
                        )
                        if len(merged_members) > _MAX_CANONICAL_MEMBERS:
                            raise ValueError("opaque identity group is too large")
                        link_changed = (
                            installation_canonical != account_canonical
                            or merged_members != set(account_members)
                        )
                        installation_counter = self._counter_key(
                            installation_canonical, period
                        )
                        account_counter = self._counter_key(account_canonical, period)
                        pipe.watch(installation_counter, account_counter)
                        installation_used = self._decode_counter(
                            pipe.get(installation_counter)
                        )
                        account_used = self._decode_counter(pipe.get(account_counter))
                        combined = account_used
                        if installation_canonical != account_canonical:
                            combined = installation_used + account_used
                            if combined > 1_000_000:
                                raise ValueError("corrupt allowance counter")
                        if (
                            link_changed
                            and any(
                                generation >= 1_000_000_000
                                for _digest, generation in identities
                            )
                        ):
                            raise ValueError("corrupt link generation")
                        pipe.multi()
                        for digest, generation in identities:
                            if digest != account_canonical:
                                pipe.set(
                                    self._root_key(digest),
                                    account_canonical,
                                    ex=_CANONICAL_LINK_TTL_SECONDS,
                                )
                            if not link_changed:
                                pipe.set(
                                    self._generation_key(digest),
                                    str(generation).encode("ascii"),
                                    ex=_CANONICAL_LINK_TTL_SECONDS,
                                )
                            else:
                                pipe.set(
                                    self._generation_key(digest),
                                    str(generation + 1).encode("ascii"),
                                    ex=_CANONICAL_LINK_TTL_SECONDS,
                                )
                        pipe.set(
                            self._members_key(account_canonical),
                            self._encode_members(merged_members),
                            ex=_CANONICAL_LINK_TTL_SECONDS,
                        )
                        if installation_canonical != account_canonical:
                            pipe.set(
                                account_counter,
                                str(combined).encode("ascii"),
                                ex=ttl,
                            )
                            pipe.delete(installation_counter)
                            pipe.delete(self._members_key(installation_canonical))
                        pipe.execute()
                        return
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        self._redis_call(operation)

    def _watch_resolve(self, pipe: Any, subject_digest: bytes) -> _ResolvedIdentity:
        current = self._decode_digest(subject_digest, subject_digest)
        seen: set[bytes] = set()
        versions: list[tuple[bytes, int]] = []
        for _ in range(_MAX_CANONICAL_DEPTH):
            if current in seen:
                raise ValueError("cyclic opaque identity")
            seen.add(current)
            root_key = self._root_key(current)
            generation_key = self._generation_key(current)
            pipe.watch(root_key, generation_key)
            generation = self._decode_generation(pipe.get(generation_key))
            versions.append((current, generation))
            parent_value = pipe.get(root_key)
            if parent_value is None:
                return _ResolvedIdentity(current, tuple(versions))
            parent = self._decode_digest(parent_value, current)
            if parent == current:
                raise ValueError("cyclic opaque identity")
            current = parent
        raise ValueError("opaque identity chain is too deep")

    @staticmethod
    def _merge_identity_versions(
        *identities: _ResolvedIdentity,
    ) -> tuple[tuple[bytes, int], ...]:
        merged: dict[bytes, int] = {}
        for identity in identities:
            for digest, generation in identity.versions:
                previous = merged.get(digest)
                if previous is not None and previous != generation:
                    raise ValueError("corrupt link generation")
                merged[digest] = generation
        return tuple(merged.items())

    def _root_key(self, subject_digest: bytes) -> bytes:
        return self._key("root", self._digest("root-key", subject_digest))

    def _members_key(self, canonical: bytes) -> bytes:
        return self._key("members", self._digest("group-members", canonical))

    def _watch_members(self, pipe: Any, canonical: bytes) -> tuple[bytes, ...]:
        key = self._members_key(canonical)
        pipe.watch(key)
        return self._decode_members(pipe.get(key), canonical)

    @staticmethod
    def _encode_members(members: set[bytes]) -> bytes:
        return json.dumps(
            sorted(value.decode("ascii") for value in members),
            separators=(",", ":"),
        ).encode("ascii")

    @staticmethod
    def _decode_members(value: object, canonical: bytes) -> tuple[bytes, ...]:
        if value is None:
            return (canonical,)
        if isinstance(value, str):
            raw = value.encode("ascii")
        elif isinstance(value, bytes):
            raw = value
        else:
            raise ValueError("corrupt opaque identity group")
        if len(raw) > 4_300:
            raise ValueError("corrupt opaque identity group")
        decoded = json.loads(raw)
        if (
            not isinstance(decoded, list)
            or not decoded
            or len(decoded) > _MAX_CANONICAL_MEMBERS
        ):
            raise ValueError("corrupt opaque identity group")
        if any(not isinstance(item, str) for item in decoded):
            raise ValueError("corrupt opaque identity group")
        members = tuple(
            AiAllowanceStore._decode_digest(item, canonical) for item in decoded
        )
        if len(set(members)) != len(members) or canonical not in members:
            raise ValueError("corrupt opaque identity group")
        return members

    def _generation_key(self, subject_digest: bytes) -> bytes:
        return self._key(
            "generation", self._digest("link-generation", subject_digest)
        )

    def _counter_key(self, canonical: bytes, period: str) -> bytes:
        return self._key("counter", self._digest("month-counter", canonical, period))

    def _request_key(self, purpose: str, canonical: bytes, request_id: UUID) -> bytes:
        return self._key(
            purpose,
            self._digest(f"request-{purpose}", canonical, str(request_id)),
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
    def _decode_generation(value: object) -> int:
        if value is None:
            return 0
        if isinstance(value, bytes):
            raw = value
        elif isinstance(value, str):
            raw = value.encode("ascii")
        else:
            raise ValueError("corrupt link generation")
        if not raw.isdigit() or len(raw) > 10:
            raise ValueError("corrupt link generation")
        generation = int(raw)
        if generation > 1_000_000_000:
            raise ValueError("corrupt link generation")
        return generation

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
        snapshot, _generation = self.get_with_generation(app_user_id)
        return snapshot

    def get_with_generation(
        self, app_user_id: str
    ) -> tuple[PlanSnapshot | None, int]:
        self._validate_identifier(app_user_id)
        cache_key = self._cache_key(app_user_id)
        generation_key = self._generation_key(app_user_id)
        current = self.current_time()

        def operation() -> tuple[PlanSnapshot | None, int]:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(cache_key, generation_key)
                        pipe.multi()
                        pipe.get(cache_key)
                        pipe.get(generation_key)
                        value, generation_value = pipe.execute()
                        break
                    except WatchError:
                        continue
            else:
                raise AllowanceUnavailable()
            generation = self._decode_generation(generation_value)
            if value is None:
                return None, generation
            snapshot, _observed_at = self._decode_cache_value(value)
            try:
                snapshot.require_current(current)
            except ValueError:
                return None, generation
            return snapshot, generation

        return AiAllowanceStore._redis_call(operation)

    def generation_matches(self, app_user_id: str, expected_generation: int) -> bool:
        self._validate_identifier(app_user_id)
        self._validate_generation(expected_generation)
        generation_key = self._generation_key(app_user_id)
        return AiAllowanceStore._redis_call(
            lambda: self._decode_generation(self._redis.get(generation_key))
            == expected_generation
        )

    def put_verified(
        self,
        app_user_id: str,
        snapshot: PlanSnapshot,
        *,
        observed_at: datetime,
    ) -> None:
        _cached, generation = self.get_with_generation(app_user_id)
        if not self.put_verified_if_generation(
            app_user_id,
            snapshot,
            observed_at=observed_at,
            expected_generation=generation,
        ):
            raise AllowanceUnavailable()

    def put_verified_if_generation(
        self,
        app_user_id: str,
        snapshot: PlanSnapshot,
        *,
        observed_at: datetime,
        expected_generation: int,
    ) -> bool:
        self._validate_identifier(app_user_id)
        self._validate_generation(expected_generation)
        if not isinstance(snapshot, PlanSnapshot):
            raise TypeError("snapshot must be a PlanSnapshot")
        observed = self._aware_second(observed_at)
        current = self.current_time()
        try:
            snapshot.require_current(current)
        except ValueError:
            raise ValueError("cannot cache stale verification") from None
        cache_key = self._cache_key(app_user_id)
        generation_key = self._generation_key(app_user_id)
        ttl = max(1, math.ceil((snapshot.verified_until - current).total_seconds()))
        encoded = self._encode_cache_value(snapshot, observed)

        def operation() -> bool:
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(cache_key, generation_key)
                        generation = self._decode_generation(pipe.get(generation_key))
                        if generation != expected_generation:
                            return False
                        existing = pipe.get(cache_key)
                        existing_observed = -1
                        if existing is not None:
                            _existing_snapshot, existing_time = self._decode_cache_value(
                                existing
                            )
                            existing_observed = self._epoch_millis(existing_time)
                        observed_epoch = self._epoch_millis(observed)
                        if observed_epoch < existing_observed:
                            return True
                        pipe.multi()
                        pipe.set(cache_key, encoded, ex=ttl)
                        pipe.execute()
                        return True
                    except WatchError:
                        continue
            raise AllowanceUnavailable()

        return AiAllowanceStore._redis_call(operation)

    def claim_webhook_event(
        self,
        event_id: str,
        effective_at: datetime,
        affected_app_user_ids: list[str] | tuple[str, ...],
    ) -> bool:
        self._validate_identifier(event_id)
        unique_ids = unique_affected_app_user_ids(affected_app_user_ids)
        for app_user_id in unique_ids:
            self._validate_identifier(app_user_id)
        self._aware_second(effective_at)
        event_key = self._event_key(event_id)
        cache_keys = [self._cache_key(value) for value in unique_ids]
        generation_keys = [self._generation_key(value) for value in unique_ids]
        retention = PLAN_CACHE_MAX_SECONDS + CHARGED_MARKER_RESET_BUFFER_SECONDS

        def operation() -> bool:
            watched = [event_key, *cache_keys, *generation_keys]
            for _ in range(_MAX_TRANSACTION_ATTEMPTS):
                with self._redis.pipeline() as pipe:
                    try:
                        pipe.watch(*watched)
                        if pipe.get(event_key) is not None:
                            return False
                        generations = [
                            self._decode_generation(pipe.get(key))
                            for key in generation_keys
                        ]
                        if any(value >= 1_000_000_000 for value in generations):
                            raise ValueError("corrupt entitlement generation")
                        pipe.multi()
                        pipe.set(event_key, b"1", ex=retention, nx=True)
                        for cache_key, generation_key, generation in zip(
                            cache_keys, generation_keys, generations, strict=True
                        ):
                            pipe.delete(cache_key)
                            pipe.set(
                                generation_key,
                                str(generation + 1).encode("ascii"),
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

    def _generation_key(self, app_user_id: str) -> bytes:
        return self._key("generation", "webhook-generation", app_user_id)

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
    def _decode_generation(value: object) -> int:
        if value is None:
            return 0
        if isinstance(value, bytes):
            raw = value
        elif isinstance(value, str):
            raw = value.encode("ascii")
        else:
            raise ValueError("corrupt entitlement generation")
        if not raw.isdigit() or len(raw) > 10:
            raise ValueError("corrupt entitlement generation")
        generation = int(raw)
        if generation > 1_000_000_000:
            raise ValueError("corrupt entitlement generation")
        return generation

    @staticmethod
    def _validate_generation(value: object) -> None:
        if (
            isinstance(value, bool)
            or not isinstance(value, int)
            or value < 0
            or value > 1_000_000_000
        ):
            raise ValueError("entitlement generation is invalid")

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
    _subject_digest: bytes = field(repr=False)
    _canonical_root: bytes = field(repr=False)
    _identity_versions: tuple[tuple[bytes, int], ...] = field(repr=False)

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
            if self._initial_state == "already_charged":
                disposition = "already_charged"
            elif self._initial_state == "identity_changed":
                disposition = "identity_changed"
            else:
                disposition = "duplicate_in_flight"
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
                        resolved = self._store._watch_resolve(
                            pipe, self._subject_digest
                        )
                        pipe.watch(
                            self._lease_key,
                            self._charged_key,
                            self._counter_key,
                        )
                        lease_owner = pipe.get(self._lease_key)
                        charged = pipe.get(self._charged_key)
                        used = self._store._decode_counter(pipe.get(self._counter_key))
                        identity_changed = (
                            resolved.root != self._canonical_root
                            or resolved.versions != self._identity_versions
                        )
                        if identity_changed:
                            pipe.multi()
                            if lease_owner == self._owner_nonce:
                                pipe.delete(self._lease_key)
                            pipe.execute()
                            return DispatchDecision(
                                "identity_changed",
                                AllowanceSnapshot(
                                    min(used, limit), limit, self._resets_at
                                ),
                            )
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
        elif decision.disposition == "identity_changed":
            self._initial_state = "identity_changed"
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
