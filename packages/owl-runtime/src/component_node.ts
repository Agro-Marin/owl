import {
  ComputationAtom,
  ComputationState,
  createComputation,
  debug,
  debugLog,
  disposeComputation,
  getCurrentComputation,
  OwlError,
  PluginManager,
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
import { APPLIED_TO_DOM, Fiber, FiberPhase, forgetOwed, makeRootFiber } from "./rendering/fibers";
import type { MemoSite } from "./rendering/memo";
import { STATUS } from "./status";

type LifecycleHook = Function;
export type PropsListener = { update(): void };
type HookKind =
  | "willUpdateProps"
  | "propsUpdated"
  | "willUnmount"
  | "mounted"
  | "willPatch"
  | "patched";

const NO_HOOKS: LifecycleHook[] = /* @__PURE__ */ Object.freeze([]) as any;

export class ComponentNode extends Scope<App> implements VNode<ComponentNode> {
  declare app: App;
  fiber: Fiber | null = null;
  component!: Component;
  bdom: BDom | null = null;
  componentName: string;
  forceNextRender: boolean = false;
  parentKey: string | null;
  props: Record<string, any>;
  defaultProps: Record<string, any> | null = null;
  renderFn!: () => BDom;
  parent: ComponentNode | null;
  childMap: Map<string, ComponentNode> | null = null;

  willUpdateProps: LifecycleHook[] = NO_HOOKS;
  propsUpdated: PropsListener[] = NO_HOOKS as any;
  willUnmount: LifecycleHook[] = NO_HOOKS;
  mounted: LifecycleHook[] = NO_HOOKS;
  willPatch: LifecycleHook[] = NO_HOOKS;
  patched: LifecycleHook[] = NO_HOOKS;
  signalComputation: ComputationAtom;
  trackedRefs: Map<any, { value: HTMLElement | null } | Set<HTMLElement>> | null = null;
  refCallbacks: WeakMap<object, RefCallback> | null = null;
  memos: Map<string, MemoSite> | null = null;
  previousMemos: Map<string, MemoSite> | null = null;

  constructor(
    C: ComponentConstructor,
    props: Record<string, any>,
    app: App,
    parent: ComponentNode | null,
    parentKey: string | null,
    pluginManager?: PluginManager
  ) {
    super(app);
    this.parent = parent;
    this.parentKey = parentKey;
    this.pluginManager = pluginManager ?? (parent ? parent.pluginManager : app.pluginManager);
    this.componentName = C.name;
    this.signalComputation = createComputation(
      () => this.render(false),
      false,
      ComputationState.EXECUTED,
      false,
      debug.reactivity || debug.effect ? `render ${C.name}` : ""
    );
    this.signalComputation.tracksElsewhere = true;
    if (debug.lifecycle) {
      debugLog(
        "lifecycle",
        `setup ${C.name}${parent ? ` (child of ${parent.componentName})` : " (root)"}`
      );
    }
    this.props = props;
    const previousComputation = getCurrentComputation();
    setComputation(undefined);
    scopeStack.push(this);
    this.collectingWillStart = true;
    try {
      const component = new C(this);
      this.component = component;
      this.renderFn = app
        .getTemplate(C.template)
        .bind(component, { this: component, __owl__: this }, this);
      component.setup();
    } catch (e) {
      this.finalize((cleanupError) => console.error(cleanupError));
      disposeComputation(this.signalComputation);
      throw e;
    } finally {
      this.collectingWillStart = false;
      scopeStack.pop();
      setComputation(previousComputation);
    }
  }

  get children(): { [key: string]: ComponentNode } {
    return this.childMap ? Object.fromEntries(this.childMap) : {};
  }

  addHook<K extends HookKind>(kind: K, fn: this[K][number], first = false) {
    const hooks: any[] = this[kind];
    if (hooks === NO_HOOKS) {
      (this as any)[kind] = [fn];
    } else if (first) {
      hooks.unshift(fn);
    } else {
      hooks.push(fn);
    }
  }

  decorate(f: Function, hookName: string): Function {
    const component = this.component;
    const scope = this;
    if (this.app.dev) {
      const name = `${this.componentName}.${hookName}`;
      const wrapper = {
        [name](...args: any[]) {
          return f.call(component, scope, ...args);
        },
      };
      return wrapper[name];
    }
    return f.bind(component, scope);
  }

  start(fiber: Fiber) {
    this.fiber = fiber;
    if (this.mounted.length) {
      fiber.root!.mounted.push(fiber);
    }
    if (this.willStart.length) {
      this.awaitWillStart(fiber);
    } else {
      fiber.render();
    }
  }

  private async awaitWillStart(fiber: Fiber) {
    const component = this.component;
    if (debug.lifecycle) {
      debugLog("lifecycle", `willStart ${this.componentName}: ${this.willStart.length} hook(s)`);
    }
    const hooks = this.willStart.splice(0);
    try {
      await Promise.all(untrack(() => hooks.map((f) => f.call(component))));
    } catch (e) {
      handleHookRejection(this, fiber, e);
      return;
    }
    if (debug.lifecycle) {
      debugLog("lifecycle", `willStart ${this.componentName} settled`);
    }
    if (this.fiber === fiber) {
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
      current = this.fiber;
    }
    if (current) {
      if (current.phase === FiberPhase.NEW && !fibersInError.has(current)) {
        if (deep) {
          current.deep = deep;
        }
        const root = current.root!;
        if (root !== current && this.bdom) {
          const merged = (root.merged ||= []);
          if (!merged.includes(current)) {
            merged.push(current);
          }
        }
        return;
      }
      deep = deep || current.deep;
    } else if (!this.bdom) {
      return;
    }

    const fiber = makeRootFiber(this);
    if (!fiber) {
      current!.deep ||= deep;
      return;
    }
    fiber.deep = deep;
    this.fiber = fiber;

    this.app.scheduler.addFiber(fiber);
    await Promise.resolve();
    if (this.status >= STATUS.DESTROYED) {
      return;
    }
    if (this.fiber === fiber) {
      fiber.render();
    }
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
    if (this.status === STATUS.DESTROYED) {
      return;
    }
    const component = this.component;
    const fiber = this.fiber;
    this.fiber = null;
    if (fiber !== null) {
      this.app.scheduler.forget(fiber);
    }
    let failure: { error: unknown } | null = null;
    if (debug.lifecycle) {
      debugLog(
        "lifecycle",
        `destroy ${this.componentName}${this.status === STATUS.MOUNTED ? `, ${this.willUnmount.length} willUnmount` : " (never mounted)"}`
      );
    }
    if (this.status === STATUS.MOUNTED) {
      for (let cb of this.willUnmount) {
        try {
          cb.call(component);
        } catch (error) {
          failure ||= { error };
        }
      }
    }
    forgetOwed(this);
    if (removalDepth && this.trackedRefs) {
      (removed ||= []).push(this);
    }
    for (const child of this.childMap?.values() || []) {
      try {
        child._destroy();
      } catch (error) {
        failure ||= { error };
      }
    }
    for (const child of fiber?.childrenMap?.values() || []) {
      try {
        child._destroy();
      } catch (error) {
        failure ||= { error };
      }
    }
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
    this.childMap = this.fiber!.childrenMap;
    this.fiber = null;
  }

  moveBeforeDOMNode(node: Node | null): void {
    this.bdom!.moveBeforeDOMNode(node);
  }

  moveBeforeVNode(other: ComponentNode | null, afterNode: Node | null) {
    this.bdom!.moveBeforeVNode(other ? other.bdom : null, afterNode);
  }

  trackRef(ref: { set(v: null): void }, atom: { value: HTMLElement | null }) {
    (this.trackedRefs ||= new Map()).set(ref, atom);
  }

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
      this._patch();
    }
  }
  _patch(withBeforeRemove: boolean = !!this.childMap?.size) {
    const fiber = this.fiber!;
    this.childMap = fiber.childrenMap;
    removalDepth++;
    try {
      this.bdom!.patch(fiber.bdom!, withBeforeRemove);
    } catch (e) {
      if (removalDepth === 1 && removalErrors) {
        reportRemovalErrors();
      }
      throw e;
    } finally {
      removalDepth--;
    }
    this.sweepRefs();
    sweepRemovedRefs();
    fiber.renderState |= APPLIED_TO_DOM;
    this.fiber = null;
    if (removalDepth === 0 && removalErrors) {
      reportRemovalErrors();
    }
  }

  beforeRemove() {
    try {
      this._destroy();
    } catch (error) {
      if (debug.error) {
        debugLog("error", `${this.componentName}: removal error held until the patch is done`);
      }
      (removalErrors ||= []).push({ node: this, error });
    }
  }

  remove() {
    this.bdom!.remove();
  }
}

let removalDepth = 0;
let removed: ComponentNode[] | null = null;
let removalErrors: { node: ComponentNode; error: unknown }[] | null = null;

function reportRemovalErrors() {
  const errors = removalErrors!;
  removalErrors = null;
  for (const params of errors) {
    handleError(params);
  }
}

function sweepRemovedRefs() {
  if (removalDepth === 0 && removed) {
    const nodes = removed;
    removed = null;
    for (let i = 0; i < nodes.length; i++) {
      nodes[i].sweepRefs();
    }
  }
}

export function getComponentScope(): ComponentNode {
  const scope = useScope();
  if (!(scope instanceof ComponentNode)) {
    throw new OwlError("Expected to be in a component scope");
  }
  return scope;
}
