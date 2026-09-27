import { effect, Plugin, PluginManager, Resource, Scope, types as t } from "../src";
import { waitScheduler } from "./helpers";

const rethrow = (e: unknown) => {
  throw e;
};

test("can add and get values", () => {
  const resource = new Resource();
  expect(resource.items()).toEqual([]);
  resource.add("value");
  expect(resource.items()).toEqual(["value"]);
});

test("can check if it contains values", () => {
  const resource = new Resource();

  expect(resource.has("value")).toBe(false);
  resource.add("value");
  expect(resource.has("value")).toBe(true);
});

test("can add multiple values (chainable)", () => {
  const resource = new Resource();
  expect(resource.items()).toEqual([]);
  resource.add("value").add("other");
  expect(resource.items()).toEqual(["value", "other"]);
});

test("can remove values", () => {
  const resource = new Resource();
  resource.add("a").add("b").add("c").add("d");
  expect(resource.items()).toEqual(["a", "b", "c", "d"]);
  resource.delete("b");
  expect(resource.items()).toEqual(["a", "c", "d"]);
  resource.delete("a").delete("d");
  expect(resource.items()).toEqual(["c"]);
});

test("can remove every value", () => {
  const resource = new Resource();
  resource.add("a").add("b");
  resource.clear();
  expect(resource.items()).toEqual([]);
  expect(resource.has("a")).toBe(false);
  resource.add("c");
  expect(resource.items()).toEqual(["c"]);
});

test("clear notifies effects", async () => {
  const resource: Resource<string> = new Resource();
  resource.add("a");
  const steps: string[][] = [];

  effect(() => {
    steps.push(resource.items());
  });
  expect(steps).toEqual([["a"]]);
  resource.clear();
  await waitScheduler();
  expect(steps).toEqual([["a"], []]);
});

test("sequence", async () => {
  const resource = new Resource<string>({ name: "r" });

  resource.add("a", { sequence: 10 });
  resource.add("b"); // default = 50
  resource.add("c", { sequence: 14 });
  resource.add("d", { sequence: 100 });

  const items = resource.items;
  expect(items()).toEqual(["a", "c", "b", "d"]);
});

test("items and effects", async () => {
  const resource: Resource<string> = new Resource();

  resource.add("a");
  const items = resource.items;
  const steps: string[] = [];

  effect(() => {
    steps.push(...items());
  });
  expect(steps).toEqual(["a"]);
  resource.add("b");
  expect(steps).toEqual(["a"]);
  await waitScheduler();
  expect(steps).toEqual(["a", "a", "b"]);
});

test("validation schema", async () => {
  const resource = new Resource({
    name: "test",
    validation: t.object({
      blip: t.string(),
    }),
  });

  resource.add({ blip: "asdf" });
  expect(() => {
    resource.add({ blip: 1 } as any);
  }).toThrow("Resource item does not match the type");
});

test("validation schema, with a class", async () => {
  class A {}
  class B {}

  const resource = new Resource({
    name: "test",
    validation: t.instanceOf(A),
  });

  resource.add(new A());
  expect(() => {
    resource.add(new B());
  }).toThrow("Resource item does not match the type");
});

test("do not bind signals on add", async () => {
  const steps: string[] = [];

  const resource = new Resource<string>();
  effect(() => {
    resource.add("a");
    steps.push("a is added");
  });
  expect(steps.splice(0)).toEqual(["a is added"]);

  resource.add("b");
  await waitScheduler();
  expect(steps.splice(0)).toEqual([]);
});

test("do not bind signals on delete", async () => {
  const steps: string[] = [];

  const resource = new Resource<string>();
  effect(() => {
    resource.delete("a");
    steps.push("a is deleted");
  });
  expect(steps.splice(0)).toEqual(["a is deleted"]);

  resource.add("b");
  await waitScheduler();
  expect(steps.splice(0)).toEqual([]);
});

test("do not bind signals on clear", async () => {
  const steps: string[] = [];

  const resource = new Resource<string>();
  effect(() => {
    resource.clear();
    steps.push("resource is cleared");
  });
  expect(steps.splice(0)).toEqual(["resource is cleared"]);

  resource.add("b");
  await waitScheduler();
  expect(steps.splice(0)).toEqual([]);
});

test("a resource created in a scope keeps updating after the scope is destroyed", async () => {
  const scope = new Scope({});
  const resource = scope.run(() => new Resource<number>());
  const seen: number[][] = [];
  effect(() => {
    seen.push(resource.items().slice());
  });
  resource.add(1);
  await waitScheduler();
  scope.finalize(rethrow);
  resource.add(2);
  await waitScheduler();
  expect(seen).toEqual([[], [1], [1, 2]]);
});

test("reading items does not reorder the stored entries", async () => {
  const resource = new Resource<string>();
  resource.add("b").add("a", { sequence: 10 });
  let runs = 0;
  effect(() => {
    resource.has("b");
    runs++;
  });
  expect(resource.items()).toEqual(["a", "b"]);
  await waitScheduler();
  expect(runs).toBe(1);
});

describe("use()", () => {
  test("throws when called outside a component/plugin context", () => {
    const resource = new Resource<string>();
    expect(() => resource.use("red")).toThrow("No active scope");
  });

  test("does not mutate when called outside a context", () => {
    const resource = new Resource<string>();
    expect(() => resource.use("red")).toThrow();
    expect(resource.has("red")).toBe(false);
    expect(resource.items()).toEqual([]);
  });

  test("adds within plugin setup and removes on plugin destroy", () => {
    const shared = new Resource<string>();

    class A extends Plugin {
      setup() {
        shared.use("red");
      }
    }

    const manager = new PluginManager({});
    manager.startPlugins([A]);
    expect(shared.items()).toEqual(["red"]);

    manager.destroy();
    expect(shared.items()).toEqual([]);
  });

  test("is chainable", () => {
    const shared = new Resource<string>();

    class A extends Plugin {
      setup() {
        shared.use("a").use("b").use("c");
      }
    }

    const manager = new PluginManager({});
    manager.startPlugins([A]);
    expect(shared.items()).toEqual(["a", "b", "c"]);

    manager.destroy();
    expect(shared.items()).toEqual([]);
  });

  test("respects sequence option", () => {
    const shared = new Resource<string>();

    class A extends Plugin {
      setup() {
        shared.use("a", { sequence: 100 });
        shared.use("b", { sequence: 10 });
        shared.use("c");
      }
    }

    const manager = new PluginManager({});
    manager.startPlugins([A]);
    expect(shared.items()).toEqual(["b", "c", "a"]);
  });

  test("only items from destroyed scope are removed", () => {
    const shared = new Resource<string>();

    class A extends Plugin {
      setup() {
        shared.use("a");
      }
    }
    class B extends Plugin {
      setup() {
        shared.use("b");
      }
    }

    const app = {};
    const parent = new PluginManager(app);
    parent.startPlugins([A]);

    const child = new PluginManager(app, { parent });
    child.startPlugins([B]);
    expect(shared.items()).toEqual(["a", "b"]);

    child.destroy();
    expect(shared.items()).toEqual(["a"]);

    parent.destroy();
    expect(shared.items()).toEqual([]);
  });

  test("an item used by two scopes stays until both are destroyed", () => {
    const shared = new Resource<string>();
    const app = {};
    const a = new Scope(app);
    const b = new Scope(app);
    a.run(() => shared.use("x"));
    b.run(() => shared.use("x"));
    expect(shared.items()).toEqual(["x", "x"]);
    a.finalize(rethrow);
    expect(shared.items()).toEqual(["x"]);
    b.finalize(rethrow);
    expect(shared.items()).toEqual([]);
  });
});
