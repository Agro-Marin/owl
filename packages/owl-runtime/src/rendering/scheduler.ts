import { debug, debugLog } from "@odoo/owl-core";
import { fibersInError } from "./error_handling";
import { APPLIED_TO_DOM, Fiber, RootFiber } from "./fibers";

// -----------------------------------------------------------------------------
//  Scheduler
// -----------------------------------------------------------------------------

let requestAnimationFrame: Window["requestAnimationFrame"];
if (typeof window !== "undefined") {
  requestAnimationFrame = window.requestAnimationFrame.bind(window);
}

export class Scheduler {
  // capture the value of requestAnimationFrame as soon as possible, to avoid
  // interactions with other code, such as test frameworks that override them
  static requestAnimationFrame = requestAnimationFrame;
  // the schedulers that may hold a task: a node's ancestor may belong to
  // another app, whose render then delays it
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

  /**
   * Drops the pass of a component destroyed before its commit.
   */
  forget(fiber: RootFiber) {
    if (this.tasks.delete(fiber)) {
      if (debug.scheduler) {
        debugLog("scheduler", `drop ${fiber.node.componentName}: destroyed`);
      }
      if (!this.tasks.size && !this.processing) {
        Scheduler.active.delete(this);
      }
    }
  }

  /**
   * Process all current tasks. This only applies to the fibers that are ready.
   * Other tasks are left unchanged.
   */
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
      // superseded: another render (a slot of this app rendered by a
      // component of another one) patched the node and cleared its fiber
      if (fiber.node.fiber !== fiber) {
        if (debug.scheduler) {
          debugLog("scheduler", `drop ${fiber.node.componentName}: superseded`);
        }
        this.tasks.delete(fiber);
        continue;
      }
      // a failed pass never completes; its node keeps the fiber, so the next
      // render reuses it and schedules it again
      if (fibersInError.has(fiber)) {
        if (debug.scheduler) {
          debugLog("scheduler", `drop ${fiber.node.componentName}: failed`);
        }
        this.tasks.delete(fiber);
        failed = true;
        continue;
      }
      if (debug.scheduler && fiber.counter !== 0) {
        debugLog(
          "scheduler",
          `wait ${fiber.node.componentName}: ${fiber.counter} render(s) pending`
        );
      }
      if (fiber.counter === 0) {
        fiber.complete();
        // at this point, the fiber should have been applied to the DOM, so we can
        // remove it from the task list. If it is not the case, it means that there
        // was an error and an error handler triggered a new rendering that recycled
        // the fiber, so in that case, we actually want to keep the fiber around,
        // otherwise it will just be ignored.
        if (fiber.renderState & APPLIED_TO_DOM) {
          this.tasks.delete(fiber);
        }
      }
    }
    if (failed) {
      // a frame after the failure, the handlers had their chance to re-render
      // around it: the renders the failed pass delayed go on
      this.flush();
    }
    if (!this.tasks.size) {
      Scheduler.active.delete(this);
    }
    this.processing = false;
  }
}
