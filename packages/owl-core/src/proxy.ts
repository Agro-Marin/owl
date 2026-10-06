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
 * The deep proxy of `val` when it can have one, `val` itself otherwise (and
 * always for a shallow proxy, which hands its values out as stored).
 */
function possiblyReactive(val: any, shallow: boolean) {
  return !shallow && canBeMadeReactive(val) ? proxy(val) : val;
}

const skipped = new WeakSet<Target>();
// class prototypes marked raw: an object inheriting from one is raw too
const rawPrototypes = new WeakSet<Target>();
let hasRawPrototypes = false;

/**
 * Mark an object or array so that it is ignored by the reactivity system: a
 * proxy hands it out as it is. Marking a class prototype (`markRaw(Foo.prototype)`)
 * marks every instance of the class and of its subclasses, which a class with
 * private members needs: a proxy cannot reach them.
 *
 * @param value the value to mark (a proxy marks its raw object)
 * @returns the value itself
 */
export function markRaw<T extends Target>(value: T): T {
  const raw = toRaw(value);
  skipped.add(raw);
  if (isClassPrototype(raw)) {
    rawPrototypes.add(raw);
    hasRawPrototypes = true;
  }
  return value;
}

function isClassPrototype(value: any): boolean {
  return (
    objectHasOwnProperty.call(value, "constructor") &&
    typeof value.constructor === "function" &&
    value.constructor.prototype === value
  );
}

function isMarkedRaw(target: Target): boolean {
  if (skipped.has(target)) {
    return true;
  }
  if (hasRawPrototypes) {
    for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
      if (rawPrototypes.has(proto)) {
        return true;
      }
    }
  }
  return false;
}

// A non-configurable, non-writable data property must be handed out as it is
// (a Proxy invariant): it cannot be swapped for its proxy, or a view.
function isLocked(target: Target, key: PropertyKey): boolean {
  const desc = Reflect.getOwnPropertyDescriptor(target, key);
  return desc !== undefined && desc.configurable === false && desc.writable === false;
}

// The TypeError an engine throws when a getter, setter or method reaches a
// private member (`this.#x`) through a proxy, which does not have it: V8,
// SpiderMonkey, JavaScriptCore.
const PRIVATE_MEMBER_ERROR =
  /^(Cannot (read|write) private member #|Receiver must be an instance of class |can't access private field or method|Cannot access invalid private field)/;

function privateMemberError(error: unknown, target: Target, key: PropertyKey): unknown {
  if (!(error instanceof TypeError) || !PRIVATE_MEMBER_ERROR.test(error.message)) {
    return error;
  }
  const name = (target as any).constructor?.name || "TheClass";
  return new OwlError(
    `Cannot reach "${String(key)}" of a ${name} through a reactive proxy: ${error.message}. ` +
      `A proxy has no private members: mark the class raw with markRaw(${name}.prototype)`,
    { cause: error }
  );
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
 * Subscribes the current computation to the value of `key` on `target`.
 *
 * @param target the target whose key is read
 * @param key the key read (or `KEYCHANGES` for the key list)
 */
function onReadTargetKey(target: Target, key: PropertyKey): void {
  // a read nobody observes subscribes nothing, and creates no atom for its
  // key: a model building its records outside any render reads thousands
  if (isObserving()) {
    onReadAtom(getTargetKeyAtom(target, key));
  }
}

/**
 * Notifies the readers of `key` on `target` that it changed, if it has any.
 *
 * @param target the target whose key changed
 * @param key the key that changed (or `KEYCHANGES` if a key was created or
 *   deleted)
 * @param atoms the value atoms (default) or the presence atoms
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
 * Notifies the readers of the indices an array dropped when its
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
  if (isMarkedRaw(target)) {
    return target;
  }
  const cache = shallow ? shallowProxies : deepProxies;
  const reactive = cache.get(target)!;
  if (reactive) {
    return reactive as T;
  }

  const type = collectionType(target);
  const handler = type ? new CollectionHandler(target, type, shallow) : new BasicHandler(shallow);
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
        const result = wrap(value);
        return result !== value && isLocked(raw, key) ? value : result;
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
  // what the atoms of the target's own properties are keyed by: the target,
  // or for a collection an object standing for its properties
  host: Target | null;

  constructor(shallow: boolean, host: Target | null = null) {
    this.shallow = shallow;
    this.keyAtoms = undefined;
    this.host = host;
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
    let value;
    try {
      value = Reflect.get(target, key, receiver);
    } catch (error) {
      throw privateMemberError(error, target, key);
    }
    if (typeof value === "function") {
      return replacedMethods.get(value) ?? value;
    }
    // Fast path: signal-based proxies and primitive values don't need wrapping
    if (this.shallow || typeof value !== "object" || value === null) {
      return value;
    }
    // the proxy an object read before already has spares the checks
    // proxifyTarget would make (twice) to find it
    const reactive = deepProxies.get(value);
    if (reactive ? isMarkedRaw(value) : !canBeMadeReactive(value)) {
      return value;
    }
    if (isLocked(target, key)) {
      return value;
    }
    return reactive ?? proxifyTarget(value, false);
  }

  set(target: any, key: PropertyKey, value: any, receiver: any): boolean {
    // a write subscribes nothing, though a getter or setter it runs reads
    // through the proxy
    const shallow = this.shallow;
    const atoms = this.host ?? target;
    try {
      return isObserving()
        ? untrack(() => writeKey(target, key, value, receiver, shallow, atoms))
        : writeKey(target, key, value, receiver, shallow, atoms);
    } catch (error) {
      throw privateMemberError(error, target, key);
    }
  }

  deleteProperty(target: any, key: PropertyKey): boolean {
    const hadKey = objectHasOwnProperty.call(target, key);
    const ret = Reflect.deleteProperty(target, key);
    if (hadKey && ret) {
      const atoms = this.host ?? target;
      onWriteKeyPresence(atoms, key);
      onWriteTargetKey(atoms, key);
      releaseKey(atoms, key);
      if (Array.isArray(target)) {
        onWriteItems(target);
      }
    }
    return ret;
  }

  // Object.defineProperty notifies as a write does. The engine also defines
  // through it the key a set trap writes (the proxy is the receiver): that
  // write notifies on its own.
  defineProperty(target: any, key: PropertyKey, descriptor: PropertyDescriptor): boolean {
    if (target === writingTarget && key === writingKey) {
      return Reflect.defineProperty(target, key, descriptor);
    }
    const before = Reflect.getOwnPropertyDescriptor(target, key);
    const isArray = Array.isArray(target);
    const originalLength = isArray ? target.length : 0;
    if (!this.shallow && "value" in descriptor) {
      descriptor.value = toRaw(descriptor.value);
    }
    const ret = Reflect.defineProperty(target, key, descriptor);
    if (ret) {
      const atoms = this.host ?? target;
      const after = Reflect.getOwnPropertyDescriptor(target, key)!;
      if (before !== undefined && before.enumerable !== after.enumerable) {
        onWriteTargetKey(atoms, KEYCHANGES);
      }
      const changed =
        !Object.is(before?.value, after.value) ||
        before?.get !== after.get ||
        before?.set !== after.set;
      onWriteKey(target, key, before !== undefined, changed, isArray, originalLength, atoms);
    }
    return ret;
  }

  ownKeys(target: any): ArrayLike<string | symbol> {
    onReadTargetKey(this.host ?? target, KEYCHANGES);
    return Reflect.ownKeys(target);
  }

  has(target: any, key: PropertyKey): boolean {
    onReadKeyPresence(this.host ?? target, key);
    return Reflect.has(target, key);
  }
}

// The key a set trap is writing, which the defineProperty trap leaves alone
let writingTarget: Target | null = null;
let writingKey: PropertyKey | undefined;

function writeKey(
  target: any,
  key: PropertyKey,
  value: any,
  receiver: any,
  shallow: boolean,
  atoms: Target
): boolean {
  // a shallow proxy hands its values back as stored: it keeps a proxy
  const stored = shallow ? value : toRaw(value);
  const isArray = Array.isArray(target);
  const originalLength = isArray ? target.length : 0;
  const own = Reflect.getOwnPropertyDescriptor(target, key);
  if (
    targets.get(receiver) === target &&
    (own !== undefined ? "value" in own : !inheritsAccessor(target, key))
  ) {
    // A data property written through its own proxy: the engine would only
    // come back through the proxy's defineProperty trap, to define it on the
    // target. Written on the target, it costs no trap.
    const ret = Reflect.set(target, key, stored);
    const changed = !(isArray && key === "length") && !Object.is(own?.value, target[key]);
    onWriteKey(target, key, own !== undefined, changed, isArray, originalLength, atoms);
    return ret;
  }
  // an accessor runs with the proxy as `this`, and a write through another
  // receiver defines the key on it
  const originalValue = Reflect.get(target, key, receiver);
  const previousTarget = writingTarget;
  const previousKey = writingKey;
  writingTarget = target;
  writingKey = key;
  let ret: boolean;
  try {
    ret = Reflect.set(target, key, stored, receiver);
  } finally {
    writingTarget = previousTarget;
    writingKey = previousKey;
  }
  const changed =
    !(isArray && key === "length") && !Object.is(originalValue, Reflect.get(target, key, receiver));
  onWriteKey(target, key, own !== undefined, changed, isArray, originalLength, atoms);
  return ret;
}

// Whether a write of a key `target` does not own reaches a setter, or a
// proxy, up its prototype chain.
function inheritsAccessor(target: Target, key: PropertyKey): boolean {
  for (
    let proto = Object.getPrototypeOf(target);
    proto !== null;
    proto = Object.getPrototypeOf(proto)
  ) {
    if (targets.has(proto)) {
      return true;
    }
    const desc = Reflect.getOwnPropertyDescriptor(proto, key);
    if (desc !== undefined) {
      return !("value" in desc);
    }
  }
  return false;
}

// Notifies a write of `key`: its creation, its value, and for an array its
// length and items. An array's length is compared with the length before the
// write, not with the value the trap is given: an index written past the end
// has already grown it.
function onWriteKey(
  target: any,
  key: PropertyKey,
  hadKey: boolean,
  changed: boolean,
  isArray: boolean,
  originalLength: number,
  atoms: Target
): void {
  if (!hadKey && objectHasOwnProperty.call(target, key)) {
    onWriteKeyCreated(atoms, key, originalLength);
    if (isArray && !changed) {
      onWriteItems(target);
    }
  }
  if (isArray && key === "length") {
    const length = target.length;
    if (length !== originalLength) {
      onWriteTargetKey(target, key);
      if (length < originalLength) {
        onWriteTargetKey(target, KEYCHANGES);
        onWriteDroppedIndices(target, length, originalLength);
      }
      onWriteItems(target);
    }
  } else if (changed) {
    onWriteTargetKey(atoms, key);
    if (isArray) {
      onWriteItems(target);
    }
  }
}

// An array's items, as one atom: read by a loop that reads them all at once
// (readArrayItems), notified by any write of an index or of the length.
const itemsAtoms = new WeakMap<Target, Atom>();

function onWriteItems(target: Target): void {
  const atom = itemsAtoms.get(target);
  if (atom !== undefined) {
    onWriteAtom(atom);
  }
}

// whether a read of `raw` itself sees what a read through its proxy would: true
// of a plain array, not of a subclass, which may answer from elsewhere
function isPlainArray(raw: object): boolean {
  return Object.getPrototypeOf(raw) === Array.prototype;
}

/**
 * The items of `array`, a proxy() of a plain array, read at once: one
 * subscription for the whole array instead of one per index, and each object
 * item handed out as its proxy, as an index read through the proxy would. For
 * any other array (a raw one, a collection signal's shallow value, an observe()
 * view, a subclass of Array) the array itself, to be read as usual. A subclass
 * may answer its index reads from elsewhere (its own proxy, getters), which a
 * read of the raw target would neither see nor subscribe to.
 */
export function readArrayItems<T>(array: T[]): T[] {
  const raw = targets.get(array) as T[] | undefined;
  if (raw === undefined || deepProxies.get(raw) !== array || !isPlainArray(raw)) {
    return array;
  }
  if (isObserving()) {
    let atom = itemsAtoms.get(raw);
    if (atom === undefined) {
      atom = createAtom(undefined, "key");
      itemsAtoms.set(raw, atom);
    }
    onReadAtom(atom);
  }
  // the get trap hands out a frozen array's items raw (a proxy invariant)
  if (Object.isFrozen(raw)) {
    return raw.slice();
  }
  const length = raw.length;
  const items = new Array(length);
  for (let i = 0; i < length; i++) {
    items[i] = deepItem(raw[i]);
  }
  return items;
}

// what the get trap of a deep proxy hands out for `value`
function deepItem(value: any): any {
  if (typeof value !== "object" || value === null) {
    return value;
  }
  const reactive = deepProxies.get(value);
  if (reactive ? isMarkedRaw(value) : !canBeMadeReactive(value)) {
    return value;
  }
  return reactive ?? proxifyTarget(value, false);
}

function onWriteKeyCreated(target: Target, key: PropertyKey, originalLength: number): void {
  onWriteKeyPresence(target, key);
  // an index past the end grows the array without a length write going
  // through the set trap
  if (key !== "length" && Array.isArray(target) && target.length !== originalLength) {
    onWriteTargetKey(target, "length");
  }
}

// Methods a proxy replaces, by the function its read would return. The array
// methods that write several keys run as one batch: an immediate computation sees the array before or after the
// call, not in between. Those that search an item by identity also find the
// raw object of an item they read as its proxy.
const replacedMethods = new Map<Function, Function>();
for (const name of ["copyWithin", "fill", "reverse", "sort"] as const) {
  const method = Array.prototype[name] as Function;
  replacedMethods.set(method, function (this: unknown[], ...args: unknown[]) {
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
  replacedMethods.set(method, function (this: unknown[], ...args: unknown[]) {
    return batch(() => untrack(() => method.apply(this, args)));
  });
}
for (const name of ["includes", "indexOf", "lastIndexOf"] as const) {
  const method = Array.prototype[name] as Function;
  replacedMethods.set(method, function (this: unknown[], ...args: unknown[]) {
    const result = method.apply(this, args);
    if (result !== -1 && result !== false) {
      return result;
    }
    // the call above read every item through the proxy, which observes them
    return method.apply(toRaw(this), [toRaw(args[0] as object), ...args.slice(1)]);
  });
}

// hasOwnProperty reads the presence of the key it asks about, as `in` does
replacedMethods.set(objectHasOwnProperty, function (this: object, key: PropertyKey) {
  const raw = toRaw(this);
  onReadKeyPresence(propertyHosts.get(raw) ?? raw, typeof key === "symbol" ? key : String(key));
  return objectHasOwnProperty.call(raw, key);
});

function collectionType(target: Target): CollectionRawType | null {
  return target instanceof Map
    ? "Map"
    : target instanceof Set
      ? "Set"
      : target instanceof WeakMap
        ? "WeakMap"
        : null;
}

// A collection's own properties (a subclass's fields, an expando) have atoms
// of their own, keyed by this stand-in: an entry of the same key is another
// value.
const propertyHosts = new WeakMap<Target, Target>();

function propertyHost(target: Target): Target {
  let host = propertyHosts.get(target);
  if (host === undefined) {
    host = {};
    propertyHosts.set(target, host);
  }
  return host;
}

// `has` and `get`, observing the key they are asked about
function makeHas(target: any) {
  return (key: any) => {
    key = toRaw(key);
    onReadKeyPresence(target, key);
    return target.has(key);
  };
}

function makeGet(target: any, shallow: boolean) {
  return (key: any) => {
    key = toRaw(key);
    onReadTargetKey(target, key);
    return possiblyReactive(target.get(key), shallow);
  };
}

/**
 * Creates an iterator method (keys, values, entries, @@iterator) that observes
 * the key list, and a Map's values as it reads them. A deep proxy yields the
 * proxies of the objects. An entry is the fresh array the raw iterator made:
 * proxying it would only subscribe its reader to atoms no write can reach.
 */
function makeIteratorObserver(
  methodName: "keys" | "values" | "entries" | typeof Symbol.iterator,
  target: any,
  shallow: boolean
) {
  const isMap = target instanceof Map;
  if (methodName === "entries" || (methodName === Symbol.iterator && isMap)) {
    return function* () {
      onReadTargetKey(target, KEYCHANGES);
      for (const entry of target.entries()) {
        if (isMap) {
          onReadTargetKey(target, entry[0]);
        }
        if (!shallow) {
          entry[0] = possiblyReactive(entry[0], false);
          entry[1] = possiblyReactive(entry[1], false);
        }
        yield entry;
      }
    };
  }
  if (isMap && methodName === "values") {
    return function* () {
      onReadTargetKey(target, KEYCHANGES);
      for (const [key, value] of target.entries()) {
        onReadTargetKey(target, key);
        yield possiblyReactive(value, shallow);
      }
    };
  }
  // a Set's members, or a Map's keys, change only by being added or removed,
  // which the key list notifies
  return function* () {
    onReadTargetKey(target, KEYCHANGES);
    for (const key of target.keys()) {
      yield possiblyReactive(key, shallow);
    }
  };
}

/**
 * Creates a forEach that observes the key list, and a Map's values, and hands
 * out the proxies of the objects, and the proxy it is called through as the
 * collection.
 */
function makeForEachObserver(target: any, shallow: boolean) {
  const readsValues = target instanceof Map;
  return function forEach(
    this: unknown,
    callback: (value: any, key: any, collection: any) => void,
    thisArg?: any
  ) {
    const collection = this ?? possiblyReactive(target, shallow);
    onReadTargetKey(target, KEYCHANGES);
    target.forEach((value: any, key: any) => {
      if (readsValues) {
        onReadTargetKey(target, key);
      }
      callback.call(
        thisArg,
        possiblyReactive(value, shallow),
        possiblyReactive(key, shallow),
        collection
      );
    });
  };
}

type SetOperation =
  | "difference"
  | "intersection"
  | "isDisjointFrom"
  | "isSubsetOf"
  | "isSupersetOf"
  | "symmetricDifference"
  | "union";

// The keys of the set-like argument of a set operation, checked as the native
// operation checks it (GetSetRecord): a `size` that is a number, a callable
// `has` and `keys`. Its keys() iterator need not be iterable itself.
function setLikeKeys(other: any): Iterator<any> {
  if (other === null || (typeof other !== "object" && typeof other !== "function")) {
    throw new TypeError("The argument of a set operation must be an object");
  }
  const size = Number(other.size);
  if (Number.isNaN(size)) {
    throw new TypeError("The .size property is NaN");
  }
  if (size < 0) {
    throw new RangeError("The .size property must not be negative");
  }
  if (typeof other.has !== "function") {
    throw new TypeError("The .has property is not callable");
  }
  if (typeof other.keys !== "function") {
    throw new TypeError("The .keys property is not callable");
  }
  const keys = other.keys();
  if (keys === null || typeof keys !== "object") {
    throw new TypeError("The .keys() result is not an object");
  }
  return keys;
}

// The members of a set-like by their raw object: a shallow set may hold
// proxies, a deep one yields them, and either way a member is the same member
// as its raw object.
function membersByRaw(members: Iterator<any>): Map<any, any> {
  const byRaw = new Map();
  for (let step = members.next(); !step.done; step = members.next()) {
    byRaw.set(toRaw(step.value), step.value);
  }
  return byRaw;
}

/**
 * Creates a version of an ES2025 Set method (union, isSubsetOf...) that reads
 * the whole membership of the set, on members compared by their raw object,
 * so that any mix of shallow, deep and plain sets answers as the raw sets
 * would; a result is a fresh, plain Set holding the members as the sets hold
 * them, or a boolean. Reading `other`'s keys through it observes a reactive
 * one.
 */
function makeSetOperation(name: SetOperation, target: Set<any>) {
  return (other: any) => {
    const theirs = membersByRaw(setLikeKeys(other));
    onReadTargetKey(target, KEYCHANGES);
    const mine = membersByRaw(target.values());
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
 * Creates a writing method (set, add, delete) that notifies the presence of
 * its key when it changes, and the value of its key when it changes: a
 * Map's or WeakMap's value, a Set's membership.
 */
function delegateAndNotify(setterName: "set" | "add" | "delete", target: any, shallow: boolean) {
  const readsValue = setterName === "set" || (setterName === "delete" && !(target instanceof Set));
  return (key: any, value: any) => {
    key = toRaw(key);
    const hadKey = target.has(key);
    const before = readsValue && hadKey ? target.get(key) : undefined;
    // a shallow collection hands its values back as stored: keep the proxy
    const ret = target[setterName](key, shallow ? value : toRaw(value));
    const hasKey = setterName !== "delete";
    if (hadKey !== hasKey) {
      onWriteKeyPresence(target, key);
    }
    const after = readsValue && hasKey ? target.get(key) : undefined;
    if (readsValue ? !Object.is(before, after) : hadKey !== hasKey) {
      onWriteTargetKey(target, key);
    }
    if (!hasKey) {
      releaseKey(target, key);
    }
    return ret;
  };
}

// The atoms of a collection's keys may exist
function hasKeyAtoms(target: Target): boolean {
  return (
    itemAtoms.keys.has(target) ||
    itemAtoms.objectKeys.has(target) ||
    presenceAtoms.keys.has(target) ||
    presenceAtoms.objectKeys.has(target)
  );
}

/**
 * Creates a clear() that notifies the key list, and the presence and value of
 * each key that had atoms. An empty collection notifies nothing.
 */
function makeClearNotifier(target: Map<any, any> | Set<any>) {
  return () => {
    if (target.size === 0) {
      return;
    }
    const keys = hasKeyAtoms(target) ? [...target.keys()] : [];
    target.clear();
    onWriteTargetKey(target, KEYCHANGES);
    for (const key of keys) {
      onWriteTargetKey(target, key, presenceAtoms);
      onWriteTargetKey(target, key);
      releaseKey(target, key);
    }
  };
}

type MethodFactory = (target: any, shallow: boolean) => Function;

const setMethods: [PropertyKey, MethodFactory][] = [
  ["has", (target) => makeHas(target)],
  ["add", (target, shallow) => delegateAndNotify("add", target, shallow)],
  ["delete", (target, shallow) => delegateAndNotify("delete", target, shallow)],
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
  ["has", (target) => makeHas(target)],
  ["get", (target, shallow) => makeGet(target, shallow)],
  ["set", (target, shallow) => delegateAndNotify("set", target, shallow)],
  ["delete", (target, shallow) => delegateAndNotify("delete", target, shallow)],
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
 * The handler of a Set, Map or WeakMap proxy. Its methods are built on first
 * read and kept for the proxy: most proxies use a few of them. Its own
 * properties are read with the proxy as receiver, a subclass's getter reading
 * the entries through it, and observed apart from the entries.
 */
class CollectionHandler extends BasicHandler {
  factories: Map<PropertyKey, MethodFactory>;
  hasSize: boolean;
  methods = new Map<PropertyKey, Function>();

  constructor(target: Target, type: CollectionRawType, shallow: boolean) {
    super(shallow, propertyHost(target));
    this.factories = methodFactories[type];
    this.hasSize = type !== "WeakMap";
  }

  get(target: any, key: PropertyKey, receiver: any): any {
    const factory = this.factories.get(key);
    if (factory) {
      let method = this.methods.get(key);
      if (!method) {
        method = factory(target, this.shallow);
        this.methods.set(key, method);
      }
      return method;
    }
    if (key === "size" && this.hasSize) {
      onReadTargetKey(target, KEYCHANGES);
      return target.size;
    }
    onReadTargetKey(this.host!, key);
    let value;
    try {
      value = Reflect.get(target, key, receiver);
    } catch (error) {
      throw privateMemberError(error, target, key);
    }
    if (typeof value === "function") {
      return replacedMethods.get(value) ?? value;
    }
    return isLocked(target, key) ? value : possiblyReactive(value, this.shallow);
  }
}
