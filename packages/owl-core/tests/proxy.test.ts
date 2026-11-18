import v8 from "node:v8";
import vm from "node:vm";
import {
  atomSymbol,
  computed,
  effect,
  immediateEffect,
  markRaw,
  observe,
  OwlError,
  proxy,
  readArrayItems,
  setDebug,
  setDebugSink,
  signal,
  sourcesOf,
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
  let traces: string[];
  beforeEach(() => {
    traces = [];
    setDebugSink((channel, message) => traces.push(`${channel}: ${message}`));
    setDebug(["reactivity", "effect"]);
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") console.debug("[owl:weak-key-lifetime]", traces);
    setDebug(false);
    setDebugSink(null);
  });

  describe.each(["native", "proxy"] as const)("%s WeakMap", (view) => {
    test.each(["get", "has", "getOrInsert", "getOrInsertComputed"] as const)(
      "%s does not keep object or symbol keys alive",
      async (method) => {
        for (const kind of ["object", "symbol"] as const) {
          const raw = new WeakMap<WeakKey, number>();
          const map = view === "proxy" ? proxy(raw) : raw;
          let key: WeakKey | null = kind === "symbol" ? Symbol("weak key") : {};
          const ref = new WeakRef(key);
          map.set(key, 1);
          const dispose = effect(() => {
            if (method === "get") return map.get(key!);
            if (method === "has") return map.has(key!);
            if (method === "getOrInsert") return map.getOrInsert(key!, 2);
            return map.getOrInsertComputed(key!, () => 2);
          });
          dispose();
          key = null;
          await collectGarbage();
          expect(map.has(Symbol("absent"))).toBe(false);
          console.debug("[owl:weak-key-lifetime]", {
            view,
            method,
            kind,
            collected: ref.deref() === undefined,
          });
          expect(ref.deref()).toBeUndefined();
        }
      }
    );
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

  test("the member an error names is matched as a whole private name, $ and non-ASCII letters included", () => {
    class Other {
      #field = 1;
      static readField(o: Other) {
        return o.#field;
      }
    }
    class Named {
      #count$ = 1;
      #café = 2;
      #fieldX = 3;
      get count() {
        return this.#count$;
      }
      get café() {
        return this.#café;
      }
      get other() {
        return Other.readField({} as Other) + this.#fieldX;
      }
    }
    const state = proxy({ named: new Named() });
    expect(() => state.named.count).toThrow("markRaw(Named.prototype)");
    expect(() => state.named.café).toThrow("markRaw(Named.prototype)");
    let error: any;
    try {
      state.named.other;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(OwlError);
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

  test("a write through a setter whose getter throws until it was set succeeds, observed or not", () => {
    class Lazy {
      _value: number | undefined = undefined;
      get value(): number {
        if (this._value === undefined) {
          throw new Error("not set yet");
        }
        return this._value;
      }
      set value(value: number) {
        this._value = value;
      }
    }
    const state = proxy({ item: new Lazy(), other: new Lazy() });
    state.other.value = 1;
    expect(state.other.value).toBe(1);
    const item = state.item;
    const seen: unknown[] = [];
    immediateEffect(() => {
      seen.push(item._value);
      try {
        seen.push(item.value);
      } catch {
        seen.push("threw");
      }
    });
    item.value = 2;
    expect(item.value).toBe(2);
    expect(seen).toEqual([undefined, "threw", 2, 2]);
  });

  test("a write through a setter calls its getter only when the key is observed", () => {
    let reads = 0;
    class Box {
      _value = 0;
      get value() {
        reads++;
        return this._value;
      }
      set value(value: number) {
        this._value = value;
      }
    }
    const box = proxy({ box: new Box() }).box;
    immediateEffect(() => box._value);
    box.value = 1;
    expect(reads).toBe(0);
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

  test("a set operation reads only what the native one reads of its argument", () => {
    if (!("union" in Set.prototype)) {
      return;
    }
    const reads: string[] = [];
    const endless = {
      get size() {
        reads.push("size");
        return Infinity;
      },
      get has() {
        reads.push("has");
        return () => true;
      },
      get keys() {
        reads.push("keys");
        return () => {
          throw new Error("keys read");
        };
      },
    };
    const set: any = proxy(new Set([1, 2]));
    expect((new Set([1, 2]) as any).isSubsetOf(endless)).toBe(true);
    const native = reads.splice(0);
    expect(set.isSubsetOf(endless)).toBe(true);
    expect(set.intersection(endless).size).toBe(2);
    expect(reads.splice(0)).toEqual([...native, ...native]);
    expect(() => set.union(endless)).toThrow("keys read");
  });

  test("a set operation answers as on the raw sets, each member as its set holds it, in order", () => {
    if (!("union" in Set.prototype)) {
      return;
    }
    const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => ({ id }));
    const deep: any = proxy(new Set([a, b, c]));
    const shallow: any = signal.Set(new Set([proxy(d), proxy(c), proxy(b)]))();
    const plain = new Set([c, b]);
    const ids = (result: any) =>
      typeof result === "boolean"
        ? result
        : [...result].map((m: any) => m.id + (toRaw(m) === m ? "" : "*")).join("");
    const operations = [
      "union",
      "intersection",
      "difference",
      "symmetricDifference",
      "isSubsetOf",
      "isSupersetOf",
      "isDisjointFrom",
    ];
    const answers = (set: any, other: any) => operations.map((name) => ids(set[name](other)));
    expect(answers(deep, shallow)).toEqual(["abcd*", "bc", "a", "ad*", false, false, false]);
    expect(answers(deep, plain)).toEqual(["abc", "bc", "a", "a", false, true, false]);
    expect(answers(shallow, deep)).toEqual(["d*c*b*a*", "c*b*", "d*", "d*a*", false, false, false]);
    expect(answers(shallow, plain)).toEqual(["d*c*b*", "c*b*", "d*", "d*", false, true, false]);
    expect(answers(proxy(new Set([b])), deep)).toEqual([
      "ba*c*",
      "b",
      "",
      "a*c*",
      true,
      false,
      false,
    ]);
    expect(answers(proxy(new Set([d])), plain)).toEqual([
      "dcb",
      "",
      "d",
      "dcb",
      false,
      false,
      true,
    ]);
  });

  test("a set operation observes the set and a reactive argument", async () => {
    if (!("union" in Set.prototype)) {
      return;
    }
    const mine: any = proxy(new Set([1]));
    const theirs: any = proxy(new Set([2]));
    const seen: number[] = [];
    effect(() => {
      seen.push(mine.union(theirs).size);
    });
    mine.add(3);
    await waitScheduler();
    theirs.add(4);
    await waitScheduler();
    expect(seen).toEqual([2, 3, 4]);
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

  test("forEach called unbound hands out the proxy it was read from", () => {
    const shallow = signal.Map(new Map([["a", 1]]));
    const deep = proxy(new Map([["a", 1]]));
    let third: any;
    const shallowForEach = shallow().forEach;
    shallowForEach((_value, _key, map) => (third = map));
    expect(third).toBe(shallow());
    const deepForEach = deep.forEach;
    deepForEach((_value, _key, map) => (third = map));
    expect(third).toBe(deep);
  });

  test("clearing a collection notifies the key list and each observed key, value or presence", () => {
    const key = { k: 1 };
    const map = proxy(
      new Map<any, number>([
        ["a", 1],
        [key, 2],
        ["b", 3],
      ])
    );
    effect(() => [map.get("a"), map.has(key), map.size]);
    expect(notifiedKeys(() => map.clear())).toEqual(["(keys)", "a", "presence of [object Object]"]);
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
    expect(notifiedKeys(() => map.set("b", 1))).toEqual(["presence of b", "b"]);
    expect(notifiedKeys(() => map.delete("b"))).toEqual(["presence of b", "b"]);
    expect(notifiedKeys(() => map.delete("b"))).toEqual([]);
  });
});

describe("array searches", () => {
  test("a search subscribes to the items as one atom, not to each index", () => {
    const list = proxy([{ a: 1 }, { a: 2 }, { a: 3 }] as any[]);
    effect(() => list.includes(99));
    expect(notifiedKeys(() => (list[1] = 0))).toEqual(["items"]);
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

  test("a search through an observe() view observes the items", () => {
    let calls = 0;
    const list = proxy([1, 2]);
    const view = observe(list, () => calls++);
    expect(view.includes(3)).toBe(false);
    list.push(3);
    expect(calls).toBe(1);
  });
});

describe("writes nobody observes", () => {
  test("a key whose last reader is gone is written as if it was never read", async () => {
    const map = proxy(new Map<string, number>());
    const stop = effect(() => {
      for (let i = 0; i < 100; i++) {
        map.get(`k${i}`);
      }
      void map.size;
    });
    expect(notifiedKeys(() => map.set("k0", 1))).toEqual(["(keys)", "k0"]);
    stop();
    expect(notifiedKeys(() => map.set("k1", 1))).toEqual([]);
    expect(notifiedKeys(() => map.clear())).toEqual([]);

    const state = proxy<any>({ a: 1, b: 1 });
    const flag = signal(true);
    effect(() => (flag() ? state.a : state.b));
    expect(notifiedKeys(() => (state.a = 2))).toEqual(["a"]);
    flag.set(false);
    await waitScheduler();
    expect(notifiedKeys(() => (state.a = 3))).toEqual([]);
    expect(notifiedKeys(() => (state.b = 2))).toEqual(["b"]);
  });

  test("a setter's getter is not called once the key's last reader is disposed", () => {
    let reads = 0;
    class Box {
      _value = 0;
      get value() {
        reads++;
        return this._value;
      }
      set value(value: number) {
        this._value = value;
      }
    }
    const box = proxy({ box: new Box() }).box;
    const stop = immediateEffect(() => box.value);
    stop();
    reads = 0;
    box.value = 1;
    expect(reads).toBe(0);
  });

  test("an object written before anything reads it notifies once something does", () => {
    const state = proxy<any>({});
    state.a = 1;
    state.b = { c: 2 };
    let seen: number[] = [];
    immediateEffect(() => {
      seen.push(state.a + state.b.c);
    });
    state.a = 10;
    state.b.c = 20;
    expect(seen).toEqual([3, 12, 30]);
    expect(toRaw(state).b).toBe(toRaw(state.b));
  });

  test("an own setter of a plain object still runs on the proxy", () => {
    const state = proxy<any>({
      _x: 0,
      get x() {
        return this._x;
      },
      set x(value: number) {
        this._x = value;
      },
    });
    const seen: number[] = [];
    immediateEffect(() => {
      seen.push(state._x);
    });
    state.x = 5;
    expect(seen).toEqual([0, 5]);
  });

  test("a setter on a class prototype still runs on the proxy", () => {
    class Counter {
      _n = 0;
      set n(value: number) {
        this._n = value;
      }
    }
    const counter = proxy(new Counter());
    const seen: number[] = [];
    immediateEffect(() => {
      seen.push(counter._n);
    });
    counter.n = 3;
    expect(seen).toEqual([0, 3]);
  });

  test("an array grown before anything reads it notifies once something does", () => {
    const list = proxy<number[]>([]);
    list.push(1, 2);
    const seen: number[] = [];
    immediateEffect(() => {
      seen.push(list.length);
    });
    list.push(3);
    list.length = 1;
    expect(seen).toEqual([2, 3, 1]);
    expect(toRaw(list)).toEqual([1]);
  });

  test("a frozen or non-writable target refuses the write as before", () => {
    const frozen = proxy<any>(Object.freeze({ a: 1 }));
    expect(Reflect.set(frozen, "a", 2)).toBe(false);
    expect(Reflect.set(frozen, "b", 2)).toBe(false);
    const locked = proxy<any>({});
    Object.defineProperty(toRaw(locked), "k", { value: 1, writable: false });
    expect(Reflect.set(locked, "k", 2)).toBe(false);
    expect(toRaw(locked).k).toBe(1);
  });

  test("a write through __proto__ still sets the target's prototype", () => {
    const proto = { inherited: true };
    const state = proxy<any>({});
    state.__proto__ = proto;
    expect(Object.getPrototypeOf(toRaw(state))).toBe(proto);
    expect(state.inherited).toBe(true);
  });
});

describe("what markRaw and the private member errors say", () => {
  test("markRaw of a built-in prototype says why it is refused", () => {
    expect(() => markRaw(Map.prototype)).toThrow(
      "markRaw(Map.prototype) would leave every Map unobserved: mark the objects themselves, " +
        "or the prototype of a class of your own"
    );
  });

  test("markRaw on an object that is not a class prototype leaves the objects inheriting from it reactive", () => {
    function Detached() {}
    Detached.prototype = Object.create({ constructor: Detached });
    const marked = [
      markRaw({ constructor: null }),
      markRaw({ constructor: Object }),
      markRaw(Detached.prototype),
    ];
    for (const base of marked) {
      const child = Object.create(base);
      expect(proxy({ child }).child).not.toBe(child);
    }
  });

  test("an object without a prototype is reactive while a class prototype is marked raw", () => {
    class Marked {}
    markRaw(Marked.prototype);
    const bare = Object.assign(Object.create(null), { a: 1 });
    const state = proxy({ bare });
    expect(state.bare).not.toBe(bare);
    expect(state.bare.a).toBe(1);
  });

  test("a private member error of an anonymous class, or of one hiding its constructor, names TheClass", () => {
    const Anonymous = [
      class {
        #value = 1;
        get value() {
          return this.#value;
        }
      },
    ][0];
    class Hiding {
      #value = 1;
      constructor() {
        (this as any).constructor = undefined;
      }
      get value() {
        return this.#value;
      }
    }
    for (const instance of [new Anonymous(), new Hiding()]) {
      expect(() => proxy({ instance }).instance.value).toThrow("markRaw(TheClass.prototype)");
    }
  });

  test("a private member error without a member or class name, as Firefox words it, is explained", () => {
    class Guarded {
      #value = 1;
      get value(): number {
        throw new TypeError("can't access private field or method: object is not the right class");
      }
      read() {
        return this.#value;
      }
    }
    const state = proxy({ guarded: new Guarded() });
    expect(() => state.guarded.value).toThrow(OwlError);
  });

  test("a private member error worded as Safari words it is explained with the member it names", () => {
    class Vault {
      #secret = 1;
      get value(): number {
        throw new TypeError("Cannot access invalid private field (evaluating 'this.#secret')");
      }
      read() {
        return this.#secret;
      }
    }
    const state = proxy({ vault: new Vault() });
    expect(() => state.vault.value).toThrow("markRaw(Vault.prototype)");
    expect(() => state.vault.value).toThrow(OwlError);
  });

  test("a TypeError that only quotes a private member error further in is left as it is", () => {
    class Quoting {
      #value = 1;
      get value(): number {
        throw new TypeError(
          "value failed: Cannot read private member #value from an object whose class did not declare it"
        );
      }
      read() {
        return this.#value;
      }
    }
    const state = proxy({ quoting: new Quoting() });
    let error: unknown;
    try {
      state.quoting.value;
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(OwlError);
  });

  test("a private member error is explained through a prototype that is no class's", () => {
    class Secret {
      #value = 1;
      get value() {
        return this.#value;
      }
    }
    const between = Object.create(Secret.prototype);
    const state = proxy({ item: Object.create(between) });
    expect(() => state.item.value).toThrow("markRaw(Secret.prototype)");
  });
});

describe("accessors", () => {
  test("a write nobody reads does not read the old value through an accessor", () => {
    let reads = 0;
    class Box {
      _value = 0;
      get value(): number {
        reads++;
        return this._value;
      }
      set value(value: number) {
        this._value = value;
      }
    }
    const box = proxy(new Box());
    box.value = 1;
    expect(toRaw(box)._value).toBe(1);
    class Slots extends Array {
      stored: unknown;
      get [0](): unknown {
        reads++;
        return this.stored;
      }
      set [0](value: unknown) {
        this.stored = value;
      }
    }
    const slots = proxy(new Slots());
    slots[0] = 1;
    expect(toRaw(slots).stored).toBe(1);
    expect(reads).toBe(0);
  });

  test("a non-configurable accessor with a getter hands out a proxy", () => {
    const inner = { a: 1 };
    const target = {};
    Object.defineProperty(target, "inner", { get: () => inner, configurable: false });
    const value = (proxy(target) as any).inner;
    expect(value).not.toBe(inner);
    expect(toRaw(value)).toBe(inner);
  });

  test("a write through a setter whose getter always throws notifies the readers of the key", () => {
    class Opaque {
      _value = 0;
      get value(): number {
        throw new Error("write-only");
      }
      set value(value: number) {
        this._value = value;
      }
    }
    const item = proxy({ item: new Opaque() }).item;
    let runs = 0;
    immediateEffect(() => {
      runs++;
      try {
        item.value;
      } catch {
        // the getter always throws
      }
    });
    item.value = 1;
    expect(runs).toBe(2);
  });

  test("a write inside an effect stores the value", async () => {
    const state = proxy({ a: 1, b: 0 });
    effect(() => {
      state.b = state.a * 2;
    });
    expect(state.b).toBe(2);
    state.a = 2;
    await waitScheduler();
    expect(toRaw(state).b).toBe(4);
  });
});

describe("key atoms", () => {
  test("the sources of a reader of a proxy are key atoms naming their key", () => {
    const state = proxy({ a: 1 });
    const reader = computed(() => state.a);
    reader();
    expect(
      sourcesOf((reader as any)[atomSymbol]).map((atom: any) => [atom.type, atom.key])
    ).toEqual([["key", "a"]]);
  });

  test("the item and key atoms of an array are released apart", async () => {
    const list = proxy([1, 2]);
    let keyRuns = 0;
    effect(() => {
      keyRuns++;
      Object.keys(list);
    });
    const stopItems = effect(() => readArrayItems(list));
    stopItems();
    list.push(3);
    await waitScheduler();
    expect(keyRuns).toBe(2);
  });

  test("the item atom of an array read again after its release notifies its new reader", async () => {
    const list = proxy([1, 2]);
    effect(() => readArrayItems(list))();
    let runs = 0;
    effect(() => {
      runs++;
      readArrayItems(list);
    });
    list[0] = 5;
    await waitScheduler();
    expect(runs).toBe(2);
  });

  test("a Map read with a null key notifies its reader", async () => {
    const map = proxy(new Map<unknown, number>());
    const seen: unknown[] = [];
    effect(() => {
      seen.push(map.get(null), map.has(null));
    });
    map.set(null, 1);
    await waitScheduler();
    expect(seen).toEqual([undefined, false, 1, true]);
  });

  test("clear notifies an object key's reader after the reader of another key went away", async () => {
    const key = {};
    const map = proxy(
      new Map<unknown, number>([
        [key, 1],
        ["a", 2],
        ["b", 3],
      ])
    );
    const seen: unknown[] = [];
    effect(() => {
      seen.push(map.get(key));
    });
    effect(() => map.get("a"))();
    map.clear();
    await waitScheduler();
    expect(seen).toEqual([1, undefined]);
  });

  test("clear notifies the keys read in the order first read, when fewer than the entries", () => {
    const entries = () =>
      new Map([
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
      ]);
    const map = proxy(entries());
    effect(() => map.get("b"));
    effect(() => map.get("a"));
    expect(notifiedKeys(() => map.clear())).toEqual(["b", "a"]);
    const sized = proxy(entries());
    effect(() => sized.size);
    effect(() => sized.get("b"));
    effect(() => sized.get("a"));
    expect(notifiedKeys(() => sized.clear())).toEqual(["(keys)", "b", "a"]);
  });

  test("clear notifies the keys in the collection's order once every entry is read", () => {
    const map = proxy(
      new Map([
        ["a", 1],
        ["b", 2],
      ])
    );
    effect(() => map.get("b"));
    effect(() => map.get("a"));
    expect(notifiedKeys(() => map.clear())).toEqual(["a", "b"]);
  });

  test("clear notifies in the order first read once the readers of an object key are gone", () => {
    const key = {};
    const map = proxy(
      new Map<unknown, number>([
        [key, 0],
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
      ])
    );
    effect(() => [map.get(key), map.has(key)])();
    effect(() => map.get("b"));
    effect(() => map.get("a"));
    expect(notifiedKeys(() => map.clear())).toEqual(["b", "a"]);
  });

  test.each([
    ["an object", {}],
    ["a symbol", Symbol("key")],
    ["a function", function key() {}],
  ])("clear notifies in the collection's order while %s key is read", (_, key) => {
    const map = proxy(
      new Map<unknown, number>([
        ["a", 1],
        [key, 2],
        ["b", 3],
        ["c", 4],
      ])
    );
    effect(() => map.get("b"));
    effect(() => map.get(key));
    expect(notifiedKeys(() => map.clear())).toEqual([String(key), "b"]);
  });

  test("clear of a collection nobody read empties it", () => {
    const map = proxy(new Map([[1, 1]]));
    map.clear();
    expect(map.size).toBe(0);
  });

  test("clear of a collection read by fewer keys than it holds notifies exactly the readers of its keys", async () => {
    const map = proxy(
      new Map([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ])
    );
    const runs = { a: 0, absent: 0 };
    effect(() => {
      runs.a++;
      map.get("a");
    });
    effect(() => {
      runs.absent++;
      map.get("absent");
    });
    expect(notifiedKeys(() => map.clear())).toEqual(["a"]);
    await waitScheduler();
    expect(runs).toEqual({ a: 2, absent: 1 });
  });
});

describe("arrays shrinking and growing", () => {
  test("a shrink by more indices than atoms notifies the dropped ones read, in the order they were first read", () => {
    const list: any = proxy(Array.from({ length: 10 }, (_, i) => i));
    effect(() => [list[5], list[1], list[0], list[10], list[12], list["01"]]);
    expect(notifiedKeys(() => (list.length = 1))).toEqual(["5", "1"]);
  });

  test("a shrink by as many indices as atoms notifies the dropped ones in index order", () => {
    const list = proxy([0, 1, 2]);
    effect(() => list[2]);
    effect(() => list[1]);
    expect(notifiedKeys(() => (list.length = 1))).toEqual(["1", "2"]);
  });

  test("a shrink notifies the dropped indices only, read by more atoms than it drops", () => {
    const list = proxy([0, 1, 2]);
    effect(() => [list[0], list[2], list[3]]);
    effect(() => list[1]);
    expect(notifiedKeys(() => (list.length = 1))).toEqual(["1", "2"]);
  });

  test("a shrink notifies the presence of the dropped indices", async () => {
    const list = proxy([0, 1, 2]);
    const seen: boolean[] = [];
    effect(() => {
      seen.push(2 in list);
    });
    list.length = 1;
    await waitScheduler();
    expect(seen).toEqual([true, false]);
  });

  test("a shrink with a registered symbol key read notifies as usual", () => {
    const tag = Symbol.for("owl test tag");
    const list: any = proxy([0, 1, 2, 3]);
    effect(() => [list[tag], list[3]]);
    expect(notifiedKeys(() => (list.length = 1))).toEqual(["3"]);
  });

  test("a shrink notifies the key list", () => {
    const list = proxy([0, 1, 2]);
    effect(() => Object.keys(list));
    expect(notifiedKeys(() => (list.length = 1))).toEqual(["(keys)"]);
  });

  test("a growing length notifies the length, not the key list", () => {
    const list = proxy([0]);
    effect(() => [list.length, Object.keys(list)]);
    expect(notifiedKeys(() => (list.length = 3))).toEqual(["length"]);
  });

  test("a length set without a reader, with the reactivity channel on, drops the items", () => {
    const list = proxy([0, 1, 2]);
    setDebugSink(() => {});
    setDebug(["reactivity"]);
    try {
      list.length = 1;
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(toRaw(list)).toEqual([0]);
  });
});

describe("deleting keys", () => {
  test("delete notifies the reader of the value, and nothing when the key was absent", async () => {
    const state = proxy({ a: 1 } as any);
    let valueRuns = 0;
    let keyRuns = 0;
    effect(() => {
      valueRuns++;
      state.a;
    });
    effect(() => {
      keyRuns++;
      Object.keys(state);
    });
    delete state.missing;
    await waitScheduler();
    expect([valueRuns, keyRuns]).toEqual([1, 1]);
    delete state.a;
    await waitScheduler();
    expect([valueRuns, keyRuns]).toEqual([2, 2]);
  });

  test("hasOwnProperty of a symbol or a number follows that key", async () => {
    const tag = Symbol("tag");
    const state = proxy({} as any);
    const seen: boolean[] = [];
    effect(() => {
      seen.push(state.hasOwnProperty(tag), state.hasOwnProperty(1));
    });
    state[tag] = 1;
    await waitScheduler();
    state[1] = 1;
    await waitScheduler();
    expect(seen).toEqual([false, false, true, false, true, true]);
  });
});

describe("array searches of proxies", () => {
  test("a search finds a proxy the array was made with", () => {
    const item = proxy({ a: 1 });
    const list = proxy([item]);
    expect(list.includes(item)).toBe(true);
    expect(list.indexOf(item)).toBe(0);
  });

  test("an array subclass's search observes only the indices it reads", async () => {
    class List<T> extends Array<T> {}
    const list = proxy(List.from([1, 2]) as List<number>);
    let runs = 0;
    effect(() => {
      runs++;
      list.indexOf(1);
    });
    list[1] = 3;
    await waitScheduler();
    expect(runs).toBe(1);
  });
});

describe("collection reads and writes, key by key", () => {
  test("iterating keys follows the key list, not the values; iterating values follows each value", () => {
    const map = proxy(new Map([["a", 1]]));
    const stopKeys = effect(() => [...map.keys()]);
    expect(notifiedKeys(() => map.set("a", 2))).toEqual([]);
    stopKeys();
    const stopValues = effect(() => [...map.values()]);
    expect(notifiedKeys(() => map.set("a", 3))).toEqual(["a"]);
    stopValues();
    effect(() => map.forEach(() => {}));
    expect(notifiedKeys(() => map.set("a", 4))).toEqual(["a"]);
    expect(notifiedKeys(() => map.set("b", 1))).toEqual(["(keys)"]);
  });

  test("iterating or visiting a Set follows its member list only", () => {
    const set = proxy(new Set(["x", "y"]));
    effect(() => [...set.entries()]);
    effect(() => set.forEach(() => {}));
    expect(notifiedKeys(() => set.delete("x"))).toEqual(["(keys)"]);
  });

  test("a shallow Map hands its entries out as stored", () => {
    const item = { a: 1 };
    const map = signal.Map(new Map([["k", item]]))();
    expect([...map.entries()][0][1]).toBe(item);
    expect([...map][0][1]).toBe(item);
  });

  test("the size of a WeakMap is a plain property, not its key list", () => {
    const map: any = proxy(new WeakMap());
    let runs = 0;
    effect(() => {
      runs++;
      map.size;
    });
    expect(notifiedKeys(() => map.set({}, 1))).toEqual([]);
    expect(runs).toBe(1);
  });

  test("a collection method is the same function each time, even with an own property of that name", async () => {
    const raw = new Map([["a", 1]]);
    (raw as any).get = function (this: Map<string, number>, key: string) {
      return Map.prototype.get.call(this, key);
    };
    const map = proxy(raw);
    expect(map.get).toBe(map.get);
    const seen: unknown[] = [];
    effect(() => {
      seen.push(map.get("a"));
    });
    map.set("a", 2);
    await waitScheduler();
    expect(seen).toEqual([1, 2]);
  });

  test("deleting a Map key whose value was undefined notifies no reader of the value", () => {
    const map = proxy(new Map<string, undefined>([["u", undefined]]));
    effect(() => map.get("u"));
    expect(notifiedKeys(() => map.delete("u"))).toEqual([]);
  });

  test("a WeakMap write the native method refuses notifies nothing", () => {
    const map: any = proxy(new WeakMap());
    effect(() => map.has(5));
    expect(notifiedKeys(() => expect(() => map.set(5, 1)).toThrow(TypeError))).toEqual([]);
  });

  test("getOrInsert stores the raw value and notifies the presence of an inserted key", () => {
    const item = { v: 1 };
    const map = proxy(new Map<string, any>());
    effect(() => map.has("k"));
    expect(notifiedKeys(() => map.getOrInsert("k", proxy(item)))).toEqual(["presence of k"]);
    expect(toRaw(map).get("k")).toBe(item);
  });

  test("a Set subclass's own clear notifies what it changed, and is called as written", () => {
    const calls: number[] = [];
    class Resetting extends Set<string> {
      clear(...args: unknown[]) {
        calls.push(args.length);
        super.clear();
        this.add("d1");
        this.add("d2");
      }
    }
    const unread = proxy(new Resetting(["x"]));
    unread.clear();
    const set = proxy(new Resetting(["d1", "x"]));
    effect(() => [set.size, set.has("d1"), set.has("x"), set.has("d2")]);
    expect(notifiedKeys(() => set.clear())).toEqual(["(keys)", "presence of x", "presence of d2"]);
    const grown = proxy(new Resetting(["d1"]));
    effect(() => grown.size);
    expect(notifiedKeys(() => grown.clear())).toEqual(["(keys)"]);
    expect(calls).toEqual([0, 0, 0]);
  });

  test("a Map subclass's own clear notifies the values it changed only", () => {
    class Keeping extends Map<string, number> {
      clear() {
        super.clear();
        this.set("kept", 1);
      }
    }
    const map = proxy(
      new Keeping([
        ["kept", 1],
        ["gone", 2],
      ])
    );
    effect(() => [map.get("kept"), map.get("gone")]);
    expect(notifiedKeys(() => map.clear())).toEqual(["gone"]);
  });
});

describe("set operations with set-likes", () => {
  test("a set-like whose keys() returns a callable iterator, or callable steps, keeps its members", () => {
    const setLike = (callableIterator: boolean) => ({
      size: 1,
      has: () => false,
      keys: () => {
        let done = false;
        const step = (value: number) => Object.assign(function step() {}, { done: false, value });
        const next = () =>
          done
            ? { done: true, value: undefined }
            : ((done = true), callableIterator ? { done: false, value: 2 } : step(2));
        return callableIterator ? Object.assign(function iterator() {}, { next }) : { next };
      },
    });
    for (const callableIterator of [true, false]) {
      expect([...(new Set([1]) as any).union(setLike(callableIterator))]).toEqual([1, 2]);
      expect([...(proxy(new Set([1])) as any).union(setLike(callableIterator))]).toEqual([1, 2]);
    }
  });

  const hasSetMethods = "union" in Set.prototype;

  test.runIf(hasSetMethods)(
    "a set-like whose has or keys is no function is refused, as natively",
    () => {
      const iterator = () => [][Symbol.iterator]();
      const noHas = { size: 1, has: 5, keys: iterator };
      const noKeys = { size: 5, has: () => true, keys: 5 };
      const set: any = proxy(new Set([1]));
      expect(() => (new Set([1]) as any).union(noHas)).toThrow(TypeError);
      expect(() => set.union(noHas)).toThrow(TypeError);
      expect(() => (new Set([1]) as any).isSubsetOf(noKeys)).toThrow(TypeError);
      expect(() => set.isSubsetOf(noKeys)).toThrow(TypeError);
    }
  );

  test.runIf(hasSetMethods)(
    "membership is answered for primitives, proxies and raw objects",
    () => {
      const raw = {};
      const item = proxy({});
      const set: any = proxy(new Set([1, 2]));
      expect(set.isSubsetOf(new Set([1, 2, 3]))).toBe(true);
      expect(proxy(new Set([1, 5]) as any).isSubsetOf(new Set([1, 2, 3]))).toBe(false);
      expect(proxy(new Set([item]) as any).isSubsetOf(new Set([item]))).toBe(true);
      expect(proxy(new Set([raw]) as any).isSubsetOf(new Set([proxy(raw)]))).toBe(true);
      expect(proxy(new Set([{}]) as any).isSubsetOf(new Set([undefined, 1]))).toBe(false);
    }
  );

  test.runIf(hasSetMethods)("a set-like's keys and next are called without arguments", () => {
    const counts: number[] = [];
    const setLike = {
      size: 1,
      has: () => false,
      keys(...args: unknown[]) {
        counts.push(args.length);
        return {
          next(...nextArgs: unknown[]) {
            counts.push(nextArgs.length);
            return { done: true, value: undefined };
          },
        };
      },
    };
    expect([...(proxy(new Set([1])) as any).union(setLike)]).toEqual([1]);
    expect(counts).toEqual([0, 0]);
  });

  test.runIf(hasSetMethods)(
    "a set-like whose iterator steps are not objects is refused, as natively",
    () => {
      const setLike = () => {
        let calls = 0;
        return {
          size: 1,
          has: () => false,
          keys: () => ({ next: () => (calls++ ? { done: true } : 5) }),
        };
      };
      expect(() => (new Set([1]) as any).union(setLike())).toThrow(TypeError);
      expect(() => (proxy(new Set([1])) as any).union(setLike())).toThrow(TypeError);
    }
  );

  test.runIf(hasSetMethods)("a finished set-like iterator's value is not read", () => {
    let reads = 0;
    const setLike = {
      size: 1,
      has: () => false,
      keys: () => ({
        next: () => ({
          done: true,
          get value() {
            reads++;
            return undefined;
          },
        }),
      }),
    };
    expect([...(new Set([1]) as any).union(setLike)]).toEqual([1]);
    expect([...(proxy(new Set([1])) as any).union(setLike)]).toEqual([1]);
    expect(reads).toBe(0);
  });

  test.runIf(hasSetMethods)("a union keeps a member as the set-like first gave it", () => {
    const raw = {};
    const item = proxy(raw);
    const union = [...(proxy(new Set()) as any).union(new Set([item, raw]))];
    expect(union.length).toBe(1);
    expect(union[0]).toBe(item);
  });
});

describe("the order and the reach of notifications", () => {
  test("a created key notifies the key list before its presence", () => {
    const state = proxy({} as any);
    effect(() => [Object.keys(state), "b" in state]);
    expect(notifiedKeys(() => (state.b = 1))).toEqual(["(keys)", "presence of b"]);
  });

  test("a deleted key notifies the key list, its presence, then its value", () => {
    const state = proxy({ a: 1 } as any);
    effect(() => [Object.keys(state), "a" in state, state.a]);
    expect(notifiedKeys(() => delete state.a)).toEqual(["(keys)", "presence of a", "a"]);
  });

  test("an array index deleted notifies the index, then the items", () => {
    const list = proxy([1, 2, 3]);
    effect(() => [list[2], readArrayItems(list)]);
    expect(notifiedKeys(() => delete (list as any)[2])).toEqual(["2", "items"]);
  });

  test("an array shrink notifies the length, the key list, the dropped indices, then the items", () => {
    const list = proxy([0, 1, 2]);
    effect(() => [list.length, Object.keys(list), list[2], readArrayItems(list)]);
    expect(notifiedKeys(() => (list.length = 1))).toEqual(["length", "(keys)", "2", "items"]);
  });

  test("an index created on an array notifies the length, the index, then the items", () => {
    const list = proxy([0]);
    effect(() => [list.length, list[0], list[1], readArrayItems(list)]);
    expect(notifiedKeys(() => (list[1] = 1))).toEqual(["length", "1", "items"]);
  });

  test("a native clear notifies each key's presence before its value", () => {
    const map = proxy(
      new Map([
        ["a", 1],
        ["b", 2],
      ])
    );
    effect(() => [map.has("a"), map.get("a"), map.get("b")]);
    expect(notifiedKeys(() => map.clear())).toEqual(["presence of a", "a", "b"]);
  });

  test("clear walks the keys read in their first-read order once the key list's reader is gone", () => {
    const map = proxy(
      new Map([
        ["a", 1],
        ["b", 2],
        ["c", 3],
      ])
    );
    effect(() => map.size)();
    effect(() => map.get("b"));
    effect(() => map.get("a"));
    expect(notifiedKeys(() => map.clear())).toEqual(["b", "a"]);
  });

  test("a native clear of a subclass finds its keys natively, whatever its keys and has say", () => {
    class NoKeys extends Map<string, number> {
      keys(): MapIterator<string> {
        return new Map<string, number>().keys();
      }
    }
    class NoHas extends Map<string, number> {
      has(_key: string) {
        return false;
      }
    }
    const listed = proxy(
      new NoKeys([
        ["a", 1],
        ["b", 2],
      ])
    );
    effect(() => [listed.get("a"), listed.get("b")]);
    expect(notifiedKeys(() => listed.clear())).toEqual(["a", "b"]);
    const found = proxy(
      new NoHas([
        ["a", 1],
        ["b", 2],
        ["c", 3],
        ["d", 4],
      ])
    );
    effect(() => found.get("b"));
    expect(notifiedKeys(() => found.clear())).toEqual(["b"]);
  });

  test("a subclass's own clear is diffed natively, whatever its keys, has and get say", () => {
    class Restoring extends Set<string> {
      clear() {
        super.clear();
        this.add("d1");
        this.add("d2");
      }
      keys(): SetIterator<string> {
        return new Set<string>().keys();
      }
      has(_key: string) {
        return false;
      }
    }
    const changed = proxy(new Restoring(["d1", "x"]));
    effect(() => [changed.size, changed.has("x"), changed.has("d2")]);
    expect(notifiedKeys(() => changed.clear())).toEqual([
      "(keys)",
      "presence of x",
      "presence of d2",
    ]);
    const restored = proxy(new Restoring(["d1", "d2"]));
    effect(() => [restored.size, restored.has("d1")]);
    expect(notifiedKeys(() => restored.clear())).toEqual([]);
    class Keeping extends Map<string, number> {
      clear() {
        super.clear();
        this.set("kept", 1);
      }
      get(_key: string): number | undefined {
        return undefined;
      }
    }
    const map = proxy(
      new Keeping([
        ["kept", 1],
        ["gone", 2],
      ])
    );
    effect(() => [map.get("kept"), map.get("gone"), map.has("gone")]);
    expect(notifiedKeys(() => map.clear())).toEqual(["presence of gone", "gone"]);
  });

  test("getOrInsert notifies the presence of the inserted key before its value", () => {
    const map = proxy(new Map<string, number>());
    effect(() => [map.get("k"), map.has("k")]);
    expect(notifiedKeys(() => map.getOrInsert("k", 1))).toEqual(["presence of k", "k"]);
  });

  test("an effect inserting a key with getOrInsert runs once, not invalidated by its own insert", async () => {
    const map = proxy(new Map<string, number>());
    const lines: string[] = [];
    setDebugSink((_channel, message) => lines.push(message));
    setDebug(["reactivity"]);
    let runs = 0;
    try {
      effect(
        () => {
          runs++;
          map.getOrInsert("k", 1);
        },
        { name: "inserter" }
      );
      await waitScheduler();
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(runs).toBe(1);
    expect(lines.filter((line) => line.includes("invalidated"))).toEqual([]);
  });

  test("iterating stops tracking nothing it already handed out", async () => {
    const map = proxy(
      new Map([
        ["a", 1],
        ["b", 2],
      ])
    );
    let keyRuns = 0;
    let valueRuns = 0;
    effect(() => {
      keyRuns++;
      for (const key of map.keys()) {
        void key;
        break;
      }
    });
    effect(() => {
      valueRuns++;
      map.values().next();
    });
    map.set("a", 3);
    await waitScheduler();
    expect([keyRuns, valueRuns]).toEqual([1, 2]);
    map.set("c", 1);
    await waitScheduler();
    expect([keyRuns, valueRuns]).toEqual([2, 3]);
  });

  test("a forEach whose callback throws still tracked the keys and the value it reached", async () => {
    const map = proxy(new Map([["a", 1]]));
    let runs = 0;
    effect(() => {
      runs++;
      try {
        map.forEach(() => {
          throw new Error("stop");
        });
      } catch {
        // the callback stopped the visit
      }
    });
    map.set("a", 2);
    await waitScheduler();
    expect(runs).toBe(2);
    map.set("b", 1);
    await waitScheduler();
    expect(runs).toBe(3);
  });

  test("a refused markRaw of a proxied prototype reads nothing through the proxy", () => {
    const lines: string[] = [];
    setDebugSink((_channel, message) => lines.push(message));
    setDebug(["reactivity"]);
    try {
      const reactive = proxy({ proto: Object.prototype as any }).proto;
      const dispose = effect(() => {
        expect(() => markRaw(reactive)).toThrow("markRaw(Object.prototype)");
      });
      dispose();
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(lines.filter((line) => line.startsWith("proxy read"))).toEqual([]);
  });

  test("a refused markRaw leaves the prototype it refused reactive", () => {
    expect(() => markRaw(Object.prototype)).toThrow(OwlError);
    const proto = proxy({ proto: Object.prototype as any }).proto;
    expect(proto).not.toBe(Object.prototype);
    expect(toRaw(proto)).toBe(Object.prototype);
  });

  test("proxy() of a shallow proxy whose class was marked raw afterwards hands out the raw instance", () => {
    class Later {}
    const instance = new Later();
    const shallow = signal.Object(instance)();
    expect(shallow).not.toBe(instance);
    markRaw(Later.prototype);
    expect(proxy(shallow)).toBe(instance);
  });

  test("a getter's TypeError is rethrown even when reading the target's constructor throws", () => {
    const target = {
      get constructor(): never {
        throw new Error("no constructor");
      },
      get broken(): number {
        throw new TypeError("plain failure");
      },
    };
    expect(() => proxy(target).broken).toThrow("plain failure");
  });

  test("an observe() view hands out a locked collection method as it is", () => {
    const own = () => 1;
    const map = new Map();
    Object.defineProperty(map, "get", { value: own, writable: false, configurable: false });
    expect(observe(proxy(map), () => {}).get).toBe(own);
  });

  test("an observe() view reads a method asking its target's descriptor once besides the engine's checks", () => {
    let descriptors = 0;
    const target = new Proxy(
      { method: () => 1 },
      {
        getOwnPropertyDescriptor(t, key) {
          descriptors++;
          return Reflect.getOwnPropertyDescriptor(t, key);
        },
      }
    );
    expect(observe(target, () => {}).method()).toBe(1);
    expect(descriptors).toBe(3);
  });

  test("an observe() view reads a plain value asking its target's descriptor only for the engine's checks", () => {
    let descriptors = 0;
    const target = new Proxy(
      { a: 1 },
      {
        getOwnPropertyDescriptor(t, key) {
          descriptors++;
          return Reflect.getOwnPropertyDescriptor(t, key);
        },
      }
    );
    expect(observe(target, () => {}).a).toBe(1);
    expect(descriptors).toBe(2);
  });
});

describe("a target behind its own Proxy", () => {
  function logged<T extends object>(target: T) {
    const log: string[] = [];
    const handler: ProxyHandler<T> = {};
    const traps = [
      "getOwnPropertyDescriptor",
      "getPrototypeOf",
      "get",
      "has",
      "ownKeys",
      "isExtensible",
      "set",
      "defineProperty",
    ] as const;
    for (const trap of traps) {
      (handler as any)[trap] = (...args: any[]) => {
        log.push(typeof args[1] === "string" ? `${trap}:${args[1]}` : trap);
        return (Reflect as any)[trap](...args);
      };
    }
    return { foreign: new Proxy(target, handler), log };
  }

  test("is asked only what each operation needs, in order", () => {
    class Marked {}
    markRaw(Marked.prototype);

    const again = logged({ x: 1 });
    proxy(again.foreign);
    again.log.length = 0;
    proxy(again.foreign);
    expect(again.log).toEqual([
      "getPrototypeOf",
      "getPrototypeOf",
      "getPrototypeOf",
      "get",
      "getPrototypeOf",
    ]);

    const skipped = logged({ y: 1 });
    markRaw(skipped.foreign);
    skipped.log.length = 0;
    proxy({ skipped: skipped.foreign }).skipped;
    expect(skipped.log).toEqual(["getPrototypeOf", "getPrototypeOf", "getPrototypeOf", "get"]);

    const created = logged({} as any);
    const state = proxy(created.foreign);
    effect(() => state.k);
    created.log.length = 0;
    state.k = 1;
    expect(created.log).toEqual([
      "getOwnPropertyDescriptor:k",
      "get:k",
      "getPrototypeOf",
      "getOwnPropertyDescriptor:k",
      "set:k",
      "getOwnPropertyDescriptor:k",
      "defineProperty:k",
      "getOwnPropertyDescriptor:k",
      "get:k",
      "getOwnPropertyDescriptor:k",
    ]);

    const shrunk = logged([1, 2, 3]);
    const list = proxy(shrunk.foreign);
    effect(() => list.length);
    shrunk.log.length = 0;
    list.length = 1;
    expect(shrunk.log).toEqual([
      "getOwnPropertyDescriptor:length",
      "get:length",
      "getPrototypeOf",
      "getOwnPropertyDescriptor:length",
      "getOwnPropertyDescriptor:length",
      "set:length",
      "getOwnPropertyDescriptor:length",
      "defineProperty:length",
      "get:length",
      "get:length",
      "get:length",
      "getOwnPropertyDescriptor:length",
    ]);

    const items = logged([1, 2]);
    const read = proxy(items.foreign);
    items.log.length = 0;
    readArrayItems(read);
    expect(items.log).toEqual(["getPrototypeOf", "isExtensible", "get:length", "get:0", "get:1"]);

    const shared: string[] = [];
    const key = logged({ key: 1 });
    const value = logged({ value: 1 });
    const watch = (entry: { log: string[] }, name: string) => {
      const push = entry.log.push.bind(entry.log);
      entry.log.push = (...lines: string[]) => {
        shared.push(...lines.map((line) => `${name} ${line}`));
        return push(...lines);
      };
    };
    watch(key, "key");
    watch(value, "value");
    const map = proxy(new Map([[key.foreign, value.foreign]]));
    [...map.entries()];
    expect(shared[0]).toMatch(/^key /);

    const firefox = logged({
      get value(): number {
        throw new TypeError("can't access private field or method: object is not the right class");
      },
    });
    const guarded = proxy(firefox.foreign);
    firefox.log.length = 0;
    expect(() => guarded.value).toThrow(OwlError);
    expect(firefox.log).toEqual(["get:value", "get:constructor"]);
  });
});
