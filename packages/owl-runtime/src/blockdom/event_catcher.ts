import { config } from "./config";
import { createEventHandler } from "./events";
import type { VNode } from "./index";

type EventsSpec = { [name: string]: number };

type Catcher = (child: VNode, handlers: any[]) => VNode;

// A catcher listens on its parent element, which outlives it. A list or multi
// that is its parent's only child clears that parent with textContent = ""
// instead of removing each child, so the catchers it held never run remove():
// the clear releases them from here.
const catchersByParent = new WeakMap<Node, Set<{ releaseHandlers(): void }>>();

export function releaseCatchers(parent: Node) {
  const catchers = catchersByParent.get(parent);
  if (catchers) {
    catchersByParent.delete(parent);
    for (const catcher of catchers) {
      catcher.releaseHandlers();
    }
  }
}

export function createCatcher(eventsSpec: EventsSpec): Catcher {
  const n = Object.keys(eventsSpec).length;

  class VCatcher {
    child: VNode;
    handlerData: any[];
    handlerFns: any[] = [];

    parentEl?: HTMLElement | undefined;
    afterNode: Text | null = null;

    constructor(child: VNode, handlers: any[]) {
      this.child = child;
      this.handlerData = handlers;
    }

    mount(parent: HTMLElement, afterNode: Node | null) {
      this.parentEl = parent;
      this.child.mount(parent, afterNode);
      this.afterNode = document.createTextNode("");
      parent.insertBefore(this.afterNode, afterNode);
      for (let name in eventsSpec) {
        const index = eventsSpec[name];
        const handler = createEventHandler(name);
        this.handlerFns[index] = handler;
        handler.setup.call(parent, [this.makeDispatcher(index), null]);
      }
      let catchers = catchersByParent.get(parent);
      if (!catchers) {
        catchersByParent.set(parent, (catchers = new Set()));
      }
      catchers.add(this);
    }

    releaseHandlers() {
      for (let i = 0; i < n; i++) {
        this.handlerFns[i].remove.call(this.parentEl!);
      }
    }

    // Registered once per event, it reads the latest handler data at dispatch,
    // and applies its modifiers only to an event from inside the child: the
    // listener sits on the parent, which the child shares with its siblings.
    // The child's root node holding the target stands for the current target
    // (what .self compares the target with): the parent is not the child's.
    makeDispatcher(index: number) {
      return (_: null, ev: Event) => {
        const target = ev.target as Node;
        const afterNode = this.afterNode;
        let currentNode: Node | null | undefined = this.child.firstNode();
        while (currentNode && currentNode !== afterNode) {
          if (currentNode.contains(target)) {
            config.mainEventHandler(this.handlerData[index], ev, currentNode);
            return;
          }
          currentNode = currentNode.nextSibling;
        }
      };
    }

    moveBeforeDOMNode(node: Node | null) {
      this.child.moveBeforeDOMNode(node);
      this.parentEl!.insertBefore(this.afterNode!, node);
    }

    moveBeforeVNode(other: VCatcher | null, afterNode: Node | null) {
      if (other) {
        afterNode = other.firstNode() || afterNode;
      }
      this.child.moveBeforeVNode(other ? other.child : null, afterNode);
      this.parentEl!.insertBefore(this.afterNode!, afterNode);
    }

    patch(other: VCatcher, withBeforeRemove: boolean) {
      if (this === other) {
        return;
      }
      this.handlerData = other.handlerData;
      this.child.patch(other.child, withBeforeRemove);
    }

    beforeRemove() {
      this.child.beforeRemove();
    }

    remove() {
      this.releaseHandlers();
      catchersByParent.get(this.parentEl!)?.delete(this);
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
