import {
  atomSymbol,
  computationScopes,
  ComputationState,
  Equals,
  onReadAtom,
  onWriteAtom,
  ReactiveValue,
  ReadonlyReactiveValue,
  toEqualsFn,
  updateComputation,
  createComputation,
} from "./computations";
import { debug, debugLog } from "./debug";
import { OwlError } from "./owl_error";
import { getScope } from "./scope";

interface ComputedOptions<TRead, TWrite = TRead> {
  set?(value: TWrite): void;
  /**
   * Custom equality used after a recompute to decide whether observers should
   * be notified (see Equals). Useful when the getter builds a fresh object
   * each time (e.g. a filtered array): with a structural equality such as
   * `shallowEqual`, an equal result stops the propagation.
   */
  equals?: Equals<TRead>;
  /**
   * Keep the computed alive past the scope it is created in: a value owned by
   * a data object (not by a component) must not be disposed with the
   * component that happened to create that object.
   */
  detached?: boolean;
  /**
   * What debug logging calls it (default: the getter's name if the computed
   * channel is on when it is created, else "computed").
   */
  name?: string;
}

function readonlySetter(): never {
  throw new OwlError(
    "Cannot write to a read-only computed value. Pass a `set` option to make it writable."
  );
}

export function computed<TRead, TWrite = TRead>(
  getter: () => TRead,
  options: ComputedOptions<TRead, TWrite> & { set(value: TWrite): void }
): ReactiveValue<TRead, TWrite>;
export function computed<TRead>(
  getter: () => TRead,
  options?: ComputedOptions<TRead>
): ReadonlyReactiveValue<TRead>;
export function computed<TRead, TWrite = TRead>(
  getter: () => TRead,
  options: ComputedOptions<TRead, TWrite> = {}
): ReactiveValue<TRead, TWrite> {
  const equalsFn = toEqualsFn(options.equals);
  // The first compute has no previous value to compare against (and nothing
  // observes the computation until the first read returns): skip the equality
  // check so a custom equals never receives the initial undefined.
  let hasValue = false;
  // A throwing getter is a result like any other: kept until a source changes,
  // rethrown to every reader, and subscribed to, so that a reader that caught
  // it runs again once the getter recovers.
  let failure: { error: unknown } | null = null;
  const computation = createComputation(() => {
    let newValue: TRead | undefined;
    let newFailure: { error: unknown } | null = null;
    try {
      newValue = getter();
      if (hasValue && !failure && equalsFn(computation.value, newValue)) {
        if (debug.computed) {
          debugLog("computed", `${computation.name} recomputed an equal value, readers kept`);
        }
        // discard the equal result: readers keep a stable identity, like a
        // signal write that compares equal
        return computation.value;
      }
    } catch (error) {
      if (debug.computed) {
        debugLog("computed", `${computation.name} failed, the error is its value`, error);
      }
      newFailure = { error };
      newValue = undefined;
    }
    // the result is in place before the readers hear of it: an immediate one
    // reads it during the notification
    const notify = hasValue;
    hasValue = true;
    failure = newFailure;
    computation.value = newValue;
    if (notify) {
      onWriteAtom(computation);
    }
    return newValue;
  }, true);
  computation.name = options.name || (debug.computed && getter.name) || "computed";

  function readComputed() {
    if (computation.state !== ComputationState.EXECUTED) {
      updateComputation(computation);
    }
    onReadAtom(computation);
    if (failure) {
      throw failure.error;
    }
    return computation.value;
  }
  readComputed[atomSymbol] = computation;
  readComputed.set = options.set ?? readonlySetter;

  if (!options.detached) {
    const scope = getScope();
    if (scope) {
      scope.computations.push(computation);
      computationScopes.set(computation, scope);
    }
  }

  return readComputed;
}
