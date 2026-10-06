import { OwlError } from "./owl_error";
import {
  batch,
  getCurrentComputation,
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

// Special keys to subscribe to: the key list, notified of a key's creation or
// deletion; an array's items as one atom, notified by any write of an index or
// of the length (read by readArrayItems and the searches). Their descriptions
// name them in the debug log.
const KEYCHANGES = Symbol("(keys)");
const ITEMS = Symbol("items");

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
 * The deep proxy of `value` when it can have one, `value` itself otherwise
 * (and always for a shallow proxy, which hands its values out as stored). The
 * proxy an object read before already has spares the checks proxifyTarget
 * would make (twice) to find it.
 */
function reactiveValue(value: any, shallow: boolean): any {
  if (shallow || typeof value !== "object" || value === null) {
    return value;
  }
  const reactive = deepProxies.get(value);
  if (reactive ? isMarkedRaw(value) : !canBeMadeReactive(value)) {
    return value;
  }
  return reactive ?? proxifyTarget(value, false);
}

const skipped = new WeakSet<Target>();
// class prototypes marked raw: an object inheriting from one is raw too
const rawPrototypes = new WeakSet<Target>();
let hasRawPrototypes = false;
// what every plain object, array, collection or function inherits from
const builtinPrototypes = new Set<object>([
  Object.prototype,
  Array.prototype,
  Map.prototype,
  Set.prototype,
  WeakMap.prototype,
  Function.prototype,
]);

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
  if (builtinPrototypes.has(raw)) {
    throw new OwlError(
      `markRaw(${raw.constructor.name}.prototype) would leave every ${raw.constructor.name} ` +
        `unobserved: mark the objects themselves, or the prototype of a class of your own`
    );
  }
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
// SpiderMonkey, JavaScriptCore. The member's name, or its class's, is captured
// where the message gives it.
const PRIVATE_MEMBER_ERROR =
  /^(?:Cannot (?:read|write) private member (#\S+)|Receiver must be an instance of class (\S+)|can't access private field or method|Cannot access invalid private field \(evaluating '[^']*?(#[\w$]+))/;

function privateMemberError(error: unknown, target: Target, key: PropertyKey): unknown {
  if (!(error instanceof TypeError)) {
    return error;
  }
  const match = PRIVATE_MEMBER_ERROR.exec(error.message);
  if (match === null) {
    return error;
  }
  const member = match[1] ?? match[3];
  const className = match[2];
  if (
    (member !== undefined || className !== undefined) &&
    !classOfTarget(target, (ctor) =>
      member !== undefined ? declaresPrivate(ctor, member) : ctor.name === className
    )
  ) {
    // the member belongs to no class of the target: the proxy did not cause it
    return error;
  }
  const name = (target as any).constructor?.name || "TheClass";
  return new OwlError(
    `Cannot reach "${String(key)}" of a ${name} through a reactive proxy: ${error.message}. ` +
      `A proxy has no private members: mark the class raw with markRaw(${name}.prototype)`,
    { cause: error }
  );
}

// Whether a class up the prototype chain of `target` passes `test`.
function classOfTarget(target: Target, test: (ctor: Function) => boolean): boolean {
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const desc = Reflect.getOwnPropertyDescriptor(proto, "constructor");
    if (desc !== undefined && typeof desc.value === "function" && test(desc.value)) {
      return true;
    }
  }
  return false;
}

// Whether the source of class `ctor` names the private member `member`.
function declaresPrivate(ctor: Function, member: string): boolean {
  const name = member.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${name}(?![\\w$])`).test(Function.prototype.toString.call(ctor));
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

interface AtomTable {
  get(key: any): Atom | undefined;
  set(key: any, atom: Atom): unknown;
  delete(key: any): boolean;
}

// a key's value, read by a get
const itemAtoms: KeyAtoms = { keys: new WeakMap(), objectKeys: new WeakMap() };
// a key's presence, read by `in` / has(): notified when the key appears or
// disappears, not when its value changes
const presenceAtoms: KeyAtoms = { keys: new WeakMap(), objectKeys: new WeakMap() };
const allAtoms = [itemAtoms, presenceAtoms];

function isObjectKey(key: unknown): key is object {
  return (typeof key === "object" && key !== null) || typeof key === "function";
}

function tablesOf(atoms: KeyAtoms, key: unknown): WeakMap<Target, AtomTable> {
  return isObjectKey(key) ? atoms.objectKeys : atoms.keys;
}

// the table of the atoms of `target`'s keys of the kind of `key`, made on first use
function keyTable(target: Target, key: unknown, atoms: KeyAtoms): AtomTable {
  const tables = tablesOf(atoms, key);
  let table = tables.get(target);
  if (table === undefined) {
    tables.set(target, (table = isObjectKey(key) ? new WeakMap() : new Map()));
  }
  return table;
}

function atomOf(table: AtomTable, key: unknown): Atom {
  let atom = table.get(key);
  if (atom === undefined) {
    table.set(key, (atom = createAtom(undefined, "key")));
  }
  return atom;
}

function findAtom(target: Target, key: unknown, atoms: KeyAtoms): Atom | undefined {
  return tablesOf(atoms, key).get(target)?.get(key);
}

/**
 * Subscribes the current computation to the value (or the presence) of `key`
 * on `target`.
 *
 * @param target the target whose key is read
 * @param key the key read (or `KEYCHANGES` for the key list, `ITEMS` for an
 *   array's items)
 * @param atoms the value atoms (default) or the presence atoms
 */
function onReadTargetKey(target: Target, key: unknown, atoms: KeyAtoms = itemAtoms): void {
  // a read nobody observes subscribes nothing, and creates no atom for its
  // key: a model building its records outside any render reads thousands
  if (isObserving()) {
    if (debug.reactivity) {
      debugRead(target, key, atoms);
    }
    onReadAtom(atomOf(keyTable(target, key, atoms), key));
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
function onWriteTargetKey(target: Target, key: unknown, atoms: KeyAtoms = itemAtoms): void {
  const atom = findAtom(target, key, atoms);
  if (atom) {
    if (debug.reactivity) {
      debugLog("reactivity", `proxy write ${describeKey(key)}`, target);
    }
    onWriteAtom(atom);
  }
}

function describeKey(key: unknown): string {
  return key === KEYCHANGES || key === ITEMS ? key.description! : String(key);
}

// which atom a tracked proxy read subscribes to, and who reads it: what a
// "why does this not re-render" question needs
function debugRead(target: Target, key: unknown, atoms: KeyAtoms): void {
  const reader = getCurrentComputation();
  const what = atoms === presenceAtoms ? `presence of ${String(key)}` : describeKey(key);
  debugLog(
    "reactivity",
    `proxy read ${what} by ${reader ? reader.name || "a computation" : "an observe() view"}`,
    target
  );
}

// a key appeared or disappeared: the key list and the key's presence
function onWriteKeyPresence(target: Target, key: unknown): void {
  onWriteTargetKey(target, KEYCHANGES);
  onWriteTargetKey(target, key, presenceAtoms);
}

// A removed key's atoms that nothing observes are dropped: kept, every key a
// long-lived object ever had would stay allocated, object keys included. A
// later read creates them again.
function releaseKey(target: Target, key: unknown): void {
  for (const atoms of allAtoms) {
    const table = tablesOf(atoms, key).get(target);
    const atom = table?.get(key);
    if (atom !== undefined && !hasObservers(atom)) {
      table!.delete(key);
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
  for (const atoms of allAtoms) {
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
  const handler = type ? new CollectionHandler(type, shallow) : new BasicHandler(shallow);
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

// the proxy each observe() view reads through, so that a view of a view
// observes the same target instead of stacking observers
const viewBases = new WeakMap<object, any>();

/**
 * Returns a view of `target` that calls `callback` the first time a value read
 * through the view changes, synchronously, as OWL 2's `reactive(target,
 * callback)` did. The subscription is one-shot: once `callback` ran, only the
 * values read through the view again are observed. Objects read through the
 * view are views too, with the same callback; reads keep subscribing the
 * computation they happen in (a render, an effect) as a plain proxy read does.
 * An array method that changes the length (push, splice...) reads it through
 * the view, so a push calls the callback, as OWL 2's reactive() did.
 *
 * @param target the object to observe
 * @param callback called when an observed value changes
 * @returns a view of the proxy of `target`
 */
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
    const type = collectionType(raw);
    const collectionMethods = type ? methodFactories[type] : null;
    // the functions handed out for the methods the view runs on its proxy
    let methods: Map<Function, Function> | null = null;
    const method = (value: Function, make: () => Function): Function => {
      let result = (methods ??= new Map()).get(value);
      if (result === undefined) {
        result = make();
        methods.set(value, result);
      }
      return result;
    };
    const self: any = new Proxy(reactive, {
      get(r, key, receiver) {
        // the view is the receiver: a getter, or a target that is itself a
        // proxy, reads through it and so subscribes the callback
        const value = read(() => Reflect.get(r, key, receiver));
        if (typeof value === "function") {
          if (collectionMethods?.has(key)) {
            return method(value, () =>
              key === "forEach"
                ? (callback: Function, thisArg?: any) => {
                    for (const [k, v] of observedIterator(read(() => r.entries()))) {
                      callback.call(thisArg, v, k, self);
                    }
                  }
                : (...args: any[]) => {
                    const result = read(() => value.apply(r, args));
                    return isIterator(result) ? observedIterator(result) : wrap(result);
                  }
            );
          }
          if (viewReaders.has(value)) {
            return method(
              value,
              () =>
                (...args: any[]) =>
                  read(() => value.apply(r, args))
            );
          }
          return value;
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
    result = self;
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
  keyAtoms: AtomTable | undefined;

  constructor(shallow: boolean) {
    this.shallow = shallow;
    this.keyAtoms = undefined;
  }

  // what the atoms of the target's own properties are keyed by: the target,
  // or for a collection an object standing for its properties
  host(target: Target): Target {
    return target;
  }

  get(target: any, key: PropertyKey, receiver: any): any {
    // a read nobody observes subscribes nothing, and creates no atom for its
    // key: a model building its records outside any render reads thousands
    if (isObserving()) {
      if (debug.reactivity) {
        debugRead(target, key, itemAtoms);
      }
      onReadAtom(atomOf((this.keyAtoms ??= keyTable(this.host(target), key, itemAtoms)), key));
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
    const result = reactiveValue(value, this.shallow);
    return result !== value && isLocked(target, key) ? value : result;
  }

  set(target: any, key: PropertyKey, value: any, receiver: any): boolean {
    // a write subscribes nothing, though a getter or setter it runs reads
    // through the proxy
    const shallow = this.shallow;
    const atoms = this.host(target);
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
      const atoms = this.host(target);
      onWriteKeyPresence(atoms, key);
      onWriteTargetKey(atoms, key);
      releaseKey(atoms, key);
      if (Array.isArray(target)) {
        onWriteItems(target);
      }
    }
    return ret;
  }

  ownKeys(target: any): ArrayLike<string | symbol> {
    onReadTargetKey(this.host(target), KEYCHANGES);
    return Reflect.ownKeys(target);
  }

  has(target: any, key: PropertyKey): boolean {
    onReadTargetKey(this.host(target), key, presenceAtoms);
    return Reflect.has(target, key);
  }
}

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
  const own = Reflect.getOwnPropertyDescriptor(target, key);
  // An own data property runs no code. Any other write may reach a setter: one
  // batch, so a setter writing other keys runs an immediate reader of them and
  // of this key once, after the write.
  return own !== undefined && "value" in own
    ? write(target, key, stored, receiver, own, atoms)
    : batch(() => write(target, key, stored, receiver, own, atoms));
}

// The write itself, with the reactive proxy as the receiver: an accessor runs
// with it as `this`, and a target behind its own Proxy sees it in its set trap.
// A write that failed changed nothing.
function write(
  target: any,
  key: PropertyKey,
  stored: any,
  receiver: any,
  own: PropertyDescriptor | undefined,
  atoms: Target
): boolean {
  const isArray = Array.isArray(target);
  const originalLength = isArray ? target.length : 0;
  const originalValue =
    own !== undefined && "value" in own ? own.value : Reflect.get(target, key, receiver);
  if (!Reflect.set(target, key, stored, receiver)) {
    return false;
  }
  const changed =
    !(isArray && key === "length") && !Object.is(originalValue, Reflect.get(target, key, receiver));
  onWriteKey(target, key, own !== undefined, changed, isArray, originalLength, atoms);
  return true;
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

// The items atom of an array (ITEMS) is notified without a debug line: the
// line of the index or length written stands for it.
function onWriteItems(target: Target): void {
  const atom = findAtom(target, ITEMS, itemAtoms);
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
  onReadTargetKey(raw, ITEMS);
  // the get trap hands out a frozen array's items raw (a proxy invariant)
  if (Object.isFrozen(raw)) {
    return raw.slice();
  }
  const length = raw.length;
  const items = new Array(length);
  for (let i = 0; i < length; i++) {
    items[i] = reactiveValue(raw[i], false);
  }
  return items;
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
// Called on an observe() view they still read through it, which subscribes
// the view: a push through it calls its callback, as OWL 2's reactive() did.
for (const name of ["pop", "push", "shift", "splice", "unshift"] as const) {
  const method = Array.prototype[name] as Function;
  replacedMethods.set(method, function (this: unknown[], ...args: unknown[]) {
    return batch(() => untrack(() => method.apply(this, args)));
  });
}
// The replaced methods that read through something other than the proxy's
// traps: an observe() view runs them on its proxy, observed.
const viewReaders = new Set<Function>();

// The searches of a plain array read its items as one atom, as readArrayItems
// does, and search the raw array: a search reading each index through the
// proxy would make an atom per index, and a proxy per object item, for an
// answer that depends on every item anyway. Any other array (a subclass, which
// may keep its items elsewhere and map its indices through its own traps) is
// searched through the proxy, each index read tracked. An object is looked for
// as given, then as its raw object (which a deep array holds).
for (const name of ["includes", "indexOf", "lastIndexOf"] as const) {
  const method = Array.prototype[name] as Function;
  const search = function (this: unknown[], ...args: unknown[]) {
    const raw = toRaw(this);
    const plain = isPlainArray(raw);
    if (plain) {
      onReadTargetKey(raw, ITEMS);
    }
    const result = method.apply(plain ? raw : this, args);
    const item = args[0];
    if (result !== -1 && result !== false) {
      return result;
    }
    // a plain array holds no proxy: only a proxy argument can still match
    if (plain && (typeof item !== "object" || item === null || toRaw(item) === item)) {
      return result;
    }
    args[0] = toRaw(item as object);
    return method.apply(raw, args);
  };
  replacedMethods.set(method, search);
  viewReaders.add(search);
}

// hasOwnProperty reads the presence of the key it asks about, as `in` does
const hasOwnPropertyReader = function (this: object, key: PropertyKey) {
  const raw = toRaw(this);
  onReadTargetKey(
    collectionType(raw) ? propertyHost(raw) : raw,
    typeof key === "symbol" ? key : String(key),
    presenceAtoms
  );
  return objectHasOwnProperty.call(raw, key);
};
replacedMethods.set(objectHasOwnProperty, hasOwnPropertyReader);
viewReaders.add(hasOwnPropertyReader);

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
    propertyHosts.set(target, (host = {}));
  }
  return host;
}

// `has` and `get`, observing the key they are asked about
function makeHas(target: any) {
  return (key: any) => {
    key = toRaw(key);
    onReadTargetKey(target, key, presenceAtoms);
    return target.has(key);
  };
}

function makeGet(target: any, shallow: boolean) {
  return (key: any) => {
    key = toRaw(key);
    onReadTargetKey(target, key);
    return reactiveValue(target.get(key), shallow);
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
          entry[0] = reactiveValue(entry[0], false);
          entry[1] = reactiveValue(entry[1], false);
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
        yield reactiveValue(value, shallow);
      }
    };
  }
  // a Set's members, or a Map's keys, change only by being added or removed,
  // which the key list notifies
  return function* () {
    onReadTargetKey(target, KEYCHANGES);
    for (const key of target.keys()) {
      yield reactiveValue(key, shallow);
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
    const collection = this ?? reactiveValue(target, shallow);
    onReadTargetKey(target, KEYCHANGES);
    target.forEach((value: any, key: any) => {
      if (readsValues) {
        onReadTargetKey(target, key);
      }
      callback.call(
        thisArg,
        reactiveValue(value, shallow),
        reactiveValue(key, shallow),
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
 * the entries through it, and observed apart from the entries. The table of
 * its methods and the stand-in its properties' atoms are keyed by are made
 * when first needed: most collection proxies are made, iterated and dropped.
 */
class CollectionHandler extends BasicHandler {
  factories: Map<PropertyKey, MethodFactory>;
  hasSize: boolean;
  methods: Map<PropertyKey, Function> | undefined = undefined;
  properties: Target | undefined = undefined;

  constructor(type: CollectionRawType, shallow: boolean) {
    super(shallow);
    this.factories = methodFactories[type];
    this.hasSize = type !== "WeakMap";
  }

  get(target: any, key: PropertyKey, receiver: any): any {
    const factory = this.factories.get(key);
    if (factory) {
      const methods = (this.methods ??= new Map());
      let method = methods.get(key);
      if (!method) {
        method = factory(target, this.shallow);
        methods.set(key, method);
      }
      return method;
    }
    if (key === "size" && this.hasSize) {
      onReadTargetKey(target, KEYCHANGES);
      return target.size;
    }
    return super.get(target, key, receiver);
  }

  host(target: Target): Target {
    return (this.properties ??= propertyHost(target));
  }
}
