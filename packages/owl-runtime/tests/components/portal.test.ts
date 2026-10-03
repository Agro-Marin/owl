import {
  App,
  mount,
  proxy,
  Component,
  onError,
  onMounted,
  onWillStart,
  Plugin,
  Portal,
  plugin,
  providePlugins,
  signal,
  xml,
} from "../../src";
import { makeDeferred, makeTestFixture, nextAppError, nextTick } from "../helpers";

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

function makeOutside(id: string): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  document.querySelectorAll("[data-test-portal]").forEach((el) => el.remove());
});

test("renders nothing in place; mounts content into target Element", async () => {
  const target = makeOutside("portal-target-1");
  target.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <div class="root">
        <Portal target="this.target">
          <span class="payload">hello</span>
        </Portal>
      </div>
    `;
    target = target;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(fixture.innerHTML).toBe(`<div class="root"></div>`);
  expect(target.innerHTML).toContain(`<span class="payload">hello</span>`);
  app.destroy();
});

test("slot content is not re-rendered when the guard removing it flips", async () => {
  const target = makeOutside("portal-target-guard");
  target.dataset.testPortal = "1";

  const seen: boolean[] = [];

  class Popover extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target">
        <t t-call-slot="default"/>
      </Portal>`;
    target = target;
  }

  class Root extends Component {
    static components = { Popover };
    static template = xml`
      <button>toggle</button>
      <Popover t-if="this.open()">open<t t-out="this.probe()"/></Popover>`;
    open = signal(false);
    probe() {
      seen.push(this.open());
      return "";
    }
  }

  const app = new App();
  const root = (await app.createRoot(Root).mount(fixture)) as InstanceType<typeof Root>;
  await nextTick();
  expect(seen).toEqual([]);

  root.open.set(true);
  await nextTick();
  expect(target.textContent).toBe("open");
  expect(seen).toEqual([true]);

  root.open.set(false);
  await nextTick();
  expect(target.textContent).toBe("");
  // The slot must never have been evaluated with the guard value that
  // removed it: the sub-root render has to yield to the ancestor's.
  expect(seen).toEqual([true]);
  app.destroy();
});

test("accepts a CSS selector string as target", async () => {
  const target = makeOutside("portal-target-2");
  target.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="'#portal-target-2'">
        <span class="payload">via selector</span>
      </Portal>
    `;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(target.innerHTML).toContain(`via selector`);
  app.destroy();
});

test("a selector the same render creates is resolved once the Portal is mounted", async () => {
  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <div class="root">
        <Portal target="'#created-by-render'">
          <span class="payload">late target</span>
        </Portal>
        <div id="created-by-render"/>
      </div>
    `;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(fixture.querySelector("#created-by-render")!.innerHTML).toContain("late target");
  app.destroy();
});

test("content portaled into a target the same render creates goes before what it holds", async () => {
  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <div class="root">
        <Portal target="'#footer'">
          <button class="portaled">save</button>
        </Portal>
        <div id="footer"><button class="own">ok</button></div>
      </div>
    `;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(fixture.querySelector("#footer")!.innerHTML).toBe(
    '<button class="portaled">save</button><button class="own">ok</button>'
  );
  app.destroy();
});

test("ref signal: waits for target to appear, then mounts", async () => {
  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <div class="here" t-ref="this.targetRef"/>
      <Portal target="this.targetRef">
        <span class="payload">deferred</span>
      </Portal>
    `;
    targetRef = signal(null);
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();
  await nextTick();

  // Target is the in-tree <div class="here"> bound by t-ref. Once the parent
  // mounts, the ref fills in, the Portal's effect re-fires, and the content
  // commits inside that div.
  const here = fixture.querySelector(".here")!;
  expect(here.innerHTML).toContain(`<span class="payload">deferred</span>`);
  app.destroy();
});

test("slot content reads signals from outer (parent) scope", async () => {
  const target = makeOutside("portal-target-3");
  target.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target">
        <span class="payload" t-out="this.count()"/>
      </Portal>
    `;
    target = target;
    count = signal(0);
  }

  const app = new App();
  const root = await app.createRoot(Root).mount(fixture);
  await nextTick();
  expect(target.querySelector(".payload")!.textContent).toBe("0");

  root.count.set(7);
  await nextTick();
  await nextTick();
  expect(target.querySelector(".payload")!.textContent).toBe("7");

  app.destroy();
});

test("forwards plugin chain: providePlugins ancestor is visible to portaled content", async () => {
  const target = makeOutside("portal-target-4");
  target.dataset.testPortal = "1";

  class FooPlugin extends Plugin {
    value = "from plugin";
  }

  let inside: any = null;
  class Inside extends Component {
    static template = xml`<span class="payload" t-out="this.foo.value"/>`;
    foo = plugin(FooPlugin);
    setup() {
      inside = this;
    }
  }

  class Root extends Component {
    static components = { Portal, Inside };
    static template = xml`
      <Portal target="this.target">
        <Inside/>
      </Portal>
    `;
    target = target;
    setup() {
      providePlugins([FooPlugin]);
    }
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(inside).not.toBeNull();
  expect(inside.foo.value).toBe("from plugin");
  expect(target.querySelector(".payload")!.textContent).toBe("from plugin");

  app.destroy();
});

test("target signal change: tears down old root, mounts at new", async () => {
  const t1 = makeOutside("portal-target-5a");
  const t2 = makeOutside("portal-target-5b");
  t1.dataset.testPortal = "1";
  t2.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target">
        <span class="payload">x</span>
      </Portal>
    `;
    target = signal<HTMLElement | null>(t1);
  }

  const app = new App();
  const root = await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(t1.innerHTML).toContain("payload");
  expect(t2.innerHTML).toBe("");

  root.target.set(t2);
  await nextTick();
  await nextTick();

  expect(t1.innerHTML).toBe("");
  expect(t2.innerHTML).toContain("payload");

  app.destroy();
});

test("target signal flipping to null tears down the portal", async () => {
  const t1 = makeOutside("portal-target-6");
  t1.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target">
        <span class="payload">x</span>
      </Portal>
    `;
    target = signal<HTMLElement | null>(t1);
  }

  const app = new App();
  const root = await app.createRoot(Root).mount(fixture);
  await nextTick();
  expect(t1.innerHTML).toContain("payload");

  root.target.set(null);
  await nextTick();
  await nextTick();
  expect(t1.innerHTML).toBe("");

  app.destroy();
});

test("portal teardown removes content from target on app destroy", async () => {
  const target = makeOutside("portal-target-7");
  target.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target">
        <span class="payload">x</span>
      </Portal>
    `;
    target = target;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();
  expect(target.innerHTML).toContain("payload");

  app.destroy();
  await nextTick();
  expect(target.innerHTML).toBe("");
});

test("multiple portals to the same target stack as siblings", async () => {
  const target = makeOutside("portal-target-8");
  target.dataset.testPortal = "1";

  class Root extends Component {
    static components = { Portal };
    static template = xml`
      <Portal target="this.target">
        <span class="a">A</span>
      </Portal>
      <Portal target="this.target">
        <span class="b">B</span>
      </Portal>
    `;
    target = target;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();

  expect(target.querySelector(".a")?.textContent).toBe("A");
  expect(target.querySelector(".b")?.textContent).toBe("B");

  app.destroy();
});

test("error in portaled content propagates to outer onError", async () => {
  const target = makeOutside("portal-target-9");
  target.dataset.testPortal = "1";

  let caught: any = null;

  class Broken extends Component {
    static template = xml`<span>ok</span>`;
    setup() {
      onWillStart(async () => {
        throw new Error("boom");
      });
    }
  }

  class Root extends Component {
    static components = { Portal, Broken };
    static template = xml`
      <Portal target="this.target">
        <Broken/>
      </Portal>
    `;
    target = target;
    setup() {
      onError((e) => {
        caught = e;
      });
    }
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();
  await nextTick();

  expect(caught).toBeInstanceOf(Error);
  expect(caught.message).toBe("boom");
  app.destroy();
});

test("waits for descendant onWillStart before mounting", async () => {
  const target = makeOutside("portal-target-10");
  target.dataset.testPortal = "1";
  const rpc = makeDeferred<string>();

  class AsyncChild extends Component {
    static template = xml`<span class="payload" t-out="this.data"/>`;
    data = "";
    setup() {
      onWillStart(async () => {
        this.data = await rpc;
      });
    }
  }

  class Root extends Component {
    static components = { Portal, AsyncChild };
    static template = xml`
      <Portal target="this.target">
        <AsyncChild/>
      </Portal>
    `;
    target = target;
  }

  const app = new App();
  await app.createRoot(Root).mount(fixture);
  await nextTick();
  // Outer mount completed, but the portal's content is still loading.
  expect(target.innerHTML).toBe("");

  rpc.resolve("ready");
  await nextTick();
  await nextTick();
  expect(target.querySelector(".payload")!.textContent).toBe("ready");

  app.destroy();
});

test("a portal created by the render that replaces its target goes to the new target", async () => {
  class Parent extends Component {
    static components = { Portal };
    static template = xml`
      <div>
        <div t-if="this.state.first" class="host first"><span class="target"/></div>
        <div t-else="" class="host second"><span class="target"/></div>
        <t t-if="!this.state.first">
          <Portal target="'.target'"><p>content</p></Portal>
        </t>
      </div>`;
    state = proxy({ first: true });
  }
  const parent = await mount(Parent, fixture);
  parent.state.first = false;
  await nextTick();
  await nextTick();
  expect(fixture.querySelector(".second .target")!.innerHTML).toBe("<p>content</p>");
});

test("a target changed after a mount-time lookup leaves no content in the old target", async () => {
  const other = makeOutside("portal-other-target");
  other.dataset.testPortal = "1";
  class Parent extends Component {
    static components = { Portal };
    static template = xml`
      <div>
        <div id="made-by-render"/>
        <Portal target="this.sel()"><p>content</p></Portal>
      </div>`;
    sel = signal("#made-by-render");
  }
  const parent = await mount(Parent, fixture);
  await nextTick();
  expect(fixture.querySelector("#made-by-render")!.innerHTML).toBe("<p>content</p>");

  parent.sel.set("#portal-other-target");
  await nextTick();
  await nextTick();
  expect(other.innerHTML).toBe("<p>content</p>");
  expect(fixture.querySelector("#made-by-render")!.innerHTML).toBe("");
});

test("portaled content sees the slot scope of the latest render", async () => {
  const target = makeOutside("pb-target");
  target.dataset.testPortal = "1";
  class Parent extends Component {
    static components = { Portal };
    static template = xml`
      <t t-foreach="this.items()" t-as="item" t-key="item.id">
        <Portal target="'#pb-target'"><span t-out="item.name"/></Portal>
      </t>`;
    items = signal([{ id: 1, name: "a" }]);
  }
  const parent = await mount(Parent, fixture);
  await nextTick();
  expect(target.innerHTML).toBe("<span>a</span>");

  parent.items.set([{ id: 1, name: "b" }]);
  await nextTick();
  await nextTick();
  expect(target.innerHTML).toBe("<span>b</span>");
});

test("an error an outer onError rethrows reaches the app as rethrown", async () => {
  const target = makeOutside("portal-target-rethrow");
  target.dataset.testPortal = "1";

  class Broken extends Component {
    static template = xml`<span>ok</span>`;
    setup() {
      onWillStart(async () => {
        throw new Error("boom");
      });
    }
  }

  class Root extends Component {
    static components = { Portal, Broken };
    static template = xml`
      <t t-if="this.show()"><Portal target="this.target"><Broken/></Portal></t>`;
    target = target;
    show = signal(false);
    setup() {
      onError((e) => {
        throw new Error("wrapped: " + e.message);
      });
    }
  }

  const app = new App();
  const root = await app.createRoot(Root).mount(fixture);
  const appError = nextAppError(app);
  root.show.set(true);
  expect((await appError).message).toBe("wrapped: boom");
});

test("a null or undefined target mounts nothing, also in dev mode", async () => {
  const target = makeOutside("portal-target-nullable");
  target.dataset.testPortal = "1";
  class Parent extends Component {
    static components = { Portal };
    static template = xml`<Portal target="this.target()"><p>content</p></Portal>`;
    target = signal<HTMLElement | null | undefined>(null);
  }
  const parent = await mount(Parent, fixture, { test: true });
  await nextTick();
  expect(target.innerHTML).toBe("");

  parent.target.set(undefined);
  await nextTick();
  expect(target.innerHTML).toBe("");

  parent.target.set(target);
  await nextTick();
  await nextTick();
  expect(target.innerHTML).toBe("<p>content</p>");
});

test("content waits for its host Portal to be in the document", async () => {
  const target = makeOutside("portal-target-host");
  target.dataset.testPortal = "1";
  const slow = makeDeferred();
  const steps: string[] = [];
  class Slow extends Component {
    static template = xml`<i>slow</i>`;
    setup() {
      onWillStart(() => slow);
    }
  }
  class Content extends Component {
    static template = xml`<span>portaled</span>`;
    setup() {
      onMounted(() => steps.push("content mounted"));
    }
  }
  class Dialog extends Component {
    static components = { Portal, Slow, Content };
    static template = xml`<div class="dialog"><Portal target="this.target"><Content/></Portal><Slow/></div>`;
    target = target;
    setup() {
      onMounted(() => steps.push("dialog mounted"));
    }
  }
  class Parent extends Component {
    static components = { Dialog };
    static template = xml`<div><Dialog t-if="this.state.open"/></div>`;
    state = proxy({ open: false });
  }
  const parent = await mount(Parent, fixture);
  parent.state.open = true;
  await nextTick();
  await nextTick();
  expect(target.innerHTML).toBe("");
  expect(steps).toEqual([]);

  parent.state.open = false;
  await nextTick();
  expect(target.innerHTML).toBe("");
  expect(steps).toEqual([]);

  parent.state.open = true;
  await nextTick();
  slow.resolve();
  await nextTick();
  await nextTick();
  expect(fixture.innerHTML).toBe('<div><div class="dialog"><i>slow</i></div></div>');
  expect(target.innerHTML).toBe("<span>portaled</span>");
  expect(steps).toEqual(["content mounted", "dialog mounted"]);
});

test("a portal added by a re-render of a mounted host appears once that render is committed", async () => {
  const target = makeOutside("portal-target-rerender");
  target.dataset.testPortal = "1";
  class Host extends Component {
    static components = { Portal };
    static template = xml`
      <div>
        <t t-foreach="this.items" t-as="item" t-key="item">
          <Portal target="this.target"><span t-out="item"/></Portal>
        </t>
      </div>`;
    target = target;
    items = proxy(["a"]);
  }
  const host = await mount(Host, fixture);
  await nextTick();
  expect(target.innerHTML).toBe("<span>a</span>");

  host.items.push("b");
  await nextTick();
  await nextTick();
  expect(target.innerHTML).toBe("<span>a</span><span>b</span>");
});

test("content is committed even when a later sibling's onMounted throws and is handled", async () => {
  const target = makeOutside("portal-target-sibling-error");
  target.dataset.testPortal = "1";
  class Bad extends Component {
    static template = xml`<b>bad</b>`;
    setup() {
      onMounted(() => {
        throw new Error("boom");
      });
    }
  }
  class Dialog extends Component {
    static components = { Portal, Bad };
    static template = xml`<div class="dialog"><Portal target="this.target"><span>portaled</span></Portal><Bad/></div>`;
    target = target;
  }
  class Parent extends Component {
    static components = { Dialog };
    static template = xml`<div><Dialog t-if="this.state.open"/></div>`;
    state = proxy({ open: false });
    errors: string[] = [];
    setup() {
      onError((e) => this.errors.push(e.message));
    }
  }
  const parent = await mount(Parent, fixture);
  parent.state.open = true;
  await nextTick();
  await nextTick();
  expect(parent.errors).toEqual(["boom"]);
  expect(fixture.innerHTML).toBe('<div><div class="dialog"><b>bad</b></div></div>');
  expect(target.innerHTML).toBe("<span>portaled</span>");
});

test("content rendered with its host mounts after the onMounted of that render", async () => {
  const target = makeOutside("portal-target-order");
  target.dataset.testPortal = "1";
  const steps: string[] = [];
  class Content extends Component {
    static template = xml`<span class="content">portaled</span>`;
    setup() {
      onMounted(() => steps.push("content mounted"));
    }
  }
  class Dialog extends Component {
    static components = { Portal, Content };
    static template = xml`<div class="dialog"><Portal target="this.target"><Content/></Portal></div>`;
    target = target;
    setup() {
      onMounted(() =>
        steps.push(`dialog mounted, content in target: ${!!target.querySelector(".content")}`)
      );
    }
  }
  class Parent extends Component {
    static components = { Dialog };
    static template = xml`<div><Dialog t-if="this.state.open"/></div>`;
    state = proxy({ open: false });
    setup() {
      onMounted(() => steps.push("parent mounted"));
    }
  }
  const parent = await mount(Parent, fixture);
  steps.splice(0);
  parent.state.open = true;
  await nextTick();
  await nextTick();
  expect(target.innerHTML).toBe('<span class="content">portaled</span>');
  expect(steps).toEqual(["dialog mounted, content in target: false", "content mounted"]);
});
