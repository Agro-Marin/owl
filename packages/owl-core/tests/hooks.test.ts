import { PluginManager, signal, useOnChange, effect } from "../src";
import { captureUnhandledRejections, waitScheduler } from "./helpers";

test("a self-writing change hook observes future changes without rereading the written value", async () => {
  const manager = new PluginManager({});
  const value = signal(0);
  const seen: number[] = [];
  let reads = 0;
  manager.run(() =>
    useOnChange(
      () => {
        reads++;
        return [value()];
      },
      (v) => {
        seen.push(v);
        if (v === 1) value.set(10);
      }
    )
  );
  value.set(1);
  await waitScheduler();
  expect(reads).toBe(2);
  value.set(1);
  await waitScheduler();
  expect(seen).toEqual([0, 1]);
  value.set(2);
  await waitScheduler();
  expect(seen).toEqual([0, 1, 2]);
  manager.destroy();
});

test("a change hook that invalidates its dependencies keeps its cleanup and can recover", async () => {
  const manager = new PluginManager({});
  const item = signal<{ id: number } | null>({ id: 0 });
  const seen: string[] = [];
  manager.run(() =>
    useOnChange(
      () => [item()!.id],
      (id) => {
        seen.push(`run ${id}`);
        if (id === 1) item.set(null);
        return () => {
          seen.push(`cleanup ${id}`);
        };
      }
    )
  );
  item.set({ id: 1 });
  await waitScheduler();
  item.set({ id: 2 });
  await waitScheduler();
  manager.destroy();
  expect(seen).toEqual(["run 0", "cleanup 0", "run 1", "cleanup 1", "run 2", "cleanup 2"]);
});

test("a failed child effect is disposed; its parent can later create a healthy replacement", async () => {
  class IntentionalTestError extends Error {
    override name = "IntentionalTestError";
  }
  const errors = captureUnhandledRejections();
  const parent = signal(0),
    child = signal(0);
  const seen: number[] = [];
  const stop = effect(() => {
    parent();
    effect(() => {
      seen.push(child());
      if (parent() === 1) throw new IntentionalTestError("child");
    });
  });
  parent.set(1);
  await waitScheduler();
  child.set(1);
  await waitScheduler();
  expect(seen).toEqual([0, 0]);
  parent.set(2);
  await waitScheduler();
  expect(seen).toEqual([0, 0, 1]);
  stop();
  expect(await errors()).toEqual(["IntentionalTestError: child"]);
});
