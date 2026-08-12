"use strict";

(function exposeLandingDemo(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ResumeAILandingDemo = api;
})(typeof globalThis === "object" ? globalThis : null, function createLandingDemoApi() {
  const STAGES = Object.freeze(["original", "annotated", "priorities", "improved"]);

  function nextStage(stage) {
    const index = STAGES.indexOf(stage);
    if (index < 0) throw new TypeError("Unknown coaching demo stage.");
    return STAGES[(index + 1) % STAGES.length];
  }

  function createController({
    onStage,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    duration = 2200,
    reducedMotion = false,
  }) {
    if (typeof onStage !== "function") throw new TypeError("A stage renderer is required.");
    let current = reducedMotion ? "improved" : "original";
    let playing = false;
    let disposed = false;
    let timer = null;

    function cancelTimer() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    }

    function emit() { if (!disposed) onStage(current); }

    function schedule() {
      if (!playing || reducedMotion || disposed || timer !== null) return;
      timer = setTimer(() => {
        timer = null;
        if (!playing || disposed) return;
        current = nextStage(current);
        emit();
        schedule();
      }, duration);
    }

    function play() {
      if (disposed || reducedMotion) return;
      playing = true;
      schedule();
    }

    function pause() {
      playing = false;
      cancelTimer();
    }

    function select(stage) {
      if (!STAGES.includes(stage)) throw new TypeError("Unknown coaching demo stage.");
      cancelTimer();
      current = stage;
      emit();
      schedule();
    }

    function replay() {
      cancelTimer();
      current = reducedMotion ? "improved" : "original";
      emit();
      schedule();
    }

    function dispose() {
      pause();
      disposed = true;
    }

    emit();
    return { play, pause, replay, select, dispose, stage: () => current };
  }

  return { STAGES, nextStage, createController };
});
