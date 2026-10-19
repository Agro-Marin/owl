import { createBlock, list, multi, text } from "../../src/blockdom";
import { Component, mount, proxy, xml } from "../../src";
import { makeTestFixture, nextTick, snapshotEverything } from "../helpers";

snapshotEverything();

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

describe("t-call-block", () => {
  test("simple t-call-block with static text", async () => {
    class Test extends Component {
      static template = xml`<div><t t-call-block="this.myBlock()"/></div>`;
      myBlock() {
        return text("hello");
      }
    }

    await mount(Test, fixture);
    expect(fixture.innerHTML).toBe("<div>hello</div>");
  });

  test("a block of another kind replaces the previous one", async () => {
    const bold = createBlock("<b>bold</b>");
    class Test extends Component {
      static template = xml`<div><t t-call-block="this.myBlock()"/></div>`;
      state = proxy({ bold: false });
      myBlock() {
        return this.state.bold ? bold() : text("plain");
      }
    }
    const test = await mount(Test, fixture);
    expect(fixture.innerHTML).toBe("<div>plain</div>");
    test.state.bold = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><b>bold</b></div>");
    test.state.bold = false;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>plain</div>");
  });

  test("a multi or a list of another shape replaces the previous one", async () => {
    const bold = createBlock("<b>bold</b>");
    const shapes = [
      () => multi([text("a"), text("b")]),
      () => multi([bold()]),
      () => multi([bold(), undefined]),
      () => multi([undefined, text("c")]),
      () => list([text("x"), text("y")]),
      () => list([bold()]),
      () => multi([list([text("z")]), text("!")]),
      () => multi([list([bold()]), text("!")]),
    ];
    const expected = [
      "<div>ab</div>",
      "<div><b>bold</b></div>",
      "<div><b>bold</b></div>",
      "<div>c</div>",
      "<div>xy</div>",
      "<div><b>bold</b></div>",
      "<div>z!</div>",
      "<div><b>bold</b>!</div>",
    ];
    class Test extends Component {
      static template = xml`<div><t t-call-block="this.myBlock()"/></div>`;
      state = proxy({ shape: 0 });
      myBlock() {
        return shapes[this.state.shape]();
      }
    }
    const test = await mount(Test, fixture);
    expect(fixture.innerHTML).toBe(expected[0]);
    for (const shape of [1, 2, 3, 4, 5, 6, 7, 0, 7, 2]) {
      test.state.shape = shape;
      await nextTick();
      expect([shape, fixture.innerHTML]).toEqual([shape, expected[shape]]);
    }
  });

  test("a multi of the same shape is patched, its empty places filled or emptied", async () => {
    class Test extends Component {
      static template = xml`<div><t t-call-block="this.myBlock()"/></div>`;
      state = proxy({ first: true });
      myBlock() {
        return multi([this.state.first ? text("a") : undefined, text("b")]);
      }
    }
    const test = await mount(Test, fixture);
    const b = fixture.firstChild!.lastChild;
    expect(fixture.innerHTML).toBe("<div>ab</div>");
    test.state.first = false;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>b</div>");
    expect(fixture.firstChild!.lastChild).toBe(b);
    test.state.first = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>ab</div>");
    expect(fixture.firstChild!.lastChild).toBe(b);
  });
});
