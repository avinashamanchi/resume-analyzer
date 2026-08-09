from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import threading
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Callable

import httpx
import jwt
from jwt.algorithms import RSAAlgorithm

from .bounded_json import read_bounded_json
from .entitlements import NonceReplayStore


_APPLE_ISSUER = "https://appleid.apple.com"
_APPLE_AUDIENCE = "com.avinashamanchi.resumeai"
_APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys"
_JWKS_MAX_BYTES = 64 * 1024
_JWKS_CACHE_SECONDS = 6 * 60 * 60
_UNKNOWN_KID_COOLDOWN_SECONDS = 30
_MAX_KEYS = 20
_JWKS_DEADLINE_SECONDS = 2.0


class InvalidAppleIdentity(ValueError):
    def __init__(self) -> None:
        super().__init__("invalid_apple_identity")


@dataclass(frozen=True, slots=True, repr=False)
class AppleIdentity:
    account_id: str = field(repr=False)
    revenuecat_app_user_id: str = field(repr=False)


class AppleIdentityVerifier:
    def __init__(
        self,
        *,
        http_client: httpx.Client,
        key_secret: bytes,
        replay_store: NonceReplayStore,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if not isinstance(http_client, httpx.Client):
            raise TypeError("http_client must be an httpx.Client")
        if http_client.follow_redirects:
            raise ValueError("Apple redirects must be disabled")
        if not isinstance(key_secret, bytes) or len(key_secret) < 32:
            raise ValueError("key_secret must contain at least 32 bytes")
        if not isinstance(replay_store, NonceReplayStore):
            raise TypeError("replay_store must be a NonceReplayStore")
        self._http_client = http_client
        self._key_secret = key_secret
        self._replay_store = replay_store
        self._now = now
        self._monotonic = monotonic
        self._keys: dict[str, tuple[Any, datetime]] = {}
        self._refresh_not_before = datetime.min.replace(tzinfo=UTC)
        self._refresh_lock = threading.Lock()

    def verify(self, identity_token: str, nonce: str) -> AppleIdentity:
        if not self._valid_token(identity_token) or not self._valid_nonce(nonce):
            raise InvalidAppleIdentity()
        identity: AppleIdentity | None = None
        failed = False
        try:
            header = jwt.get_unverified_header(identity_token)
            if not isinstance(header, dict) or header.get("alg") != "RS256":
                raise ValueError
            kid = self._bounded_string(header.get("kid"), maximum=128)
            signing_key = self._signing_key(kid)
            claims = jwt.decode(
                identity_token,
                signing_key,
                algorithms=["RS256"],
                audience=_APPLE_AUDIENCE,
                issuer=_APPLE_ISSUER,
                options={
                    "require": ["exp", "iat", "iss", "aud", "sub", "nonce"],
                    "verify_exp": False,
                    "verify_iat": False,
                },
            )
            if not isinstance(claims, dict):
                raise ValueError
            current = self._current_time()
            exp = self._strict_epoch(claims.get("exp"))
            iat = self._strict_epoch(claims.get("iat"))
            if exp <= int(current.timestamp()) or iat > int(current.timestamp()):
                raise ValueError
            subject = self._bounded_string(claims.get("sub"), maximum=512)
            claimed_nonce = self._bounded_string(claims.get("nonce"), maximum=128)
            expected_nonce = hashlib.sha256(nonce.encode("utf-8")).hexdigest()
            if not hmac.compare_digest(claimed_nonce, expected_nonce):
                raise ValueError
            self._replay_store.consume(nonce, datetime.fromtimestamp(exp, tz=UTC))
            identity = AppleIdentity(
                account_id="acct_" + self._opaque("apple-account-v1", subject),
                revenuecat_app_user_id=(
                    "rai_account_" + self._opaque("revenuecat-account-v1", subject)
                ),
            )
        except Exception:
            failed = True
        if failed or identity is None:
            raise InvalidAppleIdentity()
        return identity

    def _signing_key(self, kid: str) -> Any:
        current = self._current_time()
        cached = self._keys.get(kid)
        if cached is not None and current < cached[1]:
            return cached[0]
        started = self._monotonic()
        if not self._valid_monotonic(started):
            raise ValueError
        deadline_at = started + _JWKS_DEADLINE_SECONDS
        if not math.isfinite(deadline_at):
            raise ValueError
        acquired = self._refresh_lock.acquire(
            timeout=self._remaining_refresh_time(deadline_at)
        )
        if not acquired:
            raise ValueError
        try:
            current = self._current_time()
            cached = self._keys.get(kid)
            if cached is not None and current < cached[1]:
                return cached[0]
            if current < self._refresh_not_before:
                raise ValueError
            try:
                keys = self._fetch_keys(deadline_at)
            except Exception:
                self._refresh_not_before = max(
                    self._refresh_not_before,
                    current + timedelta(seconds=_UNKNOWN_KID_COOLDOWN_SECONDS),
                )
                raise
            expires_at = current + timedelta(seconds=_JWKS_CACHE_SECONDS)
            self._keys = {key_id: (key, expires_at) for key_id, key in keys.items()}
            self._refresh_not_before = current + timedelta(
                seconds=_UNKNOWN_KID_COOLDOWN_SECONDS
            )
            selected = self._keys.get(kid)
            if selected is None:
                raise ValueError
            return selected[0]
        finally:
            self._refresh_lock.release()

    def _fetch_keys(self, deadline_at: float) -> dict[str, Any]:
        with self._http_client.stream(
            "GET",
            _APPLE_JWKS_URL,
            headers={
                "Accept": "application/json",
                "Accept-Encoding": "identity",
            },
            timeout=httpx.Timeout(self._remaining_refresh_time(deadline_at)),
        ) as response:
            if response.status_code < 200 or response.status_code >= 300:
                raise ValueError
            payload = read_bounded_json(
                response,
                max_bytes=_JWKS_MAX_BYTES,
                monotonic=self._monotonic,
                deadline_at=deadline_at,
            )
        self._remaining_refresh_time(deadline_at)
        if not isinstance(payload, dict) or set(payload) != {"keys"}:
            raise ValueError
        values = payload["keys"]
        if not isinstance(values, list) or not values or len(values) > _MAX_KEYS:
            raise ValueError
        keys: dict[str, Any] = {}
        for value in values:
            if not isinstance(value, dict):
                raise ValueError
            kid = self._bounded_string(value.get("kid"), maximum=128)
            if (
                kid in keys
                or value.get("kty") != "RSA"
                or value.get("use") != "sig"
                or value.get("alg") != "RS256"
            ):
                raise ValueError
            for required in ("n", "e"):
                self._bounded_string(value.get(required), maximum=4_096)
            keys[kid] = RSAAlgorithm.from_jwk(
                json.dumps(value, sort_keys=True, separators=(",", ":"))
            )
        return keys

    def _remaining_refresh_time(self, deadline_at: float) -> float:
        current = self._monotonic()
        if not self._valid_monotonic(current):
            raise ValueError
        remaining = deadline_at - current
        if not math.isfinite(remaining) or remaining <= 0:
            raise ValueError
        return remaining

    @staticmethod
    def _valid_monotonic(value: object) -> bool:
        return (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
        )

    def _opaque(self, purpose: str, subject: str) -> str:
        return base64.urlsafe_b64encode(
            hmac.digest(
                self._key_secret,
                purpose.encode("ascii") + b"\x00" + subject.encode("utf-8"),
                hashlib.sha256,
            )
        ).rstrip(b"=").decode("ascii")

    def _current_time(self) -> datetime:
        value = self._now()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError
        converted = value.astimezone(UTC)
        return converted

    @staticmethod
    def _strict_epoch(value: object) -> int:
        if isinstance(value, bool) or not isinstance(value, int):
            raise ValueError
        return value

    @staticmethod
    def _bounded_string(value: object, *, maximum: int) -> str:
        if (
            not isinstance(value, str)
            or not value
            or len(value) > maximum
            or any(ord(character) < 32 or ord(character) == 127 for character in value)
        ):
            raise ValueError
        return value

    @staticmethod
    def _valid_token(value: object) -> bool:
        return (
            isinstance(value, str)
            and 0 < len(value) <= 8_192
            and value.count(".") == 2
            and not any(ord(character) < 33 or ord(character) == 127 for character in value)
        )

    @staticmethod
    def _valid_nonce(value: object) -> bool:
        return (
            isinstance(value, str)
            and 8 <= len(value) <= 256
            and not any(ord(character) < 32 or ord(character) == 127 for character in value)
        )
