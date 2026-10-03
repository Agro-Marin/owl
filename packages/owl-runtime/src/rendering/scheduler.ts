import { fibersInError } from "./error_handling";
import { APPLIED_TO_DOM, Fiber, RootFiber } from "./fibers";
import { STATUS } from "../status";

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
    this.tasks.add(fiber.root!);
    Scheduler.active.add(this);
  }

  /**
   * Process all current tasks. This only applies to the fibers that are ready.
   * Other tasks are left unchanged.
   */
  flush() {
    if (this.delayedRenders.length) {
      let renders = this.delayedRenders;
      this.delayedRenders = [];
      for (let f of renders) {
        if (f.root && f.node.status !== STATUS.DESTROYED && f.node.fiber === f) {
          f.render();
        }
      }
    }

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
    for (let fiber of this.tasks) {
      if (fiber.root !== fiber) {
        this.tasks.delete(fiber);
        continue;
      }
      // superseded: another render (a slot of this app rendered by a
      // component of another one) patched the node and cleared its fiber
      if (fiber.node.fiber !== fiber) {
        this.tasks.delete(fiber);
        continue;
      }
      // a failed pass never completes; its node keeps the fiber, so the next
      // render reuses it and schedules it again
      if (fibersInError.has(fiber)) {
        this.tasks.delete(fiber);
        continue;
      }
      if (fiber.node.status === STATUS.DESTROYED) {
        this.tasks.delete(fiber);
        continue;
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
    for (let task of this.tasks) {
      if (task.node.status === STATUS.DESTROYED) {
        this.tasks.delete(task);
      }
    }
    if (!this.tasks.size) {
      Scheduler.active.delete(this);
    }
    this.processing = false;
  }
}
