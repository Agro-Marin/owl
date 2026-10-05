import { mount, patch } from "../../src/blockdom";
import { makeTestFixture, renderToBdom, renderToString } from "../helpers";

// Random templates over the core directives, rendered by owl and by a small
// reference renderer that applies the documented semantics: the DOM owl builds
// must serialize to the reference's HTML.

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

type Scope = Record<string, unknown>;
type TNode =
  | { kind: "text"; value: string }
  | { kind: "out"; expr: string }
  | {
      kind: "elem";
      tag: string;
      attrs: [string, string][];
      dyn: [string, string][];
      attf: [string, string][];
      children: TNode[];
    }
  | { kind: "if"; branches: [string, TNode[]][]; otherwise: TNode[] | null }
  | { kind: "foreach"; list: string; as: string; children: TNode[] };

const CONTEXT: Scope = {
  a: 3,
  s: 'x&y<z>"q',
  items: [5, 6, 7],
  empty: [],
  words: ["alpha", "b&d"],
  nothing: undefined,
  flag: true,
};

function generator(random: () => number) {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  function valueExpr(locals: string[]): string {
    const base = pick(["a", "s", "'lit'", "a * 2", "s.length", "words[0]", ...locals]);
    if (random() < 0.3 && locals.length) {
      const local = pick(locals);
      return pick([
        `${base} + ${local}`,
        `(${local}_first ? 'F' : '') + ${local}`,
        `${local}_index + 1`,
        `${local}_last ? 'L' : ${local}`,
      ]);
    }
    return base;
  }
  function condExpr(locals: string[]): string {
    return pick([
      "flag",
      "!flag",
      "a > 2",
      "a lt 2",
      "items.length",
      "empty.length",
      "nothing",
      ...locals.map((l) => `${l}_index % 2`),
    ]);
  }
  function nodes(locals: string[], depth: number): TNode[] {
    const count = 1 + Math.floor(random() * 3);
    const result: TNode[] = [];
    for (let i = 0; i < count; i++) {
      result.push(node(locals, depth));
    }
    return result;
  }
  function node(locals: string[], depth: number): TNode {
    const r = random();
    if (depth > 3 || r < 0.2) {
      return random() < 0.5
        ? { kind: "text", value: pick(["hi", "a&b", "x<y", "z"]) }
        : { kind: "out", expr: valueExpr(locals) };
    }
    if (r < 0.55) {
      const dyn: [string, string][] =
        random() < 0.5 ? [["data-v", random() < 0.15 ? "nothing" : valueExpr(locals)]] : [];
      const attf: [string, string][] =
        random() < 0.4 ? [["title", `t-{{${valueExpr(locals)}}}-e`]] : [];
      return {
        kind: "elem",
        tag: pick(["span", "p", "b", "li"]),
        attrs: random() < 0.5 ? [["id", pick(["one", "two"])]] : [],
        dyn,
        attf,
        children: nodes(locals, depth + 1),
      };
    }
    if (r < 0.75) {
      const branches: [string, TNode[]][] = [[condExpr(locals), nodes(locals, depth + 1)]];
      if (random() < 0.5) {
        branches.push([condExpr(locals), nodes(locals, depth + 1)]);
      }
      return {
        kind: "if",
        branches,
        otherwise: random() < 0.5 ? nodes(locals, depth + 1) : null,
      };
    }
    const as = pick(["v", "w"]).repeat(depth + 1);
    return {
      kind: "foreach",
      list: pick(["items", "empty", "words"]),
      as,
      children: nodes([...locals, as], depth + 1),
    };
  }
  return () => nodes([], 0);
}

function toXml(list: TNode[]): string {
  return list.map(nodeXml).join("");
}

function nodeXml(n: TNode): string {
  switch (n.kind) {
    case "text":
      return n.value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    case "out":
      return `<t t-out="${escapeAttr(n.expr)}"/>`;
    case "elem": {
      const attrs = [
        ...n.attrs.map(([k, v]) => `${k}="${v}"`),
        ...n.dyn.map(([k, v]) => `t-att-${k}="${escapeAttr(v)}"`),
        ...n.attf.map(([k, v]) => `t-attf-${k}="${escapeAttr(v)}"`),
      ];
      return `<${n.tag}${attrs.length ? " " + attrs.join(" ") : ""}>${toXml(n.children)}</${n.tag}>`;
    }
    case "if": {
      let out = "";
      n.branches.forEach(([cond, body], i) => {
        out += `<t t-${i ? "elif" : "if"}="${escapeAttr(cond)}">${toXml(body)}</t>`;
      });
      if (n.otherwise) {
        out += `<t t-else="">${toXml(n.otherwise)}</t>`;
      }
      return out;
    }
    case "foreach":
      return `<t t-foreach="${n.list}" t-as="${n.as}" t-key="${n.as}">${toXml(n.children)}</t>`;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function evaluate(expr: string, scope: Scope): any {
  const js = expr.replace(/\blt\b/g, "<");
  const names = Object.keys(scope);
  return new Function(...names, `return (${js});`)(...names.map((n) => scope[n]));
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function render(list: TNode[], scope: Scope): string {
  return list.map((n) => renderNode(n, scope)).join("");
}

function renderNode(n: TNode, scope: Scope): string {
  switch (n.kind) {
    case "text":
      return escapeText(n.value);
    case "out": {
      const value = evaluate(n.expr, scope);
      return value === undefined || value === null ? "" : escapeText(String(value));
    }
    case "elem": {
      let attrs = n.attrs.map(([k, v]) => ` ${k}="${escapeHtmlAttr(v)}"`).join("");
      for (const [k, expr] of n.dyn) {
        const value = evaluate(expr, scope);
        if (value !== undefined && value !== null) {
          attrs += ` ${k}="${escapeHtmlAttr(String(value))}"`;
        }
      }
      for (const [k, format] of n.attf) {
        const value = format.replace(/\{\{(.*?)\}\}/g, (_, e) => String(evaluate(e, scope)));
        attrs += ` ${k}="${escapeHtmlAttr(value)}"`;
      }
      return `<${n.tag}${attrs}>${render(n.children, scope)}</${n.tag}>`;
    }
    case "if": {
      for (const [cond, body] of n.branches) {
        if (evaluate(cond, scope)) {
          return render(body, scope);
        }
      }
      return n.otherwise ? render(n.otherwise, scope) : "";
    }
    case "foreach": {
      const items = evaluate(n.list, scope) as unknown[];
      return items
        .map((item, i) =>
          render(n.children, {
            ...scope,
            [n.as]: item,
            [`${n.as}_index`]: i,
            [`${n.as}_first`]: i === 0,
            [`${n.as}_last`]: i === items.length - 1,
          })
        )
        .join("");
    }
  }
}

// the same names with other values: lists reordered, shrunk and grown, the
// conditions flipped, an attribute value going undefined
const UPDATED: Scope = {
  a: 1,
  s: "plain",
  items: [7, 5, 8, 6],
  empty: [9],
  words: ["b&d"],
  nothing: "now",
  flag: false,
};

// attribute order carries no meaning: an attribute set by a patch comes last
function canonical(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  const walk = (node: ChildNode): string => {
    if (node.nodeType === Node.TEXT_NODE) {
      return escapeText(node.textContent!);
    }
    const el = node as Element;
    const attrs = [...el.attributes]
      .map((a) => ` ${a.name}="${escapeHtmlAttr(a.value)}"`)
      .sort()
      .join("");
    const tag = el.tagName.toLowerCase();
    return `<${tag}${attrs}>${[...el.childNodes].map(walk).join("")}</${tag}>`;
  };
  return [...root.childNodes].map(walk).join("");
}

const COUNT = Number(process.env.OWL_TEMPLATE_FUZZ || 400);

test(
  "random templates render what the reference renderer renders",
  () => {
    const next = generator(prng(5));
    const failures: string[] = [];
    for (let i = 0; i < COUNT && failures.length < 3; i++) {
      const tree = next();
      const template = `<div>${toXml(tree)}</div>`;
      const expected = `<div>${render(tree, CONTEXT)}</div>`;
      let actual: string;
      try {
        actual = renderToString(template, { ...CONTEXT });
      } catch (error: any) {
        actual = `throws ${error.message}`;
      }
      if (actual !== expected) {
        failures.push(`${template}\n  owl ${actual}\n  ref ${expected}`);
      }
    }
    expect(failures).toEqual([]);
  },
  Math.max(120000, COUNT * 100)
);

test(
  "random templates patched to other values render what the reference renders for them",
  () => {
    const next = generator(prng(17));
    const failures: string[] = [];
    for (let i = 0; i < COUNT && failures.length < 3; i++) {
      const tree = next();
      const template = `<div>${toXml(tree)}</div>`;
      let actual: string;
      try {
        const fixture = makeTestFixture();
        const first = renderToBdom(template, { ...CONTEXT });
        mount(first, fixture);
        patch(first, renderToBdom(template, { ...UPDATED }));
        const back = canonical(fixture.innerHTML);
        patch(first, renderToBdom(template, { ...CONTEXT }));
        actual = `${back} | ${canonical(fixture.innerHTML)}`;
      } catch (error: any) {
        actual = `throws ${error.message}`;
      }
      const expected = `${canonical(`<div>${render(tree, UPDATED)}</div>`)} | ${canonical(`<div>${render(tree, CONTEXT)}</div>`)}`;
      if (actual !== expected) {
        failures.push(`${template}\n  owl ${actual}\n  ref ${expected}`);
      }
    }
    expect(failures).toEqual([]);
  },
  Math.max(120000, COUNT * 100)
);
