from __future__ import annotations

import json
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, FormatChecker
from pydantic import ValidationError

from server.contracts import AnalysisResponseV1, AnalysisResponseV2, PublicErrorV1
from server.errors import ErrorCode


def fixture(name: str) -> dict[str, object]:
    return json.loads(Path("contracts/fixtures", name).read_text())


ANALYSIS_V2_JSON_SCHEMA = json.loads(
    Path("contracts/analysis-v2.schema.json").read_text()
)
ANALYSIS_V2_JSON_VALIDATOR = Draft202012Validator(
    ANALYSIS_V2_JSON_SCHEMA,
    format_checker=FormatChecker(),
)


def _json_schema_accepts(payload: object) -> bool:
    return ANALYSIS_V2_JSON_VALIDATOR.is_valid(payload)


def test_v2_schema_is_valid_draft_2020_12():
    Draft202012Validator.check_schema(ANALYSIS_V2_JSON_SCHEMA)


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


V2_NON_COMPLETE_STATUSES = (
    "not_requested",
    "quota_exhausted",
    "plan_verification_unavailable",
    "temporarily_unavailable",
    "timeout",
    "invalid_provider_response",
)


def test_v2_complete_and_deterministic_fixtures_are_valid_and_share_the_score():
    complete = fixture("analysis-v2-complete.json")
    deterministic = fixture("analysis-v2-deterministic-only.json")

    parsed_complete = AnalysisResponseV2.model_validate(complete)
    parsed_deterministic = AnalysisResponseV2.model_validate(deterministic)

    assert parsed_complete.score.readinessScore == 78
    assert parsed_complete.ai.status == "complete"
    assert parsed_complete.ai.feedback is not None
    assert parsed_complete.ai.allowance is not None
    assert parsed_complete.ai.allowance.resetsAt.isoformat() == "2026-09-01T00:00:00+00:00"
    assert parsed_deterministic.score == parsed_complete.score
    assert parsed_deterministic.ai.status == "temporarily_unavailable"
    assert parsed_deterministic.ai.feedback is None
    assert _json_schema_accepts(complete)
    assert _json_schema_accepts(deterministic)


@pytest.mark.parametrize("status", V2_NON_COMPLETE_STATUSES)
@pytest.mark.parametrize("allowance_is_null", [False, True])
def test_v2_accepts_every_non_complete_status_without_feedback(
    status: str, allowance_is_null: bool
):
    payload = fixture("analysis-v2-deterministic-only.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    ai["status"] = status
    if allowance_is_null:
        ai["allowance"] = None

    parsed = AnalysisResponseV2.model_validate(payload)

    assert parsed.ai.status == status
    assert parsed.ai.feedback is None
    assert _json_schema_accepts(payload)


@pytest.mark.parametrize("null_field", ["feedback", "allowance"])
def test_v2_complete_requires_both_feedback_and_allowance(null_field: str):
    payload = fixture("analysis-v2-complete.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    ai[null_field] = None

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


@pytest.mark.parametrize("status", V2_NON_COMPLETE_STATUSES)
def test_v2_rejects_feedback_for_every_non_complete_status(status: str):
    payload = fixture("analysis-v2-complete.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    ai["status"] = status

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


def test_v2_rejects_unknown_and_missing_ai_status():
    unknown = fixture("analysis-v2-deterministic-only.json")
    unknown_ai = unknown["ai"]
    assert isinstance(unknown_ai, dict)
    unknown_ai["status"] = "degraded"

    missing = fixture("analysis-v2-deterministic-only.json")
    missing_ai = missing["ai"]
    assert isinstance(missing_ai, dict)
    missing_ai.pop("status")

    for payload in (unknown, missing):
        with pytest.raises(ValidationError):
            AnalysisResponseV2.model_validate(payload)
        assert not _json_schema_accepts(payload)


@pytest.mark.parametrize(
    "analysis_id",
    [
        "8EC8A3BC-7A15-4B75-9F94-A5353A2A2F9B",
        "8ec8a3bc7a154b759f94a5353a2a2f9b",
        "{8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b}",
        "urn:uuid:8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b",
    ],
)
def test_v2_rejects_noncanonical_uuid_spellings(analysis_id: str):
    payload = fixture("analysis-v2-complete.json")
    payload["analysisId"] = analysis_id

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


def test_v2_accepts_only_its_two_source_types():
    payload = fixture("analysis-v2-complete.json")
    payload["sourceType"] = "pdf"
    assert AnalysisResponseV2.model_validate(payload).sourceType == "pdf"
    assert _json_schema_accepts(payload)

    payload["sourceType"] = "vision_text"
    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


@pytest.mark.parametrize(
    ("used", "limit"),
    [
        (-1, 3),
        (101, 100),
        (4, 3),
        (True, 3),
        (1, 4),
    ],
)
def test_v2_rejects_invalid_allowances(used: object, limit: object):
    payload = fixture("analysis-v2-complete.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    allowance = ai["allowance"]
    assert isinstance(allowance, dict)
    allowance["used"] = used
    allowance["limit"] = limit

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


def test_v2_python_runtime_rejects_a_float_allowance_counter():
    payload = fixture("analysis-v2-complete.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    allowance = ai["allowance"]
    assert isinstance(allowance, dict)
    allowance["used"] = 1.0

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)


def test_v2_accepts_the_pro_allowance_boundary():
    payload = fixture("analysis-v2-complete.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    allowance = ai["allowance"]
    assert isinstance(allowance, dict)
    allowance["used"] = 100
    allowance["limit"] = 100

    parsed = AnalysisResponseV2.model_validate(payload)

    assert parsed.ai.allowance is not None
    assert parsed.ai.allowance.used == 100
    assert _json_schema_accepts(payload)


@pytest.mark.parametrize(
    "resets_at",
    [
        "2026-09-01T00:00:00+00:00",
        "2026-09-01T00:00:00.000Z",
        "2026-09-01T00:00:00",
        "2026-09-01T00:00:00z",
        "2026-09-01",
        "2026-9-1T00:00:00Z",
        "2026-13-01T00:00:00Z",
        "2026-09-01T24:00:00Z",
        "2026-13-01T24:99:99Z",
    ],
)
def test_v2_rejects_noncanonical_allowance_timestamps(resets_at: str):
    payload = fixture("analysis-v2-complete.json")
    ai = payload["ai"]
    assert isinstance(ai, dict)
    allowance = ai["allowance"]
    assert isinstance(allowance, dict)
    allowance["resetsAt"] = resets_at

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


@pytest.mark.parametrize(
    "path",
    [
        (),
        ("score",),
        ("score", "components"),
        ("ai",),
        ("ai", "feedback"),
        ("ai", "allowance"),
    ],
)
def test_v2_rejects_unknown_fields_at_every_object_level(path: tuple[str, ...]):
    payload = fixture("analysis-v2-complete.json")
    target: object = payload
    for part in path:
        assert isinstance(target, dict)
        target = target[part]
    assert isinstance(target, dict)
    target["unexpected"] = "private input"

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


@pytest.mark.parametrize(
    ("path", "field"),
    [
        ((), "schemaVersion"),
        ((), "analysisId"),
        ((), "sourceType"),
        ((), "score"),
        ((), "ai"),
        (("score",), "components"),
        (("score", "components"), "keywords"),
        (("ai",), "feedback"),
        (("ai",), "allowance"),
        (("ai", "feedback"), "summary"),
        (("ai", "allowance"), "resetsAt"),
    ],
)
def test_v2_rejects_missing_required_fields(path: tuple[str, ...], field: str):
    payload = fixture("analysis-v2-complete.json")
    target: object = payload
    for part in path:
        assert isinstance(target, dict)
        target = target[part]
    assert isinstance(target, dict)
    target.pop(field)

    with pytest.raises(ValidationError):
        AnalysisResponseV2.model_validate(payload)
    assert not _json_schema_accepts(payload)


def test_v1_uuid_parsing_remains_backward_compatible():
    payload = fixture("analysis-valid.json")
    payload["analysisId"] = str(payload["analysisId"]).upper()

    parsed = AnalysisResponseV1.model_validate(payload)

    assert str(parsed.analysisId) == "8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b"
