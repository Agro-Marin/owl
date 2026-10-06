import { expect } from "vitest";
import {
  setExpect,
  SkipTest,
  testSuite,
  type ReactiveFramework,
} from "reactive-framework-test-suite";
import { computed, immediateEffect, signal, untrack } from "../src";
import { batch } from "../src/computations";

// The cross-framework reactive conformance suite (also run by alien-signals,
// Preact signals, Vue, Solid, ...): synchronous effects are owl's immediate
// effects.
const owl: ReactiveFramework = {
  name: "owl",
  signal(initialValue) {
    const s = signal(initialValue);
    return { read: () => s(), write: (value) => s.set(value) };
  },
  computed(fn) {
    const c = computed(fn, { detached: true });
    return { read: () => c() };
  },
  effect(fn) {
    return immediateEffect(fn as () => void);
  },
  run(fn) {
    fn();
  },
  batch(fn) {
    batch(fn);
  },
  untracked(fn) {
    return untrack(fn);
  },
};

// Where owl knowingly differs: a run does not invalidate itself through its
// own writes (an effect writing what it read does not loop). A fix flips its
// case to a failure here.
const KNOWN_DIVERGENCES = new Set([
  "#179 computed self-increment: intra-run read-after-write values correct",
  "#180 inner write through computed chain resets signal",
]);

setExpect(expect as any);

for (const { section, cases, type } of testSuite) {
  describe(`${type === "behavioral" ? "behavioral: " : ""}${section}`, () => {
    for (const [name, run] of Object.entries(cases)) {
      const body = () => {
        try {
          owl.run(() => run(owl));
        } catch (error) {
          if (!(error instanceof SkipTest)) {
            throw error;
          }
        }
      };
      if (KNOWN_DIVERGENCES.has(name)) {
        test.fails(name, body);
      } else {
        test(name, body);
      }
    }
  });
}
