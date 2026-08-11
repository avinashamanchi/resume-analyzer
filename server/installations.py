from __future__ import annotations

import base64
import binascii
import hashlib
import hmac
import json
import math
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID, uuid4

from .errors import ErrorCode, PublicServiceError


_TOKEN_VERSION = 1
_DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60
_BASE64URL_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
_CLAIM_NAMES = frozenset({"installation_id", "iat", "exp", "version"})


@dataclass(frozen=True, slots=True)
class InstallationClaims:
    installation_id: UUID
    issued_at: int
    expires_at: int
    version: int


@dataclass(frozen=True, slots=True, repr=False)
class IssuedInstallationV2:
    installation_token: str = field(repr=False)
    revenuecat_app_user_id: str = field(repr=False)


class InvalidInstallationToken(PublicServiceError):
    """A stable, content-free failure for every invalid token shape."""

    def __init__(self) -> None:
        super().__init__(ErrorCode.INVALID_INSTALLATION, retryable=False)


class InstallationTokenService:
    """Issue and verify anonymous HMAC-authenticated installation claims."""

    def __init__(
        self,
        secret: bytes,
        *,
        now: Callable[[], int | float] = time.time,
        ttl_seconds: int = _DEFAULT_TOKEN_TTL_SECONDS,
        revenuecat_identity_key: bytes | None = None,
    ) -> None:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("secret must contain at least 32 bytes")
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
            raise TypeError("ttl_seconds must be an integer")
        if ttl_seconds <= 0:
            raise ValueError("ttl_seconds must be greater than zero")
        self._secret = secret
        self._now = now
        self._ttl_seconds = ttl_seconds
        identity_key = secret if revenuecat_identity_key is None else revenuecat_identity_key
        if not isinstance(identity_key, bytes) or len(identity_key) < 32:
            raise ValueError("revenuecat_identity_key must contain at least 32 bytes")
        self._revenuecat_identity_key = identity_key

    def issue(self) -> str:
        issued_at = self._current_time()
        return self._issue_token(uuid4(), issued_at)

    def issue_v2(self) -> IssuedInstallationV2:
        issued_at = self._current_time()
        installation_id = uuid4()
        token = self._issue_token(installation_id, issued_at)
        claims = InstallationClaims(
            installation_id=installation_id,
            issued_at=issued_at,
            expires_at=issued_at + self._ttl_seconds,
            version=_TOKEN_VERSION,
        )
        return IssuedInstallationV2(
            installation_token=token,
            revenuecat_app_user_id=self.revenuecat_app_user_id(claims),
        )

    def revenuecat_app_user_id(self, claims: InstallationClaims) -> str:
        if not isinstance(claims, InstallationClaims):
            raise TypeError("claims must be verified installation claims")
        digest = hmac.digest(
            self._revenuecat_identity_key,
            b"revenuecat-installation-v1\x00" + str(claims.installation_id).encode("ascii"),
            hashlib.sha256,
        )
        return "rai_installation_" + _encode_base64url(digest)

    def installation_digest(self, claims: InstallationClaims) -> str:
        if not isinstance(claims, InstallationClaims):
            raise TypeError("claims must be verified installation claims")
        digest = hmac.digest(
            self._revenuecat_identity_key,
            b"authenticated-installation-v1\x00" + str(claims.installation_id).encode("ascii"),
            hashlib.sha256,
        )
        return "inst_" + _encode_base64url(digest)

    def _issue_token(self, installation_id: UUID, issued_at: int) -> str:
        payload = {
            "exp": issued_at + self._ttl_seconds,
            "iat": issued_at,
            "installation_id": str(installation_id),
            "version": _TOKEN_VERSION,
        }
        encoded_payload = _encode_base64url(
            json.dumps(
                payload,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode("ascii")
        )
        signature = hmac.digest(
            self._secret,
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        )
        return f"{encoded_payload}.{_encode_base64url(signature)}"

    def verify(self, token: str) -> InstallationClaims:
        claims: InstallationClaims | None = None
        try:
            claims = self._verify(token)
        except (ValueError, TypeError, KeyError, json.JSONDecodeError, binascii.Error):
            pass
        if claims is None:
            raise InvalidInstallationToken()
        return claims

    def _verify(self, token: str) -> InstallationClaims:
        if not isinstance(token, str) or len(token) > 1_024:
            raise ValueError
        parts = token.split(".")
        if len(parts) != 2:
            raise ValueError
        encoded_payload, encoded_signature = parts
        payload_bytes = _decode_base64url(encoded_payload)
        supplied_signature = _decode_base64url(encoded_signature)
        expected_signature = hmac.digest(
            self._secret,
            encoded_payload.encode("ascii"),
            hashlib.sha256,
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ValueError

        payload = json.loads(payload_bytes)
        if not isinstance(payload, dict) or set(payload) != _CLAIM_NAMES:
            raise ValueError
        issued_at = _strict_integer(payload["iat"])
        expires_at = _strict_integer(payload["exp"])
        version = _strict_integer(payload["version"])
        installation_id_text = payload["installation_id"]
        if not isinstance(installation_id_text, str):
            raise ValueError
        installation_id = UUID(installation_id_text)
        if str(installation_id) != installation_id_text:
            raise ValueError
        current_time = self._current_time()
        if (
            version != _TOKEN_VERSION
            or issued_at > current_time
            or expires_at <= issued_at
            or current_time >= expires_at
        ):
            raise ValueError
        return InstallationClaims(
            installation_id=installation_id,
            issued_at=issued_at,
            expires_at=expires_at,
            version=version,
        )

    def _current_time(self) -> int:
        value = self._now()
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("clock must return a finite timestamp")
        if not math.isfinite(value):
            raise ValueError("clock must return a finite timestamp")
        return int(value)


def _strict_integer(value: Any) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError
    return value


def _encode_base64url(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode_base64url(value: str) -> bytes:
    if not value or _BASE64URL_PATTERN.fullmatch(value) is None:
        raise ValueError
    decoded = base64.b64decode(
        value + "=" * (-len(value) % 4),
        altchars=b"-_",
        validate=True,
    )
    if _encode_base64url(decoded) != value:
        raise ValueError
    return decoded
