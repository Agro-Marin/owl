import { config, createBlock, createCatcher, mount, patch } from "../../src/blockdom";
import { makeTestFixture } from "./helpers";
import { mainEventHandler } from "../../src/event_handling";

//------------------------------------------------------------------------------
// Setup and helpers
//------------------------------------------------------------------------------

let fixture: HTMLElement;
config.mainEventHandler = mainEventHandler;

beforeEach(() => {
  fixture = makeTestFixture();
});

afterEach(() => {
  fixture.remove();
});

test("simple event catcher", async () => {
  const catcher = createCatcher({ click: 0 });
  const block = createBlock("<div></div>");
  let n = 0;
  let ctx = {};
  let handler = [() => n++, ctx];
  const tree = catcher(block(), [handler]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(fixture.firstChild).toBeInstanceOf(HTMLDivElement);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(1);
});

test("do not catch events outside of itself", async () => {
  const catcher = createCatcher({ click: 0 });
  const childBlock = createBlock("<div></div>");
  const parentBlock = createBlock("<button><block-child-0/></button>");
  let n = 0;
  let ctx = {};
  let handler = [() => n++, ctx];
  const tree = parentBlock([], [catcher(childBlock(), [handler])]);

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<button><div></div></button>");

  expect(n).toBe(0);
  fixture.querySelector("div")!.click();
  expect(n).toBe(1);
  fixture.querySelector("button")!.click();
  expect(n).toBe(1);
});

describe("synthetic events follow native propagation", () => {
  const outerInner = () =>
    createBlock(
      '<div block-handler-0="click.synthetic"><p block-handler-1="click.synthetic">x</p></div>'
    );

  test("a handler stopping propagation stops the ancestors", async () => {
    const calls: string[] = [];
    const tree = outerInner()([
      [() => calls.push("outer"), {}],
      [(_: any, ev: Event) => (calls.push("inner"), ev.stopPropagation()), {}],
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["inner"]);
  });

  test("a handler removing its own element still bubbles", async () => {
    const calls: string[] = [];
    const tree = outerInner()([
      [() => calls.push("outer"), {}],
      [(_: any, ev: any) => (calls.push("inner"), ev.target.remove()), {}],
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["inner", "outer"]);
  });

  test("capture handlers run outermost first", async () => {
    const calls: string[] = [];
    const block = createBlock(
      '<div block-handler-0="click.synthetic.capture"><p block-handler-1="click.synthetic.capture">x</p></div>'
    );
    mount(
      block([
        [() => calls.push("outer"), {}],
        [() => calls.push("inner"), {}],
      ]),
      fixture
    );
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["outer", "inner"]);
  });

  test("inside an open shadow root", async () => {
    const shadow = fixture.attachShadow({ mode: "open" });
    let n = 0;
    const block = createBlock('<p block-handler-0="click.synthetic">x</p>');
    mount(block([[() => n++, {}]]), shadow as any);
    (shadow.firstChild as HTMLElement).click();
    expect(n).toBe(1);
  });

  test("a passive registration does not make a later one passive", async () => {
    const passive = createBlock('<p block-handler-0="wheel.synthetic.passive">x</p>');
    mount(passive([[() => {}, {}]]), fixture);
    const active = createBlock('<p block-handler-0="wheel.synthetic">y</p>');
    mount(active([[(_: any, ev: Event) => ev.preventDefault(), {}]]), fixture);
    const ev = new Event("wheel", { bubbles: true, cancelable: true });
    fixture.lastChild!.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

test("a native handler fires inside nested shadow roots", async () => {
  const outer = fixture.attachShadow({ mode: "open" });
  const host = document.createElement("div");
  outer.appendChild(host);
  const inner = host.attachShadow({ mode: "open" });
  let n = 0;
  const block = createBlock('<button block-handler-0="click">b</button>');
  mount(block([[() => n++, {}]]), inner as any);
  (inner.firstChild as HTMLElement).click();
  expect(n).toBe(1);
});

test("an empty handler on a catcher only applies its modifiers", async () => {
  const catcher = createCatcher({ click: 0 });
  const block = createBlock("<button>b</button>");
  const handler = ["stop", , {}];
  mount(catcher(block(), [handler]), fixture);
  let reachedBody = 0;
  const errors: string[] = [];
  const onBody = () => reachedBody++;
  const onError = (ev: ErrorEvent) => (errors.push(ev.message), ev.preventDefault());
  document.body.addEventListener("click", onBody);
  window.addEventListener("error", onError);
  (fixture.firstChild as HTMLElement).click();
  document.body.removeEventListener("click", onBody);
  window.removeEventListener("error", onError);
  expect(errors).toEqual([]);
  expect(reachedBody).toBe(0);
});

test("removing a catcher keeps the other synthetic handlers of its parent", async () => {
  const calls: string[] = [];
  const parent = createBlock('<div block-handler-0="click.synthetic"><block-child-0/></div>');
  const catcher = createCatcher({ "click.synthetic": 0 });
  const inner = createBlock("<span>c</span>");
  const outer = [() => calls.push("outer"), {}];
  const tree = parent([outer], [catcher(inner(), [[() => calls.push("comp"), {}]])]);
  mount(tree, fixture);
  patch(tree, parent([outer], [undefined]));
  (fixture.firstChild as HTMLElement).click();
  expect(calls).toEqual(["outer"]);
});
