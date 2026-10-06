import { debug, debugLog } from "@odoo/owl-core";
import type { VNode } from "./index";
import {
  characterDataRemove,
  nodeAppendChild,
  nodeGetFirstChild,
  nodeGetNextSibling,
  nodeInsertBefore,
  nodeSetTextContent,
} from "./dom";

// -----------------------------------------------------------------------------
// List Node
// -----------------------------------------------------------------------------

class VList {
  children: VNode[];
  anchor: Node | undefined;
  parentEl?: HTMLElement | undefined;

  constructor(children: VNode[]) {
    this.children = children;
  }

  mount(parent: HTMLElement, afterNode: Node | null) {
    const children = this.children;
    const _anchor = document.createTextNode("");
    this.anchor = _anchor;
    nodeInsertBefore.call(parent, _anchor, afterNode);
    const l = children.length;
    if (l) {
      const mount = children[0].mount;
      for (let i = 0; i < l; i++) {
        mount.call(children[i], parent, _anchor);
      }
    }

    this.parentEl = parent;
  }

  moveBeforeDOMNode(node: Node | null) {
    const children = this.children;
    for (let i = 0, l = children.length; i < l; i++) {
      children[i].moveBeforeDOMNode(node);
    }
    nodeInsertBefore.call(this.parentEl, this.anchor!, node);
  }

  moveBeforeVNode(other: VList | null, afterNode: Node | null) {
    if (other) {
      const next = other!.children[0];
      afterNode = (next ? next.firstNode() : other!.anchor) || null;
    }
    const children = this.children;
    for (let i = 0, l = children.length; i < l; i++) {
      children[i].moveBeforeVNode(null, afterNode);
    }
    nodeInsertBefore.call(this.parentEl, this.anchor!, afterNode);
  }

  patch(other: VList, withBeforeRemove: boolean) {
    if (this === other) {
      return;
    }
    const ch1 = this.children;
    const ch2: VNode[] = other.children;
    if (ch2.length === 0 && ch1.length === 0) {
      return;
    }
    this.children = ch2;
    const proto = ch2[0] || ch1[0];
    const {
      mount: cMount,
      patch: cPatch,
      remove: cRemove,
      beforeRemove,
      moveBeforeVNode: cMoveBefore,
      firstNode: cFirstNode,
    } = proto;

    const _anchor = this.anchor!;
    const parent = this.parentEl!;

    let startIdx1 = 0;
    let startIdx2 = 0;
    let startVn1 = ch1[0];
    let startVn2 = ch2[0];

    let endIdx1 = ch1.length - 1;
    let endIdx2 = ch2.length - 1;
    let endVn1 = ch1[endIdx1];
    let endVn2 = ch2[endIdx2];

    let mapping: Map<any, number> | undefined = undefined;

    while (startIdx1 <= endIdx1 && startIdx2 <= endIdx2) {
      // -------------------------------------------------------------------
      if (startVn1 === null) {
        startVn1 = ch1[++startIdx1];
        continue;
      }
      // -------------------------------------------------------------------
      if (endVn1 === null) {
        endVn1 = ch1[--endIdx1];
        continue;
      }
      // -------------------------------------------------------------------
      let startKey1 = startVn1.key;
      let startKey2 = startVn2.key;
      if (startKey1 === startKey2) {
        cPatch.call(startVn1, startVn2, withBeforeRemove);
        ch2[startIdx2] = startVn1;
        startVn1 = ch1[++startIdx1];
        startVn2 = ch2[++startIdx2];
        continue;
      }
      // -------------------------------------------------------------------
      let endKey1 = endVn1.key;
      let endKey2 = endVn2.key;
      if (endKey1 === endKey2) {
        cPatch.call(endVn1, endVn2, withBeforeRemove);
        ch2[endIdx2] = endVn1;
        endVn1 = ch1[--endIdx1];
        endVn2 = ch2[--endIdx2];
        continue;
      }
      // -------------------------------------------------------------------
      if (startKey1 === endKey2) {
        // bnode moved right
        cPatch.call(startVn1, endVn2, withBeforeRemove);
        ch2[endIdx2] = startVn1;
        const nextChild = ch2[endIdx2 + 1];
        cMoveBefore.call(startVn1, nextChild, _anchor);
        startVn1 = ch1[++startIdx1];
        endVn2 = ch2[--endIdx2];
        continue;
      }
      // -------------------------------------------------------------------
      if (endKey1 === startKey2) {
        // bnode moved left
        cPatch.call(endVn1, startVn2, withBeforeRemove);
        ch2[startIdx2] = endVn1;
        const nextChild = ch1[startIdx1];
        cMoveBefore.call(endVn1, nextChild, _anchor);
        endVn1 = ch1[--endIdx1];
        startVn2 = ch2[++startIdx2];
        continue;
      }
      // -------------------------------------------------------------------
      mapping = mapping || createMapping(ch1, startIdx1, endIdx1);
      let idxInOld = mapping.get(startKey2);
      // with repeated keys, the mapped child may already be taken: moved by
      // the mapping (null) or matched at an end of the range since
      if (
        idxInOld === undefined ||
        idxInOld < startIdx1 ||
        idxInOld > endIdx1 ||
        ch1[idxInOld] === null
      ) {
        cMount.call(startVn2, parent, cFirstNode.call(startVn1) || null);
      } else {
        const elmToMove = ch1[idxInOld];
        cMoveBefore.call(elmToMove, startVn1, null);
        cPatch.call(elmToMove, startVn2, withBeforeRemove);
        ch2[startIdx2] = elmToMove;
        ch1[idxInOld] = null as any;
        if (elmToMove === startVn1) {
          // only a NaN key misses the start match and is found by the map
          startVn1 = ch1[++startIdx1];
        }
      }
      startVn2 = ch2[++startIdx2];
    }
    // ---------------------------------------------------------------------
    if (startIdx1 <= endIdx1 || startIdx2 <= endIdx2) {
      if (startIdx1 > endIdx1) {
        const nextChild = ch2[endIdx2 + 1];
        const anchor = nextChild ? cFirstNode.call(nextChild) || null : _anchor;
        for (let i = startIdx2; i <= endIdx2; i++) {
          cMount.call(ch2[i], parent, anchor);
        }
      } else if (ch2.length === 0) {
        removeItems(ch1, _anchor, false, withBeforeRemove);
      } else {
        for (let i = startIdx1; i <= endIdx1; i++) {
          let ch = ch1[i];
          if (ch) {
            if (withBeforeRemove) {
              beforeRemove.call(ch);
            }
            cRemove.call(ch);
          }
        }
      }
    }
  }

  beforeRemove() {
    const children = this.children;
    const l = children.length;
    if (l) {
      const beforeRemove = children[0].beforeRemove;
      for (let i = 0; i < l; i++) {
        beforeRemove.call(children[i]);
      }
    }
  }

  remove() {
    const children = this.children;
    if (children.length) {
      removeItems(children, this.anchor!, true, false);
    } else {
      characterDataRemove.call(this.anchor!);
    }
  }

  firstNode(): Node | undefined {
    const child = this.children[0];
    // An empty list still occupies a position in the DOM: its anchor. Callers
    // use firstNode to locate a block (toggler key swaps, sibling mounts,
    // moves), so hiding the anchor would lose the position — e.g. a t-key
    // change on a component rendering an empty t-foreach used to crash here.
    // VMulti does the same with its slot anchors.
    return child ? child.firstNode() : this.anchor;
  }

  toString(): string {
    return this.children.map((c) => c!.toString()).join("");
  }
}

export function list(children: VNode[]): VNode<VList> {
  return new VList(children);
}

/**
 * Removes every item of a list (and its anchor, `withAnchor`), running each
 * item's beforeRemove first when asked. When the items, one node each, and
 * the anchor are all their parent holds, the parent is emptied at once
 * (textContent), and each item's remove() then finds its node detached: it
 * still unbinds its refs. Otherwise (an item of several nodes, or a node
 * someone else put before, after or among them: a Portal's content, a
 * widget's DOM) the items are removed one by one, which leaves what they do
 * not own in place. Ownership is checked again after the beforeRemove hooks,
 * which may change the DOM. (Deleting the items' range alone, with a Range,
 * costs Chromium as much as removing them one by one.)
 */
function removeItems(
  items: VNode[],
  anchor: Node,
  withAnchor: boolean,
  withBeforeRemove: boolean
): void {
  const l = items.length;
  const { beforeRemove, remove } = items[0];
  const parent = anchor.parentNode!;
  let owned = l > 1 && ownsParent(items, parent, anchor);
  if (owned && withBeforeRemove) {
    for (let i = 0; i < l; i++) {
      beforeRemove.call(items[i]);
    }
    withBeforeRemove = false;
    owned = ownsParent(items, parent, anchor);
  }
  if (owned) {
    if (debug.template) {
      debugLog("template", "list items removed at once: sole children");
    }
    nodeSetTextContent.call(parent, "");
    if (!withAnchor) {
      nodeAppendChild.call(parent, anchor);
    }
  } else if (l > 1 && debug.template) {
    debugLog("template", "list items removed one by one: not sole children");
  }
  for (let i = 0; i < l; i++) {
    const item = items[i];
    if (withBeforeRemove) {
      beforeRemove.call(item);
    }
    remove.call(item);
  }
  if (withAnchor && !owned) {
    characterDataRemove.call(anchor);
  }
}

// Whether the items, in order and one node each, then the anchor, are every
// child of `parent`. An item of several nodes breaks the sequence at its
// second node, a node someone else put there at itself.
function ownsParent(items: VNode[], parent: Node, anchor: Node): boolean {
  const firstNode = items[0].firstNode;
  let node: Node | null = nodeGetFirstChild.call(parent);
  for (let i = 0, l = items.length; i < l; i++) {
    if (node !== firstNode.call(items[i]) || node === null) {
      return false;
    }
    node = nodeGetNextSibling.call(node);
  }
  return node === anchor && nodeGetNextSibling.call(anchor) === null;
}

function createMapping(ch1: VNode[], startIdx1: number, endIdx1: number): Map<any, number> {
  const mapping = new Map<any, number>();
  for (let i = startIdx1; i <= endIdx1; i++) {
    mapping.set(ch1[i].key, i);
  }
  return mapping;
}
