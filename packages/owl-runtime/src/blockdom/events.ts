import { config } from "./config";

type EventHandlerSetter = (this: HTMLElement, data: any) => void;

interface EventHandlerCreator {
  setup: EventHandlerSetter;
  update: EventHandlerSetter;
  remove: (this: HTMLElement) => void;
}

export function createEventHandler(rawEvent: string): EventHandlerCreator {
  const eventName = rawEvent.split(".")[0];
  const capture = rawEvent.includes(".capture");
  const passive = rawEvent.includes(".passive");
  if (rawEvent.includes(".synthetic")) {
    return createSyntheticHandler(eventName, capture, passive);
  } else {
    return createElementHandler(eventName, capture, passive);
  }
}

// Native listener
let nextNativeEventId = 1;
function createElementHandler(
  evName: string,
  capture: boolean = false,
  passive: boolean = false
): EventHandlerCreator {
  let eventKey = `__event__${evName}_${nextNativeEventId++}`;
  if (capture) {
    eventKey = `${eventKey}_capture`;
  }

  function listener(ev: Event) {
    const currentTarget = ev.currentTarget as HTMLElement;
    // isConnected crosses any number of shadow roots
    if (!currentTarget || !currentTarget.isConnected) return;
    const data = (currentTarget as any)[eventKey];
    if (!data) return;
    config.mainEventHandler(data, ev, currentTarget);
  }

  // a dictionary costs the browser twice a boolean to read, on every element:
  // only a passive listener needs one (an element is never window, document or
  // body, the targets where an unspecified passive defaults to true)
  const options: AddEventListenerOptions | boolean = passive ? { capture, passive } : capture;

  function setup(this: HTMLElement, data: any) {
    (this as any)[eventKey] = data;
    this.addEventListener(evName, listener, options);
  }

  function remove(this: HTMLElement) {
    delete (this as any)[eventKey];
    this.removeEventListener(evName, listener, options);
  }
  function update(this: HTMLElement, data: any) {
    (this as any)[eventKey] = data;
  }

  return { setup, update, remove };
}

// Synthetic handler: a form of event delegation that allows placing only one
// listener per event type.
let nextSyntheticEventId = 1;
function createSyntheticHandler(
  evName: string,
  capture: boolean = false,
  passive: boolean = false
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
  function setup(this: HTMLElement, data: any) {
    const _data = (this as any)[eventKey] || {};
    _data[currentId] = data;
    (this as any)[eventKey] = _data;
  }

  function remove(this: HTMLElement) {
    // other handlers (a sibling component's catcher) may share this element
    delete (this as any)[eventKey]?.[currentId];
  }

  return { setup, update: setup, remove };
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
        config.mainEventHandler(handlers[id], event, node);
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
