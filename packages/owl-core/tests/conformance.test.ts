import { expect } from "vitest";
import {
  setExpect,
  SkipTest,
  testSuite,
  type ReactiveFramework,
} from "reactive-framework-test-suite";
import { batch, computed, immediateEffect, signal, untrack } from "../src";

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
  run: (fn) => fn(),
  batch: (fn) => batch(fn),
  untracked: (fn) => untrack(fn),
};

const KNOWN_DIVERGENCES = new Set<string>([]);

const NO_ASSERTION_CASES = new Set<string>([
  "#203 computed disposal with unchanged-value sibling computed",
]);

const BEHAVIOR: Record<string, string> = {
  "#17 computed evaluation timing": "lazy",
  "#15 unread computed subscription": "no subscription",
  "#146 recompute count on multiple dep changes": "single recompute",
  "#29 NaN equality semantics": "Object.is",
  "#167 computed NaN downstream propagation": "Object.is",
  "#30 same-reference signal write": "skips",
  "#176 batch return value": "returns value",
  "#173 mid-propagation read isolation": "post-write",
  "#174 intra-run read-after-write": "post-write",
  "#88 effect subscription after first-run throw": "unsubscribes",
  "#106 effect throw isolation in flush": "continues",
  "#86 computed error caching": "caches error",
  "#107 non-Error throw caching": "caches error",
  "#49 inner write re-run through computed chain": "runs 1x per write",
  "#62 infinite loop in effect": "no throw",
  "#175 effect multi-signal write batching": "unbatched (2 runs)",
  "#246 throwing run body child effect cleanup": "children survive",
  "#244 sibling cleanup order on dispose": "FIFO",
};

setExpect(expect as any);

function runCase(run: (fw: ReactiveFramework) => unknown): unknown {
  let result: unknown;
  owl.run(() => {
    result = run(owl);
  });
  return result;
}

for (const { section, cases, type } of testSuite) {
  describe(`${type === "behavioral" ? "behavioral: " : ""}${section}`, () => {
    for (const [name, run] of Object.entries(cases)) {
      const body =
        type === "behavioral"
          ? () => expect(runCase(run)).toBe(BEHAVIOR[name])
          : () => {
              try {
                if (NO_ASSERTION_CASES.has(name)) {
                  expect(() => runCase(run)).not.toThrow();
                } else {
                  runCase(run);
                }
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

test("every behavioral case has a pinned verdict, and every pinned verdict a case", () => {
  const names = testSuite
    .filter(({ type }) => type === "behavioral")
    .flatMap(({ cases }) => Object.keys(cases));
  expect(names.sort()).toEqual(Object.keys(BEHAVIOR).sort());
});
