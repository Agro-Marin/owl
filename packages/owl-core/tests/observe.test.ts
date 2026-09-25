import { effect, observe, proxy, toRaw } from "../src";
import { waitScheduler } from "./helpers";

describe("observe", () => {
  test("calls back synchronously when a value read through the view changes", () => {
    const calls: number[] = [];
    const state = observe({ a: 1, b: 2 }, () => calls.push(1));
    void state.a;
    proxy(toRaw(state)).b = 3;
    expect(calls).toEqual([]);
    proxy(toRaw(state)).a = 2;
    expect(calls).toEqual([1]);
  });

  test("is one-shot until the view is read again", () => {
    let calls = 0;
    const state = observe({ a: 1 }, () => calls++);
    void state.a;
    state.a = 2;
    state.a = 3;
    expect(calls).toBe(1);
    void state.a;
    state.a = 4;
    expect(calls).toBe(2);
  });

  test("observes nested objects read through the view", () => {
    let calls = 0;
    const state = observe({ inner: { value: 1 } }, () => calls++);
    void state.inner.value;
    proxy(toRaw(state)).inner.value = 2;
    expect(calls).toBe(1);
  });

  test("observes key sets and array lengths", () => {
    let calls = 0;
    const state = observe({ obj: {} as Record<string, number>, list: [1] }, () => calls++);
    void Object.keys(state.obj);
    state.obj.added = 1;
    expect(calls).toBe(1);
    void state.list.length;
    state.list.push(2);
    expect(calls).toBe(2);
  });

  test("observes maps and sets through their methods", () => {
    let calls = 0;
    const state = observe({ map: new Map([["k", 1]]), set: new Set<number>() }, () => calls++);
    void state.map.get("k");
    proxy(toRaw(state)).map.set("k", 2);
    expect(calls).toBe(1);
    void state.set.has(3);
    proxy(toRaw(state)).set.add(3);
    expect(calls).toBe(2);
  });

  test("a view written into the state is stored raw", () => {
    const raw = { a: { value: 1 }, b: null as any };
    const state = observe(raw, () => {});
    state.b = state.a;
    expect(raw.b).toBe(raw.a);
    expect(toRaw(state)).toBe(raw);
    expect(toRaw(state.a)).toBe(raw.a);
  });

  test("reads through the view keep subscribing the surrounding computation", async () => {
    const state = observe({ a: 1 }, () => {});
    const seen: number[] = [];
    effect(() => {
      seen.push(state.a);
    });
    proxy(toRaw(state)).a = 2;
    await waitScheduler();
    expect(seen).toEqual([1, 2]);
  });

  test("the callback's own reads outside the view are not observed", () => {
    let calls = 0;
    const other = proxy({ x: 1 });
    const state = observe({ a: 1 }, () => {
      calls++;
      void other.x;
    });
    void state.a;
    state.a = 2;
    expect(calls).toBe(1);
    other.x = 2;
    expect(calls).toBe(1);
  });

  test("getters read through the view are observed", () => {
    class Counter {
      value = 1;
      get double() {
        return this.value * 2;
      }
    }
    let calls = 0;
    const state = observe(new Counter(), () => calls++);
    expect(state.double).toBe(2);
    proxy(toRaw(state)).value = 2;
    expect(calls).toBe(1);
  });

  test("a view of a view observes the same target, for its own callback", () => {
    let outer = 0;
    let inner = 0;
    const innerView = observe({ counter: 0 }, () => inner++);
    const outerView = observe([innerView], () => outer++);
    void outerView[0].counter;
    innerView.counter = 1;
    expect(outer).toBe(1);
    expect(inner).toBe(0);
  });
});
