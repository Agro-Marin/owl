import {
  type Atom,
  atomSymbol,
  observersOf,
  setDebug,
  setDebugSink,
  signal,
  useEffect,
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
