import { debug, debugLog } from "@odoo/owl-core";
import { fibersInError } from "./error_handling";
import { APPLIED_TO_DOM, Fiber, renderMergedAlone, RootFiber } from "./fibers";

function captureAnimationFrame(): Window["requestAnimationFrame"] {
  return typeof window === "undefined"
    ? (undefined as any)
    : window.requestAnimationFrame.bind(window);
}

const requestAnimationFrame = /* @__PURE__ */ captureAnimationFrame();

export class Scheduler {
  static requestAnimationFrame = requestAnimationFrame;
  static active: Set<Scheduler> = new Set();
  tasks: Set<RootFiber> = new Set();
  requestAnimationFrame: Window["requestAnimationFrame"];
  frame: number = 0;
  delayedRenders: Fiber[] = [];
  processing = false;

  constructor() {
    this.requestAnimationFrame = Scheduler.requestAnimationFrame;
  }

  addFiber(fiber: Fiber) {
    if (debug.scheduler) {
      debugLog(
        "scheduler",
        `schedule ${fiber.root!.node.componentName}, ${this.tasks.size + 1} task(s)`
      );
    }
    this.tasks.add(fiber.root!);
    Scheduler.active.add(this);
  }

  forget(fiber: Fiber) {
    const delayed = this.delayedRenders;
    if (delayed.length) {
      const i = delayed.indexOf(fiber);
      if (i >= 0) {
        delayed.splice(i, 1);
      }
    }
    if (fiber.root === fiber && this.tasks.delete(fiber as RootFiber)) {
      if (debug.scheduler) {
        debugLog("scheduler", `drop ${fiber.node.componentName}: destroyed`);
      }
      if (!this.tasks.size && !this.processing) {
        Scheduler.active.delete(this);
      }
    }
  }

  flush() {
    if (this.delayedRenders.length) {
      let renders = this.delayedRenders;
      this.delayedRenders = [];
      if (debug.scheduler) {
        debugLog(
          "scheduler",
          `resume ${renders.length} delayed render(s)`,
          renders.map((f) => f.node.componentName)
        );
      }
      for (let f of renders) {
        if (f.root && f.node.fiber === f) {
          f.render();
        }
      }
    }
    this.requestFrame();
  }

  requestFrame() {
    if (this.frame === 0) {
      this.frame = this.requestAnimationFrame(() => this.processTasks());
    }
  }

  processTasks() {
    if (this.processing) {
      return;
    }
    this.processing = true;
    try {
      this.frame = 0;
      let failed = false;
      if (debug.scheduler) {
        debugLog("scheduler", `frame, ${this.tasks.size} task(s)`);
      }
      for (let fiber of this.tasks) {
        if (fiber.root !== fiber) {
          this.tasks.delete(fiber);
          continue;
        }
        if (fiber.node.fiber !== fiber) {
          if (debug.scheduler) {
            debugLog("scheduler", `drop ${fiber.node.componentName}: superseded`);
          }
          this.tasks.delete(fiber);
          continue;
        }
        if (fibersInError.has(fiber)) {
          if (debug.scheduler) {
            debugLog("scheduler", `drop ${fiber.node.componentName}: failed`);
          }
          this.tasks.delete(fiber);
          failed = true;
          if (fiber.merged) {
            renderMergedAlone(fiber);
          }
          continue;
        }
        if (fiber.counter === 0) {
          fiber.complete();
          if (fiber.renderState & APPLIED_TO_DOM) {
            this.tasks.delete(fiber);
          }
        } else if (debug.scheduler) {
          debugLog(
            "scheduler",
            `wait ${fiber.node.componentName}: ${fiber.counter} render(s) pending`
          );
        }
      }
      if (failed) {
        this.flush();
      }
      if (!this.tasks.size) {
        Scheduler.active.delete(this);
      }
    } finally {
      this.processing = false;
    }
  }
}
