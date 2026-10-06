import type { VNode } from "./index";
import { characterDataRemove, characterDataSetData, nodeInsertBefore } from "./dom";

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
    characterDataRemove.call(this.el!);
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

  // its text, not markup: what an attribute or an interpolation of a t-set
  // body needs (t-att-title="label"), and what text(vtext) renders
  toString(): string {
    return "" + toText(this.text);
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
    case "bigint":
    case "symbol":
      return String(value);
    case "boolean":
      return value ? "true" : "false";
    default:
      return value || "";
  }
}
