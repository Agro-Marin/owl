import {
  atomSymbol,
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
  equals?: Equals<TRead>;
  detached?: boolean;
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
  let hasValue = false;
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
        return computation.value;
      }
    } catch (error) {
      if (debug.computed) {
        debugLog("computed", `${computation.name} failed`, error);
      }
      newFailure = { error };
      newValue = undefined;
    }
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
    }
  }

  return readComputed;
}
