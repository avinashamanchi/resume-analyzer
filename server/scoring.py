"""Versioned, deterministic resume-readiness scoring.

This module only derives bounded signals from supplied text.  It does not call
an AI provider and never stores the source text or detected contact values.
"""

from __future__ import annotations

from collections import Counter
from dataclasses import dataclass
import re

from .contracts import ScoreComponentsV1, ScoreV1
from .errors import ErrorCode


SCORE_VERSION = "resume-readiness-v1"
MAX_RESUME_CODE_POINTS = 30_000
MAX_JOB_DESCRIPTION_CODE_POINTS = 20_000
MAX_DERIVED_TOKENS = 10_000

WEIGHTS_WITH_JOB = {
    "structure": 25,
    "impact": 30,
    "readability": 20,
    "keywords": 25,
}
WEIGHTS_WITHOUT_JOB = {
    "structure": 30,
    "impact": 40,
    "readability": 30,
}

# Changing either v1 vocabulary changes its scoring behavior and requires a new
# score version.
ACTION_VERBS_V1 = frozenset(
    {
        "achieved",
        "analyzed",
        "automated",
        "built",
        "coordinated",
        "created",
        "delivered",
        "designed",
        "developed",
        "drove",
        "implemented",
        "improved",
        "increased",
        "launched",
        "led",
        "managed",
        "optimized",
        "reduced",
        "shipped",
        "supported",
    }
)
STOPWORDS_V1 = frozenset(
    {
        "a",
        "an",
        "and",
        "are",
        "as",
        "at",
        "be",
        "by",
        "for",
        "from",
        "in",
        "is",
        "it",
        "job",
        "of",
        "on",
        "or",
        "our",
        "role",
        "that",
        "the",
        "this",
        "to",
        "we",
        "will",
        "with",
        "you",
        "your",
    }
)

_WORD_PATTERN = re.compile(r"[^\W_]+", re.UNICODE)
_BULLET_PATTERN = re.compile(r"^\s*(?:[-*•]\s+|\d+[.)]\s+)(?P<body>.+)$")
_MEASURABLE_SYMBOL_PATTERN = re.compile(
    r"\d+(?:\.\d+)?\s*(?:%|\$|\+|x\b)", re.IGNORECASE
)
_MEASURABLE_UNIT_PATTERN = re.compile(
    r"\b\d+(?:\.\d+)?\s*(?:users?|customers?|requests?|hours?|days?|weeks?|months?|years?|ms|seconds?|k|m|b)\b",
    re.IGNORECASE,
)
_EMAIL_PATTERN = re.compile(
    r"(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+(?![\w.-])", re.UNICODE
)
_PHONE_PATTERN = re.compile(
    r"(?<![\w+])(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?){1,2}\d{3,4}(?!\w)"
)

_SECTION_HEADINGS = {
    "experience": frozenset(
        {"experience", "work experience", "professional experience", "employment"}
    ),
    "education": frozenset({"education", "academic background"}),
    "skills": frozenset({"skills", "technical skills", "core competencies"}),
    "summary": frozenset({"summary", "professional summary", "profile", "objective"}),
}


@dataclass(frozen=True, slots=True)
class ScoreSignals:
    """Bounded inputs to the score formula; no source or contact values."""

    contact_present: bool
    experience_present: bool
    education_present: bool
    skills_present: bool
    summary_present: bool
    action_bullet_count: int
    measurable_bullet_count: int
    word_count: int
    bullet_count: int
    resume_keywords: frozenset[str]
    job_keywords: tuple[str, ...]


class ScoringInputError(ValueError):
    """Content-free rejection for scoring inputs that exceed a hard limit."""

    code = ErrorCode.SCORING_INPUT_LIMIT

    def __init__(self) -> None:
        super().__init__("Scoring input exceeds a supported limit.")


def _validate_code_point_limit(text: str, maximum: int) -> None:
    if len(text) > maximum:
        raise ScoringInputError()


def tokenize_keywords(text: str) -> tuple[str, ...]:
    """Return bounded, case-folded v1 keyword tokens in source order."""
    _validate_code_point_limit(text, MAX_RESUME_CODE_POINTS)
    tokens: list[str] = []
    for match in _WORD_PATTERN.finditer(text.casefold()):
        raw_token = match.group()
        if not 2 <= len(raw_token) <= 40 or raw_token in STOPWORDS_V1:
            continue
        if len(tokens) >= MAX_DERIVED_TOKENS:
            raise ScoringInputError()
        tokens.append(raw_token)
    return tuple(tokens)


def _selected_job_keywords(job_description: str) -> tuple[str, ...]:
    frequency = Counter(tokenize_keywords(job_description))
    ranked = sorted(frequency.items(), key=lambda item: (-item[1], item[0]))
    return tuple(term for term, _ in ranked[:20])


def _contains_contact(text: str) -> bool:
    return _EMAIL_PATTERN.search(text) is not None or _PHONE_PATTERN.search(text) is not None


def _without_contacts(text: str) -> str:
    return _PHONE_PATTERN.sub(" ", _EMAIL_PATTERN.sub(" ", text))


def _is_action_bullet(body: str) -> bool:
    words = _WORD_PATTERN.findall(body.casefold())
    return bool(words) and words[0] in ACTION_VERBS_V1


def _is_measurable_bullet(body: str) -> bool:
    return bool(
        _MEASURABLE_SYMBOL_PATTERN.search(body)
        or _MEASURABLE_UNIT_PATTERN.search(body)
    )


def collect_signals(resume_text: str, job_description: str | None = None) -> ScoreSignals:
    """Derive only score inputs; contact matches are immediately discarded."""
    _validate_code_point_limit(resume_text, MAX_RESUME_CODE_POINTS)
    if job_description is not None:
        _validate_code_point_limit(job_description, MAX_JOB_DESCRIPTION_CODE_POINTS)
    contact_present = _contains_contact(resume_text)
    non_contact_text = _without_contacts(resume_text)
    headings = {line.strip().casefold() for line in non_contact_text.splitlines()}

    bullet_count = 0
    action_bullet_count = 0
    measurable_bullet_count = 0
    for line in non_contact_text.splitlines():
        match = _BULLET_PATTERN.match(line)
        if match is None:
            continue
        bullet_count += 1
        body = match.group("body")
        action_bullet_count += _is_action_bullet(body)
        measurable_bullet_count += _is_measurable_bullet(body)

    return ScoreSignals(
        contact_present=contact_present,
        experience_present=bool(headings & _SECTION_HEADINGS["experience"]),
        education_present=bool(headings & _SECTION_HEADINGS["education"]),
        skills_present=bool(headings & _SECTION_HEADINGS["skills"]),
        summary_present=bool(headings & _SECTION_HEADINGS["summary"]),
        action_bullet_count=action_bullet_count,
        measurable_bullet_count=measurable_bullet_count,
        word_count=len(_WORD_PATTERN.findall(non_contact_text)),
        bullet_count=bullet_count,
        resume_keywords=frozenset(tokenize_keywords(non_contact_text)),
        job_keywords=()
        if job_description is None
        else _selected_job_keywords(job_description),
    )


def _clamp_ratio(value: float) -> float:
    return max(0.0, min(value, 1.0))


def _readability_ratio(word_count: int, bullet_count: int) -> float:
    length_ratio = (
        word_count / 300
        if word_count < 300
        else 1.0
        if word_count <= 1_000
        else (1_500 - word_count) / 500
    )
    bullet_ratio = (
        bullet_count / 3
        if bullet_count < 3
        else 1.0
        if bullet_count <= 30
        else (40 - bullet_count) / 10
    )
    return 0.6 * _clamp_ratio(length_ratio) + 0.4 * _clamp_ratio(bullet_ratio)


def component_scores(signals: ScoreSignals, has_job: bool) -> ScoreComponentsV1:
    """Apply the immutable v1 formula to bounded signals only."""
    weights = WEIGHTS_WITH_JOB if has_job else WEIGHTS_WITHOUT_JOB
    present_count = sum(
        (
            signals.contact_present,
            signals.experience_present,
            signals.education_present,
            signals.skills_present,
            signals.summary_present,
        )
    )
    structure = round(weights["structure"] * present_count / 5)
    impact_ratio = 0.5 * min(signals.action_bullet_count, 5) / 5 + 0.5 * min(
        signals.measurable_bullet_count, 3
    ) / 3
    impact = round(weights["impact"] * impact_ratio)
    readability = round(
        weights["readability"]
        * _readability_ratio(signals.word_count, signals.bullet_count)
    )

    keywords: int | None = None
    if has_job:
        selected_terms = signals.job_keywords
        matched_terms = len(set(selected_terms) & signals.resume_keywords)
        keywords = 0 if not selected_terms else round(
            WEIGHTS_WITH_JOB["keywords"] * matched_terms / len(selected_terms)
        )

    return ScoreComponentsV1(
        structure=structure,
        impact=impact,
        readability=readability,
        keywords=keywords,
    )


def label_for_score(score: int) -> str:
    if score < 50:
        return "Needs work"
    if score < 70:
        return "Developing"
    if score < 85:
        return "Good"
    return "Strong"


def _explanations(components: ScoreComponentsV1, has_job: bool) -> list[str]:
    explanations = [
        f"Structure checks scored {components.structure} points.",
        f"Impact evidence scored {components.impact} points.",
        f"Readability checks scored {components.readability} points.",
    ]
    if has_job:
        explanations.append(f"Job-keyword alignment scored {components.keywords} points.")
    return explanations


def score_resume(resume_text: str, job_description: str | None) -> ScoreV1:
    """Produce a deterministic v1 score without passing through an AI model."""
    has_job = job_description is not None
    signals = collect_signals(resume_text, job_description)
    components = component_scores(signals, has_job=has_job)
    readiness_score = sum(
        value for value in components.model_dump().values() if value is not None
    )
    return ScoreV1(
        scoreVersion=SCORE_VERSION,
        readinessScore=readiness_score,
        label=label_for_score(readiness_score),
        components=components,
        explanations=_explanations(components, has_job),
    )
