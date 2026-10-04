import {
  assertType,
  getDefault,
  GetDefaultedKeys,
  ResolveObjectType,
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
    node.propsUpdated.push(() => view.update());
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

  // a missing prop resolves to this view's default, else to the default another
  // view of the component declared
  function resolveValue(props: Record<string, any>, key: string) {
    const value = props[key];
    if (value === undefined) {
      if (defaults && key in defaults) {
        return defaults[key];
      }
      const declared = node.defaultProps;
      if (declared && key in declared) {
        return declared[key];
      }
    }
    return value;
  }

  const keys: string[] = Array.isArray(type) ? type : Object.keys(type);
  const signals: Signal<any>[] = [];
  const result = Object.create(null);
  for (const key of keys) {
    const s = signal(resolveValue(node.props, key));
    signals.push(s);
    Reflect.defineProperty(result, key, { enumerable: true, configurable: true, get: s });
  }
  node.propsUpdated.push(() => {
    for (let i = 0; i < keys.length; i++) {
      signals[i].set(resolveValue(node.props, keys[i]));
    }
  });

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
    node.willUpdateProps.push((np: Record<string, any>) => {
      assertType(np, validation, `Invalid component props (${componentName})`);
    });
  }
  // read-only like the schema-less view: a new key throws, not only a declared one
  return Object.preventExtensions(result);
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

// A schema-less view has no fixed key set: a key gets its signal on first read,
// present or not, so a reader of a key that appears or disappears is notified.
// The key set itself is read behind a version signal and cached until the props
// or the declared defaults change; both are built on the first read of the key
// set, which most components never make. The view is the proxy's target, and
// every trap answers for it, so its fields are never observable.
class PropsView {
  node: ComponentNode;
  signals: Record<string, Signal<any>> = Object.create(null);
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
    return (this.signals[key] ||= signal(this.resolve(key)))();
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
    const signals = this.signals;
    for (const key in signals) {
      signals[key].set(this.resolve(key));
    }
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
