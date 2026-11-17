import { applyDefaults, proxy, t, validateType, type Schema } from "../src";

test("collection schemas validate reactive entries and report their iteration paths", () => {
  const schema = t.map(t.string(), t.set(t.number()));
  expect(validateType(proxy(new Map([["ok", new Set([1, 2])]])), schema)).toEqual([]);
  expect(validateType(new Map([[42, new Set(["bad"])]]), schema)).toEqual([
    { message: "value is not a string", path: "0 > key", received: 42 },
    { message: "value is not a number", path: "0 > value > 0", received: "bad" },
  ]);
});

test("a union still tries a later collection member after a deep mismatch", () => {
  const strings = new Set(["a"]);
  expect(validateType(strings, t.or([t.set(t.number()), t.set(t.string())]))).toEqual([]);
  const nested = t.or([t.map(t.string(), t.number()), t.object({ name: t.string() })]);
  expect(validateType({ name: "a" }, nested)).toEqual([]);
});

test("collection defaults create fresh containers without filling or mutating their contents", () => {
  const schema = t.set(t.number()).optional(() => new Set([1]));
  const first = applyDefaults(undefined, schema);
  const second = applyDefaults(undefined, schema);
  expect(first).toEqual(new Set([1]));
  expect(first).not.toBe(second);
  const map = new Map([["a", undefined]]);
  expect(applyDefaults(map, t.map(t.string(), t.number().optional(2)))).toBe(map);
  expect(map.get("a")).toBeUndefined();
});

test("collection schemas retain invalid-schema errors instead of accepting constructors", () => {
  expect(() => validateType(new Set([1]), t.set(Number as unknown as Schema<number>))).toThrow(
    "constructor, not a type"
  );
  expect(() => (t.map as Function)(t.string())).toThrow("both a key schema and a value schema");
  expect(validateType([], t.set())).toMatchObject([{ message: "value is not a set" }]);
  expect(validateType({}, t.map())).toMatchObject([{ message: "value is not a map" }]);
});

test.each([null, false, 0, "", Number])(
  "a supplied invalid collection schema %s cannot silently disable validation",
  (invalid) => {
    const set = t.set as Function;
    const map = t.map as Function;
    expect(() => validateType(new Set(), set(invalid))).toThrow("Invalid schema");
    expect(() => validateType(new Map(), map(invalid, t.number()))).toThrow("Invalid schema");
    expect(() => validateType(new Map(), map(t.string(), invalid))).toThrow("Invalid schema");
  }
);

test("withEntry reports symbol paths for both value and schema errors", () => {
  const key = Symbol("member");
  expect(
    validateType(null, (context: import("../src").ValidationContext) => {
      context.withEntry(key, 1).validate(t.string());
    })
  ).toEqual([{ received: 1, path: "Symbol(member)", message: "value is not a string" }]);
  expect(() =>
    validateType(null, (context: import("../src").ValidationContext) => {
      context.withEntry(key, 1).validate(Number);
    })
  ).toThrow('Invalid schema at "Symbol(member)"');
});
