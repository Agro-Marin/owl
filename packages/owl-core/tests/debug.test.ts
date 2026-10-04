import {
  computed,
  effect,
  Plugin,
  PluginManager,
  setDebug,
  setDebugSink,
  signal,
  usePlugin,
  type DebugChannel,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

let lines: string[] = [];

beforeEach(() => {
  lines = [];
  setDebugSink((channel: DebugChannel, message: string) => lines.push(`${channel}: ${message}`));
});

afterEach(() => {
  setDebug(false);
  setDebugSink(null);
});

test("a disabled channel logs nothing", async () => {
  const s = signal(0);
  effect(() => s(), { name: "reader" });
  s.set(1);
  await waitScheduler();
  expect(lines).toEqual([]);
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
  ]);
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
});
