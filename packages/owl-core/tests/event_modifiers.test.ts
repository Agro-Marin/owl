import { EventModifier, eventModifierMask } from "../src";

const { PREVENT_ANY, STOP_ANY, SELF, PREVENT, STOP } = EventModifier;

test("an event key's mask: .prevent and .stop before .self apply to every event", () => {
  expect(eventModifierMask("click")).toBe(0);
  expect(eventModifierMask("click.stop")).toBe(STOP);
  expect(eventModifierMask("click.prevent.stop")).toBe(PREVENT | STOP);
  expect(eventModifierMask("click.prevent.self")).toBe(PREVENT_ANY | SELF);
  expect(eventModifierMask("click.self.prevent")).toBe(SELF | PREVENT);
  expect(eventModifierMask("click.stop.self.prevent")).toBe(STOP_ANY | SELF | PREVENT);
});

test("capture, passive and synthetic choose the listener and add nothing to the mask", () => {
  expect(eventModifierMask("click.capture.passive.synthetic")).toBe(0);
  expect(eventModifierMask("click.capture.stop.synthetic")).toBe(STOP);
});

test("an event named self is not the .self modifier", () => {
  expect(eventModifierMask("self.stop")).toBe(STOP);
  expect(eventModifierMask("self.stop.self")).toBe(STOP_ANY | SELF);
});

test("an unknown modifier throws", () => {
  expect(() => eventModifierMask("click.stopp")).toThrow("Unknown event modifier: 'stopp'");
  expect(() => eventModifierMask("click.stop.")).toThrow("Unknown event modifier: ''");
});
