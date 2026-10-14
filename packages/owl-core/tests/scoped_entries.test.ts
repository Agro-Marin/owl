import {
  effect,
  immediateEffect,
  Plugin,
  PluginManager,
  Registry,
  Resource,
  setDebug,
  setDebugSink,
  signal,
  types as t,
} from "../src";
import { TestScope, waitScheduler } from "./helpers";

const rethrow = (error: unknown) => {
  throw error;
};

const stores = [
  {
    name: "Resource",
    create() {
      const store = new Resource<string>().add("permanent");
      return { items: store.items, use: () => store.use("scoped") };
    },
  },
  {
    name: "Registry",
    create() {
      const store = new Registry<string>().add("entry", "permanent");
      return { items: store.items, use: () => store.use("entry", "scoped", { force: true }) };
    },
  },
];

let traces: string[];
beforeEach(() => {
  traces = [];
  setDebugSink((channel, message) => traces.push(`${channel}: ${message}`));
  setDebug("reactivity,effect,computed,scope,plugin");
});
afterEach((context) => {
  if (context.task.result?.state === "fail") console.debug("[owl:scoped-entry-review]", traces);
  setDebug(false);
  setDebugSink(null);
});

describe.each(stores)("$name scoped publication", ({ create }) => {
  test("a throwing immediate reader cannot prevent lifetime cleanup", () => {
    const store = create();
    const scope = new TestScope({});
    const failure = new Error("scoped entry observer failed");
    const stop = immediateEffect(() => {
      if (store.items().includes("scoped")) throw failure;
    });
    try {
      expect(() => scope.run(() => store.use())).toThrow(failure);
      expect(store.items()).toContain("scoped");
      stop();
      scope.finalize(rethrow);
      console.debug("[owl:scoped-entry-review] after failed publication", store.items());
      expect(store.items()).toEqual(["permanent"]);
    } finally {
      stop();
      scope.finalize(rethrow);
    }
  });

  test("plugin setup rollback releases an entry whose publication threw", () => {
    const store = create();
    const manager = new PluginManager({});
    const failure = new Error("scoped entry observer failed");
    const stop = immediateEffect(() => {
      if (store.items().includes("scoped")) throw failure;
    });
    class Contribution extends Plugin {
      setup() {
        store.use();
      }
    }
    try {
      expect(() => manager.startPlugins([Contribution])).toThrow(failure);
      console.debug("[owl:scoped-entry-review] after rollback", store.items());
      expect(store.items()).toEqual(["permanent"]);
    } finally {
      stop();
      manager.destroy();
    }
  });

  test("an immediate reader destroying the owner observes completed cleanup", () => {
    const store = create();
    const scope = new TestScope({});
    let afterDestroy: string[] | undefined;
    const stop = immediateEffect(() => {
      if (store.items().includes("scoped")) {
        scope.finalize(rethrow);
        afterDestroy = store.items().slice();
      }
    });
    try {
      scope.run(() => store.use());
      console.debug("[owl:scoped-entry-review] reentrant destruction", afterDestroy, store.items());
      expect(afterDestroy).toEqual(["permanent"]);
      expect(store.items()).toEqual(["permanent"]);
    } finally {
      stop();
      scope.finalize(rethrow);
    }
  });
});

test.each(["Resource", "Registry"])(
  "%s does not publish an entry after its option getter destroys its owner",
  (name) => {
    const store = mutableStore(name);
    const scope = new TestScope({});
    const seen: unknown[][] = [];
    const stop = immediateEffect(() => {
      seen.push(store.items().slice());
    });
    try {
      scope.run(() =>
        store.use("expired", {
          get sequence() {
            scope.finalize(rethrow);
            return 50;
          },
        })
      );
      expect(store.items()).toEqual([]);
      expect(seen.every((items) => !items.includes("expired"))).toBe(true);
    } finally {
      stop();
      scope.finalize(rethrow);
    }
  }
);

function mutableStore(name: string, validation?: unknown) {
  const options = { validation };
  if (name === "Resource") {
    const store = new Resource<unknown>(options);
    return {
      items: store.items,
      add: (value: unknown, config: { sequence?: number; force?: boolean }) =>
        store.add(value, config),
      use: (value: unknown, config: { sequence?: number; force?: boolean }) =>
        store.use(value, config),
    };
  }
  const store = new Registry<unknown>(options);
  return {
    items: store.items,
    add: (value: unknown, config: { sequence?: number; force?: boolean }) =>
      store.add("entry", value, config),
    use: (value: unknown, config: { sequence?: number; force?: boolean }) =>
      store.use("entry", value, config),
  };
}

describe.each(["Resource", "Registry"])("%s mutation inputs", (name) => {
  test.each(["add", "use"] as const)(
    "%s does not subscribe to validation getters",
    async (method) => {
      const tick = signal(0);
      const value = {
        get label() {
          tick();
          return "valid";
        },
      };
      const store = mutableStore(name, t.object({ label: t.string() }));
      const scope = new TestScope({});
      let runs = 0;
      const stop = immediateEffect(() => {
        runs++;
        if (method === "use") scope.run(() => store.use(value, { force: true }));
        else store.add(value, { force: true });
      });
      try {
        tick.set(1);
        await waitScheduler();
        console.debug("[owl:entry-input-review] validation", name, method, runs);
        expect(runs).toBe(1);
      } finally {
        stop();
        scope.finalize(rethrow);
      }
    }
  );

  test.each(["add", "use"] as const)("%s does not subscribe to option getters", async (method) => {
    const tick = signal(0);
    const store = mutableStore(name);
    const scope = new TestScope({});
    const options = {
      get sequence() {
        tick();
        return 20;
      },
      get force() {
        tick();
        return true;
      },
    };
    let runs = 0;
    const stop = immediateEffect(() => {
      runs++;
      if (method === "use") scope.run(() => store.use("value", options));
      else store.add("value", options);
    });
    try {
      tick.set(1);
      await waitScheduler();
      console.debug("[owl:entry-input-review] options", name, method, runs);
      expect(runs).toBe(1);
    } finally {
      stop();
      scope.finalize(rethrow);
    }
  });

  test("failed validation does not change entries or install restoration", () => {
    const store = mutableStore(name, t.string());
    store.add("permanent", {});
    const scope = new TestScope({});
    expect(() => scope.run(() => store.use(42, { force: true }))).toThrow();
    scope.finalize(rethrow);
    expect(store.items()).toEqual(["permanent"]);
  });

  test("validation preserves ownership of effects created by a getter", () => {
    let created = 0;
    let cleaned = 0;
    const value = {
      get label() {
        created++;
        effect(() => () => {
          cleaned++;
        });
        return "valid";
      },
    };
    const store = mutableStore(name, t.object({ label: t.string() }));
    const stop = immediateEffect(() => store.add(value, { force: true }));
    expect(created).toBeGreaterThan(0);
    stop();
    expect(cleaned).toBe(created);
  });
});

test.each(["addById", "useById"] as const)("%s captures its id getter once", (method) => {
  const registry = new Registry<{ id: string }>();
  const scope = new TestScope({});
  let reads = 0;
  const value = {
    get id() {
      return ++reads === 1 ? "entry" : "wrong";
    },
  };
  try {
    if (method === "useById") scope.run(() => registry.useById(value));
    else registry.addById(value);
    console.debug(
      "[owl:entry-input-review] id",
      method,
      reads,
      registry.entries().map(([key]) => key)
    );
    expect(reads).toBe(1);
    expect(registry.get("entry")).toBe(value);
    expect(registry.has("wrong")).toBe(false);
  } finally {
    scope.finalize(rethrow);
  }
});

test.each(["addById", "useById"] as const)("%s does not subscribe to its id getter", (method) => {
  const registry = new Registry<{ id: string }>();
  const scope = new TestScope({});
  const tick = signal(0);
  const value = {
    get id() {
      tick();
      return "entry";
    },
  };
  let runs = 0;
  const stop = immediateEffect(() => {
    runs++;
    if (method === "useById") scope.run(() => registry.useById(value, { force: true }));
    else registry.addById(value, { force: true });
  });
  try {
    tick.set(1);
    expect(runs).toBe(1);
  } finally {
    stop();
    scope.finalize(rethrow);
  }
});

test("registry use restores the entry actually replaced after option evaluation", () => {
  const registry = new Registry<string>().add("entry", "original");
  const scope = new TestScope({});
  scope.run(() =>
    registry.use("entry", "scoped", {
      force: true,
      get sequence() {
        registry.add("entry", "replacement", { force: true });
        return 50;
      },
    })
  );
  expect(registry.get("entry")).toBe("scoped");
  scope.finalize(rethrow);
  console.debug("[owl:entry-input-review] restored", registry.get("entry"));
  expect(registry.get("entry")).toBe("replacement");
});

test("registry insertion uses the current storage after an option getter clears it", () => {
  const registry = new Registry<string>().add("original", "original");
  registry.add("entry", "scoped", {
    get sequence() {
      registry.clear();
      return 50;
    },
  });
  console.debug("[owl:entry-input-review] after getter clear", registry.entries());
  expect(registry.entries()).toEqual([["entry", "scoped"]]);
});

test("a key inserted by an option getter still requires force to overwrite", () => {
  const registry = new Registry<string>();
  expect(() =>
    registry.add("entry", "outer", {
      get sequence() {
        registry.add("entry", "inner");
        return 50;
      },
    })
  ).toThrow('Key "entry" is already registered');
  expect(registry.get("entry")).toBe("inner");
});

test("retired scoped overrides cannot replace a newer permanent entry", () => {
  const registry = new Registry<string>().add("entry", "original");
  const scopes = [new TestScope({}), new TestScope({}), new TestScope({})];
  scopes[0].run(() => registry.use("entry", "first", { force: true }));
  scopes[1].run(() => registry.use("entry", "second", { force: true }));
  registry.delete("entry").add("entry", "permanent");
  scopes[2].run(() => registry.use("entry", "third", { force: true }));
  scopes[0].finalize(rethrow);
  scopes[1].finalize(rethrow);
  expect(registry.get("entry")).toBe("third");
  scopes[2].finalize(rethrow);
  expect(registry.get("entry")).toBe("permanent");
});
