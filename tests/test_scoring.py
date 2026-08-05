from __future__ import annotations

from pathlib import Path

import pytest

from server.scoring import (
    ScoreSignals,
    collect_signals,
    component_scores,
    label_for_score,
    score_resume,
    tokenize_keywords,
)


def fixture(name: str) -> str:
    return Path("tests/fixtures", name).read_text()


def test_perfect_signals_have_exact_component_maximums():
    signals = ScoreSignals(
        contact_present=True,
        experience_present=True,
        education_present=True,
        skills_present=True,
        summary_present=True,
        action_bullet_count=5,
        measurable_bullet_count=3,
        word_count=500,
        bullet_count=5,
        resume_keywords=frozenset({"flask", "python"}),
        job_keywords=("flask", "python"),
    )
    assert component_scores(signals, has_job=True).model_dump() == {
        "structure": 25,
        "impact": 30,
        "readability": 20,
        "keywords": 25,
    }


def test_sparse_signals_have_exact_reweighted_components_without_job():
    signals = ScoreSignals(
        contact_present=True,
        experience_present=True,
        education_present=False,
        skills_present=False,
        summary_present=False,
        action_bullet_count=0,
        measurable_bullet_count=0,
        word_count=150,
        bullet_count=1,
        resume_keywords=frozenset(),
        job_keywords=(),
    )
    assert component_scores(signals, has_job=False).model_dump() == {
        "structure": 12,
        "impact": 0,
        "readability": 13,
        "keywords": None,
    }


def test_score_resume_is_deterministic_and_model_independent():
    resume = fixture("resumes/strong.txt")
    job = fixture("job_descriptions/backend-engineer.txt")
    first = score_resume(resume, job)
    second = score_resume(resume, job)
    assert first == second
    assert first.scoreVersion == "resume-readiness-v1"
    values = first.components.model_dump().values()
    assert first.readinessScore == sum(value for value in values if value is not None)
    assert first.readinessScore == 100


@pytest.mark.parametrize(
    ("value", "label"),
    [(49, "Needs work"), (50, "Developing"), (70, "Good"), (85, "Strong")],
)
def test_label_boundaries(value: int, label: str):
    assert label_for_score(value) == label


def test_contact_detection_returns_boolean_not_value():
    signals = collect_signals("Avi Example avi@example.com 555-111-2222")
    assert signals.contact_present is True
    assert "avi@example.com" not in repr(signals)
    assert "555-111-2222" not in repr(signals)


def test_keywords_casefold_unicode_and_exclude_out_of_bounds_tokens():
    assert tokenize_keywords("PYTHON Straße a z x " + "q" * 41) == ("python", "strasse")


def test_job_keywords_rank_by_frequency_then_lexical_order_and_limit_to_twenty():
    job = "zebra zebra alpha " + " ".join(f"term{index:02d}" for index in range(25))
    signals = collect_signals("Zebra Alpha", job)
    assert signals.job_keywords == (
        "zebra",
        "alpha",
        "term00",
        "term01",
        "term02",
        "term03",
        "term04",
        "term05",
        "term06",
        "term07",
        "term08",
        "term09",
        "term10",
        "term11",
        "term12",
        "term13",
        "term14",
        "term15",
        "term16",
        "term17",
    )


def test_supplied_job_with_no_selectable_terms_has_zero_keyword_component():
    result = score_resume("Experience\n- Built APIs", "a an the")
    assert result.components.keywords == 0


def test_section_headings_match_only_exact_trimmed_casefolded_lines():
    signals = collect_signals("Experience and Education\n technical skills \nProfile")
    assert signals.experience_present is False
    assert signals.education_present is False
    assert signals.skills_present is True
    assert signals.summary_present is True


def test_bullet_metrics_recognize_allowed_markers_verbs_and_number_units():
    signals = collect_signals(
        "\n".join(
            (
                "- Built 20 requests",
                "* improved reliability by 10%",
                "• Coordinated 5 customers",
                "1. Designed a 2x faster service",
                "2) Created 3 weeks of documentation",
                "Not a bullet: built 100 requests",
            )
        )
    )
    assert signals.bullet_count == 5
    assert signals.action_bullet_count == 5
    assert signals.measurable_bullet_count == 5


def test_readability_penalizes_overlong_resumes_and_excessive_bullets():
    signals = ScoreSignals(
        contact_present=False,
        experience_present=False,
        education_present=False,
        skills_present=False,
        summary_present=False,
        action_bullet_count=0,
        measurable_bullet_count=0,
        word_count=1_500,
        bullet_count=40,
        resume_keywords=frozenset(),
        job_keywords=(),
    )
    assert component_scores(signals, has_job=False).readability == 0
