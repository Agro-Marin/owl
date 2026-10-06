import { config } from "./config";
import { nodeInsertBefore } from "./dom";
import { createEventHandler } from "./events";
import type { VNode } from "./index";

type EventsSpec = { [name: string]: number };

type Catcher = (child: VNode, handlers: any[]) => VNode;

type EventHandler = ReturnType<typeof createEventHandler>;

// A catcher listens on its parent element, which outlives it, with one
// listener per event key (name and modifiers) per parent, however many catchers
// of however many sites (createCatcher calls) that parent holds: a t-foreach of
// components with t-on costs one listener, and the catchers of every site are
// dispatched by one walk, innermost first, as the event would bubble through
// their elements. At dispatch, the catcher owning the target is found from the
// end anchors of the parent's children.
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
const updating: { parent: Node; catcher: VCatcherBase }[] = [];

interface VCatcherBase {
  // event key -> index of its handler data
  spec: EventsSpec;
  handlerData: any[];
  // the catcher enclosing this one in the same parent element, of any site
  outer: VCatcherBase | null;
  holds(node: Node): boolean;
}

// A list that is its parent's only child clears that parent with
// textContent = "" instead of removing each child, so the catchers it held
// never run remove(): the clear releases their listeners from here.
export function releaseCatchers(parent: Node) {
  const listeners = listenersByParent.get(parent);
  if (listeners) {
    listenersByParent.delete(parent);
    for (const { handler } of listeners.values()) {
      handler.remove.call(parent as HTMLElement);
    }
  }
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
  for (let catcher = ownerOf(node, node); catcher; catcher = catcher.outer) {
    const index = catcher.spec[key];
    if (index !== undefined) {
      config.mainEventHandler(catcher.handlerData[index], ev, node);
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
      while (catcher && !catcher.holds(node)) {
        catcher = catcher.outer;
      }
      return catcher;
    }
  }
  return null;
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
    const handler = createEventHandler(key);
    // the parent is the context: the runtime handler passes it on
    handler.setup.call(parent, [(p: Node, ev: Event) => dispatch(key, p, ev), parent]);
    listeners.set(key, { handler, count: 1 });
  }
}

function unlisten(keys: string[], parent: HTMLElement) {
  const listeners = listenersByParent.get(parent);
  if (!listeners) {
    // released in bulk already
    return;
  }
  for (const key of keys) {
    const listener = listeners.get(key)!;
    if (--listener.count === 0) {
      listener.handler.remove.call(parent);
      listeners.delete(key);
    }
  }
}

export function createCatcher(eventsSpec: EventsSpec): Catcher {
  const keys = Object.keys(eventsSpec);

  class VCatcher implements VCatcherBase {
    child: VNode;
    spec = eventsSpec;
    handlerData: any[];
    outer: VCatcherBase | null = null;

    parentEl?: HTMLElement | undefined;
    afterNode: Text | null = null;

    constructor(child: VNode, handlers: any[]) {
      this.child = child;
      this.handlerData = handlers;
    }

    mount(parent: HTMLElement, afterNode: Node | null) {
      this.parentEl = parent;
      const end = (this.afterNode = document.createTextNode(""));
      nodeInsertBefore.call(parent, end, afterNode);
      byEnd.set(end, this);
      for (let i = updating.length - 1; i >= 0; i--) {
        if (updating[i].parent === parent) {
          this.outer = updating[i].catcher;
          break;
        }
      }
      updating.push({ parent, catcher: this });
      try {
        this.child.mount(parent, end);
      } finally {
        updating.pop();
      }
      if (!this.outer) {
        // mounted by a render of its own (a component re-rendering alone):
        // an enclosing catcher is complete, found after the end anchor
        this.outer = ownerOf(this.child.firstNode()!, end.nextSibling);
      }
      listen(keys, parent);
    }

    holds(node: Node): boolean {
      // the end anchor bounds it: only its start is compared
      const first = this.child.firstNode();
      return (
        !!first &&
        (first === node ||
          !!(first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING))
      );
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
      this.handlerData = other.handlerData;
      updating.push({ parent: this.parentEl!, catcher: this });
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

  return function (child: VNode, handlers: any[]): VNode<VCatcher> {
    return new VCatcher(child, handlers);
  };
}
