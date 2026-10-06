import { asyncComputed, computed, signal } from "../src";
import { waitScheduler } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("asyncComputed", () => {
  test("currentPromise() right after a dependency changed waits for the run it queued", async () => {
    const id = signal(1);
    const fetches: Array<ReturnType<typeof deferred<number>>> = [];
    const user = asyncComputed(() => {
      const value = id();
      const fetch = deferred<number>();
      fetches.push(fetch);
      return fetch.promise.then(() => value);
    });
    fetches[0].resolve(0);
    await waitScheduler();
    expect(user()).toBe(1);

    id.set(2);
    let settled = false;
    const promise = user.currentPromise();
    expect(user.currentPromise()).toBe(promise);
    promise.then(() => (settled = true));
    await waitScheduler();
    expect(settled).toBe(false);
    expect(user.loading()).toBe(true);
    fetches[1].resolve(0);
    await waitScheduler();
    await waitScheduler();
    expect(settled).toBe(true);
    expect(user()).toBe(2);
    user.dispose();
  });

  test("currentPromise() right after refresh() waits for the new run", async () => {
    let fetch = deferred<number>();
    let runs = 0;
    const data = asyncComputed(() => {
      runs++;
      return fetch.promise;
    });
    fetch.resolve(1);
    await waitScheduler();
    fetch = deferred<number>();
    data.refresh();
    let settled = false;
    data.currentPromise().then(() => (settled = true));
    await waitScheduler();
    expect([runs, settled]).toEqual([2, false]);
    fetch.resolve(2);
    await waitScheduler();
    await waitScheduler();
    expect([settled, data()]).toEqual([true, 2]);
    data.dispose();
  });

  test("currentPromise() resolves when a queued check finds nothing to fetch again", async () => {
    const n = signal(1);
    const parity = computed(() => n() % 2);
    let runs = 0;
    const data = asyncComputed(() => {
      runs++;
      return parity();
    });
    await waitScheduler();
    n.set(3); // parity is still 1: the effect is checked, and does not run
    let settled = false;
    data.currentPromise().then(() => (settled = true));
    await waitScheduler();
    await waitScheduler();
    expect([runs, settled]).toEqual([1, true]);
    data.dispose();
  });

  test("dispose() during a run leaves it not loading", () => {
    const data = asyncComputed(() => new Promise<number>(() => {}));
    expect(data.loading()).toBe(true);
    data.dispose();
    expect(data.loading()).toBe(false);
  });
});
