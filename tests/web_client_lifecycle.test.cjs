"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { RequestLifecycle } = require(path.resolve(__dirname, "../static/lifecycle.js"));

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

test("a deferred canceled request cannot render after a newer request owns the page", async () => {
  const lifecycle = new RequestLifecycle();
  const oldController = new AbortController();
  const newerController = new AbortController();
  const old = lifecycle.begin(oldController);
  const oldResponse = deferred();
  const rendered = [];
  const oldWork = oldResponse.promise.then(() => lifecycle.applyIfCurrent(old, () => rendered.push("old")));

  lifecycle.cancel(old);
  const newer = lifecycle.begin(newerController);
  const newResponse = deferred();
  const newWork = newResponse.promise.then(() => lifecycle.applyIfCurrent(newer, () => rendered.push("new")));
  oldResponse.resolve();
  newResponse.resolve();
  await Promise.all([oldWork, newWork]);

  assert.equal(oldController.signal.aborted, true);
  assert.deepEqual(rendered, ["new"]);
});

test("source edits, reset, and pagehide invalidate active ownership", () => {
  const lifecycle = new RequestLifecycle();
  const owner = lifecycle.begin(new AbortController());
  const afterSourceEdit = lifecycle.invalidate();
  assert.equal(lifecycle.owns(owner), false);
  const afterReset = lifecycle.invalidate();
  const next = lifecycle.begin(new AbortController());
  lifecycle.pagehide();

  assert.ok(afterReset > afterSourceEdit);
  assert.equal(lifecycle.owns(next), false);
  assert.equal(lifecycle.generation > afterReset, true);
});
