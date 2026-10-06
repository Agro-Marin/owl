import {
  ComputationState,
  ComputationAtom,
  disposeOwned,
  getOwner,
  removeSources,
  runUnowned,
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
  /**
   * Owned by nothing: it outlives the effect, computed or render whose run
   * creates it, and must be disposed by whoever created it.
   */
  detached?: boolean;
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
      // they do not become sources of this effect. runTracked handles the
      // effect's own sources: those it reads again keep their subscription.
      let failure: { error: unknown } | null = null;
      if (computation.value || computation.owned) {
        try {
          runUnowned(release, computation);
        } catch (error) {
          // the run still happens: skipping it would leave the effect
          // subscribed to nothing, dead for good
          failure = { error };
        }
      }
      if (disposed) {
        // disposed by its own cleanup: it does not run again
        if (debug.effect) {
          debugLog("effect", `${computation.name} disposed by its own cleanup, not run again`);
        }
        if (failure) {
          throw failure.error;
        }
        return undefined;
      }
      const result = fn();
      // only a cleanup function is kept: any other value would be retained
      // until the next run for nothing
      const cleanup = typeof result === "function" ? result : undefined;
      if (disposed) {
        // disposed by its own run: what it read, created or returned after
        // the dispose is released too
        computation.value = cleanup;
        removeSources(computation);
        runUnowned(release, computation);
        return undefined;
      }
      if (failure) {
        computation.value = cleanup;
        throw failure.error;
      }
      return cleanup;
    },
    false,
    ComputationState.STALE,
    immediate,
    // fn.name costs a measurable share of an effect's creation: read only
    // while debugging
    options?.name || (debug.effect && fn.name) || (immediate ? "immediateEffect" : "effect")
  );
  // Created during the run of an effect or a computed's getter (untracked
  // included), it is disposed when that computation runs again or is disposed.
  // Created by a render, it is disposed with the component: a value the
  // component memoizes across renders keeps its effect.
  const owner = options?.detached ? undefined : adopt(cleanupEffect);
  if (owner !== undefined && !owner.tracksElsewhere) {
    computation.owner = owner;
  }
  computation.isEffect = true;
  if (debug.effect) {
    debugLog(
      "effect",
      `create ${computation.name}, owned by ${owner ? owner.name || "a computation" : "nothing"}`
    );
  }

  // Remove sources and unsubscribe
  function cleanupEffect() {
    if (debug.effect) {
      debugLog("effect", `dispose ${computation.name}`);
    }
    disposed = true;
    if (owner !== undefined) {
      owner.owned?.delete(cleanupEffect);
      computation.owner = null;
    }
    // Mark as executed so a queued re-run (scheduled by an earlier signal
    // write in the same microtick) is skipped by updateComputation.
    computation.state = ComputationState.EXECUTED;
    removeSources(computation);
    // Untracked so the user cleanup function's atom reads do not attach as
    // sources of whatever computation happens to be active when dispose() is
    // called. See test "dispose called inside another effect: cleanup's atom
    // reads do not leak to outer".
    if (computation.value || computation.owned) {
      runUnowned(release, computation);
    }
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

/**
 * Registers `dispose` with the computation an effect created now belongs to
 * (see getOwner), which calls it when it runs again or is disposed. Returns
 * that computation, if any.
 */
export function adopt(dispose: () => void): ComputationAtom | undefined {
  const owner = getOwner();
  if (owner !== undefined) {
    (owner.owned ??= new Set()).add(dispose);
  }
  return owner;
}

// Runs the cleanup function and disposes the child effects of `effect` (with
// nothing tracking their reads or owning what they create: run through
// runUnowned). Releases everything even when a cleanup throws, then rethrows
// the first error: a cleanup that throws must not keep the effect's children alive.
// The children go first: created by this effect's run, they may use what its
// own cleanup tears down.
function release(effect: ComputationAtom) {
  let failure: { error: unknown } | null = null;
  try {
    disposeOwned(effect);
  } catch (error) {
    failure = { error };
  }
  // the computation.value of an effect is its cleanup function, called once
  const cleanup = effect.value;
  effect.value = undefined;
  try {
    cleanup?.();
  } catch (error) {
    failure ||= { error };
  }
  if (failure) {
    throw failure.error;
  }
}
