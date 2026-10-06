import {
  App,
  Component,
  mount,
  onWillDestroy,
  props,
  setDebug,
  setDebugSink,
  xml,
} from "../../src";
import { makeTestFixture, nextTick, render } from "../helpers";

// A child component's key in its parent's children is the path to its site:
// site ids, loop keys, t-keys, slot and template names. Two paths that spell
// one key make two children share a node: the second replaces the first in
// the parent's children, and the first stays in the DOM untracked (no deep
// render, no destroy).

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

function tracking() {
  const destroyed: number[] = [];
  let n = 0;
  class Item extends Component {
    static template = xml`<b t-out="this.id"/>`;
    id = ++n;
    setup() {
      onWillDestroy(() => destroyed.push(this.id));
    }
  }
  return { Item, destroyed, created: () => n };
}

describe("component keys", () => {
  test("nested loops whose string keys hold the separator of their site ids", async () => {
    const { Item, destroyed } = tracking();
    // the keys a__b then c, and a then b__c, spelled one key __1__a__b__c
    class Parent extends Component {
      static template = xml`<div><t t-foreach="['a__b', 'a']" t-as="o" t-key="o"><t t-foreach="o === 'a' ? ['b__c'] : ['c']" t-as="i" t-key="i"><Item/></t></t></div>`;
      static components = { Item };
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div><b>1</b><b>2</b></div>");
    expect(Object.keys(parent.__owl__.children)).toHaveLength(2);
    parent.__owl__.app.destroy();
    expect(destroyed.sort()).toEqual([1, 2]);
  });

  test("nested loops whose string keys hold the mark of a segment", async () => {
    const { Item, destroyed } = tracking();
    class Parent extends Component {
      static template = xml`<div><t t-foreach="this.outer" t-as="o" t-key="o"><t t-foreach="this.inner[o]" t-as="i" t-key="i"><Item/></t></t></div>`;
      static components = { Item };
      outer = ["a\u0002:b", "a"];
      inner: Record<string, string[]> = { "a\u0002:b": ["c"], a: ["b\u0002:c"] };
    }
    const parent = await mount(Parent, fixture);
    expect(Object.keys(parent.__owl__.children)).toHaveLength(2);
    parent.__owl__.app.destroy();
    expect(destroyed.sort()).toEqual([1, 2]);
  });

  test("a t-key holding the separator of site ids, beside a loop", async () => {
    const { Item, destroyed } = tracking();
    // t-key x__2 on the site __1, and t-key x on the site __2 in a loop over
    // 1, spelled one key x__2__1
    class Parent extends Component {
      static template = xml`<div><Item t-key="'x__2'"/><t t-foreach="['1']" t-as="i" t-key="i"><Item t-key="'x'"/></t></div>`;
      static components = { Item };
    }
    const parent = await mount(Parent, fixture);
    expect(Object.keys(parent.__owl__.children)).toHaveLength(2);
    parent.__owl__.app.destroy();
    expect(destroyed.sort()).toEqual([1, 2]);
  });

  test("arrays of objects as keys are told apart by their items", async () => {
    const { Item, destroyed } = tracking();
    const a = {};
    const b = {};
    class Parent extends Component {
      static template = xml`<div><t t-foreach="this.keys" t-as="k" t-key="k"><Item/></t></div>`;
      static components = { Item };
      keys = [[a], [b], [[a]], ["@1"], [1], ["1"]];
    }
    const parent = await mount(Parent, fixture);
    expect(Object.keys(parent.__owl__.children)).toHaveLength(6);
    // a new array of the same items is the same key
    (parent as any).keys = (parent as any).keys.map((k: unknown[]) => [...k]);
    render(parent);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><b>1</b><b>2</b><b>3</b><b>4</b><b>5</b><b>6</b></div>");
    parent.__owl__.app.destroy();
    expect(destroyed.sort()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("a t-set body output by two components gives each its own components", async () => {
    const { Item, destroyed } = tracking();
    class Show extends Component {
      static template = xml`<span><t t-out="this.props.v"/></span>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<div><t t-set="body"><Item/></t><Show v="body"/><Show v="body"/></div>`;
      static components = { Show, Item };
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div><span><b>1</b></span><span><b>2</b></span></div>");
    const shows = Object.values(parent.__owl__.children);
    expect(shows.map((show) => Object.keys(show.children).length)).toEqual([1, 1]);
    parent.__owl__.app.destroy();
    expect(destroyed.sort()).toEqual([1, 2]);
  });

  test("a t-set body output by another component renders with it", async () => {
    const { Item, destroyed } = tracking();
    class Show extends Component {
      static template = xml`<span><t t-if="this.on"><t t-out="this.props.v"/></t></span>`;
      props = props();
      on = true;
    }
    class Parent extends Component {
      static template = xml`<div><t t-set="body"><Item/></t><Show v="body"/></div>`;
      static components = { Show, Item };
    }
    const parent = await mount(Parent, fixture);
    const show: any = Object.values(parent.__owl__.children)[0].component;
    // the body's Item is Show's: Show renders it alone, and drops it
    render(show);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><span><b>1</b></span></div>");
    show.on = false;
    render(show);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><span></span></div>");
    expect(destroyed).toEqual([1]);
    show.on = true;
    render(show);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><span><b>2</b></span></div>");
    parent.__owl__.app.destroy();
    expect(destroyed).toEqual([1, 2]);
  });

  test("a t-set body output by another component is logged on the fiber channel", async () => {
    const { Item } = tracking();
    class Show extends Component {
      static template = xml`<span><t t-out="this.props.v"/></span>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<div><t t-set="body"><Item/></t><Show v="body"/><t t-out="body"/></div>`;
      static components = { Show, Item };
    }
    const lines: string[] = [];
    setDebugSink((channel, message) => {
      if (message.includes("t-set body")) {
        lines.push(`${channel}: ${message}`);
      }
    });
    setDebug(["fiber"]);
    try {
      await mount(Parent, fixture);
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(lines).toEqual([
      "fiber: t-set body of Parent output by Show: its components are Show's",
    ]);
  });

  test("a slot's content and its default content never share a component", async () => {
    let n = 0;
    class Item extends Component {
      static template = xml`<b>item</b>`;
    }
    class Other extends Component {
      static template = xml`<i>other</i>`;
      id = ++n;
    }
    class Child extends Component {
      static template = xml`<span><t t-call-slot="default"><Item/></t></span>`;
      static components = { Item };
      props = props();
    }
    // the slot's Other takes the second site id of the parent's template, the
    // default content's Item the second of Child's
    class Middle extends Component {
      static template = xml`<Child slots="this.on ? this.props.slots : {}"/>`;
      static components = { Child };
      props = props();
      on = true;
    }
    class Parent extends Component {
      static template = xml`<div><Middle><t t-out="1"/><Other/></Middle></div>`;
      static components = { Middle, Other };
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div><span>1<i>other</i></span></div>");
    const middle: any = Object.values(parent.__owl__.children)[0].component;
    middle.on = false;
    render(middle);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><span><b>item</b></span></div>");
  });

  test("a value's key carries its type", async () => {
    const { Item, destroyed } = tracking();
    const values = [1, "1", "'1", true, "true", "@true", null, "null", 12n, "12", NaN, "NaN", ""];
    class Parent extends Component {
      static template = xml`<div><t t-foreach="this.values" t-as="v" t-key="v"><Item/></t></div>`;
      static components = { Item };
      values = values;
    }
    const parent = await mount(Parent, fixture);
    expect(Object.keys(parent.__owl__.children)).toHaveLength(values.length);
    parent.__owl__.app.destroy();
    expect(destroyed).toHaveLength(values.length);
  });
});

// ---------------------------------------------------------------------------
// property test: random templates with adversarial loop keys, slots called in
// loops, dynamic t-calls with bodies, t-set bodies output in loops and by
// other components
// ---------------------------------------------------------------------------

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

const OBJ1 = { o: 1 };
const OBJ2 = { o: 2 };
const FN = () => 0;
const SYM = Symbol("s");
const REG = Symbol.for("a\u0002:b");

// keys that spell one another once joined without an exact encoding: the
// separators of every encoding owl used (__, \u0002 and its tags), numbers
// that spell site ids, and values of other types with the same string form.
// For each separator S, the outer key a then the inner b S c, and the outer
// a S b then the inner c, join as one string
const SEPARATORS = ["__", "\u0002", "\u0002:", "\u0002\u0002", ":", "\u00021"];
const FAMILY: unknown[] = [
  "a",
  "c",
  "b",
  "",
  "1",
  1,
  "__1",
  "\u0002",
  "\u0002\u0002",
  "\u00021",
  ...SEPARATORS.flatMap((sep) => [`a${sep}b`, `b${sep}c`]),
];
const OTHERS: unknown[] = [
  "__",
  "\u0002:",
  "\u0002k",
  "\u0002s",
  "a\u0002",
  "-1",
  -1,
  "@1",
  "'1",
  "'",
  "@true",
  "true",
  true,
  false,
  null,
  undefined,
  "null",
  0,
  1.5,
  NaN,
  Infinity,
  -Infinity,
  12n,
  "12",
  "é",
  "😀",
  "1,2",
  OBJ1,
  OBJ2,
  FN,
  SYM,
  REG,
];
// arrays are made anew each render: a new array of the same items is the
// same key
const ARRAYS: (() => unknown[])[] = [
  () => [1, 2],
  () => ["1,2"],
  () => [OBJ1],
  () => [OBJ2],
  () => [[1], 2],
  () => [],
];
const POOL_SIZE = FAMILY.length + OTHERS.length + ARRAYS.length;

function poolValue(i: number): unknown {
  if (i < FAMILY.length) {
    return FAMILY[i];
  }
  i -= FAMILY.length;
  return i < OTHERS.length ? OTHERS[i] : ARRAYS[i - OTHERS.length]();
}

function hash(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) % 2147483646;
  }
  return h + 1;
}

// distinct pool entries, mostly from the family, in random order
function pickKeys(random: () => number, max: number): number[] {
  const count = Math.floor(random() * (max + 1));
  const result: number[] = [];
  for (let tries = 0; result.length < count && tries < 20; tries++) {
    const i =
      random() < 0.75
        ? Math.floor(random() * FAMILY.length)
        : FAMILY.length + Math.floor(random() * (POOL_SIZE - FAMILY.length));
    if (!result.includes(i)) {
      result.push(i);
    }
  }
  return result;
}

type KNode =
  | { kind: "leaf"; tkey: number | null }
  | { kind: "loop"; id: number; v: string; path: string[]; children: KNode[] }
  | { kind: "box"; def: string; children: KNode[] }
  | { kind: "call"; id: number; children: KNode[] }
  | { kind: "set"; name: string; body: KNode[] }
  | { kind: "out"; name: string }
  | { kind: "show"; def: string; name: string }
  | { kind: "zero" }
  | { kind: "slot" };

interface KTemplates {
  root: KNode[];
  boxes: Map<string, KNode[]>;
  shows: Map<string, KNode[]>;
  subs: Map<string, KNode[]>;
}

// the names of the templates a dynamic t-call picks from: they hold the
// separators too
const SUB_NAMES = ["sub", "sub__1", "s\u0002tub", "sub\u0002"];

function generate(random: () => number): KTemplates {
  let loopId = 0;
  let setId = 0;
  let callId = 0;
  let tkeyId = 0;
  const boxes = new Map<string, KNode[]>();
  const shows = new Map<string, KNode[]>();
  const subs = new Map<string, KNode[]>();
  type Where = "root" | "box" | "show" | "sub";
  function nodes(depth: number, locals: string[], sets: string[], where: Where): KNode[] {
    const count = 1 + Math.floor(random() * 3);
    const result: KNode[] = [];
    const scopeSets = [...sets];
    for (let i = 0; i < count; i++) {
      const n = node(depth, locals, scopeSets, where);
      result.push(n);
      if (n.kind === "set") {
        scopeSets.push(n.name);
      }
    }
    return result;
  }
  function node(depth: number, locals: string[], sets: string[], where: Where): KNode {
    const r = random();
    if (depth > 2 || r < 0.2) {
      if (where === "box" && random() < 0.5) {
        return { kind: "slot" };
      }
      if (where === "sub" && random() < 0.6) {
        return { kind: "zero" };
      }
      if (where === "show" && random() < 0.6) {
        return { kind: "out", name: "this.props.v" };
      }
      if (sets.length && random() < 0.6) {
        return { kind: "out", name: sets[Math.floor(random() * sets.length)] };
      }
      return { kind: "leaf", tkey: random() < 0.25 ? ++tkeyId : null };
    }
    if (r < 0.55) {
      const v = `x${depth}${locals.length}`;
      return {
        kind: "loop",
        id: ++loopId,
        v,
        path: locals,
        children: nodes(depth + 1, [...locals, v], sets, where),
      };
    }
    if (r < 0.65 && boxes.size < 3 && depth < 2) {
      const def = `Box${boxes.size + 1}`;
      boxes.set(def, []);
      boxes.set(def, nodes(depth + 1, [], [], "box"));
      return { kind: "box", def, children: nodes(depth + 1, locals, sets, where) };
    }
    if (r < 0.75 && where === "root" && depth < 2) {
      if (!subs.size) {
        for (const name of SUB_NAMES) {
          subs.set(name, []);
          subs.set(name, nodes(2, [], [], "sub"));
        }
      }
      return { kind: "call", id: ++callId, children: nodes(depth + 1, locals, sets, where) };
    }
    if (r < 0.88) {
      return { kind: "set", name: `v${++setId}`, body: nodes(depth + 1, locals, sets, where) };
    }
    if (sets.length && shows.size < 3) {
      const def = `Show${shows.size + 1}`;
      shows.set(def, []);
      shows.set(def, nodes(2, [], [], "show"));
      return { kind: "show", def, name: sets[Math.floor(random() * sets.length)] };
    }
    return { kind: "leaf", tkey: null };
  }
  const root = nodes(0, [], [], "root");
  return { root, boxes, shows, subs };
}

function kXml(list: KNode[]): string {
  return list.map(kNodeXml).join("");
}

function kNodeXml(n: KNode): string {
  switch (n.kind) {
    case "leaf":
      return n.tkey === null ? `<Leaf/>` : `<Leaf t-key="this.tk(${n.tkey})"/>`;
    case "loop": {
      const path = `[${n.path.map((l) => `${l}.i`).join(", ")}]`;
      return `<t t-foreach="this.coll(${n.id}, ${path})" t-as="${n.v}" t-key="${n.v}.k">${kXml(n.children)}</t>`;
    }
    case "box":
      return `<${n.def}>${kXml(n.children)}</${n.def}>`;
    case "call":
      return `<t t-call="{{this.tname(${n.id})}}">${kXml(n.children)}</t>`;
    case "set":
      return `<t t-set="${n.name}">${kXml(n.body)}</t>`;
    case "out":
      return `<t t-out="${n.name}"/>`;
    case "show":
      return `<${n.def} v="${n.name}"/>`;
    case "zero":
      return `<t t-out="0"/>`;
    case "slot":
      return `<t t-call-slot="default"/>`;
  }
}

interface KWorld {
  epoch: number;
  seed: number;
  alive: Set<any>;
  created: number;
  renders: Map<any, number>;
}

function makeKeyApp(world: KWorld, templates: KTemplates) {
  class Base extends Component {
    coll(id: number, path: number[]) {
      const random = prng(hash(`${world.seed}|${id}|${path.join(",")}|${world.epoch}`));
      const keys = pickKeys(random, 3);
      // half the time, the keys that join with the enclosing loop's into the
      // string another pair of keys joins into
      if (random() < 0.5) {
        const sep = 10 + 2 * Math.floor(random() * SEPARATORS.length);
        const outer = path.length ? FAMILY[path[path.length - 1]] : null;
        const extra = outer === null ? [0, sep] : outer === "a" ? [sep + 1] : [1];
        for (const i of extra) {
          if (!keys.includes(i)) {
            keys.splice(Math.floor(random() * (keys.length + 1)), 0, i);
          }
        }
      }
      return keys.map((i) => ({ k: poolValue(i), i }));
    }
    tk(id: number) {
      const random = prng(hash(`${world.seed}|tk${id}|${world.epoch}`));
      return poolValue(Math.floor(random() * POOL_SIZE));
    }
    tname(id: number) {
      const random = prng(hash(`${world.seed}|call${id}|${world.epoch}`));
      return SUB_NAMES[Math.floor(random() * SUB_NAMES.length)];
    }
  }
  const components: Record<string, any> = {};
  class Leaf extends Base {
    static template = xml`<b class="leaf" t-att-data-id="this.id" t-att-data-n="this.rendered()"/>`;
    id = ++world.created;
    setup() {
      world.alive.add(this);
      onWillDestroy(() => world.alive.delete(this));
    }
    rendered() {
      const n = (world.renders.get(this) || 0) + 1;
      world.renders.set(this, n);
      return n;
    }
  }
  components.Leaf = Leaf;
  for (const def of [...templates.boxes.keys(), ...templates.shows.keys()]) {
    components[def] = class extends Base {
      static template = def;
      static components = components;
      props = props();
    };
  }
  class Root extends Base {
    static template = "root";
    static components = components;
  }
  return Root;
}

async function settleApp(app: App) {
  for (let i = 0; i < 50; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    if (!app.scheduler.tasks.size && !app.scheduler.frame) {
      return;
    }
  }
}

interface KStats {
  leaves: number;
  templates: number;
}

function keyProblems(world: KWorld, root: HTMLElement): string[] {
  const problems: string[] = [];
  const ids = [...root.querySelectorAll("b.leaf")].map((el) => Number(el.getAttribute("data-id")));
  const shown = new Set(ids);
  if (shown.size !== ids.length) {
    problems.push(`a component shown twice: ${ids}`);
  }
  const alive = new Map([...world.alive].map((c) => [c.id, c]));
  for (const id of shown) {
    if (!alive.has(id)) {
      problems.push(`leaf ${id} shown, but destroyed`);
    }
  }
  for (const [id, leaf] of alive) {
    const node = leaf.__owl__;
    if (!shown.has(id)) {
      problems.push(`leaf ${id} alive, not shown`);
    }
    if (node.status !== 1) {
      problems.push(`leaf ${id} status ${node.status}`);
    }
    if (![...(node.parent.childMap?.values() || [])].includes(node)) {
      problems.push(`leaf ${id} not in its parent's children`);
    }
  }
  return problems;
}

async function runKeys(seed: number, stats: KStats): Promise<string | null> {
  const random = prng(seed);
  const templates = generate(random);
  const world: KWorld = { epoch: 0, seed, alive: new Set(), created: 0, renders: new Map() };
  const root = makeTestFixture();
  const app = new App({ test: true });
  app.scheduler.requestAnimationFrame = (cb) => setImmediate(() => cb(0)) as any;
  app.addTemplate("root", `<div>${kXml(templates.root)}</div>`);
  for (const [name, body] of [...templates.boxes, ...templates.shows, ...templates.subs]) {
    app.addTemplate(name, kXml(body));
  }
  const problems: string[] = [];
  let component: any;
  try {
    component = await app.createRoot(makeKeyApp(world, templates)).mount(root);
    for (let epoch = 0; epoch < 4 && !problems.length; epoch++) {
      if (epoch) {
        world.epoch = epoch;
        component.__owl__.render(false);
        await settleApp(app);
      }
      stats.leaves += world.alive.size;
      problems.push(...keyProblems(world, root).map((p) => `epoch ${epoch}: ${p}`));
    }
    if (!problems.length) {
      // a deep render reaches every child
      const before = new Map(world.renders);
      component.__owl__.render(true);
      await settleApp(app);
      for (const leaf of world.alive) {
        if (world.renders.get(leaf) === before.get(leaf)) {
          problems.push(`leaf ${leaf.id} not rendered by a deep render`);
        }
      }
    }
  } catch (error: any) {
    problems.push(`throws ${error.message}`);
  }
  app.destroy();
  if (world.alive.size) {
    problems.push(`${world.alive.size} leaves not destroyed with the app`);
  }
  stats.templates++;
  if (!problems.length) {
    return null;
  }
  const defs = [...templates.boxes, ...templates.shows, ...templates.subs]
    .map(([name, body]) => `\n  ${JSON.stringify(name)}: ${kXml(body)}`)
    .join("");
  return `seed ${seed}: <div>${kXml(templates.root)}</div>${defs}\n  ${problems.slice(0, 3).join("\n  ")}`;
}

const KEY_SEEDS = Number(process.env.OWL_KEY_SEEDS || 300);

test(
  "random templates with adversarial loop keys give every child a key of its own",
  async () => {
    const stats: KStats = { leaves: 0, templates: 0 };
    const failures: string[] = [];
    for (let seed = 1; seed <= KEY_SEEDS && failures.length < 3; seed++) {
      const failure = await runKeys(seed, stats);
      if (failure) {
        failures.push(failure);
      }
    }
    expect(failures).toEqual([]);
    // not vacuous: the templates hold components
    expect(stats.leaves).toBeGreaterThan(KEY_SEEDS * 4);
  },
  Math.max(120000, KEY_SEEDS * 400)
);
