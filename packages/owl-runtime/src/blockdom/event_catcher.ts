import { debug, debugLog, eventModifierMask } from "@odoo/owl-core";
import { config, type HandlerFn } from "./config";
import { nodeInsertBefore } from "./dom";
import { createEventHandler } from "./events";
import type { VNode } from "./index";

type EventsSpec = { [name: string]: number };

// a catcher's handlers are static, given with the spec; what a render gives
// it is its child and the context of its handlers
type Catcher = (child: VNode, ctx: any) => VNode;

type EventHandler = ReturnType<typeof createEventHandler>;

// A catcher listens on its parent element, which outlives it, with one
// listener per kind of listener (event name, capture, passive, synthetic) per
// parent, however many catchers of however many sites (createCatcher calls) and
// event keys that parent holds: a t-foreach of components with t-on costs one
// listener, and the catchers of every site are dispatched by one walk,
// innermost first, as the event would bubble through their elements, whatever
// .stop, .prevent or .self their keys add (those apply per handler). At
// dispatch, the catcher owning the target is found from the end anchors of the
// parent's children.
interface ParentListener {
  handler: EventHandler;
  count: number;
}

const listenersByParent = new WeakMap<Node, Map<string, ParentListener>>();

// the catcher whose child ends at an end anchor, of any site
const byEnd = new WeakMap<Node, VCatcherBase>();

// the catchers whose mount or patch is running: one mounted meanwhile in the
// same parent element is nested in the innermost of them (a component with
// several roots holding another one)
const updating: VCatcherBase[] = [];

// the listener an event key needs: the modifiers a native or synthetic
// listener is created with, in a fixed order
function listenerKey(key: string): string {
  const mods = key.split(".");
  let id = mods[0];
  for (const m of ["capture", "passive", "synthetic"]) {
    if (mods.includes(m)) {
      id += "." + m;
    }
  }
  return id;
}

interface CatcherHandler {
  fn: HandlerFn | null;
  mods: number;
}

interface VCatcherBase {
  // listener key -> the handlers it dispatches to
  groups: Map<string, CatcherHandler[]>;
  ctx: any;
  parentEl?: HTMLElement;
  // the catcher enclosing this one in the same parent element, of any site;
  // undefined until found (see outerOf)
  outer: VCatcherBase | null | undefined;
  child: VNode;
  afterNode: Text | null;
}

// A catcher mounted by a render of its own (a component re-rendering alone)
// has no enclosing catcher in the mounts running: it finds it from the DOM at
// its first dispatch. Not at mount: that render is still patching the
// enclosing catcher's child (the branch holding this catcher is not all in it
// yet), so the first node of that child cannot be read.
function outerOf(catcher: VCatcherBase): VCatcherBase | null {
  if (catcher.outer === undefined) {
    // the enclosing catcher, from the nodes around it
    const first = catcher.child.firstNode();
    catcher.outer = first ? ownerOf(first, catcher.afterNode!.nextSibling) : null;
    if (debug.event) {
      debugLog("event", `catcher found its outer one at dispatch: ${!!catcher.outer}`);
    }
  }
  return catcher.outer;
}

// Each listener reads the latest handler data at dispatch, and applies its
// modifiers only to an event from inside a child: the listener sits on the
// parent, which the children share with their siblings. The child's root node
// holding the target stands for the current target (what .self compares the
// target with): the parent is not the child's.
function dispatch(key: string, parent: Node, ev: Event) {
  let node = ev.target as Node | null;
  while (node && node.parentNode !== parent) {
    node = node.parentNode;
  }
  if (!node) {
    return;
  }
  for (let catcher = ownerOf(node, node); catcher; catcher = outerOf(catcher)) {
    const handlers = catcher.groups.get(key);
    if (handlers) {
      for (const { fn, mods } of handlers) {
        config.mainEventHandler(fn, mods, catcher.ctx, ev, node);
      }
    }
  }
}

// The first end anchor after the node closes the innermost catcher holding it,
// or one that starts after it, nested in the same catchers as the node: then
// its first enclosing catcher holding the node is the one.
function ownerOf(node: Node, from: Node | null): VCatcherBase | null {
  for (let n = from; n; n = n.nextSibling) {
    let catcher = byEnd.get(n) || null;
    if (catcher) {
      while (catcher && !holds(catcher, node)) {
        catcher = outerOf(catcher);
      }
      return catcher;
    }
  }
  return null;
}

function holds(catcher: VCatcherBase, node: Node): boolean {
  // the end anchor bounds it: only its start is compared
  const first = catcher.child.firstNode();
  return (
    !!first &&
    (first === node || !!(first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
  );
}

function listen(keys: string[], parent: HTMLElement) {
  let listeners = listenersByParent.get(parent);
  if (!listeners) {
    listenersByParent.set(parent, (listeners = new Map()));
  }
  for (const key of keys) {
    const listener = listeners.get(key);
    if (listener) {
      listener.count++;
      continue;
    }
    const handler = createEventHandler(key, { fn: 0, ctx: 0, arg: -1 });
    // the parent is the context: the runtime handler passes it on
    handler.setup.call(parent, {
      data: [parent],
      handlers: [(p: Node, ev: Event) => dispatch(key, p, ev)],
    });
    listeners.set(key, { handler, count: 1 });
  }
}

function unlisten(keys: string[], parent: HTMLElement) {
  const listeners = listenersByParent.get(parent)!;
  for (const key of keys) {
    const listener = listeners.get(key)!;
    if (--listener.count === 0) {
      listener.handler.remove.call(parent);
      listeners.delete(key);
    }
  }
}

export function createCatcher(eventsSpec: EventsSpec, fns: (HandlerFn | null)[]): Catcher {
  const groups = new Map<string, CatcherHandler[]>();
  for (const key in eventsSpec) {
    const id = listenerKey(key);
    let handlers = groups.get(id);
    if (!handlers) {
      groups.set(id, (handlers = []));
    }
    handlers.push({ fn: fns[eventsSpec[key]], mods: eventModifierMask(key) });
  }
  const keys = [...groups.keys()];

  class VCatcher implements VCatcherBase {
    child: VNode;
    groups = groups;
    ctx: any;
    outer: VCatcherBase | null | undefined = undefined;

    parentEl?: HTMLElement | undefined;
    afterNode: Text | null = null;

    constructor(child: VNode, ctx: any) {
      this.child = child;
      this.ctx = ctx;
    }

    mount(parent: HTMLElement, afterNode: Node | null) {
      this.parentEl = parent;
      const end = (this.afterNode = document.createTextNode(""));
      nodeInsertBefore.call(parent, end, afterNode);
      byEnd.set(end, this);
      for (let i = updating.length - 1; i >= 0; i--) {
        if (updating[i].parentEl === parent) {
          this.outer = updating[i];
          break;
        }
      }
      updating.push(this);
      try {
        this.child.mount(parent, end);
      } finally {
        updating.pop();
      }
      listen(keys, parent);
    }

    moveBeforeDOMNode(node: Node | null) {
      this.child.moveBeforeDOMNode(node);
      nodeInsertBefore.call(this.parentEl, this.afterNode!, node);
    }

    moveBeforeVNode(other: VCatcher | null, afterNode: Node | null) {
      if (other) {
        afterNode = other.firstNode() || afterNode;
      }
      this.child.moveBeforeVNode(other ? other.child : null, afterNode);
      nodeInsertBefore.call(this.parentEl, this.afterNode!, afterNode);
    }

    patch(other: VCatcher, withBeforeRemove: boolean) {
      if (this === other) {
        return;
      }
      this.ctx = other.ctx;
      updating.push(this);
      try {
        this.child.patch(other.child, withBeforeRemove);
      } finally {
        updating.pop();
      }
    }

    beforeRemove() {
      this.child.beforeRemove();
    }

    remove() {
      unlisten(keys, this.parentEl!);
      this.child.remove();
      this.afterNode!.remove();
    }

    firstNode(): Node | undefined {
      return this.child.firstNode();
    }

    toString(): string {
      return this.child.toString();
    }
  }

  return function (child: VNode, ctx: any): VNode<VCatcher> {
    return new VCatcher(child, ctx);
  };
}
