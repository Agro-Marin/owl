import {
  ComputationState,
  ComputationAtom,
  disposeOwned,
  getCurrentComputation,
  removeSources,
  untrack,
  updateComputation,
  createComputation,
} from "./computations";

export function effect<T>(fn: () => T) {
  return createEffect(fn, false);
}

export function immediateEffect<T>(fn: () => T) {
  return createEffect(fn, true);
}

const effects = new WeakSet<ComputationAtom>();

function createEffect<T>(fn: () => T, immediate: boolean) {
  let disposed = false;
  const computation = createComputation(
    () => {
      // A stored cleanup function (computation.value) or nested child effects
      // (computation.owned) are disposed before the re-run, untracked so
      // they do not become sources of this effect. updateComputation handles
      // the effect's own sources.
      let failure: { error: unknown } | null = null;
      if (computation.value || computation.owned) {
        try {
          untrack(() => unsubscribeEffect(computation));
        } catch (error) {
          // the run still happens: skipping it would leave the effect
          // subscribed to nothing, dead for good
          failure = { error };
        }
      }
      const result = fn();
      if (disposed) {
        // disposed by its own run: what it read, created or returned after
        // the dispose is released too
        computation.value = result;
        untrack(() => unsubscribeEffect(computation));
        return undefined;
      }
      if (failure) {
        computation.value = result;
        throw failure.error;
      }
      return result;
    },
    false,
    ComputationState.STALE,
    immediate
  );
  // Owned by the computation it is created in, whatever its kind (an effect,
  // a computed's getter, a render): disposed when that one runs again or is
  // disposed. A computed or a render runs any number of times, so an effect
  // they create must not outlive the run that created it.
  const parent = getCurrentComputation();
  if (parent) {
    (parent.owned ??= new Set()).add(cleanupEffect);
    if (effects.has(parent)) {
      computation.owner = parent;
    }
  }
  effects.add(computation);

  // Remove sources and unsubscribe
  function cleanupEffect() {
    disposed = true;
    parent?.owned?.delete(cleanupEffect);
    // Mark as executed so a queued re-run (scheduled by an earlier signal
    // write in the same microtick) is skipped by updateComputation.
    computation.state = ComputationState.EXECUTED;
    // Untracked so the user cleanup function's atom reads do not attach as
    // sources of whatever computation happens to be active when dispose() is
    // called. See test "dispose called inside another effect: cleanup's atom
    // reads do not leak to outer".
    untrack(() => unsubscribeEffect(computation));
  }

  try {
    updateComputation(computation);
  } catch (error) {
    // the caller gets no cleanup function to dispose it with
    cleanupEffect();
    throw error;
  }
  return cleanupEffect;
}

// Releases everything even when a cleanup throws, then rethrows the first
// error: a cleanup that throws must not keep the effect's children alive.
function unsubscribeEffect(effect: ComputationAtom) {
  removeSources(effect);
  let failure: { error: unknown } | null = null;
  try {
    runCleanup(effect);
  } catch (error) {
    failure = { error };
  }
  try {
    disposeOwned(effect);
  } catch (error) {
    failure ||= { error };
  }
  if (failure) {
    throw failure.error;
  }
}

function runCleanup(effect: ComputationAtom) {
  // the computation.value of an effect is a cleanup function, called once
  const cleanupFn = effect.value;
  effect.value = undefined;
  if (typeof cleanupFn === "function") {
    cleanupFn();
  }
}
