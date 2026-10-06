import { App, Component, OwlError, TemplateSet, xml } from "../src/runtime";

function makeFixture() {
  const fixture = document.createElement("div");
  document.body.appendChild(fixture);
  return fixture;
}

test("the compiler module makes the runtime build compile templates", async () => {
  class Hello extends Component {
    static template = xml`<div>Hello <t t-out="this.name"/>!</div>`;
    name = "world";
  }
  expect(TemplateSet.compiler).toBe(null);
  await import("../src/compiler");
  expect(TemplateSet.compiler).not.toBe(null);
  const app = new App();
  const fixture = makeFixture();
  await app.createRoot(Hello).mount(fixture);
  expect(fixture.innerHTML).toBe("<div>Hello world!</div>");
  app.destroy();
});

test("a template the compiler module rejects throws the runtime's OwlError", async () => {
  await import("../src/compiler");
  class Broken extends Component {
    static template = xml`<div t-if="this.a" t-elif="this.b"/>`;
  }
  const app = new App();
  const error = await app
    .createRoot(Broken)
    .mount(makeFixture())
    .catch((e) => e);
  expect(error).toBeInstanceOf(OwlError);
  app.destroy();
});

describe("the compiler module's registration", () => {
  const KEY = Symbol.for("@odoo/owl/compiler");

  afterEach(() => {
    TemplateSet.compiler = null;
  });

  test("it registers under a global key, which a runtime of another module instance reads", async () => {
    await import("../src/compiler");
    const registered = (globalThis as any)[KEY];
    expect(registered.version).toBe(App.version);
    TemplateSet.compiler = null;
    expect(TemplateSet.compiler).toBe(registered);
  });

  test("a compiler of another build is refused", async () => {
    await import("../src/compiler");
    const registered = (globalThis as any)[KEY];
    (globalThis as any)[KEY] = { ...registered, hash: "other" };
    try {
      TemplateSet.compiler = null;
      expect(() => TemplateSet.compiler).toThrow(
        `The template compiler module is build ${App.version}+other, but the runtime is ${App.version}+dev`
      );
    } finally {
      (globalThis as any)[KEY] = registered;
    }
  });

  test("an error of the compiler's own OwlError class is rethrown as the runtime's", () => {
    class ForeignError extends Error {}
    TemplateSet.compiler = {
      compile() {
        throw new ForeignError("bad template");
      },
      parseXML() {
        throw new ForeignError("bad xml");
      },
      OwlError: ForeignError,
    };
    const templates = new TemplateSet();
    templates.addTemplate("t", "<div/>");
    let error: any;
    try {
      templates.getTemplate("t");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OwlError);
    expect(error.message).toBe("bad template");
    expect(error.cause).toBeInstanceOf(ForeignError);
    expect(() => templates.addTemplates("<templates/>")).toThrow(OwlError);
  });
});
