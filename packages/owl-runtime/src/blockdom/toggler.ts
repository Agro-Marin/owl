import { nodeInsertBefore, nodeRemoveChild } from "./dom";
import type { VNode } from "./index";

const txt = /* @__PURE__ */ globalThis.document?.createTextNode("")!;

class VToggler {
  kind: unknown;
  child: VNode;

  constructor(kind: unknown, child: VNode) {
    this.kind = kind;
    this.child = child;
  }

  mount(parent: HTMLElement, afterNode: Node | null) {
    this.child.mount(parent, afterNode);
  }

  moveBeforeDOMNode(node: Node | null) {
    this.child.moveBeforeDOMNode(node);
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
      const parent = firstNode.parentNode as HTMLElement;
      nodeInsertBefore.call(parent, txt, firstNode);
      if (withBeforeRemove) {
        child1.beforeRemove();
      }
      child1.remove();
      child2.mount(parent, txt);
      nodeRemoveChild.call(parent, txt);
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

  detachRefs() {
    this.child.detachRefs();
  }

  firstNode(): Node | undefined {
    return this.child.firstNode();
  }

  toString(): string {
    return this.child.toString();
  }
}

export function toggler(kind: unknown, child: VNode): VNode<VToggler> {
  return new VToggler(kind, child);
}
