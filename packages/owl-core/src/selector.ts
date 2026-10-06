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
  removeSources,
  untrack,
  updateComputation,
} from "./computations";
import { debug, debugLog } from "./debug";
import { getScope } from "./scope";

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
  const atoms = new Map<K, Atom>();
  let swept = 0;
  // source changes since the last sweep: sweeping every as many changes as
  // there are keys finds the keys nobody reads any more, at O(1) a change
  let changes = 0;
  let current: K;
  // whether the computation follows the source: it does while a key is read
  let started = false;
  // what the source threw: every key rethrows it until the source recovers
  let failure: { error: unknown } | null = null;
  let disposed = false;
  const computation = createComputation(
    () => {
      const previous = current;
      const answered = started && !failure;
      try {
        current = source();
        failure = null;
      } catch (error) {
        if (debug.computed) {
          debugLog(
            "computed",
            `${computation.name}: its source failed, every key rethrows it`,
            error
          );
        }
        failure = { error };
      }
      if (!started) {
        started = true;
      } else if (answered !== !failure) {
        // failed or recovered: every key's answer changed
        notifyAll();
      } else if (!failure && !Object.is(previous, current)) {
        notifyKeys(previous, current);
        if (++changes >= atoms.size) {
          sweep();
        }
      }
      if (atoms.size === 0) {
        release();
      }
    },
    false,
    ComputationState.STALE,
    true,
    options.name || (debug.computed && source.name) || "selector"
  );

  function notify(key: K) {
    const atom = atoms.get(key);
    if (atom === undefined) {
      return;
    }
    onWriteAtom(atom);
    if (!hasObservers(atom)) {
      atoms.delete(key);
    }
  }

  // one batch: an immediate reader runs once, after every key is notified,
  // and one that throws does not keep the others from being notified
  function notifyKeys(previous: K, next: K) {
    untrack(() =>
      batch(() => {
        notify(previous);
        notify(next);
      })
    );
  }

  function notifyAll() {
    untrack(() => batch(() => atoms.forEach((_, key) => notify(key))));
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
    changes = 0;
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
    failure = null;
    removeSources(computation);
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
      return Object.is(current, key);
    }
    if (isObserving()) {
      let atom = atoms.get(key);
      if (atom === undefined) {
        if (atoms.size >= 2 * swept + 16) {
          sweep();
        }
        atom = createAtom(undefined, "key");
        atoms.set(key, atom);
      }
      // subscribed before the source is asked: a reader it fails for runs
      // again once it recovers
      onReadAtom(atom);
    } else if (!started) {
      // nothing follows the source: ask it
      current = source();
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
      disposeComputation(computation);
      atoms.clear();
    });
  }
  return isSelected;
}
