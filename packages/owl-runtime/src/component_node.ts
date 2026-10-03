import {
  ComputationAtom,
  ComputationState,
  createComputation,
  disposeComputation,
  getCurrentComputation,
  OwlError,
  Scope,
  scopeStack,
  setComputation,
  untrack,
  useScope,
} from "@odoo/owl-core";
import type { App } from "./app";
import { BDom, RefCallback, VNode } from "./blockdom";
import { Component, ComponentConstructor } from "./component";
import { fibersInError, handleError, handleHookRejection } from "./rendering/error_handling";
import { APPLIED_TO_DOM, Fiber, FiberPhase, makeRootFiber, MountFiber } from "./rendering/fibers";
import { STATUS } from "./status";

// -----------------------------------------------------------------------------
//  Component VNode class
// -----------------------------------------------------------------------------

type LifecycleHook = Function;

export class ComponentNode extends Scope implements VNode<ComponentNode> {
  fiber: Fiber | null = null;
  component!: Component;
  bdom: BDom | null = null;
  componentName: string;
  forceNextRender: boolean = false;
  parentKey: string | null;
  props: Record<string, any>;
  defaultProps: Record<string, any> | null = null;
  renderFn!: Function;
  parent: ComponentNode | null;
  children: { [key: string]: ComponentNode } = Object.create(null);

  willUpdateProps: LifecycleHook[] = [];
  // Fired right after `props` is applied to `node.props` on a parent re-render,
  // so reactive prop notifications happen once the new values are observable
  // (after user `onWillUpdateProps` hooks, including async ones, have run).
  propsUpdated: LifecycleHook[] = [];
  willUnmount: LifecycleHook[] = [];
  mounted: LifecycleHook[] = [];
  willPatch: LifecycleHook[] = [];
  patched: LifecycleHook[] = [];
  signalComputation: ComputationAtom;
  // t-refs bound to an element hosted by this component: a signal mapped to its
  // atom (so the element can be read without subscribing), a set-like ref to
  // the elements this component added to it. Swept by isConnected after each
  // patch and after this subtree is removed, to unbind a ref from a
  // bulk-removed element (slot host, enclosing t-if, cleared list) — see
  // sweepRefs.
  trackedRefs: Map<any, { value: HTMLElement | null } | Set<HTMLElement>> | null = null;
  refCallbacks: WeakMap<object, RefCallback> | null = null;

  constructor(
    C: ComponentConstructor,
    props: Record<string, any>,
    app: App,
    parent: ComponentNode | null,
    parentKey: string | null
  ) {
    super(app);
    this.parent = parent;
    this.parentKey = parentKey;
    this.pluginManager = parent ? parent.pluginManager : app.pluginManager;
    this.componentName = C.name;
    this.signalComputation = createComputation(
      () => this.render(false),
      false,
      ComputationState.EXECUTED
    );
    this.props = props;
    const previousComputation = getCurrentComputation();
    setComputation(undefined);
    scopeStack.push(this);
    this.collectingWillStart = true;
    try {
      this.component = new C(this);
      const ctx = { this: this.component, __owl__: this };
      this.renderFn = app.getTemplate(C.template).bind(this.component, ctx, this);
      this.component.setup();
    } catch (e) {
      // nothing will ever reference this node: what its setup acquired is
      // released, and the setup error is the one reported
      this.finalize((cleanupError) => console.error(cleanupError));
      disposeComputation(this.signalComputation);
      throw e;
    } finally {
      this.collectingWillStart = false;
      scopeStack.pop();
      setComputation(previousComputation);
    }
  }

  decorate(f: Function, hookName: string): Function {
    const component = this.component;
    const scope = this;
    if (this.app.dev) {
      const name = `${this.componentName}.${hookName}`;
      // Create a named wrapper so the name appears in stack traces.
      // V8 uses computed property keys as inferred function names.
      const wrapper = {
        [name](...args: any[]) {
          return f.call(component, scope, ...args);
        },
      };
      return wrapper[name];
    }
    return f.bind(component, scope);
  }

  async initiateRender(fiber: Fiber | MountFiber) {
    this.fiber = fiber;
    if (this.mounted.length) {
      fiber.root!.mounted.push(fiber);
    }
    const component = this.component;
    try {
      await Promise.all(untrack(() => this.willStart.map((f) => f.call(component))));
    } catch (e) {
      handleHookRejection(this, e);
      return;
    }
    if (this.status === STATUS.NEW && this.fiber === fiber) {
      fiber.render();
    }
  }

  async render(deep: boolean) {
    if (this.status >= STATUS.DESTROYED) {
      return;
    }
    let current = this.fiber;
    if (current && (current.root!.locked || current.phase === FiberPhase.RENDERING)) {
      await Promise.resolve();
      // situation may have changed after the microtask tick
      current = this.fiber;
    }
    if (current) {
      if (current.phase === FiberPhase.NEW && !fibersInError.has(current)) {
        if (deep) {
          // we want the render from this point on to be with deep=true
          current.deep = deep;
        }
        return;
      }
      // if current rendering was with deep=true, we want this one to be the same
      deep = deep || current.deep;
    } else if (!this.bdom) {
      return;
    }

    const fiber = makeRootFiber(this);
    fiber.deep = deep;
    this.fiber = fiber;

    this.app.scheduler.addFiber(fiber);
    await Promise.resolve();
    if (this.status >= STATUS.DESTROYED) {
      return;
    }
    // We only want to actually render the component if the following two
    // conditions are true:
    // * this.fiber: it could be null, in which case the render has been cancelled
    // * (current || !fiber.parent): if current is not null, this means that the
    //   render function was called when a render was already occurring. In this
    //   case, the pending rendering was cancelled, and the fiber needs to be
    //   rendered to complete the work.  If current is null, we check that the
    //   fiber has no parent.  If that is the case, the fiber was downgraded from
    //   a root fiber to a child fiber in the previous microtick, because it was
    //   embedded in a rendering coming from above, so the fiber will be rendered
    //   in the next microtick anyway, so we should not render it again.
    if (this.fiber === fiber && (current || !fiber.parent)) {
      fiber.render();
    }
  }

  cancel() {
    delete this.parent!.children[this.parentKey!];
    this._destroy();
  }

  destroy() {
    let shouldRemove = this.status === STATUS.MOUNTED;
    removalDepth++;
    try {
      this._destroy();
    } finally {
      removalDepth--;
      if (shouldRemove) {
        this.bdom!.remove();
        sweepRemovedRefs();
      }
    }
  }

  _destroy() {
    const component = this.component;
    // a throwing onWillUnmount must not leave this subtree alive (still
    // MOUNTED, rendering, running its effects): the error is rethrown once the
    // destruction is complete
    let failure: { error: unknown } | null = null;
    if (this.status === STATUS.MOUNTED) {
      for (let cb of this.willUnmount) {
        try {
          cb.call(component);
        } catch (error) {
          failure ||= { error };
        }
      }
    }
    // While a removal is in progress, collect ref-bearing nodes on the way down
    // (we are walking the whole subtree anyway for willUnmount). They are swept
    // once their dom is detached, by whoever drives the outermost removal — see
    // sweepRemovedRefs. A removed component's own remove() is not always called
    // (a block can bulk-remove it), so it cannot be relied on to sweep itself.
    if (removalDepth && this.trackedRefs) {
      (removed ||= []).push(this);
    }
    for (let childKey in this.children) {
      try {
        this.children[childKey]._destroy();
      } catch (error) {
        failure ||= { error };
      }
    }
    // an error no handler catches destroys the app and is rethrown: the other
    // callbacks still run and the node is still finalized before it propagates
    this.finalize((e) => {
      try {
        handleError({ error: e, node: this });
      } catch (error) {
        failure ||= { error };
      }
    });
    disposeComputation(this.signalComputation);
    if (failure) {
      throw failure.error;
    }
  }

  /**
   * Unbind any tracked t-ref from the elements no longer in the document, and
   * stop tracking what is left unbound (its ref callback re-registers it when it
   * binds an element again). `isConnected` is the discriminator: a ref the
   * block's own remove() failed to unbind (bulk removal) points at a detached
   * element and is unbound, while a ref a surviving sibling just took over
   * (t-if/t-else with a shared signal) points at a still-connected element and
   * is left alone.
   *
   * Called after this component's dom settles: at the tail of `_patch` (before
   * user `onPatched`), so an element removed in place is caught, and — for the
   * nodes collected during `_destroy` — after a removed subtree is detached.
   */
  sweepRefs() {
    const refs = this.trackedRefs;
    if (!refs) {
      return;
    }
    for (const [ref, tracked] of refs) {
      if (tracked instanceof Set) {
        for (const el of tracked) {
          if (!el.isConnected) {
            ref.delete(el);
            tracked.delete(el);
          }
        }
        if (!tracked.size) {
          refs.delete(ref);
        }
        continue;
      }
      const el = tracked.value;
      if (!el) {
        refs.delete(ref);
      } else if (!el.isConnected) {
        ref.set(null);
        refs.delete(ref);
      }
    }
  }

  /**
   * Finds a child that has dom that is not yet updated, and update it. This
   * method is meant to be used only in the context of repatching the dom after
   * a mounted hook failed and was handled.
   */
  updateDom() {
    if (!this.fiber) {
      return;
    }
    if (this.bdom === this.fiber!.bdom) {
      // If the error was handled by some child component, we need to find it to
      // apply its change
      for (let k in this.children) {
        const child = this.children[k];
        child.updateDom();
      }
    } else {
      // if we get here, this is the component that handled the error and rerendered
      // itself, so we can simply patch the dom
      removalDepth++;
      try {
        this.bdom!.patch(this.fiber!.bdom, true);
      } finally {
        removalDepth--;
      }
      this.sweepRefs();
      sweepRemovedRefs();
      this.fiber!.renderState |= APPLIED_TO_DOM;
      this.fiber = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Block DOM methods
  // ---------------------------------------------------------------------------

  firstNode(): Node | undefined {
    const bdom = this.bdom;
    return bdom ? bdom.firstNode() : undefined;
  }

  mount(parent: HTMLElement, anchor: ChildNode) {
    const bdom = this.fiber!.bdom!;
    this.bdom = bdom;
    bdom.mount(parent, anchor);
    this.status = STATUS.MOUNTED;
    this.fiber!.renderState |= APPLIED_TO_DOM;
    this.children = this.fiber!.childrenMap;
    this.fiber = null;
  }

  moveBeforeDOMNode(node: Node | null): void {
    this.bdom!.moveBeforeDOMNode(node);
  }

  moveBeforeVNode(other: ComponentNode | null, afterNode: Node | null) {
    this.bdom!.moveBeforeVNode(other ? other.bdom : null, afterNode);
  }

  /**
   * Register a t-ref signal bound to an element this component hosts, so its
   * lifecycle can clear it (see sweepRefs / _destroy). Called each time the ref
   * binds an element; idempotent.
   */
  trackRef(ref: { set(v: null): void }, atom: { value: HTMLElement | null }) {
    (this.trackedRefs ||= new Map()).set(ref, atom);
  }

  /**
   * Register an element this component added to a set-like t-ref, or forget it
   * once its block removed it from the ref (`bound` false).
   */
  trackRefElement(ref: { delete(el: HTMLElement): void }, el: HTMLElement, bound: boolean) {
    const refs = (this.trackedRefs ||= new Map());
    let els = refs.get(ref) as Set<HTMLElement> | undefined;
    if (bound) {
      if (!els) {
        refs.set(ref, (els = new Set()));
      }
      els.add(el);
    } else if (els) {
      els.delete(el);
    }
  }

  patch() {
    if (this.fiber && this.fiber.parent) {
      // we only patch here renderings coming from above. renderings initiated
      // by the component will be patched independently in the appropriate
      // fiber.complete
      this._patch();
    }
  }
  _patch() {
    let hasChildren = false;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for (let _k in this.children) {
      hasChildren = true;
      break;
    }
    const fiber = this.fiber!;
    this.children = fiber.childrenMap;
    removalDepth++;
    try {
      this.bdom!.patch(fiber.bdom!, hasChildren);
    } finally {
      removalDepth--;
    }
    this.sweepRefs();
    sweepRemovedRefs();
    fiber.renderState |= APPLIED_TO_DOM;
    this.fiber = null;
  }

  beforeRemove() {
    this._destroy();
  }

  remove() {
    this.bdom!.remove();
  }
}

// While a removal is in progress (a component patch that drops a subtree, or a
// destroy), the ref-bearing nodes of the removed subtree(s) accumulate in this
// single global list, then get swept once their dom is detached. `removalDepth`
// counts how deeply removals are nested — removals re-enter, e.g. a Portal or
// Suspense destroys its sub-root from onWillDestroy mid-patch — and only the
// outermost one (depth back to 0) does the sweep, so a nested removal never
// clears the list out from under the one driving it. The list is lazy, so a
// patch that removes nothing allocates nothing.
let removalDepth = 0;
let removed: ComponentNode[] | null = null;

// Sweep the collected nodes if this is the outermost removal and anything was
// collected. Their dom is detached by now, so sweepRefs's isConnected check
// correctly unsets refs left dangling by a bulk removal.
function sweepRemovedRefs() {
  if (removalDepth === 0 && removed) {
    const nodes = removed;
    removed = null;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].sweepRefs();
    }
  }
}

/**
 * Returns the active scope narrowed to a ComponentNode, or throws.
 */
export function getComponentScope(): ComponentNode {
  const scope = useScope();
  if (!(scope instanceof ComponentNode)) {
    throw new OwlError("Expected to be in a component scope");
  }
  return scope;
}
