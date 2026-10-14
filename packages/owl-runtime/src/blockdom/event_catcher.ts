import { debug, debugLog, eventModifierMask } from "@odoo/owl-core";
import { config, type HandlerFn } from "./config";
import { nodeInsertBefore } from "./dom";
import { createEventHandler } from "./events";
import type { VNode } from "./index";

type EventsSpec = { [name: string]: number };

type Catcher = (child: VNode, ctx: any) => VNode;

type EventHandler = ReturnType<typeof createEventHandler>;

interface ParentListener {
  handler: EventHandler;
  count: number;
}

const listenersByParent = new WeakMap<Node, Map<string, ParentListener>>();

const byEnd = new WeakMap<Node, VCatcherBase>();

const updating: VCatcherBase[] = [];

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
  groups: Map<string, CatcherHandler[]>;
  ctx: any;
  parentEl?: HTMLElement;
  outer: VCatcherBase | null | undefined;
  child: VNode;
  afterNode: Text | null;
}

function outerOf(catcher: VCatcherBase): VCatcherBase | null {
  if (catcher.outer === undefined) {
    const first = catcher.child.firstNode();
    catcher.outer = first ? ownerOf(first, catcher.afterNode!.nextSibling) : null;
    if (debug.event) {
      debugLog("event", `catcher found its outer one at dispatch: ${!!catcher.outer}`);
    }
  }
  return catcher.outer;
}

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
