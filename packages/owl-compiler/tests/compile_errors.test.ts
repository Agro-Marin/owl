import { compile, parseXML } from "../src";

function messageOf(template: string | Element, name?: string): string {
  try {
    compile(template, { name, hasGlobalValues: false });
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("compiled");
}

// One template per error the parser, the code generator and the expression
// tokenizer throw, with the message a developer reads.
const CORPUS: [string, string][] = [
  ['<div t-custom-x="1"/>', 'Custom directive "x" is not defined (in template "c")'],
  ['<div t-custom="1"/>', "Unknown QWeb directive: 't-custom' (in template \"c\")"],
  ["<block-x/>", "Invalid tag name: 'block-x' (in template \"c\")"],
  ['<div t-on="f"/>', 'Missing event name with t-on directive (in template "c")'],
  [
    '<div t-model="x"/>',
    'The t-model directive only works with <input>, <textarea> and <select> (in template "c")',
  ],
  ['<input t-model.fast="x"/>', "Unknown t-model modifier: 'fast' (in template \"c\")"],
  [
    '<input type="checkbox" t-model.trim="x"/>',
    't-model.trim needs a text input: a checkbox gives a boolean (in template "c")',
  ],
  ['<div block-x="1"/>', "Invalid attribute: 'block-x' (in template \"c\")"],
  ['<div t-frob="1"/>', "Unknown QWeb directive: 't-frob' (in template \"c\")"],
  [
    '<t t-foreach="l"><i/></t>',
    'Directive \'t-foreach\' needs a t-as (expression: t-foreach="l") (in template "c")',
  ],
  [
    '<t t-foreach="l" t-as="x"><i/></t>',
    'Directive \'t-foreach\' needs a t-key (expression: t-foreach="l" t-as="x") (in template "c")',
  ],
  [
    '<t t-foreach="l" t-as="x" t-key="x" t-memo="[x]"><t t-set="y" t-value="1"/></t>',
    't-memo needs an item made of elements, text, t-out and components only (expression: t-foreach="l" t-memo="[x]") (in template "c")',
  ],
  ['<t t-call-block="b"><i/></t>', "Directive 't-call-block' takes no content (in template \"c\")"],
  [
    '<div t-component="C"/>',
    "Directive 't-component' can only be used on <t> nodes (used on a <div>) (in template \"c\")",
  ],
  ['<C t-frob="1"/>', "Unsupported directive 't-frob' on a component (<C>) (in template \"c\")"],
  [
    '<C><div t-set-slot="a"/></C>',
    "Directive 't-set-slot' can only be used on <t> nodes (used on a <div>) (in template \"c\")",
  ],
  [
    '<C><t t-set-slot="a"><t t-set-slot="b"/></t></C>',
    'Directive \'t-set-slot\' cannot be nested in another t-set-slot (slot "b" in slot "a") (in template "c")',
  ],
  [
    '<C><t t-if="x"><t t-set-slot="a"/></t></C>',
    "Directive 't-set-slot' cannot be used under a directive (t-if on a <t>) inside a component (in template \"c\")",
  ],
  [
    '<t><i t-if="a" t-foreach="l" t-as="x" t-key="x"/><i t-else=""/></t>',
    't-if cannot stay at the same level as t-foreach when using t-elif or t-else (in template "c")',
  ],
  [
    '<i t-if="a" t-elif="b"/>',
    't-elif and t-else directives must be preceded by a t-if or t-elif directive (in template "c")',
  ],
  [
    '<t><i t-if="a"/>text<i t-else=""/></t>',
    'text is not allowed between branching directives (in template "c")',
  ],
  [
    '<i t-else=""/>',
    't-elif and t-else directives must be preceded by a t-if or t-elif directive (in template "c")',
  ],
  [
    '<C t-out="x">content</C>',
    'Cannot have t-out on a component that already has content (in template "c")',
  ],
  [
    '<t t-set="Math" t-value="1"/>',
    "'Math' cannot be a template variable (t-set): an expression reads it as JavaScript's own (in template \"c\")",
  ],
  [
    '<t t-set="this" t-value="1"/>',
    "'this' cannot be a template variable (t-set): expressions read it as the component (in template \"c\")",
  ],
  [
    '<t t-set="a-b" t-value="1"/>',
    "'a-b' cannot be a template variable (t-set): no expression can read it (in template \"c\")",
  ],
  ['<C a.frob="1"/>', "Invalid prop suffix: frob (prop 'a.frob') (in template \"c\")"],
  ['<C a.b.c="1"/>', "Invalid prop suffix: b.c (prop 'a.b.c') (in template \"c\")"],
  ['<t t-call=""/>', "Directive 't-call' needs a template name (on a <t>) (in template \"c\")"],
  [
    '<t t-ref="r"/>',
    "Directive 't-ref' can only be used on DOM nodes (used on a <t>) (in template \"c\")",
  ],
  ['<t t-portal=""/>', "Unsupported directive 't-portal' on a <t> (in template \"c\")"],
  [
    '<i t-att-x="\'abc"/>',
    'Failed to compile template "c": invalid expression `\'abc` in t-att-x="\'abc" (on a <i>): unterminated string',
  ],
  [
    '<i t-att-x="a /* x"/>',
    'Failed to compile template "c": invalid expression `a /* x` in t-att-x="a /* x" (on a <i>): unterminated comment',
  ],
  [
    '<i t-att-x="/ab"/>',
    'Failed to compile template "c": invalid expression `/ab` in t-att-x="/ab" (on a <i>): unterminated regular expression',
  ],
  [
    '<i t-att-x="`a${b"/>',
    'Failed to compile template "c": invalid expression ``a${b` in t-att-x="`a${b" (on a <i>): unclosed {',
  ],
  [
    '<i t-att-x="a # b"/>',
    'Failed to compile template "c": invalid expression `a # b` in t-att-x="a # b" (on a <i>): unexpected `#`',
  ],
  [
    '<i t-att-x="{a() {}}"/>',
    'Failed to compile template "c": invalid expression `{a() {}}` in t-att-x="{a() {}}" (on a <i>): object literal methods and accessors are not supported: use a property holding an arrow function',
  ],
  [
    '<i t-on-click="function (e) { return e }"/>',
    'Failed to compile template "c": invalid expression `function (e) { return e }` in t-on-click="function (e) { return e }" (on a <i>): function expressions with a name or parameters are not supported: use an arrow function',
  ],
  [
    '<i t-on-click="() => { if (a) { b() } }"/>',
    'Failed to compile template "c": invalid expression `() => { if (a) { b() } }` in t-on-click="() => { if (a) { b() } }" (on a <i>): unsupported statement \'if\': an arrow function\'s block body takes declarations, expressions and return only',
  ],
  [
    "<div><span></div>",
    'Invalid XML in template. (in template "c")\nThe parser has produced the following error message:\n1:20: unexpected close tag.\nThe error might be located at xml line 1 column 20\n<t><div><span></div></t>\n-------------------^',
  ],
];

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

  test.each(CORPUS)("%s", (template, message) => {
    expect(messageOf(template, "c")).toBe(message);
  });

  test("every message of the corpus names its template once, on its first line", () => {
    for (const [template] of CORPUS) {
      const message = messageOf(template, "c");
      expect(message.split('template "c"').length, template).toBe(2);
      expect(message.split("\n")[0], template).toContain('template "c"');
    }
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
