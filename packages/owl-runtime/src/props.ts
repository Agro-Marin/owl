import {
  assertType,
  type Atom,
  createAtom,
  getDefault,
  GetDefaultedKeys,
  ResolveObjectType,
  isObserving,
  markRaw,
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

export type Props<T extends {}> = T & { [isProps]: never };
export type PropsWithDefaults<T extends {}, DK extends PropertyKey> = T & { [isProps]: DK };

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

const defaultsVersions = new WeakMap<object, number>();

function makeProps(type?: any): Props<{}> {
  const node = getComponentScope();
  if (!type) {
    const view = new PropsView(node);
    node.addHook("propsUpdated", view);
    return markRaw(new Proxy(view, viewHandler)) as any;
  }
  const { app, componentName } = node;

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
  return markRaw(Object.preventExtensions(result));
}

const schemaKeyLists = new WeakMap<object, string[]>();

function schemaKeys(type: object): string[] {
  return schemaKeyLists.getOrInsertComputed(type, Object.keys);
}

class TypedProps {
  node: ComponentNode;
  defaults: Record<string, any> | null;
  atoms = new AtomTable();

  constructor(node: ComponentNode, defaults: Record<string, any> | null) {
    this.node = node;
    this.defaults = defaults;
  }

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

const AtomTable = /* @__PURE__ */ tableClass<Atom>(Object.create(null));

const PropsTable = /* @__PURE__ */ tableClass<any>(
  /* @__PURE__ */ Object.freeze(Object.create(null))
);

function tableClass<T>(prototype: object): new () => Record<string, T> {
  const Table = function () {} as unknown as new () => Record<string, T>;
  Table.prototype = prototype;
  return Table;
}

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

export const useProps = /* @__PURE__ */ Object.assign(makeProps, {
  static: staticProp,
}) as PropsFunction;

export const props = useProps;
