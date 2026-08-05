"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const contract = require(path.resolve(__dirname, "../static/contract.js"));
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../contracts/fixtures/analysis-valid.json"), "utf8"));

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

test("accepts the canonical valid analysis fixture without changing it", () => {
  assert.deepEqual(contract.validateAnalysisResponse(fixture, { hasJobDescription: true }), fixture);
});

test("rejects an analysis response with extra or missing keys", () => {
  const extra = copy(fixture);
  extra.unexpected = true;
  assert.throws(() => contract.validateAnalysisResponse(extra, { hasJobDescription: true }));
  const missing = copy(fixture);
  delete missing.feedback.summary;
  assert.throws(() => contract.validateAnalysisResponse(missing, { hasJobDescription: true }));
});

test("rejects inconsistent score labels and component totals", () => {
  const label = copy(fixture);
  label.score.label = "Good";
  assert.throws(() => contract.validateAnalysisResponse(label, { hasJobDescription: true }));
  const total = copy(fixture);
  total.score.components.impact = 24;
  assert.throws(() => contract.validateAnalysisResponse(total, { hasJobDescription: true }));
});

test("rejects malformed feedback prefix, overlap, and bounds", () => {
  const prefix = copy(fixture);
  prefix.feedback.simulatedRecruiterComment = "Recruiter feedback";
  assert.throws(() => contract.validateAnalysisResponse(prefix, { hasJobDescription: true }));
  const overlap = copy(fixture);
  overlap.feedback.missingKeywords = [" python "];
  assert.throws(() => contract.validateAnalysisResponse(overlap, { hasJobDescription: true }));
  const bounds = copy(fixture);
  bounds.feedback.summary = "x".repeat(501);
  assert.throws(() => contract.validateAnalysisResponse(bounds, { hasJobDescription: true }));
});

test("requires immutable job-description context to match nullable keyword scoring", () => {
  assert.throws(() => contract.validateAnalysisResponse(fixture));
  assert.throws(() => contract.validateAnalysisResponse(fixture, { hasJobDescription: false }));

  const noJob = copy(fixture);
  noJob.score.components = { structure: 30, impact: 30, readability: 25, keywords: null };
  assert.deepEqual(contract.validateAnalysisResponse(noJob, { hasJobDescription: false }), noJob);
  assert.throws(() => contract.validateAnalysisResponse(noJob, { hasJobDescription: true }));
});

test("uses audited Unicode casefold equivalence when rejecting keyword overlap", () => {
  const sharpS = copy(fixture);
  sharpS.feedback.matchedKeywords = ["Straße"];
  sharpS.feedback.missingKeywords = ["STRASSE"];
  assert.throws(() => contract.validateAnalysisResponse(sharpS, { hasJobDescription: true }));

  const finalSigma = copy(fixture);
  finalSigma.feedback.matchedKeywords = ["ΟΣ"];
  finalSigma.feedback.missingKeywords = ["οσ"];
  assert.throws(() => contract.validateAnalysisResponse(finalSigma, { hasJobDescription: true }));
});

test("validates installation and public error contracts fail closed", () => {
  assert.deepEqual(
    contract.validateInstallationResponse({ schemaVersion: 1, installationToken: "token" }),
    { schemaVersion: 1, installationToken: "token" }
  );
  assert.throws(() => contract.validateInstallationResponse({ schemaVersion: 1, installationToken: "token", extra: true }));
  assert.deepEqual(
    contract.validatePublicError({ schemaVersion: 1, code: "invalid_request", message: "Check the request.", requestId: fixture.analysisId, retryable: false }),
    { schemaVersion: 1, code: "invalid_request", message: "Check the request.", requestId: fixture.analysisId, retryable: false }
  );
  assert.throws(() => contract.validatePublicError({ schemaVersion: 2, code: "invalid_request", message: "Check the request.", requestId: fixture.analysisId, retryable: false }));
});
