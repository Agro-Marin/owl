import {
  ComputationState,
  ComputationAtom,
  disposeOwned,
  getCurrentComputation,
  removeSources,
  setComputation,
  updateComputation,
  createComputation,
} from "./computations";
import { debug, debugLog } from "./debug";

export interface EffectOptions {
  /**
   * What debug logging calls it (default: the function's name if the effect
   * channel is on when it is created, else "effect").
   */
  name?: string;
}

export function effect<T>(fn: () => T, options?: EffectOptions) {
  return createEffect(fn, false, options);
}

export function immediateEffect<T>(fn: () => T, options?: EffectOptions) {
  return createEffect(fn, true, options);
}

function createEffect<T>(fn: () => T, immediate: boolean, options?: EffectOptions) {
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
          unsubscribeUntracked(computation);
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
        unsubscribeUntracked(computation);
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
    immediate,
    // fn.name costs a measurable share of an effect's creation: read only
    // while debugging
    options?.name || (debug.effect && fn.name) || (immediate ? "immediateEffect" : "effect")
  );
  // Created by an effect, it is disposed when that effect runs again or is
  // disposed. Created by a render, it is disposed with the component: a value
  // the component memoizes across renders keeps its effect. Created in a
  // computed's getter, it is owned by nothing, like a top-level effect.
  const parent = getCurrentComputation();
  if (parent && !parent.isDerived) {
    (parent.owned ??= new Set()).add(cleanupEffect);
    if (parent.isEffect) {
      computation.owner = parent;
    }
  }
  computation.isEffect = true;
  if (debug.effect) {
    debugLog(
      "effect",
      `create ${computation.name}, owned by ${parent && !parent.isDerived ? parent.name : "nothing"}`
    );
  }

  // Remove sources and unsubscribe
  function cleanupEffect() {
    if (debug.effect) {
      debugLog("effect", `dispose ${computation.name}`);
    }
    disposed = true;
    parent?.owned?.delete(cleanupEffect);
    // Mark as executed so a queued re-run (scheduled by an earlier signal
    // write in the same microtick) is skipped by updateComputation.
    computation.state = ComputationState.EXECUTED;
    // Untracked so the user cleanup function's atom reads do not attach as
    // sources of whatever computation happens to be active when dispose() is
    // called. See test "dispose called inside another effect: cleanup's atom
    // reads do not leak to outer".
    unsubscribeUntracked(computation);
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

function unsubscribeUntracked(effect: ComputationAtom) {
  const previousComputation = getCurrentComputation();
  setComputation(undefined);
  try {
    unsubscribeEffect(effect);
  } finally {
    setComputation(previousComputation);
  }
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
