import {
  assertType,
  getDefault,
  GetDefaultedKeys,
  ResolveObjectType,
  ResolveReaderObjectType,
  signal,
  Signal,
} from "@odoo/owl-core";
import { getComponentScope } from "./component_node";
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

function makeProps(type?: any): Props<{}> {
  const node = getComponentScope();
  const { app, componentName } = node;

  // defaults declared in the schema (.optional(value)). Factories are resolved once
  // per component instance, so the value identity is stable across prop
  // updates of that instance.
  let defaults: Record<string, any> | null = null;
  if (type && !Array.isArray(type)) {
    for (const key in type) {
      const factory = getDefault(type[key]);
      if (factory) {
        (defaults ||= {})[key] = factory();
      }
    }
  }
  if (defaults) {
    node.defaultProps = Object.assign(node.defaultProps || {}, defaults);
  }

  // a schema-less view (a hook's) resolves the defaults the component declared
  function resolveValue(props: Record<string, any>, key: string) {
    const known = type ? defaults : node.defaultProps;
    if (props[key] === undefined && known && key in known) {
      return known[key];
    }
    return props[key];
  }

  const signals: Record<string, Signal<any>> = Object.create(null);

  if (type) {
    const keys: string[] = Array.isArray(type) ? type : Object.keys(type);
    const result = Object.create(null);
    for (const key of keys) {
      signals[key] = signal(resolveValue(node.props, key));
      Reflect.defineProperty(result, key, {
        enumerable: true,
        configurable: true,
        get: signals[key],
      });
    }
    node.propsUpdated.push(() => {
      for (const key of keys) {
        signals[key].set(resolveValue(node.props, key));
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

  const getKeys = (props: Record<string, any>) => {
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
  };

  // a schema-less view has no fixed key set: a key gets its signal on first
  // read, present or not, so a reader of a key that appears or disappears is
  // notified; the key set itself is read live, behind a version signal
  let keyList = getKeys(node.props).join("\0");
  let version = 0;
  const keySet = signal(version);
  node.propsUpdated.push(() => {
    for (const key in signals) {
      signals[key].set(resolveValue(node.props, key));
    }
    const nextKeyList = getKeys(node.props).join("\0");
    if (nextKeyList !== keyList) {
      keyList = nextKeyList;
      keySet.set(++version);
    }
  });
  const read = (key: string) => (signals[key] ||= signal(resolveValue(node.props, key)))();
  const hasKey = (key: string) => {
    keySet();
    return getKeys(node.props).includes(key);
  };
  return new Proxy(Object.create(null), {
    get(target, key) {
      return typeof key === "string" ? read(key) : Reflect.get(target, key);
    },
    has(target, key) {
      return typeof key === "string" ? hasKey(key) : Reflect.has(target, key);
    },
    ownKeys() {
      keySet();
      return getKeys(node.props);
    },
    getOwnPropertyDescriptor(_target, key) {
      if (typeof key === "string" && hasKey(key)) {
        return { value: read(key), enumerable: true, configurable: true, writable: false };
      }
      return undefined;
    },
    set: () => false,
    defineProperty: () => false,
    deleteProperty: () => false,
  });
}

export const useProps = Object.assign(makeProps, { static: staticProp }) as PropsFunction;

/** @deprecated alias for {@link useProps} */
export const props = useProps;
