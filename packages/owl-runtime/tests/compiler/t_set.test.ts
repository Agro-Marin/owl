import { Component, mount, onMounted, proxy, xml } from "../../src";
import {
  makeTestFixture,
  nextTick,
  renderToString,
  snapshotEverything,
  TestContext,
} from "../helpers";

snapshotEverything();

let fixture: HTMLElement;
beforeEach(() => {
  fixture = makeTestFixture();
});

// -----------------------------------------------------------------------------
// t-set
// -----------------------------------------------------------------------------

describe("t-set", () => {
  test("a variable may be named await or async", () => {
    const template = `<div><t t-set="await" t-value="v"/><t t-set="async" t-value="2"/><t t-out="await.x"/><t t-if="await.x and async" t-out="async"/></div>`;
    expect(renderToString(template, { v: { x: 1 } })).toBe("<div>12</div>");
  });

  test("set from attribute literal", () => {
    const template = `<div><t t-set="value" t-value="'ok'"/><t t-out="value"/></div>`;
    expect(renderToString(template)).toBe("<div>ok</div>");
  });

  test("t-set does not modify render context existing key values", () => {
    const template = `<div><t t-set="value" t-value="35"/><t t-out="value"/></div>`;
    const ctx = { value: 17 };
    expect(renderToString(template, ctx)).toBe("<div>35</div>");
    expect(ctx.value).toBe(17);
  });

  test("set from attribute literal (no outside div)", () => {
    const template = `<t><t t-set="value" t-value="'ok'"/><t t-out="value"/></t>`;
    expect(renderToString(template)).toBe("ok");
  });

  test("t-set and t-if", () => {
    const template = `
        <div>
          <t t-set="v" t-value="value"/>
          <t t-if="v === 'ok'">grimbergen</t>
        </div>`;
    expect(renderToString(template, { value: "ok" })).toBe("<div>grimbergen</div>");
  });

  test("t-set, multiple t-ifs, and a specific configuration", () => {
    const template = `
      <p>
        <div>
          <t t-if="flag" t-set="bouh" t-value="2"/>
          <span>First div</span>
        </div>
        <div>
          <t t-if="!flag">Second</t>
        </div>
      </p>`;
    expect(renderToString(template)).toBe(
      "<p><div><span>First div</span></div><div>Second</div></p>"
    );
  });

  test("set from body literal", () => {
    const template = `<t><t t-set="value">ok</t><t t-out="value"/></t>`;
    expect(renderToString(template)).toBe("ok");
  });

  test("body with backslash at top level", () => {
    const template = '<t t-set="value">\\</t><t t-out="value"/>';
    expect(renderToString(template)).toBe("\\");
  });

  test("body with backtick at top-level", () => {
    const template = '<t t-set="value">`</t><t t-out="value"/>';
    expect(renderToString(template)).toBe("`");
  });

  test("body with interpolation sigil at top level", () => {
    const template = '<t t-set="value">${very cool}</t><t t-out="value"/>';
    expect(renderToString(template)).toBe("${very cool}");
  });

  test("set from body literal (with t-if/t-else", () => {
    const template = `
      <t>
        <t t-set="value">
          <t t-if="condition">true</t>
          <t t-else="">false</t>
        </t>
        <t t-out="value"/>
      </t>`;
    expect(renderToString(template, { condition: true })).toBe("true");
    expect(renderToString(template, { condition: false })).toBe("false");
  });

  test("set from attribute lookup", () => {
    const template = `<div><t t-set="stuff" t-value="value"/><t t-out="stuff"/></div>`;
    expect(renderToString(template, { value: "ok" })).toBe("<div>ok</div>");
  });

  test("t-set evaluates an expression only once", () => {
    const template = `
        <div >
          <t t-set="v" t-value="value + ' artois'"/>
          <t t-out="v"/>
          <t t-out="v"/>
        </div>`;
    expect(renderToString(template, { value: "stella" })).toBe(
      "<div>stella artoisstella artois</div>"
    );
  });

  test("set from body lookup", () => {
    const template = `<div><t t-set="stuff"><t t-out="value"/></t><t t-out="stuff"/></div>`;
    expect(renderToString(template, { value: "ok" })).toBe("<div>ok</div>");
  });

  test("set from empty body", () => {
    const template = `<div><t t-set="stuff"/><t t-out="stuff"/></div>`;
    expect(renderToString(template)).toBe("<div></div>");
  });

  test("value priority", () => {
    const template = `<div><t t-set="value" t-value="1">2</t><t t-out="value"/></div>`;
    expect(renderToString(template)).toBe("<div>1</div>");
  });

  test("value priority (with non text body", () => {
    const template = `<div><t t-set="value" t-value="1"><span>2</span></t><t t-out="value"/></div>`;
    expect(renderToString(template)).toBe("<div>1</div>");
  });

  test("evaluate value expression", () => {
    const template = `<div><t t-set="value" t-value="1 + 2"/><t t-out="value"/></div>`;
    expect(renderToString(template)).toBe("<div>3</div>");
  });

  test("t-set should reuse variable if possible", () => {
    const template = `
        <div>
          <t t-set="v" t-value="1"/>
          <div t-foreach="list" t-as="elem" t-key="elem_index">
              <span>v<t t-out="v"/></span>
              <t t-set="v" t-value="elem"/>
          </div>
        </div>`;
    const expected = "<div><div><span>v1</span></div><div><span>va</span></div></div>";
    expect(renderToString(template, { list: ["a", "b"] })).toBe(expected);
  });

  test("t-set with content and sub t-out", () => {
    const template = `
        <div>
          <t t-set="setvar"><t t-out="beep"/> boop</t>
          <t t-out="setvar"/>
        </div>`;
    expect(renderToString(template, { beep: "beep" })).toBe("<div>beep boop</div>");
  });

  test("evaluate value expression, part 2", () => {
    const template = `<div><t t-set="value" t-value="somevariable + 2"/><t t-out="value"/></div>`;
    expect(renderToString(template, { somevariable: 43 })).toBe("<div>45</div>");
  });

  test("t-set, t-if, and mix of expression/body lookup, 1", () => {
    const template = `
        <div>
          <t t-if="flag" t-set="ourvar">1</t>
          <t t-else="" t-set="ourvar" t-value="0"></t>
          <t t-out="ourvar"/>
        </div>`;

    expect(renderToString(template, { flag: true })).toBe("<div>1</div>");
    expect(renderToString(template, { flag: false })).toBe("<div>0</div>");
  });

  test("t-set, t-if, and mix of expression/body lookup, 2", () => {
    const template = `
        <div>
          <t t-if="flag" t-set="ourvar" t-value="1"></t>
          <t t-else="" t-set="ourvar">0</t>
          <t t-out="ourvar"/>
        </div>`;

    expect(renderToString(template, { flag: true })).toBe("<div>1</div>");
    expect(renderToString(template, { flag: false })).toBe("<div>0</div>");
  });

  test("t-set, t-if, and mix of expression/body lookup, 3", () => {
    const template = `
          <t t-if="flag" t-set="ourvar" t-value="1"></t>
          <t t-else="" t-set="ourvar">0</t>
          <t t-out="ourvar"/>`;

    expect(renderToString(template, { flag: true })).toBe("1");
    expect(renderToString(template, { flag: false })).toBe("0");
  });

  test("t-set body is evaluated immediately", () => {
    const template = `
        <div>
          <t t-set="v1" t-value="'before'"/>
          <t t-set="v2">
            <span><t t-out="v1"/></span>
          </t>
          <t t-set="v1" t-value="'after'"/>
          <t t-out="v2"/>
        </div>`;

    // the values at the t-set, as OWL 2 read them
    expect(renderToString(template)).toBe("<div><span>before</span></div>");
  });

  test("t-set with t-value (falsy) and body", () => {
    const template = `
        <div>
          <t t-set="v3" t-value="false"/>
          <t t-set="v1" t-value="'before'"/>
          <t t-set="v2" t-value="v3">
            <span><t t-out="v1"/></span>
          </t>
          <t t-set="v1" t-value="'after'"/>
          <t t-set="v3" t-value="true"/>
          <t t-out="v2"/>
        </div>`;

    // the values at the t-set, as OWL 2 read them
    expect(renderToString(template)).toBe("<div><span>before</span></div>");
  });

  test("t-set with t-value (truthy) and body", () => {
    const template = `
        <div>
          <t t-set="v3" t-value="'Truthy'"/>
          <t t-set="v1" t-value="'before'"/>
          <t t-set="v2" t-value="v3">
            <span><t t-out="v1"/></span>
          </t>
          <t t-set="v1" t-value="'after'"/>
          <t t-set="v3" t-value="false"/>
          <t t-out="v2"/>
        </div>`;

    expect(renderToString(template)).toBe("<div>Truthy</div>");
  });

  test("t-set outside modified in t-foreach", async () => {
    const template = `
      <div>
        <t t-set="iter" t-value="0"/>
        <t t-foreach="['a','b']" t-as="val" t-key="val">
          <p>InLoop: <t t-out="iter"/></p>
          <t t-set="iter" t-value="iter + 1"/>
        </t>
        <p>EndLoop: <t t-out="iter"/></p>
      </div>
    `;
    expect(renderToString(template)).toBe(
      "<div><p>InLoop: 0</p><p>InLoop: 1</p><p>EndLoop: 2</p></div>"
    );
  });

  test("t-set outside modified in t-foreach increment-after operator", async () => {
    const template = `
      <div>
        <t t-set="iter" t-value="0"/>
        <t t-foreach="['a','b']" t-as="val" t-key="val">
          <p>InLoop: <t t-out="iter"/></p>
          <t t-set="iter" t-value="iter++"/>
        </t>
        <p>EndLoop: <t t-out="iter"/></p>
      </div>
    `;
    expect(renderToString(template)).toBe(
      "<div><p>InLoop: 0</p><p>InLoop: 0</p><p>EndLoop: 0</p></div>"
    );
  });

  test("t-set outside modified in t-foreach increment-before operator", async () => {
    const template = `
      <div>
        <t t-set="iter" t-value="0"/>
        <t t-foreach="['a','b']" t-as="val" t-key="val">
          <p>InLoop: <t t-out="iter"/></p>
          <t t-set="iter" t-value="++iter"/>
        </t>
        <p>EndLoop: <t t-out="iter"/></p>
      </div>
    `;
    expect(renderToString(template)).toBe(
      "<div><p>InLoop: 0</p><p>InLoop: 1</p><p>EndLoop: 2</p></div>"
    );
  });

  test("t-set can't alter from within callee", async () => {
    const context = new TestContext();
    const sub = `<div><t t-out="iter"/><t t-set="iter" t-value="'called'"/><t t-out="iter"/></div>`;
    const main = `
      <div>
        <t t-set="iter" t-value="'source'"/>
        <p><t t-out="iter"/></p>
        <t t-call="sub"/>
        <p><t t-out="iter"/></p>
      </div>
    `;
    context.addTemplate("sub", sub);
    context.addTemplate("main", main);

    expect(context.renderToString("main")).toBe(
      "<div><p>source</p><div>sourcecalled</div><p>source</p></div>"
    );
  });

  test("t-set can't alter in t-call body", async () => {
    const context = new TestContext();
    const sub = `<div><t t-out="iter"/><t t-set="iter" t-value="'called'"/><t t-out="iter"/></div>`;
    const main = `
      <div>
        <t t-set="iter" t-value="'source'"/>
        <p><t t-out="iter"/></p>
        <t t-call="sub">
          <t t-set="iter" t-value="'inCall'"/>
        </t>
        <p><t t-out="iter"/></p>
      </div>
    `;
    context.addTemplate("sub", sub);
    context.addTemplate("main", main);

    expect(context.renderToString("main")).toBe(
      "<div><p>source</p><div>sourcecalled</div><p>source</p></div>"
    );
  });

  test("t-set after a dom element is executed, and a handler before it reads the value at the handler", async () => {
    let received: number | undefined;
    class Root extends Component {
      static template = xml`
        <t t-set="val" t-value="1"/>
        <button t-on-click="() => this.logValue(val)">log</button>
        <t t-set="val" t-value="2"/>`;
      logValue(val: number) {
        received = val;
      }
    }

    await mount(Root, fixture);
    fixture.querySelector("button")!.click();
    expect(received).toBe(1);
  });

  test("template made only of t-set renders nothing", () => {
    expect(renderToString(`<t t-set="a" t-value="1"/><t t-set="b" t-value="2"/>`)).toBe("");
  });

  test("a t-set in an ended loop does not change scoping in a later loop", () => {
    const body = `<t t-foreach="[1, 2]" t-as="j" t-key="j"><t t-foreach="[7]" t-as="k" t-key="k"><t t-set="x" t-value="k"/>k</t>[<t t-out="x"/>]</t>`;
    const prefix = `<t t-foreach="[0]" t-as="i" t-key="i"><t t-set="x" t-value="i"/>i</t>`;
    expect(renderToString(body)).toBe("k[]k[]");
    expect(renderToString(prefix + body)).toBe("ik[]k[]");
  });

  test("t-set body of only a comment", () => {
    expect(renderToString(`<t t-set="x"><!-- c --></t><span>ok</span>`)).toBe("<span>ok</span>");
    expect(renderToString(`<t t-set="x" t-value="1"><!-- c --></t><t t-out="x"/>`)).toBe("1");
  });

  test("t-set body of text with entities is a string", () => {
    expect(renderToString(`<t t-set="v">a &gt; b</t><t t-out="v.length"/>`)).toBe("5");
    expect(renderToString(`<t t-set="v">a <!-- c -->b</t><t t-out="v"/>`)).toBe("a b");
  });
  test("a t-set body holding a component can be output twice", async () => {
    class Child extends Component {
      static template = xml`<i>c</i>`;
    }
    class Root extends Component {
      static template = xml`<div><t t-set="v"><Child/></t><t t-out="v"/><t t-out="v"/></div>`;
      static components = { Child };
    }
    const root = await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div><i>c</i><i>c</i></div>");
    expect(Object.keys(root.__owl__.children).length).toBe(2);
  });

  test("a t-set body holding a component keeps one component per site and iteration, nested loops included", async () => {
    let setups = 0;
    class Child extends Component {
      static template = xml`<i>c</i>`;
      setup() {
        setups++;
      }
    }
    class Root extends Component {
      static template = xml`
        <div>
          <t t-set="v"><Child/></t>
          <t t-out="this.state.n"/>
          <t t-foreach="[1, 2]" t-as="a" t-key="a">
            <t t-foreach="['x', 'y']" t-as="b" t-key="b"><t t-out="v"/></t>
            <t t-foreach="[1]" t-as="c" t-key="c"><t t-foreach="[1]" t-as="d" t-key="d">
              <t t-foreach="[{}, {}]" t-as="e" t-key="e_index"><t t-out="v"/></t>
            </t></t>
          </t>
        </div>`;
      static components = { Child };
      state = proxy({ n: 0 });
    }
    const root = await mount(Root, fixture);
    expect(fixture.innerHTML).toBe(`<div>0${"<i>c</i>".repeat(8)}</div>`);
    expect(setups).toBe(8);
    root.state.n++;
    await nextTick();
    expect(fixture.innerHTML).toBe(`<div>1${"<i>c</i>".repeat(8)}</div>`);
    expect(setups).toBe(8);
  });

  test("a t-set body holding a component can be output in a loop", async () => {
    class Child extends Component {
      static template = xml`<i>c</i>`;
    }
    class Root extends Component {
      static template = xml`
        <div>
          <t t-set="v"><Child/></t>
          <t t-foreach="this.items" t-as="n" t-key="n"><t t-out="v"/></t>
        </div>`;
      static components = { Child };
      items = [1, 2];
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div><i>c</i><i>c</i></div>");
  });

  test("an attribute of a t-set body holding only text is that text", () => {
    // what Odoo writes: <t t-set="label"><t t-if="c">Relation to follow</t>...</t>
    // then t-att-aria-label="label", or a cell value passed on as a label
    const y = `R&D <x> "q"\u00a0z`;
    const attrs = (template: string) => {
      const div = document.createElement("div");
      div.innerHTML = renderToString(template, { y });
      const p = div.querySelector("p")!;
      return [p.title, p.getAttribute("aria-label")];
    };
    const use = `<p t-att-title="x" t-attf-aria-label="L: {{x}}"/>`;
    expect(attrs(`<t t-set="x"><t t-out="y"/></t>${use}`)).toEqual([y, `L: ${y}`]);
    expect(attrs(`<t t-set="x">A: <t t-out="y"/></t>${use}`)).toEqual([`A: ${y}`, `L: A: ${y}`]);
    expect(attrs(`<t t-set="x"><t t-if="y">A &amp; B</t><t t-else="">C</t></t>${use}`)).toEqual([
      "A & B",
      "L: A & B",
    ]);
    // a body holding elements still stringifies to its markup
    expect(attrs(`<t t-set="x"><b t-out="y"/></t>${use}`)[0]).toBe(
      '<b>R&amp;D &lt;x&gt; "q"&nbsp;z</b>'
    );
  });

  test("a t-set body holding a component cannot be stringified", async () => {
    let mounted = 0;
    class Child extends Component {
      static template = xml`<i>c</i>`;
      setup() {
        onMounted(() => mounted++);
      }
    }
    class Root extends Component {
      static template = xml`<t t-set="v"><div><Child/></div></t><p t-att-title="v"/>`;
      static components = { Child };
    }
    await expect(mount(Root, fixture)).rejects.toThrow(
      "A t-set body holding a component cannot be stringified"
    );
    expect(mounted).toBe(0);
  });
});

describe("a site outputting one body, then another", () => {
  // the same t-out shows the body a t-set in a branch set: each body makes
  // blocks of its own, which the other's must not be patched with
  test.each([
    [
      "a list, then an element",
      `<t t-set="b"><t t-foreach="[1, 2]" t-as="i" t-key="i"><li t-out="i"/></t></t>`,
      `<i>x</i>`,
      "<div><li>1</li><li>2</li></div>",
      "<div><i>x</i></div>",
    ],
    [
      "an element, then a list",
      `<t t-set="b"><i>x</i></t>`,
      `<t t-foreach="[1, 2]" t-as="i" t-key="i"><li t-out="i"/></t>`,
      "<div><i>x</i></div>",
      "<div><li>1</li><li>2</li></div>",
    ],
  ])("%s", async (_name, first, second, before, after) => {
    const template = `<div>${first}<t t-if="this.s.flag"><t t-set="b">${second}</t></t><t t-out="b"/></div>`;
    class Root extends Component {
      static template = xml(Object.assign([template], { raw: [template] }) as any);
      s = proxy({ flag: false });
    }
    const root = await mount(Root, fixture);
    expect(fixture.innerHTML).toBe(before);
    root.s.flag = true;
    await nextTick();
    expect(fixture.innerHTML).toBe(after);
    root.s.flag = false;
    await nextTick();
    expect(fixture.innerHTML).toBe(before);
  });
});
