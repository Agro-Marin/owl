import {
  assertType,
  type Atom,
  createAtom,
  getDefault,
  GetDefaultedKeys,
  ResolveObjectType,
  isObserving,
  onReadAtom,
  onWriteAtom,
  OwlError,
  ResolveReaderObjectType,
  signal,
  Signal,
} from "@odoo/owl-core";
import { type ComponentNode, getComponentScope } from "./component_node";
import { staticProp } from "./prop";
import { types } from "./types";

export declare const isProps: unique symbol;

// The brand stores the defaulted key names: those keys are required for the
// component reading the props (the default fills them), but may be omitted by
// the parent providing them. The props type itself is the flat reader view,
// so editors display it expanded.
export type Props<T extends {}> = T & { [isProps]: never };
export type PropsWithDefaults<T extends {}, DK extends PropertyKey> = T & { [isProps]: DK };

// Recovers the parent view from the branded reader view: keys with a default
// become optional again.
type GetPropsWithOptionals<T> = T extends { [isProps]: infer DK extends PropertyKey }
  ? Omit<T, typeof isProps | (DK & keyof T)> & Partial<Pick<T, DK & keyof T>>
  : never;
export type GetProps<T> = {
  [K in keyof T]: T[K] extends { [isProps]: PropertyKey }
    ? (x: GetPropsWithOptionals<T[K]>) => void
    : never;
}[keyof T] extends (x: infer I) => void
  ? { [K in keyof I]: I[K] }
  : never;

type ResolveProps<Shape> = [GetDefaultedKeys<Shape>] extends [never]
  ? Props<ResolveReaderObjectType<Shape>>
  : PropsWithDefaults<ResolveReaderObjectType<Shape>, GetDefaultedKeys<Shape> & PropertyKey>;

export interface PropsFunction {
  (): Props<Record<string, any>>;
  <const Keys extends string[]>(keys: Keys): Props<ResolveObjectType<Keys>>;
  <Shape extends {}>(shape: Shape): ResolveProps<Shape>;
  static: typeof staticProp;
}

// bumped each time a view of the node declares defaults: a schema-less view's
// key set includes the defaulted keys, whenever they were declared
const defaultsVersions = new WeakMap<object, number>();

function makeProps(type?: any): Props<{}> {
  const node = getComponentScope();
  if (!type) {
    const view = new PropsView(node);
    node.addHook("propsUpdated", view);
    return new Proxy(view, viewHandler) as any;
  }
  const { app, componentName } = node;

  // defaults declared in the schema (.optional(value)). Factories are resolved once
  // per component instance, so the value identity is stable across prop
  // updates of that instance.
  let defaults: Record<string, any> | null = null;
  if (!Array.isArray(type)) {
    for (const key in type) {
      const factory = getDefault(type[key]);
      if (factory) {
        (defaults ||= {})[key] = factory();
      }
    }
  }
  if (defaults) {
    node.defaultProps = Object.assign(node.defaultProps || {}, defaults);
    defaultsVersions.set(node, (defaultsVersions.get(node) || 0) + 1);
  }

  const keys: string[] = Array.isArray(type) ? type : schemaKeys(type);
  const state = new TypedProps(node, defaults);
  const result: any = new PropsTable();
  for (const key of keys) {
    Reflect.defineProperty(result, key, {
      enumerable: true,
      configurable: true,
      get: (propGetters[key] ||= makePropGetter(key)),
    });
  }
  new StateStamp(result, state);
  node.addHook("propsUpdated", state);

  if (app.dev) {
    if (defaults) {
      const defaultedShape: Record<string, any> = {};
      for (const key in type) {
        if (key in defaults) {
          defaultedShape[key] = type[key];
        }
      }
      assertType(
        defaults,
        types.object(defaultedShape),
        `Invalid component default props (${componentName})`
      );
    }

    const validation = types.object(type);
    assertType(node.props, validation, `Invalid component props (${componentName})`);
    node.addHook("willUpdateProps", (np: Record<string, any>) => {
      assertType(np, validation, `Invalid component props (${componentName})`);
    });
  }
  // read-only like the schema-less view: a new key throws, not only a declared one
  return Object.preventExtensions(result);
}

// A schema's key list, computed once per schema object: a component class
// passes the same one for each of its instances.
const schemaKeyLists = new WeakMap<object, string[]>();

function schemaKeys(type: object): string[] {
  let keys = schemaKeyLists.get(type);
  if (!keys) {
    keys = Object.keys(type);
    schemaKeyLists.set(type, keys);
  }
  return keys;
}

// A typed view is a plain object with one accessor per schema key. The
// accessors are shared by every view (one per key name), so the views of a
// component class share their hidden class instead of each being a dictionary;
// an accessor finds its view's state in a private field, which no reflection
// reaches. A key gets its atom on its first tracked read: a key read only in
// setup, untracked, never gets one.
class TypedProps {
  node: ComponentNode;
  defaults: Record<string, any> | null;
  atoms = new AtomTable();

  constructor(node: ComponentNode, defaults: Record<string, any> | null) {
    this.node = node;
    this.defaults = defaults;
  }

  // a missing prop resolves to this view's default, else to the default another
  // view of the component declared
  resolve(key: string) {
    const value = this.node.props[key];
    if (value === undefined) {
      const defaults = this.defaults;
      if (defaults && key in defaults) {
        return defaults[key];
      }
      const declared = this.node.defaultProps;
      if (declared && key in declared) {
        return declared[key];
      }
    }
    return value;
  }

  read(key: string) {
    let atom = this.atoms[key];
    if (atom === undefined) {
      if (!isObserving()) {
        return this.resolve(key);
      }
      atom = this.atoms[key] = createAtom(this.resolve(key), "prop");
    }
    onReadAtom(atom);
    return atom.value;
  }

  update() {
    writeAtoms(this.atoms, this);
  }
}

function writeAtoms(atoms: Record<string, Atom>, view: { resolve(key: string): any }) {
  for (const key in atoms) {
    const atom = atoms[key];
    const value = view.resolve(key);
    if (!Object.is(atom.value, value)) {
      atom.value = value;
      onWriteAtom(atom, true);
    }
  }
}

// `return target` makes `new StateStamp(target, state)` add the private field
// to `target` itself
class ObjectReturner {
  constructor(target: object) {
    return target;
  }
}

class StateStamp extends ObjectReturner {
  #state: TypedProps;

  constructor(target: object, state: TypedProps) {
    super(target);
    this.#state = state;
  }

  // the state of `view`, or of the view it inherits from (a read through
  // `Object.create(props)`)
  static of(view: object | null): TypedProps | undefined {
    while (view !== null && typeof view === "object") {
      if (#state in view) {
        return (view as StateStamp).#state;
      }
      view = Object.getPrototypeOf(view);
    }
    return undefined;
  }
}

const propGetters: Record<string, (this: object) => any> = Object.create(null);

function makePropGetter(key: string) {
  return function (this: object) {
    const state = StateStamp.of(this);
    if (state === undefined) {
      throw new OwlError(`Cannot read prop "${key}" through an object that is not a props view`);
    }
    return state.read(key);
  };
}

function getKeys(node: ComponentNode): string[] {
  const props = node.props;
  const keys: string[] = [];
  for (const k in props) {
    if (k.charCodeAt(0) !== 1) {
      keys.push(k);
    }
  }
  for (const k in node.defaultProps) {
    if (!(k in props)) {
      keys.push(k);
    }
  }
  return keys;
}

// The per-key atoms of a view, in an object whose prototype chain is one
// empty null-prototype object: no inherited key, yet unlike Object.create(null)
// V8 keeps it in fast mode, and the views of a component class, reading the
// same keys, share its shape.
const AtomTable = function () {} as unknown as new () => Record<string, Atom>;
AtomTable.prototype = Object.create(null);

// The schema views, built like an AtomTable: no inherited key, fast mode. Their
// shared prototype is frozen: nothing can add a key every view would inherit.
const PropsTable = function () {} as unknown as new () => Record<string, any>;
PropsTable.prototype = Object.freeze(Object.create(null));

// A schema-less view has no fixed key set: a key gets its atom on its first
// tracked read, present or not, so a reader of a key that appears or disappears
// is notified; an untracked read has nobody to notify and creates none. An atom
// holds the value its readers saw and is written like a signal with the
// default equality, without a signal's closures.
// The key set itself is read behind a version signal and cached until the props
// or the declared defaults change; both are built on the first read of the key
// set, which most components never make. The view is the proxy's target, and
// every trap answers for it, so its fields are never observable.
class PropsView {
  node: ComponentNode;
  atoms = new AtomTable();
  keys: string[] | null = null;
  keyLookup: Set<string> | null = null;
  keysDefaults = 0;
  keySet: Signal<number> | null = null;
  keysVersion = 0;

  constructor(node: ComponentNode) {
    this.node = node;
  }

  resolve(key: string) {
    const node = this.node;
    const value = node.props[key];
    if (value === undefined) {
      const declared = node.defaultProps;
      if (declared && key in declared) {
        return declared[key];
      }
    }
    return value;
  }

  read(key: string) {
    let atom = this.atoms[key];
    if (atom === undefined) {
      if (!isObserving()) {
        return this.resolve(key);
      }
      atom = this.atoms[key] = createAtom(this.resolve(key), "prop");
    }
    onReadAtom(atom);
    return atom.value;
  }

  // the key set as a reader sees it: subscribes to its changes
  currentKeys(): string[] {
    (this.keySet ||= signal(this.keysVersion))();
    return this.refreshKeys();
  }

  refreshKeys(): string[] {
    const defaultsVersion = defaultsVersions.get(this.node) || 0;
    if (!this.keys || this.keysDefaults !== defaultsVersion) {
      this.keys = getKeys(this.node);
      this.keyLookup = null;
      this.keysDefaults = defaultsVersion;
    }
    return this.keys;
  }

  hasKey(key: string) {
    const keys = this.currentKeys();
    return (this.keyLookup ||= new Set(keys)).has(key);
  }

  update() {
    writeAtoms(this.atoms, this);
    // nobody read the key set yet: there is no one to notify
    if (!this.keySet) {
      return;
    }
    const previousKeys = this.refreshKeys();
    const nextKeys = getKeys(this.node);
    if (
      nextKeys.length !== previousKeys.length ||
      nextKeys.some((key, i) => key !== previousKeys[i])
    ) {
      this.keys = nextKeys;
      this.keyLookup = null;
      this.keySet.set(++this.keysVersion);
    }
  }
}

const viewHandler: ProxyHandler<PropsView> = {
  get: (view, key) => (typeof key === "string" ? view.read(key) : undefined),
  has: (view, key) => typeof key === "string" && view.hasKey(key),
  ownKeys: (view) => view.currentKeys(),
  getOwnPropertyDescriptor(view, key) {
    if (typeof key === "string" && view.hasKey(key)) {
      return { value: view.read(key), enumerable: true, configurable: true, writable: false };
    }
    return undefined;
  },
  getPrototypeOf: () => null,
  set: () => false,
  defineProperty: () => false,
  deleteProperty: () => false,
};

export const useProps = Object.assign(makeProps, { static: staticProp }) as PropsFunction;

/** @deprecated alias for {@link useProps} */
export const props = useProps;
