import { computed } from "./computed";
import { untrack } from "./computations";
import { effect, immediateEffect } from "./effect";
import { onWillDestroy } from "./lifecycle_hooks";
import { useScope, type ScopeApp } from "./scope";
import { shallowEqual } from "./utils";

export function useEffect(fn: Parameters<typeof effect>[0]): void {
  useScope();
  onWillDestroy(effect(fn));
}

export function useImmediateEffect(fn: Parameters<typeof immediateEffect>[0]): void {
  useScope();
  onWillDestroy(immediateEffect(fn));
}

type Cleanup = (() => void) | void;

type Args<T extends unknown[]> = { [K in keyof T]: T[K] };

export function useOnChange<T extends unknown[]>(
  dependencies: () => [...T],
  callback: (...args: Args<T>) => Cleanup,
  { initialRun = true }: { initialRun?: boolean } = {}
): void {
  const deps = computed(dependencies, { equals: shallowEqual });
  let skipRun = !initialRun;
  useEffect(() => {
    const args = deps();
    if (skipRun) {
      skipRun = false;
      return;
    }
    return untrack(() => callback(...args));
  });
}

// The events a target dispatches by name, as addEventListener types them; an
// event this map does not name (a custom one, another kind of target) is any.
type EventMapOf<T> = T extends Window
  ? WindowEventMap
  : T extends Document
    ? DocumentEventMap
    : T extends HTMLElement
      ? HTMLElementEventMap
      : {};
type ListenedEvent<T, K extends string> = K extends keyof EventMapOf<T> ? EventMapOf<T>[K] : any;

export function useListener<T extends EventTarget, K extends string>(
  target: T | (() => T | null),
  eventName: K,
  handler: (this: T, ev: ListenedEvent<T, K>) => void,
  eventParams?: AddEventListenerOptions
): void {
  useScope();
  if (typeof target === "function") {
    useEffect(() => {
      const el = target();
      if (el) {
        const listener = makeListener(handler);
        el.addEventListener(eventName, listener, eventParams);
        return () => el.removeEventListener(eventName, listener, eventParams);
      }
      return;
    });
  } else {
    const listener = makeListener(handler);
    target.addEventListener(eventName, listener, eventParams);
    onWillDestroy(() => target.removeEventListener(eventName, listener, eventParams));
  }
}

let currentEvent: WeakRef<Event> | null = null;

export function setCurrentEvent(ev: Event): void {
  if (currentEvent?.deref() !== ev) {
    currentEvent = new WeakRef(ev);
  }
}

function makeListener(handler: (this: any, ev: any) => void): EventListener {
  const attachedDuring = currentEvent?.deref();
  return function (this: EventTarget, ev: Event) {
    if (ev === attachedDuring) {
      return;
    }
    setCurrentEvent(ev);
    handler.call(this, ev);
  };
}

export function useApp<TApp extends ScopeApp = ScopeApp>(): NoInfer<TApp> {
  return useScope().app as TApp;
}
