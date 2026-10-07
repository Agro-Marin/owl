// The DOM methods blockdom calls, read once from the prototypes. Unset where
// there is no DOM.
export function fromDom<T>(read: () => T): T {
  return typeof Node === "undefined" ? (undefined as T) : read();
}
const descriptor = (o: object, p: string) => Object.getOwnPropertyDescriptor(o, p)!;

export const nodeCloneNode = /* @__PURE__ */ fromDom(() => Node.prototype.cloneNode);
export const nodeInsertBefore = /* @__PURE__ */ fromDom(() => Node.prototype.insertBefore);
export const nodeAppendChild = /* @__PURE__ */ fromDom(() => Node.prototype.appendChild);
export const nodeRemoveChild = /* @__PURE__ */ fromDom(() => Node.prototype.removeChild);
// a text node removes itself, and does nothing once detached
export const characterDataRemove = /* @__PURE__ */ fromDom(() => CharacterData.prototype.remove);
export const nodeSetTextContent: (v: string) => void = /* @__PURE__ */ fromDom(
  () => descriptor(Node.prototype, "textContent").set!
);
export const characterDataSetData: (v: string) => void = /* @__PURE__ */ fromDom(
  () => descriptor(CharacterData.prototype, "data").set!
);
export const nodeGetFirstChild: () => ChildNode | null = /* @__PURE__ */ fromDom(
  () => descriptor(Node.prototype, "firstChild").get!
);
export const nodeGetNextSibling: () => ChildNode | null = /* @__PURE__ */ fromDom(
  () => descriptor(Node.prototype, "nextSibling").get!
);
