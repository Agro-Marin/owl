export class EventBus extends EventTarget {
  trigger(name: string, payload?: any) {
    this.dispatchEvent(new CustomEvent(name, { detail: payload }));
  }
}

export function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (!Object.is(a[i], b[i])) {
        return false;
      }
    }
    return true;
  }
  const protoA = Object.getPrototypeOf(a);
  const protoB = Object.getPrototypeOf(b);
  if (
    (protoA !== Object.prototype && protoA !== null) ||
    (protoB !== Object.prototype && protoB !== null)
  ) {
    return false;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (const key of keysA) {
    if (
      !Object.hasOwn(b, key) ||
      !Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])
    ) {
      return false;
    }
  }
  return true;
}

export class Markup extends String {}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#x27;",
  '"': "&quot;",
  "`": "&#x60;",
};
const ESCAPED_CHAR = /[&<>'"`]/g;

export function htmlEscape(str: any): Markup {
  if (str instanceof Markup) {
    return str;
  }
  if (str === undefined) {
    return markup("");
  }
  if (typeof str === "number") {
    return markup(String(str));
  }
  return markup(String(str).replace(ESCAPED_CHAR, (char) => ESCAPES[char]));
}

export function markup(strings: TemplateStringsArray, ...placeholders: unknown[]): Markup;
export function markup(value: string): Markup;
export function markup(
  valueOrStrings: string | TemplateStringsArray,
  ...placeholders: unknown[]
): Markup {
  if (!Array.isArray(valueOrStrings)) {
    return new Markup(valueOrStrings);
  }
  const strings = valueOrStrings;
  let acc = "";
  let i = 0;
  for (; i < placeholders.length; ++i) {
    acc += strings[i] + htmlEscape(placeholders[i]);
  }
  acc += strings[i];
  return new Markup(acc);
}
