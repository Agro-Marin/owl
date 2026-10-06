import { OwlError } from "./owl_error";

// The modifiers of a t-on handler, as a bitmask the runtime's event handler
// reads: blockdom computes it from the handler's key (`click.stop.prevent`)
// once per block or catcher, and passes it with the handler. `.prevent` /
// `.stop` written before `.self` apply to every event (the *_ANY bits),
// written after it or without it only to an event the element itself received.
export const EventModifier = {
  PREVENT_ANY: 1,
  STOP_ANY: 2,
  SELF: 4,
  PREVENT: 8,
  STOP: 16,
} as const;

// capture, passive and synthetic choose the listener, not what it does
const LISTENER_MODIFIERS = ["capture", "passive", "synthetic"];

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
    } else if (!LISTENER_MODIFIERS.includes(m)) {
      throw new OwlError(`Unknown event modifier: '${m}'`);
    }
  }
  return mask;
}
