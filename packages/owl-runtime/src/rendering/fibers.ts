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

export function makeRootFiber(node: ComponentNode): Fiber | null {
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
    if (!node.bdom) {
      if (debug.fiber) {
        debugLog(
          "fiber",
          `keep ${node.componentName} in ${root.node.componentName}'s failed pass: never mounted`
        );
      }
      return null;
    }
    if (debug.fiber) {
      debugLog(
        "fiber",
        `render ${node.componentName} alone: ${root.node.componentName}'s pass failed`
      );
    }
    root.counter -= cancelFibers(current.children);
    current.children = [];
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

export function renderMergedAlone(root: RootFiber) {
  const merged = root.merged!;
  let waiting: Fiber[] | null = null;
  for (const fiber of merged) {
    if (fiber.node.fiber !== fiber || fiber.root !== root) {
      continue;
    }
    if (fiber.phase === FiberPhase.NEW) {
      (waiting ||= []).push(fiber);
      continue;
    }
    if (debug.fiber) {
      debugLog(
        "fiber",
        `${fiber.node.componentName} asked to render during ${root.node.componentName}'s failed pass`
      );
    }
    fiber.node.render(fiber.deep);
  }
  root.merged = waiting;
}

function recycleFiber(node: ComponentNode, current: Fiber, root: RootFiber): Fiber {
  current.renderState += 2;
  if (current === root) {
    root.merged = null;
  }
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
    if (node.fiber === fiber) {
      node.fiber = null;
    }
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
      if (root.merged && fibersInError.has(root)) {
        renderMergedAlone(root);
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
  merged: Fiber[] | null = null;

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
        if (node.fiber === current && !(owedCount && owedMounted.has(node))) {
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

    commitHooks(this);
  }
}

const owedMounted = new WeakMap<ComponentNode, Function[]>();
const owedPatched = new WeakSet<ComponentNode>();
let owedCount = 0;

const queuedForOwed = new WeakSet<Fiber>();

function oweMounted(node: ComponentNode) {
  if (node.status !== STATUS.DESTROYED && !owedMounted.has(node)) {
    owedMounted.set(node, node.willUnmount);
    node.willUnmount = [];
    owedCount++;
  }
}

function owePatched(node: ComponentNode) {
  if (node.status !== STATUS.DESTROYED && !owedPatched.has(node)) {
    owedPatched.add(node);
    owedCount++;
  }
}

function settleOwed(node: ComponentNode, hook: "mounted" | "patched"): boolean {
  if (hook === "patched") {
    if (owedPatched.delete(node)) {
      owedCount--;
      return true;
    }
    return false;
  }
  const held = owedMounted.get(node);
  if (held) {
    owedMounted.delete(node);
    node.willUnmount = held;
    owedCount--;
    return true;
  }
  return false;
}

export function forgetOwed(node: ComponentNode) {
  if (owedCount) {
    if (owedMounted.delete(node)) {
      owedCount--;
    }
    if (owedPatched.delete(node)) {
      owedCount--;
    }
  }
}

function payOwedAbove(node: ComponentNode) {
  if (!owedCount) {
    return;
  }
  const owing: ComponentNode[] = [];
  for (let p = node.parent; p; p = p.parent) {
    if (owedMounted.has(p) || owedPatched.has(p)) {
      owing.push(p);
    }
  }
  for (const hook of ["mounted", "patched"] as const) {
    for (const p of owing) {
      if (!settleOwed(p, hook)) {
        continue;
      }
      if (debug.lifecycle && p[hook].length) {
        debugLog(
          "lifecycle",
          `${hook} ${p.componentName}: ${p[hook].length} hook(s) owed since a failed commit`
        );
      }
      try {
        for (let cb of p[hook]) {
          cb();
        }
      } catch (e) {
        handleError({ node: p, error: e });
        return;
      }
    }
  }
}

function queueOwedMounted(fiber: Fiber) {
  const node = fiber.node;
  if (owedMounted.has(node)) {
    const mounted = fiber.root!.mounted;
    queuedForOwed.add(fiber);
    const i = mounted.findIndex((f) => f.node === node);
    if (i < 0) {
      mounted.push(fiber);
    } else {
      mounted[i] = fiber;
    }
  }
}

function commitHooks(root: RootFiber) {
  const { mounted, patched } = root;
  if (owedCount) {
    if (owedMounted.has(root.node) && !mounted.includes(root)) {
      mounted.unshift(root);
    }
    if (mounted.length && patched.length) {
      const mounting = new Set(mounted.map((f) => f.node));
      root.patched = patched.filter((f) => !mounting.has(f.node));
    }
  }
  const failed = callCommitHooks(mounted, "mounted");
  if (failed === null) {
    return;
  }
  if (callCommitHooks(root.patched, "patched", failed) === false) {
    payOwedAbove(root.node);
  }
}

function callCommitHooks(
  fibers: Fiber[],
  hook: "mounted" | "patched",
  failed = false
): boolean | null {
  const mounting = hook === "mounted";
  let current: Fiber | undefined;
  while ((current = fibers.pop())) {
    const node = current.node;
    const applied = current.renderState & APPLIED_TO_DOM;
    if (failed && (!applied || fibersInError.has(current))) {
      if (mounting) {
        oweMounted(node);
      } else if (applied) {
        owePatched(node);
      }
      continue;
    }
    if (!applied || node.status === STATUS.DESTROYED) {
      continue;
    }
    const settled = owedCount ? settleOwed(node, hook) : false;
    if (mounting && queuedForOwed.delete(current) && !settled) {
      if (debug.lifecycle) {
        debugLog("lifecycle", `mounted ${node.componentName}: owed hooks already paid`);
      }
      continue;
    }
    if (debug.lifecycle && node[hook].length) {
      debugLog("lifecycle", `${hook} ${node.componentName}: ${node[hook].length} hook(s)`);
    }
    try {
      for (let cb of node[hook]) {
        cb();
      }
    } catch (e) {
      failed = true;
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
  return failed;
}

function unmountChildren(children: Map<unknown, ComponentNode>) {
  for (const child of children.values()) {
    if (child.status === STATUS.MOUNTED) {
      if (debug.fiber) {
        debugLog(
          "fiber",
          `${child.componentName} goes back to unmounted with its parent's failed mount`
        );
      }
      child.status = STATUS.NEW;
      if (child.childMap) {
        unmountChildren(child.childMap);
      }
    }
  }
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
    if (debug.fiber) {
      debugLog("fiber", `mount ${this.node.componentName}`, this.target);
    }
    const node = this.node;
    const target = this.target!;
    let next: Node | null = null;
    let prev: Node | null = null;
    try {
      (node.app.constructor as any).validateTarget(target, {
        attached: !this.allowDetached,
      });
      next = this.afterNode || (this.position === "last-child" ? null : target.firstChild);
      prev = next ? next.previousSibling : target.lastChild;
      node.childMap = this.childrenMap;
      node.bdom = this.bdom;
      mount(node.bdom!, target, next);
      node.fiber = null;
      node.status = STATUS.MOUNTED;
      this.renderState |= APPLIED_TO_DOM;
    } catch (e) {
      let refError: { error: unknown } | null = null;
      const bdom = node.bdom;
      if (bdom) {
        node.bdom = null;
        node.childMap = null;
        let n: Node | null = prev ? prev.nextSibling : target.firstChild;
        while (n && n !== next) {
          const sibling: Node | null = n.nextSibling;
          n.parentNode!.removeChild(n);
          n = sibling;
        }
        try {
          bdom.detachRefs();
        } catch (error) {
          refError = { error };
        }
        for (const fiber of this.mounted) {
          oweMounted(fiber.node);
        }
        if (this.childrenMap) {
          unmountChildren(this.childrenMap);
        }
      }
      handleError({ fiber: this, error: e });
      if (refError) {
        if (node.app.destroyed) {
          console.error(refError.error);
        } else {
          handleError({ node, error: refError.error });
        }
      }
      return;
    }
    commitHooks(this);
  }
}
