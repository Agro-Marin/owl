// The generator of the template fuzz tests (template_fuzz.test.ts,
// template_fuzz_interactive.test.ts) and its reference: random templates over
// the core directives, rendered by owl and by a small reference renderer that applies the documented semantics: the DOM owl builds
// must serialize to the reference's HTML. The interactive templates add
// components, slots, t-call, t-set, Portal, Suspense, t-on handlers (native and
// synthetic, passive or not), t-model and bound properties, mounted in the
// document or in a shadow root: each event is dispatched on every element and
// the handlers that ran (and where) must be the ones the reference's
// propagation model runs, and each form control must hold what the reference
// says after renders and user edits.

export function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

export type Scope = Record<string, unknown>;
// a t-on: key is the event with its modifiers; the handler logs its id, and
// the value of an expression (a loop variable, a t-set value) when it has one
export interface Handler {
  key: string;
  id: string;
  local: string | null;
  // `this.logger(...)`, evaluated at dispatch, rather than an arrow
  call: boolean;
}
export type ModelKind = "text" | "check" | "radio" | "select";
export interface Model {
  kind: ModelKind;
  mods: string[];
  // t-model.proxy on a proxy's key, or t-model on a function with a set method
  proxy: boolean;
  // t-model.proxy on `<row>.v`, a loop variable over this.rows
  row: string | null;
}
export interface Elem {
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
  // written with t-tag (its block type is made per tag)
  dynTag?: boolean;
  // a class string, its words separated by any whitespace: static, dynamic
  // (t-att-class, or through t-att's object when viaAtt) or both
  cls?: { statics: string | null; expr: string; viaAtt: boolean };
}
// a component or a t-call template: one per use
export interface Def {
  name: string;
  body: TNode[];
  // a component used through a relay, which hands it the slots it receives
  // held in proxied state: as they are (1) or copied (2)
  relay?: 0 | 1 | 2;
}
export type TNode =
  | { kind: "text"; value: string }
  | { kind: "out"; expr: string }
  | Elem
  | { kind: "if"; branches: [string, TNode[]][]; otherwise: TNode[] | null }
  | { kind: "foreach"; list: string; as: string; key: string; children: TNode[] }
  | { kind: "comp"; def: Def; on: Handler[]; slot: TNode[] | null }
  // dyn: a dynamic slot name ({{ expr }}), with default content: a name the
  // component gives, one it does not, or undefined (Odoo's AutoComplete calls
  // `{{ source.optionSlot }}`, undefined for a source without one)
  | { kind: "slot"; on: Handler[]; dyn?: string }
  // args: the call's attributes, [name, expression]
  | { kind: "call"; def: Def; args: [string, string][] }
  // t-set with t-value, or with a body
  | { kind: "set"; name: string; value: string | null; body: TNode[] | null }
  // its content goes to an element outside the root, one per Portal and loop
  // position (the index of each enclosing loop)
  | { kind: "portal"; target: number; indexes: string[]; on: Handler[]; content: TNode[] }
  // a slow one starts its content with a Gate, whose onWillStart waits for the
  // test to open it: its fallback shows until then
  | { kind: "suspense"; on: Handler[]; content: TNode[]; fallback: TNode[] | null; slow: boolean };

export interface Generated {
  tree: TNode[];
  comps: Def[];
  calls: Def[];
  // mounted in a shadow root, events dispatched composed or not
  shadow: boolean;
  composed: boolean;
}

export const CONTEXT: Scope = {
  a: 3,
  s: 'x&y<z>"q',
  items: [5, 6, 7],
  empty: [],
  words: ["alpha", "b&d"],
  nothing: undefined,
  flag: true,
  cls: "  a \n b\tc  ",
  // loop keys that join into one string in nested loops (a__b then c, a then
  // b__c), or share a string form (1, "1"): what a component key that is not
  // exact gives two components (the interactive templates loop over them)
  keys: ["a__b", "a", "b__c", "c", "a\u0002:b", "b\u0002:c", 1, "1"],
  rows: [
    { id: 1, v: "p" },
    { id: 2, v: "q&" },
    { id: 3, v: "r" },
  ],
};

// events no t-model listens to: a dispatch runs t-on handlers only
export const EVENTS = ["keydown", "pointerdown", "mouseup", "focusin"];
export const MODIFIERS: [string, number][] = [
  ["stop", 0.2],
  ["prevent", 0.2],
  ["self", 0.2],
  ["capture", 0.2],
  ["synthetic", 0.25],
  ["passive", 0.15],
];
export const MODEL_KEY: Record<ModelKind, string> = {
  text: "t",
  check: "c",
  radio: "r",
  select: "s",
};
export const OPTIONS = ["x", "y", "z"];

// a loop variable over this.rows
export const isRow = (local: string) => local.startsWith("r");

export interface Var {
  name: string;
  body: boolean;
}
export interface GenEnv {
  locals: string[];
  depth: number;
  inComp: boolean;
  // rendered more than once for another reason than its loops (a slot, a
  // t-set body, a component in a loop): no Portal, whose target is named by
  // the loop indexes
  multi: boolean;
  // in a t-set body: no component, control, slot, t-call, t-set
  inSet: boolean;
  // the t-set variables in scope
  vars: Var[];
}

export function generator(random: () => number, interactive = false) {
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  // a component's template reads the values through `this`
  const g = (name: string) => (interactive ? `this.${name}` : name);
  let handlerId = 0;
  // every third plain element of an interactive template is written with
  // t-tag: a count, no draw, so that a seed generates the templates it did
  let plainElements = 0;
  let setId = 0;
  let portals = 0;
  let suspenses = 0;
  // every plain element but every fourth has classes: a count, no draw
  let classedElements = 0;
  // every third slot call has a dynamic name: a count, no draw
  let slotCalls = 0;
  const dynSlot = () =>
    ++slotCalls % 3 ? undefined : DYN_SLOT_NAMES[(slotCalls / 3) % DYN_SLOT_NAMES.length];
  let comps: Def[] = [];
  let calls: Def[] = [];
  const read = (local: string) => (isRow(local) ? `${local}.${pick(["v", "id"])}` : local);
  function valueExpr(env: GenEnv): string {
    const { locals } = env;
    if (interactive && env.vars.length && random() < 0.25) {
      return pick(env.vars).name;
    }
    const base = pick([
      g("a"),
      g("s"),
      "'lit'",
      `${g("a")} * 2`,
      `${g("s")}.length`,
      `${g("words")}[0]`,
      ...(interactive ? ["this.m.t"] : []),
      ...locals.map(read),
    ]);
    if (random() < 0.3 && locals.length) {
      const local = pick(locals);
      return pick([
        `${base} + ${read(local)}`,
        `(${local}_first ? 'F' : '') + ${read(local)}`,
        `${local}_index + 1`,
        `${local}_last ? 'L' : ${read(local)}`,
      ]);
    }
    return base;
  }
  function condExpr(env: GenEnv): string {
    return pick([
      g("flag"),
      `!${g("flag")}`,
      `${g("a")} > 2`,
      `${g("a")} lt 2`,
      `${g("items")}.length`,
      `${g("empty")}.length`,
      g("nothing"),
      ...env.locals.map((l) => `${l}_index % 2`),
    ]);
  }
  function handlers(env: GenEnv): Handler[] {
    const result: Handler[] = [];
    const values = [...env.locals, ...env.vars.filter((v) => !v.body).map((v) => v.name)];
    const count = random() < 0.5 ? 0 : 1 + Math.floor(random() * 3);
    for (let i = 0; i < count; i++) {
      const mods = MODIFIERS.filter(([, p]) => random() < p).map(([m]) => m);
      for (let j = mods.length - 1; j > 0; j--) {
        const k = Math.floor(random() * (j + 1));
        [mods[j], mods[k]] = [mods[k], mods[j]];
      }
      const key = [pick(EVENTS), ...mods].join(".");
      // a loop variable, its index or a t-set value: what a stale context
      // would get wrong
      let local: string | null = null;
      if (values.length && random() < 0.5) {
        local = pick(values);
        if (env.locals.includes(local)) {
          local = random() < 0.4 ? `${local}_index` : isRow(local) ? `${local}.id` : local;
        }
      }
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
  function control(env: GenEnv): Elem {
    const r = random();
    const rows = env.locals.filter(isRow);
    const textTag = () => (random() < 0.3 ? "textarea" : "input");
    const textMods = () => ["lazy", "trim", "number"].filter(() => random() < 0.3);
    let el: Elem;
    if (rows.length && random() < 0.4) {
      el = elem(textTag(), []);
      el.model = { kind: "text", mods: textMods(), proxy: true, row: pick(rows) };
    } else if (r < 0.2) {
      el = elem(textTag(), []);
      el.model = { kind: "text", mods: textMods(), proxy: random() < 0.5, row: null };
    } else if (r < 0.3) {
      el = elem("input", [["type", "checkbox"]]);
      el.model = { kind: "check", mods: [], proxy: random() < 0.5, row: null };
    } else if (r < 0.45) {
      el = elem("input", [
        ["type", "radio"],
        ["value", pick(OPTIONS)],
      ]);
      el.model = { kind: "radio", mods: [], proxy: random() < 0.5, row: null };
    } else if (r < 0.55) {
      const options = OPTIONS.map((o) =>
        elem("option", [["value", o]], [{ kind: "text", value: o }])
      );
      el = elem("select", [], options);
      el.model = { kind: "select", mods: [], proxy: random() < 0.5, row: null };
    } else if (r < 0.75) {
      el = elem(textTag(), []);
      el.bound.push(["value", valueExpr(env)]);
      if (random() < 0.3) {
        el.bound.push(["disabled", condExpr(env)]);
      }
    } else if (r < 0.9) {
      el = elem("input", [["type", "checkbox"]]);
      el.bound.push(["checked", condExpr(env)]);
    } else {
      el = elem("input", []);
      el.bound.push(["disabled", condExpr(env)]);
    }
    el.on = handlers(env);
    return el;
  }
  function component(env: GenEnv): TNode {
    // the relay mode follows the component's number: no draw of its own, so
    // that a seed generates the templates it generated before relays existed
    const relay = (comps.length % 3) as 0 | 1 | 2;
    const def: Def = { name: `C${comps.length + 1}`, body: [], relay };
    comps.push(def);
    const depth = env.depth + 1;
    def.body = nodes({
      ...env,
      locals: [],
      depth,
      inComp: true,
      vars: [],
      multi: env.multi || env.locals.length > 0,
    });
    // a slot may be called in a loop, or twice
    const slot = random() < 0.6 ? nodes({ ...env, depth, multi: true }) : null;
    if (slot && random() < 0.7) {
      def.body.splice(Math.floor(random() * (def.body.length + 1)), 0, {
        kind: "slot",
        on: handlers({ ...env, locals: [], vars: [] }),
        dyn: dynSlot(),
      });
    }
    return { kind: "comp", def, on: handlers(env), slot };
  }
  function nodes(env: GenEnv): TNode[] {
    const count = 1 + Math.floor(random() * 3);
    const result: TNode[] = [];
    let vars = env.vars;
    for (let i = 0; i < count; i++) {
      if (interactive && env.depth <= 3 && !env.inSet && random() < 0.1) {
        // read by the nodes after it, and their descendants
        const name = `sv${++setId}`;
        const inner = { ...env, vars, depth: env.depth + 1 };
        if (random() < 0.4) {
          const body = nodes({ ...inner, multi: true, inSet: true });
          result.push({ kind: "set", name, value: null, body });
          vars = [...vars, { name, body: true }];
        } else {
          result.push({ kind: "set", name, value: valueExpr(inner), body: null });
          vars = [...vars, { name, body: false }];
        }
      }
      const n = node({ ...env, vars });
      if ((n.kind === "portal" || n.kind === "suspense") && random() < 0.6) {
        // a value only the context holds, which the sub-root rendering the
        // content reads from the slot of the latest render
        const name = `sv${++setId}`;
        const flags = env.locals.map((l) => `${l}_last ? 'L' : ${l}_first ? 'F' : 'M'`);
        const value = pick([`${g("a")} * 2`, `${g("s")}.length`, ...flags]);
        result.push({ kind: "set", name, value, body: null });
        n.content.unshift({ kind: "out", expr: name });
      }
      result.push(n);
    }
    return result;
  }
  function node(env: GenEnv): TNode {
    const { depth, inComp } = env;
    const inner = { ...env, depth: depth + 1 };
    if (interactive && depth <= 3 && !env.inSet) {
      const q = random();
      if (q < 0.08 && comps.length < 4) {
        return component(env);
      }
      if (q < 0.12 && calls.length < 3) {
        const def: Def = { name: `call${calls.length + 1}`, body: [] };
        calls.push(def);
        def.body = nodes(inner);
        // every other call has an attribute: in a loop it shadows the
        // innermost loop variable (not a row, which a t-model may write), so
        // that the call's context is made under the loop item, holding its
        // own value of that name (no draw: a seed generates the templates it did)
        const last = [...env.locals].reverse().find((local) => !isRow(local));
        const args: [string, string][] =
          calls.length % 2 ? [] : last ? [[last, `${last} + '!'`]] : [["pz", "'lit'"]];
        return { kind: "call", def, args };
      }
      if (q < 0.16 && inComp) {
        return { kind: "slot", on: handlers(env), dyn: dynSlot() };
      }
      if (q < 0.28) {
        return control(env);
      }
      if (q < 0.31 && !env.multi && portals < 3) {
        return {
          kind: "portal",
          target: portals++,
          indexes: env.locals,
          on: handlers(env),
          content: nodes(inner),
        };
      }
      if (q < 0.34 && suspenses < 3) {
        suspenses++;
        return {
          kind: "suspense",
          on: handlers(env),
          content: nodes(inner),
          fallback: random() < 0.7 ? nodes(inner) : null,
          slow: random() < 0.6,
        };
      }
    }
    const r = random();
    if (depth > 3 || r < 0.2) {
      return random() < 0.5
        ? { kind: "text", value: pick(["hi", "a&b", "x<y", "z"]) }
        : { kind: "out", expr: valueExpr(env) };
    }
    if (r < 0.55) {
      const dyn: [string, string][] =
        random() < 0.5 ? [["data-v", random() < 0.15 ? g("nothing") : valueExpr(env)]] : [];
      const attf: [string, string][] =
        random() < 0.4 ? [["title", `t-{{${valueExpr(env)}}}-e`]] : [];
      const el = elem(
        pick(["span", "p", "b", "li"]),
        random() < 0.5 ? [["id", pick(["one", "two"])]] : []
      );
      el.dyn = dyn;
      el.attf = attf;
      const classes = ++classedElements % 4;
      if (classes) {
        el.cls = {
          statics: classes > 1 ? "s a" : null,
          expr: g(classedElements % 7 ? "cls" : "nothing"),
          viaAtt: classes === 3,
        };
      }
      el.children = nodes(inner);
      if (interactive) {
        el.on = handlers(env);
        el.dynTag = ++plainElements % 3 === 0;
      }
      return el;
    }
    if (r < 0.75) {
      const branches: [string, TNode[]][] = [[condExpr(env), nodes(inner)]];
      if (random() < 0.5) {
        branches.push([condExpr(env), nodes(inner)]);
      }
      return {
        kind: "if",
        branches,
        otherwise: random() < 0.5 ? nodes(inner) : null,
      };
    }
    if (interactive && random() < 0.3) {
      // proxies in a loop: a t-model.proxy on the loop variable writes to it
      const as = "r".repeat(depth + 1);
      const children = nodes({ ...inner, locals: [...env.locals, as] });
      return { kind: "foreach", list: g("rows"), as, key: `${as}.id`, children };
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
      key: as,
      children: nodes({ ...inner, locals: [...env.locals, as] }),
    };
  }
  return (): Generated => {
    handlerId = 0;
    setId = 0;
    portals = 0;
    suspenses = 0;
    slotCalls = 0;
    comps = [];
    calls = [];
    const env: GenEnv = {
      locals: [],
      depth: 0,
      inComp: false,
      multi: false,
      inSet: false,
      vars: [],
    };
    const tree = nodes(env);
    const shadow = interactive && random() < 0.25;
    const composed = shadow && random() < 0.5;
    return { tree, comps, calls, shadow, composed };
  };
}

export function toXml(list: TNode[]): string {
  return list.map(nodeXml).join("");
}

export function onXml(on: Handler[]): string {
  return on
    .map((h) => {
      const args = `'${h.id}'${h.local ? `, ${h.local}` : ""}`;
      const code = h.call ? `this.logger(${args})` : `(ev) => this.log(ev, ${args})`;
      return ` t-on-${h.key}="${escapeAttr(code)}"`;
    })
    .join("");
}

export function nodeXml(n: TNode): string {
  switch (n.kind) {
    case "text":
      return n.value.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    case "out":
      return `<t t-out="${escapeAttr(n.expr)}"/>`;
    case "elem": {
      const attrs = [
        ...n.attrs.map(([k, v]) => `${k}="${v}"`),
        ...(n.cls?.statics ? [`class="${n.cls.statics}"`] : []),
        ...(n.cls
          ? [
              n.cls.viaAtt
                ? `t-att="${escapeAttr(`{ 'class': ${n.cls.expr} }`)}"`
                : `t-att-class="${escapeAttr(n.cls.expr)}"`,
            ]
          : []),
        ...n.dyn.map(([k, v]) => `t-att-${k}="${escapeAttr(v)}"`),
        ...n.attf.map(([k, v]) => `t-attf-${k}="${escapeAttr(v)}"`),
        ...n.bound.map(([k, v]) => `t-att-${k}="${escapeAttr(v)}"`),
      ];
      if (n.model) {
        const { proxy, mods, kind, row } = n.model;
        const suffix = (proxy ? ["proxy", ...mods] : mods).map((m) => `.${m}`).join("");
        const target = row ? `${row}.v` : `this.${proxy ? "m" : "ms"}.${MODEL_KEY[kind]}`;
        attrs.push(`t-model${suffix}="${target}"`);
      }
      const tag = n.dynTag ? "t" : n.tag;
      if (n.dynTag) {
        attrs.unshift(`t-tag="'${n.tag}'"`);
      }
      const open = `${tag}${attrs.length ? " " + attrs.join(" ") : ""}${onXml(n.on)}`;
      return `<${open}>${toXml(n.children)}</${tag}>`;
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
      return `<t t-foreach="${n.list}" t-as="${n.as}" t-key="${n.key}">${toXml(n.children)}</t>`;
    case "comp": {
      const name = n.def.relay ? `R${n.def.name}` : n.def.name;
      return n.slot
        ? `<${name}${onXml(n.on)}>${toXml(n.slot)}</${name}>`
        : `<${name}${onXml(n.on)}/>`;
    }
    case "slot":
      return n.dyn
        ? `<t t-call-slot="{{ ${n.dyn} }}"${onXml(n.on)}><s>${SLOT_DEFAULT_TEXT}</s></t>`
        : `<t t-call-slot="default"${onXml(n.on)}/>`;
    case "call":
      return `<t t-call="${n.def.name}"${n.args.map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join("")}/>`;
    case "set":
      return n.body
        ? `<t t-set="${n.name}">${toXml(n.body)}</t>`
        : `<t t-set="${n.name}" t-value="${escapeAttr(n.value!)}"/>`;
    case "portal":
      const target = [n.target, ...n.indexes.map((l) => `${l}_index`)].join(", ");
      return `<Portal target="this.pt(${target})"${onXml(n.on)}>${toXml(n.content)}</Portal>`;
    case "suspense": {
      const fallback = n.fallback ? `<t t-set-slot="fallback">${toXml(n.fallback)}</t>` : "";
      const gate = n.slow ? "<Gate/>" : "";
      return `<Suspense${onXml(n.on)}>${gate}${toXml(n.content)}${fallback}</Suspense>`;
    }
  }
}

export function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ---------------------------------------------------------------------------
// reference renderer: a tree of elements, each with the handlers it holds,
// the catchers (t-on of a component or slot) enclosing it in its parent, and
// the state its properties must show
// ---------------------------------------------------------------------------

export interface RHandler {
  event: string;
  mods: string[];
  entry: string;
}
export interface VEl {
  tag: string;
  attrs: [string, string][];
  children: VChild[];
  parent: VEl | null;
  on: RHandler[];
  // the handlers of each catcher enclosing it, innermost first
  catchers: RHandler[][];
  props: [string, unknown][];
  model: Model | null;
  // the row whose `v` a t-model.proxy on a row holds
  row: Scope | null;
}
export type VChild = VEl | string;
export interface REnv {
  // the slow Suspenses show their content, not their fallback
  loaded: boolean;
  // the element each Portal renders its content in, by the key of its target
  portals: Map<string, VEl>;
}
export interface RCtx {
  self: unknown;
  locals: Scope;
  // the content a t-call-slot renders here, and where it was written
  slot: { nodes: TNode[]; ctx: RCtx } | null;
  env: REnv;
}

// a t-set body: rendered where t-out reads it, and its HTML where a string is
// needed (text as it is, an element's markup escaped)
export class BodyValue {
  constructor(
    readonly body: TNode[],
    readonly ctx: RCtx
  ) {}
  toString(): string {
    return renderList(this.body, this.ctx)
      .map((c) => (typeof c === "string" ? c : serialize(c, false)))
      .join("");
  }
}

export const compiled = new Map<string, Function>();
export function evaluate(expr: string, ctx: RCtx): any {
  const names = Object.keys(ctx.locals);
  const key = `${names.join(",")}|${expr}`;
  const fn = compiled.getOrInsertComputed(
    key,
    () => new Function(...names, `return (${expr.replace(/\blt\b/g, "<")});`)
  );
  return fn.call(ctx.self, ...names.map((n) => ctx.locals[n]));
}

export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function rHandlers(on: Handler[], ctx: RCtx): RHandler[] {
  return on.map((h) => {
    const [event, ...mods] = h.key.split(".");
    const entry = h.local ? `${h.id}:${String(evaluate(h.local, ctx))}` : h.id;
    return { event, mods, entry };
  });
}

export function withCatcher(children: VChild[], on: Handler[], ctx: RCtx): VChild[] {
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

export const DYN_SLOT_NAMES = ["'default'", "undefined", "'missing'"];
export const SLOT_DEFAULT_TEXT = "fb";

export function vel(tag: string, children: VChild[]): VEl {
  const el: VEl = {
    tag,
    attrs: [],
    children,
    parent: null,
    on: [],
    catchers: [],
    props: [],
    model: null,
    row: null,
  };
  adopt(el);
  return el;
}

export function adopt(el: VEl) {
  for (const child of el.children) {
    if (typeof child !== "string") {
      child.parent = el;
    }
  }
}

// a t-set is seen by the nodes after it in its list
export function renderList(list: TNode[], ctx: RCtx): VChild[] {
  const result: VChild[] = [];
  for (const n of list) {
    if (n.kind === "set") {
      const value = n.body ? new BodyValue(n.body, ctx) : evaluate(n.value!, ctx);
      ctx = { ...ctx, locals: { ...ctx.locals, [n.name]: value } };
    } else {
      result.push(...renderNode(n, ctx));
    }
  }
  return result;
}

export function renderNode(n: TNode, ctx: RCtx): VChild[] {
  switch (n.kind) {
    case "text":
      return [n.value];
    case "out": {
      const value = evaluate(n.expr, ctx);
      if (value instanceof BodyValue) {
        return renderList(value.body, value.ctx);
      }
      return value === undefined || value === null ? [] : [String(value)];
    }
    case "elem": {
      const el = vel(n.tag, renderList(n.children, ctx));
      el.attrs = [...n.attrs];
      if (n.cls) {
        const words = [
          ...(n.cls.statics ?? "").split(/\s+/),
          ...String(evaluate(n.cls.expr, ctx) ?? "").split(/\s+/),
        ].filter(Boolean);
        if (words.length) {
          el.attrs.push(["class", [...new Set(words)].join(" ")]);
        }
      }
      el.on = rHandlers(n.on, ctx);
      el.model = n.model;
      el.row = n.model?.row ? (ctx.locals[n.model.row] as Scope) : null;
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
        env: ctx.env,
      };
      return withCatcher(renderList(n.def.body, inner), n.on, ctx);
    }
    case "slot": {
      // a dynamic name other than "default" names no slot: the default
      // content renders, as it does when the component gives no slot
      const named = !n.dyn || n.dyn === "'default'";
      const content =
        named && ctx.slot
          ? renderList(ctx.slot.nodes, ctx.slot.ctx)
          : n.dyn
            ? [vel("s", [SLOT_DEFAULT_TEXT])]
            : [];
      return withCatcher(content, n.on, ctx);
    }
    case "call": {
      if (!n.args.length) {
        return renderList(n.def.body, ctx);
      }
      const locals = { ...ctx.locals };
      for (const [name, expr] of n.args) {
        locals[name] = evaluate(expr, ctx);
      }
      return renderList(n.def.body, { ...ctx, locals });
    }
    case "set":
      // handled by renderList
      return [];
    case "portal": {
      // the content is elsewhere: a catcher on the Portal, or around it, holds
      // nothing of it
      const key = [n.target, ...n.indexes.map((l) => ctx.locals[`${l}_index`])].join(":");
      const target = ctx.env.portals.getOrInsertComputed(key, () => vel("article", []));
      target.children.push(...renderList(n.content, ctx));
      adopt(target);
      return [];
    }
    case "suspense": {
      let content: VChild[];
      if (n.slow && !ctx.env.loaded) {
        content = n.fallback ? renderList(n.fallback, ctx) : [];
      } else {
        content = renderList(n.content, ctx);
        if (n.slow) {
          content.unshift(vel("i", ["g"]));
        }
      }
      return withCatcher(content, n.on, ctx);
    }
  }
}

export function renderRoot(list: TNode[], ctx: RCtx): VEl {
  return vel("div", renderList(list, ctx));
}

// a class's words in any order: a patch adds and removes words
function classWords(value: string): string {
  return value.split(/\s+/).filter(Boolean).sort().join(" ");
}

export function serialize(v: VChild, sorted: boolean): string {
  if (typeof v === "string") {
    return escapeText(v);
  }
  const attrs = v.attrs.map(
    ([k, value]) => ` ${k}="${escapeHtmlAttr(sorted && k === "class" ? classWords(value) : value)}"`
  );
  if (sorted) {
    attrs.sort();
  }
  return `<${v.tag}${attrs.join("")}>${v.children.map((c) => serialize(c, sorted)).join("")}</${v.tag}>`;
}

export function render(list: TNode[], scope: Scope): string {
  return renderList(list, {
    self: undefined,
    locals: scope,
    slot: null,
    env: { loaded: true, portals: new Map() },
  })
    .map((c) => serialize(c, false))
    .join("");
}

// the same names with other values: lists reordered, shrunk and grown, the
// conditions flipped, an attribute value going undefined
export const UPDATED: Scope = {
  a: 1,
  s: "plain",
  items: [7, 5, 8, 6],
  empty: [9],
  words: ["b&d"],
  nothing: "now",
  flag: false,
  cls: " b  d ",
  keys: ["c", "b__c", "a", 1, "a\u0002:b", "x"],
  rows: [
    { id: 3, v: "R" },
    { id: 1, v: "P" },
    { id: 4, v: "N" },
  ],
};

// attribute order carries no meaning: an attribute set by a patch comes last
export function canonical(html: string): string {
  const root = document.createElement("div");
  root.innerHTML = html;
  return [...root.childNodes].map(domString).join("");
}

// the DOM as built, not as an HTML parser would rebuild it (a <p> in a <p>)
export function domString(node: ChildNode): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return escapeText(node.textContent!);
  }
  const el = node as Element;
  const attrs = [...el.attributes]
    // an empty class is no class: removing the last word leaves the attribute
    .filter((a) => a.name !== "class" || a.value.trim())
    .map((a) => {
      const value = a.name === "class" ? classWords(a.value) : a.value;
      return ` ${a.name}="${escapeHtmlAttr(value)}"`;
    })
    .sort()
    .join("");
  const tag = el.tagName.toLowerCase();
  return `<${tag}${attrs}>${[...el.childNodes].map(domString).join("")}</${tag}>`;
}
