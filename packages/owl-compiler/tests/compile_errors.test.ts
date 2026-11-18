import { compile, parseXML } from "../src";

function messageOf(template: string | Element, name?: string): string {
  try {
    compile(template, { name, hasGlobalValues: false });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("compiled");
}

describe("a template that does not compile names what is wrong", () => {
  test("an invalid expression is named with its attribute and element, without the generated code", () => {
    const message = messageOf(`<div><span t-att-class="a +"/></div>`, "my.template");
    expect(message).toBe(
      `Failed to compile template "my.template": invalid expression \`a +\` in t-att-class="a +" (on a <span>): Unexpected token ')'`
    );
  });

  test.each([
    [`<p t-attf-title="x {{ a + }} y"/>`, `in t-attf-title="x {{ a + }} y" (on a <p>)`],
    [`<button t-on-click="() => {"/>`, `in t-on-click="() => {" (on a <button>)`],
    [`<t t-if="a b"><i/></t>`, `in t-if="a b" (on a <t>)`],
    [`<i t-out="1 +* 2"/>`, `in t-out="1 +* 2" (on a <i>)`],
  ])("%s names its attribute", (template, where) => {
    expect(messageOf(template)).toContain(where);
  });

  test("an Element template is named from the element as written, which compile leaves untouched", () => {
    const element = parseXML(`<div><b t-att-title="x y"/></div>`).documentElement;
    const before = element.outerHTML;
    expect(messageOf(element, "el")).toContain(`in t-att-title="x y" (on a <b>)`);
    expect(element.outerHTML).toBe(before);
  });

  test("a template error the parser throws names the template once", () => {
    expect(messageOf(`<div t-frobnicate="1"/>`, "my.template")).toBe(
      `Unknown QWeb directive: 't-frobnicate' (in template "my.template")`
    );
    expect(messageOf(`<div t-frobnicate="1"/>`)).toBe(`Unknown QWeb directive: 't-frobnicate'`);
  });

  test("a valid template still compiles", () => {
    expect(
      typeof compile(`<div t-att-class="a + b"><t t-out="c"/></div>`, {
        name: "ok",
        hasGlobalValues: false,
      })
    ).toBe("function");
  });
});
