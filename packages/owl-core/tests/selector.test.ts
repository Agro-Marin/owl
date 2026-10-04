import { effect, PluginManager, selector, setDebug, setDebugSink, signal } from "../src";
import { batch } from "../src/computations";
import { waitScheduler } from "./helpers";

function rowsReading(isSelected: (key: number) => boolean, keys: number[]) {
  const runs: Record<number, number> = {};
  const seen: Record<number, boolean> = {};
  const stops = keys.map((key) =>
    effect(() => {
      runs[key] = (runs[key] || 0) + 1;
      seen[key] = isSelected(key);
    })
  );
  return { runs, seen, stop: () => stops.forEach((stop) => stop()) };
}

describe("selector", () => {
  test("a change notifies the readers of the previous and of the new key only", async () => {
    const selected = signal<number | null>(1);
    const isSelected = selector(() => selected());
    const rows = rowsReading(isSelected, [1, 2, 3, 4]);
    await waitScheduler();
    expect(rows.seen).toEqual({ 1: true, 2: false, 3: false, 4: false });
    expect(rows.runs).toEqual({ 1: 1, 2: 1, 3: 1, 4: 1 });
    selected.set(3);
    await waitScheduler();
    expect(rows.seen).toEqual({ 1: false, 2: false, 3: true, 4: false });
    expect(rows.runs).toEqual({ 1: 2, 2: 1, 3: 2, 4: 1 });
    selected.set(null);
    await waitScheduler();
    expect(rows.runs).toEqual({ 1: 2, 2: 1, 3: 3, 4: 1 });
    selected.set(null);
    await waitScheduler();
    expect(rows.runs).toEqual({ 1: 2, 2: 1, 3: 3, 4: 1 });
    rows.stop();
  });

  test("answers outside a computation, and inside a batch before it ends", () => {
    const selected = signal(1);
    const isSelected = selector(() => selected());
    expect(isSelected(1)).toBe(true);
    batch(() => {
      selected.set(2);
      expect(isSelected(2)).toBe(true);
      expect(isSelected(1)).toBe(false);
    });
    expect(isSelected(2)).toBe(true);
  });

  test("a key read by no computation any more stops being notified", async () => {
    const selected = signal(1);
    const isSelected = selector(() => selected());
    const first = rowsReading(isSelected, [1]);
    await waitScheduler();
    first.stop();
    const second = rowsReading(isSelected, [2]);
    await waitScheduler();
    selected.set(2);
    await waitScheduler();
    expect(first.runs).toEqual({ 1: 1 });
    expect(second.runs).toEqual({ 2: 2 });
    second.stop();
  });

  test("is disposed with the scope it was created in, unless detached", async () => {
    const selected = signal(1);
    const manager = new PluginManager({});
    const attached = manager.run(() => selector(() => selected()));
    const detached = manager.run(() => selector(() => selected(), { detached: true }));
    const rows = rowsReading(attached, [1, 2]);
    await waitScheduler();
    manager.destroy();
    selected.set(2);
    await waitScheduler();
    expect(rows.runs).toEqual({ 1: 1, 2: 1 });
    // the last answer stays, nothing is tracked any more
    expect(attached(1)).toBe(true);
    expect(detached(2)).toBe(true);
    rows.stop();
  });

  test("many keys read once by short-lived computations do not accumulate", async () => {
    const kept: number[] = [];
    setDebugSink((_, message) => {
      const match = / (\d+) kept$/.exec(message);
      if (match) {
        kept.push(Number(match[1]));
      }
    });
    setDebug("computed");
    const selected = signal(0);
    const isSelected = selector(() => selected());
    for (let round = 0; round < 20; round++) {
      const keys = Array.from({ length: 50 }, (_, i) => round * 50 + i);
      const rows = rowsReading(isSelected, keys);
      await waitScheduler();
      rows.stop();
    }
    const rows = rowsReading(isSelected, [0, 999]);
    await waitScheduler();
    selected.set(999);
    await waitScheduler();
    expect(rows.runs).toEqual({ 0: 2, 999: 2 });
    rows.stop();
    setDebug(false);
    setDebugSink(null);
    // 1000 keys were read, at most 50 of them by a live computation at a time
    expect(kept.length).toBeGreaterThan(0);
    expect(Math.max(...kept)).toBeLessThanOrEqual(50);
  });
});
