import { ComputationState, debug, debugLog, debugNow, OwlError, runTracked } from "@odoo/owl-core";
import { BDom, mount, type MountTarget } from "../blockdom";
import type { ComponentNode } from "../component_node";
import { STATUS } from "../status";
import { fibersInError, handleError } from "./error_handling";
import { memoResume, memoSuspend } from "./memo";
import { Scheduler } from "./scheduler";

// Max times a given fiber may be recycled before being committed to the DOM
// before we treat it as an infinite render loop. A healthy render commits after
// ~1 pass; only a self-retriggering loop ever approaches this. See issue #1968.
const MAX_RENDER_ITERATIONS = 1000;

// Bit 0 of Fiber.renderState: whether the fiber's result was applied to the
// DOM (the other bits hold the recycle count, see the renderState declaration).
export const APPLIED_TO_DOM = 1;

// Fiber.phase: a fiber whose render threw is RENDERED too, without a bdom
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
  return new Fiber(node, parent);
}

export function makeRootFiber(node: ComponentNode): Fiber {
  let current = node.fiber;
  if (current) {
    let root = current.root!;
    // This fiber is being re-rendered before it was ever committed to the DOM.
    // In a healthy app a fiber is committed (and node.fiber nulled) before the
    // next render, so this only climbs without bound in a render loop (#1968).
    // The count is per fiber, NOT on the root: under a long-lived uncommitted
    // root, many sibling subtrees may legitimately re-render once each, and a
    // shared counter would add those up and flag a loop where there is none.
    current.renderState += 2; // bump the recycle count held in bits 1+
    if (debug.fiber) {
      debugLog(
        "fiber",
        `re-render ${node.componentName} before its commit (recycle ${current.renderState >> 1})`
      );
    }
    // lock root fiber because canceling children fibers may destroy components,
    // which means any arbitrary code can be run in onWillDestroy, which may
    // trigger new renderings
    root.locked = true;
    // a fiber that never rendered (its onWillStart or onWillUpdateProps
    // failed) is still counted from its creation
    const rendered = current.phase === FiberPhase.NEW ? 0 : 1;
    root.setCounter(root.counter + rendered - cancelFibers(current.children));
    root.locked = false;
    current.children = [];
    current.childrenMap = null;
    current.bdom = null;
    current.phase = FiberPhase.NEW;
    if (root instanceof MountFiber && root.prepared) {
      // re-rendered between prepare and commit: commit() must wait again
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
          // a cancelled failure no longer belongs to the pass
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
        // it is possible that this fiber is a fiber that crashed while being
        // mounted, so the mounted list is possibly corrupted. We restore it to
        // its normal initial state (which is empty list or a list with a mount
        // fiber.
        current.mounted = current instanceof MountFiber ? [current] : [];
      }
    }
    return current;
  }
  const fiber = new RootFiber(node, null);
  if (node.willPatch.length) {
    fiber.willPatch.push(fiber);
  }
  if (node.patched.length) {
    fiber.patched.push(fiber);
  }
  return fiber;
}

function throwOnRender() {
  throw new OwlError("Attempted to render cancelled fiber");
}

// Host component node of each sub-root node (Portal/Suspense content), seeded
// by createRoot. Sparse metadata kept out of ComponentNode itself (same
// pattern as nodeErrorHandlers): only sub-roots have entries, and they are
// GC'd with their node.
export const subRootHosts = new WeakMap<ComponentNode, ComponentNode>();

/**
 * The node whose in-flight render this node's own render must yield to.
 * Usually the parent; for a mounted sub-root node (Portal/Suspense content),
 * its host, so renders inside the sub-root still yield to an ancestor render
 * that may be about to remove the host. An unmounted sub-root deliberately
 * stays unlinked: its initial render must proceed in parallel with the host's
 * own mount (Suspense renders its default slot while the outer tree is still
 * rendering).
 */
function above(node: ComponentNode): ComponentNode | null {
  return node.parent || (node.status === STATUS.MOUNTED ? subRootHosts.get(node) || null : null);
}

/**
 * @returns number of not-yet rendered fibers cancelled
 */
function cancelFibers(fibers: Fiber[]): number {
  let result = 0;
  for (let fiber of fibers) {
    let node = fiber.node;
    fiber.render = throwOnRender;
    if (node.status === STATUS.NEW) {
      node.cancel();
    }
    node.fiber = null;
    if (fiber.phase !== FiberPhase.NEW) {
      // if fiber has been rendered, this means that the component props have
      // been updated. however, this fiber will not be patched to the dom, so
      // it could happen that the next render compare the current props with
      // the same props, and skip the render completely. With the next line,
      // we kindly request the component code to force a render, so it works as
      // expected.
      node.forceNextRender = true;
    } else {
      result++;
      // The fiber has no bdom yet, but a mounted node still needs to be
      // re-rendered: this fiber represents an in-progress update that was
      // cancelled, which may have come from the node's own render() (whose
      // makeRootFiber recycled the existing child fiber and reset its bdom
      // to null). If the parent then skips the child because props are
      // unchanged, the child's reactive update would be lost.
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
  root: RootFiber | null; // A Fiber that has been replaced by another has no root
  parent: Fiber | null;
  children: Fiber[] = [];
  // Packs the "applied to DOM" flag (bit 0, see APPLIED_TO_DOM) together with
  // the number of times this uncommitted fiber has been recycled by
  // makeRootFiber (bits 1 and up). The recycle count climbs without bound only
  // in a render loop (#1968); it shares a slot with the flag so the many
  // fibers that are never recycled don't pay for a dedicated field.
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
      root.setCounter(root.counter + 1);
      this.root = root;
      parent.children.push(this);
    } else {
      this.root = this as any;
    }
  }

  render() {
    const scheduler = this.root!.node.app.scheduler;
    // If more than one root fiber is in flight, an ancestor may be rendering —
    // walk up to detect it and delay if needed. Otherwise no ancestor can have
    // a fiber (every in-progress root lives in the tasks of a scheduler, this
    // one or, for an ancestor of another app, another active one), so skip
    // the walk.
    if (scheduler.tasks.size > 1 || Scheduler.active.size > 1) {
      let prev = this.root!.node;
      let current = above(prev);
      while (current) {
        if (current.fiber) {
          let root = current.fiber.root!;
          // `!prev.parent` means we crossed a sub-root boundary: the content
          // never appears in the host's childrenMap, but it is retained as
          // long as the host node survives — and a node holding a fiber of a
          // finished (counter 0) or failed render pass survives that pass.
          if (
            (root.counter === 0 || fibersInError.has(root)) &&
            (!prev.parent || !!current.fiber.childrenMap?.has(prev.parentKey!))
          ) {
            current = root.node;
          } else {
            // the ancestor's app flushes its delayed renders once that
            // ancestor has rendered; it may not be this fiber's app
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

    // there are no current rendering from above => we can render
    const node = this.node;
    const root = this.root;
    if (root) {
      // Bail before touching the computation tracking pointer (below) so a
      // detected loop never leaves currentComputation pinned to a signalComputation
      // that app.destroy is about to dispose. The looping node's own fiber is
      // the one makeRootFiber keeps recycling, so the reported component is
      // the one actually stuck in the loop.
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
      // A render is marked EXECUTED while it runs, so that writing a value it
      // already read schedules a re-render. A value the last render read and
      // this one has not read yet does not: runTracked leaves that link stale
      // until the render reads it again (and drops it if it does not).
      node.signalComputation.state = ComputationState.EXECUTED;
      node.previousMemos = node.memos;
      node.memos = null;
      const outerCollection = memoSuspend();
      this.phase = FiberPhase.RENDERING;
      const start = debug.fiber ? debugNow() : -1;
      // the error is handled while the render is still the current
      // computation, as onError handlers have always run
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
          // the pass failed: the renders it delayed wait for the frame that
          // drops it, after its handlers had their chance to re-render
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
  // the fibers of this pass whose render, onWillStart or onWillUpdateProps
  // failed: the pass stays failed until none of them is current
  failed: Set<Fiber> | null = null;

  // only add stuff in this if they have registered some hooks
  willPatch: Fiber[] = [];
  patched: Fiber[] = [];
  mounted: Fiber[] = [];
  // A fiber is typically locked when it is completing and the patch has not, or is being applied.
  // i.e.: render triggered in onWillUnmount or in willPatch will be delayed
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
      // Step 1: calling all willPatch lifecycle hooks
      for (current of this.willPatch) {
        // because of the asynchronous nature of the rendering, some parts of the
        // UI may have been rendered, then deleted in a followup rendering, and we
        // do not want to call onWillPatch in that case.
        let node = current.node;
        if (node.fiber === current) {
          const component = node.component;
          for (let cb of node.willPatch) {
            cb.call(component);
          }
        }
      }
      current = undefined;

      // Step 2: patching the dom
      node._patch();
      this.locked = false;
    } catch (e) {
      // the pass never reached the document: none of its onMounted runs, and
      // neither does the onWillUnmount of a component it would have mounted
      for (let fiber of this.mounted) {
        fiber.node.willUnmount = [];
      }
      this.locked = false;
      handleError({ fiber: current || this, error: e });
      return;
    }

    // Step 3: calling all mounted, then all patched lifecycle hooks
    const failed = callCommitHooks(this.mounted, "mounted");
    if (failed !== null) {
      callCommitHooks(this.patched, "patched", failed);
    }
  }

  setCounter(newValue: number) {
    this.counter = newValue;
    if (newValue === 0) {
      this.node.app.scheduler.flush();
    }
  }
}

// The onWillUnmount hooks of a component skipped by a failed commit, held
// until the commit of the recovering render calls its onMounted.
const deferredWillUnmount = new WeakMap<ComponentNode, Function[]>();

/**
 * Calls the onMounted (or onPatched) hooks of the fibers a commit applied,
 * last registered first. A throwing hook is reported at once and the other
 * components' hooks still run, so one failure does not leave the rest of the
 * committed tree without its lifecycle (a Portal committing its content). The
 * failing chain (the fibers handleError marked) is skipped and kept in the
 * list, without onWillUnmount, for the commit of a recovering render. While an
 * error is reported, the components still waiting for onMounted have no
 * onWillUnmount, in case the error destroys the app.
 *
 * @returns null once an error destroyed the app, else whether a hook failed,
 * which the onPatched call takes as `failed`
 */
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
      if (mounting && node.willUnmount.length) {
        deferredWillUnmount.set(node, node.willUnmount);
        node.willUnmount = [];
      }
      skipped.push(current);
      continue;
    }
    if (!(current.renderState & APPLIED_TO_DOM) || node.status === STATUS.DESTROYED) {
      continue;
    }
    if (mounting) {
      const deferred = deferredWillUnmount.get(node);
      if (deferred) {
        deferredWillUnmount.delete(node);
        node.willUnmount = deferred;
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
  // If set, the bdom is inserted immediately before this node inside `target`
  // (ignoring `position`). Used by Suspense to anchor its sub-root next to
  // an in-template text node instead of requiring a dedicated wrapper.
  afterNode?: Node | null;
  // The target was attached when the mount was requested; a render phase that
  // outlives it (the target's container replaced meanwhile) mounts into it
  // anyway instead of failing. Used by Portal, which then looks its target up
  // again.
  allowDetached?: boolean;
}

export class MountFiber extends RootFiber {
  target: MountTarget | null;
  position: Position;
  afterNode: Node | null = null;
  allowDetached = false;
  // true once the render phase finishes (counter reaches 0), false again if
  // the root re-renders before its commit. If target is set at that point, we
  // mount immediately; otherwise we signal readiness via onPrepared and wait
  // for commit() to supply a target.
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
      // Prepare-only: the render phase is done, but no target has been
      // supplied yet. Signal readiness and let the scheduler drop this
      // fiber from its tasks — commit() will run _mount() when called.
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
    // Otherwise the render phase is still in flight. complete() will fire
    // when the counter reaches 0 and pick up the now-set target.
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
        // this is a complicated situation: if we mount a fiber with an existing
        // bdom, this means that this same fiber was already completed, mounted,
        // but a crash occurred in some mounted hook. Then, it was handled and
        // the new rendering is being applied.
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

      // unregistering the fiber before mounted since it can do another render
      // and that the current rendering is obviously completed
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
