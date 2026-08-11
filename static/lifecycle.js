"use strict";

(function exposeLifecycle(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.ResumeAILifecycle = api;
})(typeof globalThis === "object" ? globalThis : null, function createLifecycle() {
  class RequestLifecycle {
    constructor() {
      this.generation = 0;
      this.active = null;
    }

    begin(controller) {
      if (!(controller instanceof AbortController)) throw new TypeError("A request controller is required.");
      if (this.active) this.active.controller.abort();
      const owner = { generation: ++this.generation, controller };
      this.active = owner;
      return owner;
    }

    owns(owner) {
      return this.active === owner && this.generation === owner.generation && !owner.controller.signal.aborted;
    }

    invalidate() {
      if (this.active) this.active.controller.abort();
      this.active = null;
      this.generation += 1;
      return this.generation;
    }

    cancel(owner) {
      if (this.active === owner) owner.controller.abort();
      return this.invalidate();
    }

    pagehide() { return this.invalidate(); }

    applyIfCurrent(owner, apply) {
      if (!this.owns(owner)) return false;
      apply();
      return true;
    }

    finish(owner) {
      if (!this.owns(owner)) return false;
      this.active = null;
      return true;
    }
  }

  return { RequestLifecycle };
});
