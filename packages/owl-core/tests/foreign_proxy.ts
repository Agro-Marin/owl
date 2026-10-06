// Targets that sit behind a Proxy of their own, under owl's: the shape of Odoo
// mail's records (a class instance whose set trap tells a write through the
// reactive proxy from an internal one by its receiver) and record lists (an
// Array subclass whose traps map its indices and length to `receiver.data`).
// Owl must treat them as it treats an ordinary target: every read and write
// goes through the target's own traps with owl's proxy (or an observe() view)
// as the receiver, and is tracked and notified once.
import { proxy } from "../src";

export interface Item {
  id: number;
}

export interface Fields {
  a: number;
  items: Item[];
  nested: { v: number };
  readonly total: number;
  bump(): void;
}

function fields(): Pick<Fields, "a" | "items" | "nested"> {
  return { a: 1, items: [{ id: 1 }, { id: 2 }], nested: { v: 1 } };
}

export interface ObjectKind {
  name: string;
  make(): Fields;
}

function plainObject(): Fields {
  return {
    ...fields(),
    get total() {
      return this.a + this.items.length;
    },
    bump() {
      this.a++;
    },
  };
}

class RecordBase {
  a = 0;
  items: Item[] = [];
  nested = { v: 0 };
  // what the record's own Proxy is, and the proxy its internal writes go
  // through: Odoo mail's `_proxyInternal` and `_proxy`
  declare _internal: RecordBase;
  declare _proxy: RecordBase;
  get total() {
    return this.a + this.items.length;
  }
  bump() {
    this.a++;
  }
}

/**
 * A class instance behind a receiver-sensitive Proxy (Odoo mail's
 * makeRecordProxy): a function read is bound to the receiver; a write whose
 * receiver is not the record's own Proxy (a write through owl's proxy) is made
 * on the record itself, any other write is made again through `_proxy`, the
 * reactive proxy, whose set trap comes back with the field marked as being
 * written.
 */
export function makeRecord(): Fields {
  const record = Object.assign(new RecordBase(), fields());
  const writing = new Set<PropertyKey>();
  const internal = new Proxy(record, {
    get(target, key, receiver) {
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" && key !== "constructor" ? value.bind(receiver) : value;
    },
    set(target, key, value, receiver) {
      if (writing.has(key)) {
        return Reflect.set(target, key, value);
      }
      const holder: any = receiver !== internal ? target : target._proxy;
      writing.add(key);
      try {
        holder[key] = value;
      } finally {
        writing.delete(key);
      }
      return true;
    },
  });
  record._internal = internal;
  record._proxy = proxy(internal);
  return internal as unknown as Fields;
}

export const objectKinds: ObjectKind[] = [
  { name: "a plain object", make: plainObject },
  { name: "a plain object behind a forwarding Proxy", make: () => new Proxy(plainObject(), {}) },
  {
    name: "a plain object behind a Proxy forwarding every trap with its receiver",
    make: () => forwardingProxy(plainObject()),
  },
  {
    name: "a class instance behind a receiver-sensitive Proxy (Odoo mail's records)",
    make: makeRecord,
  },
];

/** A Proxy with every trap written out, forwarding to Reflect as it is given. */
export function forwardingProxy<T extends object>(target: T): T {
  return new Proxy(target, {
    get: (t, key, receiver) => Reflect.get(t, key, receiver),
    set: (t, key, value, receiver) => Reflect.set(t, key, value, receiver),
    has: (t, key) => Reflect.has(t, key),
    deleteProperty: (t, key) => Reflect.deleteProperty(t, key),
    ownKeys: (t) => Reflect.ownKeys(t),
    getOwnPropertyDescriptor: (t, key) => Reflect.getOwnPropertyDescriptor(t, key),
    defineProperty: (t, key, desc) => Reflect.defineProperty(t, key, desc),
    getPrototypeOf: (t) => Reflect.getPrototypeOf(t),
  });
}

const isIndex = (key: PropertyKey): key is string =>
  typeof key === "string" && String(Number(key) >>> 0) === key;

/**
 * An Array subclass that keeps its items in `data` and answers its index and
 * length reads and writes through `receiver.data`: read through owl's proxy,
 * `data` is read through it too, tracked. Array.prototype's methods run on it
 * as on any array.
 */
class MappedList<T> extends Array<T> {
  declare data: T[];
}

function mappedListTraps<T>(): ProxyHandler<MappedList<T>> {
  return {
    get(target, key, receiver) {
      if (key === "length") {
        return receiver.data.length;
      }
      if (isIndex(key)) {
        return receiver.data[key as any];
      }
      return Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      if (key === "length") {
        receiver.data.length = value;
        return true;
      }
      if (isIndex(key)) {
        receiver.data[key as any] = value;
        return true;
      }
      return Reflect.set(target, key, value, receiver);
    },
    has(target, key) {
      return isIndex(key) ? Number(key) < target.data.length : Reflect.has(target, key);
    },
    deleteProperty(target, key) {
      return isIndex(key) ? delete target.data[key as any] : Reflect.deleteProperty(target, key);
    },
  };
}

export function makeMappedList<T>(items: T[]): T[] {
  const list = new MappedList<T>();
  list.data = items;
  return new Proxy(list, mappedListTraps<T>());
}

/**
 * Odoo mail's RecordList: a MappedList whose class reimplements the Array
 * methods over `this.data`, and whose Proxy binds every function it hands out
 * to the receiver.
 */
class OwnMethodsList<T> extends MappedList<T> {
  push(...items: T[]): number {
    return this.data.push(...items);
  }
  pop(): T | undefined {
    return this.data.pop();
  }
  splice(start: number, deleteCount = this.data.length - start, ...items: T[]): T[] {
    return this.data.splice(start, deleteCount, ...items);
  }
  includes(item: T): boolean {
    return this.data.includes(item);
  }
  indexOf(item: T): number {
    return this.data.indexOf(item);
  }
  lastIndexOf(item: T): number {
    return this.data.lastIndexOf(item);
  }
  map<U>(fn: (item: T, index: number, list: T[]) => U): U[] {
    return this.data.map((item, index) => fn(item, index, this));
  }
  forEach(fn: (item: T, index: number, list: T[]) => void): void {
    this.data.forEach((item, index) => fn(item, index, this));
  }
  *[Symbol.iterator](): any {
    yield* this.data;
  }
}

export function makeOwnMethodsList<T>(items: T[]): T[] {
  const list = new OwnMethodsList<T>();
  list.data = items;
  const traps = mappedListTraps<T>();
  return new Proxy(list, {
    ...traps,
    get(target, key, receiver) {
      const value = traps.get!(target, key, receiver);
      return typeof value === "function" && key !== "constructor" ? value.bind(receiver) : value;
    },
  });
}

export interface ListKind {
  name: string;
  make<T>(items: T[]): T[];
  // where a list that keeps its items elsewhere keeps them: Odoo mail writes
  // a record list's `data` through the list's reactive proxy, not its indices
  mapped?: true;
}

export const listKinds: ListKind[] = [
  { name: "a plain array", make: (items) => items },
  { name: "a plain array behind a forwarding Proxy", make: (items) => forwardingProxy(items) },
  {
    name: "an Array subclass mapping its indices to receiver.data",
    make: makeMappedList,
    mapped: true,
  },
  {
    name: "an Array subclass mapping its indices to receiver.data, with its own methods (Odoo mail's RecordList)",
    make: makeOwnMethodsList,
    mapped: true,
  },
];
