"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const contract = require(path.resolve(__dirname, "../static/contract.js"));
const lifecycle = require(path.resolve(__dirname, "../static/lifecycle.js"));
const appSource = fs.readFileSync(path.resolve(__dirname, "../static/app.js"), "utf8");
const fixture = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../contracts/fixtures/analysis-valid.json"), "utf8"));

function copy(value) { return JSON.parse(JSON.stringify(value)); }
function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}
async function ticks() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

class Element {
  constructor(value = "") {
    this.value = value;
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.textContent = "";
    this.files = [];
    this.children = [];
    this.listeners = new Map();
    this.focused = 0;
  }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type) {
    const listener = this.listeners.get(type);
    if (listener) return listener({ preventDefault() {} });
    return undefined;
  }
  replaceChildren() { this.children = []; }
  append(child) { this.children.push(child); }
  focus() { this.focused += 1; }
}

class TestFormData {
  constructor() { this.values = []; }
  append(name, value) { this.values.push([name, value]); }
}

function response(status, body) { return { status, json: () => body }; }

function boot({ sessionToken = null, invalidateOnStorageWrite = false } = {}) {
  const elements = new Map();
  const add = (selector, element = new Element()) => { elements.set(selector, element); return element; };
  const form = add("#analysis-form", new Element());
  const pdfRadio = new Element("pdf");
  const textRadio = new Element("text");
  const pdfInput = add("#resume-pdf");
  const textInput = add("#resume-text");
  const jobDescription = add("#job-description");
  const consent = add("#groq-consent");
  const ids = ["#pdf-panel", "#text-panel", "#file-name", "#analyze-button", "#cancel-button", "#form-error", "#request-status", "#report", "#readiness-score", "#readiness-label", "#readiness-summary", "#matched-keywords", "#missing-keywords", "#strengths", "#improvements", "#power-bullets", "#recruiter-comment"];
  for (const id of ids) add(id);
  form.elements = [pdfRadio, textRadio, pdfInput, textInput, jobDescription, consent, elements.get("#analyze-button"), elements.get("#cancel-button")];
  const windowListeners = new Map();
  const storage = new Map(sessionToken ? [["resume-ai.installation-token.v1", sessionToken]] : []);
  const fetchCalls = [];
  const fetchSteps = [];
  const fetch = (url, options) => {
    fetchCalls.push({ url, options });
    const step = fetchSteps.shift();
    if (!step) throw new Error("Unexpected fetch");
    return step;
  };
  const validatorCalls = { installation: 0, analysis: 0, error: 0 };
  const contractSpy = {
    validateAnalysisResponse(...arguments_) { validatorCalls.analysis += 1; return contract.validateAnalysisResponse(...arguments_); },
    validateInstallationResponse(...arguments_) { validatorCalls.installation += 1; return contract.validateInstallationResponse(...arguments_); },
    validatePublicError(...arguments_) { validatorCalls.error += 1; return contract.validatePublicError(...arguments_); }
  };
  const context = {
    AbortController,
    FormData: TestFormData,
    ResumeAIContract: contractSpy,
    ResumeAILifecycle: lifecycle,
    crypto: { randomUUID: () => "8ec8a3bc-7a15-4b75-9f94-a5353a2a2f9b" },
    document: {
      querySelector: (selector) => elements.get(selector),
      querySelectorAll: (selector) => selector === "input[name='source']" ? [pdfRadio, textRadio] : [],
      createElement: () => new Element()
    },
    fetch,
    queueMicrotask: (callback) => callback(),
    sessionStorage: {
      getItem: (key) => storage.get(key) || null,
      setItem: (key, value) => {
        storage.set(key, value);
        if (invalidateOnStorageWrite) textInput.dispatch("input");
      },
      removeItem: (key) => storage.delete(key)
    },
    window: { addEventListener: (type, listener) => windowListeners.set(type, listener) }
  };
  context.globalThis = context;
  vm.runInNewContext(appSource, context, { filename: "static/app.js" });
  textRadio.checked = true;
  textRadio.dispatch("change");
  textInput.value = "Resume text";
  consent.checked = true;
  return {
    form, textInput, jobDescription, error: elements.get("#form-error"), report: elements.get("#report"), status: elements.get("#request-status"), analyze: elements.get("#analyze-button"), cancel: elements.get("#cancel-button"),
    enqueue: (step) => fetchSteps.push(step), fetchCalls, storage, validatorCalls,
    pagehide: () => windowListeners.get("pagehide")(),
    reset: () => form.dispatch("reset")
  };
}

test("actual app wiring prevents a stale installation JSON body from storing a token or starting analysis", async () => {
  const app = boot();
  const installFetch = deferred();
  const installJson = deferred();
  app.enqueue(installFetch.promise);
  app.form.dispatch("submit");
  await ticks();
  installFetch.resolve(response(201, installJson.promise));
  await ticks();
  assert.equal(app.textInput.disabled, true);
  app.textInput.value = "Edited while disabled";
  app.textInput.dispatch("input");
  installJson.resolve({ schemaVersion: 1, installationToken: "stale-token" });
  await ticks();

  assert.equal(app.storage.has("resume-ai.installation-token.v1"), false);
  assert.equal(app.fetchCalls.length, 1);
  assert.equal(app.report.hidden, true);
  assert.equal(app.error.hidden, true);
});

test("actual app guard after installation fetch skips response JSON when ownership is invalidated", async () => {
  const app = boot();
  const installationFetch = deferred();
  let jsonCalls = 0;
  app.enqueue(installationFetch.promise);
  app.form.dispatch("submit");
  await ticks();
  installationFetch.resolve({ status: 201, json: () => { jsonCalls += 1; return Promise.resolve({ schemaVersion: 1, installationToken: "token" }); } });
  app.textInput.dispatch("input");
  await ticks();

  assert.equal(jsonCalls, 0);
  assert.equal(app.validatorCalls.installation, 0);
  assert.equal(app.storage.has("resume-ai.installation-token.v1"), false);
  assert.equal(app.fetchCalls.length, 1);
});

test("actual app guard after installation JSON skips validation, storage, and analysis when ownership is invalidated", async () => {
  const app = boot();
  const installationJson = deferred();
  let jsonCalls = 0;
  app.enqueue(Promise.resolve({ status: 201, json: () => { jsonCalls += 1; return installationJson.promise; } }));
  app.form.dispatch("submit");
  await ticks();
  assert.equal(jsonCalls, 1);
  app.textInput.dispatch("input");
  installationJson.resolve({ schemaVersion: 1, installationToken: "token" });
  await ticks();

  assert.equal(app.validatorCalls.installation, 0);
  assert.equal(app.storage.has("resume-ai.installation-token.v1"), false);
  assert.equal(app.fetchCalls.length, 1);
});

test("actual app guard after installationToken await skips analysis after a storage-triggered invalidation", async () => {
  const app = boot({ invalidateOnStorageWrite: true });
  app.enqueue(Promise.resolve(response(201, Promise.resolve({ schemaVersion: 1, installationToken: "token" }))));
  app.form.dispatch("submit");
  await ticks();

  assert.equal(app.validatorCalls.installation, 1);
  assert.equal(app.storage.get("resume-ai.installation-token.v1"), "token");
  assert.equal(app.fetchCalls.length, 1);
});

test("actual app guard after analysis fetch skips response JSON when ownership is invalidated", async () => {
  const app = boot({ sessionToken: "session-token" });
  const analysisFetch = deferred();
  let jsonCalls = 0;
  app.enqueue(analysisFetch.promise);
  app.form.dispatch("submit");
  await ticks();
  analysisFetch.resolve({ status: 200, json: () => { jsonCalls += 1; return Promise.resolve(copy(fixture)); } });
  app.textInput.dispatch("input");
  await ticks();

  assert.equal(jsonCalls, 0);
  assert.equal(app.validatorCalls.analysis, 0);
  assert.equal(app.report.hidden, true);
  assert.equal(app.error.hidden, true);
});

test("actual app guard after analysis JSON skips validation, rendering, and stale errors when ownership is invalidated", async () => {
  const app = boot({ sessionToken: "session-token" });
  const analysisJson = deferred();
  let jsonCalls = 0;
  app.enqueue(Promise.resolve({ status: 500, json: () => { jsonCalls += 1; return analysisJson.promise; } }));
  app.form.dispatch("submit");
  await ticks();
  assert.equal(jsonCalls, 1);
  app.textInput.dispatch("input");
  analysisJson.resolve({ schemaVersion: 1, code: "ai_unavailable", message: "Unavailable", requestId: fixture.analysisId, retryable: true });
  await ticks();

  assert.equal(app.validatorCalls.analysis, 0);
  assert.equal(app.validatorCalls.error, 0);
  assert.equal(app.report.hidden, true);
  assert.equal(app.error.hidden, true);
});

test("actual app wiring snapshots job-description context before an await", async () => {
  const app = boot({ sessionToken: "session-token" });
  app.jobDescription.value = "Original role context";
  app.enqueue(Promise.resolve(response(200, Promise.resolve(copy(fixture)))));
  app.form.dispatch("submit");
  app.jobDescription.value = "";
  await ticks();

  const fields = app.fetchCalls[0].options.body.values;
  assert.deepEqual(fields.find(([name]) => name === "job_description"), ["job_description", "Original role context"]);
  assert.equal(app.report.hidden, false);
});

test("actual app wiring cannot let stale analysis JSON render, show an error, or clear newer busy state", async () => {
  const app = boot({ sessionToken: "session-token" });
  app.jobDescription.value = "Role context";
  const oldJson = deferred();
  app.enqueue(Promise.resolve(response(500, oldJson.promise)));
  app.form.dispatch("submit");
  await ticks();
  app.textInput.value = "Newer resume";
  app.textInput.dispatch("input");

  const newerFetch = deferred();
  app.enqueue(newerFetch.promise);
  app.form.dispatch("submit");
  await ticks();
  assert.equal(app.status.hidden, false);
  oldJson.resolve({ schemaVersion: 1, code: "ai_unavailable", message: "Unavailable", requestId: fixture.analysisId, retryable: true });
  await ticks();

  assert.equal(app.status.hidden, false);
  assert.equal(app.report.hidden, true);
  assert.equal(app.error.hidden, true);
  newerFetch.resolve(response(200, Promise.resolve(copy(fixture))));
  await ticks();
  assert.equal(app.status.hidden, true);
  assert.equal(app.report.hidden, false);
});

for (const [name, invalidate] of [
  ["reset", (app) => app.reset()],
  ["cancel", (app) => app.cancel.dispatch("click")],
  ["pagehide", (app) => app.pagehide()]
]) {
  test(`actual app wiring blocks deferred analysis rendering after ${name}`, async () => {
    const app = boot({ sessionToken: "session-token" });
    const body = deferred();
    app.enqueue(Promise.resolve(response(200, body.promise)));
    app.form.dispatch("submit");
    await ticks();
    invalidate(app);
    body.resolve(copy(fixture));
    await ticks();

    assert.equal(app.report.hidden, true);
    if (name === "cancel") assert.match(app.error.textContent, /Analysis canceled/);
    else assert.equal(app.error.hidden, true);
  });
}
