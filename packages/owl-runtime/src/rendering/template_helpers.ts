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

/**
 * Renders the slot `name` of the component of `ctx`. A slot descriptor is
 * data: its static render function (`__render`), the context it was written
 * in (`__ctx`) and the `this` of the template that wrote it (`__owner`), its
 * slot scope name (`__scope`) and its attributes. `extra` is the scope the
 * call site gives (null without attributes); a default content is a static
 * function too, run with `owner`, the `this` of the calling template.
 */
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
    // a descriptor read through a proxy (slots held in proxied state) would
    // give its proxied context and owner, whose private members it cannot
    // reach: the slot renders from the raw descriptor. Slots are not marked
    // raw for this: that cost a WeakSet entry per render, for its outer object only
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
    // a slot renders in the context it was written in: a scope of its own
    // only for its slot scope variable. Its code writes no variable into the
    // context it is given (a t-set makes a scope first), and a context put
    // under a new one becomes a prototype, which V8 makes at a cost of about
    // 1 KB and 1.5 µs when the context is new, as a loop item's is
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
      child1 = dynamic ? toggler(name, slotBDom) : slotBDom;
    } else {
      // its sites are numbered in another template than the slot's: the
      // same key would give a component of one to a site of the other
      child2 = defaultContent.call(owner, ctx, parent, key + MARK + "d" + segment);
    }
    return multi([child1, child2]);
  }
  return slotBDom || text("");
}

// A key (of a child component, a memo site) is the path to its site: a string
// of segments, each a mark, a tag and a payload. The mark is \u0002, and every
// payload taken from a template's values doubles it, so a mark followed by
// anything but another mark always starts a segment, and two different paths
// never spell one key, whatever the loop keys, t-keys, slot and template names.
// The compiler writes the static segments in the generated code:
//   \u0002<digits>  a site (component, slot call, t-call, t-out, t-set body,
//                   t-memo list), its id unique in its template
//   \u0002:<value>  the key of an open loop, after its site
//   \u0002k<value>  the t-key around a site, before it
// and the helpers below the others:
//   \u0002s<name>   a slot's content, \u0002d<name> its default content
//   \u0002t<name>   the template a t-call renders
//   \u0002c<id>     a dynamic component's class
//   \u0002v[<id>]   a t-set body at its output site, then the body's own key
//                   (the id of the component it was set in, when another one
//                   outputs it)
const MARK = "\u0002";
const MARK2 = "\u0002\u0002";

// a slot or template name, which a dynamic one may not be: `{{ x.slot }}`
// with no slot gives undefined, and slots[undefined] is slots["undefined"]
function escapeKey(value: unknown): string {
  const name = String(value);
  return name.includes(MARK) ? name.replaceAll(MARK, MARK2) : name;
}

// A value's payload tells every value apart, its type included. A number is
// its digits; a string is itself, escaped, quoted with ' when its first
// character is at or below "@" (as a number's, a quoted string's and the
// others' are); the others start with "@": "@3" an object, a function or an
// unregistered symbol (by identity), "@true", "@null", "@undefined", "@5n",
// "@NaN", "@-Infinity", "@for:<name>" a registered symbol, and "@[" an array:
// the payload of each item followed by \u0002, then \u0002] (a new array of
// the same items is the same key).
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
    // a finite number ends with a digit; NaN and the infinities do not
    return digits.charCodeAt(digits.length - 1) <= 0x39 ? digits : "@" + digits;
  }
  if (typeof key === "string") {
    if (key.includes(MARK)) {
      key = key.replaceAll(MARK, MARK2);
    }
    // the others start with a digit, "-" or "@", all at or below "@"
    return key.charCodeAt(0) <= 0x40 ? "'" + key : key;
  }
  if (typeof key === "object" && key !== null) {
    return Array.isArray(key) ? arrayKey(key, null) : identityKey(key);
  }
  if (typeof key === "function") {
    return identityKey(key);
  }
  if (typeof key === "symbol") {
    // a registered symbol cannot be a WeakMap key; it is its registry name
    const name = Symbol.keyFor(key);
    return name === undefined ? identityKey(key) : "@for:" + escapeKey(name);
  }
  if (typeof key === "bigint") {
    return "@" + key + "n";
  }
  // a boolean, null, undefined
  return "@" + key;
}

// an array among the items of an array that holds it is "@^" and how many
// levels up it is
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

  // Renders the body at an output site of `node`, whose components it is:
  // they are in its DOM, its render creates and updates them, and its
  // destruction or a render dropping the site destroys them. Their key is the
  // site's, then this value's (its node's id first when it is not `node`: two
  // components may output their own values at one site of a third).
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

  // what an attribute or an interpolation makes of a t-set body: its HTML. A
  // component would be created for a string, never mounted, and kept alive
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

// the value a render gives an attribute or a property: a t-set body's string,
// taken while the render runs, so that the render tracks what the body reads
// and the block compares strings (the patch would stringify the same body
// object again only if it were another one, and read it untracked)
function attrValue(value: any): any {
  if (value instanceof LazyValue) {
    if (debug.template) {
      debugLog("template", "t-set body given to an attribute: stringified in the render");
    }
    return value.toString();
  }
  return value;
}

// the same for t-att's object or [name, value] pair: a copy holding the
// strings of its t-set bodies, the value itself when it holds none
function attrsValue(attrs: any): any {
  if (Array.isArray(attrs)) {
    return attrs[1] instanceof LazyValue ? [attrs[0], attrValue(attrs[1])] : attrs;
  }
  if (attrs && typeof attrs === "object") {
    let copy: any = null;
    for (const name in attrs) {
      if (attrs[name] instanceof LazyValue) {
        copy ||= { ...attrs };
        copy[name] = attrValue(attrs[name]);
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

/*
 * Safely outputs `value` as a block depending on the nature of `value`. A
 * LazyValue (a t-set body) renders under the key of the output site: `key` +
 * `site` + the `depth` loop keys around it, joined only for a LazyValue, in
 * the component `node` renders.
 */
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
    // two bodies output at one site are two kinds of content: a body is
    // patched by the same body only (each makes blocks of its own)
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
      // as above: the element unbound may no longer be the one the ref holds
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
 * hooks have run (and settled, when one returns a promise). It holds no
 * closure, nor do the createComponent closure's own: a variable a closure
 * captures makes every call of its function allocate a context, a child
 * without hooks included. The hooks and the wait are in functions of their
 * own.
 */
function updateChild(node: ComponentNode, props: Record<string, any>, parentFiber: Fiber) {
  if (debug.fiber) {
    debugLog(
      "fiber",
      `update ${node.componentName}: ${parentFiber.deep ? "deep render" : "props changed"}${node.willUpdateProps.length ? `, ${node.willUpdateProps.length} willUpdateProps` : ""}`
    );
  }
  node.forceNextRender = false;
  const fiber = makeChildFiber(node, parentFiber);
  node.fiber = fiber;
  const parentRoot = parentFiber.root!;
  if (node.willPatch.length) parentRoot.willPatch.push(fiber);
  if (node.patched.length) parentRoot.patched.push(fiber);
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

/**
 * Runs a child's onWillUpdateProps hooks, untracked, and returns the
 * promises they return, if any.
 */
function callWillUpdateProps(
  node: ComponentNode,
  props: Record<string, any>
): Promise<any>[] | undefined {
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
  const hooks = node.willUpdateProps;
  const component = node.component;
  let promises: Promise<any>[] | undefined;
  untrack(() => {
    for (const f of hooks) {
      const r = f.call(component, nextProps);
      if (r && typeof r.then === "function") {
        (promises ||= []).push(r);
      }
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

// A dynamic component's key ends with its class's: a node is reused only by
// the class that created it. An id, not the class name, which two classes may
// share.
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
    // both are object literals of the template: the same prototype, so the
    // keys a for-in counts differ as their own keys do, with no key array
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
      // the others are the same: props2 has a key more once the count runs out
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
      // only in the render's children: the node joins ctx.childMap once
      // that render is committed. It is one of them before its first render
      // runs: an error that render does not catch destroys the app, which
      // reaches the node only through them.
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

// the 0 of a t-call body (helpers.zero), and the context the body runs in
const zero = Symbol("zero");
const zeroCtx = Symbol("zeroCtx");

/**
 * The context of a call that gives no 0, for a caller that has one: the
 * called template must not see it.
 */
function withoutZero(ctx: any): any {
  const callCtx = ObjectCreate(ctx);
  callCtx[zero] = null;
  return callCtx;
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

// A t-tag value is spliced into block markup: anything that could close the
// tag or open an attribute would be parsed as markup, a prefix needs a
// namespace the block does not declare, and a block- name is one of the
// block compiler's own placeholders.
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
  callSlot,
  withKey,
  keyOf,
  prepareList,
  toNumber,
  LazyValue,
  safeOutput,
  attrValue,
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
