import { TestContext } from "../helpers";

test("an error in a named template's code is located in that template's file", () => {
  const context = new TestContext();
  context.addTemplate("my.list", `<div><t t-out="this.record.name"/></div>`);
  let error: Error | undefined;
  try {
    context.renderToString("my.list", {});
  } catch (e) {
    error = e as Error;
  }
  expect(error).toBeInstanceOf(TypeError);
  expect(error!.stack).toContain("owl-templates:///my.list:");
});
