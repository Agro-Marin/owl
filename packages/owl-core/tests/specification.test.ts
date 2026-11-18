import {
  computed,
  effect,
  immediateEffect,
  observe,
  proxy,
  Registry,
  Resource,
  signal,
  t,
  toRaw,
  useConfig,
  useListener,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

function rethrow(e: unknown) {
  throw e;
}

describe("bringing a computed up to date", () => {
  test("an observe() callback reading back through a computed what its getter wrote runs once it is up to date", () => {
    const go = signal(false);
    const state = proxy({ n: 0 });
    const log: string[] = [];
    const view = observe(state, () => {
      log.push(`callback reads ${c()}`);
    });
    void view.n;
    const c = computed(
      () => {
        log.push("getter");
        if (go()) {
          state.n = 1;
        }
        return state.n;
      },
      { name: "c", detached: true }
    );
    c();
    go.set(true);
    log.length = 0;
    expect(c()).toBe(1);
    expect(log).toEqual(["getter", "callback reads 1"]);
  });
});

describe("ownership and disposal", () => {
  test("a computed the flush disposed recomputes a new object when read again", async () => {
    const flag = signal(true);
    const c = computed(() => ({ value: 1 }), { detached: true });
    let first: object | undefined;
    effect(() => {
      if (flag()) {
        first = c();
      }
    });
    expect(c()).toBe(first);
    flag.set(false);
    await waitScheduler();
    const again = c();
    expect(again).toEqual({ value: 1 });
    expect(again).not.toBe(first);
  });

  test("an effect an observe() callback creates is disposed before the callback runs again", () => {
    let live = 0;
    const view = observe({ n: 0 }, () => {
      void view.n;
      effect(() => {
        live++;
        return () => live--;
      });
    });
    void view.n;
    const state = proxy(toRaw(view));
    state.n = 1;
    expect(live).toBe(1);
    state.n = 2;
    state.n = 3;
    expect(live).toBe(1);
  });

  test.each(["finalize", "rollback"] as const)(
    "an effect a destroy callback creates during %s is not the caller's",
    async (action) => {
      let live = 0;
      const scope = new TestScope({});
      const mark = scope.mark();
      scope.onDestroy(() => {
        effect(() => {
          live++;
          return () => live--;
        });
      });
      const s = signal(0);
      const dispose = effect(() => {
        if (s() === 0) {
          if (action === "finalize") {
            scope.finalize(rethrow);
          } else {
            scope.rollback(mark, rethrow);
          }
        }
      });
      expect(live).toBe(1);
      s.set(1);
      await waitScheduler();
      dispose();
      expect(live).toBe(1);
    }
  );
});

describe("proxies", () => {
  test("an index written past the end of an array behind its own Proxy notifies its length", async () => {
    const list = proxy(new Proxy([1, 2], {}));
    const lengths: number[] = [];
    effect(() => {
      lengths.push(list.length);
    });
    list[3] = 4;
    await waitScheduler();
    expect(lengths).toEqual([2, 4]);
  });

  test("Set.add runs an immediate reader of the size and of the member once", () => {
    const set = proxy(new Set<number>());
    let runs = 0;
    immediateEffect(() => {
      runs++;
      void [set.size, set.has(1)];
    });
    set.add(1);
    expect(runs).toBe(2);
  });

  test.each(["deep", "shallow", "observed"] as const)(
    "a %s collection stores a Set member and a Map key raw",
    (kind) => {
      const member = { id: 1 };
      const key = { id: 2 };
      const rawSet = new Set<object>();
      const rawMap = new Map<object, number>();
      const wrap = <T extends object>(raw: T, make: (raw: T) => T): T =>
        kind === "deep" ? proxy(raw) : kind === "observed" ? observe(raw, () => {}) : make(raw);
      const set = wrap(rawSet, (raw) => signal.Set(raw)() as Set<object>);
      const map = wrap(rawMap, (raw) => signal.Map(raw)() as Map<object, number>);
      set.add(proxy(member));
      map.set(proxy(key), 1);
      expect([...rawSet]).toEqual([member]);
      expect([...rawSet][0]).toBe(member);
      expect([...rawMap.keys()][0]).toBe(key);
    }
  );

  test("Object.hasOwn, propertyIsEnumerable and Object.getOwnPropertyDescriptor subscribe to nothing", async () => {
    const state = proxy({ a: 1 } as Record<string, number>);
    let runs = 0;
    effect(() => {
      runs++;
      Object.hasOwn(state, "b");
      state.propertyIsEnumerable("b");
      Object.getOwnPropertyDescriptor(state, "a");
    });
    state.b = 1;
    state.a = 2;
    await waitScheduler();
    expect(runs).toBe(1);
  });
});

describe("schema types", () => {
  test("a schema is typed as a schema, not as the value it describes", () => {
    const typeErrors = () => {
      // @ts-expect-error a schema is not the value it describes
      const s: string = t.string();
      // @ts-expect-error a number schema has no number methods
      t.number().toFixed(2);
      return s;
    };
    void typeErrors;
    expect((t.number() as any).toFixed).toBeUndefined();
  });

  test("a registry or resource validation is a schema of its entries, and useConfig takes a schema", () => {
    const registry = new Registry({ validation: t.string() });
    registry.add("k", "v");
    const value: string = registry.get("k");
    const resource = new Resource({ validation: t.number() });
    resource.add(1);
    const items: number[] = resource.items();
    const typeErrors = () => {
      // @ts-expect-error a registry entry is a value of its schema
      registry.add("n", 42);
      // @ts-expect-error a resource entry is a value of its schema
      resource.add("x");
      // @ts-expect-error a registry validation is a schema
      new Registry({ validation: "x" });
      // @ts-expect-error a resource validation is a schema
      new Resource({ validation: 42 });
      const delay: number = useConfig("delay", t.number());
      // @ts-expect-error a config type is a schema
      useConfig("delay", 500);
      return delay;
    };
    void typeErrors;
    expect([value, items]).toEqual(["v", [1]]);
  });

  test("registry.get with a default is typed as the entry or the default", () => {
    const registry = new Registry({ validation: t.string() });
    const orNull: string | null = registry.get("missing", null);
    const typeErrors = () => {
      // @ts-expect-error the default joins the entry type
      const narrow: string = registry.get("missing", null);
      return narrow;
    };
    void typeErrors;
    expect(orNull).toBe(null);
  });

  test("useListener takes an event target or any function reading one", async () => {
    const target = new EventTarget();
    const read = signal<EventTarget | null>(target);
    const scope = new TestScope({});
    let calls = 0;
    const onPing = () => calls++;
    scope.run(() => useListener(() => read(), "ping", onPing));
    await waitScheduler();
    target.dispatchEvent(new Event("ping"));
    expect(calls).toBe(1);
    scope.finalize(rethrow);
    const notTarget = () => 42;
    const typeErrors = () => {
      useListener(read, "ping", onPing);
      // @ts-expect-error a listener target is an event target or a function reading one
      useListener(notTarget, "ping", onPing);
    };
    void typeErrors;
  });
});
