import { debug, debugLog, eventModifierMask } from "@odoo/owl-core";
import { config, type HandlerFn } from "./config";

// What an element holds for each of its handlers is their owner, read at
// dispatch: a block owns its handlers, its data holding their contexts (and
// arguments) and its handlers their code, both replaced as a whole by a patch.
// A handler's slot says where in its owner it finds them; its modifiers come
// from its key.
export interface HandlerOwner {
  data?: any[];
  handlers: readonly (HandlerFn | null)[];
}

export interface HandlerSlot {
  // index of the code in the owner's handlers
  fn: number;
  // index of the context in the owner's data
  ctx: number;
  // index of the extra argument (t-model's model) in the owner's data, -1 if none
  arg: number;
}

interface EventHandlerCreator {
  setup: (this: HTMLElement, owner: HandlerOwner) => void;
  remove: (this: HTMLElement) => void;
}

export function createEventHandler(rawEvent: string, slot: HandlerSlot): EventHandlerCreator {
  const eventName = rawEvent.split(".")[0];
  const capture = rawEvent.includes(".capture");
  const passive = rawEvent.includes(".passive");
  const mods = eventModifierMask(rawEvent);
  if (rawEvent.includes(".synthetic")) {
    return createSyntheticHandler(eventName, capture, passive, slot, mods);
  } else {
    return createElementHandler(eventName, capture, passive, slot, mods);
  }
}

function dispatchTo(
  owner: HandlerOwner,
  slot: HandlerSlot,
  mods: number,
  ev: Event,
  currentTarget: EventTarget
) {
  const data = owner.data!;
  const arg = slot.arg < 0 ? undefined : data[slot.arg];
  config.mainEventHandler(owner.handlers[slot.fn], mods, data[slot.ctx], ev, currentTarget, arg);
}

// Native listener
let nextNativeEventId = 1;
function createElementHandler(
  evName: string,
  capture: boolean,
  passive: boolean,
  slot: HandlerSlot,
  mods: number
): EventHandlerCreator {
  const eventKey = `__event__${evName}_${nextNativeEventId++}${capture ? "_capture" : ""}`;

  function listener(ev: Event) {
    const currentTarget = ev.currentTarget as any;
    // isConnected crosses any number of shadow roots
    if (!currentTarget || !currentTarget.isConnected) return;
    dispatchTo(currentTarget[eventKey], slot, mods, ev, currentTarget);
  }

  // a dictionary costs the browser twice a boolean to read, on every element:
  // only a passive listener needs one (an element is never window, document or
  // body, the targets where an unspecified passive defaults to true)
  const options: AddEventListenerOptions | boolean = passive ? { capture, passive } : capture;

  function setup(this: HTMLElement, owner: HandlerOwner) {
    (this as any)[eventKey] = owner;
    this.addEventListener(evName, listener, options);
  }

  function remove(this: HTMLElement) {
    delete (this as any)[eventKey];
    this.removeEventListener(evName, listener, options);
  }

  return { setup, remove };
}

// Synthetic handler: a form of event delegation that allows placing only one
// listener per event type. An element holds the handlers of each event and
// phase under the event key, passive or not, by id, each saying where the
// element holds its owner.
interface SyntheticHandler {
  slot: HandlerSlot;
  mods: number;
  ownerKey: string;
  passive: boolean;
}

let nextSyntheticEventId = 1;
function createSyntheticHandler(
  evName: string,
  capture: boolean,
  passive: boolean,
  slot: HandlerSlot,
  mods: number
): EventHandlerCreator {
  // one replay serves the passive handlers and the others: two would each
  // follow the path, the second after the first, past a stop in the first
  const eventKey = `__event__synthetic_${evName}${capture ? "_capture" : ""}`;
  setupSyntheticEvent(evName, eventKey, capture, passive);
  const currentId = nextSyntheticEventId++;
  const ownerKey = `__event__synthetic_owner_${currentId}`;
  const handler: SyntheticHandler = { slot, mods, ownerKey, passive };
  function setup(this: HTMLElement, owner: HandlerOwner) {
    ((this as any)[eventKey] ||= {})[currentId] = handler;
    (this as any)[ownerKey] = owner;
  }

  function remove(this: HTMLElement) {
    // other handlers (a sibling component's catcher) may share this element
    delete (this as any)[eventKey]?.[currentId];
    delete (this as any)[ownerKey];
  }

  return { setup, remove };
}

function ignore() {}

// The nodes of the path a root's listener replays: those between it and the
// previous root that listens (none: from the target). The event reaches each
// root with its target retargeted to that root's tree, as a native listener
// on its nodes would see it, and a node in a closed shadow root is not in the
// path the document sees. Every node, when the document is the only root.
function replayedRange(path: EventTarget[], root: EventTarget | null): [number, number] {
  if (!syntheticRootRefs.length) {
    return [0, path.length - 1];
  }
  let start = 0;
  for (let i = 0; i < path.length; i++) {
    const node = path[i];
    if (node === document || syntheticRoots.has(node as Node)) {
      if (node === root) {
        return [start, i - 1];
      }
      start = i + 1;
    }
  }
  return [0, -1];
}

// Replays the propagation over the path fixed at dispatch time, as the browser
// does for native listeners: in phase order (outermost first when capturing),
// past a node a handler removed, and stopping where a handler stopped
// propagation: after the node's other handlers, or at once when it stopped it
// immediately. The event's stopImmediatePropagation is shadowed for the replay
// only, to learn about that call (the flag it sets is not readable); a direct
// Event.prototype call goes unnoticed. A passive handler's preventDefault is
// shadowed too, while it runs: the listener is not passive when another
// handler of the event is not.
function nativeToSyntheticEvent(eventKey: string, capture: boolean, event: Event) {
  const path = event.composedPath();
  const [first, last] = replayedRange(path, event.currentTarget);
  if (last < first) {
    return;
  }
  if (debug.event && syntheticRootRefs.length) {
    debugLog(
      "event",
      `${event.type}: replayed by its ${(event.currentTarget as Node).nodeName} over ${last - first + 1} of the ${path.length} nodes of its path`
    );
  }
  let stoppedImmediately = false;
  const shadowed = Object.hasOwn(event, "stopImmediatePropagation");
  const stopImmediatePropagation = event.stopImmediatePropagation;
  event.stopImmediatePropagation = function () {
    stoppedImmediately = true;
    stopImmediatePropagation.call(this);
  };
  try {
    for (let i = first; i <= last; i++) {
      const node = path[capture ? last + first - i : i] as any;
      const handlers = node[eventKey];
      if (!handlers || !node.isConnected) {
        continue;
      }
      for (const id in handlers) {
        const { slot, mods, ownerKey, passive } = handlers[id] as SyntheticHandler;
        if (passive && !Object.hasOwn(event, "preventDefault")) {
          event.preventDefault = ignore;
          try {
            dispatchTo(node[ownerKey], slot, mods, event, node);
          } finally {
            delete (event as any).preventDefault;
          }
        } else {
          dispatchTo(node[ownerKey], slot, mods, event, node);
        }
        if (stoppedImmediately) {
          return;
        }
      }
      if (event.cancelBubble) {
        return;
      }
    }
  } finally {
    if (shadowed) {
      event.stopImmediatePropagation = stopImmediatePropagation;
    } else {
      delete (event as any).stopImmediatePropagation;
    }
  }
}

export const SYNTHETIC_LISTENER = Symbol.for("owl.syntheticListener");

interface SyntheticEvent {
  evName: string;
  capture: boolean;
  // until a handler that is not passive needs the event
  passive: boolean;
  listener: (event: Event) => void;
}

// One listener per synthetic event key on every root an app is mounted in:
// the document, and each shadow root or other document, which an event that
// is not composed (change, submit, reset...) never leaves.
const syntheticEvents = new Map<string, SyntheticEvent>();
const syntheticRoots = new WeakSet<Node>();
const syntheticRootRefs: WeakRef<Node>[] = [];

function roots(): Node[] {
  const result: Node[] = [document];
  for (const ref of syntheticRootRefs) {
    const root = ref.deref();
    if (root) {
      result.push(root);
    }
  }
  return result;
}

function listenOn(root: Node, event: SyntheticEvent) {
  const { capture, passive } = event;
  root.addEventListener(event.evName, event.listener, { capture, passive });
}

function setupSyntheticEvent(evName: string, eventKey: string, capture: boolean, passive: boolean) {
  const existing = syntheticEvents.get(eventKey);
  if (existing) {
    if (existing.passive && !passive) {
      // a passive listener cannot prevent the default: listen again
      if (debug.event) {
        debugLog(
          "event",
          `${eventKey}: passive listener replaced, a handler may prevent the default`
        );
      }
      for (const root of roots()) {
        root.removeEventListener(evName, existing.listener, capture);
      }
      existing.passive = false;
      for (const root of roots()) {
        listenOn(root, existing);
      }
    }
    return;
  }
  const listener = (event: Event) => nativeToSyntheticEvent(eventKey, capture, event);
  // registered once for the page's lifetime: a harness that removes the
  // listeners a test left behind must recognize this one and keep it
  (listener as any)[SYNTHETIC_LISTENER] = true;
  const syntheticEvent: SyntheticEvent = { evName, capture, passive, listener };
  syntheticEvents.set(eventKey, syntheticEvent);
  for (const root of roots()) {
    listenOn(root, syntheticEvent);
  }
}

/**
 * Makes the synthetic handlers of what is mounted in `target` reachable when
 * its root is a shadow root or another document than the global one.
 */
export function addSyntheticRoot(target: Node) {
  const root = target.getRootNode();
  if (
    root === document ||
    syntheticRoots.has(root) ||
    !(root instanceof ShadowRoot || root.nodeType === Node.DOCUMENT_NODE)
  ) {
    return;
  }
  syntheticRoots.add(root);
  syntheticRootRefs.push(new WeakRef(root));
  for (const syntheticEvent of syntheticEvents.values()) {
    listenOn(root, syntheticEvent);
  }
}
