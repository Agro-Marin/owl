import { OwlError } from "./owl_error";

export const EventModifier = {
  PREVENT_ANY: 1,
  STOP_ANY: 2,
  SELF: 4,
  PREVENT: 8,
  STOP: 16,
  CAPTURE: 32,
  PASSIVE: 64,
  SYNTHETIC: 128,
} as const;

export const HANDLER_MODIFIERS = 31;

const LISTENER_MODIFIERS: { [m: string]: number } = {
  capture: EventModifier.CAPTURE,
  passive: EventModifier.PASSIVE,
  synthetic: EventModifier.SYNTHETIC,
};

export function eventModifierMask(key: string): number {
  const parts = key.split(".");
  const selfIndex = parts.indexOf("self", 1);
  let mask = 0;
  for (let i = 1; i < parts.length; i++) {
    const m = parts[i];
    const beforeSelf = i < selfIndex;
    if (m === "self") {
      mask |= EventModifier.SELF;
    } else if (m === "prevent") {
      mask |= beforeSelf ? EventModifier.PREVENT_ANY : EventModifier.PREVENT;
    } else if (m === "stop") {
      mask |= beforeSelf ? EventModifier.STOP_ANY : EventModifier.STOP;
    } else if (Object.hasOwn(LISTENER_MODIFIERS, m)) {
      mask |= LISTENER_MODIFIERS[m];
    } else {
      throw new OwlError(`Unknown event modifier: '${m}'`);
    }
  }
  if (mask & EventModifier.PASSIVE && mask & (EventModifier.PREVENT | EventModifier.PREVENT_ANY)) {
    throw new OwlError(
      `Invalid event modifiers '${key}': a passive listener cannot prevent the default`
    );
  }
  return mask;
}
