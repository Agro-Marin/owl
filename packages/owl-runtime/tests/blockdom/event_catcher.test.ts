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
import { setDebug, setDebugSink } from "@odoo/owl-core";
import { makeTestFixture } from "./helpers";
import { mainEventHandler } from "../../src/event_handling";

//------------------------------------------------------------------------------
// Setup and helpers
//------------------------------------------------------------------------------

let fixture: HTMLElement;
config.mainEventHandler = mainEventHandler;

// a handler's code is static, given with its block or catcher: this one runs
// the function a render gives as its context
const run = (ctx: any, ev: Event) => ctx(ev);

beforeEach(() => {
  fixture = makeTestFixture();
});

afterEach(() => {
  fixture.remove();
});

test("simple event catcher", async () => {
  let n = 0;
  const catcher = createCatcher({ click: 0 }, [() => n++]);
  const block = createBlock("<div></div>");
  const tree = catcher(block(), {});

  mount(tree, fixture);
  expect(fixture.innerHTML).toBe("<div></div>");

  expect(fixture.firstChild).toBeInstanceOf(HTMLDivElement);
  expect(n).toBe(0);
  (fixture.firstChild as HTMLDivElement).click();
  expect(n).toBe(1);
});

test("do not catch events outside of itself", async () => {
  let n = 0;
  const catcher = createCatcher({ click: 0 }, [() => n++]);
  const childBlock = createBlock("<div></div>");
  const parentBlock = createBlock("<button><block-child-0/></button>");
  const tree = parentBlock([], [catcher(childBlock(), {})]);

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
      '<div block-handler-0="click.synthetic"><p block-handler-1="click.synthetic">x</p></div>',
      [run, run]
    );

  test("a handler stopping propagation stops the ancestors", async () => {
    const calls: string[] = [];
    const tree = outerInner()([
      () => calls.push("outer"),
      (ev: Event) => (calls.push("inner"), ev.stopPropagation()),
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["inner"]);
  });

  const twoOnInner = (modifier = "") =>
    createBlock(
      `<div block-handler-0="click.synthetic"><p block-handler-1="click.synthetic${modifier}" block-handler-2="click.synthetic">x</p></div>`,
      [run, run, run]
    );

  test("stopping propagation still runs the other handlers of the same element", async () => {
    const calls: string[] = [];
    const tree = twoOnInner(".stop")([
      () => calls.push("outer"),
      () => calls.push("a"),
      () => calls.push("b"),
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["a", "b"]);
  });

  test("stopping propagation immediately skips the other handlers of the same element", async () => {
    const calls: string[] = [];
    const tree = twoOnInner()([
      () => calls.push("outer"),
      (ev: Event) => (calls.push("a"), ev.stopImmediatePropagation()),
      () => calls.push("b"),
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["a"]);
  });

  test("the event keeps its own stopImmediatePropagation once the dispatch is over", async () => {
    const seen: boolean[] = [];
    const tree = twoOnInner()([
      (ev: Event) => seen.push(Object.hasOwn(ev, "stopImmediatePropagation")),
      () => {},
      () => {},
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
      () => calls.push("outer"),
      (ev: any) => (calls.push("inner"), ev.target.remove()),
    ]);
    mount(tree, fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["inner", "outer"]);
  });

  test("capture handlers run outermost first", async () => {
    const calls: string[] = [];
    const block = createBlock(
      '<div block-handler-0="click.synthetic.capture"><p block-handler-1="click.synthetic.capture">x</p></div>',
      [run, run]
    );
    mount(block([() => calls.push("outer"), () => calls.push("inner")]), fixture);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["outer", "inner"]);
  });

  test("inside an open shadow root", async () => {
    const shadow = fixture.attachShadow({ mode: "open" });
    let n = 0;
    const block = createBlock('<p block-handler-0="click.synthetic">x</p>', [run]);
    mount(block([() => n++]), shadow as any);
    (shadow.firstChild as HTMLElement).click();
    expect(n).toBe(1);
  });

  test("a passive registration does not make a later one passive", async () => {
    const passive = createBlock('<p block-handler-0="wheel.synthetic.passive">x</p>', [run]);
    mount(passive([() => {}]), fixture);
    const active = createBlock('<p block-handler-0="wheel.synthetic">y</p>', [run]);
    mount(active([(ev: Event) => ev.preventDefault()]), fixture);
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
  const block = createBlock('<button block-handler-0="click">b</button>', [run]);
  mount(block([() => n++]), inner as any);
  (inner.firstChild as HTMLElement).click();
  expect(n).toBe(1);
});

test("an empty handler on a catcher only applies its modifiers", async () => {
  const catcher = createCatcher({ "click.stop": 0 }, [null]);
  const block = createBlock("<button>b</button>");
  mount(catcher(block(), {}), fixture);
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
  const parent = createBlock('<div block-handler-0="click.synthetic"><block-child-0/></div>', [
    run,
  ]);
  const catcher = createCatcher({ "click.synthetic": 0 }, [() => calls.push("comp")]);
  const inner = createBlock("<span>c</span>");
  const outer = () => calls.push("outer");
  const tree = parent([outer], [catcher(inner(), {})]);
  mount(tree, fixture);
  patch(tree, parent([outer], [undefined]));
  (fixture.firstChild as HTMLElement).click();
  expect(calls).toEqual(["outer"]);
});

test("modifiers apply only to events from inside the catcher", async () => {
  let n = 0;
  const catcher = createCatcher({ "click.stop.prevent": 0 }, [() => n++]);
  const parent = createBlock("<div><button>b</button><block-child-0/></div>");
  const inner = createBlock("<span>c</span>");
  mount(parent([], [catcher(inner(), {})]), fixture);
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
  const calls: string[] = [];
  const catcher = createCatcher({ click: 0, "click.synthetic": 1 }, [
    (v: string) => calls.push(`native ${v}`),
    (v: string) => calls.push(`synthetic ${v}`),
  ]);
  const block = createBlock("<button>b</button>");
  const tree = catcher(block(), "1");
  mount(tree, fixture);
  patch(tree, catcher(block(), "2"));
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
    const block = createBlock('<p block-handler-0="dblclick.synthetic">x</p>', [run]);
    mount(block([() => {}]), fixture);
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
    const block = createBlock('<input block-handler-0="change.synthetic"/>', [run]);
    const shadow = shadowRoot();
    mount(block([() => calls.push("change")]), shadow);
    shadow.querySelector("input")!.dispatchEvent(new Event("change", { bubbles: true }));
    expect(calls).toEqual(["change"]);
  });

  test("an event crossing the shadow root runs its handlers once", async () => {
    const calls: string[] = [];
    const block = createBlock(
      '<div block-handler-0="click.synthetic"><p block-handler-1="click.synthetic">x</p></div>',
      [run, run]
    );
    const shadow = shadowRoot();
    mount(block([() => calls.push("outer"), () => calls.push("inner")]), shadow);
    shadow.querySelector("p")!.click();
    expect(calls).toEqual(["inner", "outer"]);
  });

  test("an event type first used after the mount reaches a handler there", async () => {
    const calls: string[] = [];
    const shadow = shadowRoot();
    mount(createBlock("<div><block-child-0/></div>")([], []), shadow);
    const block = createBlock('<form block-handler-0="reset.synthetic"/>', [run]);
    mount(block([() => calls.push("reset")]), shadow.firstChild as HTMLElement);
    shadow.querySelector("form")!.dispatchEvent(new Event("reset", { bubbles: true }));
    expect(calls).toEqual(["reset"]);
  });
});

describe("removing the catchers of a parent releases their listeners", () => {
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
  const catcher = createCatcher({ click: 0, "click.synthetic": 1 }, [() => {}, () => {}]);
  const item = (key: number) => Object.assign(catcher(span(), {}), { key });
  const syntheticEntries = (el: any) => Object.keys(el["__event__synthetic_click"] || {}).length;

  test("a keyed list emptied as its parent's only child", () => {
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
  const catcher = createCatcher({ click: 0 }, [run]);
  const log = (calls: string[], name: string) => () => calls.push(name);
  const click = (text: string) =>
    [...fixture.querySelectorAll("span")].find((s) => s.textContent === text)!.click();

  test("an element outside every catcher reaches none", () => {
    const calls: string[] = [];
    const tree = multi([
      span(["before"]),
      list(
        [1, 2].map((k) => Object.assign(catcher(span([`c${k}`]), log(calls, `c${k}`)), { key: k }))
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

  test("a catcher of another site nested in one runs before it, whichever site listened first", () => {
    const calls: string[] = [];
    const outerSite = createCatcher({ click: 0 }, [run]);
    const innerSite = createCatcher({ click: 0 }, [run]);
    const outer = (name: string, content: any) => outerSite(content, log(calls, name));
    const inner = (name: string) => innerSite(span([name]), log(calls, name));
    // the first catcher on the parent holds no inner one: its site listens first
    const tree = multi([
      outer("o1", span(["a1"])),
      outer("o2", multi([span(["a2"]), inner("i2")])),
    ]);
    mount(tree, fixture);
    click("i2");
    expect(calls).toEqual(["i2", "o2"]);
    calls.length = 0;
    click("a1");
    expect(calls).toEqual(["o1"]);
  });

  test("a nested catcher runs before the enclosing one whatever modifiers their keys add", () => {
    const calls: string[] = [];
    const outerSite = createCatcher({ "click.stop": 0, "click.prevent": 1 }, [
      (name: string) => calls.push(name),
      (name: string) => calls.push(name + "p"),
    ]);
    const innerSite = createCatcher({ click: 0 }, [run]);
    const outer = (name: string, content: any) => outerSite(content, name);
    const inner = (name: string) => innerSite(span([name]), log(calls, name));
    // the first catcher on the parent holds no inner one: its keys listen first
    const tree = multi([
      outer("o1", span(["a1"])),
      outer("o2", multi([span(["a2"]), inner("i2")])),
    ]);
    mount(tree, fixture);
    click("i2");
    expect(calls).toEqual(["i2", "o2", "o2p"]);
  });

  test("a catcher nested in another one's child runs before it", () => {
    const calls: string[] = [];
    const inner = (name: string) => catcher(span([name]), log(calls, name));
    const content = multi([span(["outer"]), inner("inner"), undefined]);
    const tree = catcher(content, log(calls, "outer"));
    mount(tree, fixture);
    click("inner");
    expect(calls).toEqual(["inner", "outer"]);
    calls.length = 0;
    click("outer");
    expect(calls).toEqual(["outer"]);

    // a slot of the outer child filled by a render of its own (a component
    // re-rendering alone), not by a patch of the outer catcher
    calls.length = 0;
    content.patch(multi([span(["outer"]), inner("inner"), inner("late")]) as any, false);
    click("late");
    expect(calls).toEqual(["late", "outer"]);
  });

  test("a catcher mounted by a patch of the enclosing one knows it from that patch", () => {
    const calls: string[] = [];
    const lookups: string[] = [];
    const inner = (name: string) => catcher(span([name]), log(calls, name));
    const outer = (slot: any) => catcher(multi([span(["outer"]), slot]), log(calls, "outer"));
    const tree = outer(undefined);
    mount(tree, fixture);
    // the outer catcher, mounted by no update of its parent, looks for its own
    // enclosing catcher at its first dispatch
    click("outer");
    calls.length = 0;
    setDebugSink((_channel, message) => {
      if (message.startsWith("catcher found its outer one at dispatch")) {
        lookups.push(message);
      }
    });
    setDebug(["event"]);
    try {
      patch(tree, outer(inner("inner")));
      click("inner");
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(calls).toEqual(["inner", "outer"]);
    expect(lookups).toEqual([]);
  });
});
