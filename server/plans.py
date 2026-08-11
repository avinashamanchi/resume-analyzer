from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Literal


PlanKind = Literal["free", "pro"]
FREE_AI_LIMIT = 3
PRO_AI_LIMIT = 100
RESERVATION_TTL_SECONDS = 15
CHARGED_MARKER_RESET_BUFFER_SECONDS = 172_800
PLAN_CACHE_MAX_SECONDS = 90_000


def _utc(value: datetime, *, name: str) -> datetime:
    if not isinstance(value, datetime) or value.tzinfo is None:
        raise ValueError(f"{name} must be timezone-aware")
    return value.astimezone(UTC)


@dataclass(frozen=True, slots=True)
class PlanSnapshot:
    kind: PlanKind
    verified_until: datetime
    entitlement_expires_at: datetime | None

    def __post_init__(self) -> None:
        if self.kind not in ("free", "pro"):
            raise ValueError("plan kind is invalid")
        verified_until = _utc(self.verified_until, name="verified_until")
        expiration = self.entitlement_expires_at
        if self.kind == "free":
            if expiration is not None:
                raise ValueError("free plan cannot have an entitlement expiration")
        else:
            if expiration is None:
                raise ValueError("pro plan requires an entitlement expiration")
            expiration = _utc(expiration, name="entitlement_expires_at")
            if verified_until > expiration:
                raise ValueError("verification cannot outlive entitlement")
        object.__setattr__(self, "verified_until", verified_until)
        object.__setattr__(self, "entitlement_expires_at", expiration)

    def require_current(self, now: datetime) -> None:
        current = _utc(now, name="now")
        if current >= self.verified_until:
            raise ValueError("plan verification is unavailable")
        if (
            self.kind == "pro"
            and self.entitlement_expires_at is not None
            and current >= self.entitlement_expires_at
        ):
            raise ValueError("plan verification is unavailable")


@dataclass(frozen=True, slots=True)
class AllowanceSnapshot:
    used: int
    limit: Literal[3, 100]
    resets_at: datetime

    def __post_init__(self) -> None:
        if isinstance(self.used, bool) or not isinstance(self.used, int) or self.used < 0:
            raise ValueError("allowance usage is invalid")
        if self.limit not in (FREE_AI_LIMIT, PRO_AI_LIMIT):
            raise ValueError("allowance limit is invalid")
        reset = _utc(self.resets_at, name="resets_at")
        if reset.microsecond:
            raise ValueError("resets_at must have whole-second precision")
        object.__setattr__(self, "resets_at", reset)


def allowance_limit(plan: PlanSnapshot | PlanKind) -> Literal[3, 100]:
    kind = plan.kind if isinstance(plan, PlanSnapshot) else plan
    if kind == "free":
        return FREE_AI_LIMIT
    if kind == "pro":
        return PRO_AI_LIMIT
    raise ValueError("plan kind is invalid")


def utc_month_window(now: datetime) -> tuple[str, datetime]:
    current = _utc(now, name="now")
    if current.month == 12:
        reset = datetime(current.year + 1, 1, 1, tzinfo=UTC)
    else:
        reset = datetime(current.year, current.month + 1, 1, tzinfo=UTC)
    return f"{current.year:04d}-{current.month:02d}", reset
