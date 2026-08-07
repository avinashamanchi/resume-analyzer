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


_TOKEN_PURPOSE = "resume-ai-account-token-v1"
_TOKEN_VERSION = 1
_MAX_TTL_SECONDS = 900
_BASE64URL_PATTERN = re.compile(r"[A-Za-z0-9_-]+")
_ACCOUNT_PATTERN = re.compile(r"acct_[A-Za-z0-9_-]{16,128}")
_INSTALLATION_DIGEST_PATTERN = re.compile(r"inst_[A-Za-z0-9_-]{16,128}")
_CLAIMS = frozenset(
    {
        "account_id",
        "exp",
        "iat",
        "installation_digest",
        "purpose",
        "version",
    }
)


class InvalidAccountToken(ValueError):
    def __init__(self) -> None:
        super().__init__("invalid_account_token")


@dataclass(frozen=True, slots=True, repr=False)
class AccountTokenClaims:
    account_id: str = field(repr=False)
    installation_digest: str = field(repr=False)
    issued_at: int
    expires_at: int
    version: int


@dataclass(frozen=True, slots=True, repr=False)
class IssuedAccountToken:
    token: str = field(repr=False)
    expires_at: int


class AccountTokenService:
    def __init__(
        self,
        secret: bytes,
        *,
        now: Callable[[], int | float] = time.time,
        ttl_seconds: int = _MAX_TTL_SECONDS,
    ) -> None:
        if not isinstance(secret, bytes) or len(secret) < 32:
            raise ValueError("secret must contain at least 32 bytes")
        if isinstance(ttl_seconds, bool) or not isinstance(ttl_seconds, int):
            raise TypeError("ttl_seconds must be an integer")
        if ttl_seconds <= 0 or ttl_seconds > _MAX_TTL_SECONDS:
            raise ValueError("ttl_seconds must be between 1 and 900")
        self._secret = secret
        self._now = now
        self._ttl_seconds = ttl_seconds

    def issue(self, account_id: str, installation_digest: str) -> IssuedAccountToken:
        self._validate_claims(account_id, installation_digest)
        issued_at = self._current_time()
        expires_at = issued_at + self._ttl_seconds
        claims = {
            "account_id": account_id,
            "exp": expires_at,
            "iat": issued_at,
            "installation_digest": installation_digest,
            "purpose": _TOKEN_PURPOSE,
            "version": _TOKEN_VERSION,
        }
        encoded = _encode_base64url(
            json.dumps(
                claims,
                sort_keys=True,
                separators=(",", ":"),
                ensure_ascii=True,
            ).encode("ascii")
        )
        signature = hmac.digest(
            self._secret,
            _TOKEN_PURPOSE.encode("ascii") + b"\x00" + encoded.encode("ascii"),
            hashlib.sha256,
        )
        return IssuedAccountToken(
            token=f"{encoded}.{_encode_base64url(signature)}",
            expires_at=expires_at,
        )

    def verify(self, token: str, installation_digest: str) -> AccountTokenClaims:
        claims: AccountTokenClaims | None = None
        try:
            claims = self._verify(token, installation_digest)
        except (ValueError, TypeError, KeyError, json.JSONDecodeError, binascii.Error):
            pass
        if claims is None:
            raise InvalidAccountToken()
        return claims

    def _verify(self, token: str, installation_digest: str) -> AccountTokenClaims:
        self._validate_installation_digest(installation_digest)
        if not isinstance(token, str) or not token or len(token) > 2_048:
            raise ValueError
        parts = token.split(".")
        if len(parts) != 2:
            raise ValueError
        encoded, supplied_signature_text = parts
        supplied_signature = _decode_base64url(supplied_signature_text)
        expected_signature = hmac.digest(
            self._secret,
            _TOKEN_PURPOSE.encode("ascii") + b"\x00" + encoded.encode("ascii"),
            hashlib.sha256,
        )
        if not hmac.compare_digest(supplied_signature, expected_signature):
            raise ValueError
        raw = _decode_base64url(encoded)
        payload = json.loads(raw)
        if not isinstance(payload, dict) or set(payload) != _CLAIMS:
            raise ValueError
        account_id = payload["account_id"]
        bound_installation = payload["installation_digest"]
        self._validate_claims(account_id, bound_installation)
        if not hmac.compare_digest(bound_installation, installation_digest):
            raise ValueError
        issued_at = _strict_integer(payload["iat"])
        expires_at = _strict_integer(payload["exp"])
        version = _strict_integer(payload["version"])
        now = self._current_time()
        if (
            payload["purpose"] != _TOKEN_PURPOSE
            or version != _TOKEN_VERSION
            or issued_at > now
            or expires_at <= issued_at
            or expires_at - issued_at > _MAX_TTL_SECONDS
            or now >= expires_at
        ):
            raise ValueError
        return AccountTokenClaims(
            account_id=account_id,
            installation_digest=bound_installation,
            issued_at=issued_at,
            expires_at=expires_at,
            version=version,
        )

    @staticmethod
    def _validate_claims(account_id: object, installation_digest: object) -> None:
        if not isinstance(account_id, str) or _ACCOUNT_PATTERN.fullmatch(account_id) is None:
            raise ValueError("account identity is invalid")
        AccountTokenService._validate_installation_digest(installation_digest)

    @staticmethod
    def _validate_installation_digest(value: object) -> None:
        if (
            not isinstance(value, str)
            or _INSTALLATION_DIGEST_PATTERN.fullmatch(value) is None
        ):
            raise ValueError("installation identity is invalid")

    def _current_time(self) -> int:
        value = self._now()
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
        ):
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
