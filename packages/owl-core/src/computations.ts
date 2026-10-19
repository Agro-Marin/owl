import { debug, debugLog } from "./debug";
import { OwlError } from "./owl_error";

export interface ReadonlyReactiveValue<TRead> {
  (): TRead;
}

export interface ReactiveValue<TRead, TWrite = TRead> extends ReadonlyReactiveValue<TRead> {
  set(nextValue: TWrite): void;
}

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
  return (a, b) => untrack(() => equals(a, b));
}

export enum ComputationState {
  EXECUTED = 0,
  STALE = 1,
  PENDING = 2,
  RUNNING = 3,
}

export class Link {
  dep: Atom;
  sub: ComputationAtom;
  version: number;
  prevDep: Link | undefined;
  nextDep: Link | undefined;
  prevSub: Link | undefined;
  nextSub: Link | undefined;
  rollback: Link | undefined;
  seen: unknown;

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
    this.seen = seenValue(dep);
  }
}

function seenValue(dep: Atom): unknown {
  return (dep as ComputationAtom).isDerived ? undefined : dep.value;
}

const DEAD = -1;

export interface Atom<T = any> {
  value: T;
  subs: Link | undefined;
  subsTail: Link | undefined;
  activeLink: Link | undefined;
}

export interface ComputationAtom<T = any> extends Atom<T> {
  compute: () => T;
  onUpdated?: () => void;
  isDerived: boolean;
  deps: Link | undefined;
  depsTail: Link | undefined;
  version: number;
  prepared: boolean;
  tracksElsewhere: boolean;
  observed: Set<Atom> | null;
  state: ComputationState;
  immediate: boolean;
  notifiesWithoutRecompute: boolean;
  owned: Set<() => void> | null;
  owner: ComputationAtom | null;
  isEffect: boolean;
  running: boolean;
  ownerDepth: number;
  forward: boolean;
  name: string;
}

export function createAtom<T, K extends string>(value: T, type: K): Atom<T> & { type: K } {
  return { type, value, subs: undefined, subsTail: undefined, activeLink: undefined };
}

function isLive(link: Link): boolean {
  return link.version === link.sub.version;
}

export function hasObservers(atom: Atom): boolean {
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    if (isLive(link)) {
      return true;
    }
  }
  return false;
}

export function observersOf(atom: Atom): ComputationAtom[] {
  const result: ComputationAtom[] = [];
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    if (isLive(link)) {
      result.push(link.sub);
    }
  }
  return result;
}

export function sourcesOf(computation: ComputationAtom): Atom[] {
  const result: Atom[] = [];
  for (let link = computation.deps; link !== undefined; link = link.nextDep) {
    result.push(link.dep);
  }
  return result;
}

export const atomSymbol = Symbol("Atom");

export const scopeStack: object[] = [];

let currentOwner: ComputationAtom | undefined;

let observers: ComputationAtom[] = [];
let immediateObservers: ComputationAtom[] = [];
let currentComputation: ComputationAtom | undefined;
let pendingDisposals = new Set<ComputationAtom>();
const graphWalk: ComputationAtom[] = [];

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
    onUpdated: undefined,
    isDerived,
    deps: undefined,
    depsTail: undefined,
    version: 0,
    prepared: false,
    tracksElsewhere: false,
    observed: null,
    state,
    immediate,
    notifiesWithoutRecompute: false,
    owned: null,
    owner: null,
    isEffect: false,
    running: false,
    ownerDepth: 0,
    forward: false,
    name,
  };
}

let currentObserver: ComputationAtom | undefined;

export function isObserving(): boolean {
  return currentComputation !== undefined || currentObserver !== undefined;
}

export function onReadAtom(atom: Atom) {
  const sub = currentComputation;
  if (sub !== undefined) {
    const tail = sub.depsTail;
    if (tail === undefined || tail.dep !== atom) {
      track(atom, sub, tail);
    } else if (sub.state !== ComputationState.RUNNING) {
      readAgainAfterWrite(tail, sub);
    }
  }
  const observer = currentObserver;
  if (observer !== undefined && observer !== sub) {
    if (observer.running) {
      const tail = observer.depsTail;
      if (tail === undefined || tail.dep !== atom) {
        track(atom, observer, tail);
      }
      return;
    }
    const observed = (observer.observed ??= observedSources(observer));
    if (!observed.has(atom)) {
      observed.add(atom);
      const tail = observer.depsTail;
      const link = new Link(
        atom,
        observer,
        observer.version,
        tail,
        undefined,
        atom.subsTail,
        undefined
      );
      if (tail !== undefined) {
        tail.nextDep = link;
      } else {
        observer.deps = link;
      }
      observer.depsTail = link;
      appendSub(atom, link);
    }
  }
}

function track(dep: Atom, sub: ComputationAtom, tail: Link | undefined) {
  const version = sub.version;
  let active = dep.activeLink;
  if (active !== undefined && active.sub === sub && active.version !== DEAD) {
    if (active.version !== version) {
      reuse(active, sub, tail, version);
    } else if (sub.state !== ComputationState.RUNNING) {
      readAgainAfterWrite(active, sub);
    }
    return;
  }
  const next = tail !== undefined ? tail.nextDep : sub.deps;
  if (next !== undefined) {
    if (next.dep === dep) {
      next.version = version;
      next.seen = seenValue(dep);
      next.rollback = active;
      dep.activeLink = next;
      sub.depsTail = next;
      return;
    }
    if (!sub.prepared) {
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

function readAgainAfterWrite(link: Link, sub: ComputationAtom) {
  if (!sub.isDerived) {
    link.seen = seenValue(link.dep);
  }
}

function reuse(link: Link, sub: ComputationAtom, tail: Link | undefined, version: number) {
  link.version = version;
  link.seen = seenValue(link.dep);
  const next = tail !== undefined ? tail.nextDep : sub.deps;
  if (link !== next) {
    const prevDep = link.prevDep;
    const nextDep = link.nextDep;
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

export function onWriteAtom(atom: Atom, comparable: boolean = false) {
  if (debug.reactivity) {
    const names = observerNames(atom);
    debugLog("reactivity", `write, ${names.length} observer(s)`, names);
  }
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    const ctx = link.sub;
    const state = ctx.state;
    if (state === ComputationState.EXECUTED || ctx.forward) {
      if (link.version !== ctx.version) {
        continue;
      }
      if (ctx.isDerived) {
        markDownstream(ctx);
      } else if (ctx.immediate) {
        immediateObservers.push(ctx);
      } else {
        observers.push(ctx);
      }
    } else if (state === ComputationState.RUNNING) {
      if (link.version !== ctx.version) {
        continue;
      }
      invalidatedWhileRunning(ctx);
    }
    ctx.state =
      comparable && ctx.state !== ComputationState.STALE && !ctx.notifiesWithoutRecompute
        ? ComputationState.PENDING
        : ComputationState.STALE;
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
  if (!flushScheduled) {
    scheduleFlush();
  }
  rethrow(errors);
}

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
        for (const error of errors) {
          Promise.reject(error);
        }
      }
    }
  }
}

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

function updateOwnerFirst(computation: ComputationAtom) {
  if (computation.state === ComputationState.EXECUTED) {
    return;
  }
  let first: ComputationAtom | null = null;
  for (let owner = computation.owner; owner !== null; owner = owner.owner) {
    if (
      owner.state !== ComputationState.EXECUTED &&
      !owner.running &&
      (owner.isDerived || owner.immediate === computation.immediate)
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
  let errors = updateEach(pending);
  if (pendingDisposals.size !== 0) {
    const candidates = pendingDisposals;
    pendingDisposals = new Set();
    for (const computation of candidates) {
      if (!hasObservers(computation)) {
        if (debug.computed) {
          debugLog("computed", `dispose unobserved ${computation.name}`);
        }
        try {
          disposeComputation(computation);
        } catch (error) {
          (errors ||= []).push(error);
        }
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
  if (computation.running) {
    if (debug.error) {
      debugLog("error", `cycle: ${computation.name}`);
    }
    throw new OwlError(
      `Cycle detected: ${computation.name || "a computation"} reads its own value`
    );
  }
  if (state === ComputationState.PENDING) {
    try {
      for (let link = computation.deps; link !== undefined; link = link.nextDep) {
        const source = link.dep as ComputationAtom;
        if (!source.isDerived) {
          if (!Object.is(link.seen, source.value)) {
            computation.state = ComputationState.STALE;
            break;
          }
          continue;
        }
        updateComputation(source);
        if (computation.state === ComputationState.STALE) {
          break;
        }
      }
    } catch (error) {
      if (debug.error) {
        debugLog("error", `${computation.name}: a source threw`, error);
      }
      computation.state = ComputationState.EXECUTED;
      computation.forward = false;
      throw error;
    }
    if (computation.state !== ComputationState.STALE) {
      computation.state = ComputationState.EXECUTED;
      computation.forward = false;
      callOnUpdated(computation);
      return;
    }
  }
  computation.state = ComputationState.RUNNING;
  computation.forward = false;
  computation.running = true;
  if (computation.isEffect ? debug.effect : computation.isDerived && debug.computed) {
    debugLog(computation.isEffect ? "effect" : "computed", `run ${computation.name}`);
  }
  let releaseFailure: { error: unknown } | null = null;
  try {
    if (computation.owned !== null && !computation.isEffect && !computation.tracksElsewhere) {
      releaseFailure = releaseOwned(computation, "runs again");
    }
    computation.value = computation.tracksElsewhere
      ? detachAndRun(computation)
      : runTracked(computation, computation.compute);
  } catch (error) {
    if (debug.error) {
      debugLog("error", `${computation.name} threw`, error);
    }
    if (releaseFailure) {
      Promise.reject(releaseFailure.error);
    }
    throw error;
  } finally {
    computation.running = false;
    if (computation.state === ComputationState.RUNNING) {
      computation.state = ComputationState.EXECUTED;
    } else {
      endInvalidatedRun(computation);
    }
  }
  callOnUpdated(computation, releaseFailure);
  if (releaseFailure) {
    if (computation.isDerived) {
      Promise.reject(releaseFailure.error);
    } else {
      throw releaseFailure.error;
    }
  }
}

function callOnUpdated(computation: ComputationAtom, releaseFailure?: { error: unknown } | null) {
  const callback = computation.onUpdated;
  if (!callback) return;
  try {
    runUnowned(callback);
  } catch (error) {
    if (debug.error) {
      debugLog("error", `${computation.name} notification failed`, error);
    }
    if (releaseFailure) {
      Promise.reject(releaseFailure.error);
    }
    throw error;
  }
}

export function releaseOwned(computation: ComputationAtom, why: string): { error: unknown } | null {
  if (debug.effect) {
    debugLog(
      "effect",
      `${computation.name} ${why}: dispose ${computation.owned!.size} effect(s) it created`
    );
  }
  try {
    runUnowned(disposeOwned, computation);
    return null;
  } catch (error) {
    return { error };
  }
}

function detachAndRun(computation: ComputationAtom) {
  computation.version++;
  return runUnowned(computation.compute, undefined);
}

function forwardThrough(computation: ComputationAtom) {
  computation.forward = false;
  if (debug.reactivity) {
    debugLog("reactivity", `forward through ${computation.name}`);
  }
}

function invalidatedWhileRunning(computation: ComputationAtom) {
  if (debug.reactivity) {
    debugLog("reactivity", `${computation.name} invalidated by a write during its run`);
  }
}

function endInvalidatedRun(computation: ComputationAtom) {
  if (computation.isDerived) {
    computation.forward = true;
    if (debug.computed) {
      debugLog("computed", `${computation.name} ends out of date, a write reached it while it ran`);
    }
  } else {
    computation.state = ComputationState.EXECUTED;
  }
  const stack = graphWalk;
  stack.push(computation);
  let current: ComputationAtom | undefined;
  while ((current = stack.pop())) {
    for (let link = current.deps; link !== undefined; link = link.nextDep) {
      const source = link.dep as ComputationAtom;
      if (source.isDerived && source.state !== ComputationState.EXECUTED && !source.forward) {
        if (debug.reactivity) {
          debugLog(
            "reactivity",
            `${source.name} forwards the next write, ${computation.name} read it`
          );
        }
        source.forward = true;
        stack.push(source);
      }
    }
  }
}

export function runTracked<T>(computation: ComputationAtom, fn: () => T): T {
  const previousComputation = currentComputation;
  const previousObserver = currentObserver;
  computation.version++;
  computation.ownerDepth = scopeStack.length;
  computation.depsTail = undefined;
  computation.prepared = false;
  currentComputation = computation;
  currentObserver = undefined;
  try {
    return fn();
  } finally {
    currentComputation = previousComputation;
    currentObserver = previousObserver;
    endTracking(computation);
  }
}

export function getOwner(): ComputationAtom | undefined {
  const owner = currentComputation ?? currentOwner;
  return owner !== undefined && owner.ownerDepth === scopeStack.length ? owner : undefined;
}

function endTracking(computation: ComputationAtom) {
  const tail = computation.depsTail;
  let link = tail !== undefined ? tail.nextDep : computation.deps;
  if (link !== undefined) {
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
  computation.observed = null;
}

function observedSources(observer: ComputationAtom): Set<Atom> {
  const result = new Set<Atom>();
  for (let link = observer.deps; link !== undefined; link = link.nextDep) {
    result.add(link.dep);
  }
  return result;
}

export function removeSources(computation: ComputationAtom) {
  let link = computation.deps;
  computation.deps = undefined;
  computation.depsTail = undefined;
  computation.observed = null;
  let failure: { error: unknown } | null = null;
  while (link !== undefined) {
    const next: Link | undefined = link.nextDep;
    unlinkSub(link);
    const source = link.dep as ComputationAtom;
    if (source.isDerived && !source.running && !hasObservers(source)) {
      if (debug.computed) {
        debugLog("computed", `dispose ${source.name}, ${computation.name} was its last observer`);
      }
      try {
        disposeComputation(source);
      } catch (error) {
        failure ||= { error };
      }
    }
    link = next;
  }
  if (failure) {
    throw failure.error;
  }
}

export function disposeComputation(computation: ComputationAtom) {
  let failure: { error: unknown } | null = null;
  try {
    removeSources(computation);
  } catch (error) {
    failure = { error };
  }
  computation.state = computation.isDerived ? ComputationState.STALE : ComputationState.EXECUTED;
  if (computation.owned !== null) {
    const releaseFailure = releaseOwned(computation, "is disposed");
    failure ||= releaseFailure;
  }
  if (failure) {
    throw failure.error;
  }
}

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
  const stack = graphWalk;
  if (computation.forward) {
    forwardThrough(computation);
  }
  stack.push(computation);
  let current: ComputationAtom | undefined;
  while ((current = stack.pop())) {
    for (let link = current.subs; link !== undefined; link = link.nextSub) {
      const observer = link.sub;
      if (observer.isDerived && observer.subs === undefined) {
        pendingDisposals.add(observer);
      }
      if (link.version !== observer.version) {
        continue;
      }
      const state = observer.state;
      if (state !== ComputationState.EXECUTED) {
        if (observer.forward) {
          forwardThrough(observer);
          stack.push(observer);
        } else if (state === ComputationState.RUNNING) {
          invalidatedWhileRunning(observer);
          observer.state = observer.notifiesWithoutRecompute
            ? ComputationState.STALE
            : ComputationState.PENDING;
        }
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
  const previousObserver = currentObserver;
  if (previousComputation === undefined && previousObserver === undefined) {
    return fn();
  }
  const previousOwner = currentOwner;
  currentOwner = previousComputation ?? previousOwner;
  currentComputation = currentObserver = undefined;
  try {
    return fn();
  } finally {
    currentComputation = previousComputation;
    currentObserver = previousObserver;
    currentOwner = previousOwner;
  }
}

export function runUnowned<T>(fn: () => T): T;
export function runUnowned<A, T>(fn: (arg: A) => T, arg: A): T;
export function runUnowned<A, T>(fn: (arg: A) => T, arg?: A): T {
  const previousComputation = currentComputation;
  const previousObserver = currentObserver;
  const previousOwner = currentOwner;
  currentComputation = currentObserver = currentOwner = undefined;
  try {
    return arguments.length === 1 ? (fn as () => T)() : fn(arg as A);
  } finally {
    currentComputation = previousComputation;
    currentObserver = previousObserver;
    currentOwner = previousOwner;
  }
}

function observerNames(atom: Atom): string[] {
  const names: string[] = [];
  for (let link = atom.subs; link !== undefined; link = link.nextSub) {
    names.push(link.sub.name || "?");
  }
  return names;
}
