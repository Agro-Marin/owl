import { computed, immediateEffect, effect, proxy, signal, untrack } from "../src";
import { expectSpy, nextMicroTick } from "./helpers";

async function waitScheduler() {
  await nextMicroTick();
  return Promise.resolve();
}

describe("immediateEffect", () => {
  test("immediateEffect runs directly", () => {
    const spy = vi.fn();
    immediateEffect(() => {
      spy();
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  test("immediateEffect reruns immediately when dependency changes", () => {
    const state = proxy({ a: 1 });
    const spy = vi.fn();
    immediateEffect(() => spy(state.a));
    expectSpy(spy, 1, { args: [1] });
    state.a = 2;
    expectSpy(spy, 2, { args: [2] });
    state.a = 3;
    expectSpy(spy, 3, { args: [3] });
  });

  test("regular effect still runs in microtick", async () => {
    const state = proxy({ a: 1 });
    const spy = vi.fn();
    effect(() => spy(state.a));
    expectSpy(spy, 1, { args: [1] });
    state.a = 2;
    expectSpy(spy, 1, { args: [1] });
    await waitScheduler();
    expectSpy(spy, 2, { args: [2] });
  });

  test("immediateEffect with signal", () => {
    const s = signal(1);
    const spy = vi.fn();
    immediateEffect(() => spy(s()));
    expectSpy(spy, 1, { args: [1] });
    s.set(2);
    expectSpy(spy, 2, { args: [2] });
    s.set(3);
    expectSpy(spy, 3, { args: [3] });
  });

  test("immediateEffect keeps synchronous timing through a computed", () => {
    const s = signal(1);
    const double = computed(() => s() * 2);
    const spy = vi.fn();
    immediateEffect(() => spy(double()));
    expectSpy(spy, 1, { args: [2] });
    s.set(2);
    expectSpy(spy, 2, { args: [4] });
    s.set(3);
    expectSpy(spy, 3, { args: [6] });
  });

  test("computed dependency does not degrade a direct dependency to batched", () => {
    const a = signal(1);
    const b = signal(10);
    const isPositive = computed(() => a() > 0);
    const spy = vi.fn();
    immediateEffect(() => spy(isPositive(), b()));
    expectSpy(spy, 1, { args: [true, 10] });
    // Write reaching the effect through the computed: must not leave the
    // effect parked in the batched queue...
    a.set(-1);
    expectSpy(spy, 2, { args: [false, 10] });
    // ...nor with a non-EXECUTED state that would make onWriteAtom skip
    // scheduling this later direct write in the same task.
    b.set(20);
    expectSpy(spy, 3, { args: [false, 20] });
  });

  test("immediateEffect does not rerun when a computed dependency recomputes to an equal value", () => {
    const a = signal(1);
    const isPositive = computed(() => a() > 0);
    const spy = vi.fn();
    immediateEffect(() => spy(isPositive()));
    expectSpy(spy, 1, { args: [true] });
    a.set(2);
    expectSpy(spy, 1, { args: [true] });
    a.set(-1);
    expectSpy(spy, 2, { args: [false] });
  });

  test("an immediateEffect that writes the source of a computed it read keeps tracking the computed", () => {
    const n = signal(0);
    const double = computed(() => n() * 2);
    const seen: number[] = [];
    immediateEffect(() => {
      const value = double();
      seen.push(value);
      if (!value) {
        n.set(1);
      }
    });
    n.set(5);
    n.set(6);
    expect(seen).toEqual([0, 10, 12]);
  });

  test("an immediateEffect sees an array method's result, not its intermediate states", () => {
    const list = proxy(["a", "b", "c"]);
    const seen: string[] = [];
    immediateEffect(() => {
      seen.push(list.join(","));
    });
    list.splice(0, 1);
    list.unshift("z");
    list.reverse();
    expect(seen).toEqual(["a,b,c", "b,c", "z,b,c", "c,b,z"]);
  });

  test("immediateEffect should unsubscribe previous dependencies", () => {
    const state = proxy({ a: 1, b: 10, c: 100 });
    const spy = vi.fn();
    immediateEffect(() => {
      if (state.a === 1) {
        spy(state.b);
      } else {
        spy(state.c);
      }
    });
    expectSpy(spy, 1, { args: [10] });
    state.b = 20;
    expectSpy(spy, 2, { args: [20] });
    state.a = 2;
    expectSpy(spy, 3, { args: [100] });
    state.b = 30;
    expectSpy(spy, 3, { args: [100] });
    state.c = 200;
    expectSpy(spy, 4, { args: [200] });
  });

  test("immediateEffect should not run if dependencies do not change", () => {
    const state = proxy({ a: 1 });
    const spy = vi.fn();
    immediateEffect(() => {
      spy(state.a);
    });
    expectSpy(spy, 1, { args: [1] });
    state.a = 1;
    expectSpy(spy, 1, { args: [1] });
    state.a = 2;
    expectSpy(spy, 2, { args: [2] });
  });

  test("immediateEffect should call cleanup function", () => {
    const state = proxy({ a: 1 });
    const spy = vi.fn();
    const cleanup = vi.fn();
    immediateEffect(() => {
      spy(state.a);
      return cleanup;
    });
    expectSpy(spy, 1, { args: [1] });
    expect(cleanup).toHaveBeenCalledTimes(0);
    state.a = 2;
    expectSpy(spy, 2, { args: [2] });
    expect(cleanup).toHaveBeenCalledTimes(1);
    state.a = 3;
    expectSpy(spy, 3, { args: [3] });
    expect(cleanup).toHaveBeenCalledTimes(2);
  });

  test("immediateEffect should be able to unsubscribe", () => {
    const state = proxy({ a: 1 });
    const spy = vi.fn();
    const unsubscribe = immediateEffect(() => {
      spy(state.a);
    });
    expectSpy(spy, 1, { args: [1] });
    state.a = 2;
    expectSpy(spy, 2, { args: [2] });
    unsubscribe();
    state.a = 3;
    expectSpy(spy, 2, { args: [2] });
  });

  test("immediateEffect and effect can coexist", async () => {
    const state = proxy({ a: 1 });
    const immediateSpy = vi.fn();
    const batchedSpy = vi.fn();

    immediateEffect(() => immediateSpy(state.a));
    effect(() => batchedSpy(state.a));

    expectSpy(immediateSpy, 1, { args: [1] });
    expectSpy(batchedSpy, 1, { args: [1] });

    state.a = 2;

    expectSpy(immediateSpy, 2, { args: [2] });
    expectSpy(batchedSpy, 1, { args: [1] });

    await waitScheduler();

    expectSpy(batchedSpy, 2, { args: [2] });
  });

  describe("nested immediateEffects", () => {
    test("should track correctly", () => {
      const state = proxy({ a: 1, b: 10 });
      const spy1 = vi.fn();
      const spy2 = vi.fn();
      immediateEffect(() => {
        spy1(state.a);
        if (state.a === 1) {
          immediateEffect(() => {
            spy2(state.b);
          });
        }
      });
      expectSpy(spy1, 1, { args: [1] });
      expectSpy(spy2, 1, { args: [10] });
      state.b = 20;
      expectSpy(spy1, 1, { args: [1] });
      expectSpy(spy2, 2, { args: [20] });
      state.a = 2;
      expectSpy(spy1, 2, { args: [2] });
      expectSpy(spy2, 2, { args: [20] });
      state.b = 30;
      expectSpy(spy1, 2, { args: [2] });
      expectSpy(spy2, 2, { args: [20] });
    });
  });

  test("a throwing immediate effect reaches the writer after every other effect ran", async () => {
    const s = signal(0);
    const log: string[] = [];
    immediateEffect(() => {
      if (s() === 1) {
        throw new Error("boom");
      }
      log.push(`a${s()}`);
    });
    immediateEffect(() => {
      log.push(`b${s()}`);
    });
    effect(() => {
      log.push(`c${s()}`);
    });
    expect(() => s.set(1)).toThrow("boom");
    expect(log).toEqual(["a0", "b0", "c0", "b1"]);
    await waitScheduler();
    expect(log).toEqual(["a0", "b0", "c0", "b1", "c1"]);
    s.set(2);
    expect(log).toEqual(["a0", "b0", "c0", "b1", "c1", "a2", "b2"]);
  });
});

describe("owner of an effect", () => {
  test("a parent writing what its immediate child reads is not re-entered", () => {
    const x = signal(0);
    let parentRuns = 0;
    const childSeen: number[] = [];
    const dispose = effect(() => {
      parentRuns++;
      immediateEffect(() => {
        childSeen.push(x());
      });
      x.set(parentRuns);
    });
    expect(parentRuns).toBe(1);
    expect(childSeen).toEqual([0, 1]);
    dispose();
  });

  test("a parent's cleanup runs once per run when its immediate child re-runs inside it", () => {
    const x = signal(0);
    const log: string[] = [];
    let run = 0;
    const dispose = effect(() => {
      const r = ++run;
      log.push(`start ${r}`);
      immediateEffect(() => {
        x();
      });
      x.set(1);
      log.push(`end ${r}`);
      return () => log.push(`cleanup ${r}`);
    });
    dispose();
    expect(log).toEqual(["start 1", "end 1", "cleanup 1"]);
  });

  test("a deferred parent is not pulled into the write that re-runs its immediate child", async () => {
    const a = signal(0);
    const b = signal(0);
    const log: string[] = [];
    effect(() => {
      log.push(`parent a=${a()} b=${b()}`);
      immediateEffect(() => {
        log.push(`child a=${a()}`);
      });
    });
    log.length = 0;
    a.set(1);
    b.set(1);
    // the immediate child runs inside the write; its deferred parent does not
    expect(log).toEqual(["child a=1"]);
    await waitScheduler();
    expect(log).toEqual(["child a=1", "parent a=1 b=1", "child a=1"]);
  });
});

describe("array methods run as one batch", () => {
  test("the method's own error propagates, not an immediate effect's", () => {
    const list = proxy([1, 2, 3]);
    Object.defineProperty(list, 1, { value: 2, writable: false });
    const seen: number[] = [];
    immediateEffect(() => {
      seen.push(list[0]);
      if (list[0] === 0) {
        throw new Error("immediate saw 0");
      }
    });
    let error: any = null;
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      list.fill(0);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(TypeError);
    return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
      process.off("unhandledRejection", onRejection);
      expect(rejections).toMatchObject([{ message: "immediate saw 0" }]);
    });
  });
});

describe("owner chain", () => {
  test("an immediate grandparent due runs before a stale child, past a deferred parent", async () => {
    const a = signal(0);
    const log: string[] = [];
    immediateEffect(() => {
      const ga = untrack(a);
      effect(() => {
        immediateEffect(() => {
          log.push(`child ga=${ga} a=${a()}`);
        });
      });
      // read after the subtree exists: the child is notified first
      a();
    });
    log.length = 0;
    a.set(1);
    await waitScheduler();
    expect(log).toEqual(["child ga=1 a=1"]);
  });
});

describe("batch", () => {
  test("is public: immediate effects run once, after the outermost batch", async () => {
    const { batch } = await import("../src");
    const a = signal(1);
    const b = signal(1);
    const seen: number[] = [];
    immediateEffect(() => seen.push(a() + b()));
    batch(() => {
      a.set(2);
      batch(() => b.set(2));
      expect(seen).toEqual([2]);
    });
    expect(seen).toEqual([2, 4]);
  });
});
