import { OwlError } from "./owl_error";
import {
  batch,
  isObserving,
  onReadAtom,
  onWriteAtom,
  Atom,
  ComputationState,
  createAtom,
  createComputation,
  hasObservers,
  untrack,
  withObserver,
} from "./computations";
import { debug, debugLog } from "./debug";

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

// The atoms of the keys of each target. An object key (of a Map, Set or
// WeakMap) is held weakly, in a table of its own: its atom must not keep a
// deleted key, or any key of a WeakMap, alive. Property keys, the common case,
// are one WeakMap lookup and one Map lookup away.
interface KeyAtoms {
  keys: WeakMap<Target, Map<PropertyKey, Atom>>;
  objectKeys: WeakMap<Target, WeakMap<object, Atom>>;
}

// a key's value, read by a get
const itemAtoms: KeyAtoms = { keys: new WeakMap(), objectKeys: new WeakMap() };
// a key's presence, read by `in` / has(): notified when the key appears or
// disappears, not when its value changes
const presenceAtoms: KeyAtoms = { keys: new WeakMap(), objectKeys: new WeakMap() };

function isObjectKey(key: unknown): key is object {
  return (typeof key === "object" && key !== null) || typeof key === "function";
}

function getTargetKeyAtom(target: Target, key: PropertyKey, atoms: KeyAtoms = itemAtoms): Atom {
  if (isObjectKey(key)) {
    let table = atoms.objectKeys.get(target);
    if (table === undefined) {
      table = new WeakMap();
      atoms.objectKeys.set(target, table);
    }
    let atom = table.get(key);
    if (atom === undefined) {
      atom = createAtom(undefined, "key");
      table.set(key, atom);
    }
    return atom;
  }
  const table = getKeyAtoms(target, atoms);
  let atom = table.get(key);
  if (atom === undefined) {
    atom = createAtom(undefined, "key");
    table.set(key, atom);
  }
  return atom;
}

// the atoms of the property keys of `target`, created on first use
function getKeyAtoms(target: Target, atoms: KeyAtoms): Map<PropertyKey, Atom> {
  let table = atoms.keys.get(target);
  if (table === undefined) {
    table = new Map();
    atoms.keys.set(target, table);
  }
  return table;
}

function findAtom(target: Target, key: PropertyKey, atoms: KeyAtoms): Atom | undefined {
  return isObjectKey(key)
    ? atoms.objectKeys.get(target)?.get(key)
    : atoms.keys.get(target)?.get(key);
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
function onWriteTargetKey(target: Target, key: PropertyKey, atoms: KeyAtoms = itemAtoms): void {
  const atom = findAtom(target, key, atoms);
  if (atom) {
    if (debug.reactivity) {
      debugLog("reactivity", `proxy write ${describeKey(key)}`, target);
    }
    onWriteAtom(atom);
  }
}

function describeKey(key: PropertyKey): string {
  return key === KEYCHANGES ? "(keys)" : String(key);
}

function onReadKeyPresence(target: Target, key: PropertyKey): void {
  if (isObserving()) {
    onReadAtom(getTargetKeyAtom(target, key, presenceAtoms));
  }
}

// a key appeared or disappeared: the key list, the key's presence, its value
function onWriteKeyPresence(target: Target, key: PropertyKey): void {
  onWriteTargetKey(target, KEYCHANGES);
  onWriteTargetKey(target, key, presenceAtoms);
}

// A removed key's atoms that nothing observes are dropped: kept, every key a
// long-lived object ever had would stay allocated, object keys included. A
// later read creates them again.
function releaseKey(target: Target, key: PropertyKey): void {
  releaseKeyAtom(target, key, itemAtoms);
  releaseKeyAtom(target, key, presenceAtoms);
}

function releaseKeyAtom(target: Target, key: PropertyKey, atoms: KeyAtoms): void {
  const atom = findAtom(target, key, atoms);
  if (atom !== undefined && !hasObservers(atom)) {
    if (isObjectKey(key)) {
      atoms.objectKeys.get(target)!.delete(key);
    } else {
      atoms.keys.get(target)!.delete(key);
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
  onWriteDroppedIndicesIn(target, newLength, oldLength, itemAtoms);
  onWriteDroppedIndicesIn(target, newLength, oldLength, presenceAtoms);
}

function onWriteDroppedIndicesIn(
  target: Target,
  newLength: number,
  oldLength: number,
  atoms: KeyAtoms
): void {
  const table = atoms.keys.get(target);
  if (table !== undefined) {
    if (oldLength - newLength <= table.size) {
      for (let i = newLength; i < oldLength; i++) {
        onWriteDroppedIndex(target, String(i), atoms);
      }
    } else {
      for (const key of table.keys()) {
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
    handler = new BasicHandler(shallow);
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
    true,
    `observe ${callback.name || "callback"}`
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
 * The handler of a regular object or array proxy. One per proxy: the traps
 * find the atoms of its target's keys through `keyAtoms` (looked up once)
 * instead of a WeakMap lookup per read.
 */
class BasicHandler implements ProxyHandler<any> {
  shallow: boolean;
  // the value atoms of the target's keys
  keyAtoms: Map<PropertyKey, Atom> | undefined;

  constructor(shallow: boolean) {
    this.shallow = shallow;
    this.keyAtoms = undefined;
  }

  get(target: any, key: PropertyKey, receiver: any): any {
    // a read nobody observes subscribes nothing, and creates no atom for its
    // key: a model building its records outside any render reads thousands
    if (isObserving()) {
      let table = this.keyAtoms;
      if (table === undefined) {
        table = this.keyAtoms = getKeyAtoms(target, itemAtoms);
      }
      let atom = table.get(key);
      if (atom === undefined) {
        atom = createAtom(undefined, "key");
        table.set(key, atom);
      }
      onReadAtom(atom);
    }
    const value = Reflect.get(target, key, receiver);
    if (typeof value === "function") {
      return arrayMethods.get(value) ?? value;
    }
    // Fast path: signal-based proxies and primitive values don't need wrapping
    if (this.shallow || typeof value !== "object" || value === null) {
      return value;
    }
    // the proxy an object read before already has spares the checks
    // proxifyTarget would make (twice) to find it
    const reactive = deepProxies.get(value);
    if (reactive ? skipped.has(value) : !canBeMadeReactive(value)) {
      return value;
    }
    // non-writable non-configurable properties cannot be made proxy
    const desc = Object.getOwnPropertyDescriptor(target, key);
    if (desc && !desc.writable && !desc.configurable) {
      return value;
    }
    return reactive ?? proxifyTarget(value, false);
  }

  set(target: any, key: PropertyKey, value: any, receiver: any): boolean {
    // a write subscribes nothing, though a getter or setter it runs reads
    // through the proxy
    return isObserving()
      ? untrack(() => writeKey(target, key, value, receiver))
      : writeKey(target, key, value, receiver);
  }

  deleteProperty(target: any, key: PropertyKey): boolean {
    const hadKey = objectHasOwnProperty.call(target, key);
    const ret = Reflect.deleteProperty(target, key);
    if (hadKey && ret) {
      onWriteKeyPresence(target, key);
      onWriteTargetKey(target, key);
      releaseKey(target, key);
    }
    return ret;
  }

  ownKeys(target: any): ArrayLike<string | symbol> {
    onReadTargetKey(target, KEYCHANGES);
    return Reflect.ownKeys(target);
  }

  has(target: any, key: PropertyKey): boolean {
    onReadKeyPresence(target, key);
    return Reflect.has(target, key);
  }
}

function writeKey(target: any, key: PropertyKey, value: any, receiver: any): boolean {
  const hadKey = objectHasOwnProperty.call(target, key);
  const originalValue = Reflect.get(target, key, receiver);
  const originalLength = Array.isArray(target) ? target.length : 0;
  const ret = Reflect.set(target, key, toRaw(value), receiver);
  if (!hadKey && objectHasOwnProperty.call(target, key)) {
    onWriteKeyCreated(target, key, originalLength);
  }
  if (key === "length" && Array.isArray(target)) {
    // While Array length may trigger the set trap, it's not actually set by this
    // method but is updated behind the scenes, and the trap is not called with the
    // new value. We disable the "same-value-optimization" for it because of that.
    onWriteTargetKey(target, key);
    if (target.length < originalValue) {
      onWriteTargetKey(target, KEYCHANGES);
      onWriteDroppedIndices(target, target.length, originalValue);
    }
  } else if (!Object.is(originalValue, Reflect.get(target, key, receiver))) {
    onWriteTargetKey(target, key);
  }
  return ret;
}

function onWriteKeyCreated(target: Target, key: PropertyKey, originalLength: number): void {
  onWriteKeyPresence(target, key);
  // an index past the end grows the array without a length write going
  // through the set trap
  if (key !== "length" && Array.isArray(target) && target.length !== originalLength) {
    onWriteTargetKey(target, "length");
  }
}

// Array methods a proxy array replaces. Those that write several keys run as
// one batch: an immediate computation sees the array before or after the
// call, not in between. Those that search an item by identity also find the
// raw object of an item they read as its proxy.
const arrayMethods = new Map<Function, Function>();
for (const name of ["copyWithin", "fill", "reverse", "sort"] as const) {
  const method = Array.prototype[name] as Function;
  arrayMethods.set(method, function (this: unknown[], ...args: unknown[]) {
    return batch(() => method.apply(this, args));
  });
}
// The methods that change the length read it, and the items they shift, as
// their own business, not as reads of the caller: tracked, an effect that only
// pushes would re-run on every push of another, and two of them would re-run
// each other forever. The others stay tracked: a sort reads the items its
// comparator orders, and its caller depends on them (as in Vue).
for (const name of ["pop", "push", "shift", "splice", "unshift"] as const) {
  const method = Array.prototype[name] as Function;
  arrayMethods.set(method, function (this: unknown[], ...args: unknown[]) {
    return batch(() => untrack(() => method.apply(this, args)));
  });
}
for (const name of ["includes", "indexOf", "lastIndexOf"] as const) {
  const method = Array.prototype[name] as Function;
  arrayMethods.set(method, function (this: unknown[], ...args: unknown[]) {
    const result = method.apply(this, args);
    if (result !== -1 && result !== false) {
      return result;
    }
    // the call above read every item through the proxy, which observes them
    return method.apply(toRaw(this), [toRaw(args[0] as object), ...args.slice(1)]);
  });
}

// what the collection handlers inherit the traps they do not override from
const deepHandler = new BasicHandler(false);
const shallowHandler = new BasicHandler(true);

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
  // a Set's keys, or a Map's, change only by being added or removed, which
  // the key list notifies: only a Map's values need their keys' atoms
  const readsValues = target instanceof Map && methodName !== "keys";
  return function* () {
    onReadTargetKey(target, KEYCHANGES);
    for (const entry of target.entries()) {
      if (readsValues) {
        onReadTargetKey(target, entry[0]);
      }
      const item = yieldsEntries ? entry : methodName === "keys" ? entry[0] : entry[1];
      if (shallow) {
        yield item;
      } else if (yieldsEntries) {
        yield [possiblyReactive(entry[0], false), possiblyReactive(entry[1], false)];
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
  const readsValues = target instanceof Map;
  return function forEach(forEachCb: (val: any, key: any, target: any) => void, thisArg: any) {
    onReadTargetKey(target, KEYCHANGES);
    target.forEach(function (val: any, key: any, targetObj: any) {
      if (readsValues) {
        onReadTargetKey(target, key);
      }
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
 * Creates a version of an ES2025 Set method (union, isSubsetOf...) that reads
 * the whole membership of the set. Its result is a fresh, plain Set or a
 * boolean. A reactive `other` is read through its proxy, and so observed too.
 */
type SetOperation =
  | "difference"
  | "intersection"
  | "isDisjointFrom"
  | "isSubsetOf"
  | "isSupersetOf"
  | "symmetricDifference"
  | "union";

// The members of a set-like by their raw object: a shallow set may hold
// proxies, a deep one yields them, and either way a member is the same member
// as its raw object.
function membersByRaw(members: Iterable<any>): Map<any, any> {
  const byRaw = new Map();
  for (const member of members) {
    byRaw.set(toRaw(member), member);
  }
  return byRaw;
}

// The ES2025 set operations, on members compared by their raw object, so that
// any mix of shallow, deep and plain sets answers as the raw sets would; a
// result holds the members as the sets hold them. Reading `other`'s keys
// through it observes a reactive one.
function makeSetOperation(name: SetOperation, target: Set<any>) {
  return (other: any) => {
    onReadTargetKey(target, KEYCHANGES);
    const mine = membersByRaw(target);
    const theirs = membersByRaw(other.keys());
    const notIn = (a: Map<any, any>, b: Map<any, any>) =>
      [...a].filter(([raw]) => !b.has(raw)).map(([, member]) => member);
    switch (name) {
      case "union":
        return new Set([...target, ...notIn(theirs, mine)]);
      case "intersection":
        return new Set([...mine].filter(([raw]) => theirs.has(raw)).map(([, member]) => member));
      case "difference":
        return new Set(notIn(mine, theirs));
      case "symmetricDifference":
        return new Set([...notIn(mine, theirs), ...notIn(theirs, mine)]);
      case "isSubsetOf":
        return notIn(mine, theirs).length === 0;
      case "isSupersetOf":
        return notIn(theirs, mine).length === 0;
      case "isDisjointFrom":
        return [...mine.keys()].every((raw) => !theirs.has(raw));
    }
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
  target: any,
  shallow: boolean
) {
  return (key: any, value: any) => {
    key = toRaw(key);
    const hadKey = target.has(key);
    const originalValue = target[getterName](key);
    // a shallow collection hands its values back as stored: keep the proxy
    const ret = target[setterName](key, shallow ? value : toRaw(value));
    const hasKey = target.has(key);
    if (hadKey !== hasKey) {
      onWriteKeyPresence(target, key);
    }
    if (!Object.is(originalValue, target[getterName](key))) {
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
      onWriteTargetKey(target, key, presenceAtoms);
      onWriteTargetKey(target, key);
      releaseKey(target, key);
    }
  };
}
type MethodFactory = (target: any, shallow: boolean) => Function;

const setMethods: [PropertyKey, MethodFactory][] = [
  ["has", (target, shallow) => makeKeyObserver("has", target, shallow)],
  ["add", (target, shallow) => delegateAndNotify("add", "has", target, shallow)],
  ["delete", (target, shallow) => delegateAndNotify("delete", "has", target, shallow)],
  ["keys", (target, shallow) => makeIteratorObserver("keys", target, shallow)],
  ["values", (target, shallow) => makeIteratorObserver("values", target, shallow)],
  ["entries", (target, shallow) => makeIteratorObserver("entries", target, shallow)],
  [Symbol.iterator, (target, shallow) => makeIteratorObserver(Symbol.iterator, target, shallow)],
  ["forEach", (target, shallow) => makeForEachObserver(target, shallow)],
  ["clear", (target) => makeClearNotifier(target)],
];
// ES2025 Set methods, where the engine has them
const setOperations = (
  [
    "difference",
    "intersection",
    "isDisjointFrom",
    "isSubsetOf",
    "isSupersetOf",
    "symmetricDifference",
    "union",
  ] as const
)
  .filter((name) => name in Set.prototype)
  .map((name): [PropertyKey, MethodFactory] => [name, (target) => makeSetOperation(name, target)]);
const weakMapMethods: [PropertyKey, MethodFactory][] = [
  ["has", (target, shallow) => makeKeyObserver("has", target, shallow)],
  ["get", (target, shallow) => makeKeyObserver("get", target, shallow)],
  ["set", (target, shallow) => delegateAndNotify("set", "get", target, shallow)],
  ["delete", (target, shallow) => delegateAndNotify("delete", "has", target, shallow)],
];

/**
 * The methods a collection proxy replaces, by raw type: reading one returns a
 * version that observes (or notifies) the keys it touches. Eg: `has` on a proxy
 * set observes the key it is asked about, `add` notifies it.
 */
const methodFactories: Record<CollectionRawType, Map<PropertyKey, MethodFactory>> = {
  Set: new Map([...setMethods, ...setOperations]),
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
