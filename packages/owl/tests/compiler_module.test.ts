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
  const BUILD = `${App.version}+dev`;
  const registry = () => (globalThis as any)[KEY];

  afterEach(() => {
    TemplateSet.compiler = undefined;
  });

  test("it registers under its build, where a runtime of another module instance reads it", async () => {
    await import("../src/compiler");
    const registered = registry()[BUILD];
    expect(registered.version).toBe(App.version);
    expect(registered.hash).toBe("dev");
    TemplateSet.compiler = undefined;
    expect(TemplateSet.compiler).toBe(registered);
  });

  test("a runtime takes its own build's compiler beside another build's, and only that", async () => {
    await import("../src/compiler");
    const own = registry()[BUILD];
    const other = { ...own, hash: "other" };
    registry()[`${App.version}+other`] = other;
    try {
      TemplateSet.compiler = undefined;
      expect(TemplateSet.compiler).toBe(own);
      delete registry()[BUILD];
      TemplateSet.compiler = undefined;
      expect(TemplateSet.compiler).toBe(null);
      const templates = new TemplateSet();
      templates.addTemplate("t", "<div/>");
      expect(() => templates.getTemplate("t")).toThrow(
        `Unable to compile a template: load the compiler module (@odoo/owl/compiler) of this runtime's build or use the full build (the runtime is ${BUILD}; the compiler modules loaded are ${App.version}+other)`
      );
    } finally {
      delete registry()[`${App.version}+other`];
      registry()[BUILD] = own;
    }
  });

  test("a compiler set by hand is checked to be of the runtime's build", async () => {
    await import("../src/compiler");
    const own = registry()[BUILD];
    // the compiler module of an older owl sets TemplateSet.compiler to this
    expect(() => {
      TemplateSet.compiler = { compile: own.compile, parseXML: own.parseXML };
    }).toThrow(
      `The template compiler does not name its build, as the compiler module of an owl older than this runtime (${BUILD}) does: load the owl.compiler.es.js built with this runtime`
    );
    expect(() => {
      TemplateSet.compiler = { ...own, hash: "other" };
    }).toThrow(
      `The template compiler is build ${App.version}+other, but the runtime is ${BUILD}: load the owl.compiler.es.js built with this runtime`
    );
    TemplateSet.compiler = undefined;
    expect(TemplateSet.compiler).toBe(own);
  });

  test("null leaves the runtime without the registered compiler", async () => {
    await import("../src/compiler");
    TemplateSet.compiler = null;
    expect(TemplateSet.compiler).toBe(null);
    const templates = new TemplateSet();
    templates.addTemplate("t", "<div/>");
    expect(() => templates.getTemplate("t")).toThrow("(TemplateSet.compiler was set to null)");
    TemplateSet.compiler = undefined;
    expect(TemplateSet.compiler).toBe(registry()[BUILD]);
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
      version: App.version,
      hash: "dev",
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
