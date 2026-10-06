import { compile } from "@odoo/owl-compiler";
import { Component, mount, onWillUpdateProps, props, signal, xml } from "../../src";
import { makeTestFixture, nextTick } from "../helpers";

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

// the statements of the render functions of a compiled template: the lines
// of `function name(ctx, node, key = "") { ... }`, the template's own included
function renderFunctionLines(template: string): string[] {
  const code = compile(template).toString();
  const lines: string[] = [];
  let inside = false;
  for (const line of code.split("\n")) {
    if (/function \w+\(ctx, node, key = ""\) \{$/.test(line)) {
      inside = true;
    } else if (/^ {2}\}$/.test(line)) {
      inside = false;
    } else if (inside) {
      lines.push(line.trim());
    }
  }
  return lines;
}

describe("what a render allocates", () => {
  test("slots, slot defaults, t-call bodies and t-out bodies make no function per render", () => {
    const lines = renderFunctionLines(`
      <div>
        <Child>
          <t t-set-slot="header" t-slot-scope="s"><b t-out="s.x"/></t>
          <span>content</span>
        </Child>
        <t t-call-slot="footer">default footer</t>
        <t t-call="sub"><i>body</i></t>
        <t t-out="value">no value</t>
        <t t-out="0">no body</t>
      </div>`);
    expect(lines.length).toBeGreaterThan(0);
    const allocating = lines.filter((line) => /\.bind\(|=>/.test(line));
    expect(allocating).toEqual([]);
  });

  test("a slot called without attributes passes no scope object", () => {
    const lines = renderFunctionLines(`<div><t t-call-slot="default"/></div>`);
    const calls = lines.filter((line) => line.includes("callSlot("));
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain("{}");
  });

  test("t-props and t-call attributes build their object without a literal to copy", () => {
    const lines = renderFunctionLines(`
      <div>
        <Child t-props="this.p" a="1"/>
        <t t-call="sub" a="1"/>
      </div>`);
    expect(lines.filter((line) => line.includes("Object.assign("))).toEqual([]);
  });

  test("a slot's render function is the same on every render", async () => {
    const renders: any[] = [];
    class Child extends Component {
      static template = xml`<div><t t-call-slot="default"/></div>`;
      props = props();
      setup() {
        renders.push(this.props.slots.default.__render);
        onWillUpdateProps((next) => renders.push(next.slots.default.__render));
      }
    }
    class Parent extends Component {
      static template = xml`<Child n="this.n()"><t t-out="this.n()"/></Child>`;
      static components = { Child };
      n = signal(0);
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div>0</div>");
    parent.n.set(1);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>1</div>");
    expect(renders.length).toBe(2);
    expect(renders[0]).toBe(renders[1]);
  });
});

describe("the owner of slots, slot defaults and t-call bodies", () => {
  test("each renders its components with the components of the template that wrote it", async () => {
    class Leaf extends Component {
      static template = xml`<i t-out="this.props.v"/>`;
      props = props();
    }
    class OtherLeaf extends Component {
      static template = xml`<u t-out="this.props.v"/>`;
      props = props();
    }
    const sub = xml`<p><t t-out="0"/></p>`;
    const subWithSlot = xml`<Child><t t-out="0"/></Child>`;
    class Child extends Component {
      // Leaf here is OtherLeaf: the default content renders Child's own
      static template = xml`<div><t t-call-slot="default"/><t t-call-slot="missing"><Leaf v="'child default'"/></t></div>`;
      static components = { Leaf: OtherLeaf };
    }
    class Parent extends Component {
      static template = xml`
        <Child><Leaf v="'slot'"/></Child>
        <t t-call="${sub}"><Leaf v="'call body'"/></t>
        <t t-call="${subWithSlot}"><Leaf v="'body in a slot'"/></t>
        <t t-foreach="['a', 'b']" t-as="x" t-key="x"><t t-call="${sub}"><Leaf v="x"/></t></t>`;
      static components = { Child, Leaf };
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<div><i>slot</i><u>child default</u></div>" +
        "<p><i>call body</i></p>" +
        "<div><i>body in a slot</i><u>child default</u></div>" +
        "<p><i>a</i></p><p><i>b</i></p>"
    );
  });

  test("a slot scope is an object when the slot is called without attributes", async () => {
    class Child extends Component {
      static template = xml`<div><t t-call-slot="default"/></div>`;
    }
    class Parent extends Component {
      static template = xml`<Child t-slot-scope="s"><t t-out="typeof s"/>:<t t-out="Object.keys(s).length"/></Child>`;
      static components = { Child };
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div>object:0</div>");
  });
});
