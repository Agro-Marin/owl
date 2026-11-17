import {
  App,
  Component,
  Portal,
  onMounted,
  onWillDestroy,
  onWillStart,
  signal,
  t,
  useProps,
  xml,
} from "../../src";
import { prng } from "../../../../tools/testing/helpers";
import { makeDeferred, makeTestFixture, nextTick } from "../helpers";

let fixture: HTMLElement;
let target: HTMLElement;
let apps: App[];
let outsideTargets: HTMLElement[];
function outside() {
  const element = document.createElement("div");
  document.body.appendChild(element);
  outsideTargets.push(element);
  return element;
}
beforeEach(() => {
  fixture = makeTestFixture();
  outsideTargets = [];
  target = outside();
  apps = [];
});
afterEach(() => {
  for (const app of apps) app.destroy();
  for (const element of outsideTargets) element.remove();
});
async function mount<T extends typeof Component>(Root: T) {
  const app = new App();
  apps.push(app);
  const result = await app.createRoot(Root).mount(fixture);
  await nextTick();
  return result;
}

test("positioned portals follow rank and remain after a later unpositioned portal", async () => {
  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target" position="2"><b>B</b></Portal>
      <Portal target="this.target" position="1"><b>A</b></Portal>
      <Portal target="this.target"><b>U</b></Portal>`;
    target = target;
  }
  await mount(Root);
  expect(target.textContent).toBe("UAB");
});

test("equal positions retain actual mount order when one portal starts slowly", async () => {
  const ready = makeDeferred();
  class Slow extends Component {
    static template = xml`<b>A</b>`;
    setup() {
      onWillStart(() => ready);
    }
  }
  class Root extends Component {
    static components = { Portal, Slow };
    static template = xml`
      <Portal target="this.target" position="0"><Slow/></Portal>
      <Portal target="this.target" position="0"><b>B</b></Portal>`;
    target = target;
  }
  await mount(Root);
  expect(target.textContent).toBe("B");
  ready.resolve();
  await nextTick();
  expect(target.textContent).toBe("BA");
});

test("a keyed reorder moves multi-root content without recreating components", async () => {
  let created = 0;
  class Item extends Component {
    static template = xml`<b t-out="this.props.label"/><i t-out="this.props.label"/>`;
    props = useProps({ label: t.string() });
    setup() {
      created++;
    }
  }
  class Root extends Component {
    static components = { Portal, Item };
    static template = xml`
      <Portal t-foreach="this.items()" t-as="item" t-key="item" target="this.target" position="item_index">
        <Item label="item"/>
      </Portal>`;
    target = target;
    items = signal(["a", "b", "c"]);
  }
  const component = await mount(Root);
  const first = target.querySelector("b");
  component.items.set(["c", "a", "b"]);
  await nextTick();
  expect(target.textContent).toBe("ccaabb");
  expect(target.querySelectorAll("b")[1]).toBe(first);
  expect(created).toBe(3);
});

test("a mounted portal that changes target does not leave an ordering entry behind", async () => {
  const other = outside();
  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.host()" position="0"><b>P</b></Portal>
      <Portal target="this.other"><b>U</b></Portal>`;
    host = signal(target);
    other = other;
  }
  const component = await mount(Root);
  component.host.set(other);
  await nextTick();
  expect(target.textContent).toBe("");
  expect(other.textContent).toBe("UP");
  apps[0].destroy();
  expect(other.textContent).toBe("");
});

test("changing ranks without changing fragment order performs no DOM moves", async () => {
  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target" position="this.rank()"><input/><b>A</b></Portal>
      <Portal target="this.target" position="10"><i>B</i></Portal>`;
    target = target;
    rank = signal(0);
  }
  const component = await mount(Root);
  const input = target.querySelector("input")!;
  input.focus();
  const moves: MutationRecord[] = [];
  const observer = new MutationObserver((records) => moves.push(...records));
  observer.observe(target, { childList: true });
  component.rank.set(1);
  await nextTick();
  moves.push(...observer.takeRecords());
  observer.disconnect();
  expect(document.activeElement).toBe(input);
  expect(moves).toEqual([]);
});

test("retargeting before content is ready mounts only the surviving root", async () => {
  const other = outside();
  const ready = makeDeferred();
  let mounted = 0;
  class Slow extends Component {
    static template = xml`<b>ready</b>`;
    setup() {
      onWillStart(() => ready);
      onMounted(() => {
        mounted++;
      });
    }
  }
  class Root extends Component {
    static components = { Portal, Slow };
    static template = xml`<Portal target="this.host()" position="0"><Slow/></Portal>`;
    host = signal(target);
  }
  const component = await mount(Root);
  component.host.set(other);
  await nextTick();
  ready.resolve();
  await nextTick();
  expect(mounted).toBe(1);
  expect(target.textContent).toBe("");
  expect(other.textContent).toBe("ready");
});

test.each([7, 41, 2026])(
  "portal ordering follows a model through mixed updates (seed %s)",
  async (seed) => {
    const random = prng(seed);
    const choose = (n: number) => Math.floor(random() * n);
    const hosts = [target, outside()];
    const mounted = new Map<number, number>();
    let clock = 0;
    let id = 0;
    type Item = { id: number; host: number | null; rank: number | undefined };
    const ranks = [undefined, -1, 0, 1, 2];
    const makeItem = (): Item => ({ id: ++id, host: choose(2), rank: ranks[choose(ranks.length)] });
    class Content extends Component {
      static template = xml`<input t-att-data-id="this.props.id"/><b t-att-data-id="this.props.id" t-out="this.props.id"/>`;
      props = useProps({ id: t.number() });
      setup() {
        const id = this.props.id;
        onMounted(() => {
          mounted.set(id, ++clock);
        });
        onWillDestroy(() => {
          mounted.delete(id);
        });
      }
    }
    class Root extends Component {
      static components = { Portal, Content };
      static template = xml`
      <Portal t-foreach="this.items()" t-as="item" t-key="item.id"
        target="item.host === null ? null : this.hosts[item.host]" position="item.rank">
        <Content id="item.id"/>
      </Portal>`;
      hosts = hosts;
      items = signal<Item[]>(Array.from({ length: 4 }, makeItem));
    }
    const component = await mount(Root);
    for (let step = 0; step < 40; step++) {
      let items = component.items();
      const at = choose(items.length);
      switch (choose(5)) {
        case 0:
          items = items.map((item, i) =>
            i === at ? { ...item, rank: ranks[choose(ranks.length)] } : item
          );
          break;
        case 1:
          items = items.map((item, i) =>
            i === at ? { ...item, host: [null, 0, 1][choose(3)] } : item
          );
          break;
        case 2:
          items = [...items, makeItem()];
          break;
        case 3:
          items = items.filter((_, i) => i !== at);
          break;
        case 4:
          items = [...items].reverse();
      }
      component.items.set(items);
      await nextTick();
      await nextTick();
      for (const [host, element] of hosts.entries()) {
        const expected = items.filter((item) => item.host === host);
        const byId = new Map(expected.map((item) => [item.id, item]));
        const inputs = [...element.querySelectorAll("input")];
        const actual = inputs.map((input) => byId.get(Number(input.dataset.id))!);
        expect(actual).toHaveLength(expected.length);
        expect(new Set(actual.map((item) => item.id))).toEqual(
          new Set(expected.map((item) => item.id))
        );
        const ordered = actual.filter((item) => item.rank !== undefined);
        expect(ordered).toEqual(
          [...ordered].sort((a, b) => a.rank! - b.rank! || mounted.get(a.id)! - mounted.get(b.id)!)
        );
        const firstPositioned = actual.findIndex((item) => item.rank !== undefined);
        if (firstPositioned !== -1)
          expect(actual.slice(firstPositioned).every((item) => item.rank !== undefined)).toBe(true);
        for (const input of inputs)
          expect((input.nextElementSibling as HTMLElement).dataset.id).toBe(input.dataset.id);
      }
    }
    apps[0].destroy();
    expect(mounted.size).toBe(0);
    expect(hosts.every((host) => host.textContent === "")).toBe(true);
  }
);

test.each([NaN, Infinity, -Infinity])(
  "an invalid rank %s names the position error",
  async (rank) => {
    class Root extends Component {
      static components = { Portal };
      static template = xml`<Portal target="this.target" position="this.rank"><b>P</b></Portal>`;
      target = target;
      rank = rank;
    }
    await expect(mount(Root)).rejects.toThrow("Portal position must be a finite number");
    expect(target.textContent).toBe("");
  }
);
