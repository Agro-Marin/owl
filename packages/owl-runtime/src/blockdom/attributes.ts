import { OwlError } from "@odoo/owl-core";
import type { Setter, Updater } from "./block_compiler";

let elemSetAttribute: typeof Element.prototype.setAttribute;
let removeAttribute: typeof Element.prototype.removeAttribute;
let tokenListAdd: typeof DOMTokenList.prototype.add;
let tokenListRemove: typeof DOMTokenList.prototype.remove;
if (typeof Element !== "undefined") {
  ({ setAttribute: elemSetAttribute, removeAttribute } = Element.prototype);
  const tokenList = DOMTokenList.prototype;
  tokenListAdd = tokenList.add;
  tokenListRemove = tokenList.remove;
}
const isArray = Array.isArray;
const { split, trim } = String.prototype;
const wordRegexp = /\s+/;

/**
 * We regroup here all code related to updating attributes in a very loose sense:
 * attributes, properties and classs are all managed by the functions in this
 * file.
 */

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

export function createAttrUpdater(attr: string): Setter<HTMLElement> {
  return function (this: HTMLElement, value: any) {
    setAttribute.call(this, attr, value);
  };
}

const NO_ATTRS = Object.freeze({});

// t-att takes an object, a [name, value] pair, or nothing at all
function toAttrs(attrs: any): { [name: string]: any } {
  if (!attrs) {
    return NO_ATTRS;
  }
  if (isArray(attrs)) {
    return { [attrs[0]]: attrs[1] };
  }
  if (typeof attrs !== "object") {
    throw new OwlError(
      `Invalid t-att value '${String(attrs)}': expected an object or a [name, value] pair`
    );
  }
  return attrs;
}

export function makeAttrsUpdaters(
  updateClassFn: Updater<HTMLElement>,
  updateStyleFn: Updater<HTMLElement>
): {
  attrsSetter: Setter<HTMLElement>;
  attrsUpdater: Updater<HTMLElement>;
} {
  function updateAttr(el: HTMLElement, name: string, val: any, oldVal: any) {
    if (name === "class") {
      updateClassFn.call(el, val, oldVal);
    } else if (name === "style") {
      updateStyleFn.call(el, val, oldVal);
    } else {
      setAttribute.call(el, name, val);
    }
  }
  function attrsUpdater(this: HTMLElement, attrs: any, oldAttrs: any) {
    const next = toAttrs(attrs);
    const prev = toAttrs(oldAttrs);
    for (const name in prev) {
      if (!(name in next)) {
        updateAttr(this, name, undefined, prev[name]);
      }
    }
    for (const name in next) {
      const val = next[name];
      if (val !== prev[name]) {
        updateAttr(this, name, val, prev[name]);
      }
    }
  }
  function attrsSetter(this: HTMLElement, attrs: any) {
    attrsUpdater.call(this, attrs, NO_ATTRS);
  }
  return { attrsSetter, attrsUpdater };
}

export const { attrsSetter, attrsUpdater } = makeAttrsUpdaters(updateClass, updateStyle);

type ClassExpr = string | number | boolean | String | ClassExpr[] | { [c: string]: any };

function toClassObj(expr: ClassExpr | null | undefined): { [c: string]: any } {
  const result: { [c: string]: any } = {};
  addClasses(result, expr);
  return result;
}

function addClasses(result: { [c: string]: any }, expr: ClassExpr | null | undefined) {
  // `cond and 'a'` yields false: no class, as a false t-att-x drops x (0 stays
  // a class, as QWeb renders it)
  if (expr === false || expr === null || expr === undefined) {
    return;
  }
  switch (typeof expr) {
    case "string":
      addWords(result, expr, true);
      return;
    case "object":
      if (isArray(expr)) {
        for (const item of expr) {
          addClasses(result, item);
        }
      } else if (expr instanceof String) {
        addWords(result, expr.valueOf(), true);
      } else {
        // {'a': true, 'b c': true} becomes {a: true, b: true, c: true}
        for (const key in expr) {
          const value = expr[key];
          if (value) {
            addWords(result, key, value);
          }
        }
      }
      return;
    default:
      result[expr as any] = true;
  }
}

function addWords(result: { [c: string]: any }, str: string, value: any) {
  str = trim.call(str);
  if (str) {
    const words = split.call(str, wordRegexp);
    for (let i = 0, l = words.length; i < l; i++) {
      result[words[i]] = value;
    }
  }
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const CSS_PROP_CACHE: { [key: string]: string } = Object.create(null);

function toKebabCase(prop: string): string {
  if (prop in CSS_PROP_CACHE) {
    return CSS_PROP_CACHE[prop];
  }
  // custom properties are case-sensitive: `--mainColor` is not `--main-color`
  const result = prop.startsWith("--")
    ? prop
    : prop.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
  CSS_PROP_CACHE[prop] = result;
  return result;
}

const IMPORTANT_RE = /\s*!\s*important\s*$/i;

type StyleObj = { [prop: string]: string };

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
      const len = str.length;
      let i = 0;
      while (i < len) {
        const start = i;
        let depth = 0;
        let quote = 0;
        while (i < len) {
          const c = str.charCodeAt(i);
          if (quote) {
            if (c === 92 /* \ */) {
              i += 2;
              continue;
            }
            if (c === quote) {
              quote = 0;
            }
          } else if (c === 34 /* " */ || c === 39 /* ' */) {
            quote = c;
          } else if (c === 40 /* ( */) {
            depth++;
          } else if (c === 41 /* ) */) {
            if (depth > 0) depth--;
          } else if (c === 59 /* ; */ && depth === 0) {
            break;
          }
          i++;
        }
        const part = trim.call(str.slice(start, i));
        i++;
        if (!part) {
          continue;
        }
        const colonIdx = part.indexOf(":");
        if (colonIdx === -1) {
          continue;
        }
        const prop = trim.call(part.slice(0, colonIdx));
        const value = trim.call(part.slice(colonIdx + 1));
        if (prop && value && value !== "undefined") {
          result[prop] = value;
        }
      }
      return result;
    }
    case "object":
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

// ---------------------------------------------------------------------------
// Class
// ---------------------------------------------------------------------------

export function setClass(this: HTMLElement, val: any) {
  val = toClassObj(val);
  for (let k in val) {
    tokenListAdd.call(this.classList, k);
  }
}

export function updateClass(this: HTMLElement, val: any, oldVal: any) {
  oldVal = toClassObj(oldVal);
  val = toClassObj(val);
  for (let k in oldVal) {
    if (!(k in val)) {
      tokenListRemove.call(this.classList, k);
    }
  }
  for (let k in val) {
    if (val[k] !== oldVal[k]) {
      tokenListAdd.call(this.classList, k);
    }
  }
}

// An element whose class several sources write (a static class plus t-att-class,
// t-att-class plus t-att) counts the sources holding each class, so one source
// dropping a class does not remove it from under another.
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
  function classUpdater(this: HTMLElement, val: any, oldVal: any) {
    const prev = toClassObj(oldVal);
    const next = toClassObj(val);
    const classList = this.classList;
    let counts: Map<string, number> | undefined;
    for (const k in prev) {
      if (!(k in next)) {
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
      if (!(k in prev)) {
        counts ||= getCounts(this);
        counts.set(k, (counts.get(k) || 0) + 1);
        tokenListAdd.call(classList, k);
      } else if (next[k] !== prev[k]) {
        tokenListAdd.call(classList, k);
      }
    }
  }
  return classUpdater;
}

// ---------------------------------------------------------------------------
// Style setters
// ---------------------------------------------------------------------------

export function setStyle(this: HTMLElement, val: any) {
  val = val === "" ? {} : toStyleObj(val);
  const style = this.style;
  for (let prop in val) {
    setStyleProp(style, prop, val[prop]);
  }
}

export function updateStyle(this: HTMLElement, val: any, oldVal: any) {
  patchStyle(this, oldVal === "" ? {} : toStyleObj(oldVal), val === "" ? {} : toStyleObj(val));
}

function patchStyle(el: HTMLElement, oldVal: StyleObj, val: StyleObj) {
  const style = el.style;
  // Properties are applied in declaration order. Re-setting a shorthand (e.g.
  // `background`, `margin`) resets the longhands it covers: once a property
  // changed or moved, an unchanged one after it is re-applied if the element
  // no longer holds its value. Removing a property re-applies all of them, as
  // a removed shorthand clears longhands that some engines (jsdom) still report.
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
      // moved after a property it used to precede, which may overwrite it now
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

// An element whose style several sources write (a static style plus
// t-att-style, t-att-style plus t-att) keeps one layer per source, each over
// the ones before it and all over the static style, and is patched with their
// merge: a source dropping a property restores what a layer below sets.
const styleLayers = new WeakMap<Element, { layers: StyleObj[]; applied: StyleObj }>();

export function makeSharedStyleUpdaters(staticStyle: string): () => Updater<HTMLElement> {
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
      layers[layer] = toStyleObj(val);
      // a property a later layer sets again moves to its declaration order
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
    };
  };
}
