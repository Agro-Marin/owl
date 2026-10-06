import v8 from "node:v8";
import vm from "node:vm";
import { effect, markRaw, observe, OwlError, proxy, toRaw } from "../src";
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
