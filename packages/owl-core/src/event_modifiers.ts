import { OwlError } from "./owl_error";

// Named before the objects that hold them: a module-level read of a property
// (`EventModifier.CAPTURE`) is a possible side effect to a bundler, which then
// keeps the object in every bundle importing anything from this package.
const CAPTURE = 32;
const PASSIVE = 64;
const SYNTHETIC = 128;

export const EventModifier = {
  PREVENT_ANY: 1,
  STOP_ANY: 2,
  SELF: 4,
  PREVENT: 8,
  STOP: 16,
  CAPTURE,
  PASSIVE,
  SYNTHETIC,
} as const;

export const HANDLER_MODIFIERS = 31;

const LISTENER_MODIFIERS: { [m: string]: number } = {
  capture: CAPTURE,
  passive: PASSIVE,
  synthetic: SYNTHETIC,
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
