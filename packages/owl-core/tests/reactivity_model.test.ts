import { batch, computed, effect, immediateEffect, signal, untrack } from "../src";
import { prng } from "../../../tools/testing/helpers";
import {
  generateProgram,
  minimize,
  printProgram,
  ReactiveModel,
  runProgram,
  type ModelOptions,
  type Program,
  type ReactiveApi,
} from "./reactivity_model";

// Random programs of signals, computeds (reading computeds, writing signals,
// creating effects), effects and immediate effects (nested, detached, created
// untracked, disposed, by their owner or by any effect), batches, writes from
// effects and getters, and promise callbacks queued among them, run on Owl
// and on the reference model of reactivity_model.ts: the two logs (which
// effect or computed ran, what it read, when a promise callback ran) must be
// equal. A failure prints the seed and the program reduced to what still
// fails.
//
//   OWL_REACTIVITY_CASES=10000  how many programs (default 2000)
//   OWL_REACTIVITY_SEED=n       the first seed (default 1)
//   OWL_REACTIVITY_BUILD=path   also run them on a build (an owl.es.js); with
//                               OWL_REACTIVITY_BUILD_MODE=af18b4f5, programs
//                               af18b4f5 runs as the model says, against the
//                               model in af18b4f5's mode (that build is the
//                               ordering contract the series keeps)

const CASES = Number(process.env.OWL_REACTIVITY_CASES || 2000);
const FIRST_SEED = Number(process.env.OWL_REACTIVITY_SEED || 1);

interface Primitives {
  signal: (value: number) => { (): number; set(value: number): void };
  computed: (getter: () => number, options: { name: string }) => () => number;
  effect: (fn: () => unknown, options: { detached: boolean; name: string }) => () => void;
  immediateEffect: (fn: () => unknown, options: { detached: boolean; name: string }) => () => void;
  batch: (fn: () => void) => void;
  untrack: <T>(fn: () => T) => T;
}

function owlApi(owl: Primitives): ReactiveApi {
  return {
    signal: (value) => owl.signal(value),
    computed: (getter, options) => owl.computed(getter, options),
    effect: (fn, options) => owl.effect(fn, options),
    immediateEffect: (fn, options) => owl.immediateEffect(fn, options),
    batch: (fn) => owl.batch(fn),
    untrack: (fn) => owl.untrack(fn),
    microtask: (fn) => {
      Promise.resolve().then(fn);
    },
    tick: () => Promise.resolve(),
    drain: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

function firstDifference(a: string[], b: string[]): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function excerpt(log: string[], at: number): string {
  return log
    .slice(Math.max(0, at - 12), at + 6)
    .map((entry, i) => `${i + Math.max(0, at - 12) === at ? ">" : " "} ${entry}`)
    .join("\n");
}

async function differs(program: Program, owl: ReactiveApi, options: ModelOptions) {
  const actual = await runProgram(program, owl);
  const expected = await runProgram(program, new ReactiveModel(options).api());
  const at = firstDifference(actual, expected);
  return at === actual.length && at === expected.length ? null : { actual, expected, at };
}

async function check(owl: ReactiveApi, options: ModelOptions) {
  for (let seed = FIRST_SEED; seed < FIRST_SEED + CASES; seed++) {
    const program = generateProgram(prng(seed), options);
    if (!(await differs(program, owl, options))) continue;
    const small = await minimize(program, async (p) => !!(await differs(p, owl, options)));
    const { actual, expected, at } = (await differs(small, owl, options))!;
    throw new Error(
      `seed ${seed} (OWL_REACTIVITY_SEED=${seed} OWL_REACTIVITY_CASES=1), minimized program:\n` +
        `${printProgram(small)}\n\nowl, from entry ${at}:\n${excerpt(actual, at)}\n\n` +
        `model:\n${excerpt(expected, at)}`
    );
  }
}

test(
  "random reactive programs run in the order of the reference model",
  async () => {
    await check(owlApi({ signal, computed, effect, immediateEffect, batch, untrack }), {});
    expect(true).toBe(true);
  },
  Math.max(10000, CASES * 20)
);

test.runIf(process.env.OWL_REACTIVITY_BUILD)(
  "a build runs them in the order of the model",
  async () => {
    const build = await import(process.env.OWL_REACTIVITY_BUILD!);
    const af18b4f5 = process.env.OWL_REACTIVITY_BUILD_MODE === "af18b4f5";
    await check(owlApi(build), { af18b4f5 });
    expect(true).toBe(true);
  },
  Math.max(10000, CASES * 20)
);
