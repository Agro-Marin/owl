import { debug, debugLog } from "./debug";
import { OwlError } from "./owl_error";
import {
  ComputationAtom,
  disposeComputation,
  hasObservers,
  runUnowned,
  scopeStack as setupStack,
} from "./computations";
import { STATUS, StatusValue } from "./status";
import type { PluginManager } from "./plugin_manager";

export const scopeStack = setupStack as Scope[];

export type ScopeMark = [willStart: number, destroyCbs: number, computations: number];
const EMPTY_SCOPE_MARK = [0, 0, 0] as const;

export interface ScopeApp {
  dev?: boolean;
  pluginManager?: PluginManager;
}

function runReversed(cbs: Array<() => void>, reportError: (e: unknown) => void): void {
  for (let i = cbs.length - 1; i >= 0; i--) {
    try {
      runUnowned(cbs[i]);
    } catch (e) {
      reportError(e);
    }
  }
}

export function useScope(): Scope {
  const scope = getScope();
  if (!scope) {
    throw new OwlError("No active scope");
  }
  return scope;
}

export abstract class Scope<TApp extends ScopeApp = ScopeApp> {
  readonly app: TApp;
  pluginManager: PluginManager;
  status: StatusValue = STATUS.NEW;
  computations: ComputationAtom[] = [];
  willStart: Array<() => any> = [];
  collectingWillStart = false;
  private _controller: AbortController | null = null;
  private _destroyCbs: Array<() => void> | null = null;
  private _finalizing = false;

  constructor(app: TApp) {
    this.app = app;
    this.pluginManager = app.pluginManager!;
  }

  run<Args extends any[], T>(fn: (...args: Args) => T, ...args: Args): T {
    if (this.status > STATUS.MOUNTED) {
      throw new OwlError("Cannot run a callback in a destroyed scope");
    }
    scopeStack.push(this);
    let result: T;
    try {
      result = fn(...args);
    } finally {
      scopeStack.pop();
    }
    if (result !== null && typeof (result as any)?.then === "function") {
      return this._guard(result as any) as T;
    }
    return result;
  }

  private async _guard<T>(p: Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await p;
    } catch (e) {
      if (this.status > STATUS.MOUNTED) {
        if (debug.scope) {
          debugLog(
            "scope",
            `${scopeName(this)}: a guarded promise failed after destroy, aborted`,
            e
          );
        }
        throw makeAbortError(e);
      }
      throw e;
    }
    if (this.status > STATUS.MOUNTED) {
      if (debug.scope) {
        debugLog("scope", `${scopeName(this)}: a guarded promise settled after destroy, aborted`);
      }
      throw makeAbortError();
    }
    return result;
  }

  get abortSignal(): AbortSignal {
    if (this._finalizing || this.status > STATUS.MOUNTED) {
      if (!this._controller) {
        this._controller = new AbortController();
        this._controller.abort();
      }
      return this._controller.signal;
    }
    return (this._controller ??= new AbortController()).signal;
  }

  isDestroyed(): boolean {
    return this.status >= STATUS.DESTROYED;
  }

  onDestroy(cb: () => void): void {
    if (this.status >= STATUS.DESTROYED) {
      runUnowned(cb);
      return;
    }
    (this._destroyCbs ??= []).push(cb);
  }

  finalize(reportError: (e: unknown) => void): void {
    if (this._finalizing || this.status >= STATUS.DESTROYED) {
      return;
    }
    this._finalizing = true;
    if (debug.scope) {
      debugLog(
        "scope",
        `${scopeName(this)}: finalize, ${this._destroyCbs?.length ?? 0} destroy callback(s), ${this.computations.length} computation(s)`
      );
    }
    try {
      if (this._controller) {
        runUnowned(() => this._controller!.abort());
      }
    } finally {
      try {
        this.release(EMPTY_SCOPE_MARK, reportError);
      } finally {
        this.status = STATUS.DESTROYED;
      }
    }
  }

  mark(): ScopeMark {
    return [this.willStart.length, this._destroyCbs?.length ?? 0, this.computations.length];
  }

  rollback(mark: ScopeMark, reportError: (e: unknown) => void): void {
    if (debug.scope) {
      debugLog(
        "scope",
        `${scopeName(this)}: rollback to ${mark[0]} willStart, ${mark[1]} destroy callback(s), ${mark[2]} computation(s)`
      );
    }
    this.release(mark, reportError);
  }

  private release(mark: Readonly<ScopeMark>, reportError: (e: unknown) => void): void {
    this.willStart.length = mark[0];
    if ((this._destroyCbs?.length ?? 0) <= mark[1] && this.computations.length <= mark[2]) {
      return;
    }
    let failed = false;
    let failure: unknown;
    const report = (error: unknown) => {
      try {
        runUnowned(reportError, error);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    };
    do {
      while (this._destroyCbs && this._destroyCbs.length > mark[1]) {
        let callbacks = this._destroyCbs;
        if (mark[1]) {
          callbacks = callbacks.splice(mark[1]);
        } else {
          this._destroyCbs = null;
        }
        runReversed(callbacks, report);
      }
      if (this.computations.length > mark[2]) {
        disposeUnobserved(this.computations.splice(mark[2]), report);
      }
    } while ((this._destroyCbs?.length ?? 0) > mark[1] || this.computations.length > mark[2]);
    this.willStart.length = mark[0];
    if (failed) {
      throw failure;
    }
  }

  decorate(fn: Function, _hookName: string): Function {
    return fn.bind(undefined, this);
  }
}

function disposeUnobserved(
  computations: ComputationAtom[],
  reportError: (e: unknown) => void
): void {
  for (const computation of computations) {
    if (!hasObservers(computation)) {
      try {
        disposeComputation(computation);
      } catch (error) {
        reportError(error);
      }
    }
  }
}

export function getScope(): Scope | null {
  const len = scopeStack.length;
  return len ? scopeStack[len - 1] : null;
}

export function isAbortError(e: unknown): boolean {
  try {
    return typeof e === "object" && e !== null && (e as { name?: string }).name === "AbortError";
  } catch {
    return false;
  }
}

export function makeAbortError(cause?: unknown): Error {
  const err = new Error("The operation was aborted", cause === undefined ? undefined : { cause });
  err.name = "AbortError";
  return err;
}

function scopeName(scope: Scope): string {
  return (scope as any).componentName ?? scope.constructor.name;
}
