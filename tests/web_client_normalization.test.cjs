"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const normalizer = require(path.resolve(__dirname, "../static/unicode_normalization.js"));
const corpus = JSON.parse(fs.readFileSync(path.resolve(__dirname, "fixtures/unicode/nfkc-python-15.json"), "utf8"));
const normalizerSource = fs.readFileSync(path.resolve(__dirname, "../static/unicode_normalization.js"), "utf8");
const contractSource = fs.readFileSync(path.resolve(__dirname, "../static/contract.js"), "utf8");
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../contracts/fixtures/analysis-valid.json"), "utf8"));

test("generated normalizer matches the Python Unicode-15 deterministic multi-scalar corpus", () => {
  assert.equal(normalizer.unicodeVersion, "15.0.0");
  assert.ok(normalizer.mappingCount > 1000);
  assert.ok(normalizer.assignedRangeCount > 100);
  for (const entry of corpus) assert.equal(normalizer.normalizeNfkc(entry.input), entry.nfkc);
});

test("Unicode-15-unassigned scalars are version barriers rather than host-normalized", () => {
  assert.equal(normalizer.isUnicode15Assigned("꟱"), false);
  assert.equal(normalizer.normalizeNfkc("꟱"), "꟱");
  assert.equal(normalizer.normalizeNfkc("A꟱\u0301"), "A꟱\u0301");
});

test("generated normalizer exposes the same browser global as its CommonJS module", () => {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(normalizerSource, sandbox, { filename: "static/unicode_normalization.js" });

  assert.equal(sandbox.globalThis.ResumeAIUnicodeNormalization.unicodeVersion, normalizer.unicodeVersion);
  assert.equal(sandbox.globalThis.ResumeAIUnicodeNormalization.normalizeNfkc("ﬃ"), "ffi");
});

test("browser contract fails closed when its generated Unicode artifacts are unavailable", () => {
  const sandbox = { globalThis: {} };
  vm.runInNewContext(contractSource, sandbox, { filename: "static/contract.js" });

  assert.throws(() => sandbox.globalThis.ResumeAIContract.validateAnalysisResponse(fixture, { hasJobDescription: true }));
});
