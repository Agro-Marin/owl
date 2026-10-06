import { config } from "./config";
import { nodeInsertBefore } from "./dom";
import { createEventHandler } from "./events";
import type { VNode } from "./index";

type EventsSpec = { [name: string]: number };

type Catcher = (child: VNode, handlers: any[]) => VNode;

type EventHandler = ReturnType<typeof createEventHandler>;

// What one catcher site (one createCatcher call) shares between its instances:
// a single listener per event on each parent element, however many instances
// that parent holds (a t-foreach of components with t-on). At dispatch, the
// instance owning the target is found from the end anchors of the parent's
// children.
interface CatcherSite {
  handlers: EventHandler[];
  // the instances of this site living in each parent element
  counts: WeakMap<Node, number>;
}

// A catcher listens on its parent element, which outlives it. A list that is
// its parent's only child clears that parent with textContent = "" instead of
// removing each child, so the catchers it held never run remove(): the clear
// releases their listeners from here.
const sitesByParent = new WeakMap<Node, Set<CatcherSite>>();

function release(site: CatcherSite, parent: Node) {
  for (const handler of site.handlers) {
    handler.remove.call(parent as HTMLElement);
  }
  site.counts.delete(parent);
}

export function releaseCatchers(parent: Node) {
  const sites = sitesByParent.get(parent);
  if (sites) {
    sitesByParent.delete(parent);
    for (const site of sites) {
      release(site, parent);
    }
  }
}

// the catchers whose mount or patch is running: one mounted meanwhile in the
// same parent element, by the same site, is nested in it (a recursive
// component with several roots)
const updating: { site: CatcherSite; parent: Node; catcher: any }[] = [];

export function createCatcher(eventsSpec: EventsSpec): Catcher {
  const names = Object.keys(eventsSpec);
  // the instance of this site whose child ends at an end anchor
  const byEnd = new WeakMap<Node, VCatcher>();
  let site: CatcherSite | null = null;

  // Each listener reads the latest handler data at dispatch, and applies its
  // modifiers only to an event from inside a child: the listener sits on the
  // parent, which the children share with their siblings. The child's root
  // node holding the target stands for the current target (what .self
  // compares the target with): the parent is not the child's.
  function dispatch(index: number, parent: Node, ev: Event) {
    let node = ev.target as Node | null;
    while (node && node.parentNode !== parent) {
      node = node.parentNode;
    }
    if (!node) {
      return;
    }
    let catcher = ownerOf(node);
    while (catcher) {
      config.mainEventHandler(catcher.handlerData[index], ev, node);
      catcher = catcher.outer;
    }
  }

  // The first end anchor of this site after the node closes the innermost
  // instance holding it, or one that starts after it, nested in the same
  // instances as the node: then its first enclosing instance holding the node
  // is the one.
  function ownerOf(node: Node, from: Node | null = node): VCatcher | null {
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

  function getSite(): CatcherSite {
    if (!site) {
      site = {
        handlers: names.map((name) => createEventHandler(name)),
        counts: new WeakMap(),
      };
    }
    return site;
  }

  function listen(site: CatcherSite, parent: HTMLElement) {
    const count = site.counts.get(parent) || 0;
    site.counts.set(parent, count + 1);
    if (count) {
      return;
    }
    for (const name of names) {
      const index = eventsSpec[name];
      // the parent is the context: the runtime handler passes it on
      site.handlers[index].setup.call(parent, [
        (p: Node, ev: Event) => dispatch(index, p, ev),
        parent,
      ]);
    }
    let sites = sitesByParent.get(parent);
    if (!sites) {
      sitesByParent.set(parent, (sites = new Set()));
    }
    sites.add(site);
  }

  function unlisten(site: CatcherSite, parent: HTMLElement) {
    const count = site.counts.get(parent);
    if (count === undefined) {
      // released in bulk already
      return;
    }
    if (count > 1) {
      site.counts.set(parent, count - 1);
    } else {
      release(site, parent);
      sitesByParent.get(parent)?.delete(site);
    }
  }

  class VCatcher {
    child: VNode;
    handlerData: any[];
    // the instance of this site enclosing this one in the same parent
    outer: VCatcher | null = null;

    parentEl?: HTMLElement | undefined;
    afterNode: Text | null = null;

    constructor(child: VNode, handlers: any[]) {
      this.child = child;
      this.handlerData = handlers;
    }

    mount(parent: HTMLElement, afterNode: Node | null) {
      const site = getSite();
      this.parentEl = parent;
      const end = (this.afterNode = document.createTextNode(""));
      nodeInsertBefore.call(parent, end, afterNode);
      byEnd.set(end, this);
      for (let i = updating.length - 1; i >= 0; i--) {
        const entry = updating[i];
        if (entry.site === site && entry.parent === parent) {
          this.outer = entry.catcher;
          break;
        }
      }
      updating.push({ site, parent, catcher: this });
      try {
        this.child.mount(parent, end);
      } finally {
        updating.pop();
      }
      if (!this.outer) {
        // mounted by a render of its own (a component re-rendering alone):
        // an enclosing instance is complete, found after the end anchor
        this.outer = ownerOf(this.child.firstNode()!, end.nextSibling);
      }
      listen(site, parent);
    }

    holds(node: Node): boolean {
      const first = this.child.firstNode()!;
      return (
        first === node || !!(first.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
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
      updating.push({ site: site!, parent: this.parentEl!, catcher: this });
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
      unlisten(site!, this.parentEl!);
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
