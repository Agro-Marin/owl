import {
  App,
  Component,
  ErrorBoundary,
  globalTemplates,
  mount,
  Portal,
  proxy,
  setDebug,
  setDebugSink,
  Suspense,
  toRaw,
  xml,
} from "../../src";
import { config } from "../../src/blockdom/config";
import { mainEventHandler } from "../../src/event_handling";
import { Fiber, RootFiber } from "../../src/rendering/fibers";
import { Scheduler } from "../../src/rendering/scheduler";
import { makeTestFixture } from "../helpers";

// read before any test of this file makes an App: what importing owl did
const exposedOnImport = "__OWL_DEVTOOLS__" in window;
const ownTemplatesOnImport = Object.keys(globalTemplates).filter((name) =>
  name.startsWith("__owl__")
);

test("importing owl sets no global and registers no template", () => {
  expect(exposedOnImport).toBe(false);
  expect(ownTemplatesOnImport).toEqual([]);
});

describe("the devtools hook", () => {
  afterEach(() => {
    delete (window as any).__OWL_DEVTOOLS__;
    setDebug(false);
    setDebugSink(null);
    for (const app of [...App.apps]) {
      app.destroy();
    }
  });

  test("the first App exposes owl to the devtools, with every app, and logs it", () => {
    const lines: string[] = [];
    setDebug(["lifecycle"]);
    setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
    const first = new App();
    const exposed = (window as any).__OWL_DEVTOOLS__;
    expect(exposed).toEqual({ apps: App.apps, Fiber, RootFiber, toRaw, proxy });
    expect(exposed.apps).toBe(App.apps);
    expect(lines).toEqual(["lifecycle: window.__OWL_DEVTOOLS__ set"]);
    const second = new App();
    expect((window as any).__OWL_DEVTOOLS__).toBe(exposed);
    expect([...exposed.apps]).toEqual([first, second]);
  });

  test("a hook that watches the property before the first App sees it set then", () => {
    // what tools/devtools' page hook does when it loads before owl
    let value: any;
    const seen: any[] = [];
    Object.defineProperty(window, "__OWL_DEVTOOLS__", {
      configurable: true,
      get: () => value,
      set: (next) => {
        value = next;
        seen.push(next);
      },
    });
    expect(seen).toEqual([]);
    const app = new App();
    expect(seen.length).toBe(1);
    expect(seen[0].apps.has(app)).toBe(true);
    new App();
    expect(seen.length).toBe(1);
  });

  test("another owl's value is kept", () => {
    const other = { apps: new Set() };
    (window as any).__OWL_DEVTOOLS__ = other;
    new App();
    expect((window as any).__OWL_DEVTOOLS__).toBe(other);
  });
});

describe("owl's own templates", () => {
  test("are made on their first read, under a name of their own", () => {
    for (const C of [ErrorBoundary, Portal, Suspense]) {
      expect(Object.getOwnPropertyDescriptor(C, "template")!.get).toBeDefined();
      const name = C.template;
      expect(name).toBe(`__owl__${C.name}`);
      expect(typeof globalTemplates[name]).toBe("string");
      expect(Object.getOwnPropertyDescriptor(C, "template")).toEqual({
        value: name,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  });

  test("survive xml's counter being reset", async () => {
    class Boundary extends ErrorBoundary {}
    class Root extends Component {
      static template = xml`<Boundary><p>ok</p></Boundary>`;
      static components = { Boundary };
    }
    xml.nextId = 1;
    const fixture = makeTestFixture();
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<p>ok</p>");
    xml`<span>another</span>`;
    xml.nextId = 1;
    const second = makeTestFixture();
    await mount(Root, second);
    expect(second.innerHTML).toBe("<p>ok</p>");
  });
});

test("blockdom's event handler is owl's from the start", () => {
  expect(config.mainEventHandler).toBe(mainEventHandler);
});

test("the scheduler renders on the requestAnimationFrame of module evaluation", async () => {
  // HOOT replaces window.requestAnimationFrame with its mocked clock after it
  // imported owl; owl must keep rendering on the real frames
  const replaced = window.requestAnimationFrame;
  const mocked: FrameRequestCallback[] = [];
  window.requestAnimationFrame = (cb) => mocked.push(cb);
  try {
    class Counter extends Component {
      static template = xml`<i t-out="this.state.n"/>`;
      state = proxy({ n: 0 });
    }
    const app = new App();
    expect(app.scheduler.requestAnimationFrame).toBe(Scheduler.requestAnimationFrame);
    const fixture = makeTestFixture();
    const counter = await app.createRoot(Counter).mount(fixture);
    counter.state.n = 1;
    await new Promise((resolve) => setTimeout(resolve));
    await new Promise((resolve) => replaced(resolve));
    expect(fixture.innerHTML).toBe("<i>1</i>");
    expect(mocked).toEqual([]);
    app.destroy();
  } finally {
    window.requestAnimationFrame = replaced;
  }
});
