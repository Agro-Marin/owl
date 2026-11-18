import { batch, computed, effect, immediateEffect, selector, signal } from "../src";

// D.1 of the best-in-class plan: what a write costs, counted instead of timed.
// Each shape is held to the computed evaluations and effect runs one write (or
// batch) causes after the graph is built; every budget is the minimum the
// shape needs, so a change to one is a change to what the reactivity does.

interface Counts {
  evaluations: number;
  runs: number;
}

function shape(build: (count: Counts) => () => void): Promise<Counts> {
  const count: Counts = { evaluations: 0, runs: 0 };
  const write = build(count);
  count.evaluations = 0;
  count.runs = 0;
  write();
  return Promise.resolve().then(() => ({ ...count }));
}

const SHAPES: [string, (count: Counts) => () => void, Counts][] = [
  [
    "a chain of 100 computeds",
    (count) => {
      const source = signal(0);
      let last: () => number = source;
      for (let i = 0; i < 100; i++) {
        const previous = last;
        last = computed(() => (count.evaluations++, previous() + 1));
      }
      const end = last;
      immediateEffect(() => (count.runs++, end()));
      return () => source.set(1);
    },
    { evaluations: 100, runs: 1 },
  ],
  [
    "a diamond",
    (count) => {
      const source = signal(0);
      const left = computed(() => (count.evaluations++, source() + 1));
      const right = computed(() => (count.evaluations++, source() * 2));
      const joined = computed(() => (count.evaluations++, left() + right()));
      immediateEffect(() => (count.runs++, joined()));
      return () => source.set(1);
    },
    { evaluations: 3, runs: 1 },
  ],
  [
    "1000 effects reading one signal",
    (count) => {
      const source = signal(0);
      for (let i = 0; i < 1000; i++) {
        immediateEffect(() => (count.runs++, source()));
      }
      return () => source.set(1);
    },
    { evaluations: 0, runs: 1000 },
  ],
  [
    "1000 effects reading a selector of one signal, selection moved",
    (count) => {
      const selected = signal(0);
      const isSelected = selector(selected);
      for (let i = 0; i < 1000; i++) {
        immediateEffect(() => (count.runs++, isSelected(i)));
      }
      return () => selected.set(500);
    },
    { evaluations: 0, runs: 2 },
  ],
  [
    "a computed whose value does not change",
    (count) => {
      const source = signal(0);
      const parity = computed(() => (count.evaluations++, source() % 2));
      immediateEffect(() => (count.runs++, parity()));
      return () => source.set(2);
    },
    { evaluations: 1, runs: 0 },
  ],
  [
    "100 writes in a batch",
    (count) => {
      const source = signal(0);
      const doubled = computed(() => (count.evaluations++, source() * 2));
      immediateEffect(() => (count.runs++, doubled()));
      return () =>
        batch(() => {
          for (let i = 1; i <= 100; i++) {
            source.set(i);
          }
        });
    },
    { evaluations: 1, runs: 1 },
  ],
  [
    "a write to a branch an effect stopped reading",
    (count) => {
      const useLeft = signal(true);
      const left = signal(0);
      const right = signal(0);
      immediateEffect(() => (count.runs++, useLeft() ? left() : right()));
      useLeft.set(false);
      return () => left.set(1);
    },
    { evaluations: 0, runs: 0 },
  ],
  [
    "a deferred effect after 100 writes",
    (count) => {
      const source = signal(0);
      effect(() => (count.runs++, source()));
      return () => {
        for (let i = 1; i <= 100; i++) {
          source.set(i);
        }
      };
    },
    { evaluations: 0, runs: 1 },
  ],
];

test.each(SHAPES)("%s costs what it is budgeted", async (name, build, budget) => {
  const counts = await shape(build);
  console.debug("[owl:counted]", name, JSON.stringify(counts));
  expect(counts).toEqual(budget);
});
