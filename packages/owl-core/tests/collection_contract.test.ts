import { immediateEffect, observe, proxy, setDebug, setDebugSink, signal, toRaw } from "../src";

let lines: string[];

beforeEach(() => {
  lines = [];
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
  setDebug(["reactivity", "effect"]);
});

afterEach((context) => {
  if (context.task.result?.state === "fail") {
    console.debug("[owl:collection-test]", lines);
  }
  setDebug(false);
  setDebugSink(null);
});

describe.each(["deep", "shallow", "observed"] as const)("%s collections", (kind) => {
  function wrap<T extends Map<any, any> | Set<any> | WeakMap<any, any>>(raw: T): T {
    if (kind === "observed") {
      return observe(raw, () => {});
    }
    if (kind === "deep") {
      return proxy(raw);
    }
    if (raw instanceof Map) {
      return signal.Map(raw)() as T;
    }
    if (raw instanceof Set) {
      return signal.Set(raw)() as T;
    }
    return signal.Object(raw)();
  }

  test("Map.set returns its reactive collection and chained writes notify", () => {
    const map = wrap(new Map<string, number>());
    const seen: Array<number | undefined> = [];
    const stop = immediateEffect(() => {
      seen.push(map.get("b"));
    });
    try {
      const result = map.set("a", 1);
      result.set("b", 2);
      expect(result).toBe(map);
      expect(seen).toEqual([undefined, 2]);
      expect(lines.some((line) => line.includes("proxy write b"))).toBe(true);
    } finally {
      stop();
    }
  });

  test("Set.add returns its reactive collection and chained writes notify", () => {
    const set = wrap(new Set<number>());
    const seen: boolean[] = [];
    const stop = immediateEffect(() => {
      seen.push(set.has(2));
    });
    try {
      const result = set.add(1);
      result.add(2);
      expect(result).toBe(set);
      expect(seen).toEqual([false, true]);
    } finally {
      stop();
    }
  });

  test("WeakMap.set returns its reactive collection and chained writes notify", () => {
    const map = wrap(new WeakMap<object, number>());
    const a = {};
    const b = {};
    const seen: Array<number | undefined> = [];
    const stop = immediateEffect(() => {
      seen.push(map.get(b));
    });
    try {
      const result = map.set(a, 1);
      result.set(b, 2);
      expect(result).toBe(map);
      expect(seen).toEqual([undefined, 2]);
    } finally {
      stop();
    }
  });

  test("one Map mutation runs a reader of size, presence and value once", () => {
    const map = wrap(new Map<string, number>());
    const seen: unknown[][] = [];
    const stop = immediateEffect(() => {
      seen.push([map.size, map.has("a"), map.get("a")]);
    });
    try {
      map.set("a", 1);
      map.delete("a");
      expect(seen).toEqual([
        [0, false, undefined],
        [1, true, 1],
        [0, false, undefined],
      ]);
    } finally {
      stop();
    }
  });

  test("clear runs a reader of multiple entries once", () => {
    const map = wrap(
      new Map([
        ["a", 1],
        ["b", 2],
      ])
    );
    const seen: unknown[][] = [];
    const stop = immediateEffect(() => {
      seen.push([map.size, map.has("a"), map.get("a"), map.get("b")]);
    });
    try {
      map.clear();
      expect(seen).toEqual([
        [2, true, 1, 2],
        [0, false, undefined, undefined],
      ]);
    } finally {
      stop();
    }
  });

  test.each(["Map", "WeakMap"] as const)(
    "%s getOrInsert keeps reads, insertion and returned values reactive",
    (type) => {
      const key = {};
      const raw =
        type === "Map"
          ? new Map<object, { value: number }>()
          : new WeakMap<object, { value: number }>();
      const map = wrap(raw);
      const item = { value: 1 };
      const seen: Array<number | undefined> = [];
      const stop = immediateEffect(() => {
        seen.push(map.get(key)?.value);
      });
      try {
        const value = map.getOrInsert(proxy(key), item);
        expect(toRaw(value)).toBe(item);
        expect(map.getOrInsert(key, { value: 2 })).toBe(value);
        expect(seen).toEqual([undefined, 1]);
        expect(raw.get(key)).toBe(item);
        expect(lines.some((line) => line.includes("proxy write"))).toBe(true);
      } finally {
        stop();
      }
    }
  );

  test.each(["Map", "WeakMap"] as const)(
    "%s getOrInsertComputed normalizes the key and stored value and skips existing keys",
    (type) => {
      const key = {};
      const raw = type === "Map" ? new Map<object, object>() : new WeakMap<object, object>();
      const map = wrap(raw);
      const item = {};
      const reactiveItem = proxy(item);
      const compute = vi.fn((received) => {
        expect(received).toBe(key);
        return reactiveItem;
      });
      const value = map.getOrInsertComputed(proxy(key), compute);
      expect(toRaw(value)).toBe(item);
      expect(raw.get(key)).toBe(kind === "shallow" ? reactiveItem : item);
      expect(map.getOrInsertComputed(key, compute)).toBe(value);
      expect(compute).toHaveBeenCalledTimes(1);
      expect(() => map.getOrInsertComputed(key, null as any)).toThrow(TypeError);
    }
  );

  test("getOrInsert reads an existing value as a reactive dependency", () => {
    const map = wrap(new Map([["a", 1]]));
    const seen: number[] = [];
    const stop = immediateEffect(() => {
      seen.push(map.getOrInsert("a", 0));
    });
    try {
      map.set("a", 2);
      expect(seen).toEqual([1, 2]);
    } finally {
      stop();
    }
  });
});

test("a throwing immediate reader does not prevent other Map readers being notified", () => {
  const map = proxy(new Map<string, number>());
  const boom = new Error("reader failed");
  const stopSize = immediateEffect(() => {
    if (map.size) {
      throw boom;
    }
  });
  const seen: Array<number | undefined> = [];
  const stopValue = immediateEffect(() => {
    seen.push(map.get("a"));
  });
  try {
    expect(() => map.set("a", 1)).toThrow(boom);
    expect(seen).toEqual([undefined, 1]);
  } finally {
    stopSize();
    stopValue();
  }
});

describe("observed collection iterators", () => {
  test.each(["keys", "values", "entries", Symbol.iterator] as const)(
    "Set %s keeps array members as live views",
    (method) => {
      const item = [1];
      let calls = 0;
      const set = observe(new Set([item]), () => calls++);
      const yielded = set[method]().next().value!;
      const value =
        method === "entries" ? (yielded as [number[], number[]])[0] : (yielded as number[]);
      expect(toRaw(value)).toBe(item);
      expect(value).toBe(set.values().next().value);
      void value[0];
      proxy(item)[0] = 2;
      expect(calls).toBe(1);
      value.push(3);
      expect(item).toEqual([2, 3]);
    }
  );

  test.each(["keys", "values"] as const)("Map %s keeps arrays as live views", (method) => {
    const key = [1];
    const item = [2];
    let calls = 0;
    const map = observe(new Map([[key, item]]), () => calls++);
    const value = map[method]().next().value!;
    const raw = method === "keys" ? key : item;
    expect(toRaw(value)).toBe(raw);
    void value[0];
    proxy(raw)[0] = 3;
    expect(calls).toBe(1);
  });

  test("Map entries wrap the key and value, keeping the pair itself plain", () => {
    const key = [1];
    const value = [2];
    const map = observe(new Map([[key, value]]), () => {});
    const entry = map.entries().next().value!;
    expect(toRaw(entry)).toBe(entry);
    expect(toRaw(entry[0])).toBe(key);
    expect(toRaw(entry[1])).toBe(value);
    expect(entry[0]).toBe(map.keys().next().value);
    expect(entry[1]).toBe(map.values().next().value);
  });

  test("iterator helpers keep observing each consumed value", () => {
    let calls = 0;
    const map = observe(new Map([["a", { value: 1 }]]), () => calls++);
    expect(
      map
        .values()
        .map((item) => item.value)
        .toArray()
    ).toEqual([1]);
    proxy(toRaw(map)).get("a")!.value = 2;
    expect(calls).toBe(1);
  });
});
