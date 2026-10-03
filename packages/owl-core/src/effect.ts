import {
  ComputationState,
  ComputationAtom,
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

function createEffect<T>(fn: () => T, immediate: boolean) {
  let disposed = false;
  const computation = createComputation(
    () => {
      // A stored cleanup function (computation.value) or nested child effects
      // (computation.observers) are disposed before the re-run, untracked so
      // they do not become sources of this effect. updateComputation handles
      // the effect's own sources.
      let failure: { error: unknown } | null = null;
      if (computation.value || computation.observers.size) {
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
  const parent = getCurrentComputation();
  parent?.observers.add(computation);

  // Remove sources and unsubscribe
  function cleanupEffect() {
    disposed = true;
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
    parent?.observers.delete(computation);
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
  for (const childEffect of effect.observers) {
    // Consider it executed to avoid it's re-execution. The recursive
    // unsubscribeEffect below clears the child's sources as its first step,
    // so no explicit removeSources call is needed here.
    childEffect.state = ComputationState.EXECUTED;
    try {
      unsubscribeEffect(childEffect);
    } catch (error) {
      failure ||= { error };
    }
  }
  effect.observers.clear();
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
