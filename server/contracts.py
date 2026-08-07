from __future__ import annotations

import unicodedata
from datetime import datetime, timezone
from re import compile as compile_regex
from typing import Annotated, Literal
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)

from .errors import ErrorCode


ShortText = Annotated[str, StringConstraints(min_length=1, max_length=240)]
InstallationToken = Annotated[str, StringConstraints(min_length=1, max_length=2_048)]
AccountToken = Annotated[str, StringConstraints(min_length=1, max_length=2_048)]
RevenueCatInstallationId = Annotated[
    str,
    StringConstraints(
        min_length=18,
        max_length=160,
        pattern=r"^rai_installation_[A-Za-z0-9_-]+$",
    ),
]
RevenueCatAccountId = Annotated[
    str,
    StringConstraints(
        min_length=13,
        max_length=160,
        pattern=r"^rai_account_[A-Za-z0-9_-]+$",
    ),
]
FeedbackText = Annotated[str, StringConstraints(min_length=1, max_length=600)]
SimulatedRecruiterComment = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=800,
        pattern=r"^Simulated AI recruiter feedback:",
    ),
]
CANONICAL_UUID_V2 = compile_regex(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"
)
CANONICAL_UTC_SECOND = compile_regex(
    r"^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$"
)


def _normalized_keyword(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


def _parse_canonical_utc_second(value: object, *, name: str) -> datetime:
    if not isinstance(value, str) or CANONICAL_UTC_SECOND.fullmatch(value) is None:
        raise ValueError(f"{name} must be a canonical whole-second UTC timestamp")
    try:
        parsed = datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        raise ValueError(
            f"{name} must be a canonical whole-second UTC timestamp"
        ) from None
    return parsed.replace(tzinfo=timezone.utc)


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ScoreComponentsV1(StrictContract):
    model_config = ConfigDict(
        extra="forbid",
        strict=True,
        json_schema_extra={
            "allOf": [
                {
                    "if": {
                        "properties": {"keywords": {"type": "null"}},
                        "required": ["keywords"],
                    },
                    "then": {
                        "properties": {
                            "structure": {"maximum": 30},
                            "impact": {"maximum": 40},
                            "readability": {"maximum": 30},
                            "keywords": {"type": "null"},
                        }
                    },
                    "else": {
                        "properties": {
                            "structure": {"maximum": 25},
                            "impact": {"maximum": 30},
                            "readability": {"maximum": 20},
                            "keywords": {
                                "type": "integer",
                                "minimum": 0,
                                "maximum": 25,
                            },
                        }
                    },
                }
            ]
        },
    )
    structure: int = Field(ge=0, le=30)
    impact: int = Field(ge=0, le=40)
    readability: int = Field(ge=0, le=30)
    keywords: int | None = Field(ge=0, le=25)

    @model_validator(mode="after")
    def enforces_scoring_branch_maxima(self) -> ScoreComponentsV1:
        maxima = (
            {"structure": 30, "impact": 40, "readability": 30}
            if self.keywords is None
            else {"structure": 25, "impact": 30, "readability": 20}
        )
        values = {
            "structure": self.structure,
            "impact": self.impact,
            "readability": self.readability,
        }
        for field, maximum in maxima.items():
            if values[field] > maximum:
                raise ValueError(f"{field} exceeds its scoring-branch maximum")
        return self


class ScoreV1(StrictContract):
    scoreVersion: Literal["resume-readiness-v1"]
    readinessScore: int = Field(ge=0, le=100)
    label: Literal["Needs work", "Developing", "Good", "Strong"]
    components: ScoreComponentsV1
    explanations: list[ShortText] = Field(max_length=12)

    @model_validator(mode="after")
    def has_consistent_score(self) -> ScoreV1:
        component_total = sum(
            value for value in self.components.model_dump().values() if value is not None
        )
        if self.readinessScore != component_total:
            raise ValueError("readinessScore must equal the component total")
        expected_label = (
            "Needs work"
            if self.readinessScore < 50
            else "Developing"
            if self.readinessScore < 70
            else "Good"
            if self.readinessScore < 85
            else "Strong"
        )
        if self.label != expected_label:
            raise ValueError("label must match readinessScore")
        return self


class FeedbackV1(StrictContract):
    matchedKeywords: list[FeedbackText] = Field(max_length=20)
    missingKeywords: list[FeedbackText] = Field(max_length=20)
    strengths: list[FeedbackText] = Field(min_length=1, max_length=12)
    improvements: list[FeedbackText] = Field(min_length=1, max_length=12)
    powerBullets: list[FeedbackText] = Field(max_length=10)
    summary: Annotated[str, StringConstraints(min_length=1, max_length=500)]
    simulatedRecruiterComment: SimulatedRecruiterComment

    @model_validator(mode="after")
    def has_consistent_keyword_lists(self) -> FeedbackV1:
        matched = {_normalized_keyword(value) for value in self.matchedKeywords}
        missing = {_normalized_keyword(value) for value in self.missingKeywords}
        if matched & missing:
            raise ValueError("matchedKeywords and missingKeywords must not overlap")
        return self


class AnalysisResponseV1(StrictContract):
    schemaVersion: Literal[1]
    analysisId: UUID
    sourceType: Literal["pdf", "text", "vision_text"]
    score: ScoreV1
    feedback: FeedbackV1

    @field_validator("analysisId", mode="before")
    @classmethod
    def parses_json_uuid(cls, value: object) -> object:
        return UUID(value) if isinstance(value, str) else value


AiStatusV2 = Literal[
    "complete",
    "not_requested",
    "quota_exhausted",
    "plan_verification_unavailable",
    "temporarily_unavailable",
    "timeout",
    "invalid_provider_response",
]


class AiAllowanceV2(StrictContract):
    used: int = Field(ge=0, le=100)
    limit: Literal[3, 100]
    resetsAt: datetime

    @field_validator("resetsAt", mode="before")
    @classmethod
    def parses_canonical_utc_second(cls, value: object) -> object:
        return _parse_canonical_utc_second(value, name="resetsAt")

    @model_validator(mode="after")
    def used_does_not_exceed_limit(self) -> AiAllowanceV2:
        if self.used > self.limit:
            raise ValueError("used exceeds allowance limit")
        return self


class AiResultV2(StrictContract):
    status: AiStatusV2
    feedback: FeedbackV1 | None
    allowance: AiAllowanceV2 | None

    @model_validator(mode="after")
    def enforces_status_payload(self) -> AiResultV2:
        if self.status == "complete" and (
            self.feedback is None or self.allowance is None
        ):
            raise ValueError("complete AI results require feedback and allowance")
        if self.status != "complete" and self.feedback is not None:
            raise ValueError("feedback is present only for complete AI results")
        return self


class AnalysisResponseV2(StrictContract):
    schemaVersion: Literal[2]
    analysisId: UUID
    sourceType: Literal["reviewed_text", "pdf"]
    score: ScoreV1
    ai: AiResultV2

    @field_validator("analysisId", mode="before")
    @classmethod
    def parses_canonical_json_uuid(cls, value: object) -> object:
        if not isinstance(value, str) or CANONICAL_UUID_V2.fullmatch(value) is None:
            raise ValueError("analysisId must use canonical lowercase UUID spelling")
        return UUID(value)


class InstallationResponseV1(StrictContract):
    schemaVersion: Literal[1]
    installationToken: InstallationToken


class PlanSnapshotV2(StrictContract):
    schemaVersion: Literal[2]
    plan: Literal["free", "pro"]
    verifiedUntil: datetime
    entitlementExpiresAt: datetime | None
    allowance: AiAllowanceV2

    @field_validator("verifiedUntil", "entitlementExpiresAt", mode="before")
    @classmethod
    def parses_canonical_plan_timestamp(cls, value: object, info) -> object:
        if value is None and info.field_name == "entitlementExpiresAt":
            return None
        return _parse_canonical_utc_second(value, name=info.field_name)

    @model_validator(mode="after")
    def enforces_plan_payload(self) -> PlanSnapshotV2:
        if self.plan == "free":
            if self.entitlementExpiresAt is not None or self.allowance.limit != 3:
                raise ValueError("free plan payload is invalid")
        else:
            if (
                self.entitlementExpiresAt is None
                or self.verifiedUntil > self.entitlementExpiresAt
                or self.allowance.limit != 100
            ):
                raise ValueError("pro plan payload is invalid")
        return self


class EntitlementSyncRequestV2(StrictContract):
    pass


class AppleIdentityRequestV2(StrictContract):
    identityToken: Annotated[str, StringConstraints(min_length=1, max_length=8_192)] = Field(
        repr=False
    )
    nonce: Annotated[str, StringConstraints(min_length=8, max_length=256)] = Field(
        repr=False
    )

    @field_validator("identityToken", "nonce")
    @classmethod
    def rejects_control_characters(cls, value: str) -> str:
        if any(ord(character) < 32 or ord(character) == 127 for character in value):
            raise ValueError("sensitive identity field is invalid")
        return value


class AppleIdentityResponseV2(StrictContract):
    schemaVersion: Literal[2]
    accountToken: AccountToken = Field(repr=False)
    expiresAt: datetime
    revenueCatAppUserId: RevenueCatAccountId = Field(repr=False)

    @field_validator("expiresAt", mode="before")
    @classmethod
    def parses_canonical_expiry(cls, value: object) -> object:
        return _parse_canonical_utc_second(value, name="expiresAt")


class InstallationResponseV2(StrictContract):
    schemaVersion: Literal[2]
    installationToken: InstallationToken = Field(repr=False)
    revenueCatAppUserId: RevenueCatInstallationId = Field(repr=False)


class PublicErrorV1(StrictContract):
    schemaVersion: Literal[1]
    code: ErrorCode
    message: Annotated[str, StringConstraints(min_length=1, max_length=240)]
    requestId: UUID
    retryable: bool

    @field_validator("requestId", mode="before")
    @classmethod
    def parses_json_uuid(cls, value: object) -> object:
        return UUID(value) if isinstance(value, str) else value

    @field_validator("code", mode="before")
    @classmethod
    def parses_json_error_code(cls, value: object) -> object:
        return ErrorCode(value) if isinstance(value, str) else value
