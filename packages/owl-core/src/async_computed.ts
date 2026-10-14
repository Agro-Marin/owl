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
  /**
   * Custom equality for the resolved value (see Equals): a fetch resolving to
   * an equal value does not notify observers. Note that the previous value is
   * `undefined` before the first resolution when no `initial` is given.
   */
  equals?: Equals<T | undefined>;
}

export interface AsyncComputed<T> {
  (): T | undefined;
  loading(): boolean;
  error(): Error | null;
  refresh(): void;
  dispose(): void;
  /**
   * Returns a promise that resolves as soon as no run is in flight: if a run
   * is currently running it resolves once that run (or any run that supersedes
   * it) settles, otherwise it resolves immediately. It never rejects — fetcher
   * errors are surfaced through `error()`. Handy to await the value in
   * `onWillStart`: `onWillStart(() => data.currentPromise())`.
   */
  currentPromise(): Promise<void>;
}

/**
 * @experimental The exact API is subject to change in future versions.
 */
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

  // Whether a run is currently in flight. Mirrors `loading`, but as a plain
  // (non-reactive) flag: `currentPromise()` can read it without registering a
  // dependency. Settlement clears it before notifying loading observers,
  // which may throw, request another promise or queue a refresh.
  let inFlight = false;
  // Deferred handed out by `currentPromise()`, created lazily — only when a
  // caller actually asks for it while a run is in flight. Resolved when the run
  // settles; a re-run that supersedes an in-flight run keeps the same deferred,
  // so it resolves only once the latest run is no longer in flight. It never
  // rejects: errors are surfaced through `error()`.
  let pending: { promise: Promise<void>; resolve: () => void } | null = null;

  // Settles the current run. Must not read a signal — it also runs on the
  // synchronous path of the effect (the fetcher throwing), where a read would
  // register as a spurious dependency.
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
      // Value/error/loading observers may have queued a superseding run.
      // Retain its waiters until that run settles, or its queued dependency
      // check finds no work. A throwing observer must still release waiters.
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
        // Keep the original failure and report a separate settlement failure,
        // as batch() does when notification also fails during a failed write.
        Promise.reject(error);
      }
    }
  }

  function fail(e: unknown) {
    if (debug.effect) {
      debugLog("effect", `asyncComputed: run ${runId} failed`, e);
    }
    settle(() => {
      // Inspection is not a dependency of the fetcher. Preserve ownership,
      // though: effects a conversion hook creates still need its cleanup.
      const failure = untrack(() => (isAbortError(e) ? null : toError(e)));
      if (failure) error.set(failure);
    });
  }

  // the effect's computation: while a re-run of it is queued (a dependency
  // changed, refresh() was called), a run is about to start
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
      // Startup notifications can throw before the fetcher runs. No returned
      // cleanup will be retained by the effect, so abort and settle here.
      try {
        settle(() => {
          throw e;
        });
      } finally {
        runUnowned(abort);
      }
    }

    if (disposed) {
      // A startup observer may have disposed this effect before fetching.
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
        // Reporting can itself throw through an immediate error/loading
        // observer. The effect cannot keep our returned cleanup in that case.
        runUnowned(abort);
        throw error;
      }
      // A fetcher may have started work with its signal before it threw.
      // Keep the cleanup so disposal or a re-run still aborts that work.
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
    // superseded by the next run, or disposed
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

  // The effect, computed or render whose run creates it owns its effect (and
  // runs first when both are due), and disposes it whole: not loading any
  // more, and deaf to the abandoned run's result.
  const owner = adopt(dispose);
  scope?.onDestroy(dispose);

  const read = (() => value()) as AsyncComputed<T>;
  read.loading = () => loading();
  read.error = () => error();
  read.refresh = () => {
    if (disposed) return;
    if (runner.running) {
      // Effects deliberately do not requeue themselves for writes during
      // their own run. An explicit refresh requested by a synchronous error
      // or loading observer still needs to happen after this run returns.
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
        // The queued re-run comes in the effect flush, a microtask scheduled
        // before this one: after it, the run is in flight (and settles the
        // promise when it ends), or the check found nothing to fetch again.
        Promise.resolve().then(settlePending);
      }
    }
    return pending.promise;
  };
  return read;
}

// error() is typed Error: a thrown non-Error (a string, a plain object) is
// wrapped, and kept as its cause
function toError(e: unknown): Error {
  try {
    if (e instanceof Error || Object.prototype.toString.call(e) === "[object Error]") {
      return e as Error;
    }
  } catch {
    // Proxy traps and Symbol.toStringTag accessors may prevent inspection.
  }
  let message = "Async computed fetcher failed";
  try {
    message = String(e);
  } catch {
    // Null-prototype objects and throwing conversion hooks still have to be
    // surfaced through error(), with the original rejection as their cause.
  }
  return new Error(message, { cause: e });
}
