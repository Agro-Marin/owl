import { describe, expect, test } from "vitest";
import {
  App,
  Component,
  computed,
  config,
  effect,
  mount,
  onWillDestroy,
  onWillStart,
  plugin,
  Plugin,
  PluginInstance,
  providePlugins,
  Resource,
  signal,
  status,
  types as t,
  useListener,
  xml,
} from "../src";
import {
  atomSymbol,
  Atom,
  observersOf,
  PluginManager,
  setDebug,
  setDebugSink,
  types,
} from "@odoo/owl-core";
import { STATUS } from "../src/status";
import { makeDeferred, makeTestFixture, nextMicroTick, nextTick, waitScheduler } from "./helpers";

describe("basic features", () => {
  test("can instantiate and destroy a plugin", () => {
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup");
        onWillDestroy(() => {
          steps.push("destroy");
        });
      }
    }

    const manager = new PluginManager(new App());
    expect(steps.splice(0)).toEqual([]);

    manager.startPlugins([A]);
    expect(steps.splice(0)).toEqual(["setup"]);

    manager.destroy();
    expect(steps.splice(0)).toEqual(["destroy"]);
  });

  test("can start plugins directly from constructor", () => {
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup");
        onWillDestroy(() => {
          steps.push("destroy");
        });
      }
    }

    const manager = new PluginManager(new App());
    expect(steps.splice(0)).toEqual([]);

    manager.startPlugins([A]);
    expect(steps.splice(0)).toEqual(["setup"]);

    manager.destroy();
    expect(steps.splice(0)).toEqual(["destroy"]);
  });

  test("can set a custom id", () => {
    class A extends Plugin {
      static id = "plugin-id";
    }
    const pm = new PluginManager(new App());
    pm.startPlugins([A]);
    expect(pm.getPluginById("A")).toBe(null);
    expect(pm.getPluginById("plugin-id")).toBeInstanceOf(A);
  });

  test("fails if plugins has falsy id", () => {
    class A extends Plugin {
      static id = "";
    }
    expect(() => new PluginManager(new App()).startPlugins([A])).toThrow(`Plugin "A" has no id`);
  });

  test("can get a plugin", () => {
    let a;
    let isDestroyed = false;

    class A extends Plugin {
      static id = "a";

      setup() {
        a = this;
        onWillDestroy(() => (isDestroyed = true));
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A]);
    const plugin = manager.getPluginById("a");
    expect(plugin).toBe(a);
    expect(isDestroyed).toBe(false);

    manager.destroy();
    expect(isDestroyed).toBe(true);
  });

  test("can get a plugin with no setup and no id", () => {
    class P extends Plugin {
      value = 1;
    }

    class A extends Plugin {
      p = plugin(P);
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A]);
    const a = manager.getPlugin(A)!;
    expect(a.p.value).toBe(1);
  });

  test("fails if trying to start two plugin with the same id", () => {
    class A extends Plugin {
      static id = "plugin";
    }
    class B extends Plugin {
      static id = "plugin";
    }
    expect(() => new PluginManager(new App()).startPlugins([A, B])).toThrow(
      `Trying to start a plugin with the same id as an other plugin (id: 'plugin', existing plugin: 'A', starting plugin: 'B')`
    );
  });

  test("plugin depending on another plugin with the same id (start only A, B is started implicitly)", () => {
    class A extends Plugin {
      static id = "plugin";
      b = plugin(B);
    }
    class B extends Plugin {
      static id = "plugin";
    }
    expect(() => new PluginManager(new App()).startPlugins([A])).not.toThrow();
  });

  test("plugin depending on another plugin with the same id (start A and B)", () => {
    class A extends Plugin {
      static id = "plugin";
      b = plugin(B);
    }
    class B extends Plugin {
      static id = "plugin";
    }
    expect(() => new PluginManager(new App()).startPlugins([A, B])).toThrow(
      `Trying to start a plugin with the same id as an other plugin (id: 'plugin', existing plugin: 'A', starting plugin: 'B')`
    );
  });

  test("plugin depending on another plugin with the same id (start B then A)", () => {
    class A extends Plugin {
      static id = "plugin";
      b = plugin(B);
    }
    class B extends Plugin {
      static id = "plugin";
    }
    expect(() => new PluginManager(new App()).startPlugins([B, A])).toThrow(
      `Trying to start a plugin with the same id as an other plugin (id: 'plugin', existing plugin: 'B', starting plugin: 'A')`
    );
  });

  test("a plugin whose setup throws is not left registered", () => {
    let fail = true;
    class A extends Plugin {
      value = "";
      setup() {
        if (fail) {
          throw new Error("setup failed");
        }
        this.value = "ready";
      }
    }

    const manager = new PluginManager(new App());
    expect(() => manager.startPlugins([A])).toThrow("setup failed");
    expect(manager.getPlugin(A)).toBe(null);

    fail = false;
    manager.startPlugins([A]);
    expect(manager.getPlugin(A)!.value).toBe("ready");
    manager.destroy();
  });

  test("destroy order is reverse of setup order", () => {
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup A");
        onWillDestroy(() => {
          steps.push("destroy A");
        });
      }
    }
    class B extends Plugin {
      setup() {
        steps.push("setup B");
        onWillDestroy(() => {
          steps.push("destroy B");
        });
      }
    }

    const manager = new PluginManager(new App());
    expect(steps.splice(0)).toEqual([]);

    manager.startPlugins([A, B]);
    expect(steps.splice(0)).toEqual(["setup A", "setup B"]);

    manager.destroy();
    expect(steps.splice(0)).toEqual(["destroy B", "destroy A"]);
  });

  test("plugins do not start twice", () => {
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup");
      }
    }

    const manager = new PluginManager(new App());
    expect(steps.splice(0)).toEqual([]);

    manager.startPlugins([A, A]);
    expect(steps.splice(0)).toEqual(["setup"]);
  });

  test("plugin can have dependencies", () => {
    const steps: string[] = [];
    let a = null;
    let b = null;

    class A extends Plugin {
      static id = "a";
      setup() {
        a = this;
        steps.push("setup A");
      }
    }

    class B extends Plugin {
      static id = "b";

      a = plugin(A);
      setup() {
        b = this;
        steps.push("setup B");
      }
    }

    class C extends Plugin {
      static id = "c";

      a = plugin(A);
      b = plugin(B);
      setup() {
        steps.push("setup C");
      }
    }

    const manager = new PluginManager(new App());
    expect(steps.splice(0)).toEqual([]);

    manager.startPlugins([A, B, C]);
    expect(steps.splice(0)).toEqual(["setup A", "setup B", "setup C"]);
    expect(manager.getPluginById<B>("b")!.a).toBe(a);
    expect(manager.getPluginById<C>("c")!.a).toBe(a);
    expect(manager.getPluginById<C>("c")!.b).toBe(b);
  });

  test("can get plugins from pluginmanager", () => {
    let a = null;

    class A extends Plugin {
      static id = "a";
      setup() {
        a = this;
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A]);
    expect(manager.getPluginById<A>("a")).toBe(a);
    expect(manager.getPluginById<A>("b")).toBe(null);
    expect(manager.getPlugin(A)).toBe(a);
  });

  test("plugin auto start dependencies", () => {
    const steps: string[] = [];
    let a = null;
    let b = null;

    class A extends Plugin {
      static id = "a";
      setup() {
        a = this;
        steps.push("setup A");
      }
    }

    class B extends Plugin {
      static id = "b";

      a = plugin(A);
      setup() {
        b = this;
        steps.push("setup B");
      }
    }

    class C extends Plugin {
      static id = "c";

      b = plugin(B);
      a = plugin(A);
      setup() {
        steps.push("setup C");
      }
    }

    const manager = new PluginManager(new App());
    expect(steps.splice(0)).toEqual([]);

    manager.startPlugins([C]); // note that we only start plugin C
    expect(steps.splice(0)).toEqual(["setup A", "setup B", "setup C"]);
    expect(manager.getPluginById<B>("b")!.a).toBe(a);
    expect(manager.getPluginById<C>("c")!.a).toBe(a);
    expect(manager.getPluginById<C>("c")!.b).toBe(b);
  });

  test("dependency can be set in setup", () => {
    let a = null;

    class A extends Plugin {
      setup() {
        a = this;
      }
    }

    class B extends Plugin {
      static id = "b";

      declare a: PluginInstance<typeof A>;
      setup() {
        this.a = plugin(A);
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([B]);
    expect(manager.getPluginById<B>("b")!.a).toBe(a);
  });

  test("plugin fn cannot be called outside Plugin and Component", () => {
    class A extends Plugin {}
    expect(() => plugin(A)).toThrow(`No active scope`);
  });

  test("plugin lifecycle", () => {
    class A extends Plugin {}
    const manager = new PluginManager(new App());
    expect(manager.status).toBe(STATUS.NEW);

    manager.startPlugins([A]);
    const a = manager.getPlugin(A)!;
    expect(manager.status).toBe(STATUS.MOUNTED);
    expect(status(a)).toBe("started");

    manager.destroy();
    expect(manager.status).toBe(STATUS.DESTROYED);
    expect(status(a)).toBe("destroyed");
  });

  test("resource can be used to start plugins", async () => {
    const steps: string[] = [];

    class PluginA extends Plugin {
      setup(): void {
        steps.push("PluginA.setup");
      }
    }
    class PluginB extends Plugin {
      setup(): void {
        steps.push("PluginB.setup");
      }
    }

    const plugins = new Resource({ validation: t.constructor(Plugin) }).add(PluginA);
    const app = new App({ plugins });
    expect(steps.splice(0)).toEqual(["PluginA.setup"]);

    plugins.add(PluginB);
    await nextMicroTick();
    expect(steps.splice(0)).toEqual(["PluginB.setup"]);

    app.destroy();
  });

  test("config can be given from app", async () => {
    const steps: string[] = [];

    class PluginA extends Plugin {
      input = config("input");
      defaulted = config("defaulted", types.string().optional("default"));

      setup(): void {
        steps.push(`PluginA - ${this.input} - ${this.defaulted}`);
      }
    }

    const plugins = new Resource({ validation: t.constructor(Plugin) }).add(PluginA);
    const app = new App({ plugins, config: { input: "hello" } });
    expect(steps.splice(0)).toEqual(["PluginA - hello - default"]);

    app.destroy();
  });

  test("plugins given to a test app validate their config as in dev mode", () => {
    class PluginA extends Plugin {
      x = config("x", t.number());
    }

    expect(() => new App({ test: true, plugins: [PluginA], config: { x: "str" } })).toThrow(
      "Config does not match the type"
    );
  });

  test("config default can be declared in the type (.optional(value))", async () => {
    const steps: string[] = [];

    class PluginA extends Plugin {
      defaulted = config("defaulted", types.string().optional("default"));
      given = config("given", types.string().optional("unused"));

      setup(): void {
        steps.push(`PluginA - ${this.defaulted} - ${this.given}`);
      }
    }

    const plugins = new Resource({ validation: t.constructor(Plugin) }).add(PluginA);
    const app = new App({ plugins, config: { given: "hello" } });
    expect(steps.splice(0)).toEqual(["PluginA - default - hello"]);

    app.destroy();
  });
});

describe("sub plugin managers", () => {
  test("basic feature", () => {
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup A");
        onWillDestroy(() => {
          steps.push("destroy A");
        });
      }
    }

    class B extends Plugin {
      setup() {
        steps.push("setup B");
        onWillDestroy(() => {
          steps.push("destroy B");
        });
      }
    }

    const app = new App();
    const manager = new PluginManager(app);
    manager.startPlugins([A]);
    expect(steps.splice(0)).toEqual(["setup A"]);

    const subManager = new PluginManager(app, { parent: manager });
    subManager.startPlugins([B]);
    expect(steps.splice(0)).toEqual(["setup B"]);

    subManager.destroy();
    expect(steps.splice(0)).toEqual(["destroy B"]);

    manager.destroy();
    expect(steps.splice(0)).toEqual(["destroy A"]);
  });

  test("destroying parent plugin manager does not destroy sub managers", () => {
    // The parent keeps no reference to its sub managers (it would retain
    // destroyed ones forever): whoever creates a sub manager destroys it.
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup A");
        onWillDestroy(() => {
          steps.push("destroy A");
        });
      }
    }

    class B extends Plugin {
      setup() {
        steps.push("setup B");
        onWillDestroy(() => {
          steps.push("destroy B");
        });
      }
    }

    const app = new App();
    const manager = new PluginManager(app);
    manager.startPlugins([A]);
    const subManager = new PluginManager(app, { parent: manager });
    subManager.startPlugins([B]);
    expect(steps.splice(0)).toEqual(["setup A", "setup B"]);

    manager.destroy();
    expect(steps.splice(0)).toEqual(["destroy A"]);

    subManager.destroy();
    expect(steps.splice(0)).toEqual(["destroy B"]);
  });

  test("destroyed sub plugin manager is not retained by its parent", async () => {
    const steps: string[] = [];

    class P extends Plugin {
      setup() {
        steps.push("setup P");
        onWillDestroy(() => {
          steps.push("destroy P");
        });
      }
    }

    class Child extends Component {
      static template = xml`child`;
      setup() {
        providePlugins([P]);
      }
    }

    class Root extends Component {
      static components = { Child };
      static template = xml`<Child t-if="this.show()"/>`;
      show = signal(true);
    }

    const fixture = makeTestFixture();
    const app = new App();
    const root = app.createRoot(Root);
    const component = (await root.mount(fixture)) as Root;
    expect(steps.splice(0)).toEqual(["setup P"]);

    for (let i = 0; i < 3; i++) {
      component.show.set(false);
      await nextTick();
      expect(steps.splice(0)).toEqual(["destroy P"]);

      component.show.set(true);
      await nextTick();
      expect(steps.splice(0)).toEqual(["setup P"]);
    }

    // The app-level manager must not accumulate references to the destroyed
    // sub managers (and through them, all their plugin instances).
    expect((app.pluginManager as any)._destroyCbs ?? []).toHaveLength(0);
    app.destroy();
    expect(steps.splice(0)).toEqual(["destroy P"]);
  });

  test("can access plugin in parent manager", () => {
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("setup A");
      }
      someFunction() {
        return 1;
      }
    }

    class B extends Plugin {
      a = plugin(A);
      setup() {
        steps.push("setup B");
        steps.push("value " + this.a.someFunction());
      }
    }

    const app = new App();
    const manager = new PluginManager(app);
    manager.startPlugins([A]);
    expect(steps.splice(0)).toEqual(["setup A"]);

    new PluginManager(app, { parent: manager }).startPlugins([B]);
    expect(steps).toEqual(["setup B", "value 1"]);
  });

  test("plugin can be shadowed", () => {
    class A extends Plugin {
      someFunction() {
        return 1;
      }
    }

    class ShadowA extends Plugin {
      static id = "A";

      someFunction() {
        return 123;
      }
    }

    const app = new App();
    const manager = new PluginManager(app);
    manager.startPlugins([A]);
    expect(manager.getPluginById<A>("A")!.someFunction()).toBe(1);

    const subManager = new PluginManager(app, { parent: manager });
    subManager.startPlugins([ShadowA]);
    expect(subManager.getPluginById<A>("A")!.someFunction()).toBe(123);
  });
});

describe("plugins and resources", () => {
  test("can define a resource type", () => {
    class A extends Plugin {
      colors = new Resource({ name: "colors", validation: t.string() });
    }
    class B extends Plugin {
      a = plugin(A);

      setup() {
        this.a.colors.add("red");
      }
    }
    class C extends Plugin {
      setup() {
        plugin(A).colors.use("green").use("blue");
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A, B, C]);
    const a = manager.getPluginById("A") as A;
    expect(a.colors.items()).toEqual(["red", "green", "blue"]);
  });

  test("resources from child plugins are available in parent plugins", () => {
    class A extends Plugin {
      colors = new Resource({ name: "colors", validation: t.string() });
    }
    class B extends Plugin {
      setup() {
        plugin(A).colors.use("red");
      }
    }
    class C extends Plugin {
      setup() {
        plugin(A).colors.use("green").use("blue");
      }
    }

    const app = new App();
    const manager = new PluginManager(app);
    manager.startPlugins([A, B]);
    const a = manager.getPlugin(A)!;
    expect(a.colors.items()).toEqual(["red"]);

    const subManager = new PluginManager(app, { parent: manager });
    subManager.startPlugins([C]);
    expect(a.colors.items()).toEqual(["red", "green", "blue"]);

    subManager.destroy();
    expect(a.colors.items()).toEqual(["red"]);
  });

  test("resources are derived values, can be seen from effect", async () => {
    class A extends Plugin {
      colors = new Resource({ name: "colors", validation: t.string() });
    }

    class B extends Plugin {
      setup() {
        plugin(A).colors.use("red");
      }
    }
    class C extends Plugin {
      setup() {
        plugin(A).colors.use("green").use("blue");
      }
    }

    const app = new App();
    const manager = new PluginManager(app);
    manager.startPlugins([A, B]);
    const a = manager.getPlugin(A)!;

    const steps: string[] = [];
    effect(() => {
      steps.push(a.colors.items().join(","));
    });
    expect(steps.splice(0)).toEqual(["red"]);

    const subManager = new PluginManager(app, { parent: manager });
    subManager.startPlugins([C]);
    expect(steps.splice(0)).toEqual([]);

    await waitScheduler();
    expect(steps.splice(0)).toEqual(["red,green,blue"]);

    subManager.destroy();
    expect(steps.splice(0)).toEqual([]);

    await waitScheduler();
    expect(steps.splice(0)).toEqual(["red"]);
  });
});

test("destroying a plugin with computed cleans up signal observers", () => {
  const selectedId = signal(0);
  const selectedIdAtom: Atom = (selectedId as any)[atomSymbol];

  class A extends Plugin {
    isSelected = computed(() => selectedId() === 42);
  }

  const manager = new PluginManager(new App());
  manager.startPlugins([A]);
  const a = manager.getPlugin(A)!;

  // Evaluate the computed to establish subscriptions
  a.isSelected();
  expect(observersOf(selectedIdAtom).length).toBe(1);

  manager.destroy();

  // After destruction, the computed should be cleaned up from selectedId's observers
  expect(observersOf(selectedIdAtom).length).toBe(0);
});

describe("onWillStart in plugins", () => {
  test("plugin onWillStart delays app mount", async () => {
    const rpc = makeDeferred<string>();

    class AsyncPlugin extends Plugin {
      static id = "async";
      data: string | null = null;
      setup() {
        onWillStart(async () => {
          this.data = await rpc;
        });
      }
    }

    class Root extends Component {
      static template = xml`<span>ok</span>`;
      p = plugin(AsyncPlugin);
    }

    const fixture = makeTestFixture();
    const app = new App({ plugins: [AsyncPlugin] });
    const mounted = app.createRoot(Root).mount(fixture);
    await nextTick();
    expect(fixture.innerHTML).toBe("");

    rpc.resolve("hello");
    const instance = await mounted;
    expect(instance.p.data).toBe("hello");
    expect(fixture.innerHTML).toBe("<span>ok</span>");
    app.destroy();
  });

  test("mount waits for a plugin that only starts in a later sequence batch", async () => {
    // The root reads state from a plugin (OtherPlugin) that only starts after
    // an async foundational plugin (DataPlugin, lower sequence). mount() must
    // wait for every configured plugin before building the root, otherwise
    // `plugin(OtherPlugin)` in the root's field initializer throws.
    const rpc = makeDeferred<void>();

    class DataPlugin extends Plugin {
      static sequence = 10;
      state = signal<string | null>(null);
      setup() {
        onWillStart(() => rpc.then(() => this.state.set("some state")));
      }
    }

    class OtherPlugin extends Plugin {
      data = plugin(DataPlugin);
    }

    class Root extends Component {
      static template = xml`<t t-out="this.other.data.state().length"/>`;
      other = plugin(OtherPlugin);
    }

    const fixture = makeTestFixture();
    const mounted = mount(Root, fixture, { plugins: [DataPlugin, OtherPlugin] });
    await nextTick();
    expect(fixture.innerHTML).toBe("");

    rpc.resolve();
    const instance = await mounted;
    expect(instance.other.data.state()).toBe("some state");
    expect(fixture.innerHTML).toBe("10");
  });

  test("multiple plugin willStarts run in parallel", async () => {
    const rpc1 = makeDeferred<number>();
    const rpc2 = makeDeferred<number>();
    const started: string[] = [];

    class A extends Plugin {
      static id = "a";
      setup() {
        onWillStart(async () => {
          started.push("a:start");
          await rpc1;
        });
      }
    }
    class B extends Plugin {
      static id = "b";
      setup() {
        onWillStart(async () => {
          started.push("b:start");
          await rpc2;
        });
      }
    }

    const app = new App({ plugins: [A, B] });
    expect(started).toEqual(["a:start", "b:start"]);

    rpc1.resolve(1);
    rpc2.resolve(2);
    await app.pluginManager.ready;
    expect(app.pluginManager.status).toBe(STATUS.MOUNTED);
    app.destroy();
  });

  test("plugin onWillStart rejection rejects mount", async () => {
    class Broken extends Plugin {
      setup() {
        onWillStart(async () => {
          throw new Error("boom");
        });
      }
    }

    class Root extends Component {
      static template = xml``;
    }

    const fixture = makeTestFixture();
    const app = new App({ plugins: [Broken] });
    await expect(app.createRoot(Root).mount(fixture)).rejects.toMatchObject({
      message: "boom",
    });
    app.destroy();
  });

  test("abortSignal passed to plugin willStart aborts on destroy", async () => {
    let captured: AbortSignal | undefined;
    const rpc = makeDeferred<number>();

    class SlowPlugin extends Plugin {
      setup() {
        onWillStart(async ({ abortSignal }) => {
          captured = abortSignal;
          await rpc;
        });
      }
    }

    const app = new App({ plugins: [SlowPlugin] });
    expect(captured!.aborted).toBe(false);

    app.destroy();
    expect(captured!.aborted).toBe(true);
    // Let the pending willStart resolve to avoid leaking its promise.
    rpc.resolve(0);
  });

  test("providePlugins defers owning component render", async () => {
    const rpc = makeDeferred<number>();
    let valueAtChildSetup = -1;

    class AsyncPlugin extends Plugin {
      static id = "async";
      value = 0;
      setup() {
        onWillStart(async () => {
          this.value = await rpc;
        });
      }
    }

    class Child extends Component {
      static template = xml`<span>child</span>`;
      p = plugin(AsyncPlugin);
      setup() {
        valueAtChildSetup = this.p.value;
      }
    }

    class Parent extends Component {
      static template = xml`<Child/>`;
      static components = { Child };
      setup() {
        providePlugins([AsyncPlugin]);
      }
    }

    const fixture = makeTestFixture();
    const app = new App();
    const mounted = app.createRoot(Parent).mount(fixture);
    await nextTick();
    expect(valueAtChildSetup).toBe(-1);
    expect(fixture.innerHTML).toBe("");

    rpc.resolve(42);
    await mounted;
    expect(valueAtChildSetup).toBe(42);
    expect(fixture.innerHTML).toBe("<span>child</span>");
    app.destroy();
  });
});

describe("plugin sequence", () => {
  test("default sequence is 50 and can be overridden", () => {
    class P extends Plugin {}
    class Q extends Plugin {
      static sequence = 10;
    }
    expect(P.sequence).toBe(50);
    expect(Q.sequence).toBe(10);
  });

  test("plugins start in ascending sequence order, array order within a batch", () => {
    const steps: string[] = [];

    class A extends Plugin {
      static sequence = 10;
      setup() {
        steps.push("A");
      }
    }
    class B extends Plugin {
      setup() {
        steps.push("B");
      }
    }
    class C extends Plugin {
      setup() {
        steps.push("C");
      }
    }
    class D extends Plugin {
      static sequence = 100;
      setup() {
        steps.push("D");
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([D, C, B, A]);
    expect(steps).toEqual(["A", "C", "B", "D"]);
  });

  test("all-synchronous batches start synchronously and mount immediately", () => {
    const steps: string[] = [];

    class A extends Plugin {
      static sequence = 10;
      setup() {
        steps.push("A");
      }
    }
    class B extends Plugin {
      setup() {
        steps.push("B");
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([B, A]);
    // no async init: both batches start synchronously, fast path preserved
    expect(steps).toEqual(["A", "B"]);
    expect(manager.status).toBe(STATUS.MOUNTED);
  });

  test("lower-sequence batch fully resolves before next batch starts", async () => {
    const rpc = makeDeferred<string>();
    const steps: string[] = [];

    class Foundation extends Plugin {
      static id = "foundation";
      static sequence = 10;
      data: string | null = null;
      setup() {
        steps.push("foundation:setup");
        onWillStart(async () => {
          steps.push("foundation:willStart");
          this.data = await rpc;
        });
      }
    }

    class Feature extends Plugin {
      foundation = plugin(Foundation);
      setup() {
        steps.push(`feature:setup (data=${this.foundation.data})`);
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([Feature, Foundation]);
    expect(steps.splice(0)).toEqual(["foundation:setup", "foundation:willStart"]);
    expect(manager.getPlugin(Feature)).toBe(null);

    rpc.resolve("hello");
    await manager.ready;
    // Feature's setup only ran once Foundation was fully loaded
    expect(steps.splice(0)).toEqual(["feature:setup (data=hello)"]);
    expect(manager.status).toBe(STATUS.MOUNTED);
    manager.destroy();
  });

  test("same-sequence plugins run their willStarts in parallel", async () => {
    const rpc1 = makeDeferred<number>();
    const rpc2 = makeDeferred<number>();
    const started: string[] = [];

    class A extends Plugin {
      setup() {
        onWillStart(async () => {
          started.push("a:start");
          await rpc1;
        });
      }
    }
    class B extends Plugin {
      setup() {
        onWillStart(async () => {
          started.push("b:start");
          await rpc2;
        });
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A, B]);
    expect(started).toEqual(["a:start", "b:start"]);

    rpc1.resolve(1);
    rpc2.resolve(2);
    await manager.ready;
    expect(manager.status).toBe(STATUS.MOUNTED);
    manager.destroy();
  });

  test("explicit plugin() dependency starts immediately regardless of sequence", () => {
    const steps: string[] = [];

    class Z extends Plugin {
      static sequence = 99;
      setup() {
        steps.push("Z");
      }
    }
    class A extends Plugin {
      static sequence = 10;
      z = plugin(Z);
      setup() {
        steps.push("A");
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A, Z]);
    expect(steps).toEqual(["Z", "A"]);
    expect(manager.status).toBe(STATUS.MOUNTED);
  });

  test("rejection in an early batch skips later batches", async () => {
    const steps: string[] = [];

    class Broken extends Plugin {
      static sequence = 10;
      setup() {
        onWillStart(async () => {
          throw new Error("boom");
        });
      }
    }
    class Feature extends Plugin {
      setup() {
        steps.push("feature:setup");
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([Broken, Feature]);
    await expect(manager.ready).rejects.toMatchObject({ message: "boom" });
    expect(steps).toEqual([]);
    expect(manager.getPlugin(Feature)).toBe(null);
    expect(manager.status).not.toBe(STATUS.MOUNTED);
    manager.destroy();
  });

  test("a later batch does not start once the manager is destroyed", async () => {
    const rpc = makeDeferred<void>();
    const steps: string[] = [];

    class A extends Plugin {
      static sequence = 10;
      setup() {
        onWillStart(() => rpc);
      }
    }
    class B extends Plugin {
      setup() {
        steps.push("B setup");
        onWillDestroy(() => steps.push("B destroy"));
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([A, B]);
    manager.destroy();
    rpc.resolve();
    await manager.ready;
    expect(steps).toEqual([]);
    expect(manager.getPlugin(B)).toBe(null);
  });

  test("status flips to MOUNTED only after the last batch", async () => {
    const rpc = makeDeferred<number>();

    class A extends Plugin {
      static sequence = 10;
      setup() {
        onWillStart(() => rpc);
      }
    }
    class B extends Plugin {}

    const manager = new PluginManager(new App());
    manager.startPlugins([A, B]);
    expect(manager.status).toBe(STATUS.NEW);

    rpc.resolve(1);
    await manager.ready;
    expect(manager.status).toBe(STATUS.MOUNTED);
    manager.destroy();
  });

  test("destroy order is reverse of sequence order", () => {
    const steps: string[] = [];

    class A extends Plugin {
      static sequence = 10;
      setup() {
        onWillDestroy(() => steps.push("destroy A"));
      }
    }
    class B extends Plugin {
      setup() {
        onWillDestroy(() => steps.push("destroy B"));
      }
    }

    const manager = new PluginManager(new App());
    manager.startPlugins([B, A]);
    manager.destroy();
    expect(steps).toEqual(["destroy B", "destroy A"]);
  });

  test("plugin added to resource while startup is pending waits for previous batches", async () => {
    const rpc = makeDeferred<string>();
    const steps: string[] = [];

    class A extends Plugin {
      setup() {
        steps.push("A:setup");
        onWillStart(() => rpc);
      }
    }
    class B extends Plugin {
      setup() {
        steps.push("B:setup");
      }
    }

    const plugins = new Resource({ validation: t.constructor(Plugin) }).add(A);
    const app = new App({ plugins });
    expect(steps.splice(0)).toEqual(["A:setup"]);

    plugins.add(B);
    await nextMicroTick();
    // A's willStart is still pending: B must wait for it
    expect(steps.splice(0)).toEqual([]);

    rpc.resolve("done");
    await app.pluginManager.ready;
    expect(steps.splice(0)).toEqual(["B:setup"]);
    expect(app.pluginManager.status).toBe(STATUS.MOUNTED);
    app.destroy();
  });

  test("sequence works with plugins given to the App", async () => {
    const rpc = makeDeferred<string>();
    const steps: string[] = [];

    class Foundation extends Plugin {
      static sequence = 10;
      setup() {
        onWillStart(() => rpc);
      }
    }
    class Feature extends Plugin {
      setup() {
        steps.push("feature:setup");
      }
    }

    class Root extends Component {
      static template = xml`<span>ok</span>`;
    }

    const fixture = makeTestFixture();
    const app = new App({ plugins: [Feature, Foundation] });
    const mounted = app.createRoot(Root).mount(fixture);
    await nextTick();
    expect(steps.splice(0)).toEqual([]);
    expect(fixture.innerHTML).toBe("");

    rpc.resolve("ok");
    await mounted;
    expect(steps.splice(0)).toEqual(["feature:setup"]);
    expect(fixture.innerHTML).toBe("<span>ok</span>");
    app.destroy();
  });
});

test("can use useListener in a plugin", () => {
  let n: number = 0;
  const bus = new EventTarget();

  class A extends Plugin {
    setup() {
      useListener(bus, "blip", () => n++);
      expect(n).toBe(0);
      bus.dispatchEvent(new Event("blip"));
      expect(n).toBe(1);
    }
  }

  const manager = new PluginManager(new App());
  manager.startPlugins([A]);
  expect(n).toBe(1);

  bus.dispatchEvent(new Event("blip"));
  expect(n).toBe(2);
  manager.destroy();
  expect(n).toBe(2);
  bus.dispatchEvent(new Event("blip"));
  expect(n).toBe(2);
});

describe("plugin start failures and lookups", () => {
  test("a dependency cycle between field initializers throws instead of overflowing", () => {
    class A extends Plugin {
      b: any = plugin(B);
    }
    class B extends Plugin {
      a: any = plugin(A);
    }
    const manager = new PluginManager(new App());
    expect(() => manager.startPlugins([A])).toThrow("Circular plugin dependency: A -> B -> A");
    expect(manager.getPlugin(A)).toBe(null);
    expect(manager.getPlugin(B)).toBe(null);
  });

  test("a setup that throws undoes its willStart, destroy callbacks and dependencies", async () => {
    const steps: string[] = [];
    class Dep extends Plugin {
      setup() {
        onWillDestroy(() => steps.push("dep destroy"));
      }
    }
    class Bad extends Plugin {
      setup() {
        plugin(Dep);
        onWillStart(() => {
          steps.push("bad willStart");
        });
        onWillDestroy(() => steps.push("bad destroy"));
        throw new Error("boom");
      }
    }
    class Later extends Plugin {
      setup() {
        onWillStart(() => {
          steps.push("later willStart");
        });
      }
    }
    const manager = new PluginManager(new App());
    expect(() => manager.startPlugins([Bad])).toThrow("boom");
    expect(steps.splice(0)).toEqual(["bad destroy", "dep destroy"]);
    expect(manager.getPlugin(Dep)).toBe(null);

    manager.startPlugins([Later]);
    await manager.ready;
    manager.destroy();
    expect(steps).toEqual(["later willStart"]);
  });

  test("onWillStart outside a setup throws instead of never running", () => {
    class A extends Plugin {}
    const manager = new PluginManager(new App());
    manager.startPlugins([A]);
    expect(() => manager.run(() => onWillStart(() => {}))).toThrow(
      "onWillStart can only be called while a component or plugin is set up"
    );
  });

  test("a host asking for a provided plugin whose batch still waits gets a clear error; a child gets it loaded", async () => {
    const rpc = makeDeferred<void>();
    class Session extends Plugin {
      static sequence = 10;
      uid = 0;
      setup() {
        onWillStart(async () => {
          await rpc;
          this.uid = 7;
        });
      }
    }
    class Late extends Plugin {
      uidAtSetup = -1;
      setup() {
        this.uidAtSetup = plugin(Session).uid;
      }
    }
    let hostError = "";
    class Child extends Component {
      static template = xml`<span t-out="this.late.uidAtSetup"/>`;
      late = plugin(Late);
    }
    class Root extends Component {
      static template = xml`<Child/>`;
      static components = { Child };
      setup() {
        providePlugins([Session, Late]);
        try {
          plugin(Late);
        } catch (e: any) {
          hostError = e.message;
        }
      }
    }
    const fixture = makeTestFixture();
    const app = new App();
    const mounted = app.createRoot(Root).mount(fixture);
    expect(hostError).toBe(
      'Plugin "Late" is not started yet: its batch waits for the onWillStart of a lower sequence. Use it from a child component, or lower its sequence.'
    );
    rpc.resolve();
    await mounted;
    expect(fixture.innerHTML).toBe("<span>7</span>");
    app.destroy();
  });

  test("a cycle through a setup reports its whole path", () => {
    class A extends Plugin {
      b: any = plugin(B);
    }
    class B extends Plugin {
      setup() {
        plugin(A);
      }
    }
    const manager = new PluginManager(new App());
    expect(() => manager.startPlugins([A])).toThrow("Circular plugin dependency: A -> B -> A");
  });

  test("a plugin with a then method is handed out as itself", () => {
    class Thenable extends Plugin {
      then() {
        throw new Error("called");
      }
    }
    let found: any = null;
    class User extends Plugin {
      setup() {
        found = plugin(Thenable);
      }
    }
    const manager = new PluginManager(new App());
    manager.startPlugins([Thenable, User]);
    expect(found).toBeInstanceOf(Thenable);
  });

  test("usePlugin applies the scoped view of the plugin it finds, not of the one it asked for", () => {
    class Orm extends Plugin {
      static id = "orm";
      static scoped(self: Orm) {
        return { via: "Orm.scoped", self };
      }
    }
    class MockOrm extends Plugin {
      static id = "orm";
    }
    const parent = new PluginManager(new App());
    parent.startPlugins([Orm]);
    const sub = new PluginManager(parent.app, { parent });
    sub.startPlugins([MockOrm]);
    const found: any = sub.run(() => plugin(Orm));
    expect(found).toBeInstanceOf(MockOrm);
  });

  test("a sub manager's config falls back to its parent's", () => {
    const seen: any[] = [];
    class A extends Plugin {
      setup() {
        seen.push(config("url"), config("timeout"));
      }
    }
    const parent = new PluginManager(new App(), { config: { url: "/app", timeout: 10 } });
    const sub = new PluginManager(parent.app, { parent, config: { url: "/sub" } });
    sub.startPlugins([A]);
    expect(seen).toEqual(["/sub", 10]);
    expect(parent.config).toEqual({ url: "/app", timeout: 10 });
  });

  test("a plugin id named like an Object.prototype key is not a plugin", () => {
    class Ctor extends Plugin {
      static id = "constructor";
    }
    const manager = new PluginManager(new App());
    expect(manager.getPluginById("toString")).toBe(null);
    expect(() => manager.run(() => plugin(Ctor))).not.toThrow();
    expect(manager.getPlugin(Ctor)).toBeInstanceOf(Ctor);
  });

  test("starting plugins from an effect does not subscribe it to what they read", async () => {
    const s = signal(0);
    let runs = 0;
    class A extends Plugin {
      setup() {
        s();
      }
    }
    const manager = new PluginManager(new App());
    effect(() => {
      runs++;
      manager.startPlugins([A]);
    });
    expect(runs).toBe(1);
    s.set(1);
    await waitScheduler();
    expect(runs).toBe(1);
  });

  test("destroying an app whose plugin start is aborted rejects nothing unhandled", async () => {
    class Fetching extends Plugin {
      setup() {
        onWillStart(
          ({ abortSignal }) =>
            new Promise((_, reject) =>
              abortSignal.addEventListener("abort", () => reject(abortSignal.reason))
            )
        );
      }
    }
    const app = new App({ plugins: [Fetching] });
    app.destroy();
    await expect(app.pluginManager.ready).resolves.toBeUndefined();
  });

  test("mount() rejects with an AbortError when its app dies while plugins start", async () => {
    let manager!: PluginManager;
    class Fetching extends Plugin {
      setup() {
        manager = this.__owl__;
        onWillStart(
          ({ abortSignal }) =>
            new Promise((_, reject) =>
              abortSignal.addEventListener("abort", () => reject(abortSignal.reason))
            )
        );
      }
    }
    class Root extends Component {
      static template = xml`<div/>`;
    }
    const fixture = makeTestFixture();
    const mounted = mount(Root, fixture, { plugins: [Fetching] });
    manager.app.destroy();
    await expect(mounted).rejects.toMatchObject({ name: "AbortError" });
    expect(fixture.innerHTML).toBe("");
  });

  test("a plugin onWillStart failing after its app was destroyed is dropped, not unhandled", async () => {
    const rpc = makeDeferred<void>();
    class Failing extends Plugin {
      setup() {
        onWillStart(() => rpc);
      }
    }
    const app = new App({ plugins: [Failing] });
    app.destroy();
    rpc.reject(new Error("network down"));
    await expect(app.pluginManager.ready).resolves.toBeUndefined();
  });

  test("a host re-providing a parent's plugin in a waiting batch gets the clear error, not the parent's instance", async () => {
    const rpc = makeDeferred<void>();
    class Session extends Plugin {
      static sequence = 10;
      setup() {
        onWillStart(() => rpc);
      }
    }
    class Shared extends Plugin {
      static id = "shared";
      level = "app";
    }
    class LocalShared extends Plugin {
      static id = "shared";
      level = "local";
    }
    let hostError = "";
    let childLevel = "";
    class Child extends Component {
      static template = xml`<span/>`;
      setup() {
        childLevel = (plugin(Shared) as any).level;
      }
    }
    class Host extends Component {
      static template = xml`<Child/>`;
      static components = { Child };
      setup() {
        providePlugins([Session, LocalShared]);
        try {
          plugin(Shared);
        } catch (e: any) {
          hostError = e.message;
        }
      }
    }
    const fixture = makeTestFixture();
    const app = new App({ plugins: [Shared] });
    const mounted = app.createRoot(Host).mount(fixture);
    expect(hostError).toMatch(/^Plugin "shared" is not started yet/);
    rpc.resolve();
    await mounted;
    expect(childLevel).toBe("local");
    app.destroy();
  });
});

describe("plugin start: cycles, failures, ids", () => {
  test("a cycle through two setups throws instead of handing out a plugin mid-setup", () => {
    class A extends Plugin {
      ready = false;
      setup() {
        plugin(B);
        this.ready = true;
      }
    }
    class B extends Plugin {
      setup() {
        plugin(A);
      }
    }
    const manager = new PluginManager(new App());
    expect(() => manager.startPlugins([A])).toThrow("Circular plugin dependency: A -> B -> A");
    expect(manager.getPlugin(A)).toBe(null);
    expect(manager.getPlugin(B)).toBe(null);
  });

  test("a setup asking for its own plugin is a cycle", () => {
    class A extends Plugin {
      setup() {
        plugin(A);
      }
    }
    expect(() => new PluginManager(new App()).startPlugins([A])).toThrow(
      "Circular plugin dependency: A -> A"
    );
  });

  test("a cycle is logged on the plugin channel", () => {
    class A extends Plugin {
      setup() {
        plugin(A);
      }
    }
    const lines: string[] = [];
    setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
    setDebug(["plugin"]);
    try {
      expect(() => new PluginManager(new App()).startPlugins([A])).toThrow("Circular");
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(lines).toContain("plugin: circular dependency A -> A");
  });

  test("a later batch is no longer pending once the first batch failed synchronously", () => {
    class A extends Plugin {
      static sequence = 10;
      setup() {
        throw new Error("boom");
      }
    }
    class B extends Plugin {
      static sequence = 20;
    }
    const manager = new PluginManager(new App());
    const lines: unknown[][] = [];
    setDebugSink((_channel, message, details) => lines.push([message, ...details]));
    setDebug(["plugin"]);
    try {
      expect(() => manager.startPlugins([A, B])).toThrow("boom");
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(manager.isPending("B")).toBe(false);
    expect(lines).toContainEqual(["start failed, later batches dropped", ["B"]]);
  });

  test("a plugin's id is its class name unless it declares one; a subclass inherits a declared one", () => {
    class Named extends Plugin {}
    class Declared extends Plugin {
      static id = "declared";
    }
    class SubNamed extends Named {}
    class SubDeclared extends Declared {}
    expect([Named.id, Declared.id, SubNamed.id, SubDeclared.id]).toEqual([
      "Named",
      "declared",
      "SubNamed",
      "declared",
    ]);
  });
});
