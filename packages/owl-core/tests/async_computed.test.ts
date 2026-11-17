import { asyncComputed, computed, immediateEffect, signal } from "../src";
import { waitScheduler } from "./helpers";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe("asyncComputed", () => {
  test("refresh waits for the new run and drops a result already queued by the old run", async () => {
    const first = Promise.withResolvers<number>();
    const second = Promise.withResolvers<number>();
    let calls = 0;
    const data = asyncComputed(() => (++calls === 1 ? first.promise : second.promise));
    await waitScheduler();
    first.resolve(1);
    const refreshed = data.refresh();
    expect(refreshed).toBe(data.currentPromise());
    expect(data.loading()).toBe(true);
    let settled = false;
    refreshed.then(() => (settled = true));
    await waitScheduler();
    expect(data()).toBeUndefined();
    expect(settled).toBe(false);
    second.resolve(2);
    await refreshed;
    expect(data()).toBe(2);
    expect(data.loading()).toBe(false);
    data.dispose();
    await data.refresh();
    expect(calls).toBe(2);
  });

  test("several refresh requests share their waiter and one queued fetch", async () => {
    let calls = 0;
    const data = asyncComputed(async () => ++calls);
    await data.currentPromise();
    const first = data.refresh();
    expect(data.refresh()).toBe(first);
    await first;
    expect(calls).toBe(2);
    expect(data()).toBe(2);
    data.dispose();
  });

  test("disposing synchronously from the loading notification settles the refresh", async () => {
    const data = asyncComputed(async () => 1);
    await data.currentPromise();
    const stop = immediateEffect(() => {
      if (data.loading()) data.dispose();
    });
    await data.refresh();
    expect(data.loading()).toBe(false);
    stop();
  });

  test("a refresh requested by a result observer stays loading until the new run settles", async () => {
    const first = Promise.withResolvers<number>();
    const second = Promise.withResolvers<number>();
    let calls = 0;
    const data = asyncComputed(() => (++calls === 1 ? first.promise : second.promise));
    const loading: boolean[] = [];
    const stopLoading = immediateEffect(() => loading.push(data.loading()));
    const stopValue = immediateEffect(() => {
      if (data() === 1) data.refresh();
    });
    first.resolve(1);
    await waitScheduler();
    expect(loading).toEqual([true]);
    second.resolve(2);
    await data.currentPromise();
    expect(loading).toEqual([true, false]);
    stopLoading();
    stopValue();
    data.dispose();
  });

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
    n.set(3);
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
