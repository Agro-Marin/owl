import {
  App,
  blockDom,
  Component,
  onWillDestroy,
  onWillStart,
  Portal,
  proxy,
  Suspense,
} from "../../src";
import { makeTestFixture } from "../helpers";
import {
  CONTEXT,
  Def,
  EVENTS,
  Generated,
  MODEL_KEY,
  Model,
  OPTIONS,
  REnv,
  RHandler,
  Scope,
  TNode,
  UPDATED,
  VEl,
  domString,
  generator,
  prng,
  renderRoot,
  serialize,
  toXml,
  vel,
} from "./template_fuzz_lib";

const COUNT = Number(process.env.OWL_TEMPLATE_FUZZ || 400);
// ---------------------------------------------------------------------------
// interactive templates: mounted as components in an App
// ---------------------------------------------------------------------------

interface LogEntry {
  entry: string;
  // where the listener that ran the handler is: the element, or for a
  // catcher, its parent element
  node: EventTarget | null;
  // run by a document or shadow root listener, replaying the path
  synthetic: boolean;
  phase: number;
}
interface World {
  state: any;
  model: any;
  // per key of the model, a function reading it with a set method writing it
  accessors: Record<string, any>;
  log: LogEntry[];
  // the node owl dispatches the running handler at
  listener: EventTarget | null;
  // the Portal targets, by key, created when a render first names one
  targets: Map<string, HTMLElement>;
  container: Node;
  // what each Gate's onWillStart waits for
  gate: Promise<void>;
  // the components alive, and how many times each rendered
  alive: Set<any>;
  renders: Map<any, number>;
  root: any;
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
    pt(...key: number[]) {
      const name = key.join(":");
      let target = world.targets.get(name);
      if (!target) {
        target = world.container.appendChild(document.createElement("article"));
        world.targets.set(name, target);
      }
      return target;
    }
    log(ev: Event, id: string, ...value: unknown[]) {
      world.log.push({
        entry: value.length ? `${id}:${String(value[0])}` : id,
        node: world.listener,
        synthetic: !(ev.currentTarget instanceof Element),
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
  class Gate extends Component {
    static template = "gate";
    setup() {
      onWillStart(() => world.gate);
    }
  }
  const components: Record<string, any> = { Portal, Suspense, Gate };
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
// `<depth><c|t|b>` (capture, at target, bubble) for native listeners, and
// `<depth>s<c|b>` for synthetic ones, which a document (or shadow root)
// listener replays over the path: the capturing ones before every native
// listener, outermost first, the others after them, innermost first. Each
// group is sorted (the order of two listeners of one element is not
// specified), then ` !` if the default was prevented (a passive handler
// cannot). A stop ends the propagation after the group where it happened;
// .self holds back the handler (and the modifiers after it) unless the target
// is its element, or for a catcher, the element of its child holding the target.
function expectedLog(target: VEl, event: string): string {
  const path: VEl[] = [];
  for (let n: VEl | null = target; n; n = n.parent) {
    path.push(n);
  }
  const top = path.length - 1;
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
      const passive = h.mods.includes("passive");
      h.mods.forEach((m, i) => {
        if (i < selfIdx || runs) {
          stop ||= m === "stop";
          prevented ||= m === "prevent" && !passive;
        }
      });
      if (runs) {
        entries.push(h.entry);
      }
    }
    return stop;
  };
  const matches = (h: RHandler, capture: boolean, synthetic: boolean) =>
    h.event === event &&
    h.mods.includes("capture") === capture &&
    h.mods.includes("synthetic") === synthetic;
  // the handlers of path[i]: its own, and those of the catchers of its child
  // holding the target, which listen on it
  const at = (i: number, capture: boolean, synthetic: boolean): [RHandler, boolean][] => {
    const items: [RHandler, boolean][] = path[i].on
      .filter((h) => matches(h, capture, synthetic))
      .map((h) => [h, i === 0]);
    if (i > 0) {
      const child = path[i - 1];
      for (const catcher of child.catchers) {
        for (const h of catcher) {
          if (matches(h, capture, synthetic)) {
            items.push([h, child === target]);
          }
        }
      }
    }
    return items;
  };
  const finish = (label: string) => {
    flush(label);
    return groups.join(" ") + (prevented ? " !" : "");
  };
  for (let i = top; i >= 0; i--) {
    const stop = run(at(i, true, true));
    flush(`${i}sc`);
    if (stop) {
      return finish("");
    }
  }
  for (let i = top; i >= 1; i--) {
    const stop = run(at(i, true, false));
    flush(`${i}c`);
    if (stop) {
      return finish("");
    }
  }
  if (run(at(0, true, false)) || run(at(0, false, false))) {
    return finish("0t");
  }
  flush("0t");
  for (let i = 1; i <= top; i++) {
    const stop = run(at(i, false, false));
    flush(`${i}b`);
    if (stop) {
      return finish("");
    }
  }
  for (let i = 0; i <= top; i++) {
    const stop = run(at(i, false, true));
    flush(`${i}sb`);
    if (stop) {
      return finish("");
    }
  }
  return finish("");
}

function actualLog(log: LogEntry[], target: Element, prevented: boolean): string {
  const groups: [string, string[]][] = [];
  for (const { entry, node, synthetic, phase } of log) {
    let depth = 0;
    let n: Node | null = target;
    while (n && n !== node) {
      n = n.parentNode;
      depth++;
    }
    const where = synthetic ? `s${"?c?b"[phase] || "?"}` : "?ctb"[phase] || "?";
    const label = `${n ? depth : "?"}${where}`;
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
// share a key leave one out, and nothing renders or destroys it from there.
// Until the gate opens, a slow Suspense's content is rendered, not mounted.
function componentProblems(world: World, loaded: boolean): string[] {
  const problems: string[] = [];
  for (const component of world.alive) {
    const node = component.__owl__;
    let top = node;
    while (top.parent) {
      top = top.parent;
    }
    if (!loaded && top.status !== 1 && top.component !== world.root) {
      continue;
    }
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
      const value = v.row ? v.row.v : model[MODEL_KEY[v.model.kind]];
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

function eventProblems(
  pairs: [Element, VEl][],
  events: string[],
  world: World,
  composed: boolean
): string[] {
  const problems: string[] = [];
  for (const [el, v] of pairs) {
    for (const event of events) {
      world.log = [];
      const ev = new Event(event, { bubbles: true, cancelable: true, composed });
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

// one user edit of a form control holding a model (holder[key]), applied to
// the reference too; false when the control cannot change the model
function edit(el: HTMLInputElement, model: Model, holder: Scope, key: string, n: number): boolean {
  switch (model.kind) {
    case "text": {
      const transform = (raw: string) => {
        const value = model.mods.includes("trim") ? raw.trim() : raw;
        return model.mods.includes("number") ? toNumber(value) : value;
      };
      for (let i = 0; i < TEXT_INPUTS.length; i++) {
        const raw = TEXT_INPUTS[(n + i) % TEXT_INPUTS.length];
        if (transform(raw) !== holder[key]) {
          el.value = raw;
          holder[key] = transform(raw);
          const lazy = model.mods.includes("lazy") || model.mods.includes("trim");
          el.dispatchEvent(new Event(lazy ? "change" : "input", { bubbles: true }));
          return true;
        }
      }
      return false;
    }
    case "check":
      el.checked = !el.checked;
      holder[key] = el.checked;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    case "radio": {
      const value = el.getAttribute("value");
      if (holder[key] === value) {
        return false;
      }
      el.checked = true;
      holder[key] = value;
      // a plain event: no activation behavior, only the model's handler
      el.dispatchEvent(new Event("click", { bubbles: true }));
      return true;
    }
    case "select": {
      const value = OPTIONS.find((o) => o !== holder[key] && OPTIONS.indexOf(o) >= n % 3) || "x";
      if (value === holder[key]) {
        return false;
      }
      el.value = value;
      holder[key] = value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }
  }
}

const hasSlow = (list: TNode[]): boolean =>
  list.some((n) => {
    switch (n.kind) {
      case "suspense":
        return n.slow || hasSlow(n.content) || hasSlow(n.fallback || []);
      case "elem":
        return hasSlow(n.children);
      case "if":
        return n.branches.some(([, b]) => hasSlow(b)) || hasSlow(n.otherwise || []);
      case "foreach":
        return hasSlow(n.children);
      case "comp":
        return hasSlow(n.def.body) || hasSlow(n.slot || []);
      case "call":
        return hasSlow(n.def.body);
      case "portal":
        return hasSlow(n.content);
      default:
        return false;
    }
  });

async function runInteractive(generated: Generated): Promise<string[]> {
  const { tree, comps, calls, shadow, composed } = generated;
  const fixture = makeTestFixture();
  let container: HTMLElement | ShadowRoot = fixture;
  if (shadow) {
    const host = document.createElement("div");
    fixture.appendChild(host);
    container = host.attachShadow({ mode: "open" });
  }
  const appHost = document.createElement("div");
  container.appendChild(appHost);
  let openGate!: () => void;
  const world: World = {
    state: proxy(structuredClone(CONTEXT)),
    model: proxy({ ...MODEL }),
    accessors: {},
    log: [],
    listener: null,
    targets: new Map(),
    container,
    gate: new Promise<void>((resolve) => (openGate = resolve)),
    alive: new Set(),
    renders: new Map(),
    root: null,
  };
  for (const key in MODEL) {
    world.accessors[key] = Object.assign(() => world.model[key], {
      set: (value: unknown) => {
        world.model[key] = value;
      },
    });
  }
  // the node owl dispatches at: the outermost call is the listener's (a
  // catcher's listener dispatches to each catcher's handlers in turn)
  const { config } = blockDom;
  const mainEventHandler = config.mainEventHandler;
  config.mainEventHandler = (fn, mods, ctx, ev, currentTarget, arg) => {
    const outer = world.listener === null;
    if (outer) {
      world.listener = currentTarget;
    }
    try {
      mainEventHandler(fn, mods, ctx, ev, currentTarget, arg);
    } finally {
      if (outer) {
        world.listener = null;
      }
    }
  };
  const refModel: Scope = { ...MODEL };
  let refScope: Scope = structuredClone(CONTEXT);
  const env: REnv = { loaded: false, portals: new Map() };
  const xml = `<div>${toXml(tree)}</div>`;
  const events = EVENTS.filter((e) =>
    [xml, ...[...comps, ...calls].map((d) => toXml(d.body))].some((x) => x.includes(`t-on-${e}`))
  );
  const app = new App({ test: true });
  app.scheduler.requestAnimationFrame = (cb) => setImmediate(() => cb(0)) as any;
  app.addTemplate("root", xml);
  app.addTemplate("gate", "<i>g</i>");
  for (const def of [...comps, ...calls]) {
    app.addTemplate(def.name, toXml(def.body));
  }
  let root: any;
  const problems: string[] = [];
  const check = (stage: string, withEvents: boolean): [Element, VEl][] | null => {
    env.portals = new Map();
    const vroot = renderRoot(tree, {
      self: { ...refScope, m: refModel },
      locals: {},
      slot: null,
      env,
    });
    const pairs: [Element, VEl][] = [];
    const roots: [Element, VEl][] = [[appHost.firstElementChild!, vroot]];
    for (const [key, target] of world.targets) {
      roots.push([target, env.portals.get(key) || vel("article", [])]);
    }
    for (const key of env.portals.keys()) {
      if (!world.targets.has(key)) {
        problems.push(`${stage}: no Portal target ${key}`);
        return null;
      }
    }
    for (const [el, v] of roots) {
      const found = pair(el, v);
      if (typeof found === "string") {
        problems.push(`${stage}: ${found}`);
        return null;
      }
      pairs.push(...found);
    }
    const found = [...componentProblems(world, env.loaded), ...stateProblems(pairs, refModel)];
    if (JSON.stringify({ ...world.model }) !== JSON.stringify(refModel)) {
      found.push(`model: owl ${JSON.stringify(world.model)} ref ${JSON.stringify(refModel)}`);
    }
    if (JSON.stringify(world.state.rows) !== JSON.stringify(refScope.rows)) {
      found.push(
        `rows: owl ${JSON.stringify(world.state.rows)} ref ${JSON.stringify(refScope.rows)}`
      );
    }
    if (withEvents) {
      found.push(...eventProblems(pairs, events, world, composed));
    }
    problems.push(...found.slice(0, 3).map((p) => `${stage}: ${p}`));
    return found.length ? null : pairs;
  };
  try {
    root = world.root = await app.createRoot(makeRoot(world, comps)).mount(appHost);
    await settle(app);
    let pairs = check("mount", true);
    if (pairs && hasSlow(tree)) {
      openGate();
      env.loaded = true;
      await settle(app);
      pairs = check("loaded", true);
    }
    openGate();
    env.loaded = true;
    if (pairs) {
      Object.assign(world.state, structuredClone(UPDATED));
      refScope = structuredClone(UPDATED);
      await settle(app);
      pairs = check("update", true);
    }
    if (pairs) {
      Object.assign(world.state, structuredClone(CONTEXT));
      refScope = structuredClone(CONTEXT);
      await settle(app);
      pairs = check("back", true);
    }
    // user edits of each form control holding a model, one at a time
    for (let k = 0; pairs && k < pairs.length; k++) {
      const [el, v] = pairs[k];
      if (v.model) {
        const holder = v.row || refModel;
        const key = v.row ? "v" : MODEL_KEY[v.model.kind];
        if (edit(el as HTMLInputElement, v.model, holder, key, k)) {
          await settle(app);
          pairs = check(`edit ${pathOf(v)}`, false);
        }
      }
    }
    if (pairs) {
      pairs = check("edited", true);
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
      check("rerender", false);
      for (const component of world.alive) {
        if (world.renders.get(component) === before.get(component)) {
          problems.push(`rerender: ${component.constructor.name} not rendered by a deep render`);
        }
      }
    }
  } catch (error: any) {
    problems.push(`throws ${error.message}`);
  } finally {
    config.mainEventHandler = mainEventHandler;
  }
  app.destroy();
  if (world.alive.size) {
    problems.push(`${world.alive.size} component(s) not destroyed with the app`);
  }
  if (problems.length) {
    const defs = [...comps, ...calls].map((d) => `\n  ${d.name}: ${toXml(d.body)}`).join("");
    const where = shadow ? ` (shadow root${composed ? ", composed" : ""})` : "";
    return [`${xml}${defs}${where}\n  ${problems.join("\n  ")}`];
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
