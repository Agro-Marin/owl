import {
  computed,
  effect,
  immediateEffect,
  isAbortError,
  setDebug,
  setDebugSink,
  signal,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

function rethrow(e: unknown) {
  throw e;
}

describe("Scope.finalize", () => {
  test("a destroy callback registered by another destroy callback runs too", () => {
    const scope = new TestScope({});
    const steps: string[] = [];
    scope.onDestroy(() => {
      steps.push("first");
      scope.onDestroy(() => steps.push("late"));
    });
    scope.finalize(rethrow);
    expect(steps).toEqual(["first", "late"]);
  });

  test("the abort signal is aborted while destroy callbacks run", () => {
    const scope = new TestScope({});
    let aborted: boolean | null = null;
    scope.onDestroy(() => {
      aborted = scope.abortSignal.aborted;
    });
    scope.finalize(rethrow);
    expect(aborted).toBe(true);
  });

  test("a computed another scope still observes keeps following its sources", async () => {
    const scope = new TestScope({});
    const n = signal(1);
    const double = scope.run(() => computed(() => n() * 2));
    const seen: number[] = [];
    effect(() => seen.push(double()));
    scope.finalize(rethrow);
    n.set(2);
    await waitScheduler();
    expect(seen).toEqual([2, 4]);
  });

  test("a computed nothing else observes is disposed with its scope", () => {
    const scope = new TestScope({});
    const n = signal(1);
    const getter = vi.fn(() => n() * 2);
    const double = scope.run(() => computed(getter));
    double();
    scope.finalize(rethrow);
    n.set(2);
    expect(getter).toHaveBeenCalledTimes(1);
    expect(double()).toBe(4);
  });

  test("finalize called from a destroy callback does not run the callbacks twice", () => {
    const scope = new TestScope({});
    const steps: string[] = [];
    scope.onDestroy(() => steps.push("a"));
    scope.onDestroy(() => {
      steps.push("b");
      scope.finalize(rethrow);
    });
    scope.finalize(rethrow);
    expect(steps).toEqual(["b", "a"]);
    expect(scope.isDestroyed()).toBe(true);
  });
});

describe("Scope.run", () => {
  test("a guarded promise that rejects after the scope died rejects with an AbortError", async () => {
    const scope = new TestScope({});
    let reject!: (e: unknown) => void;
    const guarded = scope.run(() => new Promise((_, rej) => (reject = rej)));
    scope.finalize(rethrow);
    const failure = new Error("server 500");
    reject(failure);
    const error: any = await guarded.catch((e) => e);
    expect(isAbortError(error)).toBe(true);
    expect(error.cause).toBe(failure);
  });

  test("a guarded promise that rejects while the scope lives keeps its error", async () => {
    const scope = new TestScope({});
    const failure = new Error("server 500");
    await expect(scope.run(() => Promise.reject(failure))).rejects.toBe(failure);
  });
});

describe("Scope.rollback", () => {
  test("drops what was registered since the mark, keeps what was before", () => {
    const scope = new TestScope({});
    const steps: string[] = [];
    scope.willStart.push(() => {});
    scope.onDestroy(() => steps.push("kept"));
    const mark = scope.mark();
    scope.willStart.push(() => {});
    scope.onDestroy(() => steps.push("undone 1"));
    scope.onDestroy(() => steps.push("undone 2"));
    scope.rollback(mark, rethrow);
    expect(steps.splice(0)).toEqual(["undone 2", "undone 1"]);
    expect(scope.willStart.length).toBe(1);
    scope.finalize(rethrow);
    expect(steps).toEqual(["kept"]);
  });
});

describe("Scope.finalize with a reporter that rethrows", () => {
  test("still leaves the scope destroyed", () => {
    const scope = new TestScope({});
    scope.onDestroy(() => {
      throw new Error("boom");
    });
    expect(() => scope.finalize(rethrow)).toThrow("boom");
    expect(scope.isDestroyed()).toBe(true);
    expect(() => scope.run(() => 1)).toThrow("Cannot run a callback in a destroyed scope");
  });
});

describe("scope cleanup isolation", () => {
  let lines: string[];
  beforeEach(() => {
    lines = [];
    setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
    setDebug(["scope", "effect", "reactivity"]);
  });
  afterEach((context) => {
    if (context.task.result?.state === "fail") {
      console.debug("[owl:scope-cleanup-test]", lines);
    }
    setDebug(false);
    setDebugSink(null);
  });

  test.each(["finalize", "rollback", "late onDestroy"] as const)(
    "%s callbacks do not subscribe the computation requesting cleanup",
    (action) => {
      const scope = new TestScope({});
      const mark = scope.mark();
      const value = signal(0);
      scope.onDestroy(() => {
        value();
      });
      if (action === "late onDestroy") {
        scope.finalize(rethrow);
      }
      let runs = 0;
      const stop = immediateEffect(() => {
        runs++;
        if (action === "finalize") {
          scope.finalize(rethrow);
        } else if (action === "rollback") {
          scope.rollback(mark, rethrow);
        } else {
          scope.onDestroy(() => {
            value();
          });
        }
      });
      try {
        value.set(1);
        expect(runs).toBe(1);
        expect(lines).toContain("reactivity: write, 0 observer(s)");
      } finally {
        stop();
        scope.finalize(rethrow);
      }
    }
  );

  test("rollback releases callbacks registered during cleanup, preserving earlier callbacks", () => {
    const scope = new TestScope({});
    const steps: string[] = [];
    scope.onDestroy(() => steps.push("kept"));
    const mark = scope.mark();
    scope.onDestroy(() => {
      steps.push("undone");
      scope.onDestroy(() => steps.push("late"));
    });
    scope.rollback(mark, rethrow);
    expect(steps.splice(0)).toEqual(["undone", "late"]);
    scope.finalize(rethrow);
    expect(steps).toEqual(["kept"]);
  });
});
