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
  name?: string;
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
      let failure: { error: unknown } | null = null;
      if (computation.value || computation.owned) {
        try {
          runUnowned(release, computation);
        } catch (error) {
          failure = { error };
        }
      }
      if (disposed) {
        if (debug.effect) {
          debugLog("effect", `${computation.name} disposed by its own cleanup, not run again`);
        }
        if (failure) {
          throw failure.error;
        }
        return undefined;
      }
      let result;
      try {
        result = fn();
      } catch (error) {
        if (disposed) {
          detach(computation, false);
        }
        throw error;
      }
      const cleanup = typeof result === "function" ? result : undefined;
      if (disposed) {
        computation.value = cleanup;
        detach(computation, true);
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
    options?.name || (debug.effect && fn.name) || (immediate ? "immediateEffect" : "effect")
  );
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

  function cleanupEffect() {
    if (debug.effect) {
      debugLog("effect", `dispose ${computation.name}`);
    }
    disposed = true;
    if (owner !== undefined) {
      owner.owned?.delete(cleanupEffect);
      computation.owner = null;
    }
    computation.state = ComputationState.EXECUTED;
    removeSources(computation);
    if (computation.value || computation.owned) {
      runUnowned(release, computation);
    }
  }

  try {
    updateComputation(computation);
  } catch (error) {
    cleanupEffect();
    throw error;
  }
  return cleanupEffect;
}

export function adopt(dispose: () => void): ComputationAtom | undefined {
  const owner = getOwner();
  if (owner !== undefined) {
    (owner.owned ??= new Set()).add(dispose);
  }
  return owner;
}

function detach(effect: ComputationAtom, throwFirst: boolean) {
  let errors: unknown[] | null = null;
  try {
    removeSources(effect);
  } catch (error) {
    (errors ||= []).push(error);
  }
  try {
    runUnowned(release, effect);
  } catch (error) {
    (errors ||= []).push(error);
  }
  if (errors) {
    for (let i = throwFirst ? 1 : 0; i < errors.length; i++) {
      Promise.reject(errors[i]);
    }
    if (throwFirst) {
      throw errors[0];
    }
  }
}

function release(effect: ComputationAtom) {
  let failure: { error: unknown } | null = null;
  try {
    disposeOwned(effect);
  } catch (error) {
    failure = { error };
  }
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
