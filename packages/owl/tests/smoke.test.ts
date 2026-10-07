import { App, Component, mount, TemplateSet, xml } from "../src";

const COMPILER_KEY = Symbol.for("@odoo/owl/compiler");
// read before any test makes an App or reads the compiler
const globalsOnImport = {
  devtools: "__OWL_DEVTOOLS__" in window,
  registry: COMPILER_KEY in globalThis,
};

function makeFixture() {
  const fixture = document.createElement("div");
  document.body.appendChild(fixture);
  return fixture;
}

test("umbrella wiring: compile + mount + runtime work end-to-end", async () => {
  class Hello extends Component {
    static template = xml`<div>Hello world!</div>`;
  }
  const fixture = makeFixture();
  await mount(Hello, fixture);
  expect(fixture.innerHTML).toBe("<div>Hello world!</div>");
});

test("umbrella wiring: addTemplates parses XML strings", async () => {
  class Root extends Component {
    static template = "root_template";
  }
  const app = new App();
  app.addTemplates(`
    <templates>
      <t t-name="root_template">
        <span>ok</span>
      </t>
    </templates>
  `);
  const root = app.createRoot(Root);
  const fixture = makeFixture();
  await root.mount(fixture);
  expect(fixture.innerHTML).toBe("<span>ok</span>");
  app.destroy();
});

test("both builds export batch(), which runs an immediate effect once after its writes", async () => {
  const full = await import("../src");
  const runtime = await import("../src/runtime");
  expect(runtime.batch).toBe(full.batch);
  const a = full.signal(1);
  const b = full.signal(2);
  const seen: number[][] = [];
  full.immediateEffect(() => {
    seen.push([a(), b()]);
  });
  full.batch(() => {
    a.set(5);
    b.set(6);
  });
  expect(seen).toEqual([
    [1, 2],
    [5, 6],
  ]);
});

test("the full build sets no global: its compiler is its own, in no registry", () => {
  expect(globalsOnImport).toEqual({ devtools: false, registry: false });
  const compiler = TemplateSet.compiler!;
  expect(compiler.hash).toBe("dev");
  expect(COMPILER_KEY in globalThis).toBe(false);
  TemplateSet.compiler = null;
  expect(TemplateSet.compiler).toBe(null);
  TemplateSet.compiler = undefined;
  expect(TemplateSet.compiler).toBe(compiler);
});
