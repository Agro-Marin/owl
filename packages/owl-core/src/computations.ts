import { debug, debugLog } from "./debug";

export interface ReadonlyReactiveValue<TRead> {
  (): TRead;
}

export interface ReactiveValue<TRead, TWrite = TRead> extends ReadonlyReactiveValue<TRead> {
  /**
   * Update the value of the reactive with a new value. If the new value is different
   * from the previous values, all computations that depends on this reactive will
   * be invalidated, and effects will rerun.
   */
  set(nextValue: TWrite): void;
}

/**
 * The `equals` option accepted by `signal` and `computed`: a custom equality
 * used to decide whether a new value should notify observers. Defaults to
 * `Object.is`. Pass `false` to disable the check entirely (every write or
 * recompute notifies, even with an identical value — useful for values that
 * are mutated in place). The function receives (previous, next) and runs
 * untracked: it can safely read reactive values without subscribing to them.
 */
export type Equals<T> = false | ((a: T, b: T) => boolean);

function neverEqual() {
  return false;
}

export function toEqualsFn<T>(equals: Equals<T> | undefined): (a: T, b: T) => boolean {
  if (equals === false) {
    return neverEqual;
  }
  if (!equals) {
    return Object.is;
  }
  // A custom equals runs while tracking may be active (inside a computed's
  // recompute, or a signal set() issued from an effect): run it untracked so
  // reading through reactive proxies does not register spurious dependencies
  // on the active computation.
  return (a, b) => {
    const previousComputation = currentComputation;
    currentComputation = undefined;
    try {
      return equals(a, b);
    } finally {
      currentComputation = previousComputation;
    }
  };
}

export enum ComputationState {
  EXECUTED = 0,
  STALE = 1,
  PENDING = 2,
}

// One edge of the dependency graph, member of two doubly linked lists: the
// observer's sources (`deps`, in the order its last run read them) and the
// source's observers (`subs`, in the order they subscribed).
export class Link {
  dep: Atom;
  sub: ComputationAtom;
  // the run of `sub` that last read `dep` (see ComputationAtom.version), or
  // DEAD once the edge is removed
  version: number;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  // what dep.activeLink pointed at before this run pointed it here
  rollback: Link | undefined;

  constructor(
    dep: Atom,
    sub: ComputationAtom,
    version: number,
    prevDep: Link | undefined,
    nextDep: Link | undefined,
    prevSub: Link | undefined,
    rollback: Link | undefined
  ) {
    this.dep = dep;
    this.sub = sub;
    this.version = version;
    this.prevDep = prevDep;
    this.nextDep = nextDep;
    this.prevSub = prevSub;
    this.nextSub = undefined;
    this.rollback = rollback;
  }
}

const DEAD = -1;

export interface Atom<T = any> {
  value: T;
  // the computations observing it, oldest subscription first
  subs: Link | undefined;
  subsTail: Link | undefined;
  // the edge to the computation tracking it right now, if that run read it
  // already: a repeated read finds it in one step, however far back it was
  activeLink: Link | undefined;
}

export interface ComputationAtom<T = any> extends Atom<T> {
  compute: () => T;
  isDerived: boolean;
  // its sources, in the order its last run read them
  deps: Link | undefined;
  // while it runs, the last source this run read: the links after it were
  // read by the previous run and not (yet) by this one
  depsTail: Link | undefined;
  // bumped by every run: a link stamped with it was read by this run
  version: number;
  // whether this run pointed the activeLink of the sources it has yet to read
  // again at their old links (done once, at its first out-of-order read)
  prepared: boolean;
  // the atoms an observe() view subscribed it to: it subscribes while another
  // computation runs, so it cannot use activeLink to skip a repeated read
  observed: Set<Atom> | null;
  state: ComputationState;
  immediate?: boolean;
  // observe()'s contract (OWL 2's reactive callback): a derived source that
  // may have changed notifies without being recomputed, since recomputing it
  // inside a write reads records that write has not finished
  notifiesWithoutRecompute?: boolean;
  // the disposers of the effects created while this computation ran: they
  // last until it runs again or is disposed
  owned: Set<() => void> | null;
  // the effect that created this one, if any: due in the same flush, it runs
  // first, and its run disposes the child it recreates
  owner: ComputationAtom | null;
  isEffect: boolean;
  // true while its compute runs: a write it makes can reach a computation that
  // would otherwise pull it forward as its owner
  running: boolean;
  // what debug logging calls it
  name: string;
}

export function createAtom<T, K extends string>(value: T, type: K): Atom<T> & { type: K } {
  return { type, value, subs: undefined, subsTail: undefined, activeLink: undefined };
}

/**
 * The computations observing `atom`, oldest subscription first.
 */
export function observersOf(atom: Atom): ComputationAtom[] {
  const result: ComputationAtom[] = [];
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    result.push(link.sub);
  }
  return result;
}

/**
 * The sources of `computation`, in the order its last run read them.
 */
export function sourcesOf(computation: ComputationAtom): Atom[] {
  const result: Atom[] = [];
  for (let link = computation.deps; link !== undefined; link = link.nextDep) {
    result.push(link.dep);
  }
  return result;
}

export const atomSymbol = Symbol("Atom");

// The scope a computed was created in (unless detached): the effects its
// getter creates are disposed with that scope.
export const computationScopes = new WeakMap<
  ComputationAtom,
  { onDestroy(cb: () => void): void }
>();

let observers: ComputationAtom[] = [];
let immediateObservers: ComputationAtom[] = [];
let currentComputation: ComputationAtom | undefined;
// Derived computations that were notified of a write while nothing observed
// them. Left alone, they would stay subscribed to their sources forever (a
// lazy computed with no observer never re-runs, so removeSources never fires
// for it): a long-lived signal would retain every discarded computed that
// ever read it. Disposal is deferred to the effect flush because "unobserved"
// can be transient — an effect queued by the same write may re-subscribe, and
// a computation being pulled lazily is unobserved while it recomputes — so
// the flush re-checks before disposing.
let pendingDisposals = new Set<ComputationAtom>();
// Bumped by every write that invalidates an up-to-date computation: a run
// during which it did not move cannot have invalidated one of its own sources.
// (A computed notifying its readers of a new value on recompute does not move
// it: those readers were invalidated already, when the computed was.)
let invalidations = 0;

export function createComputation(
  compute: () => any,
  isDerived: boolean,
  state: ComputationState = ComputationState.STALE,
  immediate: boolean = false,
  name: string = ""
): ComputationAtom {
  return {
    value: undefined,
    subs: undefined,
    subsTail: undefined,
    activeLink: undefined,
    compute,
    isDerived,
    deps: undefined,
    depsTail: undefined,
    version: 0,
    prepared: false,
    observed: null,
    state,
    immediate,
    notifiesWithoutRecompute: false,
    owned: null,
    owner: null,
    isEffect: false,
    running: false,
    name,
  };
}

// The computation of the observe() view a read goes through: it subscribes in
// addition to the current computation, which keeps tracking as usual.
let currentObserver: ComputationAtom | undefined;

// Whether a read has anything to subscribe. Outside a computation and an
// observe() view it has not: the caller need not find, let alone create, the
// atom it would have subscribed to.
export function isObserving(): boolean {
  return currentComputation !== undefined || currentObserver !== undefined;
}

export function onReadAtom(atom: Atom) {
  const sub = currentComputation;
  if (sub !== undefined) {
    const tail = sub.depsTail;
    if (tail === undefined || tail.dep !== atom) {
      track(atom, sub, tail);
    }
  }
  if (currentObserver !== undefined && currentObserver !== sub) {
    const observed = (currentObserver.observed ??= new Set());
    if (!observed.has(atom)) {
      observed.add(atom);
      const tail = currentObserver.depsTail;
      const link = new Link(
        atom,
        currentObserver,
        currentObserver.version,
        tail,
        undefined,
        atom.subsTail,
        undefined
      );
      if (tail !== undefined) {
        tail.nextDep = link;
      } else {
        currentObserver.deps = link;
      }
      currentObserver.depsTail = link;
      appendSub(atom, link);
    }
  }
}

// `sub` reads `dep`, and the last source it read was another one (`tail`).
function track(dep: Atom, sub: ComputationAtom, tail: Link | undefined) {
  const version = sub.version;
  let active = dep.activeLink;
  if (active !== undefined && active.sub === sub && active.version !== DEAD) {
    if (active.version !== version) {
      // read by the previous run, out of order: it keeps its subscription
      reuse(active, sub, tail, version);
    }
    return;
  }
  const next = tail !== undefined ? tail.nextDep : sub.deps;
  if (next !== undefined) {
    if (next.dep === dep) {
      // read in the same order as by the previous run
      next.version = version;
      next.rollback = active;
      dep.activeLink = next;
      sub.depsTail = next;
      return;
    }
    if (!sub.prepared) {
      // The reads diverge from the previous run's: point every source still
      // to be read again at its old link, so that a later read finds it.
      sub.prepared = true;
      for (let link: Link | undefined = next; link !== undefined; link = link.nextDep) {
        const source: Atom = link.dep;
        if (source.activeLink !== link) {
          link.rollback = source.activeLink;
          source.activeLink = link;
        }
      }
      active = dep.activeLink;
      if (active !== undefined && active.sub === sub && active.version !== DEAD) {
        reuse(active, sub, tail, version);
        return;
      }
    }
  }
  const link = new Link(dep, sub, version, tail, next, dep.subsTail, active);
  if (next !== undefined) {
    next.prevDep = link;
  }
  if (tail !== undefined) {
    tail.nextDep = link;
  } else {
    sub.deps = link;
  }
  sub.depsTail = link;
  dep.activeLink = link;
  appendSub(dep, link);
}

// Moves a link the previous run read to the position of the current read.
function reuse(link: Link, sub: ComputationAtom, tail: Link | undefined, version: number) {
  link.version = version;
  const next = tail !== undefined ? tail.nextDep : sub.deps;
  if (link !== next) {
    const prevDep = link.prevDep;
    const nextDep = link.nextDep;
    // link comes after next, so it has a predecessor
    prevDep!.nextDep = nextDep;
    if (nextDep !== undefined) {
      nextDep.prevDep = prevDep;
    }
    link.prevDep = tail;
    link.nextDep = next;
    next!.prevDep = link;
    if (tail !== undefined) {
      tail.nextDep = link;
    } else {
      sub.deps = link;
    }
  }
  sub.depsTail = link;
}

function appendSub(dep: Atom, link: Link) {
  const subsTail = dep.subsTail;
  if (subsTail !== undefined) {
    subsTail.nextSub = link;
  } else {
    dep.subs = link;
  }
  dep.subsTail = link;
}

// Removes `link` from its source's observers.
function unlinkSub(link: Link) {
  const dep = link.dep;
  const prevSub = link.prevSub;
  const nextSub = link.nextSub;
  if (prevSub !== undefined) {
    prevSub.nextSub = nextSub;
  } else {
    dep.subs = nextSub;
  }
  if (nextSub !== undefined) {
    nextSub.prevSub = prevSub;
  } else {
    dep.subsTail = prevSub;
  }
  if (dep.activeLink === link) {
    dep.activeLink = link.rollback;
  }
  link.rollback = undefined;
  link.version = DEAD;
}

export function withObserver<T>(observer: ComputationAtom, fn: () => T): T {
  const previousObserver = currentObserver;
  currentObserver = observer;
  try {
    return fn();
  } finally {
    currentObserver = previousObserver;
  }
}

export function onWriteAtom(atom: Atom) {
  if (debug.reactivity) {
    const names = observerNames(atom);
    debugLog("reactivity", `write, ${names.length} observer(s)`, names);
  }
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    const ctx = link.sub;
    if (ctx.state === ComputationState.EXECUTED) {
      invalidations++;
      if (ctx.isDerived) {
        markDownstream(ctx);
      } else if (ctx.immediate) {
        immediateObservers.push(ctx);
      } else {
        observers.push(ctx);
      }
    }
    ctx.state = ComputationState.STALE;
    if (ctx.isDerived && ctx.subs === undefined) {
      pendingDisposals.add(ctx);
    }
  }
  let errors: unknown[] | null = null;
  if (immediateObservers.length && !batchDepth) {
    const toRun = immediateObservers;
    immediateObservers = [];
    errors = updateEach(toRun);
  }
  // scheduled by every write, even one that queued nothing: the flush keeps
  // its place among the microtasks of the tick that wrote first
  if (!flushScheduled) {
    scheduleFlush();
  }
  rethrow(errors);
}

// Writes made inside `batch` queue the immediate computations they notify
// instead of running them: the computations run once, when the outermost
// batch returns. An array method writes one index at a time, and must not
// expose its intermediate states (a splice duplicating an item) to them.
let batchDepth = 0;

export function batch<T>(fn: () => T): T {
  batchDepth++;
  let completed = false;
  try {
    const result = fn();
    completed = true;
    return result;
  } finally {
    if (--batchDepth === 0 && immediateObservers.length) {
      const toRun = immediateObservers;
      immediateObservers = [];
      if (debug.effect) {
        debugLog("effect", `batch end, ${toRun.length} immediate effect(s)`);
      }
      const errors = updateEach(toRun);
      if (completed) {
        rethrow(errors);
      } else if (errors) {
        // the error of fn is the one that propagates
        for (const error of errors) {
          Promise.reject(error);
        }
      }
    }
  }
}

// Runs every computation even when one throws: a computation left behind is not
// EXECUTED, so no later write would ever queue it again.
function updateEach(computations: ComputationAtom[]): unknown[] | null {
  let errors: unknown[] | null = null;
  for (let i = 0; i < computations.length; i++) {
    try {
      updateOwnerFirst(computations[i]);
    } catch (error) {
      (errors ||= []).push(error);
    }
  }
  return errors;
}

// An owner due in the same queue runs first: its run disposes the child it
// recreates. One that is running already (the child runs inside a write of
// its) or that waits in the other queue is left to its own turn.
function updateOwnerFirst(computation: ComputationAtom) {
  // the topmost ancestor due in the same queue, idle and stale: its run
  // disposes every effect below it, this one included
  let first: ComputationAtom | null = null;
  for (let owner = computation.owner; owner !== null; owner = owner.owner) {
    if (
      owner.state !== ComputationState.EXECUTED &&
      !owner.running &&
      owner.immediate === computation.immediate
    ) {
      first = owner;
    }
  }
  if (first) {
    if (debug.effect) {
      debugLog("effect", `run owner ${first.name} before ${computation.name}`);
    }
    updateComputation(first);
  }
  updateComputation(computation);
}

function rethrow(errors: unknown[] | null) {
  if (errors) {
    for (let i = 1; i < errors.length; i++) {
      Promise.reject(errors[i]);
    }
    throw errors[0];
  }
}

let flushScheduled = false;

// Intentionally Promise-based: errors thrown by the flush surface as unhandled
// promise rejections, which vitest's `onUnhandledError` hook intercepts (see
// tests/effect.test.ts using `IntentionalTestError`).
function scheduleFlush() {
  flushScheduled = true;
  Promise.resolve().then(processEffects);
}

function processEffects() {
  flushScheduled = false;
  const pending = observers;
  observers = [];
  if (debug.effect) {
    debugLog(
      "effect",
      `flush ${pending.length} effect(s)`,
      pending.map((c) => c.name)
    );
  }
  const errors = updateEach(pending);
  if (pendingDisposals.size !== 0) {
    const candidates = pendingDisposals;
    pendingDisposals = new Set();
    for (const computation of candidates) {
      // Re-check: the effects above (or any read since the write) may have
      // re-subscribed to the candidate. Disposing an unobserved derived is
      // safe: it is already STALE, so a later read fully recomputes it and
      // re-subscribes to whatever it reads.
      if (computation.subs === undefined) {
        if (debug.computed) {
          debugLog("computed", `dispose unobserved ${computation.name}`);
        }
        disposeComputation(computation);
      }
    }
  }
  rethrow(errors);
}

export function getCurrentComputation() {
  return currentComputation;
}

export function setComputation(computation: ComputationAtom | undefined) {
  currentComputation = computation;
}

export function updateComputation(computation: ComputationAtom) {
  const state = computation.state;
  if (state === ComputationState.EXECUTED) {
    return;
  }
  if (state === ComputationState.PENDING) {
    for (let link = computation.deps; link !== undefined; link = link.nextDep) {
      const source = link.dep as ComputationAtom;
      if (!source.isDerived) {
        continue;
      }
      updateComputation(source);
      // As soon as a source's recompute has marked us STALE (via onWriteAtom),
      // we already know this computation must re-run. Stop probing the rest of
      // the sources: any work they'd do is redundant, and worse, evaluating
      // them eagerly can surface errors from values the about-to-run body will
      // not actually read (e.g. an `if (lastValue()) uppercase()` guard whose
      // upstream signal just went falsy).
      if (computation.state === ComputationState.STALE) {
        break;
      }
    }
    // If the state is still not stale after processing the sources, none of
    // the dependencies have actually changed.
    if (computation.state !== ComputationState.STALE) {
      computation.state = ComputationState.EXECUTED;
      return;
    }
  }
  const invalidationsBefore = invalidations;
  computation.running = true;
  if (computation.isEffect ? debug.effect : computation.isDerived && debug.computed) {
    debugLog(computation.isEffect ? "effect" : "computed", `run ${computation.name}`);
  }
  try {
    computation.value = runTracked(computation, computation.compute);
  } catch (error) {
    if (debug.error) {
      debugLog("error", `${computation.name} threw`, error);
    }
    throw error;
  } finally {
    computation.running = false;
    try {
      if (invalidations !== invalidationsBefore) {
        settleDerivedSources(computation);
      }
    } finally {
      // A computation that threw stays subscribed to what it read before the
      // throw, and runs again when one of those changes.
      computation.state = ComputationState.EXECUTED;
    }
  }
}

// A derived source the run read and then invalidated, by a write of its own,
// is brought up to date before the run counts as done: left stale, it would
// never propagate a later change to this computation. As with a signal the
// run wrote after reading it, the run does not start over.
function settleDerivedSources(computation: ComputationAtom) {
  for (let link = computation.deps; link !== undefined; link = link.nextDep) {
    const source = link.dep;
    if ((source as ComputationAtom).isDerived && (source as ComputationAtom).state) {
      if (debug.computed) {
        debugLog(
          "computed",
          `settle ${(source as ComputationAtom).name}, invalidated by ${computation.name}`
        );
      }
      updateComputation(source as ComputationAtom);
    }
  }
}

/**
 * Runs `fn` as `computation`: what it reads becomes the computation's sources,
 * replacing the previous ones. A source read again keeps its subscription (and
 * its place among the source's observers) instead of being unsubscribed and
 * subscribed anew; only the sources `fn` no longer read are dropped, once it
 * returns or throws.
 */
export function runTracked<T>(computation: ComputationAtom, fn: () => T): T {
  const previousComputation = currentComputation;
  const previousObserver = currentObserver;
  computation.version++;
  computation.depsTail = undefined;
  computation.prepared = false;
  currentComputation = computation;
  currentObserver = undefined;
  try {
    return fn();
  } finally {
    // restored even if fn threw, so a later read does not attach to it
    currentComputation = previousComputation;
    currentObserver = previousObserver;
    endTracking(computation);
  }
}

function endTracking(computation: ComputationAtom) {
  const tail = computation.depsTail;
  let link = tail !== undefined ? tail.nextDep : computation.deps;
  if (link !== undefined) {
    // read by the previous run, not by this one
    if (tail !== undefined) {
      tail.nextDep = undefined;
    } else {
      computation.deps = undefined;
    }
    do {
      const next: Link | undefined = link.nextDep;
      unlinkSub(link);
      link = next;
    } while (link !== undefined);
  }
  for (link = computation.deps; link !== undefined; link = link.nextDep) {
    link.dep.activeLink = link.rollback;
    link.rollback = undefined;
  }
  if (computation.observed && computation.deps === undefined) {
    computation.observed = null;
  }
}

export function removeSources(computation: ComputationAtom) {
  let link = computation.deps;
  computation.deps = undefined;
  computation.depsTail = undefined;
  computation.observed = null;
  while (link !== undefined) {
    const next: Link | undefined = link.nextDep;
    unlinkSub(link);
    link = next;
  }
}

export function disposeComputation(computation: ComputationAtom) {
  let link = computation.deps;
  computation.deps = undefined;
  computation.depsTail = undefined;
  computation.observed = null;
  let failure: { error: unknown } | null = null;
  while (link !== undefined) {
    const next: Link | undefined = link.nextDep;
    unlinkSub(link);
    // Recursively dispose derived computations that lost all observers.
    const derived = link.dep as ComputationAtom;
    if (derived.isDerived && derived.subs === undefined) {
      try {
        disposeComputation(derived);
      } catch (error) {
        failure ||= { error };
      }
    }
    link = next;
  }
  // Mark as stale so it recomputes correctly if ever re-used (shared computed case)
  computation.state = ComputationState.STALE;
  try {
    disposeOwned(computation);
  } catch (error) {
    failure ||= { error };
  }
  if (failure) {
    throw failure.error;
  }
}

/**
 * Disposes the effects created during the last run of `computation`. All of
 * them are disposed even when a cleanup throws; the first error is rethrown.
 */
export function disposeOwned(computation: ComputationAtom) {
  const owned = computation.owned;
  if (!owned) {
    return;
  }
  computation.owned = null;
  let failure: { error: unknown } | null = null;
  for (const dispose of owned) {
    try {
      dispose();
    } catch (error) {
      failure ||= { error };
    }
  }
  if (failure) {
    throw failure.error;
  }
}

// the derived computations markDownstream has yet to visit (it calls no user
// code, so one stack serves every call)
const downstream: ComputationAtom[] = [];

function markDownstream(computation: ComputationAtom) {
  const stack = downstream;
  stack.push(computation);
  let current: ComputationAtom | undefined;
  while ((current = stack.pop())) {
    for (let link = current.subs; link !== undefined; link = link.nextSub) {
      const observer = link.sub;
      // Collect dead branches before the staleness short-circuit below: an
      // already-stale unobserved derived still needs to be unsubscribed.
      if (observer.isDerived && observer.subs === undefined) {
        pendingDisposals.add(observer);
      }
      if (observer.state) {
        continue;
      }
      observer.state = observer.notifiesWithoutRecompute
        ? ComputationState.STALE
        : ComputationState.PENDING;
      if (observer.isDerived) {
        stack.push(observer);
      } else if (observer.immediate) {
        immediateObservers.push(observer);
      } else {
        observers.push(observer);
      }
    }
  }
}

export function untrack<T>(fn: (...args: any[]) => T): T {
  const previousComputation = currentComputation;
  currentComputation = undefined;
  let result: T;
  try {
    result = fn();
  } finally {
    currentComputation = previousComputation;
  }
  return result;
}

function observerNames(atom: Atom): string[] {
  const names: string[] = [];
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    names.push(link.sub.name || "?");
  }
  return names;
}
