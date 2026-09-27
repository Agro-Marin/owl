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

  const options: AddEventListenerOptions = { capture, passive };

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
// a handler stopped propagation.
function nativeToSyntheticEvent(eventKey: string, capture: boolean, event: Event) {
  const path = event.composedPath();
  const last = path.length - 1;
  for (let i = 0; i <= last; i++) {
    const node = path[capture ? last - i : i] as any;
    const handlers = node[eventKey];
    if (!handlers || !node.isConnected) {
      continue;
    }
    for (const id in handlers) {
      if (config.mainEventHandler(handlers[id], event, node)) {
        return;
      }
    }
    if (event.cancelBubble) {
      return;
    }
  }
}

export const SYNTHETIC_LISTENER = Symbol.for("owl.syntheticListener");

const CONFIGURED_SYNTHETIC_EVENTS: { [event: string]: boolean } = {};

function setupSyntheticEvent(
  evName: string,
  eventKey: string,
  capture: boolean = false,
  passive: boolean = false
) {
  if (CONFIGURED_SYNTHETIC_EVENTS[eventKey]) {
    return;
  }
  const listener = (event: Event) => nativeToSyntheticEvent(eventKey, capture, event);
  // registered once for the page's lifetime: a harness that removes the
  // listeners a test left behind must recognize this one and keep it
  (listener as any)[SYNTHETIC_LISTENER] = true;
  document.addEventListener(evName, listener, { capture, passive });
  CONFIGURED_SYNTHETIC_EVENTS[eventKey] = true;
}
