// The modifiers of a compiled t-on handler, as a bitmask the template compiler
// computes and the runtime's event handler reads: handler data is
// `[handler, context, modifiers?]`. `.prevent` / `.stop` written before `.self`
// apply to every event (the *_ANY bits), written after it or without it only
// to an event the element itself received.
export const EventModifier = {
  PREVENT_ANY: 1,
  STOP_ANY: 2,
  SELF: 4,
  PREVENT: 8,
  STOP: 16,
} as const;
