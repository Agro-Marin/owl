// The DOM methods blockdom calls, read once from the prototypes. Unset where
// there is no DOM.
export let nodeCloneNode: typeof Node.prototype.cloneNode;
export let nodeInsertBefore: typeof Node.prototype.insertBefore;
export let nodeAppendChild: typeof Node.prototype.appendChild;
export let nodeRemoveChild: typeof Node.prototype.removeChild;
export let nodeSetTextContent: (v: string) => void;
export let characterDataSetData: (v: string) => void;
export let nodeGetFirstChild: () => ChildNode | null;
export let nodeGetNextSibling: () => ChildNode | null;
if (typeof Node !== "undefined") {
  const nodeProto = Node.prototype;
  const getDescriptor = (o: object, p: string) => Object.getOwnPropertyDescriptor(o, p)!;
  nodeCloneNode = nodeProto.cloneNode;
  nodeInsertBefore = nodeProto.insertBefore;
  nodeAppendChild = nodeProto.appendChild;
  nodeRemoveChild = nodeProto.removeChild;
  nodeSetTextContent = getDescriptor(nodeProto, "textContent").set!;
  characterDataSetData = getDescriptor(CharacterData.prototype, "data").set!;
  nodeGetFirstChild = getDescriptor(nodeProto, "firstChild").get!;
  nodeGetNextSibling = getDescriptor(nodeProto, "nextSibling").get!;
}
