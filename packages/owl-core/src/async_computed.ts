import {
  ComputationAtom,
  ComputationState,
  Equals,
  getCurrentComputation,
  runUnowned,
  untrack,
} from "./computations";
import { debug, debugLog } from "./debug";
import { getScope, isAbortError } from "./scope";
import { adopt, effect } from "./effect";
import { signal } from "./signal";

export interface AsyncComputedContext {
  readonly abortSignal: AbortSignal;
}

export interface AsyncComputedOptions<T> {
  initial?: T;
  equals?: Equals<T | undefined>;
}

export interface AsyncComputed<T> {
  (): T | undefined;
  loading(): boolean;
  error(): Error | null;
  refresh(): void;
  dispose(): void;
  currentPromise(): Promise<void>;
}

export function asyncComputed<T>(
  fetcher: (ctx: AsyncComputedContext) => T | Promise<T>,
  options: AsyncComputedOptions<T> = {}
): AsyncComputed<T> {
  const value = signal<T | undefined>(options.initial, { equals: options.equals });
  const loading = signal(false);
  const error = signal<Error | null>(null);
  const refreshTick = signal(0);

  const scope = getScope();

  let runId = 0;
  let disposed = false;
  let refreshQueued = false;

  let inFlight = false;
  let pending: { promise: Promise<void>; resolve: () => void } | null = null;

  function settlePending() {
    if (!inFlight && !refreshQueued && runner.state === ComputationState.EXECUTED) {
      pending?.resolve();
      pending = null;
    }
  }

  function endRun() {
    inFlight = false;
    try {
      loading.set(false);
    } finally {
      if (runner.state === ComputationState.EXECUTED) {
        settlePending();
      } else if (pending) {
        Promise.resolve().then(settlePending);
      }
    }
  }

  function settle(fn: () => void) {
    let completed = false;
    try {
      fn();
      completed = true;
    } finally {
      try {
        endRun();
      } catch (error) {
        if (completed) throw error;
        Promise.reject(error);
      }
    }
  }

  function fail(e: unknown) {
    if (debug.effect) {
      debugLog("effect", `asyncComputed: run ${runId} failed`, e);
    }
    settle(() => {
      const failure = untrack(() => (isAbortError(e) ? null : toError(e)));
      if (failure) error.set(failure);
    });
  }

  let runner: ComputationAtom;
  const stopEffect = effect(() => {
    runner ??= getCurrentComputation()!;
    refreshTick();
    const myRunId = ++runId;
    const controller = new AbortController();
    if (debug.effect) {
      debugLog("effect", `asyncComputed: run ${myRunId}`);
    }
    const abort = () => {
      if (debug.effect) {
        debugLog("effect", `asyncComputed: abort run ${myRunId}`);
      }
      controller.abort();
    };

    const abortSignals = [controller.signal];
    if (scope?.abortSignal) {
      abortSignals.push(scope.abortSignal);
    }

    try {
      inFlight = true;
      loading.set(true);
      error.set(null);
    } catch (e) {
      try {
        settle(() => {
          throw e;
        });
      } finally {
        runUnowned(abort);
      }
    }

    if (disposed) {
      runUnowned(abort);
      return;
    }

    let promise: Promise<T>;
    try {
      promise = Promise.resolve(fetcher({ abortSignal: AbortSignal.any(abortSignals) }));
    } catch (e) {
      try {
        fail(e);
      } catch (error) {
        runUnowned(abort);
        throw error;
      }
      return abort;
    }

    promise.then(
      (result) => {
        if (myRunId === runId) {
          if (debug.effect) {
            debugLog("effect", `asyncComputed: run ${myRunId} resolved`);
          }
          settle(() => value.set(result));
        } else if (debug.effect) {
          debugLog("effect", `asyncComputed: result of run ${myRunId} dropped`);
        }
      },
      (e) => {
        if (myRunId === runId) {
          fail(e);
        }
      }
    );
    return abort;
  });

  function dispose() {
    if (debug.effect) {
      debugLog("effect", "asyncComputed: dispose");
    }
    runId++;
    disposed = true;
    refreshQueued = false;
    settle(() => {
      try {
        stopEffect();
      } finally {
        owner?.owned?.delete(dispose);
      }
    });
  }

  const owner = adopt(dispose);
  scope?.onDestroy(dispose);

  const read = (() => value()) as AsyncComputed<T>;
  read.loading = () => loading();
  read.error = () => error();
  read.refresh = () => {
    if (disposed) return;
    if (runner.running) {
      if (!refreshQueued) {
        refreshQueued = true;
        Promise.resolve().then(() => {
          refreshQueued = false;
          if (!disposed) refreshTick.set(untrack(refreshTick) + 1);
          settlePending();
        });
      }
    } else {
      refreshTick.set(untrack(refreshTick) + 1);
    }
  };
  read.dispose = dispose;
  read.currentPromise = () => {
    const queued = refreshQueued || runner.state !== ComputationState.EXECUTED;
    if (!inFlight && !queued) {
      return Promise.resolve();
    }
    if (!pending) {
      pending = Promise.withResolvers<void>();
      if (!inFlight) {
        Promise.resolve().then(settlePending);
      }
    }
    return pending.promise;
  };
  return read;
}

function toError(e: unknown): Error {
  try {
    if (e instanceof Error || Object.prototype.toString.call(e) === "[object Error]") {
      return e as Error;
    }
  } catch {}
  let message = "Async computed fetcher failed";
  try {
    message = String(e);
  } catch {}
  return new Error(message, { cause: e });
}
