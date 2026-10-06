import {
  config,
  createBlock,
  createCatcher,
  list,
  mount,
  multi,
  patch,
  remove,
} from "../../src/blockdom";
import { makeTestFixture } from "./helpers";
import { mainEventHandler } from "../../src/event_handling";
import { EventModifier } from "@odoo/owl-core";

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

  const twoOnInner = () =>
    createBlock(
      '<div block-handler-0="click.synthetic"><p block-handler-1="click.synthetic" block-handler-2="click.synthetic">x</p></div>'
    );

  test("stopping propagation still runs the other handlers of the same element", async () => {
    const calls: string[] = [];
    const tree = twoOnInner()([
      [() => calls.push("outer"), {}],
      [() => calls.push("a"), {}, EventModifier.STOP],
      [() => calls.push("b"), {}],
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["a", "b"]);
  });

  test("stopping propagation immediately skips the other handlers of the same element", async () => {
    const calls: string[] = [];
    const tree = twoOnInner()([
      [() => calls.push("outer"), {}],
      [(_: any, ev: Event) => (calls.push("a"), ev.stopImmediatePropagation()), {}],
      [() => calls.push("b"), {}],
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["a"]);
  });

  test("the event keeps its own stopImmediatePropagation once the dispatch is over", async () => {
    const seen: boolean[] = [];
    const tree = twoOnInner()([
      [(_: any, ev: Event) => seen.push(Object.hasOwn(ev, "stopImmediatePropagation")), {}],
      [() => {}, {}],
      [() => {}, {}],
    ]);
    mount(tree, fixture);
    const p = fixture.querySelector("p")!;
    const ev = new MouseEvent("click", { bubbles: true });
    for (let i = 0; i < 3; i++) {
      p.dispatchEvent(ev);
      expect(Object.hasOwn(ev, "stopImmediatePropagation")).toBe(false);
      expect(ev.stopImmediatePropagation).toBe(Event.prototype.stopImmediatePropagation);
    }
    // shadowed while the handlers run, never stacked on the previous dispatch
    expect(seen).toEqual([true, true, true]);
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
  const handler = [null, {}, EventModifier.STOP];
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

test("modifiers apply only to events from inside the catcher", async () => {
  const catcher = createCatcher({ click: 0 });
  const parent = createBlock("<div><button>b</button><block-child-0/></div>");
  const inner = createBlock("<span>c</span>");
  let n = 0;
  mount(
    parent([], [catcher(inner(), [[() => n++, {}, EventModifier.STOP | EventModifier.PREVENT]])]),
    fixture
  );
  let reachedBody = 0;
  const onBody = () => reachedBody++;
  document.body.addEventListener("click", onBody);
  const outside = new MouseEvent("click", { bubbles: true, cancelable: true });
  fixture.querySelector("button")!.dispatchEvent(outside);
  const inside = new MouseEvent("click", { bubbles: true, cancelable: true });
  fixture.querySelector("span")!.dispatchEvent(inside);
  document.body.removeEventListener("click", onBody);
  expect(reachedBody).toBe(1);
  expect(outside.defaultPrevented).toBe(false);
  expect(inside.defaultPrevented).toBe(true);
  expect(n).toBe(1);
});

test("a patched catcher calls the handler of the latest render", async () => {
  const catcher = createCatcher({ click: 0, "click.synthetic": 1 });
  const block = createBlock("<button>b</button>");
  const calls: string[] = [];
  const handlers = (v: string) => [
    [() => calls.push(`native ${v}`), {}],
    [() => calls.push(`synthetic ${v}`), {}],
  ];
  const tree = catcher(block(), handlers("1"));
  mount(tree, fixture);
  patch(tree, catcher(block(), handlers("2")));
  (fixture.firstChild as HTMLElement).click();
  expect(calls).toEqual(["native 2", "synthetic 2"]);
});

test("the synthetic document listener carries a marker a test harness can recognize", async () => {
  const added: any[] = [];
  const add = document.addEventListener;
  document.addEventListener = function (this: Document, ...args: any[]) {
    added.push(args[1]);
    return (add as any).apply(this, args);
  } as any;
  try {
    const block = createBlock('<p block-handler-0="dblclick.synthetic">x</p>');
    mount(block([[() => {}, {}]]), fixture);
  } finally {
    document.addEventListener = add;
  }
  expect(added.length).toBe(1);
  expect(added[0][Symbol.for("owl.syntheticListener")]).toBe(true);
});

describe("synthetic events in a shadow root", () => {
  function shadowRoot(): ShadowRoot {
    const host = document.createElement("div");
    fixture.appendChild(host);
    return host.attachShadow({ mode: "open" });
  }

  test("an event that does not leave the shadow root reaches its handler", async () => {
    const calls: string[] = [];
    const block = createBlock('<input block-handler-0="change.synthetic"/>');
    const shadow = shadowRoot();
    mount(block([[() => calls.push("change"), {}]]), shadow);
    shadow.querySelector("input")!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(calls).toEqual(["change"]);
  });

  test("an event crossing the shadow root runs its handlers once", async () => {
    const calls: string[] = [];
    const block = createBlock(
      '<div block-handler-0="click.synthetic"><p block-handler-1="click.synthetic">x</p></div>'
    );
    const shadow = shadowRoot();
    mount(
      block([
        [() => calls.push("outer"), {}],
        [() => calls.push("inner"), {}],
      ]),
      shadow
    );
    shadow.querySelector("p")!.click();
    expect(calls).toEqual(["inner", "outer"]);
  });

  test("an event type first used after the mount reaches a handler there", async () => {
    const calls: string[] = [];
    const shadow = shadowRoot();
    mount(createBlock("<div><block-child-0/></div>")([], []), shadow);
    const block = createBlock('<form block-handler-0="reset.synthetic"/>');
    mount(block([[() => calls.push("reset"), {}]]), shadow.firstChild as HTMLElement);
    shadow.querySelector("form")!.dispatchEvent(new Event("reset", { bubbles: true }));
    expect(calls).toEqual(["reset"]);
  });
});

describe("a parent cleared in bulk releases the catchers listening on it", () => {
  function countListeners(el: HTMLElement) {
    const live = new Set<any>();
    const add = el.addEventListener;
    const rm = el.removeEventListener;
    el.addEventListener = function (this: HTMLElement, name: string, l: any, o: any) {
      live.add(l);
      return add.call(this, name, l, o);
    } as any;
    el.removeEventListener = function (this: HTMLElement, name: string, l: any, o: any) {
      live.delete(l);
      return rm.call(this, name, l, o);
    } as any;
    return live;
  }
  const host = createBlock("<div><block-child-0/></div>");
  const span = createBlock("<span>c</span>");
  const catcher = createCatcher({ click: 0, "click.synthetic": 1 });
  const handlers = [
    [() => {}, {}],
    [() => {}, {}],
  ];
  const item = (key: number) => Object.assign(catcher(span(), handlers), { key });
  const syntheticEntries = (el: any) => Object.keys(el["__event__synthetic_click"] || {}).length;

  test("a keyed list emptied by the only-child fast path", () => {
    const tree = host([], [list([1, 2, 3].map(item))]);
    mount(tree, fixture);
    const div = fixture.firstChild as HTMLElement;
    const live = countListeners(div);
    for (let i = 0; i < 5; i++) {
      patch(tree, host([], [list([])]));
      patch(tree, host([], [list([1, 2, 3].map(item))]));
    }
    // one listener for the three catchers of the site
    expect(live.size).toBe(1);
    patch(tree, host([], [list([])]));
    expect(div.innerHTML).toBe("");
    expect(live.size).toBe(0);
    expect(syntheticEntries(div)).toBe(0);
  });

  test("an only-child list or multi removed by its parent block", () => {
    for (const content of [() => list([1, 2].map(item)), () => multi([item(1), item(2)])]) {
      const tree = host([], [content()]);
      mount(tree, fixture);
      const div = fixture.firstChild as HTMLElement;
      const live = countListeners(div);
      patch(tree, host([], [content()]));
      patch(tree, host([], [undefined]));
      expect(div.innerHTML).toBe("");
      expect(live.size).toBe(0);
      expect(syntheticEntries(div)).toBe(0);
      remove(tree);
    }
  });
});

describe("catchers of one site sharing a parent", () => {
  const span = createBlock("<span><block-text-0/></span>");
  const catcher = createCatcher({ click: 0 });
  const log = (calls: string[], name: string) => [() => calls.push(name), {}];
  const click = (text: string) =>
    [...fixture.querySelectorAll("span")].find((s) => s.textContent === text)!.click();

  test("an element outside every catcher reaches none", () => {
    const calls: string[] = [];
    const tree = multi([
      span(["before"]),
      list(
        [1, 2].map((k) =>
          Object.assign(catcher(span([`c${k}`]), [log(calls, `c${k}`)]), { key: k })
        )
      ),
      span(["after"]),
    ]);
    mount(tree, fixture);
    click("before");
    click("after");
    expect(calls).toEqual([]);
    click("c2");
    click("c1");
    expect(calls).toEqual(["c2", "c1"]);
  });

  test("a catcher nested in another one's child runs before it", () => {
    const calls: string[] = [];
    const inner = (name: string) => catcher(span([name]), [log(calls, name)]);
    const content = multi([span(["outer"]), inner("inner"), undefined]);
    const tree = catcher(content, [log(calls, "outer")]);
    mount(tree, fixture);
    click("inner");
    expect(calls).toEqual(["inner", "outer"]);
    calls.length = 0;
    click("outer");
    expect(calls).toEqual(["outer"]);

    // a slot of the outer child filled by a render of its own (a component
    // re-rendering alone), not by a patch of the outer catcher
    calls.length = 0;
    content.patch(multi([span(["outer"]), inner("inner"), inner("late")]), false);
    click("late");
    expect(calls).toEqual(["late", "outer"]);
  });
});
