import type { VNode } from "./index";
import { characterDataSetData, nodeInsertBefore, nodeRemoveChild } from "./dom";

class VText {
  text: string | String;
  parentEl?: HTMLElement | undefined;
  el?: any;

  constructor(text: string | String) {
    this.text = text;
  }

  mount(parent: HTMLElement, afterNode: Node | null) {
    this.parentEl = parent;
    const node = document.createTextNode(toText(this.text));
    nodeInsertBefore.call(parent, node, afterNode);
    this.el = node;
  }

  moveBeforeDOMNode(node: Node | null) {
    nodeInsertBefore.call(this.parentEl, this.el!, node);
  }

  moveBeforeVNode(other: VText | null, afterNode: Node | null) {
    nodeInsertBefore.call(this.parentEl, this.el!, other ? other.el! : afterNode);
  }

  beforeRemove() {}

  remove() {
    nodeRemoveChild.call(this.parentEl, this.el!);
  }

  firstNode(): Node {
    return this.el!;
  }

  patch(other: VText) {
    const text2 = other.text;
    if (this.text !== text2) {
      characterDataSetData.call(this.el!, toText(text2));
      this.text = text2;
    }
  }

  toString() {
    return this.text;
  }
}

export function text(str: string | String): VNode<VText> {
  return new VText(str);
}

export function toText(value: any): string {
  switch (typeof value) {
    case "string":
      return value;
    case "number":
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      return value || "";
  }
}
