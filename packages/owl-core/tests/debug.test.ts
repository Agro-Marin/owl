import {
  batch,
  computed,
  debug,
  DEBUG_CHANNELS,
  effect,
  immediateEffect,
  observe,
  OwlError,
  Plugin,
  PluginManager,
  proxy,
  readArrayItems,
  setDebug,
  setDebugSink,
  signal,
  usePlugin,
  type DebugChannel,
} from "../src";
import {
  ComputationState,
  createComputation,
  onReadAtom,
  removeSources,
  updateComputation,
} from "../src/computations";
import { captureUnhandledRejections, TestScope, waitScheduler } from "./helpers";

let lines: string[] = [];
const initialDebugFlags = Object.values(debug);

beforeEach(() => {
  setDebug(false);
  lines = [];
  setDebugSink((channel: DebugChannel, message: string) => lines.push(`${channel}: ${message}`));
});

afterEach(() => {
  setDebug(false);
  setDebugSink(null);
});

test("the debug flags are one per channel, all off until setDebug, and take no other key", () => {
  expect(initialDebugFlags.every((on) => on === false)).toBe(true);
  expect(Object.keys(debug)).toEqual([...DEBUG_CHANNELS]);
  expect(Object.values(debug).every((on) => on === false)).toBe(true);
  expect(Object.isSealed(debug)).toBe(true);
  setDebug(["fiber"]);
  expect(Object.keys(debug).filter((channel) => (debug as any)[channel])).toEqual(["fiber"]);
});

test("a disabled channel logs nothing", async () => {
  const s = signal(0);
  effect(() => s(), { name: "reader" });
  s.set(1);
  await waitScheduler();
  expect(lines).toEqual([]);
});

test("a write that queues no effect schedules no flush", async () => {
  setDebug(["effect"]);
  const s = signal(0);
  const dispose = immediateEffect(() => s(), { name: "reader" });
  s.set(1);
  signal(0).set(1);
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "effect: create reader, owned by nothing",
    "effect: run reader",
    "effect: run reader",
    "effect: dispose reader",
  ]);
});

test("effect and reactivity channels trace a write through to the effect it re-runs", async () => {
  setDebug(["effect", "reactivity"]);
  const s = signal(0);
  const dispose = effect(() => s(), { name: "reader" });
  s.set(1);
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "effect: create reader, owned by nothing",
    "effect: run reader",
    "reactivity: write, 1 observer(s)",
    "effect: flush 1 effect(s)",
    "effect: run reader",
    "effect: dispose reader",
  ]);
});

test("the reactivity channel names each tracked proxy read and its reader", () => {
  setDebug(["reactivity"]);
  const state = proxy({ a: 1, list: [1, 2] } as any);
  state.a;
  const dispose = effect(
    () => {
      state.a;
      "b" in state;
      state.list.includes(3);
    },
    { name: "reader" }
  );
  dispose();
  expect(lines).toEqual([
    "reactivity: proxy read a by reader",
    "reactivity: proxy read presence of b by reader",
    "reactivity: proxy read list by reader",
    "reactivity: proxy read includes by reader",
    "reactivity: proxy read items by reader",
    "reactivity: release the atom of a, nothing reads it",
    "reactivity: release the atom of presence of b, nothing reads it",
    "reactivity: release the atom of list, nothing reads it",
    "reactivity: release the atom of includes, nothing reads it",
    "reactivity: release the atom of items, nothing reads it",
  ]);
});

test("the reactivity channel names a write to a key's presence apart from one to its value", () => {
  const state = proxy({ a: 1 } as any);
  const dispose = effect(() => [state.b, "b" in state]);
  setDebug(["reactivity"]);
  state.b = 2;
  setDebug(false);
  dispose();
  expect(lines).toEqual([
    "reactivity: proxy write presence of b",
    "reactivity: write, 1 observer(s)",
    "reactivity: proxy write b",
    "reactivity: write, 1 observer(s)",
  ]);
});

test("the computed channel names a recompute and an equal result", async () => {
  setDebug("computed");
  const s = signal(1);
  const parity = computed(() => s() % 2, { name: "parity" });
  const dispose = effect(() => parity());
  s.set(3);
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "computed: run parity",
    "computed: run parity",
    "computed: parity recomputed an equal value, readers kept",
    "computed: dispose parity, effect was its last observer",
  ]);
});

test("the reactivity and computed channels trace a write reaching a run that read it", async () => {
  setDebug(["reactivity", "computed"]);
  const s = signal(0);
  const c = computed(() => s(), { name: "c" });
  const dispose = effect(
    () => {
      if (c() === 0) {
        s.set(1);
      }
    },
    { name: "resetter" }
  );
  const self = computed(
    () => {
      s.set(s() + 1);
      return s();
    },
    { name: "self" }
  );
  self();
  s.set(5);
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "computed: run c",
    "reactivity: write, 1 observer(s)",
    "reactivity: resetter invalidated by a write during its run",
    "reactivity: c forwards the next write, resetter read it",
    "computed: run self",
    "reactivity: write, 2 observer(s)",
    "reactivity: forward through c",
    "reactivity: self invalidated by a write during its run",
    "computed: self ends out of date, a write reached it while it ran",
    "reactivity: write, 2 observer(s)",
    "reactivity: forward through self",
    "computed: run c",
    "reactivity: write, 1 observer(s)",
    "computed: dispose unobserved self",
    "computed: dispose c, resetter was its last observer",
  ]);
});

test("the reactivity and effect channels name the observers of a write and the effects of a flush", async () => {
  const details: unknown[] = [];
  setDebugSink((channel: DebugChannel, message: string, rest: unknown[]) => {
    lines.push(`${channel}: ${message}`);
    details.push(...rest);
  });
  const s = signal(0);
  const dispose = effect(() => s(), { name: "reader" });
  const unnamed = createComputation(() => s(), false);
  updateComputation(unnamed);
  setDebug(["reactivity", "effect"]);
  s.set(1);
  await waitScheduler();
  setDebug(false);
  dispose();
  removeSources(unnamed);
  expect(lines).toEqual([
    "reactivity: write, 2 observer(s)",
    "effect: flush 2 effect(s)",
    "effect: run reader",
  ]);
  expect(details).toEqual([
    ["reader", "?"],
    ["reader", ""],
  ]);
});

test("the reactivity channel says a run reads again a source it wrote", async () => {
  setDebug(["reactivity"]);
  const s = signal(0);
  const dispose = effect(
    () => {
      s();
      if (s() < 1) {
        s.set(1);
      }
      s();
    },
    { name: "writer" }
  );
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "reactivity: write, 1 observer(s)",
    "reactivity: writer invalidated by a write during its run",
    "reactivity: writer reads again a source written during its run",
  ]);
});

test("the effect channel traces a batch end and an owner run before the effect it owns", () => {
  const s = signal(0);
  const dispose = immediateEffect(
    () => {
      immediateEffect(() => s(), { name: "inner" });
      s();
    },
    { name: "outer" }
  );
  setDebug(["effect"]);
  batch(() => s.set(1));
  setDebug(false);
  dispose();
  expect(lines).toEqual([
    "effect: batch end, 2 immediate effect(s)",
    "effect: run owner outer before inner",
    "effect: run outer",
    "effect: dispose inner",
    "effect: create inner, owned by outer",
    "effect: run inner",
  ]);
});

test("the error channel names a cycle, a run that threw, a failing source and a failed notification", async () => {
  class IntentionalTestError extends Error {
    override name = "IntentionalTestError";
  }
  const rejections = captureUnhandledRejections();
  const errors: unknown[] = [];
  setDebugSink((channel: DebugChannel, message: string, rest: unknown[]) => {
    lines.push(`${channel}: ${message}`);
    errors.push(...rest.map((error) => (error as Error).message));
  });
  setDebug(["error"]);
  const self: () => unknown = computed(() => self(), { name: "self" });
  expect(() => self()).toThrow("Cycle detected: self reads its own value");
  const s = signal(0);
  const failing = createComputation(
    () => {
      if (s() > 0) {
        throw new IntentionalTestError("source failed");
      }
      return s();
    },
    true,
    ComputationState.STALE,
    false,
    "failing"
  );
  const reader = createComputation(
    () => {
      updateComputation(failing);
      onReadAtom(failing);
    },
    false,
    ComputationState.STALE,
    false,
    "reader"
  );
  updateComputation(reader);
  s.set(1);
  reader.state = ComputationState.PENDING;
  expect(() => updateComputation(reader)).toThrow("source failed");
  const notified = createComputation(() => s(), true, ComputationState.STALE, false, "notified");
  notified.onUpdated = () => {
    throw new IntentionalTestError("notification failed");
  };
  expect(() => updateComputation(notified)).toThrow("notification failed");
  removeSources(reader);
  removeSources(notified);
  setDebug(false);
  await rejections();
  expect(lines).toEqual([
    "error: cycle: self",
    "error: failing threw",
    "error: reader: a source threw",
    "error: notified notification failed",
  ]);
  expect(errors).toEqual(["source failed", "source failed", "notification failed"]);
});

test("the reactivity channel says an observe() callback keeps the reads made before it ran", () => {
  const state = proxy({ a: 1, b: 1 });
  let calls = 0;
  const view = observe(state, function viewer() {
    calls++;
  });
  view.a;
  setDebug(["reactivity"]);
  batch(() => {
    state.a = 2;
    view.b;
  });
  setDebug(false);
  state.b = 2;
  expect(lines).toEqual([
    "reactivity: proxy write a",
    "reactivity: write, 1 observer(s)",
    "reactivity: proxy read b by an observe() view",
    "reactivity: observe viewer keeps 1 read(s) made before it ran",
    "reactivity: release the atom of a, nothing reads it",
  ]);
  expect(calls).toBe(2);
});

test("writes in one tick make one flush, which also disposes what an immediate effect stopped reading", async () => {
  const s = signal(0);
  const t = signal(0);
  const show = signal(true);
  const c = computed(() => 1, { name: "c" });
  const a = effect(() => s(), { name: "a" });
  const b = effect(() => t(), { name: "b" });
  const reader = immediateEffect(
    () => {
      if (show()) {
        c();
      }
    },
    { name: "reader" }
  );
  await waitScheduler();
  setDebug(["effect", "computed"]);
  s.set(1);
  t.set(1);
  show.set(false);
  await waitScheduler();
  setDebug(false);
  a();
  b();
  reader();
  expect(lines).toEqual([
    "effect: run reader",
    "computed: c unread by reader, disposed at the flush",
    "effect: flush 2 effect(s)",
    "effect: run a",
    "effect: run b",
    "computed: dispose unobserved c",
  ]);
});

test("a computed an immediate effect stops reading at a batch's end is disposed at a flush of its own", async () => {
  const show = signal(true);
  const c = computed(() => 1, { name: "c" });
  const reader = immediateEffect(
    () => {
      if (show()) {
        c();
      }
    },
    { name: "reader" }
  );
  setDebug(["effect", "computed"]);
  batch(() => show.set(false));
  await waitScheduler();
  setDebug(false);
  reader();
  expect(lines).toEqual([
    "effect: batch end, 1 immediate effect(s)",
    "effect: run reader",
    "computed: c unread by reader, disposed at the flush",
    "effect: flush 0 effect(s)",
    "computed: dispose unobserved c",
  ]);
});

test("a computed one reader stops reading while another keeps it is not queued for disposal", async () => {
  const show = signal(true);
  const c = computed(() => 1, { name: "c" });
  const keeper = effect(() => c(), { name: "keeper" });
  const dropper = effect(
    () => {
      if (show()) {
        c();
      }
    },
    { name: "dropper" }
  );
  await waitScheduler();
  setDebug(["computed"]);
  show.set(false);
  await waitScheduler();
  setDebug(false);
  keeper();
  dropper();
  expect(lines).toEqual([]);
});

test("a write during a computed's run to a computed it has yet to read again does not leave the run out of date", () => {
  const s = signal(0);
  const t = signal(0);
  const c = computed(() => s(), { name: "c" });
  const d = computed(
    () => {
      if (t() === 1) {
        s.set(1);
      }
      return c();
    },
    { name: "d" }
  );
  d();
  setDebug(["computed", "reactivity"]);
  t.set(1);
  expect(d()).toBe(1);
  expect(d()).toBe(1);
  setDebug(false);
  expect(lines).toEqual([
    "reactivity: write, 1 observer(s)",
    "computed: run d",
    "reactivity: write, 1 observer(s)",
    "computed: run c",
    "reactivity: write, 1 observer(s)",
    "reactivity: write, 0 observer(s)",
  ]);
});

test("a run a write reached forwards only the computeds it read that are out of date", async () => {
  const s = signal(0);
  const t = signal(0);
  const c = computed(() => s(), { name: "c" });
  const steady = computed(() => t(), { name: "steady" });
  setDebug(["reactivity"]);
  const dispose = effect(
    () => {
      steady();
      if (c() === 0) {
        s.set(1);
      }
    },
    { name: "resetter" }
  );
  await waitScheduler();
  setDebug(false);
  dispose();
  expect(lines).toEqual([
    "reactivity: write, 1 observer(s)",
    "reactivity: resetter invalidated by a write during its run",
    "reactivity: c forwards the next write, resetter read it",
  ]);
});

test("a computed forwards one write only: the next write through another source stops at it", async () => {
  const s = signal(0);
  const t = signal(0);
  const c = computed(() => s(), { name: "c" });
  const d = computed(() => c() + t(), { name: "d" });
  const dispose = effect(
    () => {
      if (d() === 0) {
        s.set(1);
      }
    },
    { name: "resetter" }
  );
  setDebug(["reactivity"]);
  s.set(2);
  t.set(1);
  setDebug(false);
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "reactivity: write, 1 observer(s)",
    "reactivity: forward through c",
    "reactivity: forward through d",
    "reactivity: write, 1 observer(s)",
  ]);
});

test("a computed whose pending check failed on a source forwards nothing on its next write", async () => {
  class IntentionalTestError extends Error {
    override name = "IntentionalTestError";
  }
  const rejections = captureUnhandledRejections();
  const s = signal(0);
  const t = signal(0);
  const failing = createComputation(() => {
    if (s() > 0) {
      throw new IntentionalTestError("source failed");
    }
    return s();
  }, true);
  const reader = createComputation(
    () => {
      updateComputation(failing);
      onReadAtom(failing);
      return t();
    },
    true,
    ComputationState.STALE,
    false,
    "reader"
  );
  const observer = createComputation(() => {
    updateComputation(reader);
    onReadAtom(reader);
  }, false);
  updateComputation(observer);
  s.set(1);
  expect(reader.state).toBe(ComputationState.PENDING);
  expect(() => updateComputation(reader)).toThrow("source failed");
  setDebug(["reactivity"]);
  t.set(1);
  setDebug(false);
  removeSources(observer);
  await rejections();
  expect(lines).toEqual(["reactivity: write, 1 observer(s)"]);
});

test("a computed's run invalidated by its own write forwards the next write through the out-of-date computed it read", () => {
  const s = signal(0);
  const c = computed(() => s(), { name: "c" });
  const d = computed(
    () => {
      const value = c();
      if (value === 0) {
        s.set(1);
      }
      return value;
    },
    { name: "d" }
  );
  setDebug(["reactivity", "computed"]);
  d();
  setDebug(false);
  expect(lines).toEqual([
    "computed: run d",
    "computed: run c",
    "reactivity: write, 1 observer(s)",
    "reactivity: d invalidated by a write during its run",
    "computed: d ends out of date, a write reached it while it ran",
    "reactivity: c forwards the next write, d read it",
  ]);
});

test("a disposal queued while a flush disposes is left to the next flush", async () => {
  const source = signal(0);
  const s = signal(0);
  const owner = computed(
    () => {
      source();
      effect(() => () => s.set(1), { name: "owned" });
      return 1;
    },
    { name: "owner" }
  );
  const reader = computed(() => s(), { name: "reader" });
  owner();
  reader();
  setDebug(["effect", "computed"]);
  source.set(1);
  await waitScheduler();
  await waitScheduler();
  setDebug(false);
  expect(lines).toEqual([
    "effect: flush 0 effect(s)",
    "computed: dispose unobserved owner",
    "effect: owner is disposed: dispose 1 effect(s) it created",
    "effect: dispose owned",
    "effect: flush 0 effect(s)",
    "computed: dispose unobserved reader",
  ]);
});

test("the computed channel says a computed one run stopped reading is disposed at the flush", async () => {
  setDebug(["computed"]);
  const s = signal(true);
  const c = computed(() => 1, { name: "c" });
  const dispose = effect(
    () => {
      if (s()) {
        c();
      }
    },
    { name: "reader" }
  );
  s.set(false);
  await waitScheduler();
  dispose();
  expect(lines).toEqual([
    "computed: run c",
    "computed: c unread by reader, disposed at the flush",
    "computed: dispose unobserved c",
  ]);
});

test("the reactivity channel names a key-list read and an unnamed or observe() reader, and no read outside a reader", () => {
  setDebug(["reactivity"]);
  const state = proxy({ a: 1 } as any);
  const list = proxy([1]);
  const map = proxy(new Map([["k", 1]]));
  "a" in state;
  Object.keys(state);
  readArrayItems(list);
  map.get("k");
  expect(lines).toEqual([]);
  const dispose = effect(() => Object.keys(state), { name: "lister" });
  const unnamed = createComputation(() => state.a, false);
  updateComputation(unnamed);
  const view = observe(state, () => {});
  view.a;
  dispose();
  removeSources(unnamed);
  expect(lines).toEqual([
    "reactivity: proxy read (keys) by lister",
    "reactivity: proxy read a by a computation",
    "reactivity: proxy read a by an observe() view",
    "reactivity: release the atom of (keys), nothing reads it",
  ]);
});

test("the reactivity channel names an observe() callback after its function", () => {
  const observers: unknown[] = [];
  setDebugSink((channel: DebugChannel, message: string, details: unknown[]) => {
    if (message.startsWith("write")) {
      observers.push(details[0]);
    }
  });
  const state = proxy({ a: 1, b: 1 });
  observe(state, function onChange() {}).a;
  observe(state, () => {}).b;
  setDebug(["reactivity"]);
  state.a = 2;
  state.b = 2;
  expect(observers).toEqual([["observe onChange"], ["observe callback"]]);
});

test("the plugin and scope channels trace a start, a failed setup and its undo", () => {
  setDebug(["plugin", "scope"]);
  class Dep extends Plugin {}
  class Bad extends Plugin {
    setup() {
      usePlugin(Dep);
      throw new Error("boom");
    }
  }
  const manager = new PluginManager({});
  expect(() => manager.startPlugins([Bad])).toThrow("boom");
  expect(lines).toEqual([
    "plugin: batch of sequence 50",
    "plugin: start Bad",
    "plugin: start Dep",
    "plugin: start of Bad failed, undo",
    "scope: PluginManager: rollback to 0 willStart, 0 destroy callback(s), 0 computation(s)",
  ]);
});

test("the scope channel traces a finalize", () => {
  setDebug("scope");
  const scope = new TestScope({});
  scope.onDestroy(() => {});
  scope.finalize(() => {});
  expect(lines).toEqual(["scope: TestScope: finalize, 1 destroy callback(s), 0 computation(s)"]);
});

test("setDebug ignores empty entries of a string", () => {
  expect(() => setDebug("")).not.toThrow();
  expect(() => setDebug("effect,")).not.toThrow();
});

test("setDebug rejects an unknown channel", () => {
  expect(() => setDebug(["fibre"])).toThrow('Unknown debug channel "fibre"');
  expect(() => setDebug("fibre")).toThrow(OwlError);
});
