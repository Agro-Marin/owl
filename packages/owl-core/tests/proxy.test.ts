import v8 from "node:v8";
import vm from "node:vm";
import {
  computed,
  effect,
  immediateEffect,
  markRaw,
  observe,
  OwlError,
  proxy,
  setDebug,
  setDebugSink,
  signal,
  toRaw,
} from "../src";
import { waitScheduler } from "./helpers";

v8.setFlagsFromString("--expose-gc");
const gc: () => void = vm.runInNewContext("gc");

async function collectGarbage() {
  for (let i = 0; i < 5; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    gc();
  }
}

describe("memory", () => {
  test("a reactive WeakMap read by an effect does not keep its keys alive", async () => {
    const map = proxy(new WeakMap<object, number>());
    let key: object | null = {};
    const ref = new WeakRef(key);
    map.set(key, 1);
    const dispose = effect(() => map.get(key!));
    dispose();
    key = null;
    await collectGarbage();
    expect(ref.deref()).toBeUndefined();
  });

  test("a reactive Map does not keep the object keys it deleted alive", async () => {
    const map = proxy(new Map<object, number>());
    const refs: WeakRef<object>[] = [];
    for (let i = 0; i < 10; i++) {
      const key = { i };
      refs.push(new WeakRef(key));
      map.set(key, i);
      effect(() => map.get(key))();
      map.delete(key);
    }
    await collectGarbage();
    expect(refs.filter((ref) => ref.deref())).toEqual([]);
  });
});

describe("objects a proxy cannot reach into", () => {
  class Secret {
    #value = 1;
    get value() {
      return this.#value;
    }
    set value(value: number) {
      this.#value = value;
    }
  }

  test("a private member read through a getter throws an OwlError naming the key and markRaw", () => {
    const state = proxy({ secret: new Secret() });
    let error: any;
    try {
      state.secret.value;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OwlError);
    expect(error.message).toContain('"value"');
    expect(error.message).toContain("markRaw(Secret.prototype)");
    expect(error.cause).toBeInstanceOf(TypeError);
  });

  test("a private member written through a setter throws the same OwlError", () => {
    const state = proxy({ secret: new Secret() });
    expect(() => (state.secret.value = 2)).toThrow("markRaw(Secret.prototype)");
  });

  test("markRaw of a built-in prototype throws instead of leaving every such object unobserved", () => {
    for (const proto of [
      Object.prototype,
      Array.prototype,
      Map.prototype,
      Set.prototype,
      WeakMap.prototype,
      Function.prototype,
    ]) {
      expect(() => markRaw(proto as any)).toThrow(OwlError);
    }
    const state = proxy({ plain: {}, list: [] as number[], map: new Map() });
    expect(toRaw(state.plain)).not.toBe(state.plain);
    expect(toRaw(state.list)).not.toBe(state.list);
    expect(toRaw(state.map)).not.toBe(state.map);
  });

  test("a private method called through a getter throws the same OwlError", () => {
    class Locked {
      #check() {
        return 1;
      }
      get checked() {
        return this.#check();
      }
    }
    const state = proxy({ locked: new Locked() });
    expect(() => state.locked.checked).toThrow("markRaw(Locked.prototype)");
  });

  test("a private member error the target's classes do not cause is rethrown as it is", () => {
    class Other {
      #field = 1;
      #method() {
        return 1;
      }
      static readField(o: Other) {
        return o.#field;
      }
      static callMethod(o: Other) {
        return o.#method();
      }
    }
    class Reader {
      get field() {
        return Other.readField({} as Other);
      }
      get method() {
        return Other.callMethod({} as Other);
      }
    }
    const state = proxy({ reader: new Reader() });
    for (const key of ["field", "method"] as const) {
      let raw: any;
      let reactive: any;
      try {
        new Reader()[key];
      } catch (e) {
        raw = e;
      }
      try {
        state.reader[key];
      } catch (e) {
        reactive = e;
      }
      expect(raw).toBeInstanceOf(TypeError);
      expect(reactive).toBeInstanceOf(TypeError);
      expect(reactive).not.toBeInstanceOf(OwlError);
      expect(reactive.message).toBe(raw.message);
    }
  });

  test("any other TypeError of a getter is rethrown as it is", () => {
    const error = new TypeError("Cannot read private member, said a message from user code");
    const state = proxy({
      get broken(): number {
        throw error;
      },
    });
    let thrown: unknown;
    try {
      state.broken;
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBe(error);
  });

  test("markRaw on a class prototype keeps every instance, a subclass's too, raw", () => {
    class Raw {
      #n = 1;
      n() {
        return this.#n;
      }
    }
    class SubRaw extends Raw {}
    markRaw(Raw.prototype);
    const instance = new Raw();
    const state = proxy({ instance, sub: new SubRaw(), list: [instance] });
    expect(state.instance).toBe(instance);
    expect(state.instance.n()).toBe(1);
    expect(toRaw(state.sub)).toBe(state.sub);
    expect(state.list[0]).toBe(instance);
    expect(proxy(instance)).toBe(instance);
  });

  test("markRaw on a plain object leaves the objects inheriting from it reactive", () => {
    const base = markRaw({ a: 1 });
    const child = Object.create(base);
    expect(proxy({ base }).base).toBe(base);
    expect(proxy({ child }).child).not.toBe(child);
  });

  test("markRaw on a proxy marks its raw object", () => {
    const state = proxy({ inner: { a: 1 }, holder: null as any });
    const inner = state.inner;
    expect(markRaw(inner)).toBe(inner);
    state.holder = inner;
    expect(state.holder).toBe(toRaw(inner));
    expect(state.inner).toBe(toRaw(inner));
  });
});

describe("proxy invariants: a locked property is handed out as it is", () => {
  test("a frozen object's values are raw", () => {
    const inner = { a: 1 };
    const state = proxy(Object.freeze({ inner }));
    expect(state.inner).toBe(inner);
  });

  test("a sealed object's values are proxied and tracked", async () => {
    const state = proxy(Object.seal({ inner: { a: 1 } }));
    const seen: number[] = [];
    effect(() => {
      seen.push(state.inner.a);
    });
    state.inner.a = 2;
    await waitScheduler();
    expect(seen).toEqual([1, 2]);
  });

  test("a non-configurable non-writable property of an extensible object is raw", () => {
    const inner = { a: 1 };
    const target = {};
    Object.defineProperty(target, "inner", { value: inner, writable: false, configurable: false });
    expect(Object.isExtensible(target)).toBe(true);
    expect((proxy(target) as any).inner).toBe(inner);
  });

  test("a non-configurable property locked after the proxy was made is raw", () => {
    const inner = { a: 1 };
    const target: any = { inner };
    const state = proxy(target);
    expect(state.inner).not.toBe(inner);
    Object.defineProperty(target, "inner", { writable: false, configurable: false });
    expect(state.inner).toBe(inner);
  });

  test("a property only non-configurable, or only non-writable, is proxied", () => {
    const target = {};
    Object.defineProperty(target, "sealed", {
      value: { a: 1 },
      writable: true,
      configurable: false,
    });
    Object.defineProperty(target, "readonly", {
      value: { a: 1 },
      writable: false,
      configurable: true,
    });
    const state = proxy(target) as any;
    expect(toRaw(state.sealed)).not.toBe(state.sealed);
    expect(toRaw(state.readonly)).not.toBe(state.readonly);
  });

  test("a locked property of a collection is raw", () => {
    const meta = { a: 1 };
    const map = new Map();
    Object.defineProperty(map, "meta", { value: meta, writable: false, configurable: false });
    expect((proxy(map) as any).meta).toBe(meta);
  });

  test("an observe() view of a frozen object holding a proxy hands the proxy out", () => {
    const inner = proxy({ a: 1 });
    const view = observe(Object.freeze({ inner }), () => {});
    expect(view.inner).toBe(inner);
  });

  test("an observe() view of a frozen array holding proxies hands them out", () => {
    const item = proxy({ a: 1 });
    const view = observe({ list: Object.freeze([item]) }, () => {});
    expect(view.list[0]).toBe(item);
  });
});

// the keys a write notified, from the reactivity debug channel
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

describe("writes", () => {
  test("a setter writing its backing field runs an immediate reader once per write", () => {
    class Box {
      _value = 0;
      get value() {
        return this._value;
      }
      set value(value: number) {
        this._value = value;
      }
    }
    const box = proxy({ box: new Box() }).box;
    let runs = 0;
    immediateEffect(() => {
      box.value;
      runs++;
    });
    box.value = 1;
    expect(runs).toBe(2);
    expect(box.value).toBe(1);
  });

  test("an inherited setter defining its backing field runs an immediate reader once per write", () => {
    const proto = {
      get value() {
        return (this as any)._value;
      },
      set value(value: number) {
        Object.defineProperty(this, "_value", { value, writable: true, configurable: true });
      },
    };
    const state: any = proxy({ item: Object.create(proto) }).item;
    let runs = 0;
    immediateEffect(() => {
      state.value;
      runs++;
    });
    state.value = 5;
    expect(runs).toBe(2);
    expect(state.value).toBe(5);
  });

  test("a write that fails, or creates a key with the value it inherited, notifies no reader of the value", () => {
    Object.defineProperty(Object.prototype, "lockedEverywhere", {
      value: 1,
      writable: false,
      configurable: true,
    });
    try {
      const state: any = proxy({});
      let runs = 0;
      immediateEffect(() => {
        state.constructor;
        state.lockedEverywhere;
        runs++;
      });
      expect(Reflect.set(state, "lockedEverywhere", 2)).toBe(false);
      expect(runs).toBe(1);
      state.constructor = Object;
      expect(runs).toBe(1);
      expect(Object.prototype.hasOwnProperty.call(toRaw(state), "constructor")).toBe(true);
    } finally {
      delete (Object.prototype as any).lockedEverywhere;
    }
  });

  test("a shallow array and a shallow object keep the proxy written into them", async () => {
    const item = proxy({ done: false });
    const list = signal.Array<any>([]);
    const obj = signal.Object<any>({});
    list().push(item);
    obj().item = item;
    expect(list()[0]).toBe(item);
    expect(obj().item).toBe(item);
    const seen: boolean[] = [];
    effect(() => {
      seen.push(list()[0].done);
    });
    list()[0].done = true;
    await waitScheduler();
    expect(seen).toEqual([false, true]);
  });

  test("a deep proxy still stores the raw object of a proxy written into it", () => {
    const item = proxy({ a: 1 });
    const state = proxy({ item: null as any });
    state.item = item;
    expect(toRaw(state).item).toBe(toRaw(item));
  });

  test("hasOwnProperty follows the presence of the key it asks about", async () => {
    const state = proxy({ a: 1 } as Record<string, number>);
    const seen: boolean[] = [];
    effect(() => {
      seen.push(state.hasOwnProperty("b"));
    });
    state.a = 2;
    state.c = 1;
    await waitScheduler();
    expect(seen).toEqual([false]);
    state.b = 1;
    await waitScheduler();
    delete state.b;
    await waitScheduler();
    expect(seen).toEqual([false, true, false]);
  });

  test("a write through a setter, or through an object inheriting from the proxy, still notifies", async () => {
    const state = proxy({
      _x: 1,
      set x(value: number) {
        this._x = value;
      },
    } as any);
    const seen: number[] = [];
    effect(() => {
      seen.push(state._x);
    });
    state.x = 2;
    await waitScheduler();
    const child = Object.create(state);
    child._x = 3;
    await waitScheduler();
    expect(seen).toEqual([1, 2]);
    expect(child._x).toBe(3);
    expect(state._x).toBe(2);
  });

  test("a write to a read-only or a non-extensible target fails as on the raw object", () => {
    const frozen = proxy(Object.freeze({ a: 1 }) as any);
    const sealed = proxy(Object.preventExtensions({ a: 1 }) as any);
    expect(Reflect.set(frozen, "a", 2)).toBe(false);
    expect(Reflect.set(sealed, "b", 2)).toBe(false);
    expect(Reflect.set(sealed, "a", 2)).toBe(true);
    expect(sealed.a).toBe(2);
  });

  test("a write to an object behind its own proxy reaches its set trap with the reactive proxy as receiver, and notifies once", async () => {
    // Odoo mail's records: a class instance behind a Proxy whose set trap
    // tells a write through the reactive proxy from an internal one by its
    // receiver; an internal write notifies on its own, through the proxy
    class Message {
      body = "";
    }
    let reactive: any;
    let internal = false;
    const receivers: string[] = [];
    const inner = new Proxy(new Message(), {
      set(target, key, value, receiver) {
        receivers.push(receiver === reactive ? "reactive" : "other");
        if (receiver !== reactive && !internal) {
          internal = true;
          try {
            reactive[key] = value;
          } finally {
            internal = false;
          }
          return true;
        }
        return Reflect.set(target, key, value, receiver);
      },
    });
    reactive = proxy(inner);
    const seen: string[] = [];
    immediateEffect(() => {
      seen.push(reactive.body);
    });
    reactive.body = "test";
    expect(receivers).toEqual(["reactive"]);
    expect(seen).toEqual(["", "test"]);
  });

  test("Object.defineProperty through a proxy defines on the target and notifies nothing (Odoo web_studio's activeNode)", async () => {
    // web_studio defines a label getter on a proxied field inside a computed:
    // notifying would re-run what read the field
    const field = proxy({ name: "a", label: "A" } as any);
    const labels: string[] = [];
    effect(() => {
      labels.push(field.label);
    });
    const node = computed(() => {
      Object.defineProperty(field, "label", { get: () => "B", configurable: true });
      return field.name;
    });
    effect(() => node());
    await waitScheduler();
    expect(labels).toEqual(["A"]);
    expect(toRaw(field).label).toBe("B");
    const item = proxy({ a: 1 });
    Object.defineProperty(field, "item", { value: item, configurable: true, writable: true });
    expect(toRaw(field).item).toBe(item);
  });

  test("a write notifies its key once, through the set trap only", () => {
    const state = proxy({ a: 1 } as any);
    effect(() => [state.a, Object.keys(state)]);
    expect(notifiedKeys(() => (state.a = 2))).toEqual(["a"]);
    expect(notifiedKeys(() => (state.b = 2))).toEqual(["(keys)"]);
  });

  test("a key created on an object holding a length notifies the key list only", () => {
    const state = proxy({ length: 1 } as any);
    effect(() => [state.length, Object.keys(state)]);
    expect(notifiedKeys(() => (state.b = 1))).toEqual(["(keys)"]);
    const list = proxy([1] as any);
    effect(() => [list.length, Object.keys(list)]);
    expect(notifiedKeys(() => (list[1] = 2))).toEqual(["(keys)", "length"]);
    expect(notifiedKeys(() => (list.extra = 1))).toEqual(["(keys)"]);
  });

  test("a push notifies the length once; a length written to itself notifies nothing", () => {
    const list = proxy([1, 2]);
    effect(() => [list.length, list[2]]);
    expect(notifiedKeys(() => list.push(3)).filter((key) => key === "length")).toEqual(["length"]);
    expect(notifiedKeys(() => (list.length = 3))).toEqual([]);
  });
});

describe("collections", () => {
  test("a getter of a Map subclass reads the entries through the proxy", async () => {
    class Totals extends Map<string, number> {
      get total() {
        let sum = 0;
        for (const value of this.values()) {
          sum += value;
        }
        return sum;
      }
    }
    const totals = proxy(new Totals([["a", 1]]));
    const seen: number[] = [];
    effect(() => {
      seen.push(totals.total);
    });
    totals.set("b", 2);
    await waitScheduler();
    expect(seen).toEqual([1, 3]);
  });

  test("a property of a collection and an entry of the same name are apart", async () => {
    const map: any = proxy(new Map([["foo", 1]]));
    map.foo = 0;
    let entryRuns = 0;
    let propertyRuns = 0;
    effect(() => {
      entryRuns++;
      map.get("foo");
    });
    effect(() => {
      propertyRuns++;
      map.foo;
    });
    map.foo = 7;
    await waitScheduler();
    expect([entryRuns, propertyRuns]).toEqual([1, 2]);
    map.set("foo", 2);
    await waitScheduler();
    expect([entryRuns, propertyRuns]).toEqual([2, 2]);
  });

  test("hasOwnProperty taken from a collection outside any computation still observes the property", async () => {
    const map: any = proxy(new Map());
    const hasOwn = map.hasOwnProperty;
    const seen: boolean[] = [];
    effect(() => {
      seen.push(hasOwn.call(map, "foo"));
    });
    map.set("foo", 1);
    await waitScheduler();
    expect(seen).toEqual([false]);
    map.foo = 1;
    await waitScheduler();
    expect(seen).toEqual([false, true]);
  });

  test("`in`, Object.keys and delete on a collection observe its properties, not its entries", async () => {
    const map: any = proxy(new Map());
    const seen: unknown[] = [];
    effect(() => {
      seen.push("foo" in map, Object.keys(map).length);
    });
    map.set("foo", 1);
    await waitScheduler();
    expect(seen).toEqual([false, 0]);
    map.foo = 1;
    await waitScheduler();
    delete map.foo;
    await waitScheduler();
    expect(seen).toEqual([false, 0, true, 1, false, 0]);
  });

  test("hasOwnProperty is the first property read of a collection: it observes the property, not the entry", async () => {
    const map: any = proxy(new Map());
    const seen: boolean[] = [];
    effect(() => {
      seen.push(map.hasOwnProperty("foo"));
    });
    map.set("foo", 1);
    await waitScheduler();
    expect(seen).toEqual([false]);
    map.foo = 1;
    await waitScheduler();
    expect(seen).toEqual([false, true]);
  });

  test("a set operation rejects what is not set-like, as the native one does", () => {
    if (!("union" in Set.prototype)) {
      return;
    }
    const set: any = proxy(new Set([1, 2]));
    for (const other of [[1, 2], null, { size: 1, has: () => true }, { size: NaN }]) {
      let native: any;
      let reactive: any;
      try {
        (new Set([1, 2]) as any).union(other);
      } catch (e) {
        native = e;
      }
      try {
        set.union(other);
      } catch (e) {
        reactive = e;
      }
      expect(reactive?.constructor).toBe(native?.constructor);
      expect(native).toBeDefined();
    }
  });

  test("a set operation reads a set-like through its keys iterator", () => {
    if (!("union" in Set.prototype)) {
      return;
    }
    const set: any = proxy(new Set([1, 2]));
    let index = 0;
    const setLike = {
      size: 2,
      has: (value: number) => value === 2 || value === 3,
      keys: () => ({
        next: () =>
          index < 2 ? { value: [2, 3][index++], done: false } : { value: undefined, done: true },
      }),
    };
    expect([...set.union(setLike)]).toEqual([1, 2, 3]);
  });

  test("a map proxy, or a view of one, has no add method, as a map has none", () => {
    const map: any = proxy(new Map());
    expect(map.add).toBeUndefined();
    expect((observe(new Map(), () => {}) as any).add).toBeUndefined();
    expect(typeof (proxy(new Set()) as any).add).toBe("function");
  });

  test("forEach hands out the proxy it was called through", () => {
    const shallow = signal.Map(new Map([["a", 1]]));
    const deep = proxy(new Map([["a", 1]]));
    let third: any;
    shallow().forEach((_value, _key, map) => (third = map));
    expect(third).toBe(shallow());
    deep.forEach((_value, _key, map) => (third = map));
    expect(third).toBe(deep);
  });

  test("clearing an empty collection notifies nothing", () => {
    const set = proxy(new Set<number>());
    effect(() => set.size);
    expect(notifiedKeys(() => set.clear())).toEqual([]);
  });

  test("iterating a set or a map yields the proxies of its objects", () => {
    const item = { a: 1 };
    const set = proxy(new Set([item]));
    const map = proxy(new Map([[item, item]]));
    const pItem = proxy(item);
    expect([...set]).toEqual([pItem]);
    expect([...set.values()][0]).toBe(pItem);
    expect([...set.entries()][0]).toEqual([pItem, pItem]);
    expect([...map.keys()][0]).toBe(pItem);
    expect([...map.values()][0]).toBe(pItem);
    const [key, value] = [...map][0];
    expect(key).toBe(pItem);
    expect(value).toBe(pItem);
  });

  test("a map write notifies its key's value and presence only when they change", () => {
    const map = proxy(new Map([["a", 1]]));
    effect(() => [map.get("a"), map.has("a"), map.get("b"), map.has("b")]);
    expect(notifiedKeys(() => map.set("a", 1))).toEqual([]);
    expect(notifiedKeys(() => map.set("a", 2))).toEqual(["a"]);
    expect(notifiedKeys(() => map.set("b", 1))).toEqual(["b", "b"]);
    expect(notifiedKeys(() => map.delete("b"))).toEqual(["b", "b"]);
    expect(notifiedKeys(() => map.delete("b"))).toEqual([]);
  });
});

describe("array searches", () => {
  test("a search subscribes to the items as one atom, not to each index", () => {
    const list = proxy([{ a: 1 }, { a: 2 }, { a: 3 }] as any[]);
    effect(() => list.includes(99));
    expect(notifiedKeys(() => (list[1] = 0))).toEqual([]);
  });

  test("a search re-runs when an item is added, replaced or removed", async () => {
    const item = { a: 1 };
    const list = proxy([] as any[]);
    const seen: number[] = [];
    effect(() => {
      seen.push(list.indexOf(item));
    });
    list.push(item);
    await waitScheduler();
    list.unshift(0);
    await waitScheduler();
    list[1] = 0;
    await waitScheduler();
    list.length = 0;
    await waitScheduler();
    expect(seen).toEqual([-1, 0, 1, -1, -1]);
  });

  test("a search finds an item by its raw object or its proxy, from an index", () => {
    const item = { a: 1 };
    const list = proxy([item, 1, item]);
    expect(list.includes(item)).toBe(true);
    expect(list.includes(list[0])).toBe(true);
    expect(list.indexOf(list[0])).toBe(0);
    expect(list.indexOf(item, 1)).toBe(2);
    expect(list.lastIndexOf(list[0])).toBe(2);
    expect(list.lastIndexOf(item, 1)).toBe(0);
    expect(list.includes(NaN as any)).toBe(false);
    expect(proxy([NaN]).includes(NaN)).toBe(true);
  });

  test("a search on an array subclass behind its own proxy reads through it, tracked", async () => {
    // Odoo mail's RecordList shape: an Array subclass holding its items in
    // `data`, behind a Proxy that maps an index read to receiver.data[index]
    class List extends Array {
      data: any[] = [];
    }
    const inner = new Proxy(new List(), {
      get(target, key, receiver) {
        if (key === "length") {
          return receiver.data.length;
        }
        if (typeof key === "string" && /^\d+$/.test(key)) {
          return receiver.data[key];
        }
        return Reflect.get(target, key, receiver);
      },
      has(target, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          return Number(key) < target.data.length;
        }
        return Reflect.has(target, key);
      },
    });
    const list = proxy(inner) as any;
    const item = { a: 1 };
    const seen: unknown[] = [];
    effect(() => {
      seen.push(list.includes(item), list.indexOf(item));
    });
    list.data.push(item);
    await waitScheduler();
    expect(seen).toEqual([false, -1, true, 0]);
  });

  test("a search through an observe() view observes the items", () => {
    let calls = 0;
    const list = proxy([1, 2]);
    const view = observe(list, () => calls++);
    expect(view.includes(3)).toBe(false);
    list.push(3);
    expect(calls).toBe(1);
  });
});
