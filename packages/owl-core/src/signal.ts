import { OwlError } from "./owl_error";
import {
  atomSymbol,
  createAtom,
  Equals,
  onReadAtom,
  onWriteAtom,
  ReactiveValue,
  toEqualsFn,
} from "./computations";
import { proxifyTarget } from "./proxy";
import type { Constructor } from "./types";

export interface Signal<T> extends ReactiveValue<T> {
  set(nextValue: T): void;
}

interface SignalOptions<TValue, TElem = TValue> {
  type?: TElem;
  equals?: Equals<TValue>;
}

function buildSignal<T>(value: T, toRead: (value: T) => T, equals?: Equals<T>): Signal<T> {
  const atom = createAtom(value, "signal");
  const equalsFn = toEqualsFn(equals);
  const comparable = equals === undefined;

  let readValue = toRead(value);
  const readSignal = () => {
    onReadAtom(atom);
    return readValue;
  };
  readSignal[atomSymbol] = atom;

  readSignal.set = function writeSignal(newValue: T) {
    if (equalsFn(atom.value, newValue)) {
      return;
    }
    readValue = toRead(newValue);
    atom.value = newValue;
    onWriteAtom(atom, comparable);
  };

  return readSignal;
}

function identity<T>(value: T): T {
  return value;
}

function shallowProxy<T extends object>(value: T): T {
  return proxifyTarget(value, true);
}

function triggerSignal(signal: Signal<any>): void {
  if (typeof signal !== "function" || (signal as any)[atomSymbol]?.type !== "signal") {
    throw new OwlError(`Value is not a signal (${signal})`);
  }
  onWriteAtom((signal as any)[atomSymbol]);
}

function signalRef(): Signal<HTMLElement | null>;
function signalRef<T extends Constructor<HTMLElement>>(type: T): Signal<InstanceType<T> | null>;
function signalRef(): Signal<any> {
  return buildSignal<any>(null, identity);
}

function signalArray<T>(): Signal<T[]>;
function signalArray<T>(initialValue: T[], options?: { equals?: Equals<T[]> }): Signal<T[]>;
function signalArray<T>(initialValue: NoInfer<T>[], options: SignalOptions<T[], T>): Signal<T[]>;
function signalArray<T>(initialValue: T[] = [], options: SignalOptions<T[], T> = {}): Signal<T[]> {
  return buildSignal<T[]>(initialValue, shallowProxy, options.equals);
}

function signalObject<T extends Record<PropertyKey, any>>(): Signal<T>;
function signalObject<T extends Record<PropertyKey, any>>(
  initialValue: T,
  options?: { equals?: Equals<T> }
): Signal<T>;
function signalObject<T extends Record<PropertyKey, any>>(
  initialValue: NoInfer<T>,
  options: SignalOptions<T>
): Signal<T>;
function signalObject<T extends Record<PropertyKey, any>>(
  initialValue: T = {} as T,
  options: SignalOptions<T> = {}
): Signal<T> {
  return buildSignal<T>(initialValue, shallowProxy, options.equals);
}

interface MapSignalOptions<K, V> {
  keyType?: K;
  valueType?: V;
  equals?: Equals<Map<K, V>>;
}

function signalMap<K, V>(): Signal<Map<K, V>>;
function signalMap<K, V>(
  initialValue: Map<K, V>,
  options?: { equals?: Equals<Map<K, V>> }
): Signal<Map<K, V>>;
function signalMap<K, V>(
  initialValue: NoInfer<Map<K, V>>,
  options: MapSignalOptions<K, V>
): Signal<Map<K, V>>;
function signalMap<K, V>(
  initialValue: Map<K, V> = new Map(),
  options: MapSignalOptions<K, V> = {}
): Signal<Map<K, V>> {
  return buildSignal<Map<K, V>>(initialValue, shallowProxy, options.equals);
}

function signalSet<T>(): Signal<Set<T>>;
function signalSet<T>(initialValue: Set<T>, options?: { equals?: Equals<Set<T>> }): Signal<Set<T>>;
function signalSet<T>(
  initialValue: Set<NoInfer<T>>,
  options: SignalOptions<Set<T>, T>
): Signal<Set<T>>;
function signalSet<T>(
  initialValue: Set<T> = new Set(),
  options: SignalOptions<Set<T>, T> = {}
): Signal<Set<T>> {
  return buildSignal<Set<T>>(initialValue, shallowProxy, options.equals);
}

function plainSignal<T>(value: T, options?: { equals?: Equals<T> }): Signal<T>;
function plainSignal<T>(value: NoInfer<T>, options: SignalOptions<T>): Signal<T>;
function plainSignal<T>(value: T, options: SignalOptions<T> = {}): Signal<T> {
  return buildSignal<T>(value, identity, options.equals);
}

export const signal = /* @__PURE__ */ Object.assign(plainSignal, {
  trigger: triggerSignal,
  ref: signalRef,
  Array: signalArray,
  Map: signalMap,
  Object: signalObject,
  Set: signalSet,
});
