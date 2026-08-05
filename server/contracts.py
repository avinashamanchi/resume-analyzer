from __future__ import annotations

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
FeedbackText = Annotated[str, StringConstraints(min_length=1, max_length=600)]


class StrictContract(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ScoreComponentsV1(StrictContract):
    structure: int = Field(ge=0, le=30)
    impact: int = Field(ge=0, le=40)
    readability: int = Field(ge=0, le=30)
    keywords: int | None = Field(ge=0, le=25)


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
    verdict: Annotated[str, StringConstraints(min_length=1, max_length=800)]


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
