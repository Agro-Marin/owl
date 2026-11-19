import {
  App,
  Component,
  mount,
  onError,
  onMounted,
  onPatched,
  onWillPatch,
  onWillStart,
  onWillUpdateProps,
  props,
  proxy,
  setDebug,
  setDebugSink,
  signal,
  xml,
  type DebugChannel,
} from "../../src";
import { createSubRoot } from "../../src/app";
import { makeDeferred, makeTestFixture, nextMicroTick, nextTick } from "../helpers";

let fixture: HTMLElement;
let lines: string[] = [];

beforeEach(() => {
  setDebug(false);
  fixture = makeTestFixture();
  lines = [];
  setDebugSink((channel: DebugChannel, message: string) => {
    if (!message.startsWith("window.__OWL_DEVTOOLS__")) {
      lines.push(`${channel}: ${message.replace(/[\d.]+ ms/, "_ ms")}`);
    }
  });
});

afterEach(() => {
  setDebug(false);
  setDebugSink(null);
});

test("lifecycle, fiber and scheduler channels trace a mount and an update", async () => {
  const value = signal(1);
  class Child extends Component {
    static template = xml`<b t-out="this.props.v"/>`;
    props = props();
  }
  class Parent extends Component {
    static template = xml`<div><Child v="this.value()"/><i t-out="1"/></div>`;
    static components = { Child };
    value = value;
    setup() {
      onMounted(() => {});
    }
  }
  setDebug(["lifecycle", "fiber", "scheduler"]);
  await mount(Parent, fixture);
  expect(lines).toEqual([
    "lifecycle: create root Parent",
    "lifecycle: setup Parent (root)",
    "scheduler: schedule Parent, 1 task(s)",
    "lifecycle: setup Child (child of Parent)",
    "fiber: render Child in _ ms, 1 left in Parent's pass",
    "fiber: render Parent in _ ms, 0 left in Parent's pass",
    "scheduler: frame, 1 task(s)",
    "fiber: mount Parent",
    "lifecycle: mounted Parent: 2 hook(s)",
  ]);
  lines.length = 0;
  value.set(2);
  await nextTick();
  expect(lines).toEqual([
    "scheduler: schedule Parent, 1 task(s)",
    "fiber: update Child: props changed",
    "fiber: render Child in _ ms, 1 left in Parent's pass",
    "fiber: render Parent in _ ms, 0 left in Parent's pass",
    "scheduler: frame, 1 task(s)",
    "fiber: commit Parent: 0 willPatch, 0 mounted, 0 patched",
  ]);
  expect(fixture.innerHTML).toBe("<div><b>2</b><i>1</i></div>");
});

test("the scheduler channel says a frame waits for a pass whose renders are pending", async () => {
  let release!: () => void;
  class Slow extends Component {
    static template = xml`<b>slow</b>`;
    setup() {
      onWillStart(() => new Promise<void>((resolve) => (release = resolve)));
    }
  }
  class Fast extends Component {
    static template = xml`<i>fast</i>`;
  }
  const app = new App();
  setDebug(["scheduler"]);
  const slow = app.createRoot(Slow).mount(fixture);
  await app.createRoot(Fast).mount(fixture);
  expect(lines).toContain("scheduler: wait Slow: 1 render(s) pending");
  release();
  await slow;
  expect(fixture.innerHTML).toBe("<i>fast</i><b>slow</b>");
  app.destroy();
});

test("the scheduler channel says why it drops a task and which delayed renders it resumes", async () => {
  const resumed: unknown[] = [];
  setDebugSink((channel: DebugChannel, message: string, details: unknown[]) => {
    if (!message.startsWith("window.__OWL_DEVTOOLS__")) {
      lines.push(`${channel}: ${message}`);
      resumed.push(...details);
    }
  });
  const late = makeDeferred();
  class Child extends Component {
    static template = xml`<i t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => late);
      onWillPatch(() => {
        if (this.props.v === 3) {
          throw new Error("commit failed");
        }
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
  class Slow extends Component {
    static template = xml`<s/>`;
    setup() {
      onWillStart(() => makeDeferred());
    }
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  const dialog = await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  setDebug("scheduler");
  host.state.v = 2;
  await nextTick();
  dialog.state.n = 2;
  await nextTick();
  const slow = app.createRoot(Slow);
  slow.mount(fixture);
  await nextTick();
  slow.destroy();
  late.resolve();
  await nextTick();
  host.state.v = 3;
  await nextTick();
  expect(lines).toEqual([
    "scheduler: schedule Host, 1 task(s)",
    "scheduler: schedule Dialog, 2 task(s)",
    "scheduler: schedule Slow, 3 task(s)",
    "scheduler: drop Slow: destroyed",
    "scheduler: resume 1 delayed render(s)",
    "scheduler: frame, 2 task(s)",
    "scheduler: schedule Host, 1 task(s)",
    "scheduler: frame, 1 task(s)",
    "scheduler: drop Host: failed",
  ]);
  expect(resumed).toEqual([["Dialog"]]);
  expect(fixture.innerHTML).toBe("<div><i>2</i></div><p>2</p>");
  app.destroy();
});

test("the scheduler channel says it drops a root fiber its node no longer renders", async () => {
  class Comp extends Component {
    static template = xml`<div><t t-out="this.state.value"/></div>`;
    state = proxy({ value: 1 });
  }
  const comp = await mount(Comp, fixture);
  setDebug("scheduler");
  comp.state.value = 2;
  await nextMicroTick();
  await nextMicroTick();
  comp.__owl__.fiber = null;
  await nextTick();
  expect(lines).toEqual([
    "scheduler: schedule Comp, 1 task(s)",
    "scheduler: frame, 1 task(s)",
    "scheduler: drop Comp: superseded",
  ]);
});

test("the scheduler channel says it drops a root render its parent's render took over", async () => {
  class Child extends Component {
    static template = xml`<b><t t-out="this.props.v"/><t t-out="this.state.n"/></b>`;
    props = props();
    state = proxy({ n: 1 });
  }
  class Parent extends Component {
    static template = xml`<div><Child v="this.state.v"/></div>`;
    static components = { Child };
    state = proxy({ v: 1 });
  }
  const parent = await mount(Parent, fixture);
  const child = Object.values(parent.__owl__.children)[0].component as Child;
  setDebug("scheduler");
  child.state.n = 2;
  parent.state.v = 2;
  await nextTick();
  expect(lines).toEqual([
    "scheduler: schedule Child, 1 task(s)",
    "scheduler: schedule Parent, 2 task(s)",
    "scheduler: drop Child: taken over by Parent's render",
    "scheduler: frame, 1 task(s)",
  ]);
  expect(fixture.innerHTML).toBe("<div><b>22</b></div>");
});

test("the fiber channel says which renders of a failed pass wait for it and which render alone", async () => {
  const shared = proxy({ n: 1 });
  class C extends Component {
    static template = xml`<c t-out="this.shared.n"/>`;
    shared = shared;
  }
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
    static template = xml`<div><A v="this.state.v"/><t t-if="this.state.on"><C/></t><Bad v="this.state.v"/></div>`;
    static components = { A, C, Bad };
    state = proxy({ on: false, v: 1 });
    setup() {
      onError(() => {});
    }
  }
  const parent = await mount(Parent, fixture);
  const a = Object.values(parent.__owl__.children)[0].component as A;
  setDebug("fiber");
  parent.state.on = true;
  parent.state.v = 2;
  await nextTick();
  shared.n = 2;
  a.state.n = 7;
  await nextTick();
  await nextTick();
  expect(lines).toEqual([
    "fiber: update A: props changed",
    "fiber: render A in _ ms, 1 left in Parent's pass",
    "fiber: render C in _ ms, 1 left in Parent's pass",
    "fiber: update Bad: props changed",
    "fiber: render Bad in _ ms, 1 left in Parent's pass",
    "fiber: render Parent in _ ms, 0 left in Parent's pass",
    "fiber: keep C in Parent's failed pass: never mounted",
    "fiber: render A alone: Parent's pass failed",
    "fiber: render A in _ ms, 0 left in A's pass",
    "fiber: commit A: 0 willPatch, 0 mounted, 0 patched",
  ]);
});

test("the fiber channel says a render asked during a pass that then failed runs alone", async () => {
  const load = makeDeferred();
  const loadB = makeDeferred();
  class A extends Component {
    static template = xml`<a><t t-out="this.props.value"/></a>`;
    props = props();
    setup() {
      onWillUpdateProps(() => load);
    }
  }
  class B extends Component {
    static template = xml`<b><t t-out="this.props.value"/><t t-out="this.state.value"/></b>`;
    props = props();
    state = proxy({ value: 1 });
    setup() {
      onWillUpdateProps(() => loadB);
    }
  }
  class Parent extends Component {
    static template = xml`<div><A value="this.state.value"/><B value="this.state.value"/></div>`;
    static components = { A, B };
    state = proxy({ value: 1 });
    setup() {
      onError(() => {});
    }
  }
  const parent = await mount(Parent, fixture);
  const b = Object.values(parent.__owl__.children)[1].component as B;
  parent.state.value = 2;
  await nextTick();
  b.state.value = 2;
  await nextTick();
  loadB.resolve();
  await nextTick();
  setDebug("fiber");
  load.reject(new Error("load failed"));
  await nextTick();
  await nextTick();
  expect(lines).toEqual([
    "fiber: B asked to render during Parent's failed pass",
    "fiber: render B alone: Parent's pass failed",
    "fiber: render B in _ ms, 0 left in B's pass",
    "fiber: commit B: 0 willPatch, 0 mounted, 0 patched",
  ]);
});

test("the fiber channel counts the recycles of a child rendering again in a pending pass", async () => {
  const slow = makeDeferred();
  class Slow extends Component {
    static template = xml`<s t-out="this.props.v"/>`;
    props = props();
    setup() {
      onWillUpdateProps(() => slow);
    }
  }
  class A extends Component {
    static template = xml`<a><t t-out="this.props.v"/><t t-out="this.state.n"/></a>`;
    props = props();
    state = proxy({ n: 0 });
  }
  class Parent extends Component {
    static template = xml`<div><Slow v="this.state.v"/><A v="this.state.v"/></div>`;
    static components = { Slow, A };
    state = proxy({ v: 1 });
  }
  const parent = await mount(Parent, fixture);
  const a = Object.values(parent.__owl__.children)[1].component as A;
  setDebug("fiber");
  parent.state.v = 2;
  await nextTick();
  a.state.n = 1;
  await nextTick();
  slow.resolve();
  await nextTick();
  expect(lines).toEqual([
    "fiber: update Slow: props changed, 1 willUpdateProps",
    "fiber: update A: props changed",
    "fiber: render A in _ ms, 2 left in Parent's pass",
    "fiber: render Parent in _ ms, 1 left in Parent's pass",
    "fiber: recycle A (1)",
    "fiber: render A in _ ms, 1 left in Parent's pass",
    "fiber: render Slow in _ ms, 0 left in Parent's pass",
    "fiber: commit Parent: 0 willPatch, 0 mounted, 0 patched",
  ]);
  expect(fixture.innerHTML).toBe("<div><s>2</s><a>21</a></div>");
});

test("the fiber channel says a render waits for a rendering pass above it", async () => {
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
  const dialog = await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  host.state.v = 2;
  await nextTick();
  setDebug("fiber");
  dialog.state.n = 2;
  await nextTick();
  setDebug(false);
  late.resolve();
  await nextTick();
  expect(lines).toEqual(["fiber: delay Dialog: Host is rendering"]);
  app.destroy();
});

test("the fiber channel traces a deep render reaching a sub-root", async () => {
  class Dialog extends Component {
    static template = xml`<p>d</p>`;
  }
  class Host extends Component {
    static template = xml`<div/>`;
  }
  const app = new App();
  const host = await app.createRoot(Host).mount(fixture);
  await createSubRoot(app, Dialog, { host: host.__owl__ }).mount(fixture);
  setDebug("fiber");
  host.__owl__.render(true);
  await nextTick();
  expect(lines).toEqual([
    "fiber: deep render of Host reaches its sub-root Dialog",
    "fiber: render Host in _ ms, 0 left in Host's pass",
    "fiber: render Dialog in _ ms, 0 left in Dialog's pass",
    "fiber: commit Host: 0 willPatch, 0 mounted, 0 patched",
    "fiber: commit Dialog: 0 willPatch, 0 mounted, 0 patched",
  ]);
  app.destroy();
});

test("the fiber channel says a commit is dropped when its onWillPatch destroyed the app", async () => {
  let app: App;
  class Parent extends Component {
    static template = xml`<div t-out="this.state.v"/>`;
    state = proxy({ v: 0 });
    setup() {
      onWillPatch(() => app.destroy());
    }
  }
  app = new App({ test: true });
  const parent = await app.createRoot(Parent).mount(fixture);
  setDebug("fiber");
  parent.state.v = 1;
  await nextTick();
  expect(lines).toEqual([
    "fiber: render Parent in _ ms, 0 left in Parent's pass",
    "fiber: commit Parent: 1 willPatch, 0 mounted, 0 patched",
    "fiber: drop Parent's commit: destroyed by onWillPatch",
  ]);
});

test("the fiber channel says a failed first mount sends its mounted children back to unmounted", async () => {
  let boom = true;
  class Child extends Component {
    static template = xml`<p>c</p>`;
  }
  class Root extends Component {
    static template = xml`<div t-ref="this.ref" t-att-n="this.state.n"><Child/></div>`;
    static components = { Child };
    state = proxy({ n: 1 });
    ref = {
      set: (el: HTMLElement | null) => {
        if (boom && el) {
          boom = false;
          throw new Error("ref");
        }
      },
    };
    setup() {
      onError(() => (this.state.n = 2));
    }
  }
  setDebug("fiber");
  await mount(Root, fixture);
  expect(lines).toEqual([
    "fiber: render Child in _ ms, 1 left in Root's pass",
    "fiber: render Root in _ ms, 0 left in Root's pass",
    "fiber: mount Root",
    "fiber: Child goes back to unmounted with its parent's failed mount",
    "fiber: recycle Root (1)",
    "fiber: render Child in _ ms, 1 left in Root's pass",
    "fiber: render Root in _ ms, 0 left in Root's pass",
    "fiber: mount Root",
  ]);
  expect(fixture.innerHTML).toBe('<div n="2"><p>c</p></div>');
});

test("the lifecycle channel says when owed onMounted hooks run, and when a commit finds them paid", async () => {
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
      onPatched(() => {});
    }
  }
  class GrandParent extends Component {
    static template = xml`<gp t-att-w="this.state.w"><Failing/><Child/></gp>`;
    static components = { Failing, Child };
    state = proxy({ w: 0 });
    setup() {
      grandParent = this;
      onMounted(() => {});
      onPatched(() => {});
    }
  }
  class Root extends Component {
    static template = xml`<div><GrandParent t-if="this.state.on"/></div>`;
    static components = { GrandParent };
    state = proxy({ on: false });
    setup() {
      root = this;
      onError(() => {});
    }
  }
  await mount(Root, fixture);
  root.state.on = true;
  await nextTick();
  setDebug("lifecycle");
  child.state.v++;
  grandParent.state.w++;
  await nextTick();
  await nextTick();
  expect(lines).toEqual([
    "lifecycle: patched Child: 1 hook(s)",
    "lifecycle: mounted GrandParent: 1 hook(s) owed since a failed commit",
    "lifecycle: mounted GrandParent: owed hooks already paid",
    "lifecycle: patched GrandParent: 1 hook(s)",
  ]);
});

test("the fiber channel measures a render, and gives no time to one it did not see start", async () => {
  class Timed extends Component {
    static template = xml`<p t-out="this.read()"/>`;
    state = proxy({ v: 0 });
    read() {
      if (this.state.v === 2) {
        setDebug("fiber");
      }
      return this.state.v;
    }
  }
  const timed = await mount(Timed, fixture);
  const durations: number[] = [];
  setDebugSink((channel: DebugChannel, message: string) => {
    lines.push(`${channel}: ${message.replace(/[\d.]+ ms/, "_ ms")}`);
    const ms = /in ([\d.]+) ms/.exec(message);
    if (ms) {
      durations.push(Number(ms[1]));
    }
  });
  setDebug("fiber");
  const before = performance.now();
  timed.state.v = 1;
  await nextTick();
  const elapsed = performance.now() - before;
  setDebug(false);
  timed.state.v = 2;
  await nextTick();
  setDebug(false);
  expect(lines).toEqual([
    "fiber: render Timed in _ ms, 0 left in Timed's pass",
    "fiber: commit Timed: 0 willPatch, 0 mounted, 0 patched",
    "fiber: render Timed, 0 left in Timed's pass",
    "fiber: commit Timed: 0 willPatch, 0 mounted, 0 patched",
  ]);
  expect(durations.length).toBe(1);
  expect(durations[0]).toBeLessThanOrEqual(elapsed);
});

test("the fiber channel names only the live renders asked during a failed pass", async () => {
  const load = makeDeferred();
  class A extends Component {
    static template = xml`<a><t t-out="this.props.value"/></a>`;
    props = props();
    setup() {
      onWillUpdateProps(() => load);
    }
  }
  class C extends Component {
    static template = xml`<c><t t-out="this.props.value"/><t t-out="this.state.value"/></c>`;
    props = props();
    state = proxy({ value: 1 });
  }
  class M extends Component {
    static template = xml`<m><t t-out="this.state.value"/><C value="this.props.value"/></m>`;
    static components = { C };
    props = props();
    state = proxy({ value: 1 });
  }
  class Parent extends Component {
    static template = xml`<div><A value="this.state.value"/><M value="this.state.value"/></div>`;
    static components = { A, M };
    state = proxy({ value: 1 });
    setup() {
      onError(() => {});
    }
  }
  const parent = await mount(Parent, fixture);
  const m = Object.values(parent.__owl__.children)[1].component as M;
  const c = Object.values(m.__owl__.children)[0].component as C;
  parent.state.value = 2;
  await nextTick();
  c.state.value = 2;
  await nextTick();
  m.state.value = 2;
  await nextTick();
  setDebug("fiber");
  load.reject(new Error("load failed"));
  await nextTick();
  await nextTick();
  expect(lines).toEqual([
    "fiber: M asked to render during Parent's failed pass",
    "fiber: render M alone: Parent's pass failed",
    "fiber: render C again: its pending render was cancelled",
    "fiber: render C in _ ms, 1 left in M's pass",
    "fiber: render M in _ ms, 0 left in M's pass",
    "fiber: commit M: 0 willPatch, 0 mounted, 0 patched",
  ]);
  expect(fixture.innerHTML).toBe("<div><a>1</a><m>2<c>22</c></m></div>");
});

test("the fiber channel does not ask a never-mounted node of a failed pass to render alone", async () => {
  const load = makeDeferred();
  let fresh: Fresh | null = null;
  class A extends Component {
    static template = xml`<a><t t-out="this.props.value"/></a>`;
    props = props();
    setup() {
      onWillUpdateProps(() => load);
    }
  }
  class Fresh extends Component {
    static template = xml`<f><t t-out="this.state.value"/></f>`;
    state = proxy({ value: 1 });
    setup() {
      fresh = this;
    }
  }
  class Parent extends Component {
    static template = xml`<div><A value="this.state.value"/><Fresh t-if="this.state.value > 1"/></div>`;
    static components = { A, Fresh };
    state = proxy({ value: 1 });
    setup() {
      onError(() => {});
    }
  }
  const parent = await mount(Parent, fixture);
  parent.state.value = 2;
  await nextTick();
  fresh!.state.value = 2;
  await nextTick();
  setDebug("fiber");
  load.reject(new Error("load failed"));
  await nextTick();
  await nextTick();
  expect(lines).toEqual([]);
  expect(fixture.innerHTML).toBe("<div><a>1</a></div>");
});

test("the error channel says who handled an error", async () => {
  class Boom extends Component {
    static template = xml`<b t-out="this.fail()"/>`;
    fail() {
      throw new Error("boom");
    }
  }
  class Parent extends Component {
    static template = xml`<div><Boom t-if="!this.failed()"/></div>`;
    static components = { Boom };
    failed = signal(false);
    setup() {
      onError(() => this.failed.set(true));
    }
  }
  setDebug("error");
  await mount(Parent, fixture);
  expect(lines).toEqual(["error: Boom: error handled by Parent's onError"]);
});

test("the event channel traces a handled event", async () => {
  class Clicker extends Component {
    static template = xml`<button t-on-click="this.click">x</button>`;
    click() {}
  }
  await mount(Clicker, fixture);
  setDebug("event");
  fixture.querySelector("button")!.click();
  expect(lines).toEqual(["event: click on BUTTON: handled by Clicker"]);
});

test("the template channel traces a compilation", async () => {
  class Tpl extends Component {
    static template = xml`<p>compiled</p>`;
  }
  setDebug("template");
  await mount(Tpl, fixture);
  expect(lines.length).toBe(2);
  expect(lines[0]).toMatch(/^template: __template__\d+: compiled in _ ms, \d+ chars$/);
  expect(lines[1]).toBe("template: block type made: 0 handlers, <p>compiled</p>");
});

test("a component created before the reactivity channel is on is named in its traces", async () => {
  const value = signal(1);
  class Reader extends Component {
    static template = xml`<b t-out="this.value()"/>`;
    value = value;
  }
  await mount(Reader, fixture);
  const observers: unknown[] = [];
  setDebugSink((channel: DebugChannel, message: string, details: unknown[]) => {
    if (message.startsWith("write")) {
      observers.push(details[0]);
    }
  });
  setDebug("reactivity");
  value.set(2);
  expect(observers).toEqual([["render Reader"]]);
});

test("the fiber channel says it drops a render whose component an error destroyed while it rendered", async () => {
  class Bad extends Component {
    static template = xml`<b t-out="this.boom()"/>`;
    boom(): string {
      throw new Error("boom");
    }
  }
  class After extends Component {
    static template = xml`<i/>`;
  }
  class Root extends Component {
    static template = xml`<div><Bad/><After/></div>`;
    static components = { Bad, After };
  }
  const app = new App({ test: true });
  setDebug("fiber");
  await expect(app.createRoot(Root).mount(fixture)).rejects.toThrow("boom");
  expect(lines).toContain("fiber: drop Root's render: destroyed while rendering");
  expect(app.destroyed).toBe(true);
});
