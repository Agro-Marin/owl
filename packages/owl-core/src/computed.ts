import {
  atomSymbol,
  ComputationState,
  Equals,
  onReadAtom,
  onWriteAtom,
  ReactiveValue,
  toEqualsFn,
  updateComputation,
  createComputation,
} from "./computations";
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
}

function readonlySetter(): never {
  throw new OwlError(
    "Cannot write to a read-only computed value. Pass a `set` option to make it writable."
  );
}

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
    let newValue: TRead;
    try {
      newValue = getter();
    } catch (error) {
      if (hasValue) {
        onWriteAtom(computation);
      }
      hasValue = true;
      failure = { error };
      return undefined;
    }
    if (hasValue) {
      if (!failure && equalsFn(computation.value, newValue)) {
        // discard the equal result: readers keep a stable identity, like a
        // signal write that compares equal
        return computation.value;
      }
      onWriteAtom(computation);
    }
    hasValue = true;
    failure = null;
    return newValue;
  }, true);

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
    getScope()?.computations.push(computation);
  }

  return readComputed;
}
