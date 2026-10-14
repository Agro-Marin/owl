import { ComputationState, debug, debugLog, debugNow, OwlError, runTracked } from "@odoo/owl-core";
import { BDom, mount, type MountTarget } from "../blockdom";
import type { ComponentNode } from "../component_node";
import { STATUS } from "../status";
import { fibersInError, handleError } from "./error_handling";
import { memoResume, memoSuspend } from "./memo";
import { Scheduler } from "./scheduler";

const MAX_RENDER_ITERATIONS = 1000;

export const APPLIED_TO_DOM = 1;

export enum FiberPhase {
  NEW,
  RENDERING,
  RENDERED,
}

export function makeChildFiber(node: ComponentNode, parent: Fiber): Fiber {
  let current = node.fiber;
  if (current) {
    cancelFibers(current.children);
    current.root = null;
  }
  const fiber = new Fiber(node, parent);
  queueOwedMounted(fiber);
  return fiber;
}

export function makeRootFiber(node: ComponentNode): Fiber {
  const current = node.fiber;
  if (current) {
    const root = current.root!;
    if (
      root === current ||
      current.phase === FiberPhase.NEW ||
      !fibersInError.has(root) ||
      fibersInError.has(current)
    ) {
      return recycleFiber(node, current, root);
    }
    if (debug.fiber) {
      debugLog(
        "fiber",
        `render ${node.componentName} alone: ${root.node.componentName}'s pass failed`
      );
    }
    root.counter -= cancelFibers(current.children);
    current.root = null;
  }
  const fiber = new RootFiber(node, null);
  if (node.willPatch.length) {
    fiber.willPatch.push(fiber);
  }
  if (node.patched.length) {
    fiber.patched.push(fiber);
  }
  queueOwedMounted(fiber);
  return fiber;
}

function recycleFiber(node: ComponentNode, current: Fiber, root: RootFiber): Fiber {
  current.renderState += 2;
  if (debug.fiber) {
    debugLog("fiber", `recycle ${node.componentName} (${current.renderState >> 1})`);
  }
  root.locked = true;
  const rendered = current.phase === FiberPhase.NEW ? 0 : 1;
  root.counter += rendered - cancelFibers(current.children);
  root.locked = false;
  current.children = [];
  current.childrenMap = null;
  current.bdom = null;
  current.phase = FiberPhase.NEW;
  if (root instanceof MountFiber && root.prepared) {
    root.prepared = false;
    root.renderState &= ~APPLIED_TO_DOM;
  }
  if (fibersInError.has(current)) {
    fibersInError.delete(current);
    let failedElsewhere = false;
    const failed = root.failed;
    if (failed) {
      failed.delete(current);
      for (const fiber of failed) {
        if (fiber.node.fiber === fiber) {
          failedElsewhere = true;
          break;
        }
      }
    }
    if (!failedElsewhere) {
      fibersInError.delete(root);
      root.failed = null;
    }
    current.renderState &= ~APPLIED_TO_DOM;
    if (current instanceof RootFiber) {
      current.mounted = current instanceof MountFiber ? [current] : [];
    }
  }
  return current;
}

export const subRootHosts = new WeakMap<ComponentNode, ComponentNode>();
export const hostedSubRoots = new WeakMap<ComponentNode, Set<ComponentNode>>();

function renderSubRootsDeep(node: ComponentNode) {
  const subRoots = hostedSubRoots.get(node);
  if (subRoots) {
    for (const subRoot of subRoots) {
      if (subRoot.status === STATUS.MOUNTED) {
        if (debug.fiber) {
          debugLog(
            "fiber",
            `deep render of ${node.componentName} reaches its sub-root ${subRoot.componentName}`
          );
        }
        subRoot.render(true);
      }
    }
  }
}

function above(node: ComponentNode): ComponentNode | null {
  return node.parent || (node.status === STATUS.MOUNTED ? subRootHosts.get(node) || null : null);
}

function cancelFibers(fibers: Fiber[]): number {
  let result = 0;
  for (let fiber of fibers) {
    let node = fiber.node;
    if (node.status === STATUS.NEW) {
      node._destroy();
    }
    node.fiber = null;
    if (fiber.phase !== FiberPhase.NEW) {
      node.forceNextRender = true;
    } else {
      result++;
      if (node.bdom) {
        node.forceNextRender = true;
      }
    }
    result += cancelFibers(fiber.children);
  }
  return result;
}

export class Fiber {
  node: ComponentNode;
  bdom: BDom | null = null;
  root: RootFiber | null;
  parent: Fiber | null;
  children: Fiber[] = [];
  renderState = 0;
  deep: boolean = false;
  phase: FiberPhase = FiberPhase.NEW;
  childrenMap: ComponentNode["childMap"] = null;

  constructor(node: ComponentNode, parent: Fiber | null) {
    this.node = node;
    this.parent = parent;
    if (parent) {
      this.deep = parent.deep;
      const root = parent.root!;
      root.counter++;
      this.root = root;
      parent.children.push(this);
    } else {
      this.root = this as any;
    }
  }

  render() {
    const scheduler = this.root!.node.app.scheduler;
    if (scheduler.tasks.size > 1 || Scheduler.active.size > 1) {
      let prev = this.root!.node;
      let current = above(prev);
      while (current) {
        if (current.fiber) {
          let root = current.fiber.root!;
          if (
            (root.counter === 0 || fibersInError.has(root)) &&
            (!prev.parent || !!current.fiber.childrenMap?.has(prev.parentKey!))
          ) {
            current = root.node;
          } else {
            if (debug.fiber) {
              debugLog(
                "fiber",
                `delay ${this.node.componentName}: ${root.node.componentName} is rendering`
              );
            }
            root.node.app.scheduler.delayedRenders.push(this);
            return;
          }
        }
        prev = current;
        current = above(current);
      }
    }

    const node = this.node;
    const root = this.root;
    if (root) {
      if (this.renderState >> 1 > MAX_RENDER_ITERATIONS) {
        handleError({
          node,
          error: new OwlError(
            `Maximum render iterations (${MAX_RENDER_ITERATIONS}) exceeded. ` +
              `Component "${node.componentName}" is stuck in a render loop: rendering it ` +
              `keeps triggering another render before the DOM is updated. A common cause is ` +
              `updating reactive state during render or setup() — e.g. calling a parent's ` +
              `state setter from a child's setup().`
          ),
        });
        return;
      }
      node.signalComputation.state = ComputationState.EXECUTED;
      node.previousMemos = node.memos;
      node.memos = null;
      const outerCollection = memoSuspend();
      this.phase = FiberPhase.RENDERING;
      const start = debug.fiber ? debugNow() : -1;
      this.bdom = runTracked(node.signalComputation, () => {
        try {
          return node.renderFn() as BDom;
        } catch (e) {
          handleError({ node, error: e });
          return null;
        } finally {
          this.phase = FiberPhase.RENDERED;
          memoResume(outerCollection);
        }
      });
      if (this.deep && this.bdom) {
        renderSubRootsDeep(node);
      }
      const newCounter = root.counter - 1;
      root.counter = newCounter;
      if (debug.fiber) {
        debugLog(
          "fiber",
          `render ${node.componentName}${start < 0 ? "" : ` in ${(debugNow() - start).toFixed(2)} ms`}, ${newCounter} left in ${root.node.componentName}'s pass`
        );
      }
      if (newCounter === 0) {
        if (fibersInError.has(root)) {
          scheduler.requestFrame();
        } else {
          scheduler.flush();
        }
      }
    }
  }
}

export class RootFiber extends Fiber {
  counter: number = 1;
  failed: Set<Fiber> | null = null;

  willPatch: Fiber[] = [];
  patched: Fiber[] = [];
  mounted: Fiber[] = [];
  locked: boolean = false;

  complete() {
    const node = this.node;
    this.locked = true;
    let current: Fiber | undefined = undefined;
    if (debug.fiber) {
      debugLog(
        "fiber",
        `commit ${node.componentName}: ${this.willPatch.length} willPatch, ${this.mounted.length} mounted, ${this.patched.length} patched`
      );
    }
    try {
      for (current of this.willPatch) {
        let node = current.node;
        if (node.fiber === current) {
          const component = node.component;
          for (let cb of node.willPatch) {
            cb.call(component);
          }
        }
      }
      current = undefined;
      if (node.status === STATUS.DESTROYED) {
        if (debug.fiber) {
          debugLog("fiber", `drop ${node.componentName}'s commit: destroyed by onWillPatch`);
        }
        this.locked = false;
        return;
      }

      node._patch();
      this.locked = false;
    } catch (e) {
      for (let fiber of this.mounted) {
        oweMounted(fiber.node);
      }
      this.locked = false;
      handleError({ fiber: current || this, error: e });
      return;
    }

    const failed = callCommitHooks(this.mounted, "mounted");
    if (failed !== null) {
      callCommitHooks(this.patched, "patched", failed);
    }
  }
}

const owedMounted = new WeakMap<ComponentNode, Function[]>();

function oweMounted(node: ComponentNode) {
  if (!owedMounted.has(node)) {
    owedMounted.set(node, node.willUnmount);
    node.willUnmount = [];
  }
}

function queueOwedMounted(fiber: Fiber) {
  const node = fiber.node;
  if (owedMounted.has(node)) {
    const mounted = fiber.root!.mounted;
    const i = mounted.findIndex((f) => f.node === node);
    if (i < 0) {
      mounted.push(fiber);
    } else {
      mounted[i] = fiber;
    }
  }
}

function callCommitHooks(
  fibers: Fiber[],
  hook: "mounted" | "patched",
  failed = false
): boolean | null {
  const mounting = hook === "mounted";
  let skipped: Fiber[] | null = failed ? [] : null;
  let current: Fiber | undefined;
  while ((current = fibers.pop())) {
    const node = current.node;
    if (skipped && (!(current.renderState & APPLIED_TO_DOM) || fibersInError.has(current))) {
      if (mounting) {
        oweMounted(node);
      }
      skipped.push(current);
      continue;
    }
    if (!(current.renderState & APPLIED_TO_DOM) || node.status === STATUS.DESTROYED) {
      continue;
    }
    if (mounting) {
      const held = owedMounted.get(node);
      if (held) {
        owedMounted.delete(node);
        node.willUnmount = held;
      }
    }
    if (debug.lifecycle && node[hook].length) {
      debugLog("lifecycle", `${hook} ${node.componentName}: ${node[hook].length} hook(s)`);
    }
    try {
      for (let cb of node[hook]) {
        cb();
      }
    } catch (e) {
      skipped ||= [];
      const waiting = mounting ? fibers.slice() : [];
      const willUnmount = waiting.map((fiber) => fiber.node.willUnmount);
      for (let fiber of waiting) {
        fiber.node.willUnmount = [];
      }
      handleError({ fiber: current, error: e });
      if (node.app.destroyed) {
        return null;
      }
      for (let i = 0; i < waiting.length; i++) {
        waiting[i].node.willUnmount = willUnmount[i];
      }
    }
  }
  if (!skipped) {
    return false;
  }
  for (let i = skipped.length - 1; i >= 0; i--) {
    fibers.push(skipped[i]);
  }
  return true;
}

type Position = "first-child" | "last-child";

export interface MountOptions {
  position?: Position;
  afterNode?: Node | null;
  allowDetached?: boolean;
}

export class MountFiber extends RootFiber {
  target: MountTarget | null;
  position: Position;
  afterNode: Node | null = null;
  allowDetached = false;
  prepared = false;
  onPrepared: (() => void) | null = null;

  constructor(node: ComponentNode, target: MountTarget | null, options: MountOptions = {}) {
    super(node, null);
    this.target = target;
    this.position = options.position || "last-child";
    this.afterNode = options.afterNode ?? null;
    this.allowDetached = options.allowDetached ?? false;
  }

  complete() {
    this.prepared = true;
    if (this.target) {
      this._mount();
    } else {
      this.renderState |= APPLIED_TO_DOM;
      this.onPrepared?.();
    }
  }

  commit(target: MountTarget, options: MountOptions = {}) {
    this.target = target;
    this.position = options.position || "last-child";
    this.afterNode = options.afterNode ?? null;
    this.allowDetached = options.allowDetached ?? false;
    if (this.prepared) {
      this._mount();
    }
  }

  private _mount() {
    let current: Fiber | undefined = this;
    if (debug.fiber) {
      debugLog("fiber", `mount ${this.node.componentName}`, this.target);
    }
    try {
      const node = this.node;
      node.childMap = this.childrenMap;
      (node.app.constructor as any).validateTarget(this.target!, {
        attached: !this.allowDetached,
      });
      if (node.bdom) {
        node.updateDom();
      } else {
        node.bdom = this.bdom;
        if (this.afterNode) {
          mount(node.bdom!, this.target!, this.afterNode);
        } else if (this.position === "last-child" || this.target!.childNodes.length === 0) {
          mount(node.bdom!, this.target!);
        } else {
          const firstChild = this.target!.childNodes[0];
          mount(node.bdom!, this.target!, firstChild);
        }
      }

      node.fiber = null;

      node.status = STATUS.MOUNTED;
      this.renderState |= APPLIED_TO_DOM;
    } catch (e) {
      handleError({ fiber: current as Fiber, error: e });
      return;
    }
    callCommitHooks(this.mounted, "mounted");
  }
}
