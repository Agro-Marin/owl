import type { VNode } from "./index";

// -----------------------------------------------------------------------------
// Toggler node
// -----------------------------------------------------------------------------

// Shared anchor text node, reused across togglers. Accessed through
// `globalThis` and optional-chained so that merely importing owl does not
// crash without a `document`: this lets the non-rendering APIs (reactivity,
// type system, ...) run in environments such as Node.js. It is only ever read
// in `patch`, which runs while rendering into a real DOM, so the `!` holds.
const txt = globalThis.document?.createTextNode("")!;

class VToggler {
  // not `key`: a toggler in a keyed list gets its list key written there
  kind: string;
  child: VNode;

  constructor(kind: string, child: VNode) {
    this.kind = kind;
    this.child = child;
  }

  mount(parent: HTMLElement, afterNode: Node | null) {
    this.child.mount(parent, afterNode);
  }

  moveBeforeDOMNode(node: Node | null, parent?: HTMLElement) {
    this.child.moveBeforeDOMNode(node, parent);
  }

  moveBeforeVNode(other: VToggler | null, afterNode: Node | null) {
    this.moveBeforeDOMNode((other && other.firstNode()) || afterNode);
  }

  patch(other: VToggler, withBeforeRemove: boolean) {
    if (this === other) {
      return;
    }
    let child1 = this.child;
    let child2 = other.child;
    if (this.kind === other.kind) {
      child1.patch(child2, withBeforeRemove);
    } else {
      const firstNode = child1.firstNode()!;
      // a ShadowRoot parent is a node, not an element
      const parent = firstNode.parentNode as HTMLElement;
      parent.insertBefore(txt, firstNode);
      if (withBeforeRemove) {
        child1.beforeRemove();
      }
      // remove before mounting: a ref the new child sets must not be cleared by
      // the old child's removal
      child1.remove();
      child2.mount(parent, txt);
      parent.removeChild(txt);
      this.child = child2;
      this.kind = other.kind;
    }
  }

  beforeRemove() {
    this.child.beforeRemove();
  }

  remove() {
    this.child.remove();
  }

  firstNode(): Node | undefined {
    return this.child.firstNode();
  }

  toString(): string {
    return this.child.toString();
  }
}

export function toggler(kind: string, child: VNode): VNode<VToggler> {
  return new VToggler(kind, child);
}
