import {
  asyncComputed,
  atomSymbol,
  observersOf,
  computed,
  effect,
  immediateEffect,
  Plugin,
  PluginManager,
  Resource,
  selector,
  setDebug,
  setDebugSink,
  signal,
  startPlugins,
  untrack,
  type DebugChannel,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

function rethrow(e: unknown) {
  throw e;
}

// the effects created by `owned()` that are not disposed yet
let live = 0;
function owned(name = "inner") {
  return effect(
    () => {
      live++;
      return () => {
        live--;
      };
    },
    { name }
  );
}

beforeEach(() => {
  live = 0;
});

describe("an effect created in a computed's getter", () => {
  test("is disposed before the computed recomputes: N recomputes leave one, not N", async () => {
    const scope = new TestScope({});
    const s = signal(0);
    const c = scope.run(() =>
      computed(() => {
        owned();
        return s();
      })
    );
    const dispose = effect(() => c());
    expect(live).toBe(1);
    for (let i = 1; i <= 3; i++) {
      s.set(i);
      await waitScheduler();
    }
    expect(live).toBe(1);
    dispose();
    scope.finalize(rethrow);
    expect(live).toBe(0);
  });

  test("is disposed with the computed its last observer's dispose cascades to", () => {
    const scope = new TestScope({});
    const s = signal(0);
    const c = scope.run(() =>
      computed(() => {
        owned();
        return s();
      })
    );
    for (let i = 0; i < 3; i++) {
      const dispose = effect(() => c());
      expect(live).toBe(1);
      dispose();
      expect(live).toBe(0);
    }
    scope.finalize(rethrow);
  });

  test("of a detached computed is disposed on recompute and when the flush disposes the computed", async () => {
    const s = signal(0);
    const c = computed(
      () => {
        owned();
        return s();
      },
      { detached: true }
    );
    for (let i = 1; i <= 3; i++) {
      s.set(i);
      expect(c()).toBe(i);
    }
    expect(live).toBe(1);
    // nothing observes it: the write leaves it to the flush, which disposes it
    s.set(4);
    await waitScheduler();
    expect(live).toBe(0);
    expect(c()).toBe(4);
    expect(live).toBe(1);
  });

  test("is disposed with the computed when its scope is destroyed", () => {
    const scope = new TestScope({});
    const c = scope.run(() =>
      computed(() => {
        owned();
        return 1;
      })
    );
    c();
    expect(live).toBe(1);
    scope.finalize(rethrow);
    expect(live).toBe(0);
  });

  test("created inside untrack is still the computed's", () => {
    const s = signal(0);
    const c = computed(
      () => {
        untrack(() => owned());
        return s();
      },
      { detached: true }
    );
    c();
    s.set(1);
    c();
    s.set(2);
    c();
    expect(live).toBe(1);
  });

  test("its own children are disposed first, then it", () => {
    const steps: string[] = [];
    const s = signal(0);
    const c = computed(
      () => {
        effect(() => {
          effect(() => () => steps.push("grandchild"));
          return () => steps.push("child");
        });
        return s();
      },
      { detached: true }
    );
    c();
    s.set(1);
    c();
    expect(steps).toEqual(["grandchild", "child"]);
  });

  test("does not run again for a write its computed is recomputed for: the computed runs first", async () => {
    const s = signal(0);
    const log: string[] = [];
    let generation = 0;
    const c = computed(
      () => {
        const g = ++generation;
        // subscribed to s before the computed is: queued first by a write
        effect(() => log.push(`effect of run ${g} sees ${s()}`));
        return s();
      },
      { name: "c" }
    );
    const dispose = effect(() => c());
    expect(log).toEqual(["effect of run 1 sees 0"]);
    s.set(1);
    await waitScheduler();
    expect(log).toEqual(["effect of run 1 sees 0", "effect of run 2 sees 1"]);
    dispose();
  });

  test("an immediate one does not run again for a write its computed is recomputed for", () => {
    const s = signal(0);
    const log: string[] = [];
    let generation = 0;
    const c = computed(
      () => {
        const g = ++generation;
        immediateEffect(() => log.push(`effect of run ${g} sees ${s()}`));
        return s();
      },
      { name: "c" }
    );
    const dispose = effect(() => c());
    s.set(1);
    expect(log).toEqual(["effect of run 1 sees 0", "effect of run 2 sees 1"]);
    dispose();
  });

  test("whose cleanup throws on a recompute: the error is reported, the readers get the new value", async () => {
    class IntentionalTestError extends Error {
      override name = "IntentionalTestError";
    }
    const reject = vi.spyOn(Promise, "reject");
    const s = signal(0);
    let fail = true;
    const c = computed(
      () => {
        effect(() => () => {
          if (fail) {
            fail = false;
            throw new IntentionalTestError("cleanup failed");
          }
        });
        return s();
      },
      { detached: true }
    );
    const seen: unknown[] = [];
    const dispose = effect(() => seen.push(c()));
    s.set(1);
    await waitScheduler();
    expect(seen).toEqual([0, 1]);
    expect(reject.mock.calls.map(([e]) => (e as Error).message)).toEqual(["cleanup failed"]);
    reject.mockRestore();
    s.set(2);
    await waitScheduler();
    expect(seen).toEqual([0, 1, 2]);
    dispose();
  });

  test("whose cleanup throws when the computed is disposed by cascade: the dispose throws, after releasing everything", () => {
    const s = signal(0);
    const steps: string[] = [];
    const c = computed(
      () => {
        effect(() => () => {
          steps.push("first");
          throw new Error("cleanup failed");
        });
        effect(() => () => steps.push("second"));
        return s();
      },
      { detached: true }
    );
    const dispose = effect(() => c());
    expect(dispose).toThrow("cleanup failed");
    expect(steps).toEqual(["first", "second"]);
    expect(observersOf((s as any)[atomSymbol])).toEqual([]);
  });
});

describe("a cleanup that throws while computeds are disposed in bulk", () => {
  // the flush reports it as an unhandled rejection, which the test config
  // lets through by this name
  class IntentionalTestError extends Error {
    override name = "IntentionalTestError";
  }

  function failingComputed(s: () => number, detached: boolean) {
    return computed(
      () => {
        effect(() => () => {
          throw new IntentionalTestError("cleanup failed");
        });
        owned();
        return s();
      },
      { detached }
    );
  }

  test("by their scope: the error is reported, every computed is disposed, the scope is destroyed", () => {
    const scope = new TestScope({});
    const s = signal(0);
    const [a, b] = scope.run(() => [failingComputed(s, false), failingComputed(s, false)]);
    a();
    b();
    expect(live).toBe(2);
    const reported: string[] = [];
    scope.finalize((e) => reported.push((e as Error).message));
    expect(reported).toEqual(["cleanup failed", "cleanup failed"]);
    expect(live).toBe(0);
    expect(scope.isDestroyed()).toBe(true);
  });

  test("by the flush, unobserved: every one is disposed, the error is reported", async () => {
    const reject = vi.spyOn(Promise, "reject");
    const s = signal(0);
    const a = failingComputed(s, true);
    const b = failingComputed(s, true);
    a();
    b();
    s.set(1);
    await waitScheduler();
    expect(live).toBe(0);
    expect(reject.mock.calls.map(([e]) => (e as Error).message)).toEqual(["cleanup failed"]);
    reject.mockRestore();
  });
});

describe("an effect created inside untrack", () => {
  test("within an effect is disposed when that effect re-runs and when it is disposed", async () => {
    const s = signal(0);
    const dispose = effect(() => {
      s();
      untrack(() => owned());
    });
    s.set(1);
    await waitScheduler();
    expect(live).toBe(1);
    dispose();
    expect(live).toBe(0);
  });

  test("around a computed it pulls: the getter owns what it creates, the effect what the block creates after", async () => {
    const s = signal(0);
    const t = signal(0);
    let getterLive = 0;
    const c = computed(() => {
      effect(() => {
        getterLive++;
        return () => {
          getterLive--;
        };
      });
      return s();
    });
    const dispose = effect(() => {
      t();
      untrack(() => {
        c();
        owned();
      });
    });
    expect([getterLive, live]).toEqual([1, 1]);
    t.set(1);
    await waitScheduler();
    // the effect's run replaced its own, not the computed's
    expect([getterLive, live]).toEqual([1, 1]);
    s.set(1);
    c();
    expect([getterLive, live]).toEqual([1, 1]);
    // once the block is over, nothing owns what is created outside the run
    const disposeTop = owned("top");
    dispose();
    expect(live).toBe(1);
    disposeTop();
    expect(live).toBe(0);
  });

  test("in an effect's cleanup belongs to nothing, untracked or not", async () => {
    const s = signal(0);
    const dispose = effect(() => {
      s();
      return () => {
        if (live === 0) {
          untrack(() => owned("from cleanup"));
        }
      };
    });
    s.set(1);
    await waitScheduler();
    expect(live).toBe(1);
    dispose();
    expect(live).toBe(1);
  });

  test("with { detached: true } belongs to nothing: it outlives the effect that created it", async () => {
    const s = signal(0);
    let disposeInner: (() => void) | undefined;
    const dispose = effect(() => {
      s();
      disposeInner ??= effect(
        () => {
          live++;
          return () => live--;
        },
        { detached: true }
      );
    });
    s.set(1);
    await waitScheduler();
    dispose();
    expect(live).toBe(1);
    disposeInner!();
    expect(live).toBe(0);
  });
});

describe("a scope is an ownership root", () => {
  test("a plugin started from a resource's effect keeps its effects when that effect re-runs", async () => {
    const plugins = new Resource<any>();
    class A extends Plugin {
      static id = "a";
      setup() {
        owned("a");
      }
    }
    class B extends Plugin {
      static id = "b";
    }
    plugins.add(A);
    const manager = new PluginManager({});
    startPlugins(manager, plugins);
    expect(live).toBe(1);
    plugins.add(B);
    await waitScheduler();
    expect(manager.getPlugin(B)).toBeTruthy();
    expect(live).toBe(1);
    manager.destroy();
  });

  test("an effect created in a scope's run inside an effect is not that effect's", async () => {
    const scope = new TestScope({});
    const s = signal(0);
    let created = false;
    const dispose = effect(() => {
      s();
      if (!created) {
        created = true;
        scope.run(() => owned());
      }
    });
    s.set(1);
    await waitScheduler();
    dispose();
    expect(live).toBe(1);
  });
});

describe("selector", () => {
  test("an effect its source creates is disposed when the source runs again, and when no key is read", async () => {
    const s = signal(0);
    const isSelected = selector(
      () => {
        owned();
        return s();
      },
      { detached: true }
    );
    const dispose = effect(() => isSelected(1));
    for (let i = 1; i <= 3; i++) {
      s.set(i);
      await waitScheduler();
    }
    expect(live).toBe(1);
    dispose();
    s.set(4);
    await waitScheduler();
    expect(live).toBe(0);
  });
});

describe("asyncComputed", () => {
  test("created by an effect is disposed by its re-run: no longer loading, a late result is dropped", async () => {
    const s = signal(0);
    const resolvers: Array<(value: string) => void> = [];
    const created: Array<ReturnType<typeof asyncComputed<string>>> = [];
    const dispose = effect(() => {
      s();
      created.push(asyncComputed(() => new Promise<string>((r) => resolvers.push(r))));
    });
    expect(created[0].loading()).toBe(true);
    s.set(1);
    await waitScheduler();
    expect(created[0].loading()).toBe(false);
    resolvers[0]("late");
    await waitScheduler();
    expect(created[0]()).toBe(undefined);
    resolvers[1]("current");
    await waitScheduler();
    expect(created[1]()).toBe("current");
    dispose();
    expect(created[1].loading()).toBe(false);
  });

  test("an effect its fetcher creates synchronously, even untracked, is disposed when it runs again", async () => {
    const data = asyncComputed(() => {
      untrack(() => owned());
      return 1;
    });
    data.refresh();
    await waitScheduler();
    expect(live).toBe(1);
    data.dispose();
    expect(live).toBe(0);
  });
});

describe("debug logging", () => {
  let lines: string[] = [];
  beforeEach(() => {
    lines = [];
    setDebugSink((channel: DebugChannel, message: string) => lines.push(`${channel}: ${message}`));
  });
  afterEach(() => {
    setDebug(false);
    setDebugSink(null);
  });

  test("the effect channel says which effects go with their computed", () => {
    setDebug(["effect"]);
    const s = signal(0);
    const c = computed(
      () => {
        effect(() => {}, { name: "inner" });
        return s();
      },
      { name: "c", detached: true }
    );
    const dispose = effect(() => c(), { name: "reader" });
    s.set(1);
    c();
    dispose();
    expect(lines).toEqual([
      "effect: create reader, owned by nothing",
      "effect: run reader",
      "effect: create inner, owned by c",
      "effect: run inner",
      "effect: c runs again: dispose 1 effect(s) it created",
      "effect: dispose inner",
      "effect: create inner, owned by c",
      "effect: run inner",
      "effect: dispose reader",
      "effect: c is disposed: dispose 1 effect(s) it created",
      "effect: dispose inner",
    ]);
  });
});
