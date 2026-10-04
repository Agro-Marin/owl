import {
  atomSymbol,
  computed,
  debug,
  debugLog,
  markRaw,
  OwlError,
  readArrayItems,
  ReadonlyReactiveValue,
  signal,
  Signal,
  untrack,
} from "@odoo/owl-core";
import { App } from "../app";
import { BDom, createCatcher, multi, RefCallback, text, toggler } from "../blockdom";
import { html } from "../blockdom/index";
import { Component } from "../component";
import { ComponentNode } from "../component_node";
import { Markup } from "../utils";
import { handleHookRejection } from "./error_handling";
import { memoBegin, memoCollectChild, memoEnd, memoHit, memoKeep, memoPrevious } from "./memo";
import { Fiber, makeChildFiber } from "./fibers";

const ObjectCreate = Object.create;
/**
 * This file contains utility functions that will be injected in each template,
 * to perform various useful tasks in the compiled code.
 */

function withDefault(value: any, defaultValue: any): any {
  return value === undefined || value === null || value === false ? defaultValue : value;
}

function callSlot(
  ctx: any,
  parent: any,
  key: string,
  name: string,
  dynamic: boolean,
  extra: any,
  defaultContent?: (ctx: any, node: any, key: string) => BDom
): BDom {
  key = key + "__slot_" + name;
  const slots = ctx.__owl__.props.slots || {};
  const { __render, __ctx, __scope } = slots[name] || {};
  const slotScope = ObjectCreate(__ctx || {});
  if (__scope) {
    slotScope[__scope] = extra;
  }
  const slotBDom = __render ? __render(slotScope, parent, key) : null;
  if (defaultContent) {
    let child1: BDom | undefined = undefined;
    let child2: BDom | undefined = undefined;
    if (slotBDom) {
      child1 = dynamic ? toggler(name, slotBDom) : slotBDom;
    } else {
      child2 = defaultContent(ctx, parent, key);
    }
    return multi([child1, child2]);
  }
  return slotBDom || text("");
}

// string keys (component, slot, t-call keys) are built by concatenation: a key
// takes the string form it has there. An object or a function is told apart by
// identity, with an id of its own instead of "[object Object]"; an array keeps
// its string form, so that a new array of the same items is the same key.
// An id is \u0002 and a number, and a \u0002 in a string key is doubled: no
// string key can read as an id.
const objectKeys = new WeakMap<object, string>();
let nextObjectKey = 0;
const ID_MARK = "\u0002";

function keyOf(key: any): string {
  if (typeof key === "string") {
    return key.includes(ID_MARK) ? key.replaceAll(ID_MARK, ID_MARK + ID_MARK) : key;
  }
  if ((typeof key === "object" && key !== null) || typeof key === "function") {
    if (Array.isArray(key)) {
      return keyOf(String(key));
    }
    let id = objectKeys.get(key);
    if (id === undefined) {
      id = ID_MARK + ++nextObjectKey;
      objectKeys.set(key, id);
    }
    return id;
  }
  return "" + key;
}

function withKey(elem: any, k: string) {
  elem.key = k;
  return elem;
}

function prepareList(collection: unknown): [unknown[], unknown[], number, undefined[]] {
  let keys: unknown[];
  let values: unknown[];

  if (Array.isArray(collection)) {
    keys = readArrayItems(collection);
    values = keys;
  } else if (collection instanceof Map) {
    keys = [...collection.keys()];
    values = [...collection.values()];
  } else if (Symbol.iterator in Object(collection)) {
    keys = [...(<Iterable<unknown>>collection)];
    values = keys;
  } else if (collection && typeof collection === "object") {
    values = Object.values(collection);
    keys = Object.keys(collection);
  } else {
    throw new OwlError(`Invalid loop expression: "${collection}" is not iterable`);
  }
  const n = values.length;
  return [keys, values, n, new Array(n)];
}

function toNumber(val: string): number | string {
  const n = parseFloat(val);
  return isNaN(n) ? val : n;
}

class LazyValue {
  fn: any;
  ctx: any;
  component: any;
  node: any;
  key: any;

  constructor(fn: any, ctx: any, component: any, node: any, key: any) {
    this.fn = fn;
    this.ctx = ctx;
    this.component = component;
    this.node = node;
    this.key = key;
  }

  evaluate(siteKey: string = ""): any {
    return this.fn.call(this.component, this.ctx, this.node, this.key + siteKey);
  }

  toString() {
    return this.evaluate().toString();
  }
}

/*
 * Safely outputs `value` as a block depending on the nature of `value`. A
 * LazyValue (a t-set body) renders under the key of the output site: `key` +
 * `site` + the `depth` loop keys around it, joined only for a LazyValue.
 */
export function safeOutput(
  value: any,
  key: string = "",
  site: string = "",
  depth: number = 0,
  k1?: any,
  k2?: any,
  k3?: any
): ReturnType<typeof toggler> {
  if (value === undefined || value === null) {
    return toggler("undefined", text(""));
  }
  let safeKey;
  let block;
  if (value instanceof Markup) {
    safeKey = `string_safe`;
    block = html(value);
  } else if (value instanceof LazyValue) {
    safeKey = `lazy_value`;
    let siteKey = key + site;
    if (depth) {
      siteKey += "__" + keyOf(k1);
      if (depth > 1) {
        siteKey += "__" + keyOf(k2);
        if (depth > 2) {
          siteKey += "__" + keyOf(k3);
        }
      }
    }
    block = value.evaluate(siteKey);
  } else {
    safeKey = "string_unsafe";
    block = text(value);
  }
  return toggler(safeKey, block);
}

/*
 * safeOutput, with a default content for a missing value
 */
function safeOutputOr(
  value: any,
  defaultContent: () => BDom,
  key: string,
  site: string,
  depth?: number,
  k1?: any,
  k2?: any,
  k3?: any
): ReturnType<typeof toggler> {
  if (value === undefined || value === null) {
    return toggler("default", defaultContent());
  }
  return safeOutput(value, key, site, depth, k1, k2, k3);
}

function createRef(ref: any, node: ComponentNode) {
  if (!ref) {
    throw new OwlError(`Ref is undefined or null`);
  }
  // one callback per ref and host: an unchanged ref keeps its identity across
  // renders, so the block patch skips it instead of unbinding and rebinding it
  const callbacks = (node.refCallbacks ||= new WeakMap());
  let callback = callbacks.get(ref);
  if (!callback) {
    callback = makeRefCallback(ref, node);
    callbacks.set(ref, callback);
  }
  return callback;
}

function makeRefCallback(ref: any, node: ComponentNode): RefCallback {
  let add: (el: HTMLElement) => void;
  let remove: (el: HTMLElement) => void;

  if (ref.add && ref.delete) {
    // tracked like a signal below, element by element
    add = (el: HTMLElement) => {
      ref.add(el);
      node.trackRefElement(ref, el, true);
    };
    remove = (prevEl: HTMLElement) => {
      ref.delete(prevEl);
      node.trackRefElement(ref, prevEl, false);
    };
  } else if (ref.set) {
    // A sibling slot in the same patch may have already taken ownership of the
    // signal (e.g. t-if/t-else swap with a shared ref). In that case the new
    // element is mounted before this branch's remove runs, so only clear the
    // ref if it still points to the element we're unbinding.
    const atom = (ref as any)[atomSymbol];
    if (atom) {
      // The block-ref callback only fires when this block's own remove() is
      // called. When an enclosing block is removed in bulk (e.g. a slot host),
      // the callback is skipped and the signal would keep pointing at a
      // detached element. Track the ref on its host component, which clears it
      // on unmount and sweeps detached refs after each patch. `node` is the
      // host even for forwarded slot content (createRef sees the innermost
      // host via callSlot).
      add = (el: HTMLElement) => {
        ref.set(el);
        node.trackRef(ref, atom);
      };
      remove = (prevEl: HTMLElement) => {
        if (atom.value === prevEl) ref.set(null);
      };
    } else {
      add = ref.set.bind(ref);
      remove = () => ref.set(null);
    }
  } else {
    throw new OwlError(
      `Ref should implement either a 'set' function or 'add' and 'delete' functions`
    );
  }

  return (el: HTMLElement | null, previousEl: HTMLElement | null) => {
    if (previousEl) {
      remove(previousEl);
    }
    if (el) {
      add(el);
    }
  };
}

function callHandler(fn: any, ctx: any, ev: Event) {
  if (typeof fn !== "function") {
    throw new OwlError(
      `Invalid handler expression: the \`t-on\` expression should evaluate to a function, but got '${typeof fn}'. ` +
        `Did you mean to use an arrow function? (e.g. \`t-on-click="() => expr"\`)`
    );
  }
  fn.call(ctx["this"], ev);
}

type PropSignal = Signal<any> & { readonly: ReadonlyReactiveValue<any> };

// the signals behind a child's `.signal` props, one per prop name: they live as
// long as the child does
const propSignals = new WeakMap<ComponentNode, Record<string, PropSignal>>();

function wrapPropSignals(props: Record<string, any>, names: string[]): Record<string, PropSignal> {
  const signals: Record<string, PropSignal> = Object.create(null);
  for (const name of names) {
    const s = signal(props[name]) as PropSignal;
    s.readonly = computed(s);
    signals[name] = s;
    props[name] = s.readonly;
  }
  return signals;
}

function updatePropSignals(props: Record<string, any>, signals: Record<string, PropSignal>) {
  for (const name in signals) {
    const s = signals[name];
    s.set(props[name]);
    props[name] = s.readonly;
  }
}

function modelExpr(value: any) {
  if (typeof value !== "function" || typeof value.set !== "function") {
    throw new OwlError(
      `Invalid t-model expression: expression should evaluate to a function with a 'set' method defined on it`
    );
  }
  return value;
}

/**
 * Renders again a child whose render was cancelled with its parent's pass, for
 * the props it already has: node.props only ever holds props whose
 * onWillUpdateProps hooks have settled, so they do not run a second time.
 */
function rerenderChild(node: ComponentNode, props: Record<string, any>, parentFiber: Fiber) {
  if (debug.fiber) {
    debugLog("fiber", `render ${node.componentName} again: its pending render was cancelled`);
  }
  node.forceNextRender = false;
  const fiber = makeChildFiber(node, parentFiber);
  node.fiber = fiber;
  const parentRoot = parentFiber.root!;
  if (node.willPatch.length) parentRoot.willPatch.push(fiber);
  if (node.patched.length) parentRoot.patched.push(fiber);
  node.props = props;
  fiber.render();
}

/**
 * Re-renders an existing child with new props, once its onWillUpdateProps
 * hooks have run (and settled, when one returns a promise). Kept out of the
 * createComponent closure: its own closures would make every call of that
 * closure, a new child included, allocate a context.
 */
function updateChild(node: ComponentNode, props: Record<string, any>, parentFiber: Fiber) {
  if (debug.fiber) {
    debugLog(
      "fiber",
      `update ${node.componentName}: ${parentFiber.deep ? "deep render" : "props changed"}${node.willUpdateProps.length ? `, ${node.willUpdateProps.length} willUpdateProps` : ""}`
    );
  }
  node.forceNextRender = false;
  const hooks = node.willUpdateProps;
  const fiber = makeChildFiber(node, parentFiber);
  node.fiber = fiber;
  const parentRoot = parentFiber.root!;
  if (node.willPatch.length) parentRoot.willPatch.push(fiber);
  if (node.patched.length) parentRoot.patched.push(fiber);
  let promises: Promise<any>[] | undefined;
  if (hooks.length) {
    // Defaults must reach the hooks but must NOT be stored on node.props:
    // otherwise the next arePropsDifferent call sees ghost diffs on default
    // keys and re-renders on every parent render. Consumers (`props.static`/`props`)
    // already resolve defaults lazily from raw node.props.
    let nextProps = props;
    const defaultProps = node.defaultProps;
    if (defaultProps) {
      nextProps = Object.assign({}, props);
      for (const k in defaultProps) {
        if (nextProps[k] === undefined) {
          nextProps[k] = defaultProps[k];
        }
      }
    }
    const component = node.component;
    untrack(() => {
      for (const f of hooks) {
        const r = f.call(component, nextProps);
        if (r && typeof r.then === "function") {
          (promises ||= []).push(r);
        }
      }
    });
  }
  if (promises) {
    const p = promises.length === 1 ? promises[0] : Promise.all(promises);
    p.then(
      () => {
        if (fiber !== node.fiber) return;
        node.props = props;
        for (const view of node.propsUpdated) view.update();
        fiber.render();
      },
      (error) => handleHookRejection(node, error)
    );
  } else {
    node.props = props;
    for (const view of node.propsUpdated) view.update();
    fiber.render();
  }
}

function createComponent<P extends Record<string, any>>(
  app: App,
  name: string | null,
  isStatic: boolean,
  hasSlotsProp: boolean,
  hasDynamicPropList: boolean,
  propList: string[],
  signalProps?: string[]
) {
  const isDynamic = !isStatic;
  let arePropsDifferent: (p1: P, p2: P) => boolean;
  const hasNoProp = propList.length === 0;
  if (hasSlotsProp) {
    arePropsDifferent = (_1, _2) => true;
  } else if (hasDynamicPropList) {
    arePropsDifferent = function (props1: P, props2: P) {
      for (let k in props1) {
        if (props1[k] !== props2[k] || !(k in props2)) {
          return true;
        }
      }
      return Object.keys(props1).length !== Object.keys(props2).length;
    };
  } else if (hasNoProp) {
    arePropsDifferent = (_1: any, _2: any) => false;
  } else {
    arePropsDifferent = function (props1: P, props2: P) {
      for (let p of propList) {
        if (props1[p] !== props2[p]) {
          return true;
        }
      }
      return false;
    };
  }

  const initiateRender = ComponentNode.prototype.initiateRender;

  return (props: P, key: string, ctx: ComponentNode, parent: any, C: any) => {
    let node: any = ctx.childMap?.get(key);
    if (isDynamic && node && node.component.constructor !== C) {
      node = undefined;
    }
    const parentFiber = ctx.fiber!;
    let signals: Record<string, PropSignal> | undefined;
    if (signalProps) {
      signals = node && propSignals.get(node);
      if (signals) {
        updatePropSignals(props, signals);
      } else {
        signals = wrapPropSignals(props, signalProps);
      }
    }
    if (node) {
      if (arePropsDifferent(node.props, props) || parentFiber.deep) {
        updateChild(node, props, parentFiber);
      } else if (node.forceNextRender) {
        rerenderChild(node, props, parentFiber);
      } else if (debug.fiber) {
        debugLog("fiber", `keep ${node.componentName}: props unchanged`);
      }
    } else {
      // new component
      if (isStatic) {
        const components = parent.constructor.components;
        if (!components) {
          throw new OwlError(
            `Cannot find the definition of component "${name}", missing static components key in parent`
          );
        }
        C = components[name as any];
        if (!C) {
          throw new OwlError(`Cannot find the definition of component "${name}"`);
        } else if (!(C.prototype instanceof Component)) {
          throw new OwlError(
            `"${name}" is not a Component. It must inherit from the Component class`
          );
        }
      }
      node = new ComponentNode(C, props, app, ctx, key);
      if (signals) {
        propSignals.set(node, signals);
      }
      (ctx.childMap ||= new Map()).set(key, node);
      const fiber = new Fiber(node, parentFiber);
      if (node.willStart.length) {
        initiateRender.call(node, fiber);
      } else {
        node.fiber = fiber;
        if (node.mounted.length) {
          fiber.root!.mounted.push(fiber);
        }
        fiber.render();
      }
    }
    (parentFiber.childrenMap ||= new Map()).set(key, node);
    memoCollectChild(key);
    return node;
  };
}

function callTemplate(
  subTemplate: string,
  owner: any,
  app: App,
  ctx: any,
  parent: any,
  key: any
): any {
  const template = app.getTemplate(subTemplate);
  return toggler(subTemplate, template.call(owner, ctx, parent, key + subTemplate));
}

// A t-tag value is spliced into block markup: anything that could close the
// tag or open an attribute would be parsed as markup.
const INVALID_TAG_NAME = /[\s"'<>\/=&`]/;

function checkTagName(tag: unknown): unknown {
  if (tag && (typeof tag !== "string" || INVALID_TAG_NAME.test(tag))) {
    throw new OwlError(`Invalid tag name: '${tag}'`);
  }
  return tag;
}

export const helpers = {
  withDefault,
  checkTagName,
  zero: Symbol("zero"),
  callSlot,
  withKey,
  keyOf,
  prepareList,
  toNumber,
  LazyValue,
  safeOutput,
  safeOutputOr,
  createCatcher,
  markRaw,
  OwlError,
  createRef,
  modelExpr,
  createComponent,
  callTemplate,
  callHandler,
  memoPrevious,
  memoKeep,
  memoHit,
  memoBegin,
  memoEnd,
};
