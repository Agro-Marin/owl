import {
  atomSymbol,
  computed,
  debug,
  debugLog,
  OwlError,
  readArrayItems,
  ReadonlyReactiveValue,
  signal,
  Signal,
  toRaw,
  untrack,
} from "@odoo/owl-core";
import { App } from "../app";
import { BDom, createCatcher, multi, RefCallback, shapeToggler, text, toggler } from "../blockdom";
import { html } from "../blockdom/index";
import { Component } from "../component";
import { ComponentNode } from "../component_node";
import { Markup } from "../utils";
import { handleHookRejection } from "./error_handling";
import { memoBegin, memoCollectChild, memoEnd, memoHit, memoKeep, memoPrevious } from "./memo";
import { Fiber, makeChildFiber } from "./fibers";

const ObjectCreate = Object.create;

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
  defaultContent?: (ctx: any, node: any, key: string) => BDom,
  owner?: any
): BDom {
  const slots = ctx.__owl__.props.slots;
  let slot = slots && slots[name];
  let slotBDom: BDom | null = null;
  const segment = escapeKey(name);
  if (slot && slot.__render) {
    const raw = toRaw(slot);
    if (raw !== slot) {
      if (debug.template) {
        debugLog(
          "template",
          `slot "${name}": its descriptor is a proxy, rendered from its raw object`
        );
      }
      slot = raw;
    }
    let slotCtx = slot.__ctx || {};
    if (slot.__scope) {
      slotCtx = ObjectCreate(slotCtx);
      slotCtx[slot.__scope] = extra || {};
    }
    slotBDom = slot.__render.call(slot.__owner, slotCtx, parent, key + MARK + "s" + segment);
  }
  if (defaultContent) {
    let child1: BDom | undefined = undefined;
    let child2: BDom | undefined = undefined;
    if (slotBDom) {
      child1 = toggler(dynamic ? name : slot.__render, slotBDom);
    } else {
      child2 = defaultContent.call(owner, ctx, parent, key + MARK + "d" + segment);
    }
    return multi([child1, child2]);
  }
  return slotBDom ? toggler(slot.__render, slotBDom) : toggler(null, text(""));
}

function callBlock(bdom: BDom | null | undefined): BDom {
  return shapeToggler(bdom || text(""));
}

const MARK = "\u0002";
const MARK2 = "\u0002\u0002";

function escapeKey(value: unknown): string {
  const name = String(value);
  return name.includes(MARK) ? name.replaceAll(MARK, MARK2) : name;
}

const objectKeys = new WeakMap<object, string>();
let nextObjectKey = 0;

function identityKey(key: any): string {
  let id = objectKeys.get(key);
  if (id === undefined) {
    id = "@" + ++nextObjectKey;
    objectKeys.set(key, id);
  }
  return id;
}

function keyOf(key: any): string {
  if (typeof key === "number") {
    const digits = "" + key;
    return digits.charCodeAt(digits.length - 1) <= 0x39 ? digits : "@" + digits;
  }
  if (typeof key === "string") {
    if (key.includes(MARK)) {
      key = key.replaceAll(MARK, MARK2);
    }
    return key.charCodeAt(0) <= 0x40 ? "'" + key : key;
  }
  if (typeof key === "object" && key !== null) {
    return Array.isArray(key) ? arrayKey(key, null) : identityKey(key);
  }
  if (typeof key === "function") {
    return identityKey(key);
  }
  if (typeof key === "symbol") {
    const name = Symbol.keyFor(key);
    return name === undefined ? identityKey(key) : "@for:" + escapeKey(name);
  }
  if (typeof key === "bigint") {
    return "@" + key + "n";
  }
  return "@" + key;
}

function arrayKey(items: any[], open: any[][] | null): string {
  const outer = open || [];
  outer.push(items);
  let result = "@[";
  for (const item of items) {
    const level = Array.isArray(item) ? outer.indexOf(item) : -1;
    if (level !== -1) {
      result += "@^" + (outer.length - level);
    } else {
      result += Array.isArray(item) ? arrayKey(item, outer) : keyOf(item);
    }
    result += MARK + ",";
  }
  outer.pop();
  return result + MARK + "]";
}

function listKey(key: any): any {
  if (typeof key === "string") {
    const first = key.charCodeAt(0);
    return first === 0x40 || first === 0x27 ? "'" + key : key;
  }
  return key !== key || Array.isArray(key) ? keyOf(key) : key;
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

  evaluate(siteKey: string = "", node: any = this.node): any {
    let key = siteKey + MARK + "v";
    if (node !== this.node) {
      key += identityKey(this.node);
      if (debug.fiber) {
        debugLog(
          "fiber",
          `t-set body of ${this.node.componentName} output by ${node.componentName}: its components are ${node.componentName}'s`
        );
      }
    }
    return this.fn.call(this.component, this.ctx, node, key + this.key);
  }

  toString() {
    const bdom = this.evaluate();
    if (holdsComponent(bdom)) {
      throw new OwlError(
        "A t-set body holding a component cannot be stringified (used in an attribute or an interpolation): output it with t-out"
      );
    }
    return bdom.toString();
  }
}

function attrValue(value: any): any {
  if (value instanceof LazyValue) {
    if (debug.template) {
      debugLog("template", "t-set body given to an attribute: stringified in the render");
    }
    return value.toString();
  }
  return value;
}

function readObjectAttr(value: any) {
  if (value && typeof value === "object") {
    if (Array.isArray(value)) {
      for (const item of value) {
        readObjectAttr(item);
      }
    } else if (toRaw(value) !== value) {
      if (debug.template) {
        debugLog("template", "a proxied class or style object is read in the render");
      }
      for (const key in value) {
        value[key];
      }
    }
  }
}

function objectAttrValue(value: any): any {
  value = attrValue(value);
  readObjectAttr(value);
  return value;
}

function attrsValue(attrs: any): any {
  if (Array.isArray(attrs)) {
    if (attrs[0] === "class" || attrs[0] === "style") {
      readObjectAttr(attrs[1]);
    }
    return attrs[1] instanceof LazyValue ? [attrs[0], attrValue(attrs[1])] : attrs;
  }
  if (attrs && typeof attrs === "object") {
    let copy: any = null;
    for (const name in attrs) {
      const value = attrs[name];
      if (value instanceof LazyValue) {
        copy ||= { ...attrs };
        copy[name] = attrValue(value);
      } else if (name === "class" || name === "style") {
        readObjectAttr(value);
      }
    }
    return copy || attrs;
  }
  return attrs;
}

function holdsComponent(bdom: any): boolean {
  if (bdom instanceof ComponentNode) {
    return true;
  }
  const children: any[] | undefined = bdom.children;
  if (children) {
    for (const child of children) {
      if (child && holdsComponent(child)) {
        return true;
      }
    }
  }
  return bdom.child ? holdsComponent(bdom.child) : false;
}

export function safeOutput(
  value: any,
  node?: any,
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
  let safeKey: unknown;
  let block;
  if (value instanceof Markup) {
    safeKey = `string_safe`;
    block = html(value);
  } else if (value instanceof LazyValue) {
    safeKey = value.fn;
    let siteKey = key + site;
    if (depth) {
      siteKey += MARK + ":" + keyOf(k1);
      if (depth > 1) {
        siteKey += MARK + ":" + keyOf(k2);
        if (depth > 2) {
          siteKey += MARK + ":" + keyOf(k3);
        }
      }
    }
    block = value.evaluate(siteKey, node);
  } else {
    safeKey = "string_unsafe";
    block = text(value);
  }
  return toggler(safeKey, block);
}

function createRef(ref: any, node: ComponentNode) {
  if (!ref) {
    throw new OwlError(`Ref is undefined or null`);
  }
  const callbacks = (node.refCallbacks ||= new WeakMap());
  let callback = callbacks.get(ref);
  if (!callback) {
    callback = makeRefCallback(ref);
    callbacks.set(ref, callback);
  }
  return callback;
}

function makeRefCallback(ref: any): RefCallback {
  let add: (el: HTMLElement) => void;
  let remove: (el: HTMLElement) => void;

  if (ref.add && ref.delete) {
    add = (el: HTMLElement) => ref.add(el);
    remove = (prevEl: HTMLElement) => ref.delete(prevEl);
  } else if (ref.set) {
    const atom = (ref as any)[atomSymbol];
    if (atom) {
      add = (el: HTMLElement) => ref.set(el);
      remove = (prevEl: HTMLElement) => {
        if (atom.value === prevEl) ref.set(null);
      };
    } else {
      let current: HTMLElement | null = null;
      add = (el: HTMLElement) => {
        current = el;
        ref.set(el);
      };
      remove = (prevEl: HTMLElement) => {
        if (current === prevEl) {
          current = null;
          ref.set(null);
        }
      };
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

function rerenderChild(node: ComponentNode, props: Record<string, any>, parentFiber: Fiber) {
  if (debug.fiber) {
    debugLog("fiber", `render ${node.componentName} again: its pending render was cancelled`);
  }
  const fiber = childUpdateFiber(node, parentFiber);
  node.props = props;
  fiber.render();
}

function childUpdateFiber(node: ComponentNode, parentFiber: Fiber): Fiber {
  node.forceNextRender = false;
  const fiber = makeChildFiber(node, parentFiber);
  node.fiber = fiber;
  const parentRoot = parentFiber.root!;
  if (node.willPatch.length) parentRoot.willPatch.push(fiber);
  if (node.patched.length) parentRoot.patched.push(fiber);
  return fiber;
}

function updateChild(node: ComponentNode, props: Record<string, any>, parentFiber: Fiber) {
  if (debug.fiber) {
    debugLog(
      "fiber",
      `update ${node.componentName}: ${parentFiber.deep ? "deep render" : "props changed"}${node.willUpdateProps.length ? `, ${node.willUpdateProps.length} willUpdateProps` : ""}`
    );
  }
  const fiber = childUpdateFiber(node, parentFiber);
  const promises = node.willUpdateProps.length ? callWillUpdateProps(node, props) : undefined;
  if (promises) {
    renderAfter(promises, node, fiber, props);
  } else {
    renderWithProps(node, fiber, props);
  }
}

function renderWithProps(node: ComponentNode, fiber: Fiber, props: Record<string, any>) {
  node.props = props;
  for (const view of node.propsUpdated) view.update();
  fiber.render();
}

function callWillUpdateProps(
  node: ComponentNode,
  props: Record<string, any>
): Promise<any>[] | undefined {
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
  const hooks = node.willUpdateProps;
  const component = node.component;
  let promises: Promise<any>[] | undefined;
  untrack(() => {
    try {
      for (const f of hooks) {
        const r = f.call(component, nextProps);
        if (r && typeof r.then === "function") {
          (promises ||= []).push(r);
        }
      }
    } catch (e) {
      for (const promise of promises || []) {
        promise.catch(() => {});
      }
      throw e;
    }
  });
  return promises;
}

function renderAfter(
  promises: Promise<any>[],
  node: ComponentNode,
  fiber: Fiber,
  props: Record<string, any>
) {
  const p = promises.length === 1 ? promises[0] : Promise.all(promises);
  p.then(
    () => {
      if (fiber !== node.fiber) {
        if (debug.fiber) {
          debugLog(
            "fiber",
            `drop ${node.componentName}'s update: superseded, or the component destroyed`
          );
        }
        return;
      }
      renderWithProps(node, fiber, props);
    },
    (error) => handleHookRejection(node, fiber, error)
  );
}

const classKeys = new WeakMap<Function, string>();
let nextClassKey = 1;

function classKey(C: Function): string {
  let key = classKeys.get(C);
  if (key === undefined) {
    key = MARK + "c" + nextClassKey++;
    classKeys.set(C, key);
  }
  return key;
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
      let n = 0;
      for (let k in props1) {
        if (props1[k] !== props2[k] || !(k in props2)) {
          if (debug.fiber) {
            debugLog("fiber", `t-props: prop "${k}" changed or went`);
          }
          return true;
        }
        n++;
      }
      for (let k in props2) {
        if (n-- === 0) {
          if (debug.fiber) {
            debugLog("fiber", `t-props: prop "${k}" came`);
          }
          return true;
        }
      }
      return n !== 0;
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

  return (props: P, key: string, ctx: ComponentNode, parent: any, C: any) => {
    if (isDynamic) {
      key = key + classKey(C);
    }
    let node: any = ctx.childMap?.get(key);
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
      (parentFiber.childrenMap ||= new Map()).set(key, node);
      node.start(new Fiber(node, parentFiber));
      memoCollectChild(key);
      return node;
    }
    (parentFiber.childrenMap ||= new Map()).set(key, node);
    memoCollectChild(key);
    return node;
  };
}

const zero = Symbol("zero");
const zeroCtx = Symbol("zeroCtx");

function withoutZero(ctx: any): any {
  const callCtx = ObjectCreate(ctx);
  callCtx[zero] = null;
  return callCtx;
}

function slotContext(ctx: any): any {
  const result: any = {};
  for (const key in ctx) {
    result[key] = ctx[key];
  }
  if (ctx[zero] !== undefined) {
    result[zero] = ctx[zero];
    result[zeroCtx] = ctx[zeroCtx];
  }
  return result;
}

function callContext(ctx: any): any {
  const result: any = {};
  for (const key in ctx) {
    result[key] = ctx[key];
  }
  result[zero] = null;
  return result;
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
  const callKey = key + MARK + "t" + escapeKey(subTemplate);
  return toggler(subTemplate, template.call(owner, ctx, parent, callKey));
}

const INVALID_TAG_NAME = /[\s"'<>\/=&`:]|^block-/;

function checkTagName(tag: unknown): unknown {
  if (tag && (typeof tag !== "string" || INVALID_TAG_NAME.test(tag))) {
    throw new OwlError(`Invalid tag name: '${tag}'`);
  }
  return tag;
}

export const helpers = {
  withDefault,
  checkTagName,
  zero,
  zeroCtx,
  withoutZero,
  slotContext,
  callContext,
  callSlot,
  callBlock,
  withKey,
  keyOf,
  listKey,
  prepareList,
  toNumber,
  LazyValue,
  safeOutput,
  attrValue,
  objectAttrValue,
  attrsValue,
  createCatcher,
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
