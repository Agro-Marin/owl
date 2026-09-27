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
  return !attrs ? NO_ATTRS : isArray(attrs) ? { [attrs[0]]: attrs[1] } : attrs;
}

type ClassUpdater = (this: HTMLElement, val: any, oldVal: any) => void;

function makeAttrsUpdaters(updateClassFn: ClassUpdater): {
  attrsSetter: Setter<HTMLElement>;
  attrsUpdater: Updater<HTMLElement>;
} {
  function attrsUpdater(this: HTMLElement, attrs: any, oldAttrs: any) {
    const next = toAttrs(attrs);
    const prev = toAttrs(oldAttrs);
    for (const name in prev) {
      if (!(name in next)) {
        updateAttr(this, name, undefined, prev[name], updateClassFn);
      }
    }
    for (const name in next) {
      const val = next[name];
      if (val !== prev[name]) {
        updateAttr(this, name, val, prev[name], updateClassFn);
      }
    }
  }
  function attrsSetter(this: HTMLElement, attrs: any) {
    attrsUpdater.call(this, attrs, NO_ATTRS);
  }
  return { attrsSetter, attrsUpdater };
}

function updateAttr(
  el: HTMLElement,
  name: string,
  val: any,
  oldVal: any,
  updateClassFn: ClassUpdater
) {
  if (name === "class") {
    updateClassFn.call(el, val, oldVal);
  } else if (name === "style") {
    updateStyle.call(el, val, oldVal);
  } else {
    setAttribute.call(el, name, val);
  }
}

export const { attrsSetter, attrsUpdater } = makeAttrsUpdaters(updateClass);

function toClassObj(expr: string | number | boolean | { [c: string]: any } | null | undefined) {
  // `cond and 'a'` yields false: no class, as a false t-att-x drops x (0 stays
  // a class, as QWeb renders it)
  if (expr === false || expr === null || expr === undefined) {
    return {};
  }
  const result: { [c: string]: any } = {};
  switch (typeof expr) {
    case "string":
      // we transform here a list of classes into an object:
      //  'hey you' becomes {hey: true, you: true}
      const str = trim.call(expr);
      if (!str) {
        return {};
      }
      let words = split.call(str, wordRegexp);
      for (let i = 0, l = words.length; i < l; i++) {
        result[words[i]] = true;
      }
      return result;
    case "object":
      // this is already an object but we may need to split keys:
      // {'a': true, 'b c': true} should become {a: true, b: true, c: true}
      for (let key in expr as any) {
        const value = (expr as any)[key];
        if (value) {
          key = trim.call(key);
          if (!key) {
            continue;
          }
          const words = split.call(key, wordRegexp);
          for (let word of words) {
            result[word] = value;
          }
        }
      }
      return result;

    default:
      return { [expr as any]: true };
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

function setStyleProp(style: CSSStyleDeclaration, prop: string, value: string) {
  if (IMPORTANT_RE.test(value)) {
    style.setProperty(prop, value.replace(IMPORTANT_RE, ""), "important");
  } else {
    style.setProperty(prop, value);
  }
}

function toStyleObj(expr: string | { [prop: string]: any }): { [prop: string]: string } {
  const result: { [prop: string]: string } = {};
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
  return { classUpdater, ...makeAttrsUpdaters(classUpdater) };
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
  oldVal = oldVal === "" ? {} : toStyleObj(oldVal);
  val = val === "" ? {} : toStyleObj(val);
  const style = this.style;
  // Properties are applied in declaration order. Re-setting a shorthand (e.g.
  // `background`, `margin`) resets the longhands it covers, so once any property
  // has been re-applied we must also re-apply every following property, even if
  // its value is unchanged, otherwise an earlier shorthand silently clobbers it.
  // Removing a longhand clears what an unchanged shorthand had set for it, so a
  // removal re-applies everything too.
  let changed = false;
  for (let prop in oldVal) {
    if (!(prop in val)) {
      style.removeProperty(prop);
      changed = true;
    }
  }
  for (let prop in val) {
    if (changed || val[prop] !== oldVal[prop]) {
      setStyleProp(style, prop, val[prop]);
      changed = true;
    }
  }
  if (!style.cssText) {
    removeAttribute.call(this, "style");
  }
}
