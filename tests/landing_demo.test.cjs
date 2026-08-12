"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");

const { STAGES, nextStage, createController } = require(path.resolve(__dirname, "../static/landing_demo.js"));

function manualClock() {
  let queued = [];
  return {
    setTimer(callback) { queued.push(callback); return callback; },
    clearTimer(callback) { queued = queued.filter((item) => item !== callback); },
    runNext() { const callback = queued.shift(); if (callback) callback(); },
    pending() { return queued.length; },
  };
}

test("the coaching example advances in a fixed, wrapping order", () => {
  assert.deepEqual(STAGES, ["original", "annotated", "priorities", "improved"]);
  assert.equal(nextStage("original"), "annotated");
  assert.equal(nextStage("annotated"), "priorities");
  assert.equal(nextStage("priorities"), "improved");
  assert.equal(nextStage("improved"), "original");
});

test("pause, direct selection, and replay control real stage output", () => {
  const clock = manualClock();
  const rendered = [];
  const controller = createController({
    onStage: (stage) => rendered.push(stage),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    duration: 1,
    reducedMotion: false,
  });

  controller.play();
  clock.runNext();
  assert.equal(controller.stage(), "annotated");
  controller.pause();
  assert.equal(clock.pending(), 0);
  controller.select("priorities");
  assert.equal(controller.stage(), "priorities");
  controller.replay();
  assert.equal(controller.stage(), "original");
  assert.deepEqual(rendered.slice(-2), ["priorities", "original"]);
});

test("reduced motion renders the completed example without scheduling autoplay", () => {
  const clock = manualClock();
  const rendered = [];
  const controller = createController({
    onStage: (stage) => rendered.push(stage),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    reducedMotion: true,
  });

  controller.play();
  assert.equal(controller.stage(), "improved");
  assert.deepEqual(rendered, ["improved"]);
  assert.equal(clock.pending(), 0);
});

test("dispose prevents a queued transition from changing the page", () => {
  const clock = manualClock();
  const rendered = [];
  const controller = createController({
    onStage: (stage) => rendered.push(stage),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    reducedMotion: false,
  });

  controller.play();
  controller.dispose();
  clock.runNext();
  assert.deepEqual(rendered, ["original"]);
});
