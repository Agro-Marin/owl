import { Component, mount, observe, props, proxy, signal, xml } from "../../src";
import { listKinds, objectKinds, type Item } from "../../../owl-core/tests/foreign_proxy";
import { makeTestFixture, nextTick } from "../helpers";

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

function items(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1 }));
}

describe.each(listKinds)("t-foreach over $name", ({ make, mapped }) => {
  test("renders it, and renders once per write of an item, an index or the length", async () => {
    class Row extends Component {
      static template = xml`<i t-out="this.props.item.id"/>`;
      props = props();
    }
    class List extends Component {
      static template = xml`<t t-out="this.counted()"/><t t-foreach="this.list" t-as="item" t-key="item_index"><Row item="item"/></t>`;
      static components = { Row };
      list = proxy(make(items(2)));
      renders = 0;
      counted() {
        this.renders++;
        return "";
      }
    }
    const list = await mount(List, fixture);
    expect(fixture.innerHTML).toBe("<i>1</i><i>2</i>");
    list.list.push({ id: 3 });
    await nextTick();
    expect(fixture.innerHTML).toBe("<i>1</i><i>2</i><i>3</i>");
    list.list[0] = { id: 7 };
    await nextTick();
    expect(fixture.innerHTML).toBe("<i>7</i><i>2</i><i>3</i>");
    list.list.splice(1, 1);
    await nextTick();
    expect(fixture.innerHTML).toBe("<i>7</i><i>3</i>");
    list.list[1].id = 9;
    await nextTick();
    expect(fixture.innerHTML).toBe("<i>7</i><i>9</i>");
    list.list.length = 0;
    await nextTick();
    expect(fixture.innerHTML).toBe("");
    // the item write re-renders its row only
    expect(list.renders).toBe(5);
  });

  test("keyed by an item's id, held in proxied state", async () => {
    class List extends Component {
      static template = xml`<t t-foreach="this.state.list" t-as="item" t-key="item.id"><b t-out="item.id"/></t>`;
      state = proxy({ list: make(items(3)) });
    }
    const list = await mount(List, fixture);
    expect(fixture.innerHTML).toBe("<b>1</b><b>2</b><b>3</b>");
    list.state.list.splice(0, 1);
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>2</b><b>3</b>");
    list.state.list.push({ id: 4 });
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>2</b><b>3</b><b>4</b>");
  });

  test.runIf(mapped)("re-renders on a write to the data it maps its indices to", async () => {
    class List extends Component {
      static template = xml`<t t-foreach="this.list" t-as="item" t-key="item.id"><b t-out="item.id"/></t>`;
      list: any = proxy(make(items(2)));
    }
    const list = await mount(List, fixture);
    list.list.data.push({ id: 3 });
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>1</b><b>2</b><b>3</b>");
    list.list.data = list.list.data.toSpliced(0, 1);
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>2</b><b>3</b>");
    list.list.data[0].id = 5;
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>5</b><b>3</b>");
  });

  test("a shallow signal of it re-renders on an index written past the end", async () => {
    class List extends Component {
      static template = xml`<t t-foreach="this.list()" t-as="item" t-key="item.id"><b t-out="item.id"/></t>`;
      list = signal.Array(make(items(1)));
    }
    const list = await mount(List, fixture);
    list.list()[1] = { id: 2 };
    await nextTick();
    expect(fixture.innerHTML).toBe("<b>1</b><b>2</b>");
  });
});

describe.each(objectKinds)("a component reading $name", ({ make }) => {
  test("renders once per write, through a getter or a method", async () => {
    class Reader extends Component {
      static template = xml`<t t-out="this.counted()"/><t t-out="this.state.a"/>/<t t-out="this.state.total"/>`;
      state = proxy(make());
      renders = 0;
      counted() {
        this.renders++;
        return "";
      }
    }
    const reader = await mount(Reader, fixture);
    expect(fixture.innerHTML).toBe("1/3");
    reader.state.a = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("2/4");
    reader.state.bump();
    await nextTick();
    expect(fixture.innerHTML).toBe("3/5");
    reader.state.items.push({ id: 3 });
    await nextTick();
    expect(fixture.innerHTML).toBe("3/6");
    expect(reader.renders).toBe(4);
  });

  test("an observe() view of it held by a component calls back once per change", async () => {
    let calls = 0;
    const target = make();
    class Reader extends Component {
      static template = xml`<t t-out="this.state.a"/>`;
      state = observe(target, () => calls++);
    }
    await mount(Reader, fixture);
    proxy(target).a = 5;
    expect(calls).toBe(1);
    await nextTick();
    expect(fixture.innerHTML).toBe("5");
  });
});
