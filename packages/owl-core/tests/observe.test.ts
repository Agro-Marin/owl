import { computed, effect, observe, proxy, toRaw } from "../src";
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

  test("a callback reading the view again stays subscribed to what it read", () => {
    const seen: [number, number][] = [];
    const state: { a: number; b: number } = observe({ a: 1, b: 1 }, () =>
      seen.push([state.a, state.b])
    );
    void state.a;
    state.a = 2;
    expect(seen).toEqual([[2, 1]]);
    state.b = 2;
    expect(seen).toEqual([
      [2, 1],
      [2, 2],
    ]);
    state.a = 3;
    expect(seen).toEqual([
      [2, 1],
      [2, 2],
      [3, 2],
    ]);
    state.b = 3;
    expect(seen).toEqual([
      [2, 1],
      [2, 2],
      [3, 2],
      [3, 3],
    ]);
  });

  test("a callback reading part of the view drops what it did not read again", () => {
    let calls = 0;
    const state: { a: number; b: number } = observe({ a: 1, b: 1 }, () => {
      calls++;
      void state.b;
    });
    void state.a;
    state.a = 2;
    expect(calls).toBe(1);
    state.a = 3;
    expect(calls).toBe(1);
    void state.a;
    state.b = 2;
    expect(calls).toBe(2);
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

  test("observes maps and sets iterated through the view", () => {
    let calls = 0;
    const state = observe(
      { set: new Set<number>(), map: new Map<string, { v: number }>() },
      () => calls++
    );
    void [...state.set];
    proxy(toRaw(state)).set.add(1);
    expect(calls).toBe(1);
    void Array.from(state.set.values());
    proxy(toRaw(state)).set.add(2);
    expect(calls).toBe(2);
    proxy(toRaw(state)).map.set("k", { v: 1 });
    for (const [, entry] of state.map) {
      void entry.v;
    }
    proxy(toRaw(state)).map.get("k")!.v = 2;
    expect(calls).toBe(3);
  });

  test("reads through the view reach getters and inner proxies with the view as receiver", () => {
    let calls = 0;
    const data = { items: [1] };
    const receivers: any[] = [];
    const target = new Proxy(data, {
      get(t, key, receiver) {
        receivers.push(receiver);
        return Reflect.get(t, key, receiver);
      },
    });
    const holder = {
      target,
      get count() {
        return this.target.items.length;
      },
    };
    const view = observe(holder, () => calls++);
    expect(view.count).toBe(1);
    expect(receivers.every((r) => r !== proxy(target))).toBe(true);
    proxy(toRaw(view)).target.items.push(2);
    expect(calls).toBe(1);
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

  test("a computed read through the view notifies without being recomputed inside the write", () => {
    const order = proxy({ lines: [] as { method?: { cash: boolean } }[] });
    let recomputes = 0;
    const hasCash = computed(
      () => {
        recomputes++;
        return order.lines.some((line) => line.method!.cash);
      },
      { detached: true }
    );
    class OrderView {
      get hasCash() {
        return hasCash();
      }
    }
    let calls = 0;
    const view = observe(new OrderView(), () => calls++);
    expect(view.hasCash).toBe(false);
    expect(recomputes).toBe(1);
    // a line is pushed before its method is set, as a record is built field by
    // field: recomputing here would read `undefined.cash`
    order.lines.push({});
    expect(calls).toBe(1);
    expect(recomputes).toBe(1);
    order.lines[0].method = { cash: true };
    expect(hasCash()).toBe(true);
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

  test("a write that shifts an array through the view does not call the callback by itself", () => {
    let calls = 0;
    const view = observe({ list: [1, 2, 3] }, () => calls++);
    const list = view.list;
    list.push(4);
    list.pop();
    list.unshift(0);
    list.shift();
    list.splice(1, 1);
    expect(calls).toBe(0);
    expect(toRaw(list)).toEqual([1, 3]);
  });

  test("a write that shifts an array calls the callback when the view read what it changed", () => {
    let calls = 0;
    const view = observe({ list: [1, 2] }, () => calls++);
    void view.list.length;
    view.list.push(3);
    expect(calls).toBe(1);
  });

  test("an item a shifting write returns is a view", () => {
    let calls = 0;
    const view = observe({ list: [{ a: 1 }] }, () => calls++);
    const item = view.list.pop()!;
    void item.a;
    item.a = 2;
    expect(calls).toBe(1);
  });

  test("forEach through a map view hands out views, and the view as the map", () => {
    let calls = 0;
    const view = observe(new Map([["k", { a: 1 }]]), () => calls++);
    let value: any;
    let map: any;
    view.forEach((v, _k, m) => {
      value = v;
      map = m;
    });
    expect(map).toBe(view);
    expect(value).toBe([...view.values()][0]);
    void value.a;
    proxy(toRaw(value)).a = 2;
    expect(calls).toBe(1);
  });

  test("forEach through a view observes the entries, not what its callback reads elsewhere", () => {
    let calls = 0;
    const other = proxy({ x: 1 });
    const view = observe(new Set([1]), () => calls++);
    view.forEach(() => other.x);
    other.x = 2;
    expect(calls).toBe(0);
    view.add(2);
    expect(calls).toBe(1);
  });

  test("a collection view hands out its constructor, and other functions, as they are", () => {
    const view: any = observe(new Map(), () => {});
    expect(view.constructor).toBe(Map);
    expect(new view.constructor([[1, 2]]).get(1)).toBe(2);
  });

  test("hasOwnProperty through the view observes the presence of its key", () => {
    let calls = 0;
    const view: any = observe({ a: 1 }, () => calls++);
    expect(view.hasOwnProperty("b")).toBe(false);
    proxy(toRaw(view)).b = 1;
    expect(calls).toBe(1);
  });
});
