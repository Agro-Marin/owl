import v8 from "node:v8";
import vm from "node:vm";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  type Atom,
  atomSymbol,
  batch,
  computed,
  effect,
  immediateEffect,
  observersOf,
  proxy,
  selector,
  setDebug,
  setDebugSink,
  signal,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

v8.setFlagsFromString("--expose-gc");
const gc: () => void = vm.runInNewContext("gc");
function subscribers(value: unknown) {
  return observersOf((value as { [atomSymbol]: Atom })[atomSymbol]);
}
let traces: string[];
beforeEach(() => {
  traces = [];
  // Recording live key objects here would invalidate the lifetime probes.
  setDebugSink((channel, message) => traces.push(`${channel}: ${message}`));
  setDebug("reactivity,effect,computed,scope,error");
});
afterEach((context) => {
  if (context.task.result?.state === "fail") console.debug("[owl:selector-review]", traces);
  setDebug(false);
  setDebugSink(null);
});

test.each([0, -0])("leaving signed zero %s does not notify the other zero's reader", (initial) => {
  const selected = signal(initial);
  const isSelected = selector(selected);
  const other = Object.is(initial, -0) ? 0 : -0;
  let unaffectedRuns = 0;
  const seen: boolean[] = [];
  const stopUnaffected = immediateEffect(() => {
    unaffectedRuns++;
    if (unaffectedRuns > 1) throw new Error("an unchanged selector answer was notified");
    expect(isSelected(other)).toBe(false);
  });
  const stopAffected = immediateEffect(() => {
    seen.push(isSelected(initial));
  });
  try {
    expect(() => selected.set(1)).not.toThrow();
    console.debug("[owl:selector-review] signed zero", {
      negative: Object.is(initial, -0),
      unaffectedRuns,
      seen,
    });
    expect(unaffectedRuns).toBe(1);
    expect(seen).toEqual([true, false]);
  } finally {
    stopUnaffected();
    stopAffected();
  }
});

test("both signed-zero answers change when selection switches between them", () => {
  const selected = signal(0);
  const isSelected = selector(selected);
  const positive: boolean[] = [];
  const negative: boolean[] = [];
  const stopPositive = immediateEffect(() => {
    positive.push(isSelected(0));
  });
  const stopNegative = immediateEffect(() => {
    negative.push(isSelected(-0));
  });
  try {
    selected.set(-0);
    expect(positive).toEqual([true, false]);
    expect(negative).toEqual([false, true]);
  } finally {
    stopPositive();
    stopNegative();
  }
});

test("untracked signed-zero queries preserve Object.is", () => {
  const selected = signal(-0);
  const isSelected = selector(selected);
  expect(isSelected(-0)).toBe(true);
  expect(isSelected(0)).toBe(false);
  selected.set(0);
  expect(isSelected(0)).toBe(true);
  expect(isSelected(-0)).toBe(false);
});

test("a stable NaN selection does not notify its reader", () => {
  const selected = signal(NaN);
  const isSelected = selector(selected);
  let runs = 0;
  const stop = immediateEffect(() => {
    runs++;
    expect(isSelected(NaN)).toBe(true);
  });
  try {
    selected.set(NaN);
    expect(runs).toBe(1);
  } finally {
    stop();
  }
});

test.each([
  {
    name: "Error instances",
    first: new Error("first failure"),
    second: new Error("second failure"),
  },
  { name: "strings", first: "first failure", second: "second failure" },
  { name: "falsy values", first: 0, second: false },
  { name: "undefined and null", first: undefined, second: null },
])("a changed source failure notifies every key reader ($name)", async ({ first, second }) => {
  const version = signal(0);
  const isSelected = selector(() => {
    if (version() === 0) throw first;
    if (version() === 1) throw second;
    return "selected";
  });
  const seen: unknown[][] = [[], []];
  const stops = ["selected", "other"].map((key, index) =>
    effect(() => {
      try {
        seen[index].push(isSelected(key));
      } catch (error) {
        seen[index].push(error);
      }
    })
  );
  try {
    version.set(1);
    await waitScheduler();
    console.debug("[owl:selector-review] source failure change", seen);
    expect(seen).toEqual([
      [first, second],
      [first, second],
    ]);
    version.set(2);
    await waitScheduler();
    expect(seen).toEqual([
      [first, second, true],
      [first, second, false],
    ]);
  } finally {
    stops.forEach((stop) => stop());
  }
});

test("rethrowing the same source failure does not change a key's answer", () => {
  const tick = signal(0);
  const failure = new Error("stable failure");
  const isSelected = selector<string>(() => {
    tick();
    throw failure;
  });
  let runs = 0;
  const stop = immediateEffect(() => {
    runs++;
    expect(() => isSelected("row")).toThrow(failure);
  });
  try {
    tick.set(1);
    expect(runs).toBe(1);
  } finally {
    stop();
  }
});

test("a disposed selector keeps its last failure instead of an older selection", () => {
  const scope = new TestScope({});
  const broken = signal(false);
  const failure = new Error("selection failed");
  let reads = 0;
  const isSelected = scope.run(() =>
    selector(() => {
      reads++;
      if (broken()) throw failure;
      return "row";
    })
  );
  const seen: unknown[] = [];
  const stop = immediateEffect(() => {
    try {
      seen.push(isSelected("row"));
    } catch (error) {
      seen.push(error);
    }
  });
  try {
    broken.set(true);
    expect(seen).toEqual([true, failure]);
    scope.finalize((error) => {
      throw error;
    });
    const before = reads;
    broken.set(false);
    expect(() => isSelected("row")).toThrow(failure);
    expect(reads).toBe(before);
  } finally {
    stop();
    scope.finalize(() => {});
  }
});

test.each(["value", "error"])("an immediate %s reader can choose a fallback selection", (mode) => {
  const version = signal(0);
  const failure = new Error("fallback needed");
  const isSelected = selector(() => {
    const current = version();
    if (current === 1 && mode === "error") throw failure;
    return ["initial", "trigger", "final"][current];
  });
  const stopFallback = immediateEffect(() => {
    try {
      if (isSelected("trigger")) version.set(2);
    } catch (error) {
      if (error === failure) version.set(2);
      else throw error;
    }
  });
  const seen: unknown[] = [];
  const stopFinal = immediateEffect(() => {
    try {
      seen.push(isSelected("final"));
    } catch (error) {
      seen.push(error);
    }
  });
  try {
    version.set(1);
    console.debug("[owl:selector-review] reentrant fallback", mode, version(), seen);
    expect(version()).toBe(2);
    expect(seen.at(-1)).toBe(true);
    expect(isSelected("final")).toBe(true);
    expect(isSelected("trigger")).toBe(false);
  } finally {
    stopFallback();
    stopFinal();
  }
});

test.each(["value", "error"])(
  "a source destroying its scope cannot replace the frozen answer (%s)",
  (mode) => {
    const scope = new TestScope({});
    const destroy = signal(false);
    const failure = new Error("late source failure");
    let reads = 0;
    const isSelected = scope.run(() =>
      selector(() => {
        reads++;
        if (destroy()) {
          scope.finalize(() => {});
          if (mode === "error") throw failure;
          return "late";
        }
        return "initial";
      })
    );
    const stop = immediateEffect(() => {
      isSelected("initial");
    });
    try {
      destroy.set(true);
      expect(scope.isDestroyed()).toBe(true);
      expect(isSelected("initial")).toBe(true);
      expect(isSelected("late")).toBe(false);
      expect(reads).toBe(2);
    } finally {
      stop();
      scope.finalize(() => {});
    }
  }
);

test("a disposed selector preserves a failure from an untracked read", () => {
  const scope = new TestScope({});
  const failure = new Error("untracked source failed");
  const isSelected = scope.run(() =>
    selector<string>(() => {
      throw failure;
    })
  );
  expect(() => isSelected("row")).toThrow(failure);
  scope.finalize(() => {});
  expect(() => isSelected("row")).toThrow(failure);
});

test("a batched untracked read still throws when the last key's reader has stopped", () => {
  const broken = signal(false);
  const failure = new Error("source failed after its reader stopped");
  const isSelected = selector(() => {
    if (broken()) throw failure;
    return "row";
  });
  const stop = effect(() => {
    isSelected("row");
  });
  stop();
  batch(() => {
    broken.set(true);
    expect(() => isSelected("row")).toThrow(failure);
  });
});

test("notification failure remains primary when the previous source cleanup also fails", () => {
  const root = resolve(__dirname, "../../..");
  const script = `
    import assert from "node:assert/strict";
    import { build } from ${JSON.stringify(resolve(root, "node_modules/esbuild/lib/main.js"))};
    const {outputFiles} = await build({entryPoints: [${JSON.stringify(resolve(root, "packages/owl-core/src/index.ts"))}], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent"});
    const owl = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
    owl.setDebugSink((channel, message) => console.debug("[owl:" + channel + "] " + message));
    owl.setDebug("reactivity,effect,computed,error");
    const unhandled = [];
    process.on("unhandledRejection", error => { unhandled.push(error); console.debug("[owl:selector-secondary]", error.message); });
    const version = owl.signal(0);
    const cleanupFailure = new Error("source cleanup failed");
    const notificationFailure = new Error("key notification failed");
    const isSelected = owl.selector(() => {
      const current = version();
      owl.effect(() => () => { if (current === 0) throw cleanupFailure; });
      return current;
    });
    const stop = owl.immediateEffect(() => { if (!isSelected(0)) throw notificationFailure; });
    let caught;
    try { version.set(1); } catch (error) { caught = error; }
    assert.equal(caught, notificationFailure);
    assert.equal(isSelected(1), true);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(unhandled, [cleanupFailure]);
    console.debug("[owl:selector-failure-order]", {primary: caught.message, secondary: unhandled.map(error => error.message)});
    stop(); version.set(2);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(unhandled.length, 1);
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  console.debug("[owl:selector-failure-order-probe]", run.status, run.stdout, run.stderr);
  expect(run.error).toBeUndefined();
  expect(run.status).toBe(0);
});

test.each(["selection", "error", "undefined", "derived"])(
  "unused selectors release an unchanged %s source",
  (mode) => {
    const tick = signal(0);
    const stable = computed(() => {
      tick();
      return "row";
    });
    const failure = new Error("stable source failure");
    let created = 0;
    let cleaned = 0;
    const choose = selector(() => {
      if (mode === "derived") stable();
      else tick();
      created++;
      effect(() => () => {
        cleaned++;
      });
      if (mode === "error") throw failure;
      if (mode === "undefined") throw undefined;
      return "row";
    });
    const stop = effect(() => {
      try {
        choose("row");
      } catch {}
    });
    stop();
    tick.set(1);
    console.debug(
      "[owl:selector-review] unchanged unused source",
      mode,
      created,
      cleaned,
      subscribers(tick).length
    );
    expect(subscribers(tick)).toEqual([]);
    expect(cleaned).toBe(created);
  }
);

test("checking an unchanged derived source preserves a live key reader", () => {
  const tick = signal(0);
  const stable = computed(() => {
    tick();
    return "row";
  });
  const choose = selector(stable);
  let runs = 0;
  const stop = effect(() => {
    runs++;
    expect(choose("row")).toBe(true);
  });
  try {
    tick.set(1);
    expect(runs).toBe(1);
    expect(subscribers(tick)).toHaveLength(1);
  } finally {
    stop();
    tick.set(2);
  }
});

test("releasing source-owned work cannot restart the unused selector", () => {
  const tick = signal(0);
  let created = 0;
  let cleaned = 0;
  const choose = selector(() => {
    tick();
    created++;
    effect(() => () => {
      cleaned++;
      tick.set(tick() + 1);
    });
    return "row";
  });
  const stop = effect(() => {
    choose("row");
  });
  stop();
  tick.set(1);
  expect(created).toBe(2);
  expect(cleaned).toBe(2);
  expect(subscribers(tick)).toEqual([]);
});

test("scope cleanup cannot restart a selector through another source", () => {
  const scope = new TestScope({});
  const other = proxy({ value: 0 });
  const upstream = computed(() => {
    effect(() => () => {
      other.value = 1;
    });
    return 0;
  });
  let reads = 0;
  const choose = scope.run(() =>
    selector(() => {
      reads++;
      return upstream() + other.value;
    })
  );
  const stop = effect(() => {
    choose(0);
  });
  try {
    scope.finalize((error) => {
      throw error;
    });
    console.debug("[owl:selector-review] disposal source writes", reads, other.value);
    expect(reads).toBe(1);
    expect(other.value).toBe(1);
    expect(choose(0)).toBe(true);
  } finally {
    stop();
    scope.finalize(() => {});
  }
});

describe.each(["object", "symbol"])("disposed selector %s key lifetime", (kind) => {
  test.each([false, true])(
    "keys are released even when owned cleanup throws=%s",
    async (throws) => {
      const scope = new TestScope({});
      const failure = new Error("selector source cleanup failed");
      const errors: unknown[] = [];
      let cleaned = 0;
      const isSelected = scope.run(() =>
        selector<unknown>(() => {
          effect(() => () => {
            cleaned++;
            if (throws) throw failure;
          });
          return 0;
        })
      );
      let key: WeakKey | null = kind === "object" ? {} : Symbol("selector key");
      const reference = new WeakRef(key);
      const stop = immediateEffect(() => {
        isSelected(key);
      });
      scope.finalize((error) => {
        errors.push(error);
      });
      stop();
      key = null;
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        gc();
      }
      // Keep the selector alive: losing the table itself would hide retention.
      expect(isSelected(0)).toBe(true);
      console.debug("[owl:selector-review] key lifetime", {
        kind,
        throws,
        cleaned,
        collected: reference.deref() === undefined,
      });
      expect(cleaned).toBe(1);
      expect(errors).toEqual(throws ? [failure] : []);
      expect(reference.deref()).toBeUndefined();
    }
  );
});
