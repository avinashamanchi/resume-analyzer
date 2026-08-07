from __future__ import annotations

import hmac
import math
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Callable, Mapping
from urllib.parse import quote

import httpx

from .bounded_json import decode_bounded_json, read_bounded_json
from .entitlements import VerifiedEntitlementCache
from .plans import PLAN_CACHE_MAX_SECONDS, PlanSnapshot


_API_BASE = "https://api.revenuecat.com/v1/subscribers/"
_MAX_RESPONSE_BYTES = 256 * 1024
_MAX_WEBHOOK_SKEW = timedelta(minutes=10)
_SUPPORTED_EVENTS = frozenset(
    {
        "INITIAL_PURCHASE",
        "RENEWAL",
        "CANCELLATION",
        "UNCANCELLATION",
        "NON_RENEWING_PURCHASE",
        "SUBSCRIPTION_PAUSED",
        "EXPIRATION",
        "BILLING_ISSUE",
        "PRODUCT_CHANGE",
        "TRANSFER",
        "REFUND",
    }
)


class EntitlementUnavailable(RuntimeError):
    def __init__(self) -> None:
        super().__init__("entitlement_unavailable")


class InvalidRevenueCatWebhook(ValueError):
    def __init__(self) -> None:
        super().__init__("invalid_revenuecat_webhook")


@dataclass(frozen=True, slots=True, repr=False)
class RevenueCatEvent:
    event_id: str = field(repr=False)
    app_user_id: str = field(repr=False)
    original_app_user_id: str = field(repr=False)
    aliases: tuple[str, ...] = field(repr=False)
    transferred_from: tuple[str, ...] = field(repr=False)
    transferred_to: tuple[str, ...] = field(repr=False)
    event_type: str
    product_id: str | None
    entitlement_ids: tuple[str, ...]
    effective_at: datetime

    @property
    def affected_app_user_ids(self) -> tuple[str, ...]:
        values = (
            self.app_user_id,
            self.original_app_user_id,
            *self.aliases,
            *self.transferred_from,
            *self.transferred_to,
        )
        return tuple(dict.fromkeys(values))


class RevenueCatClient:
    def __init__(
        self,
        *,
        secret_api_key: str,
        http_client: httpx.Client,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
        monotonic: Callable[[], float] = time.monotonic,
    ) -> None:
        if (
            not isinstance(secret_api_key, str)
            or not secret_api_key.startswith("sk_")
            or len(secret_api_key) < 32
        ):
            raise ValueError("RevenueCat server credential is invalid")
        if not isinstance(http_client, httpx.Client):
            raise TypeError("http_client must be an httpx.Client")
        if http_client.follow_redirects:
            raise ValueError("RevenueCat redirects must be disabled")
        self._secret_api_key = secret_api_key
        self._http_client = http_client
        self._now = now
        self._monotonic = monotonic

    def fetch_plan(self, app_user_id: str, deadline: float) -> PlanSnapshot:
        if not self._valid_identifier(app_user_id) or not self._valid_deadline(deadline):
            raise EntitlementUnavailable()
        result: PlanSnapshot | None = None
        failed = False
        try:
            started = self._monotonic()
            url = _API_BASE + quote(app_user_id, safe="")
            with self._http_client.stream(
                "GET",
                url,
                headers={
                    "Accept": "application/json",
                    "Authorization": f"Bearer {self._secret_api_key}",
                },
                timeout=httpx.Timeout(deadline),
            ) as response:
                if response.status_code < 200 or response.status_code >= 300:
                    raise ValueError
                payload = read_bounded_json(response, max_bytes=_MAX_RESPONSE_BYTES)
            if self._monotonic() - started > deadline:
                raise ValueError
            result = self._decode_plan(payload)
        except Exception:
            failed = True
        if failed or result is None:
            raise EntitlementUnavailable()
        return result

    def _decode_plan(self, payload: object) -> PlanSnapshot:
        if not isinstance(payload, dict) or not isinstance(payload.get("subscriber"), dict):
            raise ValueError
        subscriber = payload["subscriber"]
        entitlements = subscriber.get("entitlements")
        if not isinstance(entitlements, dict):
            raise ValueError
        now = self._aware_second(self._now())
        expiration: datetime | None = None
        if "resume_pro" in entitlements:
            entitlement = entitlements["resume_pro"]
            if not isinstance(entitlement, dict) or set(entitlement) != {"expires_date"}:
                raise ValueError
            expiration = self._parse_timestamp(entitlement["expires_date"])
        maximum = now + timedelta(seconds=PLAN_CACHE_MAX_SECONDS)
        if expiration is None or expiration <= now:
            return PlanSnapshot("free", maximum, None)
        return PlanSnapshot("pro", min(maximum, expiration), expiration)

    @staticmethod
    def _parse_timestamp(value: object) -> datetime:
        if not isinstance(value, str) or not value or len(value) > 64:
            raise ValueError
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return RevenueCatClient._aware_second(parsed)

    @staticmethod
    def _aware_second(value: datetime) -> datetime:
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError
        converted = value.astimezone(UTC)
        return converted

    @staticmethod
    def _valid_identifier(value: object) -> bool:
        return (
            isinstance(value, str)
            and 0 < len(value) <= 512
            and not any(ord(character) < 32 or ord(character) == 127 for character in value)
        )

    @staticmethod
    def _valid_deadline(value: object) -> bool:
        return (
            not isinstance(value, bool)
            and isinstance(value, (int, float))
            and math.isfinite(value)
            and 0 < value <= 2
        )


class RevenueCatPlanVerifier:
    def __init__(
        self, cache: VerifiedEntitlementCache, client: RevenueCatClient
    ) -> None:
        self._cache = cache
        self._client = client

    def verify(self, app_user_id: str, *, deadline: float) -> PlanSnapshot:
        cached = self._cache.get(app_user_id)
        if cached is not None:
            return cached
        snapshot = self._client.fetch_plan(app_user_id, deadline)
        self._cache.put_verified(
            app_user_id,
            snapshot,
            observed_at=self._cache.current_time(),
        )
        return snapshot


class RevenueCatWebhook:
    def __init__(
        self,
        *,
        webhook_secret: str,
        app_id: str,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        if not isinstance(webhook_secret, str) or len(webhook_secret) < 32:
            raise ValueError("webhook secret is invalid")
        self._webhook_secret = webhook_secret
        self._app_id = self._bounded_string(app_id, maximum=128)
        self._now = now

    def decode(self, headers: Mapping[str, str], body: bytes) -> RevenueCatEvent:
        result: RevenueCatEvent | None = None
        failed = False
        try:
            authorization = headers.get("Authorization", "")
            expected = f"Bearer {self._webhook_secret}"
            if not hmac.compare_digest(authorization, expected):
                raise ValueError
            payload = decode_bounded_json(body, max_bytes=_MAX_RESPONSE_BYTES)
            result = self._decode_event(payload)
        except Exception:
            failed = True
        if failed or result is None:
            raise InvalidRevenueCatWebhook()
        return result

    def _decode_event(self, payload: object) -> RevenueCatEvent:
        if not isinstance(payload, dict) or set(payload) != {"api_version", "event"}:
            raise ValueError
        if payload["api_version"] != "1.0" or not isinstance(payload["event"], dict):
            raise ValueError
        event = payload["event"]
        expected_fields = {
            "id",
            "app_id",
            "app_user_id",
            "original_app_user_id",
            "aliases",
            "transferred_from",
            "transferred_to",
            "type",
            "product_id",
            "entitlement_ids",
            "event_timestamp_ms",
        }
        if set(event) != expected_fields:
            raise ValueError
        if self._bounded_string(event["app_id"], maximum=128) != self._app_id:
            raise ValueError
        event_type = self._bounded_string(event["type"], maximum=64)
        if event_type not in _SUPPORTED_EVENTS:
            raise ValueError
        timestamp_ms = event["event_timestamp_ms"]
        if isinstance(timestamp_ms, bool) or not isinstance(timestamp_ms, int):
            raise ValueError
        effective_at = datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC)
        now = RevenueCatClient._aware_second(self._now())
        if abs(effective_at - now) > _MAX_WEBHOOK_SKEW:
            raise ValueError
        product = event["product_id"]
        if product is not None:
            product = self._bounded_string(product, maximum=256)
        return RevenueCatEvent(
            event_id=self._bounded_string(event["id"], maximum=256),
            app_user_id=self._bounded_string(event["app_user_id"], maximum=512),
            original_app_user_id=self._bounded_string(
                event["original_app_user_id"], maximum=512
            ),
            aliases=self._bounded_list(event["aliases"]),
            transferred_from=self._bounded_list(event["transferred_from"]),
            transferred_to=self._bounded_list(event["transferred_to"]),
            event_type=event_type,
            product_id=product,
            entitlement_ids=self._bounded_list(event["entitlement_ids"], maximum=16),
            effective_at=effective_at,
        )

    @classmethod
    def _bounded_list(cls, value: object, *, maximum: int = 32) -> tuple[str, ...]:
        if not isinstance(value, list) or len(value) > maximum:
            raise ValueError
        result = tuple(cls._bounded_string(item, maximum=512) for item in value)
        if len(set(result)) != len(result):
            raise ValueError
        return result

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
