import { debug, debugLog } from "@odoo/owl-core";
import { nodeInsertBefore, nodeRemoveChild } from "./dom";
import type { VNode } from "./index";
import { VList } from "./list";
import { VMulti } from "./multi";

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
    if (this.kind === other.kind) {
      this.child.patch(other.child, withBeforeRemove);
    } else {
      this.replace(other, withBeforeRemove);
    }
  }

  replace(other: VToggler, withBeforeRemove: boolean) {
    const child1 = this.child;
    const child2 = other.child;
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

class VShapeToggler extends VToggler {
  patch(other: VShapeToggler, withBeforeRemove: boolean) {
    if (this === other) {
      return;
    }
    if (sameShape(this.child, other.child)) {
      this.child.patch(other.child, withBeforeRemove);
    } else {
      if (debug.template) {
        debugLog(
          "template",
          "a given block of another shape is mounted in place of the previous one"
        );
      }
      this.replace(other, withBeforeRemove);
    }
  }
}

function sameShape(a: VNode, b: VNode): boolean {
  if (a.constructor !== b.constructor) {
    return false;
  }
  if (a instanceof VMulti) {
    const children1 = a.children;
    const children2 = (b as VMulti).children;
    if (children1.length !== children2.length) {
      return false;
    }
    for (let i = 0; i < children1.length; i++) {
      const vn1 = children1[i];
      const vn2 = children2[i];
      if (vn1 && vn2 && !sameShape(vn1, vn2)) {
        return false;
      }
    }
    return true;
  }
  if (a instanceof VList) {
    const item1 = a.children[0];
    const item2 = (b as VList).children[0];
    return !item1 || !item2 || sameShape(item1, item2);
  }
  return true;
}

export function shapeToggler(child: VNode): VNode<VToggler> {
  return new VShapeToggler(null, child);
}
