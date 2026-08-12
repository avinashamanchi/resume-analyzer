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

(function bindLandingDemo(root) {
  if (!root || !root.document || !root.ResumeAILandingDemo) return;

  function setup() {
    const document = root.document;
    const demo = document.querySelector(".resume-demo");
    if (!demo) return;
    const status = demo.querySelector("[data-demo-status]");
    const toggle = demo.querySelector("[data-demo-toggle]");
    const replay = demo.querySelector("[data-demo-replay]");
    const stageButtons = Array.from(demo.querySelectorAll("[data-demo-select]"));
    const navToggle = document.querySelector(".entry-nav-toggle");
    const nav = document.querySelector("#entry-nav");
    const reducedMotion = Boolean(root.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
    const messages = {
      original: "Original bullet shown without a clear action or result.",
      annotated: "The review identifies hidden ownership and missing evidence.",
      priorities: "Ownership, specificity, and outcome are the next editing priorities.",
      improved: "Improved example shown with ownership, scope, and outcome.",
    };
    let playing = false;

    function render(stage) {
      demo.dataset.demoStage = stage;
      if (status) status.textContent = messages[stage];
      for (const button of stageButtons) button.setAttribute("aria-pressed", String(button.dataset.demoSelect === stage));
    }

    const controller = root.ResumeAILandingDemo.createController({ onStage: render, reducedMotion });

    function setPlaying(next) {
      playing = Boolean(next) && !reducedMotion;
      if (playing) controller.play(); else controller.pause();
      if (toggle) toggle.textContent = playing ? "Pause demo" : "Play demo";
    }

    toggle?.addEventListener("click", () => setPlaying(!playing));
    replay?.addEventListener("click", () => { controller.replay(); setPlaying(!reducedMotion); });
    for (const button of stageButtons) {
      button.addEventListener("click", () => {
        setPlaying(false);
        controller.select(button.dataset.demoSelect);
      });
    }

    if ("IntersectionObserver" in root && !reducedMotion) {
      const observer = new root.IntersectionObserver((entries) => setPlaying(Boolean(entries[0]?.isIntersecting)), { threshold: 0.35 });
      observer.observe(demo);
      root.addEventListener("pagehide", () => observer.disconnect(), { once: true });
    } else {
      setPlaying(!reducedMotion);
    }

    navToggle?.addEventListener("click", () => {
      const open = navToggle.getAttribute("aria-expanded") !== "true";
      navToggle.setAttribute("aria-expanded", String(open));
      nav?.setAttribute("data-open", String(open));
    });
    nav?.addEventListener("click", (event) => {
      if (event.target.closest("a")) {
        navToggle?.setAttribute("aria-expanded", "false");
        nav.setAttribute("data-open", "false");
      }
    });
    for (const link of document.querySelectorAll("[data-focus-analysis]")) {
      link.addEventListener("click", () => root.setTimeout(() => document.querySelector("#analysis-form-heading")?.focus(), 0));
    }
    root.addEventListener("pagehide", () => controller.dispose(), { once: true });
  }

  if (root.document.readyState === "loading") root.document.addEventListener("DOMContentLoaded", setup, { once: true });
  else setup();
})(typeof globalThis === "object" ? globalThis : null);
