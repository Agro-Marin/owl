import {
  Component,
  mount,
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
// tracked by its parent, and no onWillUpdateProps hook may run again for props
// whose hooks already settled.

function prng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

interface World {
  pending: { resolve: () => void }[];
  violations: string[];
  live: Set<Component>;
}

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

  class Slow extends Component {
    static template = xml`<b t-out="this.props.value"/>`;
    props = props();
    setup() {
      tracked(this);
      slowUpdates(this, (p) => String(p.value));
    }
  }
  class Item extends Component {
    static template = xml`<li><t t-out="this.props.list"/><t t-out="this.props.id"/>:<t t-out="this.props.label"/>:<t t-out="this.state.n"/><t t-if="this.props.isSelected(this.props.id)">*</t></li>`;
    props = props();
    state = proxy({ n: 0 });
    setup() {
      tracked(this);
      if (this.props.id % 2) {
        slowUpdates(this, (p) => `${p.list}${p.id}/${p.label}`);
      }
    }
  }
  class Parent extends Component {
    static template = xml`
      <div>
        <Slow value="this.state.value"/>
        <ul><t t-foreach="this.state.items" t-as="id" t-key="id"><Item list="'u'" id="id" label="this.state.label" isSelected="this.isSelected"/></t></ul>
        <ol><t t-foreach="this.state.items" t-as="id" t-key="id" t-memo="[this.state.label]"><Item list="'o'" id="id" label="this.state.label" isSelected="this.isSelected"/></t></ol>
        <Slow t-if="this.state.flag" value="this.state.value * 10"/>
      </div>`;
    static components = { Slow, Item };
    state = proxy({ value: 0, label: "a", flag: false, selected: 0, items: [1, 2, 3] as number[] });
    isSelected = selector(() => this.state.selected);
    setup() {
      tracked(this);
    }
  }
  return Parent;
}

function expectedHtml(state: any, itemStates: Map<string, number>): string {
  const items = (list: string) =>
    state.items
      .map(
        (id: number) =>
          `<li>${list}${id}:${state.label}:${itemStates.get(list + id) ?? 0}${state.selected === id ? "*" : ""}</li>`
      )
      .join("");
  const extra = state.flag ? `<b>${state.value * 10}</b>` : "";
  return `<div><b>${state.value}</b><ul>${items("u")}</ul><ol>${items("o")}</ol>${extra}</div>`;
}

async function runScenario(seed: number, steps: number) {
  const fixture = makeTestFixture();
  const world: World = { pending: [], violations: [], live: new Set() };
  const Parent = makeApp(world);
  const parent: any = await mount(Parent, fixture);
  const random = prng(seed);
  let nextId = 4;
  const itemComponents = () =>
    [...world.live].filter((c: any) => c.constructor.name === "Item") as any[];
  const trace: string[] = [];
  for (let step = 0; step < steps; step++) {
    const r = random();
    const state = parent.state;
    if (r < 0.15) {
      state.value++;
      trace.push(`value=${state.value}`);
    } else if (r < 0.25) {
      state.label = state.label === "a" ? "b" : "a";
      trace.push(`label=${state.label}`);
    } else if (r < 0.32) {
      state.flag = !state.flag;
      trace.push(`flag=${state.flag}`);
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
  const expected = expectedHtml(parent.state, itemStates);
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
  const items = itemComponents();
  if (items.length !== 2 * parent.state.items.length) {
    problems.push(`${items.length} live Items for ${parent.state.items.length} ids in two lists`);
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

test("random render sequences settle on the render of the final state", async () => {
  const failures: string[] = [];
  const start = Date.now();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const failure = await runScenario(seed, 40);
    if (failure) {
      failures.push(failure);
    }
  }
  expect(failures.slice(0, 3)).toEqual([]);
  void start;
}, 120000);
