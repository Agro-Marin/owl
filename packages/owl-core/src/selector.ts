import {
  Atom,
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
  let current: K;
  let started = false;
  let disposed = false;
  const computation = createComputation(
    () => {
      const next = source();
      if (!started) {
        started = true;
        current = next;
        return;
      }
      const previous = current;
      if (Object.is(previous, next)) {
        return;
      }
      current = next;
      untrack(() => {
        notify(previous);
        notify(next);
      });
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

  // keys read once and never again would keep their atoms: drop the
  // unobserved ones whenever the table doubled since the last sweep
  function sweep() {
    const before = atoms.size;
    for (const [key, atom] of atoms) {
      if (!hasObservers(atom)) {
        atoms.delete(key);
      }
    }
    swept = atoms.size;
    if (debug.computed) {
      debugLog(
        "computed",
        `${computation.name} swept ${before - swept} unread key(s), ${swept} kept`
      );
    }
  }

  function isSelected(key: K): boolean {
    if (disposed) {
      return Object.is(current, key);
    }
    if (computation.state !== ComputationState.EXECUTED) {
      updateComputation(computation);
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
      onReadAtom(atom);
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
