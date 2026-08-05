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
  assert.deepEqual(contract.validateAnalysisResponse(fixture), fixture);
});

test("rejects an analysis response with extra or missing keys", () => {
  const extra = copy(fixture);
  extra.unexpected = true;
  assert.throws(() => contract.validateAnalysisResponse(extra));
  const missing = copy(fixture);
  delete missing.feedback.summary;
  assert.throws(() => contract.validateAnalysisResponse(missing));
});

test("rejects inconsistent score labels and component totals", () => {
  const label = copy(fixture);
  label.score.label = "Good";
  assert.throws(() => contract.validateAnalysisResponse(label));
  const total = copy(fixture);
  total.score.components.impact = 24;
  assert.throws(() => contract.validateAnalysisResponse(total));
});

test("rejects malformed feedback prefix, overlap, and bounds", () => {
  const prefix = copy(fixture);
  prefix.feedback.simulatedRecruiterComment = "Recruiter feedback";
  assert.throws(() => contract.validateAnalysisResponse(prefix));
  const overlap = copy(fixture);
  overlap.feedback.missingKeywords = [" python "];
  assert.throws(() => contract.validateAnalysisResponse(overlap));
  const bounds = copy(fixture);
  bounds.feedback.summary = "x".repeat(501);
  assert.throws(() => contract.validateAnalysisResponse(bounds));
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
