import {
  Component,
  mount,
  onError,
  onWillDestroy,
  onWillUpdateProps,
  props,
  proxy,
  selector,
  xml,
} from "../../src";
import { makeTestFixture, nextMicroTick, nextTick } from "../helpers";

// Random sequences of state changes, slow onWillUpdateProps hooks resolved in
// any order, and ticks, against a small tree: once everything settles, the DOM
// must be the render of the final state, every live component mounted and
// tracked by its parent, no onWillUpdateProps hook may run again for props
// whose hooks already settled, and a click on any element must run the
// handlers of that element and its ancestors, with their latest context (the
// t-on of a component in a loop, of an element in a slot, a memoized item's).

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface World {
  pending: { resolve: () => void }[];
  clicks: string[];
  violations: string[];
  live: Set<Component>;
  // whether the bomb's render threw: its boundary shows the fallback from then on
  threw: boolean;
}

// a grid keyed by row then column, whose keys join into one string across
// the two loops (a__b then c, a then b__c) or share a string form (1, "1"):
// a component key that is not exact gives two cells one key
const ROWS: unknown[] = ["a__b", "a", "a\u0002:b", "b", "1", 1];
const COLUMNS = new Map<unknown, unknown[]>([
  ["a__b", ["c", "x"]],
  ["a", ["b__c", "b\u0002:c", "x"]],
  ["a\u0002:b", ["c"]],
  ["b", []],
  ["1", ["2"]],
  [1, ["2", 2]],
]);

function makeApp(world: World) {
  // a hook call for the props the component already holds is a violation:
  // node.props only ever receives props whose hooks have settled
  function slowUpdates(component: any, describe: (p: any) => string) {
    onWillUpdateProps((next: any) => {
      const incoming = describe(next);
      if (incoming === describe(component.__owl__.props)) {
        world.violations.push(
          `${component.constructor.name}: onWillUpdateProps again for ${incoming}`
        );
      }
      return new Promise<void>((resolve) => {
        world.pending.push({ resolve });
      });
    });
  }
  function tracked(component: Component) {
    world.live.add(component);
    onWillDestroy(() => world.live.delete(component));
  }
  const click = (entry: string) => world.clicks.push(entry);

  class Slow extends Component {
    static template = xml`<b t-on-click="() => this.click('slow:' + this.props.value)" t-out="this.props.value"/>`;
    props = props();
    click = click;
    setup() {
      tracked(this);
      slowUpdates(this, (p) => String(p.value));
    }
  }
  class Item extends Component {
    static template = xml`<li t-on-click="() => this.click('li:' + this.props.list + this.props.id)"><t t-out="this.props.list"/><t t-out="this.props.id"/>:<t t-out="this.props.label"/>:<t t-out="this.state.n"/><t t-if="this.props.isSelected(this.props.id)">*</t></li>`;
    props = props();
    click = click;
    state = proxy({ n: 0 });
    setup() {
      tracked(this);
      if (this.props.id % 2) {
        slowUpdates(this, (p) => `${p.list}${p.id}/${p.label}`);
      }
    }
  }
  class Box extends Component {
    static template = xml`<section t-on-click="() => this.click('box')"><t t-call-slot="default"/></section>`;
    props = props();
    click = click;
    setup() {
      tracked(this);
    }
  }
  class Cell extends Component {
    static template = xml`<dd t-out="this.props.row + '|' + this.props.col"/>`;
    props = props();
    setup() {
      tracked(this);
    }
  }
  class Bomb extends Component {
    static template = xml`<s t-on-click="() => this.click('bomb')" t-out="this.check()"/>`;
    props = props();
    click = click;
    setup() {
      tracked(this);
    }
    check() {
      if (this.props.armed) {
        world.threw = true;
        throw new Error("boom");
      }
      return "ok";
    }
  }
  class Guard extends Component {
    static template = xml`<em t-if="this.state.failed">failed</em><t t-else=""><Bomb armed="this.props.armed"/></t>`;
    static components = { Bomb };
    props = props();
    state = proxy({ failed: false });
    setup() {
      tracked(this);
      onError(() => {
        this.state.failed = true;
      });
    }
  }
  class Parent extends Component {
    static template = xml`
      <div t-on-click="() => this.click('div')">
        <Slow value="this.state.value"/>
        <ul><t t-foreach="this.state.items" t-as="id" t-key="id"><Item list="'u'" id="id" label="this.state.label" isSelected="this.isSelected" t-on-click="() => this.click('u:' + id + '@' + id_index)"/></t></ul>
        <ol><t t-foreach="this.state.items" t-as="id" t-key="id" t-memo="[this.state.label]"><Item list="'o'" id="id" label="this.state.label" isSelected="this.isSelected" t-on-click="() => this.click('o:' + id)"/></t></ol>
        <Box><i t-on-click="() => this.click('slot:' + this.state.value)" t-out="this.state.value"/></Box>
        <Guard armed="this.state.armed"/>
        <Slow t-if="this.state.flag" value="this.state.value * 10"/>
        <p><u t-on-click="() => this.click('pu')"/></p>
        <a t-on-click="() => this.click('pa')"/>
        <dl><t t-foreach="this.state.rows" t-as="r" t-key="r"><t t-foreach="this.columns(r)" t-as="c" t-key="c"><Cell row="r" col="c"/></t></t></dl>
      </div>`;
    static components = { Slow, Item, Box, Guard, Cell };
    state = proxy({
      value: 0,
      label: "a",
      flag: false,
      selected: 0,
      armed: false,
      items: [1, 2, 3] as number[],
      rows: ["a__b", "a"] as unknown[],
    });
    columns = (row: unknown) => COLUMNS.get(row)!;
    isSelected = selector(() => this.state.selected);
    click = click;
    setup() {
      tracked(this);
    }
  }
  return Parent;
}

function expectedHtml(state: any, itemStates: Map<string, number>, threw: boolean): string {
  const items = (list: string) =>
    state.items
      .map(
        (id: number) =>
          `<li>${list}${id}:${state.label}:${itemStates.get(list + id) ?? 0}${state.selected === id ? "*" : ""}</li>`
      )
      .join("");
  const extra = state.flag ? `<b>${state.value * 10}</b>` : "";
  const guard = threw ? "<em>failed</em>" : "<s>ok</s>";
  const cells = state.rows
    .map((row: unknown) =>
      COLUMNS.get(row)!
        .map((col) => `<dd>${row}|${col}</dd>`)
        .join("")
    )
    .join("");
  return `<div><b>${state.value}</b><ul>${items("u")}</ul><ol>${items("o")}</ol><section><i>${state.value}</i></section>${guard}${extra}<p><u></u></p><a></a><dl>${cells}</dl></div>`;
}

// the handlers a click on the element runs, by its place in expectedHtml: its
// own, then for an Item's li, its parent's t-on on the Item (with the loop id
// and index: a stale context gets the index wrong after a reorder), then the
// ancestors'
function expectedClicks(target: Element): string[] {
  const ran: string[] = [];
  for (let el: Element | null = target; el && el.tagName !== "DIV"; el = el.parentElement) {
    const text = el.textContent!;
    switch (el.tagName) {
      case "LI": {
        const [, list, id] = text.match(/^([uo])(\d+):/)!;
        const index = [...el.parentElement!.children].indexOf(el);
        // a memoized item keeps the context it was rendered with: its index
        // may be an old one
        ran.push(`li:${list}${id}`, list === "u" ? `u:${id}@${index}` : `o:${id}`);
        break;
      }
      case "B":
        ran.push(`slow:${text}`);
        break;
      case "SECTION":
        ran.push("box");
        break;
      case "I":
        ran.push(`slot:${text}`);
        break;
      case "S":
        ran.push("bomb");
        break;
      case "U":
        ran.push("pu");
        break;
      case "A":
        ran.push("pa");
        break;
    }
  }
  ran.push("div");
  return ran;
}

async function runScenario(seed: number, steps: number) {
  const fixture = makeTestFixture();
  const world: World = {
    pending: [],
    clicks: [],
    violations: [],
    live: new Set(),
    threw: false,
  };
  const Parent = makeApp(world);
  const parent: any = await mount(Parent, fixture);
  const random = prng(seed);
  // the grid's changes draw from a stream of their own: the other changes
  // are those the seed drew before the grid
  const gridRandom = prng(seed * 7919);
  let nextId = 4;
  const itemComponents = () =>
    [...world.live].filter((c: any) => c.constructor.name === "Item") as any[];
  const trace: string[] = [];
  for (let step = 0; step < steps; step++) {
    const r = random();
    const state = parent.state;
    const g = gridRandom();
    if (g < 0.25) {
      const row = ROWS[Math.floor(gridRandom() * ROWS.length)];
      const at = state.rows.indexOf(row);
      if (at === -1) {
        state.rows.splice(Math.floor(gridRandom() * (state.rows.length + 1)), 0, row);
      } else {
        state.rows.splice(at, 1);
      }
      trace.push(`row ${JSON.stringify(row)}`);
    } else if (g < 0.3) {
      state.rows.reverse();
      trace.push(`reverse rows`);
    }
    if (r < 0.15) {
      state.value++;
      trace.push(`value=${state.value}`);
    } else if (r < 0.25) {
      state.label = state.label === "a" ? "b" : "a";
      trace.push(`label=${state.label}`);
    } else if (r < 0.3) {
      state.flag = !state.flag;
      trace.push(`flag=${state.flag}`);
    } else if (r < 0.32) {
      state.armed = !state.armed;
      trace.push(`armed=${state.armed}`);
    } else if (r < 0.42) {
      state.items.push(nextId++);
      trace.push(`push`);
    } else if (r < 0.5 && state.items.length) {
      state.items.splice(Math.floor(random() * state.items.length), 1);
      trace.push(`remove`);
    } else if (r < 0.57 && state.items.length > 1) {
      state.items.reverse();
      trace.push(`reverse`);
    } else if (r < 0.6) {
      state.selected = state.items.length
        ? state.items[Math.floor(random() * state.items.length)]
        : 0;
      trace.push(`select ${state.selected}`);
    } else if (r < 0.65) {
      const items = itemComponents();
      if (items.length) {
        const item = items[Math.floor(random() * items.length)];
        item.state.n++;
        trace.push(`item ${item.props.list}${item.props.id}.n++`);
      }
    } else if (r < 0.85 && world.pending.length) {
      const [p] = world.pending.splice(Math.floor(random() * world.pending.length), 1);
      p.resolve();
      trace.push(`resolve`);
    } else if (r < 0.93) {
      await nextMicroTick();
      trace.push(`micro`);
    } else {
      await nextTick();
      trace.push(`tick`);
    }
  }
  // settle: resolve whatever is pending until nothing new appears
  for (let round = 0; round < 50; round++) {
    while (world.pending.length) {
      world.pending.shift()!.resolve();
    }
    await nextTick();
    if (!world.pending.length) {
      await nextTick();
      if (!world.pending.length) break;
    }
  }
  const itemStates = new Map<string, number>();
  for (const item of itemComponents()) {
    itemStates.set(item.props.list + item.props.id, item.state.n);
  }
  const problems: string[] = [...world.violations];
  const expected = expectedHtml(parent.state, itemStates, world.threw);
  if (fixture.innerHTML !== expected) {
    problems.push(`DOM ${fixture.innerHTML}\n  expected ${expected}`);
  }
  for (const component of world.live) {
    const node: any = (component as any).__owl__;
    if (node.status !== 1) {
      problems.push(`${component.constructor.name} live but status ${node.status}`);
    }
    if (node.parent && ![...(node.parent.childMap?.values() || [])].includes(node)) {
      problems.push(`${component.constructor.name} not in its parent's childMap`);
    }
  }
  for (const el of fixture.querySelectorAll("*")) {
    world.clicks = [];
    el.dispatchEvent(new Event("click", { bubbles: true }));
    const expected = expectedClicks(el);
    if (world.clicks.join(",") !== expected.join(",")) {
      problems.push(`click on ${el.outerHTML}: ran ${world.clicks} expected ${expected}`);
    }
  }
  const items = itemComponents();
  if (items.length !== 2 * parent.state.items.length) {
    problems.push(`${items.length} live Items for ${parent.state.items.length} ids in two lists`);
  }
  const cells = [...world.live].filter((c: any) => c.constructor.name === "Cell").length;
  const expectedCells = parent.state.rows.reduce(
    (n: number, row: unknown) => n + COLUMNS.get(row)!.length,
    0
  );
  if (cells !== expectedCells) {
    problems.push(`${cells} live Cells for ${expectedCells} cells in the grid`);
  }
  parent.__owl__.app.destroy();
  if (world.live.size) {
    problems.push(`${world.live.size} component(s) not destroyed with the app`);
  }
  return problems.length
    ? `seed ${seed}: ${problems.join("; ")}\n  trace: ${trace.join(", ")}`
    : null;
}

const SEEDS = Number(process.env.OWL_MODEL_SEEDS || 40);

test(
  "random render sequences settle on the render of the final state",
  async () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= SEEDS; seed++) {
      const failure = await runScenario(seed, 40);
      if (failure) {
        failures.push(failure);
      }
    }
    expect(failures.slice(0, 3)).toEqual([]);
  },
  Math.max(120000, SEEDS * 200)
);
