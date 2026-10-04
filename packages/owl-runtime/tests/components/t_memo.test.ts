import { Component, mount, onWillUpdateProps, props, proxy, xml } from "../../src";
import { makeDeferred, makeTestFixture, nextTick, snapshotEverything } from "../helpers";

let fixture: HTMLElement;

snapshotEverything();

beforeEach(() => {
  fixture = makeTestFixture();
});

const rowsText = () => [...fixture.querySelectorAll("li")].map((li) => li.textContent);

describe("t-memo", () => {
  test("an item whose dependencies are unchanged keeps its previous content", async () => {
    class List extends Component {
      static template = xml`
        <ul><li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[row.label]"
          t-att-class="{ on: row.id === this.state.selected }"><t t-out="row.label"/>/<t t-out="row.note"/></li></ul>`;
      state = proxy({
        selected: 0,
        rows: [
          { id: 1, label: "a", note: "x" },
          { id: 2, label: "b", note: "y" },
        ],
      });
    }
    const list = await mount(List, fixture);
    expect(rowsText()).toEqual(["a/x", "b/y"]);
    // not a dependency: the item is not rendered again
    list.state.rows[0].note = "changed";
    list.state.selected = 1;
    await nextTick();
    expect(rowsText()).toEqual(["a/x", "b/y"]);
    expect(fixture.querySelector(".on")).toBe(null);
    list.state.rows[0].label = "A";
    await nextTick();
    expect(rowsText()).toEqual(["A/changed", "b/y"]);
    expect(fixture.querySelector(".on")!.textContent).toBe("A/changed");
  });

  test("memoized items move, disappear and come back with the right content", async () => {
    class List extends Component {
      static template = xml`
        <ul><li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[row.label]" t-out="row.label"/></ul>`;
      state = proxy({ rows: [1, 2, 3, 4].map((id) => ({ id, label: `r${id}` })) });
    }
    const list = await mount(List, fixture);
    const rows = list.state.rows;
    const second = fixture.querySelectorAll("li")[1];
    [rows[1], rows[3]] = [rows[3], rows[1]];
    await nextTick();
    expect(rowsText()).toEqual(["r1", "r4", "r3", "r2"]);
    expect(fixture.querySelectorAll("li")[3]).toBe(second);
    rows.splice(1, 1);
    rows.push({ id: 5, label: "r5" });
    await nextTick();
    expect(rowsText()).toEqual(["r1", "r3", "r2", "r5"]);
    rows.unshift({ id: 4, label: "r4 again" });
    await nextTick();
    expect(rowsText()).toEqual(["r4 again", "r1", "r3", "r2", "r5"]);
  });

  test("a list the previous render did not show starts without memos", async () => {
    class List extends Component {
      static template = xml`
        <ul t-if="this.state.shown"><li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[]" t-out="row.label"/></ul>`;
      state = proxy({ shown: true, rows: [{ id: 1, label: "one" }] });
    }
    const list = await mount(List, fixture);
    expect(rowsText()).toEqual(["one"]);
    list.state.shown = false;
    await nextTick();
    expect(rowsText()).toEqual([]);
    list.state.rows[0].label = "uno";
    list.state.shown = true;
    await nextTick();
    expect(rowsText()).toEqual(["uno"]);
  });

  test("nested memoized lists keep the items of each outer item apart", async () => {
    // same key and same dependencies in both groups: only the site tells them apart
    class Groups extends Component {
      static template = xml`
        <p t-out="this.state.title"/>
        <div t-foreach="this.state.groups" t-as="group" t-key="group.id">
          <ul><li t-foreach="group.items" t-as="item" t-key="item.id" t-memo="[item.label]"><t t-out="group.id"/>:<t t-out="item.label"/></li></ul>
        </div>`;
      state = proxy({
        title: "t",
        groups: [
          { id: "g1", items: [{ id: 1, label: "same" }] },
          { id: "g2", items: [{ id: 1, label: "same" }] },
        ],
      });
    }
    const groups = await mount(Groups, fixture);
    expect(rowsText()).toEqual(["g1:same", "g2:same"]);
    groups.state.title = "re-render";
    await nextTick();
    expect(rowsText()).toEqual(["g1:same", "g2:same"]);
    groups.state.groups.reverse();
    await nextTick();
    expect(rowsText()).toEqual(["g2:same", "g1:same"]);
    groups.state.groups[0].items[0].label = "changed";
    await nextTick();
    expect(rowsText()).toEqual(["g2:changed", "g1:same"]);
  });

  test("a render superseded before it is applied leaves memos the next one can use", async () => {
    const def = makeDeferred();
    class Child extends Component {
      static template = xml`<span t-out="this.props.value"/>`;
      props = props();
      setup() {
        onWillUpdateProps(() => def);
      }
    }
    class List extends Component {
      static template = xml`
        <Child value="this.state.value"/>
        <ul><li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[row.label]" t-out="row.label"/></ul>`;
      static components = { Child };
      state = proxy({ value: 0, rows: [1, 2].map((id) => ({ id, label: `r${id}` })) });
    }
    const list = await mount(List, fixture);
    list.state.value = 1;
    list.state.rows[0].label = "first";
    await nextTick();
    // the first render waits for its child: nothing applied yet
    expect(rowsText()).toEqual(["r1", "r2"]);
    list.state.rows.push({ id: 3, label: "r3" });
    list.state.rows[1].label = "second";
    await nextTick();
    def.resolve();
    await nextTick();
    expect(rowsText()).toEqual(["first", "second", "r3"]);
    expect(fixture.querySelector("span")!.textContent).toBe("1");
  });

  test("a memoized list in a template called twice keeps each call's items apart", async () => {
    const sub = xml`<ul><li t-foreach="rows" t-as="row" t-key="row.id" t-memo="[row.label]"><t t-out="side"/>:<t t-out="row.label"/></li></ul>`;
    class Lists extends Component {
      static template = xml`
        <p t-out="this.state.title"/>
        <t t-call="${sub}" rows="this.state.left" side="'left'"/>
        <t t-call="${sub}" rows="this.state.right" side="'right'"/>`;
      state = proxy({
        title: "t",
        left: [{ id: 1, label: "same" }],
        right: [{ id: 1, label: "same" }],
      });
    }
    const lists = await mount(Lists, fixture);
    expect(rowsText()).toEqual(["left:same", "right:same"]);
    lists.state.title = "re-render";
    await nextTick();
    expect(rowsText()).toEqual(["left:same", "right:same"]);
    lists.state.right[0].label = "changed";
    await nextTick();
    expect(rowsText()).toEqual(["left:same", "right:changed"]);
  });

  test("rejects an item it could not skip, and dependencies that are not an array", async () => {
    class Child extends Component {
      static template = xml`<span/>`;
    }
    const compile = (body: string) => {
      class List extends Component {
        static template = xml`<ul>${body}</ul>`;
        static components = { Child };
        state = proxy({ rows: [{ id: 1 }], total: 0 });
      }
      return mount(List, fixture);
    };
    await expect(
      compile(`<li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[]"><Child/></li>`)
    ).rejects.toThrow("t-memo needs an item made of elements, text and t-out only");
    await expect(
      compile(
        `<li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[]"><t t-if="row.id">x</t><t t-else=""><t t-call="other"/></t></li>`
      )
    ).rejects.toThrow("found t-call");
    await expect(
      compile(
        `<t t-set="count" t-value="0"/><li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="[]"><t t-set="count" t-value="count + 1"/></li>`
      )
    ).rejects.toThrow('t-set="count" inside a t-memo item writes a variable of an enclosing scope');
    await expect(
      compile(`<li t-foreach="this.state.rows" t-as="row" t-key="row.id" t-memo="row.id"/>`)
    ).rejects.toThrow("t-memo expects an array of dependencies");
  });
});
