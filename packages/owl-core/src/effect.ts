import {
  ComputationState,
  ComputationAtom,
  getCurrentComputation,
  removeSources,
  setComputation,
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
  const computation = createComputation(
    () => {
      // Only run the unsubscribe dance (and the surrounding setComputation
      // save/restore) when there's actually something to clean up: a stored
      // cleanup function (computation.value) or nested child effects
      // (computation.observers). For the common "leaf effect" case this is
      // both empty, and removeSources alone suffices.
      if (computation.value || computation.observers.size) {
        // Keep cleanup function and child cleanup from tracking atom reads as
        // sources of this effect.
        setComputation(undefined);
        unsubscribeEffect(computation);
        setComputation(computation);
      } else {
        removeSources(computation);
      }
      return fn();
    },
    false,
    ComputationState.STALE,
    immediate
  );
  const parent = getCurrentComputation();
  parent?.observers.add(computation);

  // Remove sources and unsubscribe
  function cleanupEffect() {
    // Mark as executed so a queued re-run (scheduled by an earlier signal
    // write in the same microtick) is skipped by updateComputation.
    computation.state = ComputationState.EXECUTED;
    // Clear currentComputation across unsubscribeEffect so the user cleanup
    // function's atom reads do not attach as sources of whatever computation
    // happens to be active when dispose() is called. See test
    // "dispose called inside another effect: cleanup's atom reads do not
    // leak to outer".
    const previousComputation = getCurrentComputation();
    setComputation(undefined);
    unsubscribeEffect(computation);
    setComputation(previousComputation);
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

function unsubscribeEffect(effect: ComputationAtom) {
  removeSources(effect);
  runCleanup(effect);
  for (const childEffect of effect.observers) {
    // Consider it executed to avoid it's re-execution. The recursive
    // unsubscribeEffect below clears the child's sources as its first step,
    // so no explicit removeSources call is needed here.
    childEffect.state = ComputationState.EXECUTED;
    unsubscribeEffect(childEffect);
  }
  effect.observers.clear();
}

function runCleanup(effect: ComputationAtom) {
  // the computation.value of an effect is a cleanup function
  const cleanupFn = effect.value;
  if (cleanupFn && typeof cleanupFn === "function") {
    cleanupFn();
    effect.value = undefined;
  }
}
