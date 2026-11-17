import {
  type Atom,
  atomSymbol,
  observersOf,
  setDebug,
  setDebugSink,
  signal,
  useEffect,
  useImmediateEffect,
  batch,
  useListener,
  useOnChange,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

const rethrow = (error: unknown) => {
  throw error;
};
function subscribers(value: unknown) {
  return observersOf((value as { [atomSymbol]: Atom })[atomSymbol]);
}
let traces: string[];
beforeEach(() => {
  traces = [];
  setDebugSink((channel, message) => traces.push(`${channel}: ${message}`));
  setDebug("reactivity,effect,computed,scope,event");
});
afterEach((context) => {
  if (context.task.result?.state === "fail") console.debug("[owl:hook-lifetime-review]", traces);
  setDebug(false);
  setDebugSink(null);
});

test("useEffect outside a scope does not run or subscribe", () => {
  const tick = signal(0);
  let calls = 0;
  expect(() =>
    useEffect(() => {
      calls++;
      tick();
    })
  ).toThrow("No active scope");
  console.debug("[owl:hook-lifetime-review] invalid effect", calls, subscribers(tick).length);
  expect(calls).toBe(0);
  expect(subscribers(tick)).toEqual([]);
});

test("useImmediateEffect outside a scope creates no orphan effect", () => {
  const value = signal(0);
  let runs = 0;
  expect(() =>
    useImmediateEffect(() => {
      value();
      runs++;
    })
  ).toThrow("No active scope");
  value.set(1);
  expect(runs).toBe(0);
  expect(subscribers(value)).toEqual([]);
});

test("useImmediateEffect batches writes and releases its subscriptions with the scope", () => {
  const value = signal(0);
  const scope = new TestScope({});
  const seen: number[] = [];
  let cleanups = 0;
  scope.run(() =>
    useImmediateEffect(() => {
      seen.push(value());
      return () => {
        cleanups++;
      };
    })
  );
  batch(() => {
    value.set(1);
    value.set(2);
  });
  expect(seen).toEqual([0, 2]);
  expect(cleanups).toBe(1);
  scope.finalize(rethrow);
  value.set(3);
  expect(seen).toEqual([0, 2]);
  expect(cleanups).toBe(2);
  expect(subscribers(value)).toEqual([]);
});

test("useImmediateEffect releases a callback that destroys its own scope during setup", () => {
  const value = signal(0);
  const scope = new TestScope({});
  let cleanups = 0;
  scope.run(() =>
    useImmediateEffect(() => {
      value();
      scope.finalize(rethrow);
      return () => {
        cleanups++;
      };
    })
  );
  value.set(1);
  expect(cleanups).toBe(1);
  expect(subscribers(value)).toEqual([]);
});

test("useImmediateEffect leaves no subscription when its first callback throws", () => {
  const value = signal(0);
  const scope = new TestScope({});
  let runs = 0;
  expect(() =>
    scope.run(() =>
      useImmediateEffect(() => {
        value();
        runs++;
        throw new Error("setup failed");
      })
    )
  ).toThrow("setup failed");
  value.set(1);
  scope.finalize(rethrow);
  expect(runs).toBe(1);
  expect(subscribers(value)).toEqual([]);
});

test.each([true, false])(
  "useOnChange outside a scope does not evaluate dependencies (initialRun=%s)",
  (initialRun) => {
    const tick = signal(0);
    let reads = 0;
    let calls = 0;
    expect(() =>
      useOnChange(
        () => {
          reads++;
          return [tick()];
        },
        () => {
          calls++;
        },
        { initialRun }
      )
    ).toThrow("No active scope");
    console.debug("[owl:hook-lifetime-review] invalid change hook", initialRun, reads, calls);
    expect(reads).toBe(0);
    expect(calls).toBe(0);
    expect(subscribers(tick)).toEqual([]);
  }
);

test.each(["direct", "signal"])("useListener outside a scope leaves no listener (%s)", (mode) => {
  const target = new EventTarget();
  const reference = signal<EventTarget | null>(target);
  let calls = 0;
  expect(() =>
    useListener(mode === "direct" ? target : reference, "ping", () => {
      calls++;
    })
  ).toThrow("No active scope");
  target.dispatchEvent(new Event("ping"));
  console.debug("[owl:hook-lifetime-review] invalid listener", mode, calls);
  expect(calls).toBe(0);
  expect(subscribers(reference)).toEqual([]);
});

test("useEffect still runs, reruns and releases cleanup with its scope", async () => {
  const tick = signal(0);
  const scope = new TestScope({});
  let calls = 0;
  let cleaned = 0;
  scope.run(() =>
    useEffect(() => {
      tick();
      calls++;
      return () => {
        cleaned++;
      };
    })
  );
  tick.set(1);
  await waitScheduler();
  expect(calls).toBe(2);
  expect(cleaned).toBe(1);
  scope.finalize(rethrow);
  expect(cleaned).toBe(2);
  expect(subscribers(tick)).toEqual([]);
});

test.each(["direct", "signal"])("useListener still removes its scoped listener (%s)", (mode) => {
  const target = new EventTarget();
  const reference = signal<EventTarget | null>(target);
  const scope = new TestScope({});
  let calls = 0;
  scope.run(() =>
    useListener(mode === "direct" ? target : reference, "ping", () => {
      calls++;
    })
  );
  target.dispatchEvent(new Event("ping"));
  expect(calls).toBe(1);
  scope.finalize(rethrow);
  target.dispatchEvent(new Event("ping"));
  expect(calls).toBe(1);
  expect(subscribers(reference)).toEqual([]);
});
