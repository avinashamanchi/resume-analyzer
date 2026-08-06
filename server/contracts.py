from __future__ import annotations

import unicodedata
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
FeedbackText = Annotated[str, StringConstraints(min_length=1, max_length=600)]
SimulatedRecruiterComment = Annotated[
    str,
    StringConstraints(
        min_length=1,
        max_length=800,
        pattern=r"^Simulated AI recruiter feedback:",
    ),
]


def _normalized_keyword(value: str) -> str:
    return unicodedata.normalize("NFKC", value).strip().casefold()


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
        for field, maximum in maxima.items():
            if getattr(self, field) > maximum:
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


class InstallationResponseV1(StrictContract):
    schemaVersion: Literal[1]
    installationToken: InstallationToken


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
