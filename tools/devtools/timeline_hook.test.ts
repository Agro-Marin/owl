import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JSDOM } from "jsdom";

const HOOK = readFileSync(
  join(import.meta.dirname, "src/page_scripts/owl_devtools_global_hook.js"),
  "utf8"
);

// The page's owl, as the devtools see it through window.__OWL_DEVTOOLS__,
// with its debug channels recorded in `channels` and `sink`.
function pageWithOwl(withDebugApi = true) {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  const window = dom.window as any;
  const state: { channels: unknown; sink: any } = { channels: false, sink: null };
  class Fiber {}
  window.__OWL_DEVTOOLS__ = {
    apps: new Set(),
    Fiber,
    RootFiber: class extends Fiber {},
    toRaw: (x: unknown) => x,
    ...(withDebugApi && {
      DEBUG_CHANNELS: ["scheduler", "fiber"],
      setDebug: (channels: unknown) => (state.channels = channels),
      setDebugSink: (sink: unknown) => (state.sink = sink),
    }),
  };
  const posted: any[] = [];
  window.top.postMessage = (message: any) => posted.push(message);
  window.eval(HOOK);
  return { window, hook: window.__OWL__DEVTOOLS_GLOBAL_HOOK__, state, posted };
}

test("the timeline records the chosen channels and sends what they say to the panel in batches", () => {
  vi.useFakeTimers();
  try {
    const { hook, state, posted } = pageWithOwl();
    expect(hook.getDebugChannels()).toEqual(["scheduler", "fiber"]);
    expect(hook.startTimeline(["scheduler"])).toBe(true);
    expect(state.channels).toEqual(["scheduler"]);
    state.sink("scheduler", "frame, 1 task(s)", []);
    state.sink("scheduler", "frame, 0 task(s)", []);
    expect(posted.filter((m) => m.type === "Timeline")).toEqual([]);
    vi.advanceTimersByTime(250);
    const batches = posted.filter((m) => m.type === "Timeline");
    expect(batches.length).toBe(1);
    expect(batches[0].data.map((e: any) => `${e.channel}: ${e.message}`)).toEqual([
      "scheduler: frame, 1 task(s)",
      "scheduler: frame, 0 task(s)",
    ]);
    expect(typeof batches[0].data[0].time).toBe("number");
    state.sink("scheduler", "frame, 2 task(s)", []);
    hook.stopTimeline();
    expect(state.channels).toBe(false);
    expect(state.sink).toBe(null);
    expect(posted.filter((m) => m.type === "Timeline").length).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});

test("an owl build without the debug API has no timeline", () => {
  const { hook } = pageWithOwl(false);
  expect(hook.getDebugChannels()).toBe(null);
  expect(hook.startTimeline(["scheduler"])).toBe(false);
  hook.stopTimeline();
});
