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

const KEYCHANGES = Symbol("(keys)");
const ITEMS = Symbol("items");

type Target = object;
type Reactive<T extends Target> = T;

const objectToString = Object.prototype.toString;
const objectHasOwnProperty = Object.prototype.hasOwnProperty;

function canBeMadeReactive(value: any): boolean {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const raw = toRaw(value);
  return (
    Array.isArray(raw) ||
    collectionMethods(raw) !== null ||
    objectToString.call(raw) === "[object Object]"
  );
}
function reactiveValue(value: any, shallow: boolean): any {
  if (shallow || typeof value !== "object" || value === null) {
    return value;
  }
  const reactive = deepProxies.get(value);
  if (reactive ? isMarkedRaw(value) : !canBeMadeReactive(value)) {
    return value;
  }
  return reactive ?? proxifyCheckedTarget(value, false);
}

const skipped = new WeakSet<Target>();
const rawPrototypes = new WeakSet<Target>();
let hasRawPrototypes = false;
const builtinPrototypes = /* @__PURE__ */ builtinPrototypeSet();

function builtinPrototypeSet(): Set<object> {
  return new Set([
    Object.prototype,
    Array.prototype,
    Map.prototype,
    Set.prototype,
    WeakMap.prototype,
    Function.prototype,
  ]);
}

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
    Object.hasOwn(value, "constructor") &&
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

function isLocked(target: Target, key: PropertyKey): boolean {
  const desc = Reflect.getOwnPropertyDescriptor(target, key);
  return (
    desc !== undefined &&
    desc.configurable === false &&
    ("value" in desc ? desc.writable === false : desc.get === undefined)
  );
}

const PRIVATE_MEMBER_ERROR =
  /^(?:Cannot (?:read|write) private member (#\S+)|Receiver must be an instance of class (\S+)|can't access private field or method|Cannot access invalid private field \(evaluating '[^']*?(#[\w$]+))/;

function privateMemberError(error: unknown, target: Target, key: PropertyKey): unknown {
  const match = error instanceof TypeError && PRIVATE_MEMBER_ERROR.exec(error.message);
  if (!match || !declaresMember(target, match[1] ?? match[3], match[2])) {
    return error;
  }
  const name = (target as any).constructor?.name || "TheClass";
  return new OwlError(
    `Cannot reach "${String(key)}" of a ${name} through a reactive proxy: ${match.input}. ` +
      `A proxy has no private members: mark the class raw with markRaw(${name}.prototype)`,
    { cause: error }
  );
}

function declaresMember(target: Target, member?: string, className?: string): boolean {
  if (member === undefined && className === undefined) {
    return true;
  }
  for (let proto = Object.getPrototypeOf(target); proto; proto = Object.getPrototypeOf(proto)) {
    const ctor = Object.hasOwn(proto, "constructor") ? proto.constructor : undefined;
    if (
      typeof ctor === "function" &&
      (className !== undefined
        ? ctor.name === className
        : Function.prototype.toString.call(ctor).match(PRIVATE_NAMES)?.includes(member!))
    ) {
      return true;
    }
  }
  return false;
}

const PRIVATE_NAMES = /#[\p{ID_Continue}$\u200c\u200d]+/gu;

export function toRaw<T extends Target, U extends Reactive<T>>(value: U | T): T {
  return (targets.get(value) as T | undefined) ?? (value as T);
}

interface KeyAtoms {
  keys: WeakMap<Target, Map<PropertyKey, Atom>>;
  weakKeys: WeakMap<Target, WeakMap<WeakKey, Atom>>;
}

interface AtomTable {
  get(key: any): Atom | undefined;
  set(key: any, atom: Atom): unknown;
  delete(key: any): boolean;
}

const itemAtoms: KeyAtoms = { keys: new WeakMap(), weakKeys: new WeakMap() };
const presenceAtoms: KeyAtoms = { keys: new WeakMap(), weakKeys: new WeakMap() };
const allAtoms = [itemAtoms, presenceAtoms];

function isWeakKey(key: unknown): key is WeakKey {
  return (
    (typeof key === "object" && key !== null) || typeof key === "function" || isWeakSymbol(key)
  );
}

function isWeakSymbol(key: unknown): key is symbol {
  return typeof key === "symbol" && Symbol.keyFor(key) === undefined;
}

function tablesOf(atoms: KeyAtoms, key: unknown): WeakMap<Target, AtomTable> {
  return isWeakKey(key) ? atoms.weakKeys : atoms.keys;
}

function keyTable(target: Target, key: unknown, atoms: KeyAtoms): AtomTable {
  const tables = tablesOf(atoms, key);
  let table = tables.get(target);
  if (table === undefined) {
    tables.set(target, (table = isWeakKey(key) ? new WeakMap() : new Map()));
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

function onReadTargetKey(target: Target, key: unknown, atoms: KeyAtoms = itemAtoms): void {
  if (isObserving()) {
    if (debug.reactivity) {
      debugRead(target, key, atoms);
    }
    onReadAtom(atomOf(keyTable(target, key, atoms), key));
  }
}

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

function debugRead(target: Target, key: unknown, atoms: KeyAtoms): void {
  const reader = getCurrentComputation();
  const what = atoms === presenceAtoms ? `presence of ${String(key)}` : describeKey(key);
  debugLog(
    "reactivity",
    `proxy read ${what} by ${reader ? reader.name || "a computation" : "an observe() view"}`,
    target
  );
}

function onWriteKeyPresence(target: Target, key: unknown): void {
  onWriteTargetKey(target, KEYCHANGES);
  onWriteTargetKey(target, key, presenceAtoms);
}

function releaseKey(target: Target, key: unknown): void {
  for (const atoms of allAtoms) {
    const table = tablesOf(atoms, key).get(target);
    const atom = table?.get(key);
    if (atom !== undefined && !hasObservers(atom)) {
      table!.delete(key);
    }
  }
}

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

const targets = new WeakMap<Reactive<Target>, Target>();
const deepProxies = new WeakMap<Target, Reactive<Target>>();
const shallowProxies = new WeakMap<Target, Reactive<Target>>();

export function proxifyTarget<T extends Target>(target: T, shallow: boolean): T {
  if (!canBeMadeReactive(target)) {
    throw new OwlError(`Cannot make the given value reactive`);
  }
  return proxifyCheckedTarget(target, shallow);
}

function proxifyCheckedTarget<T extends Target>(target: T, shallow: boolean): T {
  const raw = targets.get(target);
  if (raw) {
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

  const methodKeys = collectionMethods(target);
  const handler = methodKeys
    ? new CollectionHandler(methodKeys, shallow)
    : new BasicHandler(shallow);
  const proxy = new Proxy(target, handler as ProxyHandler<T>) as Reactive<T>;

  cache.set(target, proxy);
  targets.set(proxy, target);

  return proxy;
}

export function proxy<T extends Target>(target: T): T {
  return proxifyTarget(target, false);
}

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
  const wrap = (value: any): any => (targets.has(value) ? view(value) : value);
  function view(target: any): any {
    const reactive = viewBases.get(target) ?? target;
    const known = views.get(reactive);
    if (known) {
      return known;
    }
    const raw = toRaw(reactive);
    const methodKeys = collectionMethods(raw);
    let methods: Map<Function, Function> | undefined;
    const self: any = new Proxy(reactive, {
      get(r, key, receiver) {
        const value = read(() => Reflect.get(r, key, receiver));
        if (typeof value !== "function") {
          const result = wrap(value);
          return result !== value && isLocked(raw, key) ? value : result;
        }
        if (isLocked(raw, key)) {
          return value;
        }
        if (!methodKeys?.has(key) && !viewReaders.has(value)) {
          return value;
        }
        let method = (methods ??= new Map()).get(value);
        if (!method) {
          methods.set(
            value,
            (method =
              methodKeys && key === "forEach"
                ? (callback: Function, thisArg?: any) => {
                    for (const [k, v] of self.entries()) {
                      callback.call(thisArg, v, k, self);
                    }
                  }
                : (...args: any[]) => {
                    const result = read(() => value.apply(r, args));
                    const entries =
                      key === "entries" || (key === Symbol.iterator && raw instanceof Map);
                    return isIterator(result) ? observedIterator(result, entries) : wrap(result);
                  })
          );
        }
        return method;
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
    views.set(reactive, self);
    viewBases.set(self, reactive);
    targets.set(self, raw);
    return self;
  }
  function* observedIterator(iterator: Iterator<any>, entries: boolean): IterableIterator<any> {
    let done = false;
    try {
      while (true) {
        const step = read(() => iterator.next());
        if (step.done) {
          done = true;
          return step.value;
        }
        yield entries ? step.value.map(wrap) : wrap(step.value);
      }
    } finally {
      if (!done) {
        read(() => iterator.return?.());
      }
    }
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

class BasicHandler implements ProxyHandler<any> {
  shallow: boolean;
  keyAtoms: AtomTable | undefined;
  weakKeyAtoms: AtomTable | undefined;

  constructor(shallow: boolean) {
    this.shallow = shallow;
    this.keyAtoms = undefined;
    this.weakKeyAtoms = undefined;
  }

  host(target: Target): Target {
    return target;
  }

  get(target: any, key: PropertyKey, receiver: any): any {
    if (isObserving()) {
      if (debug.reactivity) {
        debugRead(target, key, itemAtoms);
      }
      const table = isWeakSymbol(key)
        ? (this.weakKeyAtoms ??= keyTable(this.host(target), key, itemAtoms))
        : (this.keyAtoms ??= keyTable(this.host(target), key, itemAtoms));
      onReadAtom(atomOf(table, key));
    }
    let value;
    try {
      value = Reflect.get(target, key, receiver);
    } catch (error) {
      throw privateMemberError(error, target, key);
    }
    if (typeof value === "function") {
      const result = replacedMethods.get(value) ?? value;
      return result !== value && isLocked(target, key) ? value : result;
    }
    const result = reactiveValue(value, this.shallow);
    return result !== value && isLocked(target, key) ? value : result;
  }

  set(target: any, key: PropertyKey, value: any, receiver: any): boolean {
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
    const hadKey = Object.hasOwn(target, key);
    const ret = Reflect.deleteProperty(target, key);
    if (hadKey && ret) {
      batch(() => {
        const atoms = this.host(target);
        onWriteKeyPresence(atoms, key);
        onWriteTargetKey(atoms, key);
        releaseKey(atoms, key);
        if (Array.isArray(target)) {
          onWriteItems(target);
        }
      });
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
  const stored = shallow ? value : toRaw(value);
  const own = Reflect.getOwnPropertyDescriptor(target, key);
  return own !== undefined && "value" in own && !Array.isArray(target)
    ? write(target, key, stored, receiver, own, atoms)
    : batch(() => write(target, key, stored, receiver, own, atoms));
}

function write(
  target: any,
  key: PropertyKey,
  stored: any,
  receiver: any,
  own: PropertyDescriptor | undefined,
  atoms: Target
): boolean {
  const isArray = Array.isArray(target);
  const length = isArray ? target.length : 0;
  const before =
    own !== undefined && "value" in own ? own.value : Reflect.get(target, key, receiver);
  if (!Reflect.set(target, key, stored, receiver)) {
    return false;
  }
  if (isArray && key === "length") {
    if (target.length !== length) {
      onWriteTargetKey(target, key);
      if (target.length < length) {
        onWriteTargetKey(target, KEYCHANGES);
        onWriteDroppedIndices(target, target.length, length);
      }
      onWriteItems(target);
    }
    return true;
  }
  const created = own === undefined && Object.hasOwn(target, key);
  const changed = !Object.is(before, Reflect.get(target, key, receiver));
  if (created) {
    onWriteKeyPresence(atoms, key);
  }
  if (isArray && target.length !== length) {
    onWriteTargetKey(target, "length");
  }
  if (changed) {
    onWriteTargetKey(atoms, key);
  }
  if (isArray && (created || changed)) {
    onWriteItems(target);
  }
  return true;
}

function onWriteItems(target: Target): void {
  const atom = findAtom(target, ITEMS, itemAtoms);
  if (atom !== undefined) {
    onWriteAtom(atom);
  }
}

function isPlainArray(raw: object): boolean {
  return Object.getPrototypeOf(raw) === Array.prototype;
}

export function readArrayItems<T>(array: T[]): T[] {
  const raw = targets.get(array) as T[] | undefined;
  if (raw === undefined || deepProxies.get(raw) !== array || !isPlainArray(raw)) {
    return array;
  }
  onReadTargetKey(raw, ITEMS);
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

const viewReaders = new Set<Function>();
const replacedMethods = /* @__PURE__ */ replaceMethods();

function replaceMethods(): Map<Function, Function> {
  const replaced = new Map<Function, Function>();
  for (const name of ["copyWithin", "fill", "reverse", "sort"] as const) {
    const method = Array.prototype[name] as Function;
    replaced.set(method, function (this: unknown[], ...args: unknown[]) {
      return batch(() => method.apply(this, args));
    });
  }
  for (const name of ["pop", "push", "shift", "splice", "unshift"] as const) {
    const method = Array.prototype[name] as Function;
    replaced.set(method, function (this: unknown[], ...args: unknown[]) {
      return batch(() => untrack(() => method.apply(this, args)));
    });
  }

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
      if (plain && (typeof item !== "object" || item === null || toRaw(item) === item)) {
        return result;
      }
      args[0] = toRaw(item as object);
      return method.apply(raw, args);
    };
    replaced.set(method, search);
    viewReaders.add(search);
  }

  const hasOwnPropertyReader = function (this: object, key: PropertyKey) {
    const raw = toRaw(this);
    onReadTargetKey(
      collectionMethods(raw) ? propertyHost(raw) : raw,
      typeof key === "symbol" ? key : String(key),
      presenceAtoms
    );
    return Object.hasOwn(raw, key);
  };
  replaced.set(objectHasOwnProperty, hasOwnPropertyReader);
  viewReaders.add(hasOwnPropertyReader);
  return replaced;
}

const propertyHosts = new WeakMap<Target, Target>();

function propertyHost(target: Target): Target {
  let host = propertyHosts.get(target);
  if (host === undefined) {
    propertyHosts.set(target, (host = {}));
  }
  return host;
}

function makeMethod(key: PropertyKey, target: any, shallow: boolean): Function {
  switch (key) {
    case "has":
      return (item: any) => {
        item = toRaw(item);
        onReadTargetKey(target, item, presenceAtoms);
        return target.has(item);
      };
    case "get":
      return (item: any) => {
        item = toRaw(item);
        onReadTargetKey(target, item);
        return reactiveValue(target.get(item), shallow);
      };
    case "getOrInsert":
    case "getOrInsertComputed":
      return makeGetOrInsert(key, target, shallow);
    case "add":
    case "set":
    case "delete":
      return delegateAndNotify(key, target, shallow);
    case "clear":
      return makeClearNotifier(target);
    case "forEach":
      return makeForEachObserver(target, shallow);
    case "keys":
    case "values":
    case "entries":
    case Symbol.iterator:
      return makeIteratorObserver(key, target, shallow);
  }
  return makeSetOperation(key as string, target);
}

function makeIteratorObserver(methodName: PropertyKey, target: any, shallow: boolean) {
  const isMap = target instanceof Map;
  const entries = methodName === "entries" || (methodName === Symbol.iterator && isMap);
  const readsValues = isMap && methodName !== "keys";
  return function* () {
    onReadTargetKey(target, KEYCHANGES);
    for (const item of entries || readsValues ? target.entries() : target.keys()) {
      if (readsValues) {
        onReadTargetKey(target, item[0]);
      }
      if (!entries) {
        yield reactiveValue(readsValues ? item[1] : item, shallow);
      } else {
        if (!shallow) {
          item[0] = reactiveValue(item[0], false);
          item[1] = reactiveValue(item[1], false);
        }
        yield item;
      }
    }
  };
}

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

function membersByRaw(members: Iterator<any>): Map<any, any> {
  const byRaw = new Map();
  for (let step = members.next(); !step.done; step = members.next()) {
    byRaw.set(toRaw(step.value), step.value);
  }
  return byRaw;
}

function makeSetOperation(name: string, target: Set<any>) {
  return (other: any) => {
    (new Set() as any).isSubsetOf(other);
    const theirs = membersByRaw(other.keys());
    onReadTargetKey(target, KEYCHANGES);
    const mine = membersByRaw(target.values());
    const result = (new Set(mine.keys()) as any)[name](new Set(theirs.keys()));
    if (typeof result === "boolean") {
      return result;
    }
    for (const [raw, member] of theirs) {
      if (!mine.has(raw)) {
        mine.set(raw, member);
      }
    }
    return new Set([...mine].filter(([raw]) => result.has(raw)).map(([, member]) => member));
  };
}

function delegateAndNotify(setterName: "set" | "add" | "delete", target: any, shallow: boolean) {
  const readsValue = setterName === "set" || (setterName === "delete" && !(target instanceof Set));
  const prototype =
    target instanceof Map
      ? Map.prototype
      : target instanceof Set
        ? Set.prototype
        : WeakMap.prototype;
  const has = prototype.has;
  const get = readsValue ? (prototype as Map<any, any>).get : undefined;
  const nativeMethod =
    setterName === "delete"
      ? prototype.delete
      : setterName === "add"
        ? Set.prototype.add
        : (prototype as Map<any, any>).set;
  const collection = (shallow ? shallowProxies : deepProxies).get(target)!;
  return (key: any, value: any) =>
    batch(() => {
      key = toRaw(key);
      const hadKey = has.call(target, key);
      const before = get && hadKey ? get.call(target, key) : undefined;
      let ret;
      let method;
      let completed = false;
      try {
        method = target[setterName];
        ret = Reflect.apply(method, target, [key, shallow ? value : toRaw(value)]);
        completed = true;
      } finally {
        const hasKey =
          completed && method === nativeMethod ? setterName !== "delete" : has.call(target, key);
        if (hadKey !== hasKey) {
          onWriteKeyPresence(target, key);
        }
        const after = get && hasKey ? get.call(target, key) : undefined;
        if (readsValue ? !Object.is(before, after) : hadKey !== hasKey) {
          onWriteTargetKey(target, key);
        }
        if (!hasKey) {
          releaseKey(target, key);
        }
      }
      return ret === target ? collection : ret;
    });
}

function makeGetOrInsert(
  method: "getOrInsert" | "getOrInsertComputed",
  target: any,
  shallow: boolean
) {
  const prototype = target instanceof Map ? Map.prototype : WeakMap.prototype;
  const has = prototype.has;
  const get = prototype.get;
  return (key: any, value: any) =>
    batch(() => {
      key = toRaw(key);
      const hadKey = has.call(target, key);
      const before = hadKey ? get.call(target, key) : undefined;
      const argument =
        method === "getOrInsert"
          ? shallow
            ? value
            : toRaw(value)
          : !shallow && typeof value === "function"
            ? (key: any) => toRaw(value(key))
            : value;
      let result;
      try {
        result = target[method](key, argument);
      } finally {
        const hasKey = has.call(target, key);
        if (hadKey !== hasKey) {
          onWriteKeyPresence(target, key);
        }
        if (!Object.is(before, get.call(target, key))) {
          onWriteTargetKey(target, key);
        }
        onReadTargetKey(target, key);
      }
      return reactiveValue(result, shallow);
    });
}

function hasKeyAtoms(target: Target): boolean {
  return allAtoms.some((atoms) => atoms.keys.has(target) || atoms.weakKeys.has(target));
}

function makeClearNotifier(target: Map<any, any> | Set<any>) {
  const prototype = target instanceof Map ? Map.prototype : Set.prototype;
  const size = Object.getOwnPropertyDescriptor(prototype, "size")!.get!;
  const keysOf = prototype.keys;
  const isMap = target instanceof Map;
  const snapshot = () =>
    new Map<any, any>(
      isMap
        ? Map.prototype.entries.call(target)
        : Array.from(Set.prototype.values.call(target), (key) => [key, key])
    );
  return () => {
    const clear = target.clear;
    if (clear !== prototype.clear) {
      if (!hasKeyAtoms(target)) return Reflect.apply(clear, target, []);
      const before = snapshot();
      return batch(() => {
        try {
          return Reflect.apply(clear, target, []);
        } finally {
          const after = snapshot();
          const keys = new Set([...before.keys(), ...after.keys()]);
          const oldKeys = [...before.keys()];
          const newKeys = [...after.keys()];
          if (
            oldKeys.length !== newKeys.length ||
            oldKeys.some((key, i) => !Object.is(key, newKeys[i]))
          ) {
            onWriteTargetKey(target, KEYCHANGES);
          }
          for (const key of keys) {
            const hadKey = before.has(key);
            const hasKey = after.has(key);
            if (hadKey !== hasKey) onWriteTargetKey(target, key, presenceAtoms);
            if (isMap ? !Object.is(before.get(key), after.get(key)) : hadKey !== hasKey) {
              onWriteTargetKey(target, key);
            }
            if (!hasKey) releaseKey(target, key);
          }
        }
      });
    }
    const nonempty = size.call(target) !== 0;
    const keys = nonempty && hasKeyAtoms(target) ? [...keysOf.call(target)] : [];
    batch(() => {
      Reflect.apply(clear, target, []);
      if (nonempty) onWriteTargetKey(target, KEYCHANGES);
      for (const key of keys) {
        onWriteTargetKey(target, key, presenceAtoms);
        onWriteTargetKey(target, key);
        releaseKey(target, key);
      }
    });
  };
}

const setLikeMethods: PropertyKey[] = [
  "has",
  "delete",
  "clear",
  "forEach",
  "keys",
  "values",
  "entries",
  Symbol.iterator,
];
const weakMapMethods = new Set<PropertyKey>([
  "has",
  "get",
  "set",
  "delete",
  "getOrInsert",
  "getOrInsertComputed",
]);
const setOperations = [
  "difference",
  "intersection",
  "isDisjointFrom",
  "isSubsetOf",
  "isSupersetOf",
  "symmetricDifference",
  "union",
];

const mapMethods = /* @__PURE__ */ unionOf(setLikeMethods, weakMapMethods);
const setMethods = /* @__PURE__ */ unionOf(setLikeMethods, ["add"], setOperations);

function unionOf(...lists: Iterable<PropertyKey>[]): Set<PropertyKey> {
  const union = new Set<PropertyKey>();
  for (const list of lists) {
    for (const item of list) {
      union.add(item);
    }
  }
  return union;
}

function collectionMethods(target: Target): Set<PropertyKey> | null {
  return target instanceof Map
    ? mapMethods
    : target instanceof Set
      ? setMethods
      : target instanceof WeakMap
        ? weakMapMethods
        : null;
}

class CollectionHandler extends BasicHandler {
  methodKeys: Set<PropertyKey>;
  hasSize: boolean;
  methods: Map<PropertyKey, Function> | undefined = undefined;
  properties: Target | undefined = undefined;

  constructor(methodKeys: Set<PropertyKey>, shallow: boolean) {
    super(shallow);
    this.methodKeys = methodKeys;
    this.hasSize = methodKeys !== weakMapMethods;
  }

  get(target: any, key: PropertyKey, receiver: any): any {
    if (Object.hasOwn(target, key) && isLocked(target, key)) {
      return super.get(target, key, receiver);
    }
    if (this.methodKeys.has(key)) {
      const methods = (this.methods ??= new Map());
      let method = methods.get(key);
      if (!method) {
        methods.set(key, (method = makeMethod(key, target, this.shallow)));
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
