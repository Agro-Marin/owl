import { OwlError } from "@odoo/owl-core";
import type { Setter, Snapshotter } from "./block_compiler";
import { fromDom } from "./dom";

const elemSetAttribute = /* @__PURE__ */ fromDom(() => Element.prototype.setAttribute);
const removeAttribute = /* @__PURE__ */ fromDom(() => Element.prototype.removeAttribute);
const elemSetAttributeNS = /* @__PURE__ */ fromDom(() => Element.prototype.setAttributeNS);
const removeAttributeNS = /* @__PURE__ */ fromDom(() => Element.prototype.removeAttributeNS);
const tokenListAdd = /* @__PURE__ */ fromDom(() => DOMTokenList.prototype.add);
const tokenListRemove = /* @__PURE__ */ fromDom(() => DOMTokenList.prototype.remove);
const isArray = Array.isArray;
const wordRegexp = /\s+/;

function setAttribute(this: HTMLElement, key: string, value: any) {
  switch (value) {
    case false:
    case null:
    case undefined:
      removeAttribute.call(this, key);
      break;
    case true:
      elemSetAttribute.call(this, key, "");
      break;
    default:
      elemSetAttribute.call(this, key, value);
  }
}

export function createAttrUpdater(attr: string, ns?: string | null): Setter<HTMLElement> {
  if (ns) {
    const localName = attr.slice(attr.indexOf(":") + 1);
    return function (this: HTMLElement, value: any) {
      const str = toAttrValue(value);
      if (str === null) {
        removeAttributeNS.call(this, ns, localName);
      } else {
        elemSetAttributeNS.call(this, ns, attr, str);
      }
    };
  }
  return function (this: HTMLElement, value: any) {
    setAttribute.call(this, attr, value);
  };
}

const NO_ATTRS = /* @__PURE__ */ Object.freeze({});

function toAttrs(attrs: any): { [name: string]: any } {
  if (!attrs) {
    return NO_ATTRS;
  }
  if (isArray(attrs)) {
    return { [attrs[0]]: attrs[1] };
  }
  if (typeof attrs !== "object" || attrs instanceof String) {
    throw new OwlError(
      `Invalid t-att value '${String(attrs)}': expected an object or a [name, value] pair`
    );
  }
  return attrs;
}

function toAttrValue(value: any): string | null {
  switch (value) {
    case false:
    case null:
    case undefined:
      return null;
    case true:
      return "";
    default:
      return typeof value === "string" ? value : String(value);
  }
}

function writeAttr(el: Element, name: string, value: string | null) {
  const colon = name.indexOf(":");
  const ns = colon > 0 ? prefixNamespace(el, name.slice(0, colon)) : null;
  if (ns) {
    if (value === null) {
      removeAttributeNS.call(el, ns, name.slice(colon + 1));
    } else {
      elemSetAttributeNS.call(el, ns, name, value);
    }
  } else if (value === null) {
    removeAttribute.call(el, name);
  } else {
    elemSetAttribute.call(el, name, value);
  }
}

const KNOWN_PREFIXES: { [prefix: string]: string } = {
  xlink: "http://www.w3.org/1999/xlink",
  xml: "http://www.w3.org/XML/1998/namespace",
};

export function prefixNamespace(node: Node, prefix: string): string | null {
  return Object.hasOwn(KNOWN_PREFIXES, prefix)
    ? KNOWN_PREFIXES[prefix]
    : node.lookupNamespaceURI(prefix);
}

type AttrsSnap = { [name: string]: any };

function nullProtoClass(): new () => AttrsSnap {
  function Snap() {}
  Snap.prototype = Object.create(null);
  return Snap as any;
}

const AttrsSnap = /* @__PURE__ */ nullProtoClass();

const NO_ATTRS_SNAP = /* @__PURE__ */ Object.freeze(new AttrsSnap());

export function makeAttrsUpdater(
  updateClassFn: Snapshotter<HTMLElement>,
  updateStyleFn: Snapshotter<HTMLElement>
): Snapshotter<HTMLElement> {
  function attrsUpdater(this: HTMLElement, attrs: any, prev: AttrsSnap = NO_ATTRS_SNAP): AttrsSnap {
    const next = toAttrs(attrs);
    const snap = new AttrsSnap();
    for (const name in next) {
      const val = next[name];
      if (name === "class") {
        snap.class = updateClassFn.call(this, val, prev.class);
      } else if (name === "style") {
        snap.style = updateStyleFn.call(this, val, prev.style);
      } else {
        const value = toAttrValue(val);
        if (value !== prev[name]) {
          writeAttr(this, name, value);
        }
        snap[name] = value;
      }
    }
    for (const name in prev) {
      if (snap[name] === undefined) {
        if (name === "class") {
          updateClassFn.call(this, undefined, prev.class);
        } else if (name === "style") {
          updateStyleFn.call(this, undefined, prev.style);
        } else if (prev[name] !== null) {
          writeAttr(this, name, null);
        }
      }
    }
    return snap;
  }
  return attrsUpdater;
}

export function makeAttrsSetter(attrsUpdater: Snapshotter<HTMLElement>): Setter<HTMLElement> {
  return function attrsSetter(this: HTMLElement, attrs: any) {
    return attrsUpdater.call(this, attrs, NO_ATTRS_SNAP);
  };
}

export const attrsUpdater = /* @__PURE__ */ makeAttrsUpdater(updateClass, updateStyle);
export const attrsSetter = /* @__PURE__ */ makeAttrsSetter(attrsUpdater);

type ClassExpr = string | number | boolean | String | ClassExpr[] | { [c: string]: any };

const SOURCE = /* @__PURE__ */ Symbol("source");

type ClassSnap = { [c: string]: true; [SOURCE]?: string };

const NO_CLASSES: ClassSnap = /* @__PURE__ */ Object.freeze({}) as ClassSnap;

function toClassObj(expr: ClassExpr | null | undefined): ClassSnap {
  const result: ClassSnap = {};
  if (typeof expr === "string") {
    result[SOURCE] = expr;
  }
  addClasses(result, expr);
  return result;
}

function addClasses(result: ClassSnap, expr: ClassExpr | null | undefined) {
  if (expr === false || expr === null || expr === undefined) {
    return;
  }
  switch (typeof expr) {
    case "string":
      addWords(result, expr);
      return;
    case "object":
      if (isArray(expr)) {
        for (const item of expr) {
          addClasses(result, item);
        }
      } else if (expr instanceof String) {
        addWords(result, expr.valueOf());
      } else {
        for (const key in expr) {
          if (expr[key]) {
            addWords(result, key);
          }
        }
      }
      return;
    default:
      result[expr as any] = true;
  }
}

function addWords(result: ClassSnap, str: string) {
  str = str.trim();
  if (str) {
    const words = str.split(wordRegexp);
    for (let i = 0, l = words.length; i < l; i++) {
      result[words[i]] = true;
    }
  }
}

const CSS_PROP_CACHE: { [key: string]: string } = Object.create(null);

function toKebabCase(prop: string): string {
  if (prop in CSS_PROP_CACHE) {
    return CSS_PROP_CACHE[prop];
  }
  const result = prop.startsWith("--")
    ? prop
    : prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  CSS_PROP_CACHE[prop] = result;
  return result;
}

const IMPORTANT_RE = /\s*!\s*important\s*$/i;

type StyleObj = { [prop: string]: string; [SOURCE]?: string };

function holdsStyleProp(style: CSSStyleDeclaration, prop: string, value: string): boolean {
  const important = IMPORTANT_RE.test(value);
  return (
    style.getPropertyPriority(prop) === (important ? "important" : "") &&
    style.getPropertyValue(prop) === (important ? value.replace(IMPORTANT_RE, "") : value)
  );
}

function setStyleProp(style: CSSStyleDeclaration, prop: string, value: string) {
  if (IMPORTANT_RE.test(value)) {
    style.setProperty(prop, value.replace(IMPORTANT_RE, ""), "important");
  } else {
    style.setProperty(prop, value);
  }
}

function toStyleObj(expr: string | { [prop: string]: any }): StyleObj {
  const result: StyleObj = {};
  switch (typeof expr) {
    case "string": {
      const str = expr;
      result[SOURCE] = str;
      const len = str.length;
      let i = 0;
      while (i < len) {
        const start = i;
        let depth = 0;
        let quote = 0;
        while (i < len) {
          const c = str.charCodeAt(i);
          if (quote) {
            if (c === 92) {
              i += 2;
              continue;
            }
            if (c === quote) {
              quote = 0;
            }
          } else if (c === 34 || c === 39) {
            quote = c;
          } else if (c === 40) {
            depth++;
          } else if (c === 41) {
            if (depth > 0) depth--;
          } else if (c === 59 && depth === 0) {
            break;
          }
          i++;
        }
        const part = str.slice(start, i).trim();
        i++;
        if (!part) {
          continue;
        }
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) {
          continue;
        }
        const prop = part.slice(0, colonIdx).trim();
        const value = part.slice(colonIdx + 1).trim();
        if (prop && value && value !== "undefined") {
          result[prop] = value;
        }
      }
      return result;
    }
    case "object":
      if (expr instanceof String) {
        return toStyleObj(expr.valueOf());
      }
      for (let prop in expr as any) {
        const value = (expr as any)[prop];
        if (value || value === 0) {
          result[toKebabCase(prop)] = String(value);
        }
      }
      return result;
    default:
      return {};
  }
}

export function setClass(this: HTMLElement, val: any): ClassSnap {
  const next = toClassObj(val);
  let str = "";
  for (const k in next) {
    str = str ? str + " " + k : k;
  }
  if (str) {
    elemSetAttribute.call(this, "class", str);
  }
  return next;
}

export function updateClass(this: HTMLElement, val: any, prev: ClassSnap = NO_CLASSES): ClassSnap {
  if (typeof val === "string" && prev[SOURCE] === val) {
    return prev;
  }
  const next = toClassObj(val);
  const classList = this.classList;
  for (const k in prev) {
    if (next[k] !== true) {
      tokenListRemove.call(classList, k);
    }
  }
  for (const k in next) {
    if (prev[k] !== true) {
      tokenListAdd.call(classList, k);
    }
  }
  return next;
}

const classCounts = new WeakMap<Element, Map<string, number>>();

export function makeSharedClassUpdaters(staticClasses: string[]) {
  function getCounts(el: HTMLElement): Map<string, number> {
    let counts = classCounts.get(el);
    if (!counts) {
      counts = new Map();
      for (const k of staticClasses) {
        counts.set(k, 1);
      }
      classCounts.set(el, counts);
    }
    return counts;
  }
  function classUpdater(this: HTMLElement, val: any, prev: ClassSnap = NO_CLASSES): ClassSnap {
    if (typeof val === "string" && prev[SOURCE] === val) {
      return prev;
    }
    const next = toClassObj(val);
    const classList = this.classList;
    let counts: Map<string, number> | undefined;
    for (const k in prev) {
      if (next[k] !== true) {
        counts ||= getCounts(this);
        const count = counts.get(k)! - 1;
        if (count) {
          counts.set(k, count);
        } else {
          counts.delete(k);
          tokenListRemove.call(classList, k);
        }
      }
    }
    for (const k in next) {
      if (prev[k] !== true) {
        counts ||= getCounts(this);
        counts.set(k, (counts.get(k) || 0) + 1);
        tokenListAdd.call(classList, k);
      }
    }
    return next;
  }
  return classUpdater;
}

const NO_STYLE: StyleObj = /* @__PURE__ */ Object.freeze({}) as StyleObj;

export function setStyle(this: HTMLElement, val: any): StyleObj {
  const next = toStyleObj(val);
  const style = this.style;
  for (const prop in next) {
    setStyleProp(style, prop, next[prop]);
  }
  return next;
}

export function updateStyle(this: HTMLElement, val: any, prev: StyleObj = NO_STYLE): StyleObj {
  if (typeof val === "string" && prev[SOURCE] === val) {
    return prev;
  }
  const next = toStyleObj(val);
  patchStyle(this, prev, next);
  return next;
}

function patchStyle(el: HTMLElement, oldVal: StyleObj, val: StyleObj) {
  const style = el.style;
  let removed = false;
  for (let prop in oldVal) {
    if (!(prop in val)) {
      style.removeProperty(prop);
      removed = true;
    }
  }
  const oldProps = removed ? null : Object.keys(oldVal);
  let next = 0;
  let changed = false;
  for (let prop in val) {
    const value = val[prop];
    if (oldProps && prop in oldVal && oldProps[next++] !== prop) {
      changed = true;
    }
    if (removed || value !== oldVal[prop] || (changed && !holdsStyleProp(style, prop, value))) {
      setStyleProp(style, prop, value);
      changed = true;
    }
  }
  if (!style.length) {
    removeAttribute.call(el, "style");
  }
}

const styleLayers = new WeakMap<Element, { layers: StyleObj[]; applied: StyleObj }>();

export function makeSharedStyleUpdaters(staticStyle: string): () => Snapshotter<HTMLElement> {
  const base = toStyleObj(staticStyle);
  let sources = 0;
  return () => {
    const layer = ++sources;
    return function styleUpdater(this: HTMLElement, val: any) {
      let state = styleLayers.get(this);
      if (!state) {
        state = { layers: [base], applied: base };
        styleLayers.set(this, state);
      }
      const layers = state.layers;
      const next = (layers[layer] = toStyleObj(val));
      const merged: StyleObj = {};
      for (let i = 0; i < layers.length; i++) {
        const props = layers[i];
        for (const prop in props) {
          delete merged[prop];
          merged[prop] = props[prop];
        }
      }
      patchStyle(this, state.applied, merged);
      state.applied = merged;
      return next;
    };
  };
}
