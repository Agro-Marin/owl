import { eventModifierMask } from "@odoo/owl-core";
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
  const fn = owner.handlers[slot.fn];
  if (slot.arg < 0) {
    config.mainEventHandler(fn, mods, data[slot.ctx], ev, currentTarget);
  } else {
    config.mainEventHandler(fn, mods, data[slot.ctx], ev, currentTarget, data[slot.arg]);
  }
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
  let eventKey = `__event__${evName}_${nextNativeEventId++}`;
  if (capture) {
    eventKey = `${eventKey}_capture`;
  }

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
// listener per event type. An element holds the handlers of each key under the
// event key, by id, each saying where the element holds its owner.
interface SyntheticHandler {
  slot: HandlerSlot;
  mods: number;
  ownerKey: string;
}

let nextSyntheticEventId = 1;
function createSyntheticHandler(
  evName: string,
  capture: boolean,
  passive: boolean,
  slot: HandlerSlot,
  mods: number
): EventHandlerCreator {
  // one document listener per key: a passive one cannot serve preventDefault
  let eventKey = `__event__synthetic_${evName}`;
  if (capture) {
    eventKey = `${eventKey}_capture`;
  }
  if (passive) {
    eventKey = `${eventKey}_passive`;
  }
  setupSyntheticEvent(evName, eventKey, capture, passive);
  const currentId = nextSyntheticEventId++;
  const ownerKey = `__event__synthetic_owner_${currentId}`;
  const handler: SyntheticHandler = { slot, mods, ownerKey };
  function setup(this: HTMLElement, owner: HandlerOwner) {
    const handlers = (this as any)[eventKey] || {};
    handlers[currentId] = handler;
    (this as any)[eventKey] = handlers;
    (this as any)[ownerKey] = owner;
  }

  function remove(this: HTMLElement) {
    // other handlers (a sibling component's catcher) may share this element
    delete (this as any)[eventKey]?.[currentId];
    delete (this as any)[ownerKey];
  }

  return { setup, remove };
}

// Replays the propagation over the path fixed at dispatch time, as the browser
// does for native listeners: in phase order (outermost first when capturing),
// through open shadow roots, past a node a handler removed, and stopping where
// a handler stopped propagation: after the node's other handlers, or at once
// when it stopped it immediately. The event's stopImmediatePropagation is
// shadowed for the replay only, to learn about that call (the flag it sets is
// not readable); a direct Event.prototype call goes unnoticed.
function nativeToSyntheticEvent(
  eventKey: string,
  capture: boolean,
  replayed: WeakSet<Event> | null,
  event: Event
) {
  // a root listener and the document's both see an event crossing the root
  if (replayed) {
    if (replayed.has(event)) {
      return;
    }
    replayed.add(event);
  }
  const path = event.composedPath();
  const last = path.length - 1;
  let stoppedImmediately = false;
  const shadowed = Object.hasOwn(event, "stopImmediatePropagation");
  const stopImmediatePropagation = event.stopImmediatePropagation;
  event.stopImmediatePropagation = function () {
    stoppedImmediately = true;
    stopImmediatePropagation.call(this);
  };
  try {
    for (let i = 0; i <= last; i++) {
      const node = path[capture ? last - i : i] as any;
      const handlers = node[eventKey];
      if (!handlers || !node.isConnected) {
        continue;
      }
      for (const id in handlers) {
        const { slot, mods, ownerKey } = handlers[id] as SyntheticHandler;
        dispatchTo(node[ownerKey], slot, mods, event, node);
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
  options: AddEventListenerOptions;
  listener: (event: Event) => void;
  // the events already replayed, once a root other than the document listens
  replayed: WeakSet<Event> | null;
}

// One listener per synthetic event key on every root an app is mounted in:
// the document, and each shadow root or other document, which an event that
// is not composed (change, submit, reset...) never leaves.
const syntheticEvents = new Map<string, SyntheticEvent>();
const syntheticRoots = new WeakSet<Node>();
const syntheticRootRefs: WeakRef<Node>[] = [];

function listenOn(root: Node, event: SyntheticEvent) {
  if (root !== document) {
    event.replayed ||= new WeakSet();
  }
  root.addEventListener(event.evName, event.listener, event.options);
}

function setupSyntheticEvent(
  evName: string,
  eventKey: string,
  capture: boolean = false,
  passive: boolean = false
) {
  if (syntheticEvents.has(eventKey)) {
    return;
  }
  const listener = (event: Event) =>
    nativeToSyntheticEvent(eventKey, capture, syntheticEvent.replayed, event);
  // registered once for the page's lifetime: a harness that removes the
  // listeners a test left behind must recognize this one and keep it
  (listener as any)[SYNTHETIC_LISTENER] = true;
  const syntheticEvent: SyntheticEvent = {
    evName,
    options: { capture, passive },
    listener,
    replayed: null,
  };
  syntheticEvents.set(eventKey, syntheticEvent);
  listenOn(document, syntheticEvent);
  for (const ref of syntheticRootRefs) {
    const root = ref.deref();
    if (root) {
      listenOn(root, syntheticEvent);
    }
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
