import {
  App,
  blockDom,
  Component,
  mount,
  onError,
  onMounted,
  onPatched,
  onWillDestroy,
  onWillPatch,
  onWillStart,
  onWillUnmount,
  onWillUpdateProps,
  props,
  proxy,
  signal,
  status,
  xml,
} from "../../src";
import {
  getConsoleOutput,
  makeDeferred,
  makeTestFixture,
  nextMicroTick,
  nextTick,
} from "../helpers";

let fixture: HTMLElement;
let log: string[];

beforeEach(() => {
  fixture = makeTestFixture();
  log = [];
});

function trackLifecycle(name: string) {
  onMounted(() => log.push(`${name}:mounted`));
  onWillUnmount(() => log.push(`${name}:willUnmount`));
  onWillDestroy(() => log.push(`${name}:willDestroy`));
}

function boundaryApp(opts: { childThrows: () => boolean; mid?: boolean }) {
  let n = 0;
  const refs: { boundary?: any; mid?: any } = {};
  class Child extends Component {
    static template = xml`<p>child</p>`;
    setup() {
      const id = ++n;
      trackLifecycle(`Child${id}`);
      onMounted(() => {
        if (opts.childThrows()) {
          throw new Error("boom");
        }
      });
    }
  }
  class Boundary extends Component {
    static template = xml`<div><t t-if="this.state.error">fallback</t><Child t-else=""/></div>`;
    static components = { Child };
    state = proxy({ error: false });
    setup() {
      refs.boundary = this;
      trackLifecycle("Boundary");
      onError(() => (this.state.error = true));
    }
  }
  class Mid extends Component {
    static template = xml`<span t-out="this.state.v"/><Boundary/>`;
    static components = { Boundary };
    state = proxy({ v: 1 });
    setup() {
      refs.mid = this;
    }
  }
  class Root extends Component {
    static template = opts.mid
      ? xml`<section><Mid/></section>`
      : xml`<section><Boundary/></section>`;
    static components = { Boundary, Mid };
    setup() {
      trackLifecycle("Root");
    }
  }
  return { Root, refs, setups: () => n };
}

test("a child the recovery removed is set up again when shown, not revived destroyed", async () => {
  let boom = true;
  const { Root, refs, setups } = boundaryApp({ childThrows: () => boom });
  const root = await mount(Root, fixture);
  await nextTick();
  expect(fixture.innerHTML).toBe("<section><div>fallback</div></section>");
  boom = false;
  refs.boundary.state.error = false;
  await nextTick();
  expect(fixture.innerHTML).toBe("<section><div><p>child</p></div></section>");
  expect(setups()).toBe(2);
  expect(log).toContain("Child2:mounted");
  root.__owl__.app.destroy();
  expect(log.filter((l) => l === "Child1:willUnmount")).toEqual(["Child1:willUnmount"]);
  expect(log.filter((l) => l === "Child2:willUnmount")).toEqual(["Child2:willUnmount"]);
});

test("ancestors mounted by the recovery of a failed first mount keep their onWillUnmount", async () => {
  let boom = true;
  const { Root } = boundaryApp({
    childThrows: () => {
      const b = boom;
      boom = false;
      return b;
    },
  });
  const root = await mount(Root, fixture);
  await nextTick();
  log.length = 0;
  root.__owl__.app.destroy();
  expect(log).toContain("Root:willUnmount");
  expect(log).toContain("Boundary:willUnmount");
});

test("a component between the root and the recovering one keeps rendering after the recovery", async () => {
  const { Root, refs } = boundaryApp({ childThrows: () => true, mid: true });
  await mount(Root, fixture);
  await nextTick();
  expect(fixture.innerHTML).toBe("<section><span>1</span><div>fallback</div></section>");
  refs.mid.state.v = 2;
  await nextTick();
  expect(fixture.innerHTML).toBe("<section><span>2</span><div>fallback</div></section>");
  refs.mid.state.v = 3;
  await nextTick();
  expect(fixture.innerHTML).toBe("<section><span>3</span><div>fallback</div></section>");
});

test("an onError that destroys its root stops the onMounted of the components committed with it", async () => {
  class A extends Component {
    static template = xml`<a>a</a>`;
    setup() {
      onMounted(() => log.push(`A:mounted ${status(this)}`));
    }
  }
  class B extends Component {
    static template = xml`<b>b</b>`;
    setup() {
      onMounted(() => {
        throw new Error("boom");
      });
    }
  }
  let dialogRoot: any;
  class Dialog extends Component {
    static template = xml`<div><A/><B/></div>`;
    static components = { A, B };
    setup() {
      onError(() => dialogRoot.destroy());
    }
  }
  class Host extends Component {
    static template = xml`<main/>`;
  }
  const app = new App();
  await app.createRoot(Host).mount(fixture);
  dialogRoot = app.createRoot(Dialog);
  dialogRoot.mount(fixture);
  await nextTick();
  await nextTick();
  expect(log.filter((l) => l.endsWith("destroyed"))).toEqual([]);
  app.destroy();
});

test("a render delayed behind a pass that fails on its last pending render waits for the recovery", async () => {
  const late = makeDeferred();
  const bSeen: string[] = [];
  class C extends Component {
    static template = xml`<c><t t-out="this.check()"/></c>`;
    props = props();
    setup() {
      onWillUpdateProps(() => late);
    }
    check() {
      if (this.props.value === 2) {
        throw new Error("C fails");
      }
      return this.props.value;
    }
  }
  class B extends Component {
    static template = xml`<b><t t-out="this.read()"/></b>`;
    props = props();
    state = proxy({ value: 1 });
    read() {
      bSeen.push(`failed=${this.props.failed} v=${this.state.value}`);
      return this.state.value;
    }
  }
  class Parent extends Component {
    static template = xml`<div><C t-if="!this.state.failed" value="this.state.value"/><B failed="this.state.failed"/></div>`;
    static components = { C, B };
    state = proxy({ value: 1, failed: false });
    setup() {
      onError(() => (this.state.failed = true));
    }
  }
  const parent = await mount(Parent, fixture);
  const b = Object.values(parent.__owl__.children).find(
    (n: any) => n.component instanceof B
  ) as any;
  bSeen.length = 0;
  parent.state.value = 2;
  await nextMicroTick();
  b.component.state.value = 2;
  await nextMicroTick();
  late.resolve();
  await nextTick();
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><b>2</b></div>");
  expect(bSeen).toEqual(["failed=true v=2"]);
});

test("an onMounted owed since a failed commit runs once when a descendant's commit pays it first", async () => {
  let root: any, grandParent: any, child: any;
  let throws = true;
  class Failing extends Component {
    static template = xml`<x/>`;
    setup() {
      onMounted(() => {
        if (throws) {
          throws = false;
          throw new Error("x");
        }
      });
    }
  }
  class Child extends Component {
    static template = xml`<c t-out="this.state.v"/>`;
    state = proxy({ v: 0 });
    setup() {
      child = this;
      onPatched(() => log.push("Child:patched"));
    }
  }
  class GrandParent extends Component {
    static template = xml`<gp t-att-w="this.state.w"><Failing/><Child/></gp>`;
    static components = { Failing, Child };
    state = proxy({ w: 0 });
    setup() {
      grandParent = this;
      onMounted(() => log.push("GrandParent:mounted"));
      onPatched(() => log.push("GrandParent:patched"));
    }
  }
  class Root extends Component {
    static template = xml`<div><GrandParent t-if="this.state.on"/></div>`;
    static components = { GrandParent };
    state = proxy({ on: false });
    setup() {
      root = this;
      onError((e) => log.push(`caught ${e.message}`));
    }
  }
  await mount(Root, fixture);
  root.state.on = true;
  await nextTick();
  expect(log.splice(0)).toEqual(["caught x"]);
  child.state.v++;
  grandParent.state.w++;
  await nextTick();
  await nextTick();
  expect(fixture.innerHTML).toBe('<div><gp w="1"><x></x><c>1</c></gp></div>');
  expect(log).toEqual(["Child:patched", "GrandParent:mounted", "GrandParent:patched"]);
});

test("an onMounted owed since a failed commit runs, alone, when its parent's render reaches it", async () => {
  let root: any;
  let throws = true;
  class Failing extends Component {
    static template = xml`<x/>`;
    setup() {
      onMounted(() => {
        if (throws) {
          throws = false;
          throw new Error("x");
        }
      });
    }
  }
  class New extends Component {
    static template = xml`<n/>`;
    setup() {
      onMounted(() => log.push("New:mounted"));
    }
  }
  class GrandParent extends Component {
    static template = xml`<gp t-att-v="this.props.v"><Failing/></gp>`;
    static components = { Failing };
    props = props();
    setup() {
      onMounted(() => log.push("GrandParent:mounted"));
      onPatched(() => log.push("GrandParent:patched"));
    }
  }
  class Root extends Component {
    static template = xml`<div><New t-if="this.state.v > 1"/><GrandParent t-if="this.state.on" v="this.state.v"/></div>`;
    static components = { GrandParent, New };
    state = proxy({ on: false, v: 1 });
    setup() {
      root = this;
      onError((e) => log.push(`caught ${e.message}`));
    }
  }
  await mount(Root, fixture);
  root.state.on = true;
  await nextTick();
  expect(log.splice(0)).toEqual(["caught x"]);
  root.state.v = 2;
  await nextTick();
  await nextTick();
  expect(log).toEqual(["GrandParent:mounted", "New:mounted"]);
  expect(fixture.innerHTML).toBe('<div><n></n><gp v="2"><x></x></gp></div>');
});

test("an onMounted owed since a failed commit runs once when its parent renders it twice in one pass", async () => {
  let root: any;
  let throws = true;
  const slow = makeDeferred();
  class Failing extends Component {
    static template = xml`<x/>`;
    setup() {
      onMounted(() => {
        if (throws) {
          throws = false;
          throw new Error("x");
        }
      });
    }
  }
  class Slow extends Component {
    static template = xml`<s t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => slow);
    }
  }
  class GrandParent extends Component {
    static template = xml`<gp t-att-v="this.props.v"><Failing/></gp>`;
    static components = { Failing };
    props = props();
    setup() {
      onMounted(() => log.push("GrandParent:mounted"));
    }
  }
  class Root extends Component {
    static template = xml`<div><Slow v="this.state.v"/><GrandParent t-if="this.state.on" v="this.state.v"/></div>`;
    static components = { GrandParent, Slow };
    state = proxy({ on: false, v: 1 });
    setup() {
      root = this;
      onError((e) => log.push(`caught ${e.message}`));
    }
  }
  await mount(Root, fixture);
  root.state.on = true;
  await nextTick();
  expect(log.splice(0)).toEqual(["caught x"]);
  root.state.v = 2;
  await nextTick();
  root.state.v = 3;
  await nextTick();
  slow.resolve();
  await nextTick();
  await nextTick();
  expect(log).toEqual(["GrandParent:mounted"]);
  expect(fixture.innerHTML).toBe('<div><s>3</s><gp v="3"><x></x></gp></div>');
});

test("an onPatched owed since a failed commit, paid by a commit below, runs none of that component's onMounted", async () => {
  let child: any;
  let boom = true;
  class Child extends Component {
    static template = xml`<p><t t-out="this.props.n"/>-<t t-out="this.state.k"/></p>`;
    props = props();
    state = proxy({ k: 0 });
    setup() {
      child = this;
      onPatched(() => {
        if (boom) {
          boom = false;
          throw new Error("boom");
        }
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-out="this.state.n"/><Child n="this.state.n"/></div>`;
    static components = { Child };
    state = proxy({ n: 1 });
    setup() {
      onError((e) => log.push(`caught ${e.message}`));
      onMounted(() => log.push("Parent:mounted"));
      onPatched(() => log.push("Parent:patched"));
    }
  }
  const parent = await mount(Parent, fixture);
  expect(log.splice(0)).toEqual(["Parent:mounted"]);
  parent.state.n = 2;
  await nextTick();
  expect(log.splice(0)).toEqual(["caught boom"]);
  child.state.k = 1;
  await nextTick();
  expect(log.splice(0)).toEqual(["Parent:patched"]);
  child.state.k = 2;
  await nextTick();
  expect(log).toEqual([]);
});

test("an owed onMounted that throws when a descendant's commit pays it goes to the handlers above", async () => {
  let root: any, child: any;
  let failingCalls = 0;
  class Failing extends Component {
    static template = xml`<x/>`;
    setup() {
      onMounted(() => {
        if (failingCalls++ === 0) {
          throw new Error("x");
        }
      });
    }
  }
  class Child extends Component {
    static template = xml`<c t-out="this.state.v"/>`;
    state = proxy({ v: 0 });
    setup() {
      child = this;
    }
  }
  class GrandParent extends Component {
    static template = xml`<gp><Failing/><Child/></gp>`;
    static components = { Failing, Child };
    setup() {
      let calls = 0;
      onMounted(() => {
        log.push("GrandParent:mounted");
        if (calls++ === 0) {
          throw new Error("owed");
        }
      });
    }
  }
  class Root extends Component {
    static template = xml`<div><GrandParent t-if="this.state.on"/></div>`;
    static components = { GrandParent };
    state = proxy({ on: false });
    setup() {
      root = this;
      onError((e) => log.push(`caught ${e.message}`));
    }
  }
  await mount(Root, fixture);
  root.state.on = true;
  await nextTick();
  expect(log.splice(0)).toEqual(["caught x"]);
  child.state.v++;
  await nextTick();
  await nextTick();
  expect(log).toEqual(["GrandParent:mounted", "caught owed"]);
  expect(fixture.innerHTML).toBe("<div><gp><x></x><c>1</c></gp></div>");
});

test("a commit failed by an onWillPatch owes the onMounted of what it mounted, not of the components already mounted", async () => {
  let boom = true;
  class Child extends Component {
    static template = xml`<p t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillPatch(() => {
        if (boom) {
          boom = false;
          throw new Error("boom");
        }
      });
      trackLifecycle("Child");
    }
  }
  class New extends Component {
    static template = xml`<n/>`;
    setup() {
      onMounted(() => log.push("New:mounted"));
      onWillUnmount(() => log.push("New:willUnmount"));
    }
  }
  class Parent extends Component {
    static template = xml`<div><Child v="this.state.v"/><New t-if="this.state.v > 1"/></div>`;
    static components = { Child, New };
    state = proxy({ v: 1 });
    setup() {
      onMounted(() => log.push("Parent:mounted"));
      onWillUnmount(() => log.push("Parent:willUnmount"));
      onError((e) => log.push(e.message));
    }
  }
  const app = new App({ test: true });
  const parent = await app.createRoot(Parent).mount(fixture);
  expect(log.splice(0)).toEqual(["Child:mounted", "Parent:mounted"]);
  parent.state.v = 2;
  await nextTick();
  await nextTick();
  expect(log.splice(0)).toEqual(["boom"]);
  expect(fixture.innerHTML).toBe("<div><p>1</p></div>");
  parent.state.v = 3;
  await nextTick();
  await nextTick();
  expect(log.splice(0)).toEqual(["New:mounted"]);
  expect(fixture.innerHTML).toBe("<div><p>3</p><n></n></div>");
  app.destroy();
  expect(log).toEqual([
    "Parent:willUnmount",
    "Child:willUnmount",
    "Child:willDestroy",
    "New:willUnmount",
  ]);
});

test("an onMounted and an onPatched owed by one failed commit are both run by a commit below", async () => {
  let root: any, leaf: any;
  let throws = true;
  class Failing extends Component {
    static template = xml`<x/>`;
    setup() {
      onMounted(() => {
        if (throws) {
          throws = false;
          throw new Error("x");
        }
      });
    }
  }
  class Leaf extends Component {
    static template = xml`<l t-out="this.state.k"/>`;
    state = proxy({ k: 0 });
    setup() {
      leaf = this;
    }
  }
  class Mid extends Component {
    static template = xml`<m><Failing/><Leaf/></m>`;
    static components = { Failing, Leaf };
    setup() {
      onMounted(() => log.push("Mid:mounted"));
    }
  }
  class Root extends Component {
    static template = xml`<div t-att-v="this.state.v"><Mid t-if="this.state.v === 2"/></div>`;
    static components = { Mid };
    state = proxy({ v: 1 });
    setup() {
      root = this;
      onPatched(() => log.push("Root:patched"));
      onError((e) => log.push(`caught ${e.message}`));
    }
  }
  await mount(Root, fixture);
  root.state.v = 2;
  await nextTick();
  expect(log.splice(0)).toEqual(["caught x"]);
  leaf.state.k = 1;
  await nextTick();
  await nextTick();
  expect(log).toEqual(["Mid:mounted", "Root:patched"]);
  expect(fixture.innerHTML).toBe('<div v="2"><m><x></x><l>1</l></m></div>');
});

test("a root that handles its own render error by rendering again commits that render", async () => {
  let comp: any;
  class Root extends Component {
    static template = xml`<div t-out="this.read()"/>`;
    state = proxy({ v: 1, fixed: false });
    setup() {
      comp = this;
      trackLifecycle("Root");
      onPatched(() => log.push("Root:patched"));
      onError((e) => {
        log.push(`caught ${e.message}`);
        this.state.fixed = true;
      });
    }
    read() {
      if (this.state.v === 2 && !this.state.fixed) {
        throw new Error("render");
      }
      return this.state.v;
    }
  }
  await mount(Root, fixture);
  comp.state.v = 2;
  await nextTick();
  await nextTick();
  expect(log).toEqual(["Root:mounted", "caught render", "Root:patched"]);
  expect(fixture.innerHTML).toBe("<div>2</div>");
});

test("a removal error outside any patch is thrown by the removal", async () => {
  class Child extends Component {
    static template = xml`<p/>`;
    setup() {
      onWillUnmount(() => {
        throw new Error("unmount");
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><Child/></div>`;
    static components = { Child };
  }
  const parent = await mount(Parent, fixture);
  expect(() => blockDom.remove(parent.__owl__.bdom!, true)).toThrow("unmount");
});

describe("a pass failed by one component, handled without a re-render", () => {
  class A extends Component {
    static template = xml`<a><t t-out="this.props.v"/>-<t t-out="this.state.n"/></a>`;
    props = props();
    state = proxy({ n: 0 });
  }
  class Bad extends Component {
    static template = xml`<b t-out="this.props.v > 1 ? this.boom.x : 'ok'"/>`;
    props = props();
  }
  class Parent extends Component {
    static template = xml`<div><A v="this.state.v"/><Bad v="this.state.v"/></div>`;
    static components = { A, Bad };
    state = proxy({ v: 1 });
    setup() {
      onError((e) => log.push(e.message.slice(0, 30)));
    }
  }

  test("a sibling updated in that pass still renders on its own", async () => {
    const parent = await mount(Parent, fixture);
    const a = Object.values(parent.__owl__.children)[0].component as A;
    parent.state.v = 2;
    await nextTick();
    expect(log.length).toBe(1);
    a.state.n = 7;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>2-7</a><b>ok</b></div>");
  });

  test("a commit failed by an onWillPatch leaves no task behind, and the next render commits", async () => {
    let boom = true;
    class Child extends Component {
      static template = xml`<p t-out="this.props.v"/>`;
      props = props();
      setup() {
        onWillPatch(() => {
          if (boom) {
            boom = false;
            throw new Error("boom");
          }
        });
      }
    }
    class Parent extends Component {
      static template = xml`<div><Child v="this.state.v"/></div>`;
      static components = { Child };
      state = proxy({ v: 1 });
      setup() {
        onError((e) => log.push(e.message));
      }
    }
    const app = new App({ test: true });
    const parent = await app.createRoot(Parent).mount(fixture);
    parent.state.v = 2;
    await nextTick();
    await nextTick();
    expect(log).toEqual(["boom"]);
    expect(fixture.innerHTML).toBe("<div><p>1</p></div>");
    expect(app.scheduler.tasks.size).toBe(0);
    parent.state.v = 3;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>3</p></div>");
    app.destroy();
  });

  test("a component that pass left out, rendering on its own meanwhile, renders once the pass is dropped", async () => {
    let boom = true;
    class Child extends Component {
      static template = xml`<p t-out="this.props.v"/>`;
      props = props();
      setup() {
        onWillPatch(() => {
          if (boom) {
            boom = false;
            throw new Error("boom");
          }
        });
      }
    }
    class Item extends Component {
      static template = xml`<i><t t-out="this.props.id"/>-<t t-out="this.state.n"/></i>`;
      props = props();
      state = proxy({ n: 0 });
    }
    class Parent extends Component {
      static template = xml`<div><Child v="this.state.v"/><t t-foreach="this.state.items" t-as="id" t-key="id"><Item id="id"/></t></div>`;
      static components = { Child, Item };
      state = proxy({ v: 1, items: [1, 2] });
      setup() {
        onError((e) => log.push(e.message));
      }
    }
    const loading = makeDeferred();
    class Loading extends Component {
      static template = xml`<span>loaded</span>`;
      setup() {
        onWillStart(() => loading);
      }
    }
    const app = new App({ test: true });
    const parent = await app.createRoot(Parent).mount(fixture);
    const second = Object.values(parent.__owl__.children)[2].component as Item;
    app.createRoot(Loading).mount(fixture);
    parent.state.v = 2;
    parent.state.items.pop();
    await nextMicroTick();
    await nextMicroTick();
    second.state.n = 1;
    await nextTick();
    await nextTick();
    expect(log).toEqual(["boom"]);
    expect(fixture.innerHTML).toBe("<div><p>1</p><i>1-0</i><i>2-1</i></div>");
    second.state.n = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>1</p><i>1-0</i><i>2-2</i></div>");
    loading.resolve();
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>1</p><i>1-0</i><i>2-2</i></div><span>loaded</span>");
    expect(app.scheduler.tasks.size).toBe(0);
    app.destroy();
  });

  test("a component the pass created, never mounted, waits for the pass instead of committing alone", async () => {
    const shared = proxy({ n: 1 });
    class C extends Component {
      static template = xml`<c t-out="this.shared.n"/>`;
      shared = shared;
    }
    class Parent extends Component {
      static template = xml`<div><t t-if="this.state.on"><C/><Bad v="2"/></t></div>`;
      static components = { C, Bad };
      state = proxy({ on: false });
      setup() {
        onError((e) => log.push(e.message.slice(0, 30)));
      }
    }
    const parent = await mount(Parent, fixture);
    parent.state.on = true;
    await nextTick();
    shared.n = 2;
    await nextTick();
    await nextTick();
    expect(log.length).toBe(1);
    expect(fixture.innerHTML).toBe("<div></div>");
    parent.state.on = false;
    await nextTick();
    shared.n = 3;
    await nextTick();
    expect(log.length).toBe(1);
  });

  test("a component rendering alone cancels the children it had in the pass once", async () => {
    const pending: ReturnType<typeof makeDeferred>[] = [];
    let setups = 0;
    class D extends Component {
      static template = xml`<d/>`;
      setup() {
        const id = ++setups;
        const loaded = makeDeferred();
        pending.push(loaded);
        onWillStart(() => loaded);
        onWillDestroy(() => log.push(`D${id}:willDestroy`));
      }
    }
    class C extends Component {
      static template = xml`<c><t t-out="this.props.v"/>-<t t-out="this.state.n"/><D t-if="this.props.v === 2"/></c>`;
      static components = { D };
      props = props();
      state = proxy({ n: 0 });
    }
    class Parent extends Component {
      static template = xml`<div><C v="this.state.v"/><Bad v="this.state.ok ? 1 : this.state.v"/></div>`;
      static components = { C, Bad };
      state = proxy({ v: 1, ok: false });
      setup() {
        onError((e) => log.push(e.message.slice(0, 30)));
      }
    }
    const parent = await mount(Parent, fixture);
    const c = Object.values(parent.__owl__.children)[0].component as C;
    parent.state.v = 2;
    await nextTick();
    c.state.n = 1;
    await nextTick();
    parent.state.ok = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><c>1-0</c><b>ok</b></div>");
    for (const loaded of pending) {
      loaded.resolve();
    }
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><c>2-1<d></d></c><b>ok</b></div>");
    expect(log.slice(1)).toEqual(["D1:willDestroy", "D2:willDestroy"]);
    parent.__owl__.app.destroy();
    expect(setups).toBe(3);
    expect(log.slice(1)).toEqual(["D1:willDestroy", "D2:willDestroy", "D3:willDestroy"]);
  });

  test.each([
    ["after", false],
    ["before", true],
  ])(
    "a render it asks for while its onWillUpdateProps waits, %s the pass failed, renders on its own",
    async (_, failLate) => {
      const updated = makeDeferred();
      const badUpdated = makeDeferred();
      class Waiting extends Component {
        static template = xml`<a><t t-out="this.props.v"/>-<t t-out="this.state.n"/></a>`;
        props = props();
        state = proxy({ n: 0 });
        setup() {
          onWillUpdateProps(() => updated);
        }
      }
      class LateBad extends Bad {
        setup() {
          if (failLate) {
            onWillUpdateProps(() => badUpdated);
          }
        }
      }
      class Parent extends Component {
        static template = xml`<div><Waiting v="this.state.v"/><LateBad v="this.state.v"/></div>`;
        static components = { Waiting, LateBad };
        state = proxy({ v: 1 });
        setup() {
          onError((e) => log.push(e.message.slice(0, 30)));
        }
      }
      const parent = await mount(Parent, fixture);
      const waiting = Object.values(parent.__owl__.children)[0].component as Waiting;
      parent.state.v = 2;
      await nextTick();
      waiting.state.n = 7;
      await nextTick();
      updated.resolve();
      await nextTick();
      badUpdated.resolve();
      await nextTick();
      await nextTick();
      expect(log.length).toBe(1);
      expect(fixture.innerHTML).toBe("<div><a>2-7</a><b>ok</b></div>");
    }
  );

  test("its own renders do not add up to a render loop", async () => {
    const parent = await mount(Parent, fixture);
    const a = Object.values(parent.__owl__.children)[0].component as A;
    parent.state.v = 2;
    await nextTick();
    for (let i = 1; i <= 1005; i++) {
      a.state.n = i;
      await nextMicroTick();
      await nextMicroTick();
      await nextMicroTick();
      if (i % 100 === 0) {
        await nextTick();
      }
    }
    await nextTick();
    expect(log.length).toBe(1);
    expect(fixture.innerHTML).toBe("<div><a>2-1005</a><b>ok</b></div>");
  });
});

test("an onWillUnmount error of a patch is reported before the onMounted of what it mounted", async () => {
  let throwOnce = true;
  class A extends Component {
    static template = xml`<a/>`;
    setup() {
      trackLifecycle("A");
    }
  }
  class B extends Component {
    static template = xml`<b/>`;
    setup() {
      onWillUnmount(() => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("B willUnmount");
        }
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-if="this.state.on"><A/></t><t t-if="!this.state.on"><B/></t><t t-out="this.state.n"/></div>`;
    static components = { A, B };
    state = proxy({ on: false, n: 0 });
    setup() {
      onError((e) => {
        log.push(`caught ${e.message}`);
        this.state.n++;
      });
    }
  }
  const parent = await mount(Parent, fixture);
  parent.state.on = true;
  await nextTick();
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><a></a>1</div>");
  parent.state.on = false;
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><b></b>1</div>");
  expect(log).toEqual(["caught B willUnmount", "A:mounted", "A:willUnmount", "A:willDestroy"]);
});

test("an onMounted error does not drop a render of its component requested earlier in the commit", async () => {
  let x: any;
  class X extends Component {
    static template = xml`<x t-out="this.state.n"/>`;
    state = proxy({ n: 0 });
    setup() {
      x = this;
      onMounted(() => {
        throw new Error("X mounted");
      });
    }
  }
  class Y extends Component {
    static template = xml`<y/>`;
    setup() {
      onMounted(() => {
        x.state.n = 1;
        x.__owl__.render(false);
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-if="this.state.show"><X/><Y/></t></div>`;
    static components = { X, Y };
    state = proxy({ show: false });
    setup() {
      onError((e) => log.push(e.message));
    }
  }
  const parent = await mount(Parent, fixture);
  parent.state.show = true;
  await nextTick();
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><x>1</x><y></y></div>");
  x.state.n = 2;
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><x>2</x><y></y></div>");
  expect(log).toEqual(["X mounted"]);
});

test("after an onPatched error handled without a re-render, a later commit below runs the owed onPatched", async () => {
  let child: any;
  let boom = true;
  class Child extends Component {
    static template = xml`<p><t t-out="this.props.n"/>-<t t-out="this.state.k"/></p>`;
    props = props();
    state = proxy({ k: 0 });
    setup() {
      child = this;
      onWillPatch(() => log.push("Child:willPatch"));
      onPatched(() => {
        log.push("Child:patched");
        if (boom) {
          boom = false;
          throw new Error("boom");
        }
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-out="this.state.n"/><Child n="this.state.n"/></div>`;
    static components = { Child };
    state = proxy({ n: 1 });
    setup() {
      onError((e) => log.push(`caught ${e.message}`));
      onWillPatch(() => log.push("Parent:willPatch"));
      onPatched(() => log.push("Parent:patched"));
    }
  }
  const parent = await mount(Parent, fixture);
  parent.state.n = 2;
  await nextTick();
  expect(log.splice(0)).toEqual([
    "Parent:willPatch",
    "Child:willPatch",
    "Child:patched",
    "caught boom",
  ]);
  child.state.k = 1;
  await nextTick();
  expect(fixture.innerHTML).toBe("<div>2<p>2-1</p></div>");
  expect(log.splice(0)).toEqual(["Child:willPatch", "Child:patched", "Parent:patched"]);
  parent.state.n = 3;
  await nextTick();
  expect(log).toEqual(["Parent:willPatch", "Child:willPatch", "Child:patched", "Parent:patched"]);
});

test("a component that commits on its own after its onPatched error is not rendered again by an unchanged parent", async () => {
  let boom = false;
  class Child extends Component {
    static template = xml`<p><t t-out="this.props.v"/>-<t t-out="this.state.n"/></p>`;
    props = props();
    state = proxy({ n: 0 });
    setup() {
      onPatched(() => {
        if (boom) {
          boom = false;
          throw new Error("patched");
        }
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-out="this.state.x"/><Child v="1"/><t t-foreach="[1]" t-as="i" t-key="i" t-memo="[]"><Child v="2"/></t></div>`;
    static components = { Child };
    state = proxy({ x: 0 });
    setup() {
      onError((e) => log.push(e.message));
    }
  }
  const parent = await mount(Parent, fixture);
  const children = Object.values(parent.__owl__.children).map((n) => n.component as Child);
  for (const child of children) {
    boom = true;
    child.state.n = 1;
    await nextTick();
  }
  expect(log).toEqual(["patched", "patched"]);
  for (const child of children) {
    child.state.n = 2;
  }
  await nextTick();
  expect(fixture.innerHTML).toBe("<div>0<p>1-2</p><p>2-2</p></div>");
  const renders: string[] = [];
  for (const child of children) {
    const node = child.__owl__;
    const render = node.renderFn;
    node.renderFn = () => {
      renders.push(`Child ${child.props.v}`);
      return render();
    };
  }
  parent.state.x = 1;
  await nextTick();
  expect(fixture.innerHTML).toBe("<div>1<p>1-2</p><p>2-2</p></div>");
  expect(renders).toEqual([]);
});

test("an onWillUnmount error does not stop the patch removing its component", async () => {
  class Child extends Component {
    static template = xml`<i>child</i>`;
    setup() {
      onWillUnmount(() => {
        throw new Error("Child willUnmount");
      });
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-if="this.state.on"><Child/></t><span t-out="this.state.n"/></div>`;
    static components = { Child };
    state = proxy({ on: true, n: 1 });
    setup() {
      onError((e) => log.push(`caught ${e.message}`));
      onPatched(() => log.push("Parent:patched"));
    }
  }
  const parent = await mount(Parent, fixture);
  parent.state.on = false;
  parent.state.n = 2;
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><span>2</span></div>");
  expect(log).toEqual(["caught Child willUnmount", "Parent:patched"]);
});

describe("a first mount that throws half way", () => {
  function throwingRef(state: { boom: boolean }) {
    return {
      set: (el: HTMLElement | null) => {
        if (state.boom && el) {
          state.boom = false;
          throw new Error("ref");
        }
      },
    };
  }

  test("is taken out of the target before the error handler runs", async () => {
    const state = { boom: true };
    const seen: string[] = [];
    class Child extends Component {
      static template = xml`<p t-ref="this.ref">child</p>`;
      ref = throwingRef(state);
    }
    class Root extends Component {
      static template = xml`<div><Child/></div>`;
      static components = { Child };
      setup() {
        onError(() => seen.push(fixture.innerHTML));
      }
    }
    mount(Root, fixture);
    await nextTick();
    await nextTick();
    expect(seen).toEqual([""]);
  });

  test("is mounted afresh by the recovery, its children set up again", async () => {
    const state = { boom: true };
    class Leaf extends Component {
      static template = xml`<i t-out="this.props.n"/>`;
      props = props();
      setup() {
        trackLifecycle("Leaf");
        onWillPatch(() => log.push("Leaf:willPatch"));
        onPatched(() => log.push("Leaf:patched"));
      }
    }
    class Child extends Component {
      static template = xml`<p t-ref="this.ref"><Leaf n="this.props.n"/></p>`;
      static components = { Leaf };
      props = props();
      ref = throwingRef(state);
      setup() {
        trackLifecycle("Child");
      }
    }
    class Root extends Component {
      static template = xml`<div><Child n="this.state.n"/></div>`;
      static components = { Child };
      state = proxy({ n: 1 });
      setup() {
        trackLifecycle("Root");
        onError((e) => {
          log.push(`caught ${e.message}`);
          this.state.n = 2;
        });
      }
    }
    const root = await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div><p><i>2</i></p></div>");
    expect(log.splice(0)).toEqual([
      "caught ref",
      "Leaf:willDestroy",
      "Child:willDestroy",
      "Leaf:mounted",
      "Child:mounted",
      "Root:mounted",
    ]);
    root.__owl__.app.destroy();
    expect(log).toEqual([
      "Root:willUnmount",
      "Child:willUnmount",
      "Leaf:willUnmount",
      "Leaf:willDestroy",
      "Child:willDestroy",
      "Root:willDestroy",
    ]);
  });

  test("leaves none of the nodes it inserted in the target", async () => {
    const state = { boom: true };
    class Root extends Component {
      static template = xml`<a/><b t-ref="this.ref" t-out="this.state.n"/><c/>`;
      state = proxy({ n: 1 });
      ref = throwingRef(state);
      setup() {
        onError(() => (this.state.n = 2));
      }
    }
    fixture.innerHTML = "<hr/>";
    await mount(Root, fixture, { position: "first-child" });
    expect(fixture.innerHTML).toBe("<a></a><b>2</b><c></c><hr>");
  });

  test("leaves what the target held before it, mounting last", async () => {
    const state = { boom: true };
    class Root extends Component {
      static template = xml`<a/><b t-ref="this.ref" t-out="this.state.n"/><c/>`;
      state = proxy({ n: 1 });
      ref = throwingRef(state);
      setup() {
        onError(() => (this.state.n = 2));
      }
    }
    fixture.innerHTML = "<hr/>";
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<hr><a></a><b>2</b><c></c>");
  });

  test("runs no onWillUnmount of the children it rolled back, and one that would throw does not stop it", async () => {
    const state = { boom: true };
    class Child extends Component {
      static template = xml`<p>c</p>`;
      setup() {
        onWillUnmount(() => {
          log.push("Child:willUnmount");
          throw new Error("unmount");
        });
        onWillDestroy(() => log.push("Child:willDestroy"));
      }
    }
    class Other extends Component {
      static template = xml`<p>o</p>`;
      setup() {
        onWillDestroy(() => log.push("Other:willDestroy"));
      }
    }
    class Root extends Component {
      static template = xml`<div t-ref="this.ref" t-att-n="this.state.n"><Child/><Other/></div>`;
      static components = { Child, Other };
      ref = throwingRef(state);
      state = proxy({ n: 1 });
      setup() {
        onError((e) => {
          log.push(`caught ${e.message}`);
          this.state.n = 2;
        });
      }
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe('<div n="2"><p>c</p><p>o</p></div>');
    expect(log).toEqual(["caught ref", "Child:willDestroy", "Other:willDestroy"]);
  });

  test("runs no onWillUnmount of the grandchildren it rolled back either", async () => {
    const state = { boom: true };
    class GrandChild extends Component {
      static template = xml`<i>g</i>`;
      setup() {
        trackLifecycle("GrandChild");
      }
    }
    class Child extends Component {
      static template = xml`<p><GrandChild/></p>`;
      static components = { GrandChild };
    }
    class Root extends Component {
      static template = xml`<div t-ref="this.ref" t-att-n="this.state.n"><Child t-if="this.state.n === 1"/></div>`;
      static components = { Child };
      ref = throwingRef(state);
      state = proxy({ n: 1 });
      setup() {
        onError((e) => {
          log.push(`caught ${e.message}`);
          this.state.n = 2;
        });
      }
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe('<div n="2"></div>');
    expect(log).toEqual(["caught ref", "GrandChild:willDestroy"]);
  });

  test("reports a ref that also throws when unset, after its own error", async () => {
    class Root extends Component {
      static template = xml`<div t-ref="this.ref"/>`;
      ref = {
        set: (el: HTMLElement | null) => {
          throw new Error(el ? "ref" : "unset");
        },
      };
      setup() {
        onError((e) => log.push(`caught ${e.message}`));
      }
    }
    mount(Root, fixture);
    await nextTick();
    await nextTick();
    expect(log).toEqual(["caught ref", "caught unset"]);
    expect(fixture.innerHTML).toBe("");
  });

  test("logs a ref that also throws when unset once nothing handles its own error", async () => {
    class Root extends Component {
      static template = xml`<div t-ref="this.ref"/>`;
      ref = {
        set: (el: HTMLElement | null) => {
          throw new Error(el ? "ref" : "unset");
        },
      };
    }
    await expect(mount(Root, fixture)).rejects.toThrow("ref");
    expect(getConsoleOutput()).toEqual(["error:Error: unset"]);
  });

  test("sends the children and grandchildren it mounted back to unmounted when nothing renders again", async () => {
    const state = { boom: true };
    let child: any, grandChild: any;
    class GrandChild extends Component {
      static template = xml`<i>g</i>`;
      setup() {
        grandChild = this;
      }
    }
    class Child extends Component {
      static template = xml`<p><GrandChild/></p>`;
      static components = { GrandChild };
      setup() {
        child = this;
      }
    }
    class Root extends Component {
      static template = xml`<div t-ref="this.ref"><Child/></div>`;
      static components = { Child };
      ref = throwingRef(state);
      setup() {
        onError((e) => log.push(`caught ${e.message}`));
      }
    }
    mount(Root, fixture);
    await nextTick();
    await nextTick();
    expect(log).toEqual(["caught ref"]);
    expect(fixture.innerHTML).toBe("");
    expect([status(child), status(grandChild)]).toEqual(["new", "new"]);
  });

  test("rejects with its own error when nothing handles it, though a child's onWillDestroy throws", async () => {
    const state = { boom: true };
    class Child extends Component {
      static template = xml`<p>c</p>`;
      setup() {
        onWillDestroy(() => {
          log.push("Child:willDestroy");
          throw new Error("destroy");
        });
      }
    }
    class Root extends Component {
      static template = xml`<div t-ref="this.ref"><Child/></div>`;
      static components = { Child };
      ref = throwingRef(state);
    }
    await expect(mount(Root, fixture)).rejects.toThrow("ref");
    expect(fixture.innerHTML).toBe("");
    expect(log).toEqual(["Child:willDestroy"]);
  });

  test("unsets a ref it set before the throw", async () => {
    const state = { boom: true };
    class Child extends Component {
      static template = xml`<p t-ref="this.ref"/>`;
      ref = throwingRef(state);
    }
    let root: any;
    class Root extends Component {
      static template = xml`<div t-att-n="this.state.n"><span t-if="this.state.show" t-ref="this.span"/><Child/></div>`;
      static components = { Child };
      span = signal<HTMLElement | null>(null);
      state = proxy({ n: 1, show: true });
      setup() {
        root = this;
        onError(() => {
          this.state.n = 2;
          this.state.show = false;
        });
      }
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe('<div n="2"><p></p></div>');
    expect(root.span()).toBe(null);
  });
});
