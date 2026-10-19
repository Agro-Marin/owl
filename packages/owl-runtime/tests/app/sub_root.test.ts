import {
  App,
  Component,
  onError,
  onMounted,
  onWillDestroy,
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
