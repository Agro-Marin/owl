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
