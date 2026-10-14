import {
  Atom,
  batch,
  ComputationState,
  createAtom,
  createComputation,
  disposeComputation,
  hasObservers,
  isObserving,
  onReadAtom,
  onWriteAtom,
  updateComputation,
} from "./computations";
import { debug, debugLog } from "./debug";
import { getScope } from "./scope";

const NEGATIVE_ZERO = Symbol("selector negative zero");

function atomKey<K>(key: K): K | typeof NEGATIVE_ZERO {
  return Object.is(key, -0) ? NEGATIVE_ZERO : key;
}

const enum Publication {
  NONE,
  PAIR,
  ALL,
}

export interface SelectorOptions {
  detached?: boolean;
  name?: string;
}

export function selector<K>(source: () => K, options: SelectorOptions = {}): (key: K) => boolean {
  const atoms = new Map<K | typeof NEGATIVE_ZERO, Atom>();
  let swept = 0;
  let checks = 0;
  let current: K;
  let started = false;
  let failure: { error: unknown } | null = null;
  let disposed = false;
  let pending = Publication.NONE;
  let previousKey: K | undefined;
  const computation = createComputation(
    () => {
      pending = Publication.NONE;
      previousKey = undefined;
      if (disposed) return;
      const previous = current;
      const previousFailure = failure;
      const answered = started && !failure;
      readSource();
      if (disposed) {
        release();
        return;
      }
      if (!started) {
        started = true;
      } else if (
        answered !== !failure ||
        (failure && !Object.is(previousFailure?.error, failure.error))
      ) {
        pending = Publication.ALL;
      } else if (!failure && !Object.is(previous, current)) {
        previousKey = previous;
        pending = Publication.PAIR;
      }
    },
    false,
    ComputationState.STALE,
    true,
    options.name || (debug.computed && source.name) || "selector"
  );
  computation.onUpdated = () => {
    if (started) checks++;
    let completed = false;
    try {
      if (pending) batch(notify);
      completed = true;
    } finally {
      try {
        if (checks && checks >= atoms.size) sweep();
        if (atoms.size === 0 && started) release();
      } catch (error) {
        if (completed) throw error;
        Promise.reject(error);
      }
    }
  };

  function readSource() {
    try {
      const next = source();
      if (!disposed) {
        current = next;
        failure = null;
      } else if (debug.computed) {
        debugLog("computed", `${computation.name}: result after destroy dropped`);
      }
    } catch (error) {
      if (disposed) {
        if (debug.computed) {
          debugLog("computed", `${computation.name}: failure after destroy dropped`, error);
        }
        return;
      }
      if (debug.computed) {
        debugLog(
          "computed",
          `${computation.name}: its source failed, every key rethrows it`,
          error
        );
      }
      failure = { error };
    }
  }

  function notify() {
    const all = pending === Publication.ALL;
    const previous = previousKey as K;
    const next = current;
    pending = Publication.NONE;
    previousKey = undefined;
    if (all) {
      for (const key of atoms.keys()) notifyKey(key);
    } else {
      notifyKey(previous);
      notifyKey(next);
    }
  }

  function notifyKey(key: K | typeof NEGATIVE_ZERO) {
    const storedKey = atomKey(key);
    const atom = atoms.get(storedKey);
    if (atom !== undefined) {
      onWriteAtom(atom);
      if (!hasObservers(atom)) atoms.delete(storedKey);
    }
  }

  function sweep() {
    const before = atoms.size;
    atoms.forEach((atom, key) => {
      if (!hasObservers(atom)) {
        atoms.delete(key);
      }
    });
    swept = atoms.size;
    checks = 0;
    if (debug.computed) {
      debugLog(
        "computed",
        `${computation.name} swept ${before - swept} unread key(s), ${swept} kept`
      );
    }
  }

  function release() {
    if (debug.computed) {
      debugLog("computed", `${computation.name}: no key is read, stops following its source`);
    }
    started = false;
    batch(() => disposeComputation(computation));
  }

  function update() {
    if (computation.running) {
      return;
    }
    if (!started) {
      computation.state = ComputationState.STALE;
    }
    updateComputation(computation);
  }

  function isSelected(key: K): boolean {
    if (disposed) {
      if (failure) throw failure.error;
      return Object.is(current, key);
    }
    if (isObserving()) {
      const storedKey = atomKey(key);
      let atom = atoms.get(storedKey);
      if (atom === undefined) {
        if (atoms.size >= 2 * swept + 16) {
          sweep();
        }
        atom = createAtom(undefined, "key");
        atoms.set(storedKey, atom);
      }
      onReadAtom(atom);
    } else if (!started) {
      readSource();
      if (failure) throw failure.error;
      return Object.is(current, key);
    }
    if (!started || computation.state !== ComputationState.EXECUTED) update();
    if (failure) {
      throw failure.error;
    }
    return Object.is(current, key);
  }

  if (!options.detached) {
    getScope()?.onDestroy(() => {
      disposed = true;
      try {
        batch(() => disposeComputation(computation));
      } finally {
        atoms.clear();
      }
    });
  }
  return isSelected;
}
