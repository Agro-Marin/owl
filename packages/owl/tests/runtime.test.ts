import { compile } from "@odoo/owl-compiler";
import { App, Component, xml } from "../src/runtime";

function makeFixture() {
  const fixture = document.createElement("div");
  document.body.appendChild(fixture);
  return fixture;
}

test("the runtime build mounts precompiled templates", async () => {
  class Hello extends Component {
    static template = "hello";
    name = "world";
  }
  const app = new App({
    templates: {
      hello: compile(`<div>Hello <t t-out="this.name"/>!</div>`, {
        name: "hello",
        hasGlobalValues: false,
      }),
    },
  });
  const fixture = makeFixture();
  await app.createRoot(Hello).mount(fixture);
  expect(fixture.innerHTML).toBe("<div>Hello world!</div>");
  app.destroy();
});

test("the runtime build refuses a template it would have to compile", async () => {
  class Hello extends Component {
    static template = xml`<div>Hello</div>`;
  }
  const app = new App();
  await expect(app.createRoot(Hello).mount(makeFixture())).rejects.toThrow(
    "Unable to compile a template. Please use owl full build instead"
  );
  app.destroy();
});
