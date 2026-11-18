import {
  App,
  Component,
  onError,
  onMounted,
  onWillDestroy,
  onWillPatch,
  onWillStart,
  onWillUpdateProps,
  props,
  proxy,
  signal,
  xml,
} from "../../src";
import { createSubRoot } from "../../src/app";
import { status } from "../../src/status";
import { makeDeferred, makeTestFixture, nextTick, snapshotEverything } from "../helpers";

let fixture: HTMLElement;

snapshotEverything();

beforeEach(() => {
  fixture = makeTestFixture();
});

class SomeComponent extends Component {
  static template = xml`<div>main app</div>`;
}

class SubComponent extends Component {
  static template = xml`<div>sub root</div>`;
}

describe("subroot", () => {
  test("can mount subroot", async () => {
    const app = new App();
    const comp = await app.createRoot(SomeComponent).mount(fixture);
    expect(fixture.innerHTML).toBe("<div>main app</div>");
    const subRoot = app.createRoot(SubComponent);
    const subcomp = await subRoot.mount(fixture);
    expect(fixture.innerHTML).toBe("<div>main app</div><div>sub root</div>");

    app.destroy();
    expect(fixture.innerHTML).toBe("");
    expect(status(comp)).toBe("destroyed");
    expect(status(subcomp)).toBe("destroyed");
  });

  test("can mount subroot inside own dom", async () => {
    const app = new App();
    const comp = await app.createRoot(SomeComponent).mount(fixture);
    expect(fixture.innerHTML).toBe("<div>main app</div>");
    const subRoot = app.createRoot(SubComponent);
    const subcomp = await subRoot.mount(fixture.querySelector("div")!);
    expect(fixture.innerHTML).toBe("<div>main app<div>sub root</div></div>");

    app.destroy();
    expect(fixture.innerHTML).toBe("");
    expect(status(comp)).toBe("destroyed");
    expect(status(subcomp)).toBe("destroyed");
  });

  test("subcomponents can be destroyed, and it properly cleanup the subroots", async () => {
    const app = new App();
    const comp = await app.createRoot(SomeComponent).mount(fixture);
    expect(fixture.innerHTML).toBe("<div>main app</div>");
    const root = app.createRoot(SubComponent);
    const subcomp = await root.mount(fixture.querySelector("div")!);
    expect(fixture.innerHTML).toBe("<div>main app<div>sub root</div></div>");

    root.destroy();
    expect(fixture.innerHTML).toBe("<div>main app</div>");
    expect(status(comp)).not.toBe("destroyed");
    expect(status(subcomp)).toBe("destroyed");
  });

  test("can create a root in a setup function, then use a hook", async () => {
    class C extends Component {
      static template = xml`c`;
    }

    class A extends Component {
      static template = xml`a`;
      state: any;
      setup() {
        app.createRoot(C);
        this.state = proxy({ value: 1 });
      }
    }

    const app = new App();
    await app.createRoot(A).mount(fixture);
    expect(fixture.innerHTML).toBe("a");
  });
});

test("destroy a subroot while another component is mounted in main app", async () => {
  class C extends Component {
    static template = xml`c`;
  }

  class ChildA extends Component {
    static template = xml`a<div t-ref="this.ref"></div>`;
    ref = signal<any>(null);
    setup() {
      let root = app.createRoot(C);
      onMounted(() => {
        root.mount(this.ref());
      });
      onWillDestroy(() => {
        root.destroy();
      });
    }
  }
  class ChildB extends Component {
    static template = xml`b`;
  }

  class SomeComponent extends Component {
    static template = xml`
        <t t-if="this.state.flag"><ChildB/></t>
        <t t-else=""><ChildA/></t>
        `;
    static components = { ChildA, ChildB };
    state = proxy({ flag: false });
  }

  const app = new App();
  const comp = await app.createRoot(SomeComponent).mount(fixture);
  expect(fixture.innerHTML).toBe("a<div>c</div>");
  comp.state.flag = true;
  await nextTick();
  expect(fixture.innerHTML).toBe("b");
});

test("a deep render of the host renders its mounted sub-roots again", async () => {
  const plain = { label: "a" };
  class Dialog extends Component {
    static template = xml`<p t-out="this.plain.label"/>`;
    plain = plain;
  }
  class Host extends Component {
    static template = xml`<div/>`;
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  plain.label = "b";
  host.__owl__.render(true);
  await nextTick();
  expect(fixture.innerHTML).toBe("<div></div><p>b</p>");
  app.destroy();
});

test("a deep render of the host that fails does not render its sub-roots", async () => {
  const plain = { label: "a" };
  const errors: string[] = [];
  class Dialog extends Component {
    static template = xml`<p t-out="this.plain.label"/>`;
    plain = plain;
  }
  class Host extends Component {
    static template = xml`<div t-out="this.read()"/>`;
    failing = false;
    setup() {
      onError((e) => errors.push(e.message));
    }
    read() {
      if (this.failing) {
        throw new Error("host failed");
      }
      return "host";
    }
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  plain.label = "b";
  host.failing = true;
  host.__owl__.render(true);
  await nextTick();
  expect(errors).toEqual(["host failed"]);
  expect(fixture.innerHTML).toBe("<div>host</div><p>a</p>");
  app.destroy();
});

test("a sub-root error handler runs after the root component's own onError", async () => {
  const steps: string[] = [];
  class Broken extends Component {
    static template = xml`<div/>`;
    setup() {
      throw new Error("boom");
    }
  }
  class Host extends Component {
    static components = { Broken };
    static template = xml`<t t-if="!this.failed()"><Broken/></t>`;
    failed = signal(false);
    setup() {
      onError((e) => {
        steps.push(`own: ${e.message}`);
        this.failed.set(true);
      });
    }
  }
  const app = new App();
  const root = app.createRoot(Host, {
    onError: (e: Error) => steps.push(`sub-root: ${e.message}`),
  } as any);
  root.mount(fixture);
  await nextTick();
  expect(steps).toEqual(["own: boom"]);
  expect(fixture.innerHTML).toBe("");
  app.destroy();
});

test("a sub-root destroyed while its render waits behind its host's pass is not kept by the scheduler", async () => {
  const late = makeDeferred();
  class Child extends Component {
    static template = xml`<i t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => late);
    }
  }
  class Host extends Component {
    static template = xml`<div><Child v="this.state.v"/></div>`;
    static components = { Child };
    state = proxy({ v: 1 });
  }
  class Dialog extends Component {
    static template = xml`<p t-out="this.state.n"/>`;
    state = proxy({ n: 1 });
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  const subRoot = createSubRoot(app, Dialog, { host: host.__owl__ });
  const dialog = await subRoot.mount(fixture);
  host.state.v = 2;
  await nextTick();
  dialog.state.n = 2;
  await nextTick();
  expect(app.scheduler.delayedRenders.map((f) => f.node.componentName)).toEqual(["Dialog"]);
  subRoot.destroy();
  expect(app.scheduler.delayedRenders.length).toBe(0);
  late.resolve();
  await nextTick();
  expect(fixture.innerHTML).toBe("<div><i>2</i></div>");
  app.destroy();
});

test("a destroyed root that never rendered leaves the renders waiting behind another pass", async () => {
  const late = makeDeferred();
  class Child extends Component {
    static template = xml`<i t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => late);
    }
  }
  class Host extends Component {
    static template = xml`<div><Child v="this.state.v"/></div>`;
    static components = { Child };
    state = proxy({ v: 1 });
  }
  class Dialog extends Component {
    static template = xml`<p t-out="this.state.n"/>`;
    state = proxy({ n: 1 });
  }
  class Slow extends Component {
    static template = xml`<s/>`;
    setup() {
      onWillStart(() => makeDeferred());
    }
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  const dialog = await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  host.state.v = 2;
  await nextTick();
  dialog.state.n = 2;
  await nextTick();
  const slow = app.createRoot(Slow);
  slow.mount(fixture);
  await nextTick();
  expect(app.scheduler.delayedRenders.map((f) => f.node.componentName)).toEqual(["Dialog"]);
  slow.destroy();
  expect(app.scheduler.delayedRenders.map((f) => f.node.componentName)).toEqual(["Dialog"]);
  late.resolve();
  await nextTick();
  expect(app.scheduler.delayedRenders).toEqual([]);
  expect(fixture.innerHTML).toBe("<div><i>2</i></div><p>2</p>");
  app.destroy();
});

test("a pass whose commit fails resumes the renders that waited behind it", async () => {
  const late = makeDeferred();
  class Child extends Component {
    static template = xml`<i t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => late);
      onWillPatch(() => {
        throw new Error("commit failed");
      });
    }
  }
  class Host extends Component {
    static template = xml`<div><Child v="this.state.v"/></div>`;
    static components = { Child };
    state = proxy({ v: 1 });
    setup() {
      onError(() => {});
    }
  }
  class Dialog extends Component {
    static template = xml`<p t-out="this.state.n"/>`;
    state = proxy({ n: 1 });
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  const dialog = await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  host.state.v = 2;
  await nextTick();
  dialog.state.n = 2;
  await nextTick();
  expect(app.scheduler.delayedRenders.map((f) => f.node.componentName)).toEqual(["Dialog"]);
  late.resolve();
  await nextTick();
  expect(app.scheduler.delayedRenders).toEqual([]);
  expect(app.scheduler.tasks.size).toBe(0);
  expect(fixture.innerHTML).toBe("<div><i>1</i></div><p>2</p>");
  app.destroy();
});
