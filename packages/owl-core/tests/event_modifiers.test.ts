import { EventModifier, eventModifierMask, HANDLER_MODIFIERS } from "../src";

const { PREVENT_ANY, STOP_ANY, SELF, PREVENT, STOP, CAPTURE, PASSIVE, SYNTHETIC } = EventModifier;

test("an event key's mask: .prevent and .stop before .self apply to every event", () => {
  expect(eventModifierMask("click")).toBe(0);
  expect(eventModifierMask("click.stop")).toBe(STOP);
  expect(eventModifierMask("click.prevent.stop")).toBe(PREVENT | STOP);
  expect(eventModifierMask("click.prevent.self")).toBe(PREVENT_ANY | SELF);
  expect(eventModifierMask("click.self.prevent")).toBe(SELF | PREVENT);
  expect(eventModifierMask("click.stop.self.prevent")).toBe(STOP_ANY | SELF | PREVENT);
});

test("capture, passive and synthetic choose the listener, outside the handler modifiers", () => {
  expect(eventModifierMask("click.capture.passive.synthetic")).toBe(CAPTURE | PASSIVE | SYNTHETIC);
  expect(eventModifierMask("click.capture.stop.synthetic")).toBe(CAPTURE | STOP | SYNTHETIC);
  expect(eventModifierMask("click.capture.passive.synthetic") & HANDLER_MODIFIERS).toBe(0);
  expect(eventModifierMask("click.stop.self.prevent") & HANDLER_MODIFIERS).toBe(
    STOP_ANY | SELF | PREVENT
  );
});

test("a passive key that prevents the default throws", () => {
  expect(() => eventModifierMask("touchmove.passive.prevent")).toThrow(
    "Invalid event modifiers 'touchmove.passive.prevent': a passive listener cannot prevent the default"
  );
  expect(() => eventModifierMask("click.prevent.self.passive")).toThrow("Invalid event modifiers");
  expect(eventModifierMask("click.passive.stop")).toBe(PASSIVE | STOP);
});

test("an event named self is not the .self modifier", () => {
  expect(eventModifierMask("self.stop")).toBe(STOP);
  expect(eventModifierMask("self.stop.self")).toBe(STOP_ANY | SELF);
});

test("an unknown modifier throws", () => {
  expect(() => eventModifierMask("click.stopp")).toThrow("Unknown event modifier: 'stopp'");
  expect(() => eventModifierMask("click.stop.")).toThrow("Unknown event modifier: ''");
});
