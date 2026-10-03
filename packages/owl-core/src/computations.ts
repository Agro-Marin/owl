import { batched } from "./batched";
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

export interface Atom<T = any> {
  observers: Set<ComputationAtom>;
  value: T;
}

export interface ComputationAtom<T = any> extends Atom<T> {
  compute: () => T;
  isDerived: boolean;
  sources: Set<Atom>;
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

export const atomSymbol = Symbol("Atom");

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
// Bumped by every write: a run during which it did not move wrote nothing, so
// it cannot have invalidated one of its own sources.
let writeCount = 0;

export function createComputation(
  compute: () => any,
  isDerived: boolean,
  state: ComputationState = ComputationState.STALE,
  immediate: boolean = false,
  name: string = ""
): ComputationAtom {
  return {
    state,
    value: undefined,
    compute,
    sources: new Set(),
    observers: new Set(),
    isDerived,
    immediate,
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
  if (currentComputation) {
    currentComputation.sources.add(atom);
    atom.observers.add(currentComputation);
  }
  if (currentObserver && currentObserver !== currentComputation) {
    currentObserver.sources.add(atom);
    atom.observers.add(currentObserver);
  }
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
  writeCount++;
  if (debug.reactivity) {
    debugLog("reactivity", `write, ${atom.observers.size} observer(s)`, observerNames(atom));
  }
  for (const ctx of atom.observers) {
    if (ctx.state === ComputationState.EXECUTED) {
      if (ctx.isDerived) {
        markDownstream(ctx);
      } else if (ctx.immediate) {
        immediateObservers.push(ctx);
      } else {
        observers.push(ctx);
      }
    }
    ctx.state = ComputationState.STALE;
    if (ctx.isDerived && ctx.observers.size === 0) {
      pendingDisposals.add(ctx);
    }
  }
  let errors: unknown[] | null = null;
  if (immediateObservers.length && !batchDepth) {
    const toRun = immediateObservers;
    immediateObservers = [];
    errors = updateEach(toRun);
  }
  batchProcessEffects();
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
  const owner = computation.owner;
  if (
    owner &&
    owner.state !== ComputationState.EXECUTED &&
    !owner.running &&
    owner.immediate === computation.immediate
  ) {
    if (debug.effect) {
      debugLog("effect", `run owner ${owner.name} before ${computation.name}`);
    }
    updateOwnerFirst(owner);
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

const batchProcessEffects = batched(processEffects);
function processEffects() {
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
      if (computation.observers.size === 0) {
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
    for (const source of computation.sources) {
      if (!("compute" in source)) {
        continue;
      }
      updateComputation(source as ComputationAtom);
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
  const writesBefore = writeCount;
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
      if (writeCount !== writesBefore) {
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
  for (const source of computation.sources) {
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
  const previousSources = computation.sources;
  computation.sources = new Set();
  const previousComputation = currentComputation;
  const previousObserver = currentObserver;
  currentComputation = computation;
  currentObserver = undefined;
  try {
    return fn();
  } finally {
    // restored even if fn threw, so a later read does not attach to it
    currentComputation = previousComputation;
    currentObserver = previousObserver;
    const sources = computation.sources;
    for (const source of previousSources) {
      if (!sources.has(source)) {
        source.observers.delete(computation);
      }
    }
  }
}

export function removeSources(computation: ComputationAtom) {
  const sources = computation.sources;
  for (const source of sources) {
    const observers = source.observers;
    observers.delete(computation);
    // todo: if source has no effect observer anymore, remove its sources too
    // todo: test it
  }
  sources.clear();
}

export function disposeComputation(computation: ComputationAtom) {
  const sources = computation.sources;
  let failure: { error: unknown } | null = null;
  for (const source of sources) {
    source.observers.delete(computation);
    // Recursively dispose derived computations that lost all observers.
    // `isDerived` is only set on ComputationAtoms produced by `computed`, so
    // this check also acts as the "is this a ComputationAtom?" discriminator
    // that the previous `"compute" in source` test served.
    const derived = source as ComputationAtom;
    if (derived.isDerived && derived.observers.size === 0) {
      try {
        disposeComputation(derived);
      } catch (error) {
        failure ||= { error };
      }
    }
  }
  sources.clear();
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

function markDownstream(computation: ComputationAtom) {
  const stack: ComputationAtom[] = [computation];
  let current: ComputationAtom | undefined;
  while ((current = stack.pop())) {
    for (const observer of current.observers) {
      // Collect dead branches before the staleness short-circuit below: an
      // already-stale unobserved derived still needs to be unsubscribed.
      if (observer.isDerived && observer.observers.size === 0) {
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
  for (const observer of atom.observers) {
    names.push(observer.name || "?");
  }
  return names;
}
