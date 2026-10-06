import { App, Component, onWillDestroy, proxy } from "../../src";
import { mount, patch } from "../../src/blockdom";
import { makeTestFixture, renderToBdom, renderToString } from "../helpers";

// Random templates over the core directives, rendered by owl and by a small
// reference renderer that applies the documented semantics: the DOM owl builds
// must serialize to the reference's HTML. The interactive templates add
// components, slots, t-call, t-on handlers, t-model and bound properties: each
// event is dispatched on every element and the handlers that ran (and where)
// must be the ones the reference's propagation model runs, and each form
// control must hold what the reference says after renders and user edits.

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

type Scope = Record<string, unknown>;
// a t-on: key is the event with its modifiers; the handler logs its id, and
// the value of a loop variable when it has one
interface Handler {
  key: string;
  id: string;
  local: string | null;
  // `this.logger(...)`, evaluated at dispatch, rather than an arrow
  call: boolean;
}
type ModelKind = "text" | "check" | "radio" | "select";
interface Model {
  kind: ModelKind;
  mods: string[];
  // t-model.proxy on a proxy's key, or t-model on a function with a set method
  proxy: boolean;
}
interface Elem {
  kind: "elem";
  tag: string;
  attrs: [string, string][];
  dyn: [string, string][];
  attf: [string, string][];
  children: TNode[];
  on: Handler[];
  // t-att-value, t-att-checked, t-att-disabled: properties
  bound: [string, string][];
  model: Model | null;
}
// a component or a t-call template: one per use
interface Def {
  name: string;
  body: TNode[];
}
type TNode =
  | { kind: "text"; value: string }
  | { kind: "out"; expr: string }
  | Elem
  | { kind: "if"; branches: [string, TNode[]][]; otherwise: TNode[] | null }
  | { kind: "foreach"; list: string; as: string; children: TNode[] }
  | { kind: "comp"; def: Def; on: Handler[]; slot: TNode[] | null }
  | { kind: "slot"; on: Handler[] }
  | { kind: "call"; def: Def };

interface Generated {
  tree: TNode[];
  comps: Def[];
  calls: Def[];
}

const CONTEXT: Scope = {
  a: 3,
  s: 'x&y<z>"q',
  items: [5, 6, 7],
  empty: [],
  words: ["alpha", "b&d"],
  nothing: undefined,
  flag: true,
  // loop keys that join into one string in nested loops (a__b then c, a then
  // b__c), or share a string form (1, "1"): what a component key that is not
  // exact gives two components (the interactive templates loop over them)
  keys: ["a__b", "a", "b__c", "c", "a\u0002:b", "b\u0002:c", 1, "1"],
};

// events no t-model listens to: a dispatch runs t-on handlers only
const EVENTS = ["keydown", "pointerdown", "mouseup", "focusin"];
const MODIFIERS = ["stop", "prevent", "self", "capture"];
const MODEL_KEY: Record<ModelKind, string> = { text: "t", check: "c", radio: "r", select: "s" };
const OPTIONS = ["x", "y", "z"];

function generator(random: () => number, interactive = false) {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  // a component's template reads the values through `this`
  const g = (name: string) => (interactive ? `this.${name}` : name);
  let handlerId = 0;
  let comps: Def[] = [];
  let calls: Def[] = [];
  function valueExpr(locals: string[]): string {
    const base = pick([
      g("a"),
      g("s"),
      "'lit'",
      `${g("a")} * 2`,
      `${g("s")}.length`,
      `${g("words")}[0]`,
      ...(interactive ? ["this.m.t"] : []),
      ...locals,
    ]);
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
      g("flag"),
      `!${g("flag")}`,
      `${g("a")} > 2`,
      `${g("a")} lt 2`,
      `${g("items")}.length`,
      `${g("empty")}.length`,
      g("nothing"),
      ...locals.map((l) => `${l}_index % 2`),
    ]);
  }
  function handlers(locals: string[]): Handler[] {
    const result: Handler[] = [];
    const count = random() < 0.5 ? 0 : 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const mods = MODIFIERS.filter(() => random() < 0.2);
      for (let j = mods.length - 1; j > 0; j--) {
        const k = Math.floor(random() * (j + 1));
        [mods[j], mods[k]] = [mods[k], mods[j]];
      }
      const key = [pick(EVENTS), ...mods].join(".");
      // a loop variable, or its index: what a stale context would get wrong
      const local =
        locals.length && random() < 0.5 ? pick(locals) + (random() < 0.4 ? "_index" : "") : null;
      const call = random() < 0.3;
      if (!result.some((h) => h.key === key)) {
        result.push({ key, id: `h${++handlerId}`, local, call });
      }
    }
    return result;
  }
  function elem(tag: string, attrs: [string, string][], children: TNode[] = []): Elem {
    return {
      kind: "elem",
      tag,
      attrs,
      dyn: [],
      attf: [],
      children,
      on: [],
      bound: [],
      model: null,
    };
  }
  function control(locals: string[]): Elem {
    const r = random();
    let el: Elem;
    if (r < 0.2) {
      el = elem("input", []);
      el.model = {
        kind: "text",
        mods: ["lazy", "trim", "number"].filter(() => random() < 0.3),
        proxy: random() < 0.5,
      };
    } else if (r < 0.3) {
      el = elem("input", [["type", "checkbox"]]);
      el.model = { kind: "check", mods: [], proxy: random() < 0.5 };
    } else if (r < 0.45) {
      el = elem("input", [
        ["type", "radio"],
        ["value", pick(OPTIONS)],
      ]);
      el.model = { kind: "radio", mods: [], proxy: random() < 0.5 };
    } else if (r < 0.55) {
      const options = OPTIONS.map((o) =>
        elem("option", [["value", o]], [{ kind: "text", value: o }])
      );
      el = elem("select", [], options);
      el.model = { kind: "select", mods: [], proxy: random() < 0.5 };
    } else if (r < 0.75) {
      el = elem("input", []);
      el.bound.push(["value", valueExpr(locals)]);
      if (random() < 0.3) {
        el.bound.push(["disabled", condExpr(locals)]);
      }
    } else if (r < 0.9) {
      el = elem("input", [["type", "checkbox"]]);
      el.bound.push(["checked", condExpr(locals)]);
    } else {
      el = elem("input", []);
      el.bound.push(["disabled", condExpr(locals)]);
    }
    el.on = handlers(locals);
    return el;
  }
  function component(locals: string[], depth: number, inComp: boolean): TNode {
    const def: Def = { name: `C${comps.length + 1}`, body: [] };
    comps.push(def);
    def.body = nodes([], depth + 1, true);
    const slot = random() < 0.6 ? nodes(locals, depth + 1, inComp) : null;
    if (slot && random() < 0.7) {
      def.body.splice(Math.floor(random() * (def.body.length + 1)), 0, {
        kind: "slot",
        on: handlers([]),
      });
    }
    return { kind: "comp", def, on: handlers(locals), slot };
  }
  function nodes(locals: string[], depth: number, inComp: boolean): TNode[] {
    const count = 1 + Math.floor(random() * 3);
    const result: TNode[] = [];
    for (let i = 0; i < count; i++) {
      result.push(node(locals, depth, inComp));
    }
    return result;
  }
  function node(locals: string[], depth: number, inComp: boolean): TNode {
    if (interactive && depth <= 3) {
      const q = random();
      if (q < 0.08 && comps.length < 4) {
        return component(locals, depth, inComp);
      }
      if (q < 0.12 && calls.length < 3) {
        const def: Def = { name: `call${calls.length + 1}`, body: [] };
        calls.push(def);
        def.body = nodes(locals, depth + 1, inComp);
        return { kind: "call", def };
      }
      if (q < 0.16 && inComp) {
        return { kind: "slot", on: handlers(locals) };
      }
      if (q < 0.28) {
        return control(locals);
      }
    }
    const r = random();
    if (depth > 3 || r < 0.2) {
      return random() < 0.5
        ? { kind: "text", value: pick(["hi", "a&b", "x<y", "z"]) }
        : { kind: "out", expr: valueExpr(locals) };
    }
    if (r < 0.55) {
      const dyn: [string, string][] =
        random() < 0.5 ? [["data-v", random() < 0.15 ? g("nothing") : valueExpr(locals)]] : [];
      const attf: [string, string][] =
        random() < 0.4 ? [["title", `t-{{${valueExpr(locals)}}}-e`]] : [];
      const el = elem(
        pick(["span", "p", "b", "li"]),
        random() < 0.5 ? [["id", pick(["one", "two"])]] : []
      );
      el.dyn = dyn;
      el.attf = attf;
      el.children = nodes(locals, depth + 1, inComp);
      if (interactive) {
        el.on = handlers(locals);
      }
      return el;
    }
    if (r < 0.75) {
      const branches: [string, TNode[]][] = [[condExpr(locals), nodes(locals, depth + 1, inComp)]];
      if (random() < 0.5) {
        branches.push([condExpr(locals), nodes(locals, depth + 1, inComp)]);
      }
      return {
        kind: "if",
        branches,
        otherwise: random() < 0.5 ? nodes(locals, depth + 1, inComp) : null,
      };
    }
    const as = pick(["v", "w"]).repeat(depth + 1);
    return {
      kind: "foreach",
      list: g(
        pick(
          interactive ? ["items", "empty", "words", "keys", "keys"] : ["items", "empty", "words"]
        )
      ),
      as,
      children: nodes([...locals, as], depth + 1, inComp),
    };
  }
  return (): Generated => {
    handlerId = 0;
    comps = [];
    calls = [];
    const tree = nodes([], 0, false);
    return { tree, comps, calls };
  };
}

function toXml(list: TNode[]): string {
  return list.map(nodeXml).join("");
}

function onXml(on: Handler[]): string {
  return on
    .map((h) => {
      const args = `'${h.id}'${h.local ? `, ${h.local}` : ""}`;
      const code = h.call ? `this.logger(${args})` : `(ev) => this.log(ev, ${args})`;
      return ` t-on-${h.key}="${escapeAttr(code)}"`;
    })
    .join("");
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
        ...n.bound.map(([k, v]) => `t-att-${k}="${escapeAttr(v)}"`),
      ];
      if (n.model) {
        const { proxy, mods, kind } = n.model;
        const suffix = (proxy ? ["proxy", ...mods] : mods).map((m) => `.${m}`).join("");
        attrs.push(`t-model${suffix}="this.${proxy ? "m" : "ms"}.${MODEL_KEY[kind]}"`);
      }
      const open = `${n.tag}${attrs.length ? " " + attrs.join(" ") : ""}${onXml(n.on)}`;
      return `<${open}>${toXml(n.children)}</${n.tag}>`;
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
    case "comp":
      return n.slot
        ? `<${n.def.name}${onXml(n.on)}>${toXml(n.slot)}</${n.def.name}>`
        : `<${n.def.name}${onXml(n.on)}/>`;
    case "slot":
      return `<t t-call-slot="default"${onXml(n.on)}/>`;
    case "call":
      return `<t t-call="${n.def.name}"/>`;
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------------
// reference renderer: a tree of elements, each with the handlers it holds,
// the catchers (t-on of a component or slot) enclosing it in its parent, and
// the state its properties must show
// ---------------------------------------------------------------------------

interface RHandler {
  event: string;
  mods: string[];
  entry: string;
}
interface VEl {
  tag: string;
  attrs: [string, string][];
  children: VChild[];
  parent: VEl | null;
  on: RHandler[];
  // the handlers of each catcher enclosing it, innermost first
  catchers: RHandler[][];
  props: [string, unknown][];
  model: Model | null;
}
type VChild = VEl | string;
interface RCtx {
  self: unknown;
  locals: Scope;
  // the content a t-call-slot renders here, and where it was written
  slot: { nodes: TNode[]; ctx: RCtx } | null;
}

const compiled = new Map<string, Function>();
function evaluate(expr: string, ctx: RCtx): any {
  const names = Object.keys(ctx.locals);
  const key = `${names.join(",")}|${expr}`;
  let fn = compiled.get(key);
  if (!fn) {
    fn = new Function(...names, `return (${expr.replace(/\blt\b/g, "<")});`);
    compiled.set(key, fn);
  }
  return fn.call(ctx.self, ...names.map((n) => ctx.locals[n]));
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

function rHandlers(on: Handler[], ctx: RCtx): RHandler[] {
  return on.map((h) => {
    const [event, ...mods] = h.key.split(".");
    const entry = h.local ? `${h.id}:${String(ctx.locals[h.local])}` : h.id;
    return { event, mods, entry };
  });
}

function withCatcher(children: VChild[], on: Handler[], ctx: RCtx): VChild[] {
  if (on.length) {
    const handlers = rHandlers(on, ctx);
    for (const child of children) {
      if (typeof child !== "string") {
        child.catchers.push(handlers);
      }
    }
  }
  return children;
}

function renderList(list: TNode[], ctx: RCtx): VChild[] {
  return list.flatMap((n) => renderNode(n, ctx));
}

function renderNode(n: TNode, ctx: RCtx): VChild[] {
  switch (n.kind) {
    case "text":
      return [n.value];
    case "out": {
      const value = evaluate(n.expr, ctx);
      return value === undefined || value === null ? [] : [String(value)];
    }
    case "elem": {
      const el: VEl = {
        tag: n.tag,
        attrs: [...n.attrs],
        children: renderList(n.children, ctx),
        parent: null,
        on: rHandlers(n.on, ctx),
        catchers: [],
        props: [],
        model: n.model,
      };
      for (const [k, expr] of n.dyn) {
        const value = evaluate(expr, ctx);
        if (value !== undefined && value !== null) {
          el.attrs.push([k, String(value)]);
        }
      }
      for (const [k, format] of n.attf) {
        const value = format.replace(/\{\{(.*?)\}\}/g, (_, e) => String(evaluate(e, ctx)));
        el.attrs.push([k, value]);
      }
      for (const [k, expr] of n.bound) {
        const value = evaluate(expr, ctx);
        el.props.push([k, value]);
        // the one bound property reflected as an attribute
        if (k === "disabled" && value) {
          el.attrs.push(["disabled", ""]);
        }
      }
      for (const child of el.children) {
        if (typeof child !== "string") {
          child.parent = el;
        }
      }
      return [el];
    }
    case "if": {
      for (const [cond, body] of n.branches) {
        if (evaluate(cond, ctx)) {
          return renderList(body, ctx);
        }
      }
      return n.otherwise ? renderList(n.otherwise, ctx) : [];
    }
    case "foreach": {
      const items = evaluate(n.list, ctx) as unknown[];
      return items.flatMap((item, i) =>
        renderList(n.children, {
          ...ctx,
          locals: {
            ...ctx.locals,
            [n.as]: item,
            [`${n.as}_index`]: i,
            [`${n.as}_first`]: i === 0,
            [`${n.as}_last`]: i === items.length - 1,
          },
        })
      );
    }
    case "comp": {
      const inner: RCtx = {
        self: ctx.self,
        locals: {},
        slot: n.slot ? { nodes: n.slot, ctx } : null,
      };
      return withCatcher(renderList(n.def.body, inner), n.on, ctx);
    }
    case "slot": {
      const content = ctx.slot ? renderList(ctx.slot.nodes, ctx.slot.ctx) : [];
      return withCatcher(content, n.on, ctx);
    }
    case "call":
      return renderList(n.def.body, ctx);
  }
}

function renderRoot(list: TNode[], ctx: RCtx): VEl {
  const root: VEl = {
    tag: "div",
    attrs: [],
    children: renderList(list, ctx),
    parent: null,
    on: [],
    catchers: [],
    props: [],
    model: null,
  };
  for (const child of root.children) {
    if (typeof child !== "string") {
      child.parent = root;
    }
  }
  return root;
}

function serialize(v: VChild, sorted: boolean): string {
  if (typeof v === "string") {
    return escapeText(v);
  }
  const attrs = v.attrs.map(([k, value]) => ` ${k}="${escapeHtmlAttr(value)}"`);
  if (sorted) {
    attrs.sort();
  }
  return `<${v.tag}${attrs.join("")}>${v.children.map((c) => serialize(c, sorted)).join("")}</${v.tag}>`;
}

function render(list: TNode[], scope: Scope): string {
  return renderList(list, { self: undefined, locals: scope, slot: null })
    .map((c) => serialize(c, false))
    .join("");
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
  keys: ["c", "b__c", "a", 1, "a\u0002:b", "x"],
};

// attribute order carries no meaning: an attribute set by a patch comes last
function canonical(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  return [...root.childNodes].map(domString).join("");
}

// the DOM as built, not as an HTML parser would rebuild it (a <p> in a <p>)
function domString(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(node.textContent!);
  }
  const el = node as Element;
  const attrs = [...el.attributes]
    .map((a) => ` ${a.name}="${escapeHtmlAttr(a.value)}"`)
    .sort()
    .join("");
  const tag = el.tagName.toLowerCase();
  return `<${tag}${attrs}>${[...el.childNodes].map(domString).join("")}</${tag}>`;
}

const COUNT = Number(process.env.OWL_TEMPLATE_FUZZ || 400);

test(
  "random templates render what the reference renderer renders",
  () => {
    const next = generator(prng(5));
    const failures: string[] = [];
    for (let i = 0; i < COUNT && failures.length < 3; i++) {
      const { tree } = next();
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
      const { tree } = next();
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

// ---------------------------------------------------------------------------
// interactive templates: mounted as components in an App
// ---------------------------------------------------------------------------

interface LogEntry {
  entry: string;
  currentTarget: EventTarget | null;
  phase: number;
}
interface World {
  state: any;
  model: any;
  // per key of the model, a function reading it with a set method writing it
  accessors: Record<string, any>;
  log: LogEntry[];
  // the components alive, and how many times each rendered
  alive: Set<any>;
  renders: Map<any, number>;
}

const MODEL: Scope = { t: "init", c: true, r: "y", s: "z" };

function makeRoot(world: World, comps: Def[]) {
  class Base extends Component {
    setup() {
      world.alive.add(this);
      onWillDestroy(() => world.alive.delete(this));
      const node = this.__owl__;
      const render = node.renderFn;
      node.renderFn = () => {
        world.renders.set(this, (world.renders.get(this) || 0) + 1);
        return render();
      };
    }
    get m() {
      return world.model;
    }
    get ms() {
      return world.accessors;
    }
    log(ev: Event, id: string, ...value: unknown[]) {
      world.log.push({
        entry: value.length ? `${id}:${String(value[0])}` : id,
        currentTarget: ev.currentTarget,
        phase: ev.eventPhase,
      });
    }
    logger(id: string, ...value: unknown[]) {
      return (ev: Event) => this.log(ev, id, ...value);
    }
  }
  for (const key of Object.keys(CONTEXT)) {
    Object.defineProperty(Base.prototype, key, {
      get() {
        return world.state[key];
      },
    });
  }
  const components: Record<string, typeof Component> = {};
  for (const def of comps) {
    components[def.name] = class extends Base {
      static template = def.name;
      static components = components;
    };
    // named in owl's debug logs
    Object.defineProperty(components[def.name], "name", { value: def.name });
  }
  return class Root extends Base {
    static template = "root";
    static components = components;
  };
}

function toNumber(value: string): number | string {
  const n = parseFloat(value);
  return isNaN(n) ? value : n;
}

// what a value property shows for a value
function shown(value: unknown): string {
  return value === 0 ? "0" : value ? String(value) : "";
}

function pathOf(v: VEl): string {
  const parts: string[] = [];
  for (let n: VEl | null = v; n; n = n.parent) {
    const siblings = n.parent ? n.parent.children.filter((c) => typeof c !== "string") : [n];
    parts.unshift(`${n.tag}${siblings.indexOf(n)}`);
  }
  return parts.join(">");
}

// the handlers a dispatch on the target must run, grouped by where they run:
// `<depth><c|t|b>` (capture, at target, bubble), each group sorted (the order of
// two listeners of one element is not specified), then ` !` if the default was
// prevented. A stop ends the propagation after the group where it happened;
// .self holds back the handler (and the modifiers after it) unless the target
// is its element, or for a catcher, the element of its child holding the target.
function expectedLog(target: VEl, event: string): string {
  const path: VEl[] = [];
  for (let n: VEl | null = target; n; n = n.parent) {
    path.push(n);
  }
  const groups: string[] = [];
  let prevented = false;
  // the entries of the current group: at the target, capture listeners run in
  // a pass of their own before the others (a stop between them counts)
  let entries: string[] = [];
  const flush = (label: string) => {
    if (entries.length) {
      groups.push(`${label}:${entries.sort().join(",")}`);
    }
    entries = [];
  };
  const run = (items: [RHandler, boolean][]): boolean => {
    let stop = false;
    for (const [h, isSelf] of items) {
      const selfIdx = h.mods.indexOf("self");
      const runs = selfIdx < 0 || isSelf;
      h.mods.forEach((m, i) => {
        if (i < selfIdx || runs) {
          stop ||= m === "stop";
          prevented ||= m === "prevent";
        }
      });
      if (runs) {
        entries.push(h.entry);
      }
    }
    return stop;
  };
  const matches = (h: RHandler, capture: boolean) =>
    h.event === event && h.mods.includes("capture") === capture;
  const atAncestor = (i: number, capture: boolean): [RHandler, boolean][] => {
    const items: [RHandler, boolean][] = path[i].on
      .filter((h) => matches(h, capture))
      .map((h) => [h, false]);
    const child = path[i - 1];
    for (const catcher of child.catchers) {
      for (const h of catcher) {
        if (matches(h, capture)) {
          items.push([h, child === target]);
        }
      }
    }
    return items;
  };
  const finish = (label: string) => {
    flush(label);
    return groups.join(" ") + (prevented ? " !" : "");
  };
  for (let i = path.length - 1; i >= 1; i--) {
    const stop = run(atAncestor(i, true));
    flush(`${i}c`);
    if (stop) {
      return finish("");
    }
  }
  const own = (capture: boolean): [RHandler, boolean][] =>
    target.on.filter((h) => matches(h, capture)).map((h) => [h, true]);
  if (run(own(true)) || run(own(false))) {
    return finish("0t");
  }
  flush("0t");
  for (let i = 1; i < path.length; i++) {
    const stop = run(atAncestor(i, false));
    flush(`${i}b`);
    if (stop) {
      return finish("");
    }
  }
  return finish("");
}

function actualLog(log: LogEntry[], target: Element, prevented: boolean): string {
  const groups: [string, string[]][] = [];
  for (const { entry, currentTarget, phase } of log) {
    let depth = 0;
    let n: Element | null = target;
    while (n && n !== currentTarget) {
      n = n.parentElement;
      depth++;
    }
    const label = `${n ? depth : "?"}${"?ctb"[phase] || "?"}`;
    const last = groups[groups.length - 1];
    if (last && last[0] === label) {
      last[1].push(entry);
    } else {
      groups.push([label, [entry]]);
    }
  }
  return (
    groups.map(([label, entries]) => `${label}:${entries.sort().join(",")}`).join(" ") +
    (prevented ? " !" : "")
  );
}

// pairs each element owl built with the reference's, once the two serialize
// alike; the difference otherwise
function pair(actual: Element, expected: VEl): [Element, VEl][] | string {
  const owl = domString(actual);
  const ref = serialize(expected, true);
  if (owl !== ref) {
    return `owl ${owl}\n  ref ${ref}`;
  }
  const pairs: [Element, VEl][] = [];
  const walk = (el: Element, v: VEl) => {
    pairs.push([el, v]);
    const children = v.children.filter((c) => typeof c !== "string") as VEl[];
    children.forEach((c, i) => walk(el.children[i], c));
  };
  walk(actual, expected);
  return pairs;
}

// every component alive is mounted and in its parent's children: two that
// share a key leave one out, and nothing renders or destroys it from there
function componentProblems(world: World): string[] {
  const problems: string[] = [];
  for (const component of world.alive) {
    const node = component.__owl__;
    if (node.status !== 1) {
      problems.push(`${component.constructor.name} alive but status ${node.status}`);
    } else if (node.parent && ![...(node.parent.childMap?.values() || [])].includes(node)) {
      problems.push(`${component.constructor.name} not in its parent's children`);
    }
  }
  return problems;
}

function stateProblems(pairs: [Element, VEl][], model: Scope): string[] {
  const problems: string[] = [];
  for (const [el, v] of pairs) {
    const input = el as HTMLInputElement;
    const expect = (prop: string, actual: unknown, expected: unknown) => {
      if (actual !== expected) {
        problems.push(`${pathOf(v)}.${prop}: owl ${actual} ref ${expected}`);
      }
    };
    for (const [prop, value] of v.props) {
      if (prop === "value") {
        expect(prop, input.value, shown(value));
      } else {
        expect(prop, (input as any)[prop], !!value);
      }
    }
    if (v.model) {
      const value = model[MODEL_KEY[v.model.kind]];
      switch (v.model.kind) {
        case "text":
          expect("value", input.value, shown(value));
          break;
        case "check":
          expect("checked", input.checked, !!value);
          break;
        case "radio":
          expect("checked", input.checked, value === input.getAttribute("value"));
          break;
        case "select":
          expect("value", input.value, value);
          break;
      }
    }
  }
  return problems;
}

function eventProblems(pairs: [Element, VEl][], events: string[], world: World): string[] {
  const problems: string[] = [];
  for (const [el, v] of pairs) {
    for (const event of events) {
      world.log = [];
      const ev = new Event(event, { bubbles: true, cancelable: true });
      el.dispatchEvent(ev);
      const actual = actualLog(world.log, el, ev.defaultPrevented);
      const expected = expectedLog(v, event);
      if (actual !== expected) {
        problems.push(`${event} on ${pathOf(v)}: owl [${actual}] ref [${expected}]`);
      }
    }
  }
  return problems;
}

async function settle(app: App) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!app.scheduler.tasks.size && !app.scheduler.frame) {
      return;
    }
  }
}

const TEXT_INPUTS = [" 7 ", "abc", "4.5", "q r", "0", "init"];

// one user edit of a form control holding a model, applied to the reference
// model too; false when the control cannot change the model
function edit(el: HTMLInputElement, model: Model, ref: Scope, n: number): boolean {
  const key = MODEL_KEY[model.kind];
  switch (model.kind) {
    case "text": {
      const transform = (raw: string) => {
        const value = model.mods.includes("trim") ? raw.trim() : raw;
        return model.mods.includes("number") ? toNumber(value) : value;
      };
      for (let i = 0; i < TEXT_INPUTS.length; i++) {
        const raw = TEXT_INPUTS[(n + i) % TEXT_INPUTS.length];
        if (transform(raw) !== ref[key]) {
          el.value = raw;
          ref[key] = transform(raw);
          const lazy = model.mods.includes("lazy") || model.mods.includes("trim");
          el.dispatchEvent(new Event(lazy ? "change" : "input", { bubbles: true }));
          return true;
        }
      }
      return false;
    }
    case "check":
      el.checked = !el.checked;
      ref[key] = el.checked;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    case "radio": {
      const value = el.getAttribute("value");
      if (ref[key] === value) {
        return false;
      }
      el.checked = true;
      ref[key] = value;
      // a plain event: no activation behavior, only the model's handler
      el.dispatchEvent(new Event("click", { bubbles: true }));
      return true;
    }
    case "select": {
      const value = OPTIONS.find((o) => o !== ref[key] && OPTIONS.indexOf(o) >= n % 3) || "x";
      if (value === ref[key]) {
        return false;
      }
      el.value = value;
      ref[key] = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }
}

async function runInteractive({ tree, comps, calls }: Generated): Promise<string[]> {
  const fixture = makeTestFixture();
  const world: World = {
    state: proxy(structuredClone(CONTEXT)),
    model: proxy({ ...MODEL }),
    accessors: {},
    log: [],
    alive: new Set(),
    renders: new Map(),
  };
  for (const key in MODEL) {
    world.accessors[key] = Object.assign(() => world.model[key], {
      set: (value: unknown) => {
        world.model[key] = value;
      },
    });
  }
  const refModel: Scope = { ...MODEL };
  const xml = `<div>${toXml(tree)}</div>`;
  const events = EVENTS.filter((e) =>
    [xml, ...[...comps, ...calls].map((d) => toXml(d.body))].some((x) => x.includes(`t-on-${e}`))
  );
  const app = new App({ test: true });
  app.scheduler.requestAnimationFrame = (cb) => setImmediate(() => cb(0)) as any;
  app.addTemplate("root", xml);
  for (const def of [...comps, ...calls]) {
    app.addTemplate(def.name, toXml(def.body));
  }
  let root: any;
  const problems: string[] = [];
  const check = (stage: string, scope: Scope, withEvents: boolean): [Element, VEl][] | null => {
    const vroot = renderRoot(tree, { self: { ...scope, m: refModel }, locals: {}, slot: null });
    const pairs = pair(fixture.firstElementChild!, vroot);
    if (typeof pairs === "string") {
      problems.push(`${stage}: ${pairs}`);
      return null;
    }
    const found = [...componentProblems(world), ...stateProblems(pairs, refModel)];
    if (JSON.stringify({ ...world.model }) !== JSON.stringify(refModel)) {
      found.push(`model: owl ${JSON.stringify(world.model)} ref ${JSON.stringify(refModel)}`);
    }
    if (withEvents) {
      found.push(...eventProblems(pairs, events, world));
    }
    problems.push(...found.slice(0, 3).map((p) => `${stage}: ${p}`));
    return found.length ? null : pairs;
  };
  try {
    root = await app.createRoot(makeRoot(world, comps)).mount(fixture);
    let pairs = check("mount", CONTEXT, true);
    if (pairs) {
      Object.assign(world.state, structuredClone(UPDATED));
      await settle(app);
      pairs = check("update", UPDATED, true);
    }
    if (pairs) {
      Object.assign(world.state, structuredClone(CONTEXT));
      await settle(app);
      pairs = check("back", CONTEXT, true);
    }
    // user edits of each form control holding a model, one at a time
    for (let k = 0; pairs && k < pairs.length; k++) {
      const [el, v] = pairs[k];
      if (v.model && edit(el as HTMLInputElement, v.model, refModel, k)) {
        await settle(app);
        pairs = check(`edit ${pathOf(v)}`, CONTEXT, false);
      }
    }
    if (pairs) {
      pairs = check("edited", CONTEXT, true);
    }
    // user edits of bound properties: a render sets them back
    if (pairs) {
      for (const [el, v] of pairs) {
        for (const [prop] of v.props) {
          if (prop === "value") {
            (el as HTMLInputElement).value = "typed";
          } else if (prop === "checked") {
            (el as HTMLInputElement).checked = !(el as HTMLInputElement).checked;
          }
        }
      }
      const before = new Map(world.renders);
      root.__owl__.render(true);
      await settle(app);
      check("rerender", CONTEXT, false);
      for (const component of world.alive) {
        if (world.renders.get(component) === before.get(component)) {
          problems.push(`rerender: ${component.constructor.name} not rendered by a deep render`);
        }
      }
    }
  } catch (error: any) {
    problems.push(`throws ${error.message}`);
  }
  app.destroy();
  if (world.alive.size) {
    problems.push(`${world.alive.size} component(s) not destroyed with the app`);
  }
  if (problems.length) {
    const defs = [...comps, ...calls].map((d) => `\n  ${d.name}: ${toXml(d.body)}`).join("");
    return [`${xml}${defs}\n  ${problems.join("\n  ")}`];
  }
  return [];
}

test(
  "random interactive templates run the handlers and hold the form state the reference expects",
  async () => {
    const next = generator(prng(Number(process.env.OWL_TEMPLATE_FUZZ_SEED || 29)), true);
    const failures: string[] = [];
    for (let i = 0; i < COUNT && failures.length < 3; i++) {
      const generated = next();
      for (const failure of await runInteractive(generated)) {
        failures.push(`#${i} ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  },
  Math.max(120000, COUNT * 300)
);
