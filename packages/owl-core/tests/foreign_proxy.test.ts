import {
  computed,
  effect,
  immediateEffect,
  markRaw,
  observe,
  proxy,
  readArrayItems,
  setDebug,
  setDebugSink,
  signal,
  toRaw,
} from "../src";
import { listKinds, objectKinds, type Item } from "./foreign_proxy";
import { waitScheduler } from "./helpers";

function notifiedKeys(fn: () => void): string[] {
  const keys: string[] = [];
  setDebugSink((_channel, message) => {
    if (message.startsWith("proxy write ")) {
      keys.push(message.slice("proxy write ".length));
    }
  });
  setDebug(["reactivity"]);
  try {
    fn();
  } finally {
    setDebug(false);
    setDebugSink(null);
  }
  return keys;
}

describe.each(objectKinds)("$name under a proxy", ({ make }) => {
  test("a write re-runs an effect and an immediate effect reading it once", async () => {
    const state = proxy(make());
    const seen: number[] = [];
    const immediate: number[] = [];
    effect(() => {
      seen.push(state.a);
    });
    immediateEffect(() => {
      immediate.push(state.a);
    });
    state.a = 2;
    state.a = 3;
    await waitScheduler();
    expect(seen).toEqual([1, 3]);
    expect(immediate).toEqual([1, 2, 3]);
    state.a = 3;
    await waitScheduler();
    expect(seen).toEqual([1, 3]);
    expect(immediate).toEqual([1, 2, 3]);
  });

  test("a write notifies its key once", () => {
    const state = proxy(make());
    effect(() => state.a);
    expect(notifiedKeys(() => (state.a = 2))).toEqual(["a"]);
    expect(state.a).toBe(2);
  });

  test("a key created or deleted re-runs a reader of the keys once", () => {
    const state: any = proxy(make());
    const seen: boolean[] = [];
    immediateEffect(() => {
      seen.push(Object.keys(state).includes("extra"));
    });
    state.extra = 1;
    delete state.extra;
    expect(seen).toEqual([false, true, false]);
  });

  test("a write, a creation or a delete runs an immediate reader of the key, its presence and the keys once", () => {
    const state: any = proxy(make());
    let runs = 0;
    immediateEffect(() => {
      runs++;
      void [state.a, state.extra, "extra" in state, Object.keys(state)];
    });
    state.a = 2;
    expect(runs).toBe(2);
    state.extra = 1;
    expect(runs).toBe(3);
    state.extra = 2;
    expect(runs).toBe(4);
    delete state.extra;
    expect(runs).toBe(5);
  });

  test("a getter reads through the proxy, tracked", async () => {
    const state = proxy(make());
    const seen: number[] = [];
    effect(() => {
      seen.push(state.total);
    });
    state.items.push({ id: 3 });
    await waitScheduler();
    state.a = 10;
    await waitScheduler();
    expect(seen).toEqual([3, 4, 13]);
  });

  test("a method writing through `this` notifies once", () => {
    const state = proxy(make());
    const seen: number[] = [];
    immediateEffect(() => {
      seen.push(state.a);
    });
    state.bump();
    expect(seen).toEqual([1, 2]);
  });

  test("a nested object is handed out as its proxy, one per object, and tracked", async () => {
    const target = make();
    const state = proxy(target);
    const nested = Reflect.get(target, "nested");
    expect(state.nested).toBe(state.nested);
    expect(state.nested).toBe(proxy(nested));
    expect(toRaw(state.nested)).toBe(nested);
    const seen: number[] = [];
    effect(() => {
      seen.push(state.nested.v);
    });
    state.nested.v = 2;
    await waitScheduler();
    expect(seen).toEqual([1, 2]);
  });

  test("proxy identity and toRaw", () => {
    const target = make();
    const state = proxy(target);
    expect(proxy(target)).toBe(state);
    expect(proxy(state)).toBe(state);
    expect(toRaw(state)).toBe(target);
    const item = { id: 9 };
    state.items = [item];
    expect(toRaw(state.items[0])).toBe(item);
    expect(state.items[0]).toBe(proxy(item));
  });

  test("a raw-marked target or value stays raw", () => {
    const target = markRaw(make());
    expect(proxy(target)).toBe(target);
    const state = proxy(make());
    const kept = markRaw({ v: 5 });
    state.nested = kept;
    expect(state.nested).toBe(kept);
  });

  test("an observe() view calls back once per change of what it read", () => {
    const target = make();
    let calls = 0;
    const view = observe(target, () => calls++);
    expect(view.total).toBe(3);
    proxy(target).items.push({ id: 3 });
    expect(calls).toBe(1);
    expect(view.nested.v).toBe(1);
    proxy(target).nested.v = 2;
    expect(calls).toBe(2);
    void view.a;
    view.a = 7;
    expect(calls).toBe(3);
    expect(proxy(target).a).toBe(7);
    expect(toRaw(view)).toBe(target);
    expect(toRaw(view.nested)).toBe(Reflect.get(target, "nested"));
  });

  test("a method called through an observe() view reads and writes through it", () => {
    const target = make();
    let calls = 0;
    const view = observe(target, () => calls++);
    view.bump();
    expect(calls).toBe(1);
    expect(view.a).toBe(2);
    proxy(target).a = 3;
    expect(calls).toBe(2);
  });

  test("a shallow signal of it notifies a write once and hands out values as stored", async () => {
    const target = make();
    const state = signal.Object(target);
    const seen: number[] = [];
    effect(() => {
      seen.push(state().a);
    });
    state().a = 2;
    await waitScheduler();
    expect(seen).toEqual([1, 2]);
    expect(state().nested).toBe(Reflect.get(target, "nested"));
  });
});

describe.each(listKinds)("$name under a proxy", ({ make, mapped }) => {
  function items(n: number): Item[] {
    return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
  }

  test("readArrayItems re-reads it once per write and hands out what an index read would", () => {
    const raw = items(3);
    const list = proxy(make(raw));
    let runs = 0;
    const ids = computed(
      () => {
        runs++;
        return [...readArrayItems(list)].map((item) => item?.id);
      },
      { detached: true }
    );
    expect(ids()).toEqual([1, 2, 3]);
    expect(readArrayItems(list)[0]).toBe(list[0]);
    list.push({ id: 4 });
    expect(ids()).toEqual([1, 2, 3, 4]);
    list[0] = { id: 10 };
    expect(ids()).toEqual([10, 2, 3, 4]);
    list.splice(1, 2);
    expect(ids()).toEqual([10, 4]);
    list.reverse();
    expect(ids()).toEqual([4, 10]);
    list.length = 0;
    expect(ids()).toEqual([]);
    expect(runs).toBe(6);
  });

  test("a write re-runs an effect reading the length and an index once", async () => {
    const list = proxy(make(items(2)));
    const seen: unknown[] = [];
    effect(() => {
      seen.push([list.length, list[0]?.id]);
    });
    list.push({ id: 3 });
    await waitScheduler();
    list[0] = { id: 7 };
    await waitScheduler();
    expect(seen).toEqual([
      [2, 1],
      [3, 1],
      [3, 7],
    ]);
  });

  test("a push or an index write runs an immediate reader of the items once", () => {
    const list = proxy(make(items(2)));
    const seen: number[][] = [];
    immediateEffect(() => {
      seen.push([...readArrayItems(list)].map((item) => item.id));
    });
    list.push({ id: 3 });
    list[0] = { id: 7 };
    list.splice(0, 1);
    expect(seen).toEqual([
      [1, 2],
      [1, 2, 3],
      [7, 2, 3],
      [2, 3],
    ]);
  });

  test("an index write or a length write runs an immediate reader of the index, the length and the items once", () => {
    const list = proxy(make(items(3)));
    let runs = 0;
    immediateEffect(() => {
      runs++;
      void [list[0], list[2], list.length, readArrayItems(list), 1 in list];
    });
    list[0] = { id: 7 };
    expect(runs).toBe(2);
    list[3] = { id: 8 };
    expect(runs).toBe(3);
    list.length = 1;
    expect(runs).toBe(4);
    expect(list.length).toBe(1);
  });

  test.skipIf(mapped)(
    "a delete runs an immediate reader of the index, the length and the items once",
    () => {
      // (a list whose traps report no own index property is outside it: a proxy
      // tells a key's presence by the target's own properties)
      const list = proxy(make(items(3)));
      let runs = 0;
      immediateEffect(() => {
        runs++;
        void [list[1], list.length, readArrayItems(list), 1 in list, Object.keys(list)];
      });
      delete list[1];
      expect(runs).toBe(2);
      expect(1 in list).toBe(false);
    }
  );

  test("an item is handed out as its proxy, one per item, raw under toRaw", () => {
    const raw = items(2);
    const list = proxy(make(raw));
    expect(list[0]).toBe(list[0]);
    expect(list[0]).toBe(proxy(raw[0]));
    expect(toRaw(list[0])).toBe(raw[0]);
    expect(proxy(toRaw(list))).toBe(list);
    expect(proxy(list)).toBe(list);
  });

  test("includes / indexOf / lastIndexOf find an item by its proxy or its raw object, tracked", async () => {
    const raw = items(2);
    const extra = { id: 3 };
    const list = proxy(make(raw));
    expect(list.includes(raw[1])).toBe(true);
    expect(list.includes(list[1])).toBe(true);
    expect(list.indexOf(list[1])).toBe(1);
    expect(list.lastIndexOf(raw[0])).toBe(0);
    const seen: unknown[] = [];
    effect(() => {
      seen.push(list.includes(extra), list.indexOf(proxy(extra)));
    });
    list.push(extra);
    await waitScheduler();
    expect(seen).toEqual([false, -1, true, 2]);
  });

  test("a raw-marked item is handed out raw", () => {
    const kept = markRaw({ id: 1 });
    const list = proxy(make([kept]));
    expect(list[0]).toBe(kept);
    expect(readArrayItems(list)[0]).toBe(kept);
  });

  test("an observe() view calls back once per change of what it read, and on a push through it", () => {
    const raw = items(2);
    const list = proxy(make(raw));
    let calls = 0;
    const view = observe(list, () => calls++);
    expect(view.length).toBe(2);
    expect(toRaw(view[0])).toBe(raw[0]);
    list.push({ id: 3 });
    expect(calls).toBe(1);
    void view[0].id;
    list[0].id = 9;
    expect(calls).toBe(2);
    view.push({ id: 4 });
    expect(calls).toBe(3);
    expect(list.length).toBe(4);
    const ids: number[] = [];
    view.forEach((item) => ids.push(item.id));
    expect(ids).toEqual([9, 2, 3, 4]);
    list[1].id = 8;
    expect(calls).toBe(4);
  });

  test("a shallow signal of it notifies an index written past the end once and hands out items as stored", async () => {
    // (a method of the list writing the array it keeps its items in is not
    // seen: a shallow proxy hands that array out raw)
    const raw = items(2);
    const list = signal.Array(make(raw));
    const seen: number[] = [];
    effect(() => {
      seen.push(list().length);
    });
    list()[2] = { id: 3 };
    await waitScheduler();
    expect(seen).toEqual([2, 3]);
    expect(list()[0]).toBe(raw[0]);
  });

  test.runIf(mapped)("a write to the data it maps its indices to re-runs every reader once", () => {
    const raw = items(2);
    const first = raw[0];
    const list: any = proxy(make(raw));
    const ids: string[] = [];
    const lengths: number[] = [];
    const found: boolean[] = [];
    immediateEffect(() => {
      ids.push([...readArrayItems<Item>(list)].map((item: Item) => item.id).join(","));
    });
    immediateEffect(() => {
      lengths.push(list.length);
    });
    immediateEffect(() => {
      found.push(list.includes(first));
    });
    list.data.push({ id: 3 });
    list.data.shift();
    list.data = [{ id: 5 }];
    expect(ids).toEqual(["1,2", "1,2,3", "2,3", "5"]);
    expect(lengths).toEqual([2, 3, 2, 1]);
    expect(found).toEqual([true, true, false, false]);
  });
});
