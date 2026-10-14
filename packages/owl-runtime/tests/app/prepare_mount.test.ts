import {
  App,
  Component,
  onMounted,
  onWillDestroy,
  onWillStart,
  proxy,
  status,
  xml,
} from "../../src";
import { makeDeferred, makeTestFixture, nextTick } from "../helpers";

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

test("prepare() kicks off willStart before mount is called", async () => {
  const steps: string[] = [];
  const rpc = makeDeferred<string>();

  class Root extends Component {
    static template = xml`<span t-out="this.data"/>`;
    data = "";
    setup() {
      onWillStart(async () => {
        steps.push("willStart:start");
        this.data = await rpc;
        steps.push("willStart:end");
      });
      onMounted(() => steps.push("mounted"));
    }
  }

  const app = new App();
  const root = app.createRoot(Root);
  const prepared = root.prepare();

  await nextTick();
  expect(steps).toEqual(["willStart:start"]);
  expect(fixture.innerHTML).toBe("");

  rpc.resolve("hello");
  await prepared;
  expect(steps).toEqual(["willStart:start", "willStart:end"]);
  expect(fixture.innerHTML).toBe("");

  await root.mount(fixture);
  expect(steps).toEqual(["willStart:start", "willStart:end", "mounted"]);
  expect(fixture.innerHTML).toBe("<span>hello</span>");
  app.destroy();
});

test("prepare() is idempotent", async () => {
  class Root extends Component {
    static template = xml`<span>ok</span>`;
  }

  const app = new App();
  const root = app.createRoot(Root);
  const p1 = root.prepare();
  const p2 = root.prepare();
  expect(p1).toBe(p2);
  await p1;
  await root.mount(fixture);
  expect(fixture.innerHTML).toBe("<span>ok</span>");
  app.destroy();
});

test("mount() without prior prepare() prepares internally", async () => {
  class Root extends Component {
    static template = xml`<span>ok</span>`;
  }

  const app = new App();
  const root = app.createRoot(Root);
  await root.mount(fixture);
  expect(fixture.innerHTML).toBe("<span>ok</span>");
  app.destroy();
});

test("destroy() without mount() cleans up the prepared fiber", async () => {
  let destroyed = false;

  class Root extends Component {
    static template = xml`<span>ok</span>`;
    setup() {
      this.__owl__.onDestroy(() => {
        destroyed = true;
      });
    }
  }

  const app = new App();
  const root = app.createRoot(Root);
  await root.prepare();
  root.destroy();
  expect(destroyed).toBe(true);
  app.destroy();
});

test("mount() validates the target, prepare() does not", async () => {
  class Root extends Component {
    static template = xml`<span>ok</span>`;
  }

  const app = new App();
  const root = app.createRoot(Root);
  await root.prepare();
  const detached = document.createElement("div");
  expect(() => root.mount(detached)).toThrow(/detached/);
  app.destroy();
});

test("prepare-then-mount renders in parallel with another root", async () => {
  const order: string[] = [];
  const aRpc = makeDeferred<string>();
  const bRpc = makeDeferred<string>();

  class A extends Component {
    static template = xml`<span class="a"/>`;
    setup() {
      onWillStart(async () => {
        order.push("a:start");
        await aRpc;
        order.push("a:end");
      });
    }
  }

  class B extends Component {
    static template = xml`<span class="b"/>`;
    setup() {
      onWillStart(async () => {
        order.push("b:start");
        await bRpc;
        order.push("b:end");
      });
    }
  }

  const app = new App();
  const rootA = app.createRoot(A);
  const rootB = app.createRoot(B);
  rootA.prepare();
  rootB.prepare();
  await nextTick();
  expect(order).toEqual(["a:start", "b:start"]);

  bRpc.resolve("b");
  await nextTick();
  await nextTick();
  expect(order).toContain("b:end");

  aRpc.resolve("a");
  await nextTick();
  await nextTick();
  expect(order).toContain("a:end");
  app.destroy();
});

test("mount() after destroy() is a no-op", async () => {
  const steps: string[] = [];

  class Root extends Component {
    static template = xml`<span>ok</span>`;
    setup() {
      onMounted(() => steps.push("mounted"));
      onWillDestroy(() => steps.push("willDestroy"));
    }
  }

  const app = new App();
  const root = app.createRoot(Root);
  await root.prepare();
  root.destroy();
  expect(root.destroyed).toBe(true);

  let mounted = false;
  root.mount(fixture).then(() => (mounted = true));
  await nextTick();
  expect(steps).toEqual(["willDestroy"]);
  expect(fixture.innerHTML).toBe("");
  expect(mounted).toBe(false);
  app.destroy();
});

test("mount() after destroy() does not validate the target", async () => {
  class Root extends Component {
    static template = xml`<span>ok</span>`;
  }

  const app = new App();
  const root = app.createRoot(Root);
  await root.prepare();
  root.destroy();
  const detached = document.createElement("div");
  expect(() => root.mount(detached)).not.toThrow();
  app.destroy();
});

test("destroy() while the render phase is pending resolves prepare()", async () => {
  const steps: string[] = [];
  const rpc = makeDeferred<string>();

  class Root extends Component {
    static template = xml`<span t-out="this.data"/>`;
    data = "";
    setup() {
      onWillStart(async () => {
        this.data = await rpc;
        steps.push("willStart:end");
      });
      onMounted(() => steps.push("mounted"));
    }
  }

  const app = new App();
  const root = app.createRoot(Root);
  const prepared = root.prepare();
  await nextTick();

  root.destroy();
  rpc.resolve("hello");
  await prepared;

  root.mount(fixture);
  await nextTick();
  expect(steps).toEqual(["willStart:end"]);
  expect(fixture.innerHTML).toBe("");
  app.destroy();
});

test("prepare() after destroy() does not start a render", async () => {
  const steps: string[] = [];

  class Root extends Component {
    static template = xml`<span>ok</span>`;
    setup() {
      onWillStart(() => steps.push("willStart"));
    }
  }

  const app = new App();
  const root = app.createRoot(Root);
  root.destroy();

  const p1 = root.prepare();
  const p2 = root.prepare();
  expect(p1).toBe(p2);
  await p1;
  expect(steps).toEqual([]);
  expect(root.prepared).toBe(false);
  app.destroy();
});

test("destroy() is idempotent and keeps the component destroyed", async () => {
  const steps: string[] = [];

  class Root extends Component {
    static template = xml`<span>ok</span>`;
    setup() {
      onWillDestroy(() => steps.push("willDestroy"));
    }
  }

  const app = new App();
  const root = app.createRoot(Root);
  const component = await root.mount(fixture);
  expect(fixture.innerHTML).toBe("<span>ok</span>");

  root.destroy();
  root.destroy();
  expect(steps).toEqual(["willDestroy"]);
  expect(fixture.innerHTML).toBe("");
  expect(status(component)).toBe("destroyed");

  root.mount(fixture);
  await nextTick();
  expect(fixture.innerHTML).toBe("");
  expect(status(component)).toBe("destroyed");
  app.destroy();
});

test("mounting a root a second time throws, while pending or once mounted", async () => {
  class Root extends Component {
    static template = xml`<span>root</span>`;
  }
  const other = document.createElement("div");
  fixture.appendChild(other);
  const app = new App();
  const root = app.createRoot(Root);
  const promise = root.mount(fixture);
  expect(() => root.mount(other)).toThrow("already mounted");
  await promise;
  expect(() => root.mount(other)).toThrow("already mounted");
  expect(fixture.innerHTML).toBe("<div></div><span>root</span>");
  expect(other.innerHTML).toBe("");
  app.destroy();
});

test("mount() during a re-render of the prepared root waits for that render", async () => {
  const late = makeDeferred();
  class Late extends Component {
    static template = xml`<i>late</i>`;
    setup() {
      onWillStart(() => late);
    }
  }
  let component: Root;
  class Root extends Component {
    static template = xml`<div><t t-out="this.state.value"/><Late t-if="this.state.value === 2"/></div>`;
    static components = { Late };
    state = proxy({ value: 1 });
    setup() {
      component = this;
    }
  }

  const app = new App({ test: true });
  const root = app.createRoot(Root);
  await root.prepare();
  component!.state.value = 2;
  await nextTick();
  const mounted = root.mount(fixture);
  await nextTick();
  expect(fixture.innerHTML).toBe("");
  expect(app.destroyed).toBe(false);

  late.resolve();
  expect(await mounted).toBe(component!);
  expect(fixture.innerHTML).toBe("<div>2<i>late</i></div>");
  app.destroy();
});
