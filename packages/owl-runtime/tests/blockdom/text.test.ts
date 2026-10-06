import { mount, patch, remove, text } from "../../src/blockdom";
import { makeTestFixture } from "./helpers";

//------------------------------------------------------------------------------
// Setup and helpers
//------------------------------------------------------------------------------

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

afterEach(() => {
  fixture.remove();
});

describe("adding/patching text", () => {
  test("simple text node", async () => {
    const tree = text("foo");
    expect(tree.el).toBe(undefined);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("foo");
    expect(tree.el).not.toBe(undefined);
  });

  test("patching a simple text node", async () => {
    const tree = text("foo");
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("foo");

    patch(tree, text("bar"));
    expect(fixture.innerHTML).toBe("bar");
  });

  test("falsy values in text nodes", () => {
    const cases = [
      [false, "false"],
      [undefined, ""],
      [null, ""],
      [0, "0"],
      ["", ""],
    ];
    for (let [value, result] of cases) {
      const fixture = makeTestFixture();
      mount(text(value as any), fixture);
      expect(fixture.innerHTML).toBe(result);
    }
  });

  test("bigint and symbol values in text nodes", () => {
    for (const [value, result] of [
      [0n, "0"],
      [12n, "12"],
      [Symbol("s"), "Symbol(s)"],
    ]) {
      const fixture = makeTestFixture();
      const tree = text(value as any);
      mount(tree, fixture);
      expect(fixture.innerHTML).toBe(result);
      patch(tree, text(1 as any));
      patch(tree, text(value as any));
      expect(fixture.innerHTML).toBe(result);
    }
  });

  test("a text node stringifies to the HTML it renders", () => {
    const tree = text("a < b & c > d");
    mount(tree, fixture);
    expect(tree.toString()).toBe(fixture.innerHTML);
    expect(tree.toString()).toBe("a &lt; b &amp; c &gt; d");
  });

  test("vtext node can be used as text", () => {
    const t = text("foo") as any;
    mount(text(t), fixture);
    expect(fixture.innerHTML).toBe("foo");
  });
});

describe("remove text  blocks", () => {
  test("a text block can be removed", async () => {
    const tree = text("cat");
    expect(fixture.childNodes.length).toBe(0);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe("cat");
    expect(fixture.childNodes.length).toBe(1);
    remove(tree);
    expect(fixture.innerHTML).toBe("");
    expect(fixture.childNodes.length).toBe(0);
  });
});
