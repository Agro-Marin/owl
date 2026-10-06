import { setDebug, setDebugSink } from "@odoo/owl-core";
import { mount, createBlock, multi, config, patch } from "../../src/blockdom";
// import { defaultHandler, setupMainHandler } from "../../src/bdom/block";
import { makeTestFixture } from "./helpers";

//------------------------------------------------------------------------------
// Setup and helpers
//------------------------------------------------------------------------------

let fixture: HTMLElement;
let initialHandler = config.mainEventHandler;

beforeEach(() => {
  fixture = makeTestFixture();
  config.mainEventHandler = initialHandler;
});

afterEach(() => {
  fixture.remove();
});

test("simple event handling, with function", async () => {
  let n = 0;
  const block_handlers = [() => n++];
  const block = createBlock('<div block-handler-0="click"></div>', block_handlers);
  const tree = block([{}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(fixture.firstChild).toBeInstanceOf(HTMLDivElement);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(1);
});

test("simple event handling, with function and argument", async () => {
  let n = 0;
  // the handler's code is static, given with the block; its data is the
  // context the handler gets
  const onClick = (arg: number) => {
    n += arg;
  };
  const block_handlers = [onClick];
  const block = createBlock('<div block-handler-0="click"></div>', block_handlers);
  const tree = block([3], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(fixture.firstChild).toBeInstanceOf(HTMLDivElement);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(3);

  patch(tree, block([5], null, block_handlers));
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(8);
});

test("simple event handling ", async () => {
  config.mainEventHandler = (fn, mods, ctx) => {
    const [owner, method] = ctx;
    owner[method]();
  };

  const block_handlers = [null];

  const block = createBlock('<div block-handler-0="click"></div>', block_handlers);
  let n = 0;
  const obj = { f: () => n++ };
  const tree = block([[obj, "f"]], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(fixture.firstChild).toBeInstanceOf(HTMLDivElement);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(1);
});

test("can bind two handlers on same node", async () => {
  let steps: string[] = [];
  let handleClick = () => steps.push("click");
  let handleDblClick = () => steps.push("dblclick");
  const block_handlers = [handleClick, handleDblClick];
  const block = createBlock(
    '<div block-handler-0="click" block-handler-1="dblclick"></div>',
    block_handlers
  );
  const tree = block([{}, {}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  (fixture.firstChild as HTMLDivElement).dispatchEvent(new Event("dblclick", { bubbles: true }));
  expect(steps).toEqual(["click", "dblclick"]);
});

test("two same block nodes with different handler contexts", async () => {
  let steps: string[] = [];
  const block_handlers = [(ctx: string) => steps.push(ctx)];
  const block = createBlock('<div block-handler-0="click"></div>', block_handlers);
  const tree = multi([block(["1"], null, block_handlers), block(["2"], null, block_handlers)]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div><div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  (fixture.firstChild!.nextSibling as HTMLDivElement).click();
  expect(steps).toEqual(["1", "2"]);
});

test("two same block nodes with different handler contexts (synthetic)", async () => {
  let steps: string[] = [];
  const block_handlers = [(ctx: string) => steps.push(ctx)];
  const block = createBlock('<div block-handler-0="click.synthetic"></div>', block_handlers);
  const tree = multi([block(["1"], null, block_handlers), block(["2"], null, block_handlers)]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div><div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  (fixture.firstChild!.nextSibling as HTMLDivElement).click();
  expect(steps).toEqual(["1", "2"]);
});

test("two event handlers on same event", async () => {
  let n = 0;
  let m = 0;
  const block_handlers = [() => m++, () => n++];
  const block = createBlock(
    '<div block-handler-0="click" block-handler-1="click"></div>',
    block_handlers
  );
  const tree = block([{}, {}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(m).toBe(0);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(m).toBe(1);
  expect(n).toBe(1);
});

test("two synthetic event handlers on same event", async () => {
  let n = 0;
  let m = 0;
  const block_handlers = [() => m++, () => n++];
  const block = createBlock(
    '<div block-handler-0="click.synthetic" block-handler-1="click.synthetic"></div>',
    block_handlers
  );
  const tree = block([{}, {}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(m).toBe(0);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(m).toBe(1);
  expect(n).toBe(1);
});

test("synthetic and native handlers can cohabitate", async () => {
  let steps: string[] = [];
  let handler1 = () => steps.push("1");
  let handler2 = () => steps.push("2");
  const block_handlers = [handler1, handler2];
  const block = createBlock(
    '<div block-handler-0="click.synthetic"><div block-handler-1="click"/></div>',
    block_handlers
  );
  const tree = block([{}, {}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div><div></div></div>");

  (fixture.firstChild!.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["2", "1"]);
  (fixture.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["2", "1", "1"]);
});

test("synthetic and native handlers can cohabitate (2)", async () => {
  let steps: string[] = [];
  let handler1 = () => steps.push("1");
  let handler2 = () => steps.push("2");
  const block_handlers = [handler1, handler2];
  const block = createBlock(
    '<div block-handler-0="click"><div block-handler-1="click.synthetic"/></div>',
    block_handlers
  );
  const tree = block([{}, {}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div><div></div></div>");

  (fixture.firstChild!.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["1", "2"]);
  (fixture.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["1", "2", "1"]);
});

test("synthetic and native handlers can cohabitate (3)", async () => {
  let steps: string[] = [];
  const handler0 = () => steps.push("0");
  let handler1 = () => steps.push("1");
  let handler2 = () => steps.push("2");
  const parent_handlers = [handler0];
  const parent = createBlock(
    `<div block-handler-0="click"><block-child-0/><block-child-1/></div>`,
    parent_handlers
  );
  const block_handlers = [handler1];
  const block = createBlock('<div block-handler-0="click"/>', block_handlers);
  const blockSynth_handlers = [handler2];
  const blockSynth = createBlock('<div block-handler-0="click.synthetic"/>', blockSynth_handlers);
  const tree = parent(
    [{}],
    [block([{}], null, block_handlers), blockSynth([{}], null, blockSynth_handlers)],
    parent_handlers
  );

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div><div></div><div></div></div>");

  const children = fixture.children[0].children;

  (children[0] as HTMLElement).click();
  expect(steps).toEqual(["1", "0"]);
  (children[1] as HTMLElement).click();
  expect(steps).toEqual(["1", "0", "0", "2"]);
});

test("synthetic and native handlers can cohabitate (4)", async () => {
  let steps: string[] = [];
  const handler0 = (ctx: any, ev: Event) => {
    steps.push("0");
    ev.stopPropagation();
  };
  let handler1 = () => steps.push("1");
  let handler2 = () => steps.push("2");
  const parent_handlers = [handler0];
  const parent = createBlock(
    `<div block-handler-0="click"><block-child-0/><block-child-1/></div>`,
    parent_handlers
  );
  const block_handlers = [handler1];
  const block = createBlock('<div block-handler-0="click"/>', block_handlers);
  const blockSynth_handlers = [handler2];
  const blockSynth = createBlock('<div block-handler-0="click.synthetic"/>', blockSynth_handlers);
  const tree = parent(
    [{}],
    [block([{}], null, block_handlers), blockSynth([{}], null, blockSynth_handlers)],
    parent_handlers
  );

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div><div></div><div></div></div>");

  const children = fixture.children[0].children;

  (children[0] as HTMLElement).click();
  expect(steps).toEqual(["1", "0"]);
  (children[1] as HTMLElement).click();
  expect(steps).toEqual(["1", "0", "0"]);
});

test("synthetic and native handlers can cohabitate (5)", async () => {
  let steps: string[] = [];
  let handler1 = () => steps.push("1");
  let handler2 = () => steps.push("2");
  const block_handlers = [handler1, handler2];
  const block = createBlock(
    '<div block-handler-0="click.synthetic" block-handler-1="click"/>',
    block_handlers
  );
  const tree = block([{}, {}], null, block_handlers);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["2", "1"]);
});

test("synthetic and native handlers can cohabitate (6)", async () => {
  let steps: string[] = [];
  const handler1 = () => steps.push("1");
  const handler2 = () => steps.push("2");
  const handler3 = () => steps.push("3");
  const handler4 = () => steps.push("4");
  const block_handlers = [handler1, handler2, handler3, handler4];
  const block = createBlock(
    `<div
    block-handler-0="click.synthetic"
    block-handler-1="click"
    block-handler-2="click.synthetic"
    block-handler-3="click"
  />`,
    block_handlers
  );
  const tree = block([{}, {}, {}, {}], null, block_handlers);
  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["2", "4", "1", "3"]);
});

test("a block string has one block type, given its handlers at each call", async () => {
  const handlers = [() => {}];
  const str = '<div block-handler-0="click"></div>';
  const type = createBlock(str, [() => {}]);
  expect(createBlock(str, handlers)).toBe(type);
  expect(createBlock(str)).toBe(type);
  expect(type([{}], null, handlers).constructor).toBe(type([{}], null, [() => {}]).constructor);
  expect(() => createBlock(str, [])).toThrow("1 handlers, 0 given");
  expect(() => createBlock(str, ["f" as any])).toThrow("Invalid handler");
  // a call without its handlers fails at mount, not at the first event
  expect(() => mount(type([{}]), fixture)).toThrow("1 handlers, 0 given");
});

test("the template channel says when a block type is made, once per string", async () => {
  const lines: string[] = [];
  setDebug("template");
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
  try {
    const str = '<i block-handler-0="click" data-t="debug-once"></i>';
    createBlock(str, [null]);
    createBlock(str, [() => {}]);
    createBlock(str);
  } finally {
    setDebug(false);
    setDebugSink(null);
  }
  expect(lines).toEqual([
    'template: block type made: 1 handlers, <i block-handler-0="click" data-t="debug-once"></i>',
  ]);
});

test("a block patched with one of the same string and other handlers runs the other's", async () => {
  const calls: string[] = [];
  const str = '<div block-handler-0="click"></div>';
  const a_handlers = [(ctx: string) => calls.push("a " + ctx)];
  const a = createBlock(str, a_handlers);
  const b_handlers = [(ctx: string) => calls.push("b " + ctx)];
  const b = createBlock(str, b_handlers);
  const tree = a(["1"], null, a_handlers);
  mount(tree, fixture);
  (fixture.firstChild as HTMLElement).click();
  patch(tree, b(["2"], null, b_handlers));
  (fixture.firstChild as HTMLElement).click();
  expect(calls).toEqual(["a 1", "b 2"]);
});

test("a handler argument is given to the handler after the event", async () => {
  const calls: any[] = [];
  const handler = (ctx: any, ev: Event, arg: any) => calls.push([ctx, ev.type, arg]);
  for (const event of ["click", "click.synthetic"]) {
    calls.length = 0;
    const block_handlers = [handler, handler];
    const block = createBlock(
      `<div block-handler-0="${event}" block-handler-arg-1="0" block-handler-2="${event}"/>`,
      block_handlers
    );
    const tree = block(["a", "model1", "b"], null, block_handlers);
    mount(tree, fixture);
    const div = fixture.lastChild as HTMLElement;
    div.click();
    patch(tree, block(["c", "model2", "d"], null, block_handlers));
    div.click();
    expect(calls).toEqual([
      ["a", "click", "model1"],
      ["b", "click", undefined],
      ["c", "click", "model2"],
      ["d", "click", undefined],
    ]);
  }
});
