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
  const block = createBlock('<div block-handler-0="click"></div>', [() => n++]);
  const tree = block([{}]);

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
  const block = createBlock('<div block-handler-0="click"></div>', [onClick]);
  const tree = block([3]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(fixture.firstChild).toBeInstanceOf(HTMLDivElement);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(3);

  patch(tree, block([5]));
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(8);
});

test("simple event handling ", async () => {
  config.mainEventHandler = (fn, mods, ctx) => {
    const [owner, method] = ctx;
    owner[method]();
  };

  const block = createBlock('<div block-handler-0="click"></div>', [null]);
  let n = 0;
  const obj = { f: () => n++ };
  const tree = block([[obj, "f"]]);

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
  const block = createBlock('<div block-handler-0="click" block-handler-1="dblclick"></div>', [
    handleClick,
    handleDblClick,
  ]);
  const tree = block([{}, {}]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  (fixture.firstChild as HTMLDivElement).dispatchEvent(new Event("dblclick", { bubbles: true }));
  expect(steps).toEqual(["click", "dblclick"]);
});

test("two same block nodes with different handler contexts", async () => {
  let steps: string[] = [];
  const block = createBlock('<div block-handler-0="click"></div>', [
    (ctx: string) => steps.push(ctx),
  ]);
  const tree = multi([block(["1"]), block(["2"])]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div><div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  (fixture.firstChild!.nextSibling as HTMLDivElement).click();
  expect(steps).toEqual(["1", "2"]);
});

test("two same block nodes with different handler contexts (synthetic)", async () => {
  let steps: string[] = [];
  const block = createBlock('<div block-handler-0="click.synthetic"></div>', [
    (ctx: string) => steps.push(ctx),
  ]);
  const tree = multi([block(["1"]), block(["2"])]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div><div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  (fixture.firstChild!.nextSibling as HTMLDivElement).click();
  expect(steps).toEqual(["1", "2"]);
});

test("two event handlers on same event", async () => {
  let n = 0;
  let m = 0;
  const block = createBlock('<div block-handler-0="click" block-handler-1="click"></div>', [
    () => m++,
    () => n++,
  ]);
  const tree = block([{}, {}]);

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
  const block = createBlock(
    '<div block-handler-0="click.synthetic" block-handler-1="click.synthetic"></div>',
    [() => m++, () => n++]
  );
  const tree = block([{}, {}]);

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
  const block = createBlock(
    '<div block-handler-0="click.synthetic"><div block-handler-1="click"/></div>',
    [handler1, handler2]
  );
  const tree = block([{}, {}]);

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
  const block = createBlock(
    '<div block-handler-0="click"><div block-handler-1="click.synthetic"/></div>',
    [handler1, handler2]
  );
  const tree = block([{}, {}]);

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
  const parent = createBlock(
    `<div block-handler-0="click"><block-child-0/><block-child-1/></div>`,
    [handler0]
  );
  const block = createBlock('<div block-handler-0="click"/>', [handler1]);
  const blockSynth = createBlock('<div block-handler-0="click.synthetic"/>', [handler2]);
  const tree = parent([{}], [block([{}]), blockSynth([{}])]);

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
  const parent = createBlock(
    `<div block-handler-0="click"><block-child-0/><block-child-1/></div>`,
    [handler0]
  );
  const block = createBlock('<div block-handler-0="click"/>', [handler1]);
  const blockSynth = createBlock('<div block-handler-0="click.synthetic"/>', [handler2]);
  const tree = parent([{}], [block([{}]), blockSynth([{}])]);

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
  const block = createBlock('<div block-handler-0="click.synthetic" block-handler-1="click"/>', [
    handler1,
    handler2,
  ]);
  const tree = block([{}, {}]);

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
  const block = createBlock(
    `<div
    block-handler-0="click.synthetic"
    block-handler-1="click"
    block-handler-2="click.synthetic"
    block-handler-3="click"
  />`,
    [handler1, handler2, handler3, handler4]
  );
  const tree = block([{}, {}, {}, {}]);
  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  (fixture.firstChild as HTMLDivElement).click();
  expect(steps).toEqual(["2", "4", "1", "3"]);
});

test("a block class is made once per block string, whatever its handlers", async () => {
  const handlers = [() => {}];
  const str = '<div block-handler-0="click"></div>';
  expect(createBlock(str, [() => {}])([{}]).constructor).toBe(
    createBlock(str, handlers)([{}]).constructor
  );
  expect(() => createBlock(str)).toThrow("1 handlers, 0 given");
  expect(() => createBlock(str, ["f" as any])).toThrow("Invalid handler");
});

test("a block patched with one of the same string and other handlers runs the other's", async () => {
  const calls: string[] = [];
  const str = '<div block-handler-0="click"></div>';
  const a = createBlock(str, [(ctx: string) => calls.push("a " + ctx)]);
  const b = createBlock(str, [(ctx: string) => calls.push("b " + ctx)]);
  const tree = a(["1"]);
  mount(tree, fixture);
  (fixture.firstChild as HTMLElement).click();
  patch(tree, b(["2"]));
  (fixture.firstChild as HTMLElement).click();
  expect(calls).toEqual(["a 1", "b 2"]);
});

test("a handler argument is given to the handler after the event", async () => {
  const calls: any[] = [];
  const handler = (ctx: any, ev: Event, arg: any) => calls.push([ctx, ev.type, arg]);
  for (const event of ["click", "click.synthetic"]) {
    calls.length = 0;
    const block = createBlock(
      `<div block-handler-0="${event}" block-handler-arg-1="0" block-handler-2="${event}"/>`,
      [handler, handler]
    );
    const tree = block(["a", "model1", "b"]);
    mount(tree, fixture);
    const div = fixture.lastChild as HTMLElement;
    div.click();
    patch(tree, block(["c", "model2", "d"]));
    div.click();
    expect(calls).toEqual([
      ["a", "click", "model1"],
      ["b", "click", undefined],
      ["c", "click", "model2"],
      ["d", "click", undefined],
    ]);
  }
});
