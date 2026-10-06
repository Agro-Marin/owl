import {
  ComputationAtom,
  ComputationState,
  Equals,
  getCurrentComputation,
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

  // Whether a run is currently in flight. Mirrors `loading`, but as a plain
  // (non-reactive) flag: `currentPromise()` can read it without registering a
  // dependency, and `dispose()` can mark the run abandoned without writing to
  // the reactive `loading` signal.
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
  function endRun() {
    loading.set(false);
    inFlight = false;
    pending?.resolve();
    pending = null;
  }

  function fail(e: unknown) {
    if (!isAbortError(e)) {
      error.set(toError(e));
    }
    endRun();
  }

  // the effect's computation: while a re-run of it is queued (a dependency
  // changed, refresh() was called), a run is about to start
  let runner: ComputationAtom;
  const stopEffect = effect(() => {
    runner ??= getCurrentComputation()!;
    refreshTick();
    const myRunId = ++runId;
    const controller = new AbortController();

    const abortSignals = [controller.signal];
    if (scope?.abortSignal) {
      abortSignals.push(scope.abortSignal);
    }

    loading.set(true);
    inFlight = true;
    error.set(null);

    let promise: Promise<T>;
    try {
      promise = Promise.resolve(fetcher({ abortSignal: AbortSignal.any(abortSignals) }));
    } catch (e) {
      fail(e);
      return;
    }

    promise.then(
      (result) => {
        if (myRunId === runId) {
          value.set(result);
          endRun();
        }
      },
      (e) => {
        if (myRunId === runId) {
          fail(e);
        }
      }
    );
    // superseded by the next run, or disposed
    return () => controller.abort();
  });

  function dispose() {
    if (debug.effect) {
      debugLog("effect", "asyncComputed: dispose");
    }
    runId++;
    stopEffect();
    owner?.owned?.delete(dispose);
    // the abandoned run is no longer in flight, nor loading; any awaiter is
    // released
    endRun();
  }

  // The effect, computed or render whose run creates it owns its effect (and
  // runs first when both are due), and disposes it whole: not loading any
  // more, and deaf to the abandoned run's result.
  const owner = adopt(dispose);
  scope?.onDestroy(dispose);

  const read = (() => value()) as AsyncComputed<T>;
  read.loading = () => loading();
  read.error = () => error();
  read.refresh = () => refreshTick.set(untrack(refreshTick) + 1);
  read.dispose = dispose;
  read.currentPromise = () => {
    const queued = runner.state !== ComputationState.EXECUTED;
    if (!inFlight && !queued) {
      return Promise.resolve();
    }
    if (!pending) {
      let resolve!: () => void;
      pending = { promise: new Promise<void>((res) => (resolve = res)), resolve };
      if (!inFlight) {
        // The queued re-run comes in the effect flush, a microtask scheduled
        // before this one: after it, the run is in flight (and settles the
        // promise when it ends), or the check found nothing to fetch again.
        Promise.resolve().then(() => {
          if (!inFlight) {
            if (debug.effect) {
              debugLog("effect", "asyncComputed: the queued re-run fetched nothing, settled");
            }
            pending?.resolve();
            pending = null;
          }
        });
      }
    }
    return pending.promise;
  };
  return read;
}

// error() is typed Error: a thrown non-Error (a string, a plain object) is
// wrapped, and kept as its cause
function toError(e: unknown): Error {
  return e instanceof Error || Object.prototype.toString.call(e) === "[object Error]"
    ? (e as Error)
    : new Error(String(e), { cause: e });
}
