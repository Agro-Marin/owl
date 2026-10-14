import { effect, markRaw, observe, proxy, signal, toRaw } from "../src";
import { waitScheduler } from "./helpers";

describe("wrapping nested objects", () => {
  test.each(["property", "map", "iterator", "forEach"] as const)(
    "%s accepts a value after one type-tag inspection",
    (readKind) => {
      let inspections = 0;
      const raw = {
        value: 1,
        get [Symbol.toStringTag]() {
          if (++inspections > 1) throw new Error("type tag inspected twice");
          return "Object";
        },
      };
      const read =
        readKind === "property"
          ? () => proxy({ raw }).raw
          : readKind === "map"
            ? () => proxy(new Map([["row", raw]])).get("row")!
            : readKind === "iterator"
              ? () =>
                  proxy(new Set([raw]))
                    .values()
                    .next().value!
              : () => {
                  let result = raw;
                  proxy(new Map([["row", raw]])).forEach((value) => (result = value));
                  return result;
                };
      const wrapped = read();
      expect(wrapped.value).toBe(1);
      // Compare identities before passing booleans to the matcher: its
      // diagnostic deep comparisons would themselves inspect the type tag.
      expect(wrapped !== raw).toBe(true);
      expect(toRaw(wrapped) === raw).toBe(true);
      expect(inspections).toBe(1);
    }
  );

  test("a failed type inspection does not cache a partial wrapper", () => {
    const error = new Error("type inspection failed");
    let fail = true;
    const raw = {
      value: 1,
      get [Symbol.toStringTag]() {
        if (fail) throw error;
        return "Object";
      },
    };
    const state = proxy({ raw });
    expect(() => state.raw).toThrow(error);
    fail = false;
    expect(toRaw(state.raw)).toBe(raw);
    expect(state.raw.value).toBe(1);
  });

  test("raw marking after a cached nested read still applies", () => {
    const raw = { value: 1 };
    const state = proxy({ raw });
    const wrapped = state.raw;
    expect(wrapped).not.toBe(raw);
    markRaw(wrapped);
    expect(state.raw).toBe(raw);
  });

  test("a stored observer view preserves its callback and computation", async () => {
    let notifications = 0;
    const raw = { value: 1 };
    const view = observe(raw, () => notifications++);
    const state = proxy({ view });
    const seen: number[] = [];
    const stop = effect(() => seen.push(state.view.value));
    try {
      expect(state.view).toBe(view);
      proxy(raw).value = 2;
      await waitScheduler();
      expect(notifications).toBe(1);
      expect(seen).toEqual([1, 2]);
    } finally {
      stop();
    }
  });

  test("a nested shallow collection is converted to its deep flavor", async () => {
    const item = { value: 1 };
    const shallow = signal.Map(new Map([["row", item]]))();
    const state = proxy({ shallow });
    const seen: number[] = [];
    const stop = effect(() => seen.push(state.shallow.get("row")!.value));
    try {
      expect(shallow.get("row")).toBe(item);
      expect(state.shallow).not.toBe(shallow);
      expect(toRaw(state.shallow)).toBe(toRaw(shallow));
      state.shallow.get("row")!.value = 2;
      await waitScheduler();
      expect(seen).toEqual([1, 2]);
    } finally {
      stop();
    }
  });
});
