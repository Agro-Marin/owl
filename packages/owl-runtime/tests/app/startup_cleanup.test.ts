import {
  App,
  Component,
  onWillDestroy,
  onWillStart,
  Plugin,
  setDebug,
  setDebugSink,
  signal,
  useEffect,
  xml,
} from "../../src";
import { PluginManager, STATUS, useScope } from "@odoo/owl-core";
import { createSubRoot } from "../../src/app";
import { makeTestFixture } from "../helpers";

let lines: string[];

function cleanupNewApps(previous: Set<App>) {
  for (const app of App.apps) {
    if (!previous.has(app)) {
      // Failed configuration can leave the old implementation registered
      // before its manager exists. Keep fail-before checks isolated too.
      if (app.pluginManager) App.prototype.destroy.call(app);
      else App.apps.delete(app);
    }
  }
}

beforeEach(() => {
  lines = [];
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
  setDebug(["plugin", "scope", "lifecycle", "effect"]);
});

afterEach((context) => {
  if (context.task.result?.state === "fail") {
    console.debug("[owl:startup-cleanup-test]", lines);
  }
  setDebug(false);
  setDebugSink(null);
});

test("failed synchronous plugin startup unregisters the app and releases earlier plugins", () => {
  const apps = new Set(App.apps);
  const boom = new Error("startup failed");
  const count = signal(0);
  let runs = 0;
  let cleaned = 0;
  class First extends Plugin {
    static sequence = 1;
    setup() {
      useEffect(() => {
        count();
        runs++;
        return () => {
          cleaned++;
        };
      });
    }
  }
  class Bad extends Plugin {
    static sequence = 2;
    setup() {
      throw boom;
    }
  }
  try {
    expect(() => new App({ test: true, plugins: [First, Bad] })).toThrow(boom);
    expect(new Set(App.apps)).toEqual(apps);
    expect([runs, cleaned]).toEqual([1, 1]);
    expect(lines.some((line) => line.includes("destroy app"))).toBe(true);
  } finally {
    cleanupNewApps(apps);
  }
});

test("failed startup of an App subclass releases plugins without calling a not-yet-initialized override", () => {
  const before = new Set(App.apps);
  const boom = new Error("plugin setup failed");
  let cleaned = 0;
  let overrideCalls = 0;
  class First extends Plugin {
    static sequence = 1;
    setup() {
      useEffect(() => () => {
        cleaned++;
      });
    }
  }
  class Bad extends Plugin {
    setup() {
      throw boom;
    }
  }
  class CustomApp extends App {
    initialized = true;
    destroy() {
      overrideCalls++;
      if (!this.initialized) throw new Error("derived fields are not initialized");
      super.destroy();
    }
  }
  try {
    expect(() => new CustomApp({ test: true, plugins: [First, Bad] })).toThrow(boom);
    expect(new Set(App.apps)).toEqual(before);
    expect(cleaned).toBe(1);
    expect(overrideCalls).toBe(0);
  } finally {
    cleanupNewApps(before);
  }
});

test.each(["plugins", "config"] as const)(
  "a throwing %s config getter does not retain the App",
  (key) => {
    const before = new Set(App.apps);
    const boom = new Error("config getter failed");
    const config = { test: true };
    Object.defineProperty(config, key, {
      get() {
        throw boom;
      },
    });
    try {
      expect(() => new App(config)).toThrow(boom);
      expect(new Set(App.apps)).toEqual(before);
    } finally {
      cleanupNewApps(before);
    }
  }
);

test("a throwing plugin manager destroy still unregisters the app and clears its scheduler", () => {
  const app = new App({ test: true });
  const boom = new Error("plugin destruction failed");
  app.scheduler.tasks.add({} as any);
  const destroy = app.pluginManager.destroy.bind(app.pluginManager);
  app.pluginManager.destroy = () => {
    destroy();
    throw boom;
  };
  try {
    expect(() => app.destroy()).toThrow(boom);
    expect(App.apps.has(app)).toBe(false);
    expect(app.scheduler.tasks.size).toBe(0);
    expect(app.destroyed).toBe(true);
  } finally {
    app.pluginManager.destroy = destroy;
    app.destroy();
  }
});

test("the App reads the test flag before startup rather than again after registration", () => {
  const before = new Set(App.apps);
  let reads = 0;
  const config = {};
  Object.defineProperty(config, "test", {
    get() {
      if (++reads > 1) throw new Error("test config was read twice");
      return true;
    },
  });
  let app: App | undefined;
  try {
    app = new App(config);
    expect(reads).toBe(1);
    expect(app.dev).toBe(true);
  } finally {
    cleanupNewApps(before);
  }
});

test("a destroyed sub-root releases its prepare waiter even when destruction throws", async () => {
  const boom = new Error("sub-root cleanup failed");
  class Waiting extends Component {
    static template = xml`<p/>`;
    setup() {
      onWillStart(() => new Promise<void>(() => {}));
      onWillDestroy(() => {
        throw boom;
      });
    }
  }
  const app = new App({ test: true });
  const root = createSubRoot(app, Waiting, {
    onError(error) {
      throw error;
    },
  });
  let settled = false;
  void root.prepare().then(() => {
    settled = true;
  });
  try {
    expect(root.prepared).toBe(false);
    expect(() => root.destroy()).toThrow(boom);
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(root.destroyed).toBe(true);
  } finally {
    app.destroy();
  }
});

test("a sub-root's constructor and setup see the supplied plugin manager", () => {
  const app = new App({ test: true });
  const manager = new PluginManager(app, { parent: app.pluginManager });
  const seen: unknown[] = [];
  class Child extends Component {
    static template = xml`<p/>`;
    initialManager = useScope().pluginManager;
    setup() {
      seen.push(this.initialManager, useScope().pluginManager);
    }
  }
  const root = createSubRoot(app, Child, { pluginManager: manager });
  try {
    expect(seen).toEqual([manager, manager]);
  } finally {
    root.destroy();
    app.destroy();
    manager.destroy();
  }
});

test("a sub-root awaits the supplied plugin manager before rendering", async () => {
  const app = new App({ test: true });
  const manager = new PluginManager(app, { parent: app.pluginManager });
  const ready = Promise.withResolvers<void>();
  manager.config.label = "not ready";
  manager.ready = ready.promise.then(() => {
    manager.config.label = "ready";
    manager.status = STATUS.MOUNTED;
  });
  class Child extends Component {
    static template = xml`<p t-out="this.label"/>`;
    get label() {
      return this.__owl__.pluginManager.config.label;
    }
  }
  const root = createSubRoot(app, Child, { pluginManager: manager });
  const fixture = makeTestFixture();
  try {
    const mounted = root.mount(fixture);
    expect(root.prepared).toBe(false);
    ready.resolve();
    await mounted;
    expect(fixture.innerHTML).toBe("<p>ready</p>");
  } finally {
    root.destroy();
    app.destroy();
    manager.destroy();
  }
});
