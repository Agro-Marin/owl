import {
  debug,
  debugLog,
  EventModifier,
  eventModifierMask,
  HANDLER_MODIFIERS,
} from "@odoo/owl-core";
import { config, type HandlerFn } from "./config";
import { nodeInsertBefore } from "./dom";
import { createEventHandler, type HandlerOwner } from "./events";
import type { VNode } from "./index";

type EventsSpec = { [name: string]: number };

type Catcher = (child: VNode, ctx: any) => VNode;

interface ListenerKind {
  id: string;
  capture: boolean;
  listen(parent: HTMLElement, passive: boolean): void;
  unlisten(parent: HTMLElement, passive: boolean): void;
}

interface ParentListener {
  count: number;
  passive: boolean;
}

interface SiteKind {
  kind: ListenerKind;
  passive: boolean;
}

const kinds = new Map<string, ListenerKind>();

const listenersByParent = new WeakMap<Node, Map<ListenerKind, ParentListener>>();

const byEnd = new WeakMap<Node, VCatcherBase>();

const updating: VCatcherBase[] = [];

function kindOf(key: string, mask: number): ListenerKind {
  let id = key.split(".")[0];
  if (mask & EventModifier.CAPTURE) {
    id += ".capture";
  }
  if (mask & EventModifier.SYNTHETIC) {
    id += ".synthetic";
  }
  let kind = kinds.get(id);
  if (!kind) {
    kind = makeKind(id, mask);
    kinds.set(id, kind);
  }
  return kind;
}

function makeKind(id: string, mask: number): ListenerKind {
  const capture = !!(mask & EventModifier.CAPTURE);
  if (mask & EventModifier.SYNTHETIC) {
    const creators: ReturnType<typeof createEventHandler>[] = [];
    const creator = (passive: boolean) =>
      (creators[+passive] ||= createEventHandler(passive ? id + ".passive" : id, {
        fn: 0,
        ctx: 0,
        arg: -1,
      }));
    const handlers = [(parent: Node, ev: Event) => dispatch(kind, parent, ev)];
    const kind: ListenerKind = {
      id,
      capture,
      listen(parent, passive) {
        const owner: HandlerOwner = { data: [parent], handlers };
        creator(passive).setup.call(parent, owner);
      },
      unlisten(parent, passive) {
        creator(passive).remove.call(parent);
      },
    };
    return kind;
  }
  const name = id.split(".")[0];
  const passiveOptions = { capture, passive: true };
  const listener = (ev: Event) => {
    const parent = ev.currentTarget as Node | null;
    if (parent && parent.isConnected) {
      dispatch(kind, parent, ev);
    }
  };
  const kind: ListenerKind = {
    id,
    capture,
    listen(parent, passive) {
      parent.addEventListener(name, listener, passive ? passiveOptions : capture);
    },
    unlisten(parent) {
      parent.removeEventListener(name, listener, capture);
    },
  };
  return kind;
}

interface CatcherHandler {
  fn: HandlerFn | null;
  mods: number;
  passive: boolean;
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

function dispatch(kind: ListenerKind, parent: Node, ev: Event) {
  let node = ev.target as Node | null;
  while (node && node.parentNode !== parent) {
    node = node.parentNode;
  }
  if (!node) {
    return;
  }
  const chain: VCatcherBase[] = [];
  for (let catcher = ownerOf(node, node); catcher; catcher = outerOf(catcher)) {
    if (catcher.groups.has(kind.id)) {
      chain.push(catcher);
    }
  }
  if (chain.length === 1) {
    const handlers = chain[0].groups.get(kind.id)!;
    if (handlers.length === 1) {
      runHandler(handlers[0], chain[0].ctx, ev, node);
      return;
    }
  } else if (!chain.length) {
    return;
  }
  let stopped = false;
  let stoppedImmediately = false;
  const ownStop = Object.hasOwn(ev, "stopPropagation");
  const ownStopImmediate = Object.hasOwn(ev, "stopImmediatePropagation");
  const stopPropagation = ev.stopPropagation;
  const stopImmediatePropagation = ev.stopImmediatePropagation;
  ev.stopPropagation = function () {
    stopped = true;
    stopPropagation.call(this);
  };
  ev.stopImmediatePropagation = function () {
    stoppedImmediately = true;
    stopImmediatePropagation.call(this);
  };
  try {
    const l = chain.length;
    for (let i = 0; i < l; i++) {
      const catcher = chain[kind.capture ? l - 1 - i : i];
      for (const handler of catcher.groups.get(kind.id)!) {
        runHandler(handler, catcher.ctx, ev, node);
        if (stoppedImmediately) {
          return;
        }
      }
      if (stopped && i < l - 1) {
        if (debug.event) {
          debugLog("event", `${ev.type}: stopped at catcher ${i + 1} of ${l}`);
        }
        return;
      }
    }
  } finally {
    restore(ev, "stopPropagation", ownStop, stopPropagation);
    restore(ev, "stopImmediatePropagation", ownStopImmediate, stopImmediatePropagation);
  }
}

function restore(ev: any, name: string, own: boolean, value: any) {
  if (own) {
    ev[name] = value;
  } else {
    delete ev[name];
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

function listen(siteKinds: SiteKind[], parent: HTMLElement) {
  let listeners = listenersByParent.get(parent);
  if (!listeners) {
    listenersByParent.set(parent, (listeners = new Map()));
  }
  for (const { kind, passive } of siteKinds) {
    const listener = listeners.get(kind);
    if (!listener) {
      kind.listen(parent, passive);
      listeners.set(kind, { count: 1, passive });
      continue;
    }
    listener.count++;
    if (!passive && listener.passive) {
      if (debug.event) {
        debugLog(
          "event",
          `${kind.id}: passive catcher listener replaced, a handler may prevent the default`
        );
      }
      kind.unlisten(parent, true);
      kind.listen(parent, false);
      listener.passive = false;
    }
  }
}

function unlisten(siteKinds: SiteKind[], parent: HTMLElement) {
  const listeners = listenersByParent.get(parent)!;
  for (const { kind } of siteKinds) {
    const listener = listeners.get(kind)!;
    if (--listener.count === 0) {
      kind.unlisten(parent, listener.passive);
      listeners.delete(kind);
    }
  }
}

function ignore() {}

function runHandler(handler: CatcherHandler, ctx: any, ev: Event, node: Node) {
  if (handler.passive && !Object.hasOwn(ev, "preventDefault")) {
    ev.preventDefault = ignore;
    try {
      config.mainEventHandler(handler.fn, handler.mods, ctx, ev, node);
    } finally {
      delete (ev as any).preventDefault;
    }
  } else {
    config.mainEventHandler(handler.fn, handler.mods, ctx, ev, node);
  }
}

export function createCatcher(eventsSpec: EventsSpec, fns: (HandlerFn | null)[]): Catcher {
  const groups = new Map<string, CatcherHandler[]>();
  const siteKinds: SiteKind[] = [];
  for (const key in eventsSpec) {
    const mask = eventModifierMask(key);
    const kind = kindOf(key, mask);
    const passive = !!(mask & EventModifier.PASSIVE);
    let handlers = groups.get(kind.id);
    if (!handlers) {
      groups.set(kind.id, (handlers = []));
      siteKinds.push({ kind, passive });
    } else if (!passive) {
      siteKinds.find((k) => k.kind === kind)!.passive = false;
    }
    handlers.push({ fn: fns[eventsSpec[key]], mods: mask & HANDLER_MODIFIERS, passive });
  }

  class VCatcher implements VCatcherBase {
    child: VNode;
    declare groups: Map<string, CatcherHandler[]>;
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
      listen(siteKinds, parent);
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
      unlisten(siteKinds, this.parentEl!);
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

  VCatcher.prototype.groups = groups;

  return function (child: VNode, ctx: any): VNode<VCatcher> {
    return new VCatcher(child, ctx);
  };
}
