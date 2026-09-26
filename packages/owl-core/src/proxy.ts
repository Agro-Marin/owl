import { OwlError } from "./owl_error";
import {
  onReadAtom,
  onWriteAtom,
  Atom,
  ComputationState,
  createComputation,
  untrack,
  withObserver,
} from "./computations";

// Special key to subscribe to, to be notified of key creation/deletion
const KEYCHANGES = Symbol("Key changes");

// The following types only exist to signify places where objects are expected
// to be proxy or not, they provide no type checking benefit over "object"
type Target = object;
type Reactive<T extends Target> = T;

type Collection = Set<any> | Map<any, any> | WeakMap<any, any>;
type CollectionRawType = "Set" | "Map" | "WeakMap";

const objectToString = Object.prototype.toString;
const objectHasOwnProperty = Object.prototype.hasOwnProperty;

/**
 * Checks whether a given value can be made into a proxy object.
 *
 * @param value the value to check
 * @returns whether the value can be made proxy
 */
function canBeMadeReactive(value: any): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const raw = toRaw(value);
  if (Array.isArray(raw) || raw instanceof Set || raw instanceof Map || raw instanceof WeakMap) {
    return true;
  }
  return objectToString.call(raw) === "[object Object]";
}
/**
 * Creates a proxy from the given object/callback if possible and returns it,
 * returns the original object otherwise.
 *
 * @param value the value make proxy
 * @returns a proxy for the given object when possible, the original otherwise
 */
function possiblyReactive(val: any, atom: Atom | null) {
  return !atom && canBeMadeReactive(val) ? proxy(val) : val;
}

const skipped = new WeakSet<Target>();
/**
 * Mark an object or array so that it is ignored by the reactivity system
 *
 * @param value the value to mark
 * @returns the object itself
 */
export function markRaw<T extends Target>(value: T): T {
  skipped.add(value);
  return value;
}

/**
 * Given a proxy objet, return the raw (non proxy) underlying object
 *
 * @param value a proxy value
 * @returns the underlying value
 */
export function toRaw<T extends Target, U extends Reactive<T>>(value: U | T): T {
  return targets.has(value) ? (targets.get(value) as T) : value;
}

const targetToKeysToAtomItem = new WeakMap<Target, Map<PropertyKey, Atom>>();

function getTargetKeyAtom(target: Target, key: PropertyKey): Atom {
  let keyToAtomItem: Map<PropertyKey, Atom> = targetToKeysToAtomItem.get(target)!;
  if (!keyToAtomItem) {
    keyToAtomItem = new Map();
    targetToKeysToAtomItem.set(target, keyToAtomItem);
  }
  let atom = keyToAtomItem.get(key)!;
  if (!atom) {
    atom = {
      value: undefined,
      observers: new Set(),
    };
    keyToAtomItem.set(key, atom);
  }
  return atom;
}

/**
 * Observes a given key on a target with an callback. The callback will be
 * called when the given key changes on the target.
 *
 * @param target the target whose key should be observed
 * @param key the key to observe (or Symbol(KEYCHANGES) for key creation
 *  or deletion)
 */
function onReadTargetKey(target: Target, key: PropertyKey): void {
  onReadAtom(getTargetKeyAtom(target, key));
}

/**
 * Notify Reactives that are observing a given target that a key has changed on
 * the target.
 *
 * @param target target whose Reactives should be notified that the target was
 *  changed.
 * @param key the key that changed (or Symbol `KEYCHANGES` if a key was created
 *   or deleted)
 */
function onWriteTargetKey(target: Target, key: PropertyKey): void {
  const keyToAtomItem = targetToKeysToAtomItem.get(target)!;
  if (!keyToAtomItem) {
    return;
  }
  if (!keyToAtomItem.has(key)) {
    return;
  }
  onWriteAtom(keyToAtomItem.get(key)!);
}

/**
 * Notify Reactives that are observing the indices an array dropped when its
 * length was written: such a write does not go through the deleteProperty trap.
 *
 * @param target the array whose length was written
 * @param newLength the length after the write
 */
function onWriteDroppedIndices(target: Target, newLength: number): void {
  const keyToAtomItem = targetToKeysToAtomItem.get(target)!;
  if (!keyToAtomItem) {
    return;
  }
  const droppedKeys = [...keyToAtomItem.keys()].filter(
    (key) => typeof key === "string" && Number(key) >= newLength && String(Number(key)) === key
  );
  for (const key of droppedKeys) {
    onWriteTargetKey(target, key);
  }
}

// Maps proxy objects to the underlying target
const targets = new WeakMap<Reactive<Target>, Target>();
const proxyCache = new WeakMap<Target, Reactive<Target>>();

export function proxifyTarget<T extends Target>(target: T, atom: Atom | null): T {
  if (!canBeMadeReactive(target)) {
    throw new OwlError(`Cannot make the given value reactive`);
  }
  if (skipped.has(target)) {
    return target;
  }
  if (targets.has(target)) {
    // target is reactive, create a reactive on the underlying object instead
    return target;
  }
  const reactive = proxyCache.get(target)!;
  if (reactive) {
    return reactive as T;
  }

  let handler: ProxyHandler<any>;
  if (target instanceof Map) {
    handler = collectionsProxyHandler(target as unknown as Collection, "Map", atom);
  } else if (target instanceof Set) {
    handler = collectionsProxyHandler(target as unknown as Collection, "Set", atom);
  } else if (target instanceof WeakMap) {
    handler = collectionsProxyHandler(target as unknown as Collection, "WeakMap", atom);
  } else {
    handler = basicProxyHandler<T>(atom);
  }
  const proxy = new Proxy(target, handler as ProxyHandler<T>) as Reactive<T>;

  proxyCache.set(target, proxy);
  targets.set(proxy, target);

  return proxy;
}

/**
 * Wraps an object so it behaves like a signal, but with the familiar
 * property-access API: instead of `count()` / `count.set(n)`, you write
 * `state.count` and `state.count = n`. Reading and writing the proxy
 * transparently looks and feels like reading and writing the original object.
 *
 * Reactivity is nested: reading a property that holds another object/array
 * returns a proxy for that value too, recursively. Arrays, Maps, Sets, and
 * WeakMaps are also wrapped, so `state.items.push(x)` or `state.map.set(k, v)`
 * notify subscribers the same way property writes do.
 *
 * Subscriptions are only created when a read happens *while a computation is
 * active* — i.e. inside a component's render, or inside an `effect`,
 * `computed`, or `asyncComputed`. Reading the proxy from a plain function
 * with no surrounding computation just returns the value without subscribing
 * anything.
 *
 * @param target the object to make reactive
 * @returns a proxy that tracks reads/writes against `target`
 */
export function proxy<T extends Target>(target: T): T {
  return proxifyTarget(target, null);
}

/**
 * Returns a view of `target` that calls `callback` the first time a value read
 * through the view changes, synchronously, as OWL 2's `reactive(target,
 * callback)` did. The subscription is one-shot: once `callback` ran, only the
 * values read through the view again are observed. Objects read through the
 * view are views too, with the same callback; reads keep subscribing the
 * computation they happen in (a render, an effect) as a plain proxy read does.
 *
 * @param target the object to observe
 * @param callback called when an observed value changes
 * @returns a view of the proxy of `target`
 */
// the proxy each observe() view reads through, so that a view of a view
// observes the same target instead of stacking observers
const viewBases = new WeakMap<object, any>();

export function observe<T extends Target>(target: T, callback: () => void): T {
  const computation = createComputation(
    () => untrack(callback),
    false,
    ComputationState.EXECUTED,
    true
  );
  const views = new WeakMap<Target, any>();
  const read = <R>(fn: () => R): R => withObserver(computation, fn);
  const wrap = (value: any): any =>
    typeof value === "object" && value !== null && targets.has(value) ? view(value) : value;
  function view(target: any): any {
    const reactive = viewBases.get(target) ?? target;
    let result = views.get(reactive);
    if (result) {
      return result;
    }
    const raw = toRaw(reactive);
    const isCollection = raw instanceof Map || raw instanceof Set || raw instanceof WeakMap;
    result = new Proxy(reactive, {
      get(r, key, receiver) {
        // the view is the receiver: a getter, or a target that is itself a
        // proxy, reads through it and so subscribes the callback
        const value = read(() => Reflect.get(r, key, receiver));
        if (isCollection && typeof value === "function") {
          return (...args: any[]) => {
            const result = read(() => value.apply(r, args));
            return isIterator(result) ? observedIterator(result) : wrap(result);
          };
        }
        return wrap(value);
      },
      has(r, key) {
        return read(() => Reflect.has(r, key));
      },
      ownKeys(r) {
        return read(() => Reflect.ownKeys(r));
      },
      getOwnPropertyDescriptor(r, key) {
        return read(() => Reflect.getOwnPropertyDescriptor(r, key));
      },
      set(r, key, value) {
        return Reflect.set(r, key, value, r);
      },
      deleteProperty(r, key) {
        return Reflect.deleteProperty(r, key);
      },
    });
    views.set(reactive, result);
    viewBases.set(result, reactive);
    targets.set(result, raw);
    return result;
  }
  // a collection's iterator reads its entries as it advances: each step is
  // read through the view, not only the call that created the iterator
  function observedIterator(iterator: Iterator<any>): IterableIterator<any> {
    return {
      next() {
        const step = read(() => iterator.next());
        if (step.done) {
          return step;
        }
        const value = Array.isArray(step.value) ? step.value.map(wrap) : wrap(step.value);
        return { done: false, value };
      },
      [Symbol.iterator]() {
        return this;
      },
    };
  }
  return view(proxy(target));
}

function isIterator(value: any): value is Iterator<any> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof value.next === "function" &&
    typeof value[Symbol.iterator] === "function"
  );
}

/**
 * Creates a basic proxy handler for regular objects and arrays.
 *
 * @param callback @see proxy
 * @returns a proxy handler object
 */
function basicProxyHandler<T extends Target>(atom: Atom | null): ProxyHandler<T> {
  return {
    get(target, key, receiver) {
      onReadTargetKey(target, key);
      const value = Reflect.get(target, key, receiver);
      // Fast path: signal-based proxies and primitive values don't need wrapping
      if (atom || typeof value !== "object" || value === null) {
        return value;
      }
      if (!canBeMadeReactive(value)) {
        return value;
      }
      // non-writable non-configurable properties cannot be made proxy
      const desc = Object.getOwnPropertyDescriptor(target, key);
      if (desc && !desc.writable && !desc.configurable) {
        return value;
      }
      return proxifyTarget(value, null);
    },
    set(target, key, value, receiver) {
      const hadKey = objectHasOwnProperty.call(target, key);
      const originalValue = Reflect.get(target, key, receiver);
      const ret = Reflect.set(target, key, toRaw(value), receiver);
      const keyCreated = !hadKey && objectHasOwnProperty.call(target, key);
      const valueChanged = originalValue !== Reflect.get(target, key, receiver);
      if (keyCreated) {
        onWriteTargetKey(target, KEYCHANGES);
      }
      if (key === "length" && Array.isArray(target)) {
        // While Array length may trigger the set trap, it's not actually set by this
        // method but is updated behind the scenes, and the trap is not called with the
        // new value. We disable the "same-value-optimization" for it because of that.
        onWriteTargetKey(target, key);
        if (target.length < (originalValue as number)) {
          onWriteTargetKey(target, KEYCHANGES);
          onWriteDroppedIndices(target, target.length);
        }
      } else if (valueChanged) {
        onWriteTargetKey(target, key);
      }
      return ret;
    },
    deleteProperty(target, key) {
      const ret = Reflect.deleteProperty(target, key);
      // TODO: only notify when something was actually deleted
      onWriteTargetKey(target, KEYCHANGES);
      onWriteTargetKey(target, key);
      return ret;
    },
    ownKeys(target) {
      onReadTargetKey(target, KEYCHANGES);
      return Reflect.ownKeys(target);
    },
    has(target, key) {
      // TODO: this observes all key changes instead of only the presence of the argument key
      // observing the key itself would observe value changes instead of presence changes
      // so we may need a finer grained system to distinguish observing value vs presence.
      onReadTargetKey(target, KEYCHANGES);
      return Reflect.has(target, key);
    },
  } as ProxyHandler<T>;
}
/**
 * Creates a function that will observe the key that is passed to it when called
 * and delegates to the underlying method.
 *
 * @param methodName name of the method to delegate to
 * @param target @see proxy
 * @param callback @see proxy
 */
function makeKeyObserver(methodName: "has" | "get", target: any, atom: Atom | null) {
  return (key: any) => {
    key = toRaw(key);
    onReadTargetKey(target, key);
    return possiblyReactive(target[methodName](key), atom);
  };
}
/**
 * Creates an iterable that will delegate to the underlying iteration method and
 * observe keys as necessary.
 *
 * @param methodName name of the method to delegate to
 * @param target @see proxy
 * @param callback @see proxy
 */
function makeIteratorObserver(
  methodName: "keys" | "values" | "entries" | typeof Symbol.iterator,
  target: any,
  atom: Atom | null
) {
  return function* () {
    onReadTargetKey(target, KEYCHANGES);
    const keys = target.keys();
    for (const item of target[methodName]()) {
      const key = keys.next().value;
      onReadTargetKey(target, key);
      yield possiblyReactive(item, atom);
    }
  };
}
/**
 * Creates a forEach function that will delegate to forEach on the underlying
 * collection while observing key changes, and keys as they're iterated over,
 * and making the passed keys/values proxy.
 *
 * @param target @see proxy
 * @param callback @see proxy
 */
function makeForEachObserver(target: any, atom: Atom | null) {
  return function forEach(forEachCb: (val: any, key: any, target: any) => void, thisArg: any) {
    onReadTargetKey(target, KEYCHANGES);
    target.forEach(function (val: any, key: any, targetObj: any) {
      onReadTargetKey(target, key);
      forEachCb.call(
        thisArg,
        possiblyReactive(val, atom),
        possiblyReactive(key, atom),
        possiblyReactive(targetObj, atom)
      );
    }, thisArg);
  };
}
/**
 * Creates a function that will delegate to an underlying method, and check if
 * that method has modified the presence or value of a key, and notify the
 * proxys appropriately.
 *
 * @param setterName name of the method to delegate to
 * @param getterName name of the method which should be used to retrieve the
 *  value before calling the delegate method for comparison purposes
 * @param target @see proxy
 */
function delegateAndNotify(
  setterName: "set" | "add" | "delete",
  getterName: "has" | "get",
  target: any
) {
  return (key: any, value: any) => {
    key = toRaw(key);
    const hadKey = target.has(key);
    const originalValue = target[getterName](key);
    const ret = target[setterName](key, value);
    const hasKey = target.has(key);
    if (hadKey !== hasKey) {
      onWriteTargetKey(target, KEYCHANGES);
    }
    if (originalValue !== target[getterName](key)) {
      onWriteTargetKey(target, key);
    }
    return ret;
  };
}
/**
 * Creates a function that will clear the underlying collection and notify that
 * the keys of the collection have changed.
 *
 * @param target @see proxy
 */
function makeClearNotifier(target: Map<any, any> | Set<any>) {
  return () => {
    const allKeys = [...target.keys()];
    target.clear();
    onWriteTargetKey(target, KEYCHANGES);
    for (const key of allKeys) {
      onWriteTargetKey(target, key);
    }
  };
}
/**
 * Maps raw type of an object to an object containing functions that can be used
 * to build an appropritate proxy handler for that raw type. Eg: when making a
 * proxy set, calling the has method should mark the key that is being
 * retrieved as observed, and calling the add or delete method should notify the
 * proxys that the key which is being added or deleted has been modified.
 */
const rawTypeToFuncHandlers = {
  Set: (target: any, atom: Atom | null) => ({
    has: makeKeyObserver("has", target, atom),
    add: delegateAndNotify("add", "has", target),
    delete: delegateAndNotify("delete", "has", target),
    keys: makeIteratorObserver("keys", target, atom),
    values: makeIteratorObserver("values", target, atom),
    entries: makeIteratorObserver("entries", target, atom),
    [Symbol.iterator]: makeIteratorObserver(Symbol.iterator, target, atom),
    forEach: makeForEachObserver(target, atom),
    clear: makeClearNotifier(target),
    get size() {
      onReadTargetKey(target, KEYCHANGES);
      return target.size;
    },
  }),
  Map: (target: any, atom: Atom | null) => ({
    has: makeKeyObserver("has", target, atom),
    get: makeKeyObserver("get", target, atom),
    set: delegateAndNotify("set", "get", target),
    delete: delegateAndNotify("delete", "has", target),
    keys: makeIteratorObserver("keys", target, atom),
    values: makeIteratorObserver("values", target, atom),
    entries: makeIteratorObserver("entries", target, atom),
    [Symbol.iterator]: makeIteratorObserver(Symbol.iterator, target, atom),
    forEach: makeForEachObserver(target, atom),
    clear: makeClearNotifier(target),
    get size() {
      onReadTargetKey(target, KEYCHANGES);
      return target.size;
    },
  }),
  WeakMap: (target: any, atom: Atom | null) => ({
    has: makeKeyObserver("has", target, atom),
    get: makeKeyObserver("get", target, atom),
    set: delegateAndNotify("set", "get", target),
    delete: delegateAndNotify("delete", "has", target),
  }),
};
/**
 * Creates a proxy handler for collections (Set/Map/WeakMap)
 *
 * @param callback @see proxy
 * @param target @see proxy
 * @returns a proxy handler object
 */
function collectionsProxyHandler<T extends Collection>(
  target: T,
  targetRawType: CollectionRawType,
  atom: Atom | null
): ProxyHandler<T> {
  // TODO: if performance is an issue we can create the special handlers lazily when each
  // property is read.
  const specialHandlers = rawTypeToFuncHandlers[targetRawType](target, atom);
  return Object.assign(basicProxyHandler(atom), {
    // FIXME: probably broken when part of prototype chain since we ignore the receiver
    get(target: any, key: PropertyKey) {
      if (objectHasOwnProperty.call(specialHandlers, key)) {
        return (specialHandlers as any)[key];
      }
      onReadTargetKey(target, key);
      return possiblyReactive(target[key], atom);
    },
  }) as ProxyHandler<T>;
}
