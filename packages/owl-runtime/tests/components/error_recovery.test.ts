import {
  App,
  Component,
  mount,
  onError,
  onMounted,
  onWillDestroy,
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

// a boundary whose child's onMounted throws during the first mount
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
  // B renders once, in the recovered pass, never with the props of the failed one
  expect(bSeen).toEqual(["failed=true v=2"]);
});
