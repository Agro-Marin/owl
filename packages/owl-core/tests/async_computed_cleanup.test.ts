import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { asyncComputed, effect, immediateEffect, setDebug, setDebugSink, signal } from "../src";
import { TestScope, waitScheduler } from "./helpers";

let lines: string[];

beforeEach(() => {
  lines = [];
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
  setDebug(["effect", "scope", "reactivity"]);
});

afterEach((context) => {
  if (context.task.result?.state === "fail") {
    console.debug("[owl:async-cleanup-test]", lines);
  }
  setDebug(false);
  setDebugSink(null);
});

test("non-Error failures with throwing inspectors are published through error()", () => {
  const root = resolve(__dirname, "../../..");
  const script = `
    import assert from "node:assert/strict";
    import vm from "node:vm";
    import { build } from ${JSON.stringify(resolve(root, "node_modules/esbuild/lib/main.js"))};
    const { outputFiles } = await build({
      entryPoints: [${JSON.stringify(resolve(root, "packages/owl-core/src/index.ts"))}],
      bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent"
    });
    const owl = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
    owl.setDebug("effect,error");
    const unhandled = [];
    process.on("unhandledRejection", error => { unhandled.push(error); console.debug("[owl:unhandled-error-shape]", error.message); });
    const cases = [
      ["null prototype", () => Object.create(null)],
      ["throwing name", () => Object.defineProperty({}, "name", {get() { throw new Error("name inspection failed"); }})],
      ["throwing conversion", () => ({[Symbol.toPrimitive]() { throw new Error("conversion failed"); }})],
      ["throwing prototype", () => new Proxy({}, {getPrototypeOf() { throw new Error("prototype inspection failed"); }})],
      ["string", () => "fetch failed"],
      ["local Error", () => new Error("fetch failed")],
      ["foreign Error", () => vm.runInNewContext('new Error("fetch failed")')],
    ];
    const failures = [];
    for (const asynchronous of [false, true]) {
      for (const [name, makeFailure] of cases) {
        const thrown = makeFailure();
        let data;
        try {
          data = owl.asyncComputed(() => { if (asynchronous) return Promise.reject(thrown); throw thrown; });
          await data.currentPromise();
          const stored = data.error();
          assert(stored);
          if (name.endsWith("Error")) assert.equal(stored, thrown);
          else { assert(stored instanceof Error); assert.equal(stored.cause, thrown); }
          assert.equal(typeof stored.message, "string");
          assert.equal(data.loading(), false);
          console.debug("[owl:error-shape]", {name, asynchronous, published: true, message: stored.message});
        } catch (error) {
          failures.push({name, asynchronous, error: error.message});
          console.debug("[owl:error-shape] failed", {name, asynchronous, error: error.message});
        } finally { data?.dispose(); }
      }
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(failures, []);
    assert.equal(unhandled.length, 0);
  `;
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  console.debug("[owl:error-shape-probe]", run.status, run.stdout, run.stderr);
  expect(run.status).toBe(0);
});

test("error inspection does not subscribe the fetcher to the inspector's signal reads", async () => {
  const unrelated = signal(0);
  let fetches = 0;
  const failure = {
    get name() {
      unrelated();
      return "Failure";
    },
    [Symbol.toPrimitive]() {
      unrelated();
      return "fetch failed";
    },
  };
  const data = asyncComputed(() => {
    fetches++;
    throw failure;
  });
  try {
    expect(data.error()?.cause).toBe(failure);
    unrelated.set(1);
    await waitScheduler();
    expect(fetches).toBe(1);
  } finally {
    data.dispose();
  }
});

test("effects created by synchronous error conversion keep their cleanup ownership", () => {
  let cleaned = 0;
  const failure = {
    [Symbol.toPrimitive]() {
      effect(() => () => {
        cleaned++;
      });
      return "fetch failed";
    },
  };
  const data = asyncComputed(() => {
    throw failure;
  });
  data.dispose();
  expect(cleaned).toBe(1);
});

test.each(["value", "error", "loading"] as const)(
  "currentPromise waits for a refresh requested by a %s observer",
  async (channel) => {
    const runs: Array<ReturnType<typeof Promise.withResolvers<number>>> = [];
    const data = asyncComputed(() => {
      const run = Promise.withResolvers<number>();
      runs.push(run);
      return run.promise;
    });
    const stop = immediateEffect(() => {
      const refresh =
        channel === "value"
          ? data() === 1
          : channel === "error"
            ? data.error() !== null
            : !data.loading() && runs.length === 1;
      if (refresh) data.refresh();
    });
    let settled = false;
    const pending = data.currentPromise().then(() => {
      settled = true;
    });
    try {
      if (channel === "error") runs[0].reject(new Error("first run failed"));
      else runs[0].resolve(1);
      await waitScheduler();
      console.debug("[owl:async-revalidation]", {
        runs: runs.length,
        settled,
        loading: data.loading(),
      });
      expect(runs).toHaveLength(2);
      expect(settled).toBe(false);
      runs[1].resolve(2);
      await pending;
      expect(data()).toBe(2);
      expect(data.loading()).toBe(false);
    } finally {
      stop();
      data.dispose();
    }
  }
);

test("a synchronous fetch failure retains waiters for the refresh its error observer requests", async () => {
  let runs = 0;
  const last = Promise.withResolvers<number>();
  const data = asyncComputed(() => {
    runs++;
    if (runs === 2) throw new Error("second run failed");
    return runs === 1 ? 0 : last.promise;
  });
  await data.currentPromise();
  const stop = immediateEffect(() => {
    if (data.error()) data.refresh();
  });
  let settled = false;
  try {
    data.refresh();
    const pending = data.currentPromise().then(() => {
      settled = true;
    });
    await waitScheduler();
    await waitScheduler();
    expect(runs).toBe(3);
    expect(settled).toBe(false);
    last.resolve(3);
    await pending;
    expect(data()).toBe(3);
  } finally {
    stop();
    data.dispose();
  }
});

test("a value observer disposing the run cannot retain a newly requested waiter", async () => {
  const run = Promise.withResolvers<number>();
  const data = asyncComputed(() => run.promise);
  let settled = false;
  const stop = immediateEffect(() => {
    if (data() === 1) {
      data.dispose();
      void data.currentPromise().then(() => {
        settled = true;
      });
    }
  });
  try {
    run.resolve(1);
    await waitScheduler();
    expect(settled).toBe(true);
    expect(data.loading()).toBe(false);
  } finally {
    stop();
    data.dispose();
  }
});

test("disposal discards a refresh deferred during synchronous reporting", async () => {
  let runs = 0;
  const signals: AbortSignal[] = [];
  const data = asyncComputed(({ abortSignal }) => {
    signals.push(abortSignal);
    if (++runs === 2) throw new Error("second run failed");
    return 0;
  });
  await data.currentPromise();
  const stop = immediateEffect(() => {
    if (data.error()) {
      data.refresh();
      data.dispose();
    }
  });
  try {
    data.refresh();
    await data.currentPromise();
    await waitScheduler();
    expect(runs).toBe(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(data.loading()).toBe(false);
  } finally {
    stop();
    data.dispose();
  }
});

test.each(["loading", "error"] as const)(
  "disposal from a starting %s observer prevents fetching and releases waiters",
  async (channel) => {
    let fetches = 0;
    const data = asyncComputed(() => {
      fetches++;
      if (channel === "error" && fetches === 1) throw new Error("first run failed");
      return fetches;
    });
    await data.currentPromise();
    const stop = immediateEffect(() => {
      if (channel === "loading" ? data.loading() : data.error() === null) data.dispose();
    });
    let settled = false;
    try {
      data.refresh();
      void data.currentPromise().then(() => {
        settled = true;
      });
      await waitScheduler();
      await waitScheduler();
      console.debug("[owl:async-start-disposal]", { fetches, settled, loading: data.loading() });
      expect(fetches).toBe(1);
      expect(settled).toBe(true);
      expect(data.loading()).toBe(false);
    } finally {
      stop();
      data.dispose();
    }
  }
);

test.each(["dispose", "rerun", "scope"] as const)(
  "%s aborts a run whose fetcher threw synchronously",
  async (action) => {
    const trigger = signal(0);
    const signals: AbortSignal[] = [];
    const boom = new Error("fetcher failed");
    const scope = new TestScope({});
    const data = scope.run(() =>
      asyncComputed(({ abortSignal }) => {
        trigger();
        signals.push(abortSignal);
        throw boom;
      })
    );
    expect(data.error()).toBe(boom);
    expect(data.loading()).toBe(false);
    if (action === "dispose") {
      data.dispose();
    } else if (action === "scope") {
      scope.finalize((error) => {
        throw error;
      });
    } else {
      trigger.set(1);
      await waitScheduler();
    }
    expect(signals[0].aborted).toBe(true);
    data.dispose();
    scope.finalize((error) => {
      throw error;
    });
  }
);

test("disposing a run releases awaiters even when an owned cleanup throws", async () => {
  const boom = new Error("child cleanup failed");
  let abortSignal: AbortSignal | undefined;
  const data = asyncComputed((context) => {
    abortSignal = context.abortSignal;
    effect(() => () => {
      throw boom;
    });
    return new Promise<number>(() => {});
  });
  let settled = false;
  void data.currentPromise().then(() => {
    settled = true;
  });
  expect(() => data.dispose()).toThrow(boom);
  await waitScheduler();
  expect(settled).toBe(true);
  expect(data.loading()).toBe(false);
  expect(abortSignal?.aborted).toBe(true);
});

test("a throwing loading observer cannot strand currentPromise during disposal", async () => {
  const boom = new Error("loading observer failed");
  const data = asyncComputed(() => new Promise<number>(() => {}));
  const stop = immediateEffect(() => {
    if (!data.loading()) throw boom;
  });
  let settled = false;
  void data.currentPromise().then(() => {
    settled = true;
  });
  try {
    expect(() => data.dispose()).toThrow(boom);
    await waitScheduler();
    expect(settled).toBe(true);
    expect(data.loading()).toBe(false);
  } finally {
    stop();
    data.dispose();
  }
});
test.each([
  "value observer",
  "error observer",
  "equality",
  "synchronous reporting",
  "starting loading",
  "cleanup plus loading",
] as const)("a throwing %s still settles the async run and surfaces its error", (scenario) => {
  const root = resolve(__dirname, "../../..");
  const script = `
      import assert from "node:assert/strict";
      import { build } from ${JSON.stringify(resolve(root, "node_modules/esbuild/lib/main.js"))};
      const { outputFiles } = await build({
        entryPoints: [${JSON.stringify(resolve(root, "packages/owl-core/src/index.ts"))}],
        bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent"
      });
      const owl = await import("data:text/javascript;base64," + Buffer.from(outputFiles[0].contents).toString("base64"));
      owl.setDebug("effect,reactivity");
      const scenario = ${JSON.stringify(scenario)};
      const boom = new Error("expected notification failure");
      const secondary = new Error("loading failed during cleanup");
      const unhandled = [];
      const trigger = owl.signal(false);
      const unrelated = owl.signal(0);
      const signals = [];
      process.on("unhandledRejection", error => {
        unhandled.push(error);
        console.debug("[owl:async-settlement] unhandled", error.message);
      });
      const data = owl.asyncComputed(
        context => {
          signals.push(context.abortSignal);
          context.abortSignal.addEventListener("abort", () => { unrelated(); });
          if (scenario === "cleanup plus loading") owl.effect(() => () => { throw boom; });
          if (trigger() && scenario === "synchronous reporting") throw boom;
          return scenario === "error observer" ? Promise.reject(boom) : Promise.resolve(1);
        },
        scenario === "equality" ? { equals() { throw boom; } } : {}
      );
      const stop = owl.immediateEffect(() => {
        if (scenario === "value observer" && data() === 1) throw boom;
        if ((scenario === "error observer" || scenario === "synchronous reporting") && data.error() === boom) throw boom;
        if (scenario === "starting loading" && data.loading() && trigger()) throw boom;
        if (scenario === "cleanup plus loading" && !data.loading()) throw secondary;
      });
      if (scenario === "synchronous reporting" || scenario === "starting loading") {
        await data.currentPromise();
        trigger.set(true);
      }
      let settled = false;
      void data.currentPromise().then(() => { settled = true; });
      let disposalError;
      if (scenario === "cleanup plus loading") {
        try { data.dispose(); } catch (error) { disposalError = error; }
      }
      await new Promise(resolve => setImmediate(resolve));
      console.debug("[owl:async-settlement]", {scenario, settled, loading: data.loading(), unhandled: unhandled.length});
      assert.equal(unhandled.length, 1);
      assert.equal(unhandled[0], scenario === "cleanup plus loading" ? secondary : boom);
      if (scenario === "cleanup plus loading") assert.equal(disposalError, boom);
      assert.equal(settled, true);
      assert.equal(data.loading(), false);
      const runs = signals.length;
      unrelated.set(1);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(signals.length, runs);
      assert.equal(unhandled.length, 1);
      stop(); data.dispose();
      assert.equal(signals.at(-1).aborted, true);
    `;
  const run = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  console.debug("[owl:async-settlement-probe]", scenario, run.status, run.stdout, run.stderr);
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
});
