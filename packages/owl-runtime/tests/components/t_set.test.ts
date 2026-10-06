import { Component, mount, props, proxy, xml } from "../../src";
import { makeTestFixture, nextTick, render, snapshotEverything } from "../helpers";

snapshotEverything();

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

// -----------------------------------------------------------------------------
// t-set
// -----------------------------------------------------------------------------

describe("t-set", () => {
  test("t-set outside modified in t-if", async () => {
    class Comp extends Component {
      static template = xml`
        <div>
          <t t-set="iter" t-value="0"/>
          <t t-set="flag" t-value="this.state.flag" />
          <t t-if="flag === 'if'">
            <t t-set="iter" t-value="2"/>
          </t>
          <t t-elif="flag === 'elif'">
            <t t-set="iter" t-value="3"/>
          </t>
          <t t-else="">
            <t t-set="iter" t-value="4"/>
          </t>
          <p><t t-out="iter"/></p>
        </div>`;
      state = { flag: "if" };
    }
    const comp = await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><p>2</p></div>");
    comp.state.flag = "elif";
    render(comp);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>3</p></div>");
    comp.state.flag = "false";
    render(comp);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>4</p></div>");
  });

  test("t-set in t-if", async () => {
    // Weird that code block within 'if' leaks outside of it
    // Python does the same
    class Comp extends Component {
      static template = xml`
        <div>
          <t t-set="flag" t-value="this.state.flag" />
          <t t-if="flag === 'if'">
            <t t-set="iter" t-value="2"/>
          </t>
          <t t-elif="flag === 'elif'">
            <t t-set="iter" t-value="3"/>
          </t>
          <t t-else="">
            <t t-set="iter" t-value="4"/>
          </t>
          <p><t t-out="iter"/></p>
        </div>`;
      state = { flag: "if" };
    }
    const comp = await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><p>2</p></div>");
    comp.state.flag = "elif";
    render(comp);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>3</p></div>");
    comp.state.flag = "false";
    render(comp);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><p>4</p></div>");
  });

  test("t-set can't alter component even if key in component", async () => {
    class Comp extends Component {
      static template = xml`
        <div>
          <p><t t-out="this.iter"/></p>
          <t t-set="iter" t-value="5"/>
          <p><t t-out="this.iter"/></p>
          <p><t t-out="iter"/></p>
        </div>`;
      iter = 1;
    }
    const comp = await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><p>1</p><p>1</p><p>5</p></div>");
    expect(comp.iter).toBe(1);
  });

  test("t-set can't alter component if key not in component", async () => {
    class Comp extends Component {
      static template = xml`
        <div>
          <p><t t-out="this.iter"/></p>
          <t t-set="iter" t-value="5"/>
          <p><t t-out="this.iter"/></p>
          <p><t t-out="iter"/></p>
        </div>`;
    }
    const comp = await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><p></p><p></p><p>5</p></div>");
    expect((comp as any).iter).toBeUndefined();
  });

  test("slot setted value (with t-set) not accessible with t-out", async () => {
    class Childcomp extends Component {
      static template = xml`<div><t t-out="iter"/><t t-set="iter" t-value="'called'"/><t t-out="iter"/></div>`;
    }
    class Comp extends Component {
      static components = { Childcomp };
      static template = xml`
        <div>
          <t t-set="iter" t-value="'source'"/>
          <p><t t-out="iter"/></p>
          <Childcomp>
            <t t-set="iter" t-value="'inCall'"/>
          </Childcomp>
          <p><t t-out="iter"/></p>
        </div>`;
    }
    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><p>source</p><div>called</div><p>source</p></div>");
  });

  test("t-set not altered by child comp", async () => {
    let child;
    class Childcomp extends Component {
      static template = xml`
        <div>
          <t t-out="this.iter"/>
          <t t-set="iter" t-value="'called'"/>
          <t t-out="this.iter"/>
          <t t-out="iter"/>
        </div>`;
      iter = "child";
      setup() {
        super.setup();
        child = this;
      }
    }
    class Comp extends Component {
      static components = { Childcomp };
      static template = xml`
        <div>
          <t t-set="iter" t-value="'source'"/>
          <p><t t-out="iter"/></p>
          <Childcomp/>
          <p><t t-out="iter"/></p>
        </div>`;
    }
    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe(
      "<div><p>source</p><div>childchildcalled</div><p>source</p></div>"
    );
    expect((child as any).iter).toBe("child");
  });

  test("t-set with something in body", async () => {
    class Comp extends Component {
      static template = xml`
        <div>
          <t t-set="v">
            <p>coucou</p>
          </t>
          <div><t t-out="v"/></div>
        </div>`;
    }

    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><div><p>coucou</p></div></div>");
  });

  test("t-set with a component in body", async () => {
    class Child extends Component {
      static template = xml`Child`;
    }

    class Comp extends Component {
      static template = xml`
        <div>
          <t t-set="v">
            <Child/>
          </t>
          <div><t t-out="v"/></div>
        </div>`;
      static components = { Child };
    }

    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("<div><div>Child</div></div>");
  });

  test("slots with an unused t-set with a component in body", async () => {
    class Child extends Component {
      static template = xml`Child <t t-call-slot="default"/>`;
      props = props();
    }

    class Comp extends Component {
      static template = xml`
            <Child>
              <t t-set="v">
                <Child/>
              </t>
              in slot
            </Child>`;
      static components = { Child };
    }

    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("Child  in slot ");
  });

  test("slots with a t-set with a component in body", async () => {
    class C extends Component {
      static template = xml`C`;
    }
    class Child extends Component {
      static template = xml`Child <t t-call-slot="default"/>`;
      props = props();
    }

    class Comp extends Component {
      static template = xml`
            <Child>
              <t t-set="v">
                <C/>
              </t>
              in slot
              <t t-out="v" />
            </Child>`;
      static components = { Child, C };
    }

    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("Child  in slot C");
  });

  test("slots with an t-set with a component in body", async () => {
    class Child extends Component {
      static template = xml`Child`;
    }
    class Blorg extends Component {
      static template = xml`Blorg <t t-call-slot="default"/>`;
      props = props();
    }

    class Comp extends Component {
      static template = xml`
        <Blorg>
          <t t-set="v">
            <Child/>
            <div>coffee</div>
          </t>
          tea
          <t t-out="v"/>
        </Blorg>`;
      static components = { Child, Blorg };
    }

    await mount(Comp, fixture);

    expect(fixture.innerHTML).toBe("Blorg  tea Child<div>coffee</div>");
  });

  test("t-set body with a component, output in nested loops", async () => {
    let n = 0;
    class Cell extends Component {
      static template = xml`<b t-out="this.id"/>`;
      id = ++n;
    }
    class Comp extends Component {
      static template = xml`
        <div>
          <t t-foreach="[1, 2]" t-as="r" t-key="r">
            <p><t t-foreach="['a']" t-as="c" t-key="c">
              <t t-set="v"><Cell/></t><t t-out="v"/>
            </t></p>
          </t>
        </div>`;
      static components = { Cell };
    }
    await mount(Comp, fixture);
    expect(fixture.innerHTML).toBe("<div><p><b>1</b></p><p><b>2</b></p></div>");
  });
});

describe("a t-set body in an attribute is its string at render", () => {
  class Box extends Component {
    static template = xml`<t t-call-slot="default"/>`;
  }
  class Label extends Component {
    static template = xml`<p t-att-title="this.props.label"/>`;
    props = props();
  }
  const state = proxy({ a: 3 });
  class Root extends Component {
    static components = { Box, Label };
    state = state;
  }

  async function update(template: string): Promise<string[]> {
    state.a = 3;
    class Comp extends Root {
      static template = template;
    }
    await mount(Comp, fixture);
    const before = fixture.innerHTML;
    state.a = 1;
    await nextTick();
    return [before, fixture.innerHTML];
  }

  test("read only in an attribute: the render follows what the body reads", async () => {
    expect(
      await update(xml`<div><t t-set="b">v<t t-out="this.state.a"/></t><p t-att-data-v="b"/></div>`)
    ).toEqual(['<div><p data-v="v3"></p></div>', '<div><p data-v="v1"></p></div>']);
  });

  test("in a slot, whose owner alone renders again", async () => {
    expect(
      await update(
        xml`<div><t t-set="b"><i t-out="this.state.a"/></t><Box><p t-att-data-v="b"><t t-out="b"/></p></Box></div>`
      )
    ).toEqual([
      '<div><p data-v="<i>3</i>"><i>3</i></p></div>',
      '<div><p data-v="<i>1</i>"><i>1</i></p></div>',
    ]);
  });

  test("a single interpolation, a property and a prop read by a child", async () => {
    const [before, after] = await update(
      xml`<div><t t-set="b">v<t t-out="this.state.a"/></t><p t-attf-data-v="{{b}}"/><input t-att-value="b"/><Label label="b"/></div>`
    );
    expect([before, fixture.querySelector("input")!.value]).toEqual([
      '<div><p data-v="v3"></p><input><p title="v3"></p></div>',
      "v1",
    ]);
    expect(after).toBe('<div><p data-v="v1"></p><input><p title="v1"></p></div>');
  });

  test("in t-att, as an object's value or a pair's", async () => {
    expect(
      await update(
        xml`<div><t t-set="b">v<t t-out="this.state.a"/></t><p t-att="{'data-v': b}"/><p t-att="['data-w', b]"/></div>`
      )
    ).toEqual([
      '<div><p data-v="v3"></p><p data-w="v3"></p></div>',
      '<div><p data-v="v1"></p><p data-w="v1"></p></div>',
    ]);
  });
});
