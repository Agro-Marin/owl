import {
  App,
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
  status,
  xml,
} from "../../src";
import { makeDeferred, makeTestFixture, nextMicroTick, nextTick } from "../helpers";

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
});
