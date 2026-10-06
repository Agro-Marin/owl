import { setDebug, setDebugSink } from "@odoo/owl-core";
import { list, mount, patch, createBlock } from "../../src/blockdom";
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

test("input with value property", () => {
  // render input with initial value
  const block = createBlock(`<input block-property-0="value"/>`);

  const tree = block(["zucchini"]);
  mount(tree, fixture);
  // const bnode1 = renderToBdom(template, { v: "zucchini" });
  // const fixture = makeTestFixture();
  // mount(bnode1, fixture);
  const input = fixture.querySelector("input")!;
  expect(input.value).toBe("zucchini");

  // change value manually in input, to simulate user input
  input.value = "tomato";
  expect(input.value).toBe("tomato");

  // rerender with a different value, and patch actual dom, to check that
  // input value was properly reset by owl
  patch(tree, block(["potato"]));
  expect(input.value).toBe("potato");
});

test("input with value property, and falsy value given", () => {
  const block = createBlock(`<input block-property-0="value"/>`);

  const tree = block([undefined]);
  mount(tree, fixture);
  const input = fixture.querySelector("input")!;
  expect(input.value).toBe("");

  patch(tree, block([null]));
  expect(input.value).toBe("");

  patch(tree, block([0]));
  expect(input.value).toBe("0");

  patch(tree, block([""]));
  expect(input.value).toBe("");

  patch(tree, block([false]));
  expect(input.value).toBe("");
});

test("input type=checkbox with checked property", () => {
  // render input with initial value
  const block = createBlock(`<input type="checkbox" block-property-0="checked"/>`);

  const tree = block([true]);
  mount(tree, fixture);
  expect(fixture.innerHTML).toBe(`<input type="checkbox">`);
  const input = fixture.querySelector("input")!;
  expect(input.checked).toBe(true);
});

test("a select's value is set once the options a child mounts exist", () => {
  const select = createBlock(`<select block-property-0="value"><block-child-0/></select>`);
  const option = createBlock(`<option block-attribute-0="value"><block-text-1/></option>`);
  const options = (values: string[]) =>
    list(
      values.map((v) => {
        const vnode = option([v, v]);
        vnode.key = v;
        return vnode;
      })
    );
  const tree = select(["b"], [options(["a", "b", "c"])]);
  mount(tree, fixture);
  const el = fixture.querySelector("select")!;
  expect(el.value).toBe("b");

  // the option and the value arrive in the same patch
  patch(tree, select(["d"], [options(["a", "b", "c", "d"])]));
  expect(el.value).toBe("d");
});

test("an input's value is set after the attributes bounding it", () => {
  const block = createBlock(
    `<input type="range" block-property-0="value" block-attribute-1="max" block-attribute-2="min"/>`
  );
  const tree = block(["150", "200", "120"]);
  mount(tree, fixture);
  const input = fixture.querySelector("input")!;
  expect(input.value).toBe("150");
  patch(tree, block(["250", "300", "120"]));
  expect(input.value).toBe("250");
});

test("a synced flag already holding its value is not written again", () => {
  const block = createBlock(
    `<div><button block-sync-property-0="disabled"/><input block-sync-property-1="readOnly" block-sync-property-2="value"/></div>`
  );
  const data = () => [true, true, "x"];
  const tree = block(data());
  mount(tree, fixture);
  const observer = new MutationObserver(() => {});
  observer.observe(fixture, { attributes: true, subtree: true });
  for (let i = 0; i < 100; i++) {
    patch(tree, block(data()));
  }
  const records = observer.takeRecords().length;
  observer.disconnect();
  expect(records).toBe(0);
  // a value the user changed is still set back
  const input = fixture.querySelector("input")!;
  input.value = "typed";
  patch(tree, block(data()));
  expect(input.value).toBe("x");
});

test("a synced value is written on every patch, even when the element already reads it", () => {
  // a number input holding a partial "1e" reads "", and setting "" clears it
  const block = createBlock(`<input block-sync-property-0="value"/>`);
  const tree = block([""]);
  mount(tree, fixture);
  const input = fixture.querySelector("input")!;
  const writes: string[] = [];
  Object.defineProperty(input, "value", {
    get: () => "",
    set: (v: string) => writes.push(v),
  });
  patch(tree, block([""]));
  expect(writes).toEqual([""]);
});

test("a synced value the user changed is set back by a patch giving the same value", () => {
  const block = createBlock(`<input block-sync-property-0="value"/>`);
  const tree = block(["zucchini"]);
  mount(tree, fixture);
  const input = fixture.querySelector("input")!;
  input.value = "tomato";
  patch(tree, block(["zucchini"]));
  expect(input.value).toBe("zucchini");
  // 0 is "0", another falsy value ""
  patch(tree, block([0]));
  expect(input.value).toBe("0");
  patch(tree, block([false]));
  expect(input.value).toBe("");
});

test("a synced flag the user changed is set back by a patch giving the same value", () => {
  const block = createBlock(`<input type="checkbox" block-sync-property-0="checked"/>`);
  const tree = block([true]);
  mount(tree, fixture);
  const input = fixture.querySelector("input")!;
  input.checked = false;
  patch(tree, block([true]));
  expect(input.checked).toBe(true);
  // any truthy value is true
  input.checked = false;
  patch(tree, block(["yes"]));
  expect(input.checked).toBe(true);
});

test("a (t-model) property is written only when its value changes", () => {
  const block = createBlock(`<input block-property-0="value"/>`);
  const tree = block(["zucchini"]);
  mount(tree, fixture);
  const input = fixture.querySelector("input")!;
  // what the user types before the model hears of it stays
  input.value = "tomato";
  patch(tree, block(["zucchini"]));
  expect(input.value).toBe("tomato");
  patch(tree, block(["potato"]));
  expect(input.value).toBe("potato");
});

test("the template channel says when a synced flag is not written", () => {
  const lines: string[] = [];
  setDebug("template");
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
  try {
    const block = createBlock(`<button block-sync-property-0="disabled"/>`);
    const tree = block([true]);
    mount(tree, fixture);
    patch(tree, block([true]));
    patch(tree, block([false]));
  } finally {
    setDebug(false);
    setDebugSink(null);
  }
  expect(lines).toEqual(["template: disabled of <button>: not written, it is already true"]);
});
