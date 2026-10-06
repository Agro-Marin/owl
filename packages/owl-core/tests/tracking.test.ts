import {
  atomSymbol,
  ComputationState,
  computed,
  getCurrentComputation,
  createComputation,
  hasObservers,
  runTracked,
  effect,
  immediateEffect,
  observe,
  observersOf,
  proxy,
  signal,
  sourcesOf,
  untrack,
  type Atom,
  type ComputationAtom,
} from "../src";
import { updateComputation } from "../src/computations";
import { waitScheduler } from "./helpers";

const atomOf = (reactive: any): ComputationAtom => reactive[atomSymbol];

describe("dependency tracking", () => {
  test("a source read several times in a run is one edge", () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const sum = computed(() => a() + b() + a() + c() + a() + b());
    expect(sum()).toBe(10);
    expect(sourcesOf(atomOf(sum))).toEqual([atomOf(a), atomOf(b), atomOf(c)]);
    expect(observersOf(atomOf(a))).toEqual([atomOf(sum)]);

    a.set(10);
    expect(sum()).toBe(37);
    expect(sourcesOf(atomOf(sum))).toEqual([atomOf(a), atomOf(b), atomOf(c)]);
    expect(observersOf(atomOf(a))).toEqual([atomOf(sum)]);
  });

  test("the sources are kept in the order of the last run's reads", () => {
    const flip = signal(false);
    const a = signal("a");
    const b = signal("b");
    const both = computed(() => (flip() ? b() + a() : a() + b()));
    expect(both()).toBe("ab");
    expect(sourcesOf(atomOf(both))).toEqual([atomOf(flip), atomOf(a), atomOf(b)]);

    flip.set(true);
    expect(both()).toBe("ba");
    expect(sourcesOf(atomOf(both))).toEqual([atomOf(flip), atomOf(b), atomOf(a)]);
  });

  test("a source read in another order keeps its place among the observers", () => {
    const flip = signal(false);
    const s = signal(1);
    const x = signal(1);
    const first = computed(() => (flip() ? x() + s() : s() + x()));
    const second = computed(() => s());
    first();
    second();
    expect(observersOf(atomOf(s))).toEqual([atomOf(first), atomOf(second)]);

    flip.set(true);
    first();
    expect(observersOf(atomOf(s))).toEqual([atomOf(first), atomOf(second)]);
    expect(observersOf(atomOf(x))).toEqual([atomOf(first)]);
  });

  test("dropped sources are unsubscribed, added ones subscribed, kept ones untouched", () => {
    const step = signal(0);
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const d = signal(4);
    const other = computed(() => a() + c());
    const reader = computed(() => (step() ? c() + d() + a() : a() + b() + c()));
    other();
    expect(reader()).toBe(6);
    expect(observersOf(atomOf(a))).toEqual([atomOf(other), atomOf(reader)]);

    step.set(1);
    expect(reader()).toBe(8);
    expect(sourcesOf(atomOf(reader))).toEqual([atomOf(step), atomOf(c), atomOf(d), atomOf(a)]);
    expect(observersOf(atomOf(a))).toEqual([atomOf(other), atomOf(reader)]);
    expect(observersOf(atomOf(c))).toEqual([atomOf(other), atomOf(reader)]);
    expect(observersOf(atomOf(b))).toEqual([]);
    expect(observersOf(atomOf(d))).toEqual([atomOf(reader)]);

    b.set(20);
    expect(reader()).toBe(8);
    d.set(40);
    expect(reader()).toBe(44);
  });

  test("a computed pulled between two reads of the same source by its reader", () => {
    const s = signal(1);
    const inner = computed(() => s() * 10);
    const outer = computed(() => s() + inner() + s());
    expect(outer()).toBe(12);
    expect(sourcesOf(atomOf(outer))).toEqual([atomOf(s), atomOf(inner)]);
    expect(observersOf(atomOf(s))).toEqual([atomOf(outer), atomOf(inner)]);

    s.set(2);
    expect(outer()).toBe(24);
    expect(sourcesOf(atomOf(outer))).toEqual([atomOf(s), atomOf(inner)]);
    expect(observersOf(atomOf(s))).toEqual([atomOf(outer), atomOf(inner)]);
  });

  test("a nested run that reads the outer run's sources in another order", () => {
    const flip = signal(false);
    const a = signal(1);
    const b = signal(2);
    const inner = computed(() => (flip() ? b() + a() : a() + b()));
    const outer = computed(() => a() + inner() + b() + a() + inner());
    expect(outer()).toBe(10);
    flip.set(true);
    a.set(5);
    expect(outer()).toBe(26);
    expect(sourcesOf(atomOf(outer))).toEqual([atomOf(a), atomOf(inner), atomOf(b)]);
    expect(sourcesOf(atomOf(inner))).toEqual([atomOf(flip), atomOf(b), atomOf(a)]);
    expect(observersOf(atomOf(a))).toEqual([atomOf(outer), atomOf(inner)]);
  });

  test("an immediate effect run inside another run keeps both graphs exact", () => {
    const trigger = signal(0);
    const s = signal(1);
    const seen: number[] = [];
    immediateEffect(() => {
      trigger();
      seen.push(s() + s());
    });
    const writer = computed(() => {
      const value = s();
      trigger.set(value);
      return value + s();
    });
    expect(writer()).toBe(2);
    expect(seen).toEqual([2, 2]);
    expect(sourcesOf(atomOf(writer))).toEqual([atomOf(s)]);
    expect(observersOf(atomOf(s)).length).toBe(2);
  });

  test("a disposed effect is no longer reachable from what it read", () => {
    const s = signal(1);
    const t = signal(2);
    const stop = effect(() => s() + t() + s());
    const sAtom: Atom = atomOf(s);
    expect(observersOf(sAtom).length).toBe(1);
    stop();
    expect(observersOf(sAtom)).toEqual([]);
    expect(sAtom.subs).toBeUndefined();
    expect(sAtom.subsTail).toBeUndefined();
    expect(sAtom.activeLink).toBeUndefined();
    expect(atomOf(t).activeLink).toBeUndefined();
  });

  test("an effect disposed by its own run releases what it reads after", async () => {
    const s = signal(1);
    const t = signal(2);
    let stop: () => void = () => {};
    stop = effect(() => {
      s();
      if (s() > 1) {
        stop();
        t();
      }
    });
    s.set(2);
    await waitScheduler();
    expect(observersOf(atomOf(s))).toEqual([]);
    expect(observersOf(atomOf(t))).toEqual([]);
  });

  test("an observe() view read many times inside an effect subscribes once per value", async () => {
    const state = proxy({ a: 1, b: 2 });
    let calls = 0;
    const view = observe(state, () => calls++);
    const seen: number[] = [];
    const stop = effect(() => {
      let sum = 0;
      for (let i = 0; i < 10; i++) {
        sum += view.a + state.b + view.a;
      }
      seen.push(sum);
    });
    state.a = 3;
    expect(calls).toBe(1);
    // one-shot: the view is not read again until the effect re-runs
    state.a = 4;
    expect(calls).toBe(1);
    await waitScheduler();
    expect(seen).toEqual([40, 100]);
    state.a = 5;
    expect(calls).toBe(2);
    stop();
  });

  test("random read orders keep sources and observers consistent", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const signals = Array.from({ length: 12 }, (_, i) => signal(i));
    const plan = signal<number[]>([]);
    const innerPlan = signal<number[]>([]);
    const inner = computed(() => innerPlan().reduce((sum, i) => sum + signals[i](), 0));
    const reader = computed(() => {
      let sum = 0;
      for (const i of plan()) {
        sum += i < 0 ? inner() : signals[i]();
      }
      return sum;
    });
    const pick = () =>
      Array.from({ length: Math.floor(random() * 16) }, () =>
        random() < 0.15 ? -1 : Math.floor(random() * signals.length)
      );
    for (let round = 0; round < 200; round++) {
      plan.set(pick());
      if (random() < 0.5) {
        innerPlan.set(pick().filter((i) => i >= 0));
      }
      const expected = plan().reduce(
        (sum, i) =>
          sum + (i < 0 ? innerPlan().reduce((s, j) => s + signals[j](), 0) : signals[i]()),
        0
      );
      expect(reader()).toBe(expected);
      const order: Atom[] = [atomOf(plan)];
      for (const i of plan()) {
        const atom = i < 0 ? atomOf(inner) : atomOf(signals[i]);
        if (!order.includes(atom)) {
          order.push(atom);
        }
      }
      expect(sourcesOf(atomOf(reader))).toEqual(order);
      for (const s of signals) {
        const observers = observersOf(atomOf(s));
        expect(new Set(observers).size).toBe(observers.length);
        expect(observers.includes(atomOf(reader))).toBe(order.includes(atomOf(s)));
        expect(atomOf(s).activeLink).toBeUndefined();
      }
      if (random() < 0.3) {
        signals[Math.floor(random() * signals.length)].set(Math.floor(random() * 100));
      }
    }
  });

  test("a write does not reach a running computation through a source it has yet to read again", () => {
    const s = signal(0);
    const t = signal(0);
    let runs = 0;
    const render = createComputation(() => runs++, false, ComputationState.EXECUTED);
    runTracked(render, () => s() + t());
    runTracked(render, () => {
      t.set(1);
      expect(render.state).toBe(ComputationState.EXECUTED);
      s();
      s.set(1);
      // a signal write leaves its readers pending a check of the value
      expect(render.state).toBe(ComputationState.PENDING);
    });
    expect(observersOf(atomOf(t))).toEqual([]);
    expect(sourcesOf(render)).toEqual([atomOf(s)]);
  });

  test("a computation that tracks elsewhere: running it detaches its sources, which the tracking run reuses", () => {
    const s = signal(1);
    const t = signal(2);
    let runs = 0;
    const render = createComputation(() => runs++, false, ComputationState.EXECUTED);
    render.tracksElsewhere = true;
    runTracked(render, () => s() + t());
    const sLink = atomOf(s).subs;
    expect(observersOf(atomOf(s))).toEqual([render]);

    render.state = ComputationState.STALE;
    updateComputation(render);
    expect(runs).toBe(1);
    expect(observersOf(atomOf(s))).toEqual([]);
    expect(hasObservers(atomOf(t))).toBe(false);
    s.set(3);
    expect(render.state).toBe(ComputationState.EXECUTED);

    runTracked(render, () => s());
    expect(atomOf(s).subs).toBe(sLink);
    expect(observersOf(atomOf(s))).toEqual([render]);
    expect(atomOf(t).subs).toBeUndefined();
    s.set(4);
    expect(render.state).toBe(ComputationState.PENDING);
  });

  test("a computed a detached computation stops reading is collected by the next write", async () => {
    const s = signal(1);
    const c = computed(() => s() * 2);
    const render = createComputation(() => {}, false, ComputationState.EXECUTED);
    render.tracksElsewhere = true;
    runTracked(render, () => c());
    render.state = ComputationState.STALE;
    updateComputation(render);
    expect(hasObservers(atomOf(c))).toBe(false);
    expect(observersOf(atomOf(c))).toEqual([]);
    runTracked(render, () => s());
    expect(atomOf(c).subs).toBeUndefined();
    // the next write makes it a disposal candidate, disposed at the flush
    s.set(2);
    await waitScheduler();
    expect(sourcesOf(atomOf(c))).toEqual([]);
    expect(c()).toBe(4);
  });
});

describe("untrack", () => {
  test("a read inside untrack subscribes no observe() view either", () => {
    const other = proxy({ x: 1 });
    const state = proxy({
      get a() {
        return untrack(() => other.x);
      },
    });
    let calls = 0;
    const view = observe(state, () => calls++);
    expect(view.a).toBe(1);
    other.x = 2;
    expect(calls).toBe(0);
  });
});

describe("links", () => {
  test("a link to a computed keeps no copy of its value", () => {
    const list = signal([1, 2, 3]);
    const firstTwo = computed(() => list().slice(0, 2));
    let reader: any;
    const dispose = effect(() => {
      reader = getCurrentComputation();
      firstTwo();
      list();
    });
    expect(reader.deps.dep).toBe(atomOf(firstTwo));
    expect(reader.deps.seen).toBeUndefined();
    // a signal's link keeps it: a write set back compares to it
    expect(reader.deps.nextDep.seen).toBe(list());
    dispose();
  });
});
