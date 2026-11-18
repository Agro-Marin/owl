import type { VNode } from "./index";
import { nodeInsertBefore } from "./dom";

class VHtml {
  html: string;
  parentEl?: HTMLElement | undefined;
  content: ChildNode[] = [];

  constructor(html: string | String) {
    this.html = String(html);
  }

  mount(parent: HTMLElement, afterNode: Node | null) {
    this.parentEl = parent;
    this.content = insertHtml(parent, this.html, afterNode);
  }

  moveBeforeDOMNode(node: Node | null) {
    const parent = this.parentEl;
    for (let elem of this.content) {
      nodeInsertBefore.call(parent, elem, node);
    }
  }

  moveBeforeVNode(other: VHtml | null, afterNode: Node | null) {
    const target = other ? other.content[0] : afterNode;
    this.moveBeforeDOMNode(target);
  }

  patch(other: VHtml) {
    if (this === other) {
      return;
    }
    const html2 = other.html;
    if (this.html !== html2) {
      const content = insertHtml(this.parentEl!, html2, this.content[0]);
      this.remove();
      this.content = content;
      this.html = html2;
    }
  }

  beforeRemove() {}

  remove() {
    for (let elem of this.content) {
      elem.remove();
    }
  }

  detachRefs() {}

  firstNode(): Node {
    return this.content[0]!;
  }

  toString() {
    return this.html;
  }
}

function insertHtml(parent: HTMLElement, html: string, afterNode: Node | null): ChildNode[] {
  const template = document.createElement("template");
  template.innerHTML = html;
  const content: ChildNode[] = [...template.content.childNodes];
  if (!content.length) {
    content.push(document.createTextNode(""));
  }
  for (const node of content) {
    nodeInsertBefore.call(parent, node, afterNode);
  }
  return content;
}

export function html(str: string | String): VNode<VHtml> {
  return new VHtml(str);
}
