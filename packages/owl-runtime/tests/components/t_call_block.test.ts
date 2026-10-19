import { createBlock, text } from "../../src/blockdom";
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
});
