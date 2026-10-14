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
  untrack,
  updateComputation,
} from "./computations";
import { debug, debugLog } from "./debug";
import { getScope } from "./scope";

// Map merges signed zero; selector answers use Object.is and distinguish it.
const NEGATIVE_ZERO = Symbol("selector negative zero");

function atomKey<K>(key: K): K | typeof NEGATIVE_ZERO {
  return Object.is(key, -0) ? NEGATIVE_ZERO : key;
}

export interface SelectorOptions {
  /**
   * Keep the selector alive past the scope it is created in (see computed).
   */
  detached?: boolean;
  /**
   * What debug logging calls it.
   */
  name?: string;
}

/**
 * Returns `isSelected(key)`: whether `source()` is `key` (Object.is). A
 * computation reading `isSelected(key)` depends on the answer for that key
 * only: when the source changes from `a` to `b`, the readers of `a` and of `b`
 * are notified, no other. A list whose rows each read `isSelected(row.id)`
 * renders two rows on a selection change instead of every row.
 */
export function selector<K>(source: () => K, options: SelectorOptions = {}): (key: K) => boolean {
  // the atom of each key a computation read, created on that read
  const atoms = new Map<K | typeof NEGATIVE_ZERO, Atom>();
  let swept = 0;
  // source checks since the last sweep: sweeping every as many checks as
  // there are keys finds the keys nobody reads any more, at O(1) a change
  let checks = 0;
  let current: K;
  // whether the computation follows the source: it does while a key is read
  let started = false;
  // what the source threw: every key rethrows it until the source recovers
  let failure: { error: unknown } | null = null;
  let disposed = false;
  let pendingKeys: Iterable<K | typeof NEGATIVE_ZERO> | null = null;
  const computation = createComputation(
    () => {
      pendingKeys = null;
      if (disposed) return;
      const previous = current;
      const previousFailure = failure;
      const answered = started && !failure;
      readSource();
      if (disposed) {
        // The source may destroy its own scope, then read or create more work.
        // Release that late work without changing the frozen answer.
        release();
        return;
      }
      if (!started) {
        started = true;
      } else if (
        answered !== !failure ||
        (failure && !Object.is(previousFailure?.error, failure.error))
      ) {
        // Failed, recovered or threw a different value: every answer changed.
        pendingKeys = atoms.keys();
      } else if (!failure && !Object.is(previous, current)) {
        pendingKeys = [previous, current];
      }
    },
    false,
    ComputationState.STALE,
    true,
    options.name || (debug.computed && source.name) || "selector"
  );
  computation.onUpdated = () => {
    const keys = pendingKeys;
    pendingKeys = null;
    if (started) checks++;
    let completed = false;
    try {
      if (keys) notify(keys);
      completed = true;
    } finally {
      try {
        // Notification removes unread keys and can dispose more readers.
        if (checks && checks >= atoms.size) sweep();
        if (atoms.size === 0 && started) release();
      } catch (error) {
        if (completed) throw error;
        // Preserve a notification failure while still releasing source work.
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

  // one batch: an immediate reader runs once, after every key is notified,
  // and one that throws does not keep the others from being notified
  function notify(keys: Iterable<K | typeof NEGATIVE_ZERO>) {
    untrack(() =>
      batch(() => {
        for (const key of keys) {
          const storedKey = atomKey(key);
          const atom = atoms.get(storedKey);
          if (atom !== undefined) {
            onWriteAtom(atom);
            if (!hasObservers(atom)) {
              atoms.delete(storedKey);
            }
          }
        }
      })
    );
  }

  // keys read once and never again would keep their atoms: drop the
  // unobserved ones whenever the table doubled since the last sweep
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

  // no key is read: stop following the source until one is read again
  function release() {
    if (debug.computed) {
      debugLog("computed", `${computation.name}: no key is read, stops following its source`);
    }
    started = false;
    // Unsubscribe before source-owned cleanup can write its inputs. A
    // derived source's cleanup can also write another dependency: defer
    // those immediate runs until disposal marks this computation done.
    batch(() => disposeComputation(computation));
  }

  function update() {
    // a reader its run notifies reads the answer that run has set
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
      // subscribed before the source is asked: a reader it fails for runs
      // again once it recovers
      onReadAtom(atom);
    } else if (!started) {
      // nothing follows the source: ask it
      readSource();
      if (failure) throw failure.error;
      return Object.is(current, key);
    }
    update();
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
        // A failing owned cleanup must not leave the key table retained.
        atoms.clear();
      }
    });
  }
  return isSelected;
}
