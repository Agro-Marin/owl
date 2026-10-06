import {
  Component,
  markup,
  mount,
  onMounted,
  onWillUnmount,
  props,
  proxy,
  signal,
  xml,
} from "../../src";
import {
  makeTestFixture,
  nextTick,
  render,
  snapshotEverything,
  steps,
  useLogLifecycle,
  getConsoleOutput,
} from "../helpers";

snapshotEverything();

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

describe("list of components", () => {
  test("emptied, keeps a node one of its components put among the items as it unmounts", async () => {
    const seen: string[] = [];
    class Item extends Component {
      static template = xml`<li><t t-out="this.props.id"/></li>`;
      props = props();
      setup() {
        onWillUnmount(() => {
          const ul = fixture.querySelector("ul")!;
          seen.push(`${this.props.id}:${ul.children.length}`);
          if (this.props.id === 2) {
            ul.insertBefore(document.createElement("b"), ul.firstChild);
          }
        });
      }
    }
    class List extends Component {
      static template = xml`<ul><t t-foreach="this.ids()" t-as="id" t-key="id"><Item id="id"/></t></ul>`;
      static components = { Item };
      ids = signal([1, 2, 3]);
    }
    const parent = await mount(List, fixture);
    expect(fixture.innerHTML).toBe("<ul><li>1</li><li>2</li><li>3</li></ul>");
    parent.ids.set([]);
    await nextTick();
    expect(fixture.innerHTML).toBe("<ul><b></b></ul>");
    // every item unmounts while the list is still in place
    expect(seen).toEqual(["1:3", "2:3", "3:4"]);
  });

  test("a keyed item switching between text and markup, or between tags", async () => {
    class Parent extends Component {
      static template = xml`
        <t t-foreach="this.items()" t-as="item" t-key="item.id"><t t-out="item.content"/></t>
        <t t-foreach="this.items()" t-as="item" t-key="item.id"><t t-tag="item.tag">x</t></t>`;
      items = signal<any[]>([{ id: 1, content: "plain", tag: "p" }]);
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("plain<p>x</p>");
    parent.items.set([{ id: 1, content: markup("<b>bold</b>"), tag: "span" }]);
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>bold</b><span>x</span>");
  });

  test("simple list", async () => {
    class Child extends Component {
      static template = xml`<span><t t-out="this.props.value"/></span>`;
      props = props();
    }

    class Parent extends Component {
      static template = xml`
            <t t-foreach="this.state.elems" t-as="elem" t-key="elem.id">
                <Child value="elem.value"/>
            </t>`;
      static components = { Child };

      state = proxy({
        elems: [
          { id: 1, value: "a" },
          { id: 2, value: "b" },
        ],
      });
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<span>a</span><span>b</span>");
    parent.state.elems.push({ id: 4, value: "d" });
    await nextTick();
    expect(fixture.innerHTML).toBe("<span>a</span><span>b</span><span>d</span>");

    parent.state.elems.pop();

    await nextTick();
    expect(fixture.innerHTML).toBe("<span>a</span><span>b</span>");
  });

  test("components in a node in a t-foreach ", async () => {
    class Child extends Component {
      static template = xml`<div><t t-out="this.props.item"/></div>`;
      props = props();
      setup() {
        useLogLifecycle(this);
      }
    }

    class Parent extends Component {
      static template = xml`
              <div>
                  <ul>
                      <t t-foreach="this.items" t-as="item" t-key="'li_'+item">
                          <li>
                              <Child item="item"/>
                          </li>
                      </t>
                  </ul>
              </div>`;
      static components = { Child };

      setup() {
        useLogLifecycle(this);
      }

      get items() {
        return [1, 2];
      }
    }

    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<div><ul><li><div>1</div></li><li><div>2</div></li></ul></div>"
    );
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Parent:setup",
        "Parent:willStart",
        "Child:setup",
        "Child:willStart",
        "Child:setup",
        "Child:willStart",
        "Child:mounted",
        "Child:mounted",
        "Parent:mounted",
      ]
    `);
  });

  test("reconciliation alg works for t-foreach in t-foreach", async () => {
    class Child extends Component {
      static template = xml`<div><t t-out="this.props.blip"/></div>`;
      props = props();
    }

    class Parent extends Component {
      static template = xml`
        <div>
            <t t-foreach="this.state.s" t-as="section" t-key="section_index">
                <t t-foreach="section.blips" t-as="blip" t-key="blip_index">
                  <Child blip="blip"/>
                </t>
            </t>
        </div>`;
      static components = { Child };
      state = { s: [{ blips: ["a1", "a2"] }, { blips: ["b1"] }] };
    }

    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div><div>a1</div><div>a2</div><div>b1</div></div>");
  });

  test("reconciliation alg works for t-foreach in t-foreach, 2", async () => {
    class Child extends Component {
      static template = xml`<div><t t-out="this.props.row + '_' + this.props.col"/></div>`;
      props = props();
    }

    class Parent extends Component {
      static template = xml`
        <div>
          <p t-foreach="this.state.rows" t-as="row" t-key="row">
            <p t-foreach="this.state.cols" t-as="col" t-key="col">
                <Child row="row" col="col"/>
              </p>
            </p>
        </div>`;
      static components = { Child };
      state = proxy({ rows: [1, 2], cols: ["a", "b"] });
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<div><p><p><div>1_a</div></p><p><div>1_b</div></p></p><p><p><div>2_a</div></p><p><div>2_b</div></p></p></div>"
    );
    parent.state.rows = [2, 1];
    await nextTick();
    expect(fixture.innerHTML).toBe(
      "<div><p><p><div>2_a</div></p><p><div>2_b</div></p></p><p><p><div>1_a</div></p><p><div>1_b</div></p></p></div>"
    );
  });

  test("sub components rendered in a loop", async () => {
    class Child extends Component {
      static template = xml`<p><t t-out="this.props.n"/></p>`;
      props = props();
    }

    class Parent extends Component {
      static template = xml`
        <div>
          <t t-foreach="this.state.numbers" t-as="number" t-key="number" >
            <Child n="number"/>
          </t>
        </div>`;
      static components = { Child };

      state = proxy({ numbers: [1, 2, 3] });
    }
    await mount(Parent, fixture);

    expect(fixture.innerHTML).toBe(`<div><p>1</p><p>2</p><p>3</p></div>`);
  });

  test("sub components with some state rendered in a loop", async () => {
    let n = 1;

    class Child extends Component {
      static template = xml`<p><t t-out="this.state.n"/></p>`;
      state: any;
      setup() {
        this.state = proxy({ n });
        n++;
      }
    }

    class Parent extends Component {
      static template = xml`
        <div>
          <t t-foreach="this.state.numbers" t-as="number" t-key="number">
            <Child/>
          </t>
        </div>`;
      static components = { Child };

      state = proxy({
        numbers: [1, 2, 3],
      });
    }
    const parent = await mount(Parent, fixture);

    parent.state.numbers = [1, 3];
    await nextTick();
    expect(fixture.innerHTML).toBe(`<div><p>1</p><p>3</p></div>`);
  });

  test("list of sub components inside other nodes", async () => {
    // this confuses the patching algorithm...
    class SubComponent extends Component {
      static template = xml`<span>asdf</span>`;
    }
    class Parent extends Component {
      static template = xml`
      <div>
          <div t-foreach="this.state.blips" t-as="blip" t-key="blip.id">
              <SubComponent />
          </div>
      </div>`;
      static components = { SubComponent };
      state = proxy({
        blips: [
          { a: "a", id: 1 },
          { b: "b", id: 2 },
          { c: "c", id: 4 },
        ],
      });
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<div><div><span>asdf</span></div><div><span>asdf</span></div><div><span>asdf</span></div></div>"
    );
    parent.state.blips.splice(0, 1);
    await nextTick();
    expect(fixture.innerHTML).toBe(
      "<div><div><span>asdf</span></div><div><span>asdf</span></div></div>"
    );
  });

  test("t-foreach with t-component, and update", async () => {
    class Child extends Component {
      static template = xml`
          <span>
            <t t-out="this.state.val"/>
            <t t-out="this.props.val"/>
          </span>`;
      props = props();
      state = proxy({ val: "A" });
      setup() {
        onMounted(() => {
          this.state.val = "B";
        });
      }
    }
    class Parent extends Component {
      static components = { Child };
      static template = xml`
          <div>
            <t t-foreach="Array(2)" t-as="n" t-key="n_index">
              <Child val="n_index"/>
            </t>
          </div>`;
    }

    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div><span>A0</span><span>A1</span></div>");

    await nextTick(); // wait for changes triggered in mounted to be applied
    expect(fixture.innerHTML).toBe("<div><span>B0</span><span>B1</span></div>");
  });

  test("switch component position", async () => {
    const childInstances = [];
    class Child extends Component {
      static template = xml`<div t-out="this.props.key"></div>`;
      props = props();
      setup() {
        childInstances.push(this);
      }
    }

    class Parent extends Component {
      static components = { Child };
      static template = xml`<span>
        <t t-foreach="this.clist" t-as="c" t-key="c">
          <Child key="c"/>
        </t>
      </span>`;

      clist = [1, 2];
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<span><div>1</div><div>2</div></span>");
    parent.clist = [2, 1];
    render(parent);
    await nextTick();
    expect(fixture.innerHTML).toBe("<span><div>2</div><div>1</div></span>");
    expect(childInstances.length).toBe(2);
  });

  test("crash on duplicate key in dev mode", async () => {
    class Child extends Component {
      static template = xml``;
    }

    class Parent extends Component {
      static template = xml`
        <t t-foreach="[1, 2]" t-as="item" t-key="'child'">
          <Child/>
        </t>
      `;
      static components = { Child };
    }
    let error: any;
    try {
      await mount(Parent, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error.message).toBe("Got duplicate key in t-foreach: child");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("dev mode: keys the list tells apart give their components keys of their own", async () => {
    class Child extends Component {
      static template = xml`<i t-out="this.props.v"/>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<t t-foreach="this.items" t-as="item" t-key="item"><Child v="item"/></t>`;
      static components = { Child };
      items = [1, "1"];
    }
    const parent = await mount(Parent, fixture, { test: true });
    expect(fixture.innerHTML).toBe("<i>1</i><i>1</i>");
    expect(Object.keys(parent.__owl__.children)).toHaveLength(2);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("dev mode: keys the list tells apart give a t-set body output in the loop keys of its own", async () => {
    class Child extends Component {
      static template = xml`<i>child</i>`;
    }
    class Parent extends Component {
      static template = xml`
        <t t-set="v"><Child/></t>
        <t t-foreach="this.items" t-as="item" t-key="item"><t t-out="v"/></t>`;
      static components = { Child };
      items = [1, "1"];
    }
    const parent = await mount(Parent, fixture, { test: true });
    expect(fixture.innerHTML).toBe("<i>child</i><i>child</i>");
    expect(Object.keys(parent.__owl__.children)).toHaveLength(2);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("dev mode: a body without components keeps the list's own keys", async () => {
    class Parent extends Component {
      static template = xml`<t t-foreach="this.items" t-as="item" t-key="item"><i t-att-class="typeof item"/></t>`;
      items = [1, "1"];
    }
    await mount(Parent, fixture, { test: true });
    expect(fixture.innerHTML).toBe('<i class="number"></i><i class="string"></i>');
  });

  test("object keys are told apart by identity, components included", async () => {
    const instances: any[] = [];
    class Child extends Component {
      static template = xml`<i t-out="this.props.item.n"/>`;
      props = props();
      setup() {
        instances.push(this);
      }
    }

    class Parent extends Component {
      static template = xml`
        <t t-foreach="this.state.items" t-as="item" t-key="item">
          <Child item="item"/>
        </t>
      `;
      static components = { Child };
      state = proxy({ items: [{ n: 1 }, { n: 2 }] });
    }

    const parent = await mount(Parent, fixture, { test: true });
    expect(fixture.innerHTML).toBe("<i>1</i><i>2</i>");
    expect(instances.length).toBe(2);
    parent.state.items = [parent.state.items[1], parent.state.items[0]];
    await nextTick();
    expect(fixture.innerHTML).toBe("<i>2</i><i>1</i>");
    expect(instances.length).toBe(2);
  });

  test("crash on the same object used twice as a key in dev mode", async () => {
    class Child extends Component {
      static template = xml``;
    }

    class Parent extends Component {
      static template = xml`
        <t t-foreach="[this.obj, this.obj]" t-as="item" t-key="item">
          <Child/>
        </t>
      `;
      static components = { Child };
      obj = {};
    }

    let error: any;
    try {
      await mount(Parent, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error.message).toBe("Got duplicate key in t-foreach: [object Object]");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("order is correct when slots are not of same type", async () => {
    class Child extends Component {
      static template = xml`
          <t t-foreach="this.slotNames" t-as="slotName" t-key="slotName" t-call-slot="{{ slotName }}"/>
      `;
      props = props();
      get slotNames() {
        return Object.entries(this.props.slots)
          .filter((entry: any) => entry[1].active)
          .map((entry) => entry[0]);
      }
    }

    class Parent extends Component {
      static template = xml`
        <Child>
          <t t-set-slot="a" active="!this.state.active"><div t-if="!this.state.active">A</div></t>
          <t t-set-slot="b" active="true">B</t>
          <t t-set-slot="c" active="this.state.active">C</t>
        </Child>
      `;
      static components = { Child };
      state = proxy({ active: false });
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.textContent).toBe("AB");
    parent.state.active = true;
    await nextTick();
    expect(fixture.textContent).toBe("BC");
  });
});
