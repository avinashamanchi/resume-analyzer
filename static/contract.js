"use strict";

(function exposeContract(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ResumeAIContract = api;
})(typeof globalThis === "object" ? globalThis : null, function createContract() {
  const ERROR_CODES = new Set([
    "invalid_request", "invalid_installation", "rate_limited", "request_in_progress",
    "unsupported_file", "file_too_large", "pdf_too_many_pages", "pdf_encrypted",
    "pdf_invalid", "pdf_timeout", "scan_required", "resume_too_long",
    "scoring_input_limit", "ai_timeout", "ai_unavailable", "invalid_ai_response",
    "service_misconfigured", "service_unavailable"
  ]);
  const SOURCE_TYPES = new Set(["pdf", "text", "vision_text"]);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const CASEFOLD_EQUIVALENTS = Object.freeze({
    "ß": "ss",
    "ς": "σ",
    "ϐ": "β",
    "ϑ": "θ",
    "ϕ": "φ",
    "ϖ": "π",
    "ϰ": "κ",
    "ϱ": "ρ",
    "ϵ": "ε"
  });

  function invalid() { throw new Error("The service returned an invalid response."); }
  function plainObject(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value) || Object.prototype.toString.call(value) !== "[object Object]") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === null || Function.prototype.toString.call(prototype.constructor) === Function.prototype.toString.call(Object);
  }
  function exactKeys(value, keys) {
    if (!plainObject(value)) invalid();
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalid();
  }
  function codePointLength(value) { return Array.from(value).length; }
  function text(value, minimum, maximum) {
    if (typeof value !== "string" || codePointLength(value) < minimum || codePointLength(value) > maximum) invalid();
    return value;
  }
  function integer(value, minimum, maximum) {
    if (!Number.isInteger(value) || value < minimum || value > maximum) invalid();
    return value;
  }
  function canonicalUuid(value) {
    if (typeof value !== "string" || !UUID.test(value)) invalid();
    return value;
  }
  function list(value, minimum, maximum, item) {
    if (!Array.isArray(value) || value.length < minimum || value.length > maximum) invalid();
    return value.map(item);
  }
  function normalizedTerm(value) {
    let folded = "";
    for (const character of value.normalize("NFKC").trim().toLocaleLowerCase("und")) {
      folded += CASEFOLD_EQUIVALENTS[character] || character;
    }
    return folded.normalize("NFKC");
  }
  function labelFor(score) {
    if (score < 50) return "Needs work";
    if (score < 70) return "Developing";
    if (score < 85) return "Good";
    return "Strong";
  }

  function validateScore(value, hasJobDescription) {
    exactKeys(value, ["scoreVersion", "readinessScore", "label", "components", "explanations"]);
    if (value.scoreVersion !== "resume-readiness-v1") invalid();
    const readinessScore = integer(value.readinessScore, 0, 100);
    if (value.label !== labelFor(readinessScore)) invalid();
    exactKeys(value.components, ["structure", "impact", "readability", "keywords"]);
    const components = {
      structure: integer(value.components.structure, 0, 30),
      impact: integer(value.components.impact, 0, 40),
      readability: integer(value.components.readability, 0, 30),
      keywords: value.components.keywords === null ? null : integer(value.components.keywords, 0, 25)
    };
    if ((components.keywords === null) === hasJobDescription) invalid();
    const total = components.structure + components.impact + components.readability + (components.keywords || 0);
    if (total !== readinessScore) invalid();
    return {
      scoreVersion: value.scoreVersion,
      readinessScore,
      label: value.label,
      components,
      explanations: list(value.explanations, 0, 12, (item) => text(item, 1, 240))
    };
  }

  function validateFeedback(value) {
    exactKeys(value, ["matchedKeywords", "missingKeywords", "strengths", "improvements", "powerBullets", "summary", "simulatedRecruiterComment"]);
    const matchedKeywords = list(value.matchedKeywords, 0, 20, (item) => text(item, 1, 600));
    const missingKeywords = list(value.missingKeywords, 0, 20, (item) => text(item, 1, 600));
    const matched = new Set(matchedKeywords.map(normalizedTerm));
    if (missingKeywords.some((item) => matched.has(normalizedTerm(item)))) invalid();
    const simulatedRecruiterComment = text(value.simulatedRecruiterComment, 1, 800);
    if (!simulatedRecruiterComment.startsWith("Simulated AI recruiter feedback:")) invalid();
    return {
      matchedKeywords,
      missingKeywords,
      strengths: list(value.strengths, 1, 12, (item) => text(item, 1, 600)),
      improvements: list(value.improvements, 1, 12, (item) => text(item, 1, 600)),
      powerBullets: list(value.powerBullets, 0, 10, (item) => text(item, 1, 600)),
      summary: text(value.summary, 1, 500),
      simulatedRecruiterComment
    };
  }

  function validateAnalysisResponse(value, context) {
    exactKeys(context, ["hasJobDescription"]);
    if (typeof context.hasJobDescription !== "boolean") invalid();
    exactKeys(value, ["schemaVersion", "analysisId", "sourceType", "score", "feedback"]);
    if (value.schemaVersion !== 1 || !SOURCE_TYPES.has(value.sourceType)) invalid();
    return {
      schemaVersion: 1,
      analysisId: canonicalUuid(value.analysisId),
      sourceType: value.sourceType,
      score: validateScore(value.score, context.hasJobDescription),
      feedback: validateFeedback(value.feedback)
    };
  }

  function validateInstallationResponse(value) {
    exactKeys(value, ["schemaVersion", "installationToken"]);
    if (value.schemaVersion !== 1) invalid();
    return { schemaVersion: 1, installationToken: text(value.installationToken, 1, 2048) };
  }

  function validatePublicError(value) {
    exactKeys(value, ["schemaVersion", "code", "message", "requestId", "retryable"]);
    if (value.schemaVersion !== 1 || !ERROR_CODES.has(value.code) || typeof value.retryable !== "boolean") invalid();
    return {
      schemaVersion: 1,
      code: value.code,
      message: text(value.message, 1, 240),
      requestId: canonicalUuid(value.requestId),
      retryable: value.retryable
    };
  }

  return { validateAnalysisResponse, validateInstallationResponse, validatePublicError };
});
