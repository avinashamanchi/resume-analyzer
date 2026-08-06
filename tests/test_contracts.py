from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from server.contracts import AnalysisResponseV1, PublicErrorV1
from server.errors import ErrorCode


def fixture(name: str) -> dict[str, object]:
    return json.loads(Path("contracts/fixtures", name).read_text())


def test_analysis_fixture_is_strict():
    valid = fixture("analysis-valid.json")
    analysis = AnalysisResponseV1.model_validate(valid)
    assert analysis.schemaVersion == 1
    assert analysis.feedback.simulatedRecruiterComment.startswith(
        "Simulated AI recruiter feedback:"
    )

    invalid = fixture("analysis-invalid-extra-key.json")
    with pytest.raises(ValidationError):
        AnalysisResponseV1.model_validate(invalid)


def test_feedback_contract_rejects_legacy_verdict_field():
    payload = fixture("analysis-valid.json")
    feedback = payload["feedback"]
    assert isinstance(feedback, dict)
    feedback["verdict"] = feedback.pop("simulatedRecruiterComment")

    with pytest.raises(ValidationError):
        AnalysisResponseV1.model_validate(payload)


def test_feedback_contract_rejects_unlabeled_simulated_recruiter_comment():
    payload = fixture("analysis-valid.json")
    feedback = payload["feedback"]
    assert isinstance(feedback, dict)
    feedback["simulatedRecruiterComment"] = "A recruiter may want more detail."

    with pytest.raises(ValidationError):
        AnalysisResponseV1.model_validate(payload)


def test_analysis_contract_rejects_noncanonical_score_label():
    payload = fixture("analysis-valid.json")
    payload["score"] = {**payload["score"], "label": "Needs work"}

    with pytest.raises(ValidationError, match="label must match readinessScore"):
        AnalysisResponseV1.model_validate(payload)


def test_analysis_contract_requires_keywords_but_allows_explicit_null():
    payload = fixture("analysis-valid.json")
    payload["score"] = {
        **payload["score"],
        "readinessScore": 70,
        "label": "Good",
        "components": {**payload["score"]["components"]},
    }
    payload["score"]["components"].pop("keywords")

    with pytest.raises(ValidationError, match="keywords"):
        AnalysisResponseV1.model_validate(payload)

    payload["score"]["components"]["keywords"] = None
    assert AnalysisResponseV1.model_validate(payload).score.components.keywords is None


@pytest.mark.parametrize(
    "components",
    [
        {"structure": 26, "impact": 25, "readability": 20, "keywords": 15},
        {"structure": 25, "impact": 31, "readability": 20, "keywords": 15},
        {"structure": 25, "impact": 25, "readability": 21, "keywords": 15},
        {"structure": 31, "impact": 30, "readability": 25, "keywords": None},
        {"structure": 30, "impact": 41, "readability": 25, "keywords": None},
        {"structure": 30, "impact": 30, "readability": 31, "keywords": None},
    ],
)
def test_analysis_contract_rejects_components_above_branch_maximum(components):
    payload = fixture("analysis-valid.json")
    readiness_score = sum(value for value in components.values() if value is not None)
    payload["score"] = {
        **payload["score"],
        "readinessScore": readiness_score,
        "label": "Strong" if readiness_score >= 85 else "Good",
        "components": components,
    }

    with pytest.raises(ValidationError):
        AnalysisResponseV1.model_validate(payload)


def test_canonical_component_schema_matches_generated_branch_maxima():
    canonical = json.loads(Path("contracts/analysis-v1.schema.json").read_text())
    canonical_components = canonical["$defs"]["components"]
    generated_components = AnalysisResponseV1.model_json_schema()["$defs"]["ScoreComponentsV1"]

    assert canonical_components["allOf"] == generated_components["allOf"]
    branch = canonical_components["allOf"][0]
    assert branch["then"]["properties"] == {
        "structure": {"maximum": 30},
        "impact": {"maximum": 40},
        "readability": {"maximum": 30},
        "keywords": {"type": "null"},
    }
    assert branch["else"]["properties"] == {
        "structure": {"maximum": 25},
        "impact": {"maximum": 30},
        "readability": {"maximum": 20},
        "keywords": {"type": "integer", "minimum": 0, "maximum": 25},
    }


def test_public_error_uses_a_stable_code_and_no_unknown_fields():
    error = PublicErrorV1(
        schemaVersion=1,
        code=ErrorCode.AI_TIMEOUT,
        message="The feedback service timed out. Please try again.",
        requestId="b3a8b258-4e63-4a7c-b9d4-b77a69d4da6a",
        retryable=True,
    )

    assert error.code == "ai_timeout"
    with pytest.raises(ValidationError):
        PublicErrorV1.model_validate(error.model_dump() | {"providerMessage": "secret"})


def test_public_error_validates_a_wire_format_error_code():
    payload = {
        "schemaVersion": 1,
        "code": "ai_timeout",
        "message": "The feedback service timed out. Please try again.",
        "requestId": "b3a8b258-4e63-4a7c-b9d4-b77a69d4da6a",
        "retryable": True,
    }

    assert PublicErrorV1.model_validate(payload).code is ErrorCode.AI_TIMEOUT
