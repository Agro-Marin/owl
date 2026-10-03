import { OwlError } from "./owl_error";
import {
  batch,
  isObserving,
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
function possiblyReactive(val: any, shallow: boolean) {
  return !shallow && canBeMadeReactive(val) ? proxy(val) : val;
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

interface TargetAtoms {
  keys: Map<PropertyKey, Atom>;
  // an object key (of a Map, Set or WeakMap) is held weakly: its atom must
  // not keep a deleted key, or any key of a WeakMap, alive
  objectKeys: WeakMap<object, Atom> | null;
}
type KeyAtoms = WeakMap<Target, TargetAtoms>;

// a key's value, read by a get
const targetToKeysToAtomItem: KeyAtoms = new WeakMap();
// a key's presence, read by `in` / has(): notified when the key appears or
// disappears, not when its value changes
const targetToKeysToPresenceAtom: KeyAtoms = new WeakMap();

function isObjectKey(key: unknown): key is object {
  return (typeof key === "object" && key !== null) || typeof key === "function";
}

function getTargetKeyAtom(
  target: Target,
  key: PropertyKey,
  atoms: KeyAtoms = targetToKeysToAtomItem
): Atom {
  let table = atoms.get(target);
  if (!table) {
    table = { keys: new Map(), objectKeys: null };
    atoms.set(target, table);
  }
  let atom = findAtom(table, key);
  if (!atom) {
    atom = {
      value: undefined,
      observers: new Set(),
    };
    if (isObjectKey(key)) {
      (table.objectKeys ??= new WeakMap()).set(key, atom);
    } else {
      table.keys.set(key, atom);
    }
  }
  return atom;
}

function findAtom(table: TargetAtoms, key: PropertyKey): Atom | undefined {
  return isObjectKey(key) ? table.objectKeys?.get(key) : table.keys.get(key);
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
  // a read nobody observes subscribes nothing, and creates no atom for its
  // key: a model building its records outside any render reads thousands
  if (isObserving()) {
    onReadAtom(getTargetKeyAtom(target, key));
  }
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
function onWriteTargetKey(
  target: Target,
  key: PropertyKey,
  atoms: KeyAtoms = targetToKeysToAtomItem
): void {
  const table = atoms.get(target);
  const atom = table && findAtom(table, key);
  if (atom) {
    onWriteAtom(atom);
  }
}

function onReadKeyPresence(target: Target, key: PropertyKey): void {
  if (isObserving()) {
    onReadAtom(getTargetKeyAtom(target, key, targetToKeysToPresenceAtom));
  }
}

// a key appeared or disappeared: the key list, the key's presence, its value
function onWriteKeyPresence(target: Target, key: PropertyKey): void {
  onWriteTargetKey(target, KEYCHANGES);
  onWriteTargetKey(target, key, targetToKeysToPresenceAtom);
}

// A removed key's atoms that nothing observes are dropped: kept, every key a
// long-lived object ever had would stay allocated, object keys included. A
// later read creates them again.
function releaseKey(target: Target, key: PropertyKey): void {
  for (const atoms of [targetToKeysToAtomItem, targetToKeysToPresenceAtom]) {
    const table = atoms.get(target);
    const atom = table && findAtom(table, key);
    if (atom && atom.observers.size === 0) {
      if (isObjectKey(key)) {
        table!.objectKeys!.delete(key);
      } else {
        table!.keys.delete(key);
      }
    }
  }
}

/**
 * Notify Reactives that are observing the indices an array dropped when its
 * length was written: such a write does not go through the deleteProperty trap.
 * Visits the dropped range or the atoms, whichever is smaller: a pop() drops
 * one index of an array whose every index may have an atom.
 *
 * @param target the array whose length was written
 * @param newLength the length after the write
 * @param oldLength the length before the write
 */
function onWriteDroppedIndices(target: Target, newLength: number, oldLength: number): void {
  for (const atoms of [targetToKeysToAtomItem, targetToKeysToPresenceAtom]) {
    const table = atoms.get(target);
    if (!table) {
      continue;
    }
    if (oldLength - newLength <= table.keys.size) {
      for (let i = newLength; i < oldLength; i++) {
        onWriteDroppedIndex(target, String(i), atoms);
      }
    } else {
      for (const key of table.keys.keys()) {
        if (typeof key === "string" && isIndexIn(key, newLength, oldLength)) {
          onWriteDroppedIndex(target, key, atoms);
        }
      }
    }
  }
}

function isIndexIn(key: string, start: number, end: number): boolean {
  const index = Number(key);
  return index >= start && index < end && String(index) === key;
}

function onWriteDroppedIndex(target: Target, key: string, atoms: KeyAtoms): void {
  onWriteTargetKey(target, key, atoms);
  releaseKey(target, key);
}

// Maps proxy objects to the underlying target
const targets = new WeakMap<Reactive<Target>, Target>();
// A shallow proxy (the value of a collection signal) does not wrap what it
// holds, a deep one (proxy()) does: one target may have both, and neither
// may be handed out for the other.
const deepProxies = new WeakMap<Target, Reactive<Target>>();
const shallowProxies = new WeakMap<Target, Reactive<Target>>();

export function proxifyTarget<T extends Target>(target: T, shallow: boolean): T {
  if (!canBeMadeReactive(target)) {
    throw new OwlError(`Cannot make the given value reactive`);
  }
  const raw = targets.get(target);
  if (raw) {
    // a proxy of the other flavor is unwrapped: proxy() of a collection
    // signal's value is deep, a collection signal of a proxy() is shallow. A
    // proxy of this flavor, or an observe() view, is kept as it is.
    if ((shallow ? deepProxies : shallowProxies).get(raw) !== target) {
      return target;
    }
    target = raw as T;
  }
  if (skipped.has(target)) {
    return target;
  }
  const cache = shallow ? shallowProxies : deepProxies;
  const reactive = cache.get(target)!;
  if (reactive) {
    return reactive as T;
  }

  let handler: ProxyHandler<any>;
  if (target instanceof Map) {
    handler = collectionsProxyHandler(target as unknown as Collection, "Map", shallow);
  } else if (target instanceof Set) {
    handler = collectionsProxyHandler(target as unknown as Collection, "Set", shallow);
  } else if (target instanceof WeakMap) {
    handler = collectionsProxyHandler(target as unknown as Collection, "WeakMap", shallow);
  } else {
    handler = shallow ? shallowHandler : deepHandler;
  }
  const proxy = new Proxy(target, handler as ProxyHandler<T>) as Reactive<T>;

  cache.set(target, proxy);
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
  return proxifyTarget(target, false);
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
  computation.notifiesWithoutRecompute = true;
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
function basicProxyHandler<T extends Target>(shallow: boolean): ProxyHandler<T> {
  return {
    get(target, key, receiver) {
      onReadTargetKey(target, key);
      const value = Reflect.get(target, key, receiver);
      if (typeof value === "function") {
        return batchedArrayMethods.get(value) ?? value;
      }
      // Fast path: signal-based proxies and primitive values don't need wrapping
      if (shallow || typeof value !== "object" || value === null) {
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
      return proxifyTarget(value, false);
    },
    set(target, key, value, receiver) {
      const hadKey = objectHasOwnProperty.call(target, key);
      const originalValue = Reflect.get(target, key, receiver);
      const ret = Reflect.set(target, key, toRaw(value), receiver);
      const keyCreated = !hadKey && objectHasOwnProperty.call(target, key);
      const valueChanged = originalValue !== Reflect.get(target, key, receiver);
      if (keyCreated) {
        onWriteKeyPresence(target, key);
        // an index past the end grows the array without a length write
        // going through this trap
        if (key !== "length" && Array.isArray(target)) {
          onWriteTargetKey(target, "length");
        }
      }
      if (key === "length" && Array.isArray(target)) {
        // While Array length may trigger the set trap, it's not actually set by this
        // method but is updated behind the scenes, and the trap is not called with the
        // new value. We disable the "same-value-optimization" for it because of that.
        onWriteTargetKey(target, key);
        if (target.length < (originalValue as number)) {
          onWriteTargetKey(target, KEYCHANGES);
          onWriteDroppedIndices(target, target.length, originalValue as number);
        }
      } else if (valueChanged) {
        onWriteTargetKey(target, key);
      }
      return ret;
    },
    deleteProperty(target, key) {
      const hadKey = objectHasOwnProperty.call(target, key);
      const ret = Reflect.deleteProperty(target, key);
      if (hadKey && ret) {
        onWriteKeyPresence(target, key);
        onWriteTargetKey(target, key);
        releaseKey(target, key);
      }
      return ret;
    },
    ownKeys(target) {
      onReadTargetKey(target, KEYCHANGES);
      return Reflect.ownKeys(target);
    },
    has(target, key) {
      onReadKeyPresence(target, key);
      return Reflect.has(target, key);
    },
  } as ProxyHandler<T>;
}
// The array methods that write several keys, run as one batch: an immediate
// computation sees the array before or after the call, not in between.
const batchedArrayMethods = new Map<Function, Function>(
  (
    ["copyWithin", "fill", "pop", "push", "reverse", "shift", "sort", "splice", "unshift"] as const
  ).map((name) => {
    const method = Array.prototype[name] as Function;
    return [
      method,
      function (this: unknown[], ...args: unknown[]) {
        return batch(() => method.apply(this, args));
      },
    ];
  })
);

// the traps only use the target they are given: one handler per flavor
const deepHandler = basicProxyHandler(false);
const shallowHandler = basicProxyHandler(true);

/**
 * Creates a function that will observe the key that is passed to it when called
 * and delegates to the underlying method.
 *
 * @param methodName name of the method to delegate to
 * @param target @see proxy
 * @param callback @see proxy
 */
function makeKeyObserver(methodName: "has" | "get", target: any, shallow: boolean) {
  return (key: any) => {
    key = toRaw(key);
    if (methodName === "has") {
      onReadKeyPresence(target, key);
    } else {
      onReadTargetKey(target, key);
    }
    return possiblyReactive(target[methodName](key), shallow);
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
  shallow: boolean
) {
  // an entry is a fresh [key, value] array nobody else holds: proxying it would
  // only subscribe the reader to atoms no write can ever reach
  const yieldsEntries =
    methodName === "entries" || (methodName === Symbol.iterator && target instanceof Map);
  return function* () {
    onReadTargetKey(target, KEYCHANGES);
    const keys = target.keys();
    for (const item of target[methodName]()) {
      const key = keys.next().value;
      onReadTargetKey(target, key);
      if (shallow) {
        yield item;
      } else if (yieldsEntries) {
        yield [possiblyReactive(item[0], false), possiblyReactive(item[1], false)];
      } else {
        yield possiblyReactive(item, false);
      }
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
function makeForEachObserver(target: any, shallow: boolean) {
  return function forEach(forEachCb: (val: any, key: any, target: any) => void, thisArg: any) {
    onReadTargetKey(target, KEYCHANGES);
    target.forEach(function (val: any, key: any, targetObj: any) {
      onReadTargetKey(target, key);
      forEachCb.call(
        thisArg,
        possiblyReactive(val, shallow),
        possiblyReactive(key, shallow),
        possiblyReactive(targetObj, shallow)
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
      onWriteKeyPresence(target, key);
    }
    if (originalValue !== target[getterName](key)) {
      onWriteTargetKey(target, key);
    }
    if (!hasKey) {
      releaseKey(target, key);
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
      onWriteTargetKey(target, key, targetToKeysToPresenceAtom);
      onWriteTargetKey(target, key);
      releaseKey(target, key);
    }
  };
}
type MethodFactory = (target: any, shallow: boolean) => Function;

const setMethods: [PropertyKey, MethodFactory][] = [
  ["has", (target, shallow) => makeKeyObserver("has", target, shallow)],
  ["add", (target) => delegateAndNotify("add", "has", target)],
  ["delete", (target) => delegateAndNotify("delete", "has", target)],
  ["keys", (target, shallow) => makeIteratorObserver("keys", target, shallow)],
  ["values", (target, shallow) => makeIteratorObserver("values", target, shallow)],
  ["entries", (target, shallow) => makeIteratorObserver("entries", target, shallow)],
  [Symbol.iterator, (target, shallow) => makeIteratorObserver(Symbol.iterator, target, shallow)],
  ["forEach", (target, shallow) => makeForEachObserver(target, shallow)],
  ["clear", (target) => makeClearNotifier(target)],
];
const weakMapMethods: [PropertyKey, MethodFactory][] = [
  ["has", (target, shallow) => makeKeyObserver("has", target, shallow)],
  ["get", (target, shallow) => makeKeyObserver("get", target, shallow)],
  ["set", (target) => delegateAndNotify("set", "get", target)],
  ["delete", (target) => delegateAndNotify("delete", "has", target)],
];

/**
 * The methods a collection proxy replaces, by raw type: reading one returns a
 * version that observes (or notifies) the keys it touches. Eg: `has` on a proxy
 * set observes the key it is asked about, `add` notifies it.
 */
const methodFactories: Record<CollectionRawType, Map<PropertyKey, MethodFactory>> = {
  Set: new Map(setMethods),
  Map: new Map([...setMethods, ...weakMapMethods]),
  WeakMap: new Map(weakMapMethods),
};

/**
 * Creates a proxy handler for collections (Set/Map/WeakMap). Its methods are
 * built on first read and kept for the proxy: most proxies use a few of them.
 */
function collectionsProxyHandler<T extends Collection>(
  target: T,
  targetRawType: CollectionRawType,
  shallow: boolean
): ProxyHandler<T> {
  const factories = methodFactories[targetRawType];
  const hasSize = targetRawType !== "WeakMap";
  const methods = new Map<PropertyKey, Function>();
  return Object.assign(Object.create(shallow ? shallowHandler : deepHandler), {
    // FIXME: probably broken when part of prototype chain since we ignore the receiver
    get(target: any, key: PropertyKey) {
      const factory = factories.get(key);
      if (factory) {
        let method = methods.get(key);
        if (!method) {
          method = factory(target, shallow);
          methods.set(key, method);
        }
        return method;
      }
      if (key === "size" && hasSize) {
        onReadTargetKey(target, KEYCHANGES);
        return target.size;
      }
      onReadTargetKey(target, key);
      return possiblyReactive(target[key], shallow);
    },
  }) as ProxyHandler<T>;
}
