import {
  computed,
  effect,
  immediateEffect,
  markRaw,
  observe,
  onWillDestroy,
  proxy,
  setDebug,
  setDebugSink,
} from "../src";
import { TestScope } from "./helpers";

let lines: string[];
beforeEach(() => {
  lines = [];
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
  setDebug(["reactivity", "effect", "computed", "scope"]);
});
afterEach((context) => {
  if (context.task.result?.state === "fail") console.debug("[owl:review-contracts]", lines);
  setDebug(false);
  setDebugSink(null);
});

test.each(["local", "registered", "well-known"] as const)(
  "%s symbol properties keep their value and key-list notifications",
  (kind) => {
    const key =
      kind === "local"
        ? Symbol("property")
        : kind === "registered"
          ? Symbol.for("owl.test.property")
          : Symbol.toStringTag;
    const state = proxy({ [key]: 1 });
    const seen: unknown[][] = [];
    const stop = immediateEffect(() =>
      seen.push([Object.getOwnPropertySymbols(state).length, state[key]])
    );
    try {
      state[key] = 2;
      delete state[key];
      expect(seen).toEqual([
        [1, 1],
        [1, 2],
        [0, undefined],
      ]);
    } finally {
      stop();
    }
  }
);

test("a registered symbol read from WeakMap remains an ordinary missing-key read", () => {
  const key = Symbol.for("owl.test.invalid-weak-key");
  const map = proxy(new WeakMap<WeakKey, number>());
  const stop = immediateEffect(() =>
    expect([map.has(key), map.get(key)]).toEqual([false, undefined])
  );
  try {
    expect(() => map.set(key, 1)).toThrow(TypeError);
  } finally {
    stop();
  }
});

test.each(["symbol-first", "string-first"] as const)(
  "mixed property reads use the right atom table (%s)",
  (order) => {
    const key = Symbol("property");
    const state = proxy({ text: 1, [key]: 2 });
    const seen: number[][] = [];
    const stop = immediateEffect(() =>
      seen.push(order === "symbol-first" ? [state[key], state.text] : [state.text, state[key]])
    );
    try {
      state.text = 3;
      state[key] = 4;
      expect(seen).toEqual(
        order === "symbol-first"
          ? [
              [2, 1],
              [2, 3],
              [4, 3],
            ]
          : [
              [1, 2],
              [3, 2],
              [3, 4],
            ]
      );
    } finally {
      stop();
    }
  }
);

test.each(["Map", "Set", "WeakMap"] as const)(
  "%s symbol entries still notify their stored values and presence",
  (kind) => {
    const key = Symbol("entry");
    const collection: any = proxy(
      kind === "Map" ? new Map() : kind === "Set" ? new Set() : new WeakMap()
    );
    const seen: unknown[][] = [];
    const stop = immediateEffect(() =>
      seen.push([collection.has(key), kind === "Set" ? undefined : collection.get(key)])
    );
    try {
      if (kind === "Set") collection.add(key);
      else collection.getOrInsertComputed(key, () => 1);
      if (kind === "WeakMap") collection.delete(key);
      else collection.clear();
      expect(seen).toEqual([
        [false, undefined],
        [true, kind === "Set" ? undefined : 1],
        [false, undefined],
      ]);
    } finally {
      stop();
    }
  }
);

test.each(["Map", "Set", "WeakMap"] as const)(
  "%s fluent methods keep their proxy identity after its target is marked raw",
  (type) => {
    const raw = type === "Map" ? new Map() : type === "Set" ? new Set() : new WeakMap();
    const collection: any = proxy(raw);
    markRaw(raw);
    const result = type === "Set" ? collection.add({}) : collection.set({}, 1);
    expect(result).toBe(collection);
  }
);

test.each(["Map", "WeakMap"] as const)(
  "%s native upsert does not invoke overridden has/get methods",
  (type) => {
    const boom = new Error("the native method must not call these overrides");
    const Base: any = type === "Map" ? Map : WeakMap;
    class Custom extends Base {
      has() {
        throw boom;
      }
      get() {
        throw boom;
      }
    }
    const key = {};
    const raw: any = new Custom();
    const nativePrototype = type === "Map" ? Map.prototype : WeakMap.prototype;
    expect(nativePrototype.getOrInsert.call(raw, key, 1)).toBe(1);
    expect(proxy(raw).getOrInsert(key, 2)).toBe(1);
    const other = {};
    expect(proxy(raw).getOrInsertComputed(other, () => 3)).toBe(3);
  }
);

test.each(["Map", "WeakMap", "Set"] as const)(
  "%s native mutations do not invoke overridden has/get methods",
  (type) => {
    const Base: any = type === "Map" ? Map : type === "Set" ? Set : WeakMap;
    const boom = new Error("native mutations do not use public readers");
    class Custom extends Base {
      has() {
        throw boom;
      }
      get() {
        throw boom;
      }
    }
    const raw = new Custom();
    const collection: any = proxy(raw);
    const key = {};
    expect(type === "Set" ? collection.add(key) : collection.set(key, 1)).toBe(collection);
    expect(collection.delete(key)).toBe(true);
  }
);

test.each(["Map", "WeakMap", "Set"] as const)(
  "%s no-op delete preserves its subscriptions without notifying",
  (type) => {
    const Base: any = type === "Map" ? Map : type === "Set" ? Set : WeakMap;
    class Custom extends Base {
      delete() {
        return false;
      }
    }
    const key = {};
    const raw = new Custom();
    if (type === "Set") raw.add(key);
    else raw.set(key, 1);
    const collection: any = proxy(raw);
    const seen: unknown[] = [];
    const stop = immediateEffect(() =>
      seen.push(type === "Set" ? collection.has(key) : collection.get(key))
    );
    try {
      expect(collection.delete(key)).toBe(false);
      expect(seen).toEqual([type === "Set" ? true : 1]);
      if (type === "Set") {
        expect(collection.has(key)).toBe(true);
      } else {
        collection.set(key, 2);
        expect(seen).toEqual([1, 2]);
      }
    } finally {
      stop();
    }
  }
);

test.each(["Map", "Set"] as const)("%s no-op clear does not notify", (type) => {
  const Base: any = type === "Map" ? Map : Set;
  class Custom extends Base {
    clear() {}
  }
  const raw = new Custom();
  if (type === "Map") raw.set("key", 1);
  else raw.add("key");
  const collection: any = proxy(raw);
  const seen: number[] = [];
  const stop = immediateEffect(() => seen.push(collection.size));
  try {
    collection.clear();
    expect(seen).toEqual([1]);
  } finally {
    stop();
  }
});

test.each([false, true])(
  "an overridden clear reports its actual changes even when it throws (throws=%s)",
  (throws) => {
    const boom = new Error("clear failed after changing entries");
    class Custom extends Map<string, number> {
      clear(): void {
        super.delete("a");
        super.set("b", 2);
        super.set("c", 3);
        if (throws) throw boom;
      }
    }
    const map = proxy(
      new Custom([
        ["a", 1],
        ["b", 1],
      ])
    );
    const seen: unknown[][] = [];
    const stop = immediateEffect(() =>
      seen.push([map.size, map.has("a"), map.get("b"), [...map.keys()]])
    );
    try {
      if (throws) expect(() => map.clear()).toThrow(boom);
      else map.clear();
      expect(seen).toEqual([
        [2, true, 1, ["a", "b"]],
        [2, false, 2, ["b", "c"]],
      ]);
    } finally {
      stop();
    }
  }
);

test("an overridden clear is called on an empty collection and keeps its return value", () => {
  let calls = 0;
  class Custom extends Map {
    clear(): any {
      calls++;
      return "custom result";
    }
  }
  const map = proxy(new Custom());
  expect(map.clear()).toBe("custom result");
  expect(calls).toBe(1);
});

test("native clear does not invoke overridden keys", () => {
  class Custom extends Map<string, number> {
    keys(): never {
      throw new Error("native clear does not call keys");
    }
  }
  const map = proxy(new Custom([["a", 1]]));
  const seen: number[] = [];
  const stop = immediateEffect(() => seen.push(map.size));
  try {
    map.clear();
    expect(seen).toEqual([1, 0]);
  } finally {
    stop();
  }
});

test.each(["Map", "WeakMap", "Set"] as const)(
  "%s mutations notify actual changes before rethrowing an override's error",
  (type) => {
    const Base: any = type === "Map" ? Map : type === "Set" ? Set : WeakMap;
    const boom = new Error("write failed after changing its key");
    class Custom extends Base {
      set(key: object, value: number) {
        super.set(key, value);
        throw boom;
      }
      add(key: object) {
        super.add(key);
        throw boom;
      }
    }
    const collection: any = proxy(new Custom());
    const key = {};
    const seen: unknown[] = [];
    const stop = immediateEffect(() =>
      seen.push(type === "Set" ? collection.has(key) : collection.get(key))
    );
    try {
      expect(() => (type === "Set" ? collection.add(key) : collection.set(key, 1))).toThrow(boom);
      expect(seen).toEqual(type === "Set" ? [false, true] : [undefined, 1]);
    } finally {
      stop();
    }
  }
);

test.each(["Map", "WeakMap", "Set"] as const)("%s no-op insertion does not notify", (type) => {
  const Base: any = type === "Map" ? Map : type === "Set" ? Set : WeakMap;
  class Custom extends Base {
    set() {
      return this;
    }
    add() {
      return this;
    }
  }
  const collection: any = proxy(new Custom());
  const key = {};
  const seen: boolean[] = [];
  const stop = immediateEffect(() => seen.push(collection.has(key)));
  try {
    expect(type === "Set" ? collection.add(key) : collection.set(key, 1)).toBe(collection);
    expect(seen).toEqual([false]);
  } finally {
    stop();
  }
});

test.each(["getOrInsert", "getOrInsertComputed"] as const)(
  "%s reports an override's write before rethrowing",
  (method) => {
    const boom = new Error("upsert failed after changing its key");
    class Custom extends Map<string, number> {
      getOrInsert(key: string): never {
        super.set(key, 1);
        throw boom;
      }
      getOrInsertComputed(key: string): never {
        super.set(key, 1);
        throw boom;
      }
    }
    const map = proxy(new Custom());
    const seen: Array<number | undefined> = [];
    const stop = immediateEffect(() => seen.push(map.get("a")));
    try {
      expect(() => map[method]("a")).toThrow(boom);
      expect(seen).toEqual([undefined, 1]);
    } finally {
      stop();
    }
  }
);

test("a mutation ignores an overridden function's own call property", () => {
  class Custom extends Map<string, number> {
    set(key: string, value: number) {
      return super.set(key, value);
    }
    clear() {
      super.clear();
    }
  }
  for (const fn of [Custom.prototype.set, Custom.prototype.clear]) {
    Object.defineProperty(fn, "call", {
      value() {
        throw new Error("method.call must not be invoked");
      },
    });
  }
  const map = proxy(new Custom());
  const seen: number[] = [];
  const stop = immediateEffect(() => seen.push(map.size));
  try {
    map.set("a", 1);
    map.clear();
    expect(seen).toEqual([0, 1, 0]);
  } finally {
    stop();
  }
});

test("upsert observes callback side effects before notifying immediate readers", () => {
  const map = proxy(new Map<string, number>());
  const seen: Array<number | undefined> = [];
  const stop = immediateEffect(() => {
    seen.push(map.get("a"));
  });
  try {
    expect(
      map.getOrInsertComputed("a", () => {
        map.set("a", 1);
        return 2;
      })
    ).toBe(2);
    expect(seen).toEqual([undefined, 2]);
  } finally {
    stop();
  }
});

test.each(["finalize", "rollback"] as const)(
  "%s drains destroy callbacks registered by computation disposal",
  (action) => {
    const scope = new TestScope({});
    const mark = scope.mark();
    const steps: string[] = [];
    scope.run(() => {
      const c = computed(() => {
        effect(() => () => {
          scope.onDestroy(() => steps.push("released"));
        });
        return 1;
      });
      c();
    });
    if (action === "finalize")
      scope.finalize((error) => {
        throw error;
      });
    else
      scope.rollback(mark, (error) => {
        throw error;
      });
    expect(steps).toEqual(["released"]);
    expect(scope.mark()).toEqual(mark);
    scope.finalize((error) => {
      throw error;
    });
    expect(steps).toEqual(["released"]);
  }
);

test("breaking an observed iterator closes the underlying generator", () => {
  let closed = 0;
  class ClosingMap extends Map<string, number> {
    *entries(): MapIterator<[string, number]> {
      try {
        yield* super.entries();
      } finally {
        closed++;
      }
    }
  }
  const map = observe(
    new ClosingMap([
      ["a", 1],
      ["b", 2],
    ]),
    () => {}
  );
  for (const value of map.values()) {
    expect(value).toBe(1);
    break;
  }
  expect(closed).toBe(1);
});

test.each(["finalize", "rollback"] as const)(
  "%s error reporting does not subscribe the caller",
  (action) => {
    const scope = new TestScope({});
    const mark = scope.mark();
    const value = proxy({ count: 0 });
    scope.onDestroy(() => {
      throw new Error("cleanup failed");
    });
    let runs = 0;
    const stop = immediateEffect(() => {
      runs++;
      const report = () => {
        void value.count;
      };
      if (action === "finalize") scope.finalize(report);
      else scope.rollback(mark, report);
    });
    try {
      value.count++;
      expect(runs).toBe(1);
    } finally {
      stop();
      scope.finalize(() => {});
    }
  }
);

test("a throwing reporter still releases other callbacks and registrations made during cleanup", () => {
  const scope = new TestScope({});
  const boom = new Error("cleanup failed");
  const steps: string[] = [];
  scope.onDestroy(() => steps.push("earlier"));
  scope.onDestroy(() => {
    steps.push("throwing");
    scope.onDestroy(() => steps.push("late"));
    throw boom;
  });
  expect(() =>
    scope.finalize((error) => {
      throw error;
    })
  ).toThrow(boom);
  expect(steps).toEqual(["throwing", "earlier", "late"]);
  expect(scope.isDestroyed()).toBe(true);
});

test.each([false, true])(
  "locked collection method properties preserve Proxy invariants (observed=%s)",
  (observed) => {
    const raw = new Map();
    const method = () => 42;
    Object.defineProperty(raw, "get", { value: method });
    const map = observed ? observe(raw, () => {}) : proxy(raw);
    expect(map.get).toBe(method);
    expect(map.get("x")).toBe(42);
  }
);

test("a locked replaced array method is handed out exactly as stored", () => {
  const raw: number[] = [];
  Object.defineProperty(raw, "push", { value: Array.prototype.push });
  expect(proxy(raw).push).toBe(Array.prototype.push);
  expect(observe(raw, () => {}).push).toBe(Array.prototype.push);
});

test.each([false, true])(
  "a locked collection accessor without a getter returns undefined (observed=%s)",
  (observed) => {
    const raw = new Map();
    Object.defineProperty(raw, "get", { set() {} });
    const map = observed ? observe(raw, () => {}) : proxy(raw);
    expect(map.get).toBeUndefined();
  }
);

test("an overridden upsert that does not insert does not notify readers", () => {
  class NoInsertion extends Map<string, number> {
    getOrInsert(_key: string, _value: number) {
      return 42;
    }
  }
  const map = proxy(new NoInsertion());
  let runs = 0;
  const stop = immediateEffect(() => {
    runs++;
    map.size;
    map.has("a");
    map.get("a");
  });
  try {
    expect(map.getOrInsert("a", 1)).toBe(42);
    expect(runs).toBe(1);
    expect(map.has("a")).toBe(false);
  } finally {
    stop();
  }
});

test.each(["finalize", "late"] as const)(
  "%s keeps destroy callback arguments unchanged",
  (action) => {
    const scope = new TestScope({});
    const calls: unknown[][] = [];
    if (action === "late") scope.finalize(() => {});
    scope.onDestroy(function (...args) {
      calls.push(args);
    });
    if (action === "finalize") {
      scope.run(() =>
        onWillDestroy(function (...args) {
          calls.push(args);
        })
      );
      scope.finalize(() => {});
      expect(calls).toEqual([[scope], []]);
    } else expect(calls).toEqual([[]]);
  }
);
