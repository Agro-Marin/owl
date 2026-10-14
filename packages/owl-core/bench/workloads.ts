import type * as Core from "../src";

type Owl = typeof Core;

export interface Workload {
  run(iterations: number): void;
  validate(): Record<string, number>;
  dispose(): void;
}

function equal(actual: number, expected: number, name: string) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
}

function reads(owl: Owl, read: () => number, tracked: boolean, dependencies: number): Workload {
  let iterations = 0;
  let sum = 0;
  let sources = 0;
  return {
    run(count) {
      const run = () => {
        for (let i = 0; i < count; i++) sum += read();
        if (tracked) sources = owl.sourcesOf(owl.getCurrentComputation()!).length;
      };
      if (tracked) owl.immediateEffect(run, { name: "benchmark reads" })();
      else run();
      iterations += count;
    },
    validate() {
      equal(sum, iterations, "read checksum");
      equal(sources, dependencies, "tracked dependencies");
      return { iterations, sum, sources };
    },
    dispose() {},
  };
}

function writes(owl: Owl, rows: number, selective: boolean): Workload {
  const value = owl.signal(0);
  const selected = selective ? owl.selector(value) : null;
  let iterations = 0;
  let runs = 0;
  let answers = 0;
  const stops = Array.from({ length: rows }, (_, key) =>
    owl.immediateEffect(
      () => {
        runs++;
        const answer = selected ? Number(selected(key)) : value();
        answers += answer;
      },
      { name: `benchmark row ${key}` }
    )
  );
  return {
    run(count) {
      for (let i = 0; i < count; i++) value.set(++iterations & 1);
    },
    validate() {
      equal(runs, rows + iterations * (selective ? 2 : rows), "observer runs");
      equal(answers, selective ? 1 + iterations : Math.ceil(iterations / 2) * rows, "answers");
      return { iterations, runs, answers };
    },
    dispose() {
      stops.forEach((stop) => stop());
      for (let i = 0; selective && i < rows; i++) value.set(iterations + i + 2);
    },
  };
}

function mutations(
  owl: Owl,
  read: () => number,
  mutate: (iteration: number) => void,
  expected: (iterations: number) => number,
  notifications = 1
): Workload {
  let iterations = 0;
  let runs = 0;
  let answer = 0;
  const stop = owl.immediateEffect(
    () => {
      runs++;
      answer = read();
    },
    { name: "benchmark collection reader" }
  );
  return {
    run(count) {
      for (let i = 0; i < count; i++) mutate(++iterations);
    },
    validate() {
      equal(runs, 1 + iterations * notifications, "collection notifications");
      equal(answer, expected(iterations), "collection answer");
      return { iterations, runs, answer };
    },
    dispose: stop,
  };
}

function iteration(owl: Owl, kind: "map" | "array", observed: boolean): Workload {
  const collection =
    kind === "map"
      ? owl.proxy(new Map(Array.from({ length: 32 }, (_, key) => [key, 1])))
      : owl.proxy(Array.from({ length: 32 }, () => 1));
  let notifications = 0;
  const view = observed ? owl.observe(collection, () => notifications++) : collection;
  let iterations = 0;
  let sum = 0;
  let sources = 0;
  return {
    run(count) {
      const run = () => {
        for (let i = 0; i < count; i++) {
          for (const value of view.values()) sum += value;
        }
        if (!observed) sources = owl.sourcesOf(owl.getCurrentComputation()!).length;
      };
      if (observed) run();
      else owl.immediateEffect(run, { name: "benchmark iterator reader" })();
      iterations += count;
    },
    validate() {
      equal(sum, iterations * 32, "iterator checksum");
      if (!observed) equal(sources, kind === "map" ? 33 : 34, "iterator dependencies");
      if (collection instanceof Map) collection.set(0, collection.get(0)! + 1);
      else collection[0]++;
      if (observed) equal(notifications, 1, "observed iterator notification");
      return { iterations, sum, sources, notifications };
    },
    dispose() {
      if (collection instanceof Map) collection.clear();
      else collection.length = 0;
    },
  };
}

export const workloads: Record<string, (owl: Owl) => Workload> = {
  signal_untracked_reads: (owl) => reads(owl, owl.signal(1), false, 0),
  signal_tracked_repeated_reads: (owl) => reads(owl, owl.signal(1), true, 1),
  selector_tracked_string_reads: (owl) => {
    const selected = owl.selector(() => "row");
    return reads(owl, () => Number(selected("row")), true, 1);
  },
  proxy_tracked_property_reads: (owl) => {
    const value = owl.proxy({ value: 1 });
    return reads(owl, () => value.value, true, 1);
  },
  proxy_tracked_cached_object_reads: (owl) => {
    const value = owl.proxy({ record: { value: 1 } });
    return reads(owl, () => value.record.value, true, 2);
  },
  proxy_tracked_stored_proxy_reads: (owl) => {
    const record = owl.proxy({ value: 1 });
    const value = owl.proxy({ record });
    return reads(owl, () => value.record.value, true, 2);
  },
  proxy_tracked_foreign_proxy_reads: (owl) => {
    const raw = new Proxy(
      { value: 1 },
      { get: (target, key, receiver) => Reflect.get(target, key, receiver) }
    );
    const value = owl.proxy({ record: owl.proxy(raw) });
    return reads(owl, () => value.record.value, true, 2);
  },
  map_tracked_stored_proxy_reads: (owl) => {
    const value = owl.proxy(new Map([["row", owl.proxy({ value: 1 })]]));
    return reads(owl, () => value.get("row")!.value, true, 2);
  },
  map_tracked_get_reads: (owl) => {
    const value = owl.proxy(new Map([["row", 1]]));
    return reads(owl, () => value.get("row")!, true, 1);
  },
  immediate_effect_writes: (owl) => writes(owl, 1, false),
  immediate_effect_32_observers: (owl) => writes(owl, 32, false),
  selector_2_rows: (owl) => writes(owl, 2, true),
  selector_32_rows: (owl) => writes(owl, 32, true),
  selector_1024_rows: (owl) => writes(owl, 1024, true),
  map_existing_value_writes: (owl) => {
    const value = owl.proxy(new Map([["row", 0]]));
    return mutations(
      owl,
      () => value.get("row")!,
      (i) => value.set("row", i),
      (i) => i
    );
  },
  map_insert_delete: (owl) => {
    const value = owl.proxy(new Map<number, number>());
    return mutations(
      owl,
      () => value.size,
      (i) => {
        value.set(i, i);
        value.delete(i);
      },
      () => 0,
      2
    );
  },
  set_membership_writes: (owl) => {
    const value = owl.proxy(new Set<string>());
    return mutations(
      owl,
      () => Number(value.has("row")),
      (i) => (i & 1 ? value.add("row") : value.delete("row")),
      (i) => i & 1
    );
  },
  array_batched_splice: (owl) => {
    const value = owl.proxy(Array.from({ length: 32 }, () => 0));
    return mutations(
      owl,
      () => owl.readArrayItems(value).reduce((sum, item) => sum + item, 0),
      (i) => value.splice(0, 1, i),
      (i) => i
    );
  },
  map_tracked_iteration_32_values: (owl) => iteration(owl, "map", false),
  map_observed_iteration_32_values: (owl) => iteration(owl, "map", true),
  array_tracked_iteration_32_values: (owl) => iteration(owl, "array", false),
  array_observed_iteration_32_values: (owl) => iteration(owl, "array", true),
};
