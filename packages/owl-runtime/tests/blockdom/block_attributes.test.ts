import { mount, patch, createBlock } from "../../src/blockdom";
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

test("simple attribute", async () => {
  const block = createBlock('<div block-attribute-0="hello"></div>');
  const tree = block(["world"]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div hello="world"></div>`);

  patch(tree, block(["owl"]));
  expect(fixture.innerHTML).toBe(`<div hello="owl"></div>`);
});

test("updating attribute with falsy value", async () => {
  const block = createBlock('<div block-attribute-0="hello"></div>');
  const tree = block([false]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div></div>`);

  patch(tree, block(["owl"]));
  expect(fixture.innerHTML).toBe(`<div hello="owl"></div>`);

  patch(tree, block([false]));
  expect(fixture.innerHTML).toBe(`<div></div>`);

  patch(tree, block(["owl"]));
  expect(fixture.innerHTML).toBe(`<div hello="owl"></div>`);

  patch(tree, block([undefined]));
  expect(fixture.innerHTML).toBe(`<div></div>`);
});

test("dynamic attribute (pair)", async () => {
  const block = createBlock('<div block-attributes="0"></div>');
  const tree = block([["hello", "world"]]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div hello="world"></div>`);

  patch(tree, block([["ola", "mundo"]]));
  expect(fixture.innerHTML).toBe(`<div ola="mundo"></div>`);
});

test("dynamic attribute (pair, with false value)", async () => {
  const block = createBlock('<div block-attributes="0"></div>');
  const tree = block([["hello", false]]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div></div>`);

  patch(tree, block([["hello", "world"]]));
  expect(fixture.innerHTML).toBe(`<div hello="world"></div>`);

  patch(tree, block([["hello", false]]));
  expect(fixture.innerHTML).toBe(`<div></div>`);
});

test("dynamic attribute (object)", async () => {
  const block = createBlock('<div block-attributes="0"></div>');
  const tree = block([{ hello: "world" }]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div hello="world"></div>`);

  patch(tree, block([{ ola: "mundo" }]));
  expect(fixture.innerHTML).toBe(`<div ola="mundo"></div>`);
});

test("dynamic attribute (object), with falsy values", async () => {
  const block = createBlock('<div block-attributes="0"></div>');
  const tree = block([{ hello: "world", blip: false }]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div hello="world"></div>`);

  patch(tree, block([{ ola: "mundo", blip: undefined }]));
  expect(fixture.innerHTML).toBe(`<div ola="mundo"></div>`);

  patch(tree, block([{ ola: false, blip: 1 }]));
  expect(fixture.innerHTML).toBe(`<div blip="1"></div>`);

  patch(tree, block([{ ola: undefined, blip: undefined }]));
  expect(fixture.innerHTML).toBe(`<div></div>`);
});

test("class attribute", async () => {
  const block = createBlock('<div block-attribute-0="class"></div>');
  const tree = block(["fire"]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div class="fire"></div>`);

  patch(tree, block(["water"]));
  expect(fixture.innerHTML).toBe(`<div class="water"></div>`);

  patch(tree, block([""]));
  expect(fixture.innerHTML).toBe(`<div class=""></div>`);

  patch(tree, block([0]));
  expect(fixture.innerHTML).toBe(`<div class="0"></div>`);
});

test("attribute with undefined value", async () => {
  const block = createBlock('<div block-attribute-0="abc"></div>');
  const tree = block([undefined]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div></div>`);
});

test("class attribute with undefined value", async () => {
  const block = createBlock('<div block-attribute-0="class"></div>');
  const tree = block([undefined]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div></div>`);
});

test("class attribute (with a preexisting value", async () => {
  const block = createBlock('<div class="tomato" block-attribute-0="class"></div>');
  const tree = block(["potato"]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div class="tomato potato"></div>`);

  patch(tree, block(["squash"]));
  expect(fixture.innerHTML).toBe(`<div class="tomato squash"></div>`);

  patch(tree, block([""]));
  expect(fixture.innerHTML).toBe(`<div class="tomato"></div>`);
});

test("block-class attributes with preexisting class attribute", async () => {
  const block = createBlock('<div block-attributes="0" class="owl"></div>');
  const tree = block([{ class: "eagle" }]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div class="owl eagle"></div>`);

  patch(tree, block([{ class: "falcon" }]));
  expect(fixture.innerHTML).toBe(`<div class="owl falcon"></div>`);

  patch(tree, block([{}]));
  expect(fixture.innerHTML).toBe(`<div class="owl"></div>`);
});

test("block-class attributes (array syntax) with preexisting class attribute", async () => {
  const block = createBlock('<div block-attributes="0" class="owl"></div>');
  const tree = block([["class", "eagle"]]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<div class="owl eagle"></div>`);

  patch(tree, block([["class", "falcon"]]));
  expect(fixture.innerHTML).toBe(`<div class="owl falcon"></div>`);

  patch(tree, block([["class", ""]]));
  expect(fixture.innerHTML).toBe(`<div class="owl"></div>`);

  patch(tree, block([["class", "buzzard"]]));
  expect(fixture.innerHTML).toBe(`<div class="owl buzzard"></div>`);
});

describe("block-attributes changing form", () => {
  test("from nothing to an object and back", async () => {
    const block = createBlock('<div block-attributes="0"></div>');
    const tree = block([null]);
    mount(tree, fixture);
    patch(tree, block([{ a: "1" }]));
    expect(fixture.innerHTML).toBe(`<div a="1"></div>`);
    patch(tree, block([undefined]));
    expect(fixture.innerHTML).toBe(`<div></div>`);
  });

  test("a pair changing name keeps the static class", async () => {
    const block = createBlock('<div class="static" block-attributes="0"></div>');
    const tree = block([["class", "dyn"]]);
    mount(tree, fixture);
    expect(fixture.innerHTML).toBe(`<div class="static dyn"></div>`);
    patch(tree, block([["id", "x"]]));
    expect(fixture.innerHTML).toBe(`<div class="static" id="x"></div>`);
    patch(tree, block([["class", "dyn"]]));
    expect(fixture.innerHTML).toBe(`<div class="static dyn"></div>`);
  });

  test("a pair becoming a style object", async () => {
    const block = createBlock('<div block-attributes="0"></div>');
    const tree = block([["id", "x"]]);
    mount(tree, fixture);
    patch(tree, block([["style", { color: "red" }]]));
    expect(fixture.innerHTML).toBe(`<div style="color: red;"></div>`);
  });
});

test("a false class value adds no class", async () => {
  const block = createBlock('<div block-attribute-0="class"></div>');
  const tree = block([false]);
  mount(tree, fixture);
  const div = fixture.firstChild as HTMLElement;
  expect(div.className).toBe("");
  patch(tree, block(["a"]));
  expect(div.className).toBe("a");
  patch(tree, block([false]));
  expect(div.className).toBe("");
});

describe("style", () => {
  test("removing a longhand re-applies the shorthand before it", async () => {
    const block = createBlock('<div block-attribute-0="style"></div>');
    const tree = block(["margin: 1px; margin-top: 5px"]);
    mount(tree, fixture);
    const div = fixture.firstChild as HTMLElement;
    expect(div.style.marginTop).toBe("5px");
    patch(tree, block(["margin: 1px"]));
    expect(div.style.marginTop).toBe("1px");
  });

  test("a custom property keeps its case", async () => {
    const block = createBlock('<div block-attribute-0="style"></div>');
    mount(block([{ "--mainColor": "red" }]), fixture);
    const div = fixture.firstChild as HTMLElement;
    expect(div.style.getPropertyValue("--mainColor")).toBe("red");
  });
});
