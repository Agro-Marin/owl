import {
  debug,
  debugLog,
  EventModifier,
  eventModifierMask,
  HANDLER_MODIFIERS,
} from "@odoo/owl-core";
import { config, type HandlerFn } from "./config";

export interface HandlerOwner {
  data?: any[];
  handlers: readonly (HandlerFn | null)[];
}

export interface HandlerSlot {
  fn: number;
  ctx: number;
  arg: number;
}

interface EventHandlerCreator {
  setup: (this: HTMLElement, owner: HandlerOwner) => void;
  remove: (this: HTMLElement) => void;
}

export function createEventHandler(rawEvent: string, slot: HandlerSlot): EventHandlerCreator {
  const eventName = rawEvent.split(".")[0];
  const mask = eventModifierMask(rawEvent);
  const capture = !!(mask & EventModifier.CAPTURE);
  const passive = !!(mask & EventModifier.PASSIVE);
  const mods = mask & HANDLER_MODIFIERS;
  if (mask & EventModifier.SYNTHETIC) {
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
    if (!currentTarget || !currentTarget.isConnected) return;
    dispatchTo(currentTarget[eventKey], slot, mods, ev, currentTarget);
  }

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
    delete (this as any)[eventKey]?.[currentId];
    delete (this as any)[ownerKey];
  }

  return { setup, remove };
}

function ignore() {}

function replayedRange(path: EventTarget[], root: EventTarget | null): [number, number] {
  if (!syntheticRootRefs.length || !pruneRoots()) {
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
  passive: boolean;
  listener: (event: Event) => void;
}

const syntheticEvents = new Map<string, SyntheticEvent>();
const syntheticRoots = new WeakSet<Node>();
const syntheticRootRefs: WeakRef<Node>[] = [];

function pruneRoots(): number {
  let live = 0;
  for (let i = 0; i < syntheticRootRefs.length; i++) {
    if (syntheticRootRefs[i].deref()) {
      syntheticRootRefs[live++] = syntheticRootRefs[i];
    }
  }
  if (live < syntheticRootRefs.length) {
    if (debug.event) {
      debugLog("event", `${syntheticRootRefs.length - live} collected synthetic roots dropped`);
    }
    syntheticRootRefs.length = live;
  }
  return live;
}

function roots(): Node[] {
  pruneRoots();
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
  (listener as any)[SYNTHETIC_LISTENER] = true;
  const syntheticEvent: SyntheticEvent = { evName, capture, passive, listener };
  syntheticEvents.set(eventKey, syntheticEvent);
  for (const root of roots()) {
    listenOn(root, syntheticEvent);
  }
}

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
  pruneRoots();
  syntheticRootRefs.push(new WeakRef(root));
  for (const syntheticEvent of syntheticEvents.values()) {
    listenOn(root, syntheticEvent);
  }
}
