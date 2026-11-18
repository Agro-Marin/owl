import {
  App,
  Component,
  mount,
  onError,
  onWillUpdateProps,
  Portal,
  props,
  proxy,
  setDebug,
  setDebugSink,
  xml,
} from "../src";
import {
  makeDeferred,
  makeTestFixture,
  nextTick,
  renderToBdom,
  renderToString,
  TestContext,
} from "./helpers";
import { createBlock, mount as mountBlock, patch } from "../src/blockdom";

let fixture: HTMLElement;
let lines: string[];

beforeEach(() => {
  fixture = makeTestFixture();
  lines = [];
  setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
});

afterEach(() => {
  setDebug(false);
  setDebugSink(null);
});

describe("rendering", () => {
  test("a rejection of a superseded onWillUpdateProps is logged on the error channel", async () => {
    const defs: Array<ReturnType<typeof makeDeferred>> = [];
    class Child extends Component {
      static template = xml`<span t-out="this.props.v"/>`;
      props = props();
      setup() {
        onWillUpdateProps(() => {
          const def = makeDeferred();
          defs.push(def);
          return def;
        });
      }
    }
    class Parent extends Component {
      static template = xml`<div><Child v="this.state.v"/></div>`;
      static components = { Child };
      state = proxy({ v: 1 });
      setup() {
        onError(() => {});
      }
    }
    const parent = await mount(Parent, fixture);
    setDebug(["error"]);
    parent.state.v = 2;
    await nextTick();
    parent.state.v = 3;
    await nextTick();
    defs[0].reject(new Error("stale"));
    await nextTick();
    defs[1].resolve();
    await nextTick();
    expect(lines).toEqual(["error: Child: rejection dropped, superseded"]);
    expect(fixture.innerHTML).toBe("<div><span>3</span></div>");
  });

  test("an error nobody handles under a Portal destroys the app once", async () => {
    const target = document.createElement("div");
    document.body.appendChild(target);
    let broken: any;
    class Broken extends Component {
      static template = xml`<span t-out="this.state.ok ? 'ok' : this.boom.x"/>`;
      state = proxy({ ok: true });
      setup() {
        broken = this;
      }
    }
    class Root extends Component {
      static template = xml`<div><Portal target="this.target"><Broken/></Portal></div>`;
      static components = { Portal, Broken };
      target = target;
    }
    const app = new App({ test: true });
    const rejections: string[] = [];
    const onRejection = (e: any) => rejections.push(e.message);
    process.on("unhandledRejection", onRejection);
    try {
      await app.createRoot(Root).mount(fixture);
      await nextTick();
      expect(target.innerHTML).toBe("<span>ok</span>");
      setDebug(["error", "lifecycle"]);
      broken.state.ok = false;
      await nextTick();
      await nextTick();
    } finally {
      process.off("unhandledRejection", onRejection);
      target.remove();
    }
    expect(app.destroyed).toBe(true);
    expect(lines.filter((l) => l.includes("destroy app"))).toHaveLength(1);
  });
});

describe("events", () => {
  test("a slot's t-on mounted by its component's own render finds the enclosing handler at its first dispatch, logged on the event channel", async () => {
    const calls: string[] = [];
    const state = proxy({ show: false });
    class Child extends Component {
      static template = xml`<t t-if="this.state.show"><t t-if="false"/><t t-call-slot="default" t-on-click="() => this.log('slot')"/></t>`;
      props = props();
      state = state;
      log(name: string) {
        calls.push(name);
      }
    }
    class Parent extends Component {
      static template = xml`<div><Child t-on-click="() => this.log('child')"><p>content</p></Child></div>`;
      static components = { Child };
      log(name: string) {
        calls.push(name);
      }
    }
    await mount(Parent, fixture);
    state.show = true;
    await nextTick();
    setDebug(["event"]);
    fixture.querySelector("p")!.click();
    expect(calls).toEqual(["slot", "child"]);
    expect(lines).toContain("event: catcher found its outer one at dispatch: true");
  });
});

describe("synthetic roots", () => {
  test("a target mounted detached and moved into a shadow root later gets only the composed events there", () => {
    const calls: string[] = [];
    const run = (ctx: any, ev: Event) => ctx(ev);
    const handlers = [run, run];
    const block = createBlock(
      '<p block-handler-0="click.synthetic" block-handler-1="change.synthetic">x</p>',
      handlers
    );
    const detached = document.createElement("div");
    mountBlock(
      block([() => calls.push("click"), () => calls.push("change")], null, handlers),
      detached
    );
    const shadow = makeTestFixture().attachShadow({ mode: "open" });
    shadow.appendChild(detached);
    const p = detached.firstChild as HTMLElement;
    p.dispatchEvent(new Event("change", { bubbles: true }));
    p.click();
    expect(calls).toEqual(["click"]);
  });
});

describe("attributes", () => {
  test("a class string equal to the last one is not written again", async () => {
    const fixture = makeTestFixture();
    const template = `<div t-att-class="cls"/>`;
    const tree = renderToBdom(template, { cls: "x y" });
    mountBlock(tree, fixture);
    const records: MutationRecord[] = [];
    const observer = new MutationObserver((list) => records.push(...list));
    observer.observe(fixture, { attributes: true, subtree: true });
    patch(tree, renderToBdom(template, { cls: "x y" }));
    await Promise.resolve();
    expect(records).toEqual([]);
    patch(tree, renderToBdom(template, { cls: "x z" }));
    await Promise.resolve();
    observer.disconnect();
    expect(records.length).toBeGreaterThan(0);
    expect(fixture.innerHTML).toBe('<div class="x z"></div>');
  });
});

describe("templates", () => {
  test("String() of a t-set body gives a text node's text and a bigint's digits", () => {
    const template = `<t t-set="v"><t t-out="x"/></t><t t-out="String(v)"/>`;
    expect(renderToString(template, { x: "a<b" })).toBe("a&lt;b");
    expect(renderToString(template, { x: 0n })).toBe("0");
    expect(renderToString(template, { x: 12n })).toBe("12");
  });

  test("a t-out showing one t-set body, then another, replaces the content", async () => {
    class Comp extends Component {
      static template = xml`
        <div>
          <t t-set="v"><t t-foreach="this.state.items" t-as="i" t-key="i"><b t-out="i"/></t></t>
          <t t-if="this.state.other"><t t-set="v"><i>other</i></t></t>
          <t t-out="v"/>
        </div>`;
      state = proxy({ items: [1, 2], other: false });
    }
    const comp = await mount(Comp, fixture);
    expect(fixture.innerHTML).toBe("<div><b>1</b><b>2</b></div>");
    comp.state.other = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><i>other</i></div>");
    comp.state.other = false;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><b>1</b><b>2</b></div>");
  });

  test("a directive on a t-set-slot node makes only its content conditional: the slot is always given", async () => {
    let child: any;
    class Child extends Component {
      static template = xml`<div><t t-call-slot="extra">default</t></div>`;
      props = props();
      setup() {
        child = this;
      }
    }
    class Parent extends Component {
      static template = xml`<Child><t t-set-slot="extra" t-if="this.state.show">given</t></Child>`;
      static components = { Child };
      state = proxy({ show: false });
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div></div>");
    expect(child.props.slots.extra).toBeDefined();
    parent.state.show = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>given</div>");
  });

  test("t-props copies with object spread: an own __proto__ key is a prop", async () => {
    let child: any;
    class Child extends Component {
      static template = xml`<span/>`;
      props = props();
      setup() {
        child = this;
      }
    }
    class Parent extends Component {
      static template = xml`<Child t-props="this.p"/>`;
      static components = { Child };
      p = JSON.parse('{"__proto__": 1, "a": 2}');
    }
    await mount(Parent, fixture);
    expect(Object.hasOwn(child.props, "__proto__")).toBe(true);
    expect(child.props.a).toBe(2);
  });

  test("a t-call attribute named like a getter-only property up the context chain is ignored", () => {
    const context = new TestContext();
    context.addTemplate("sub", `<t t-out="label"/>`);
    context.addTemplate("main", `<div><t t-call="sub" label="'given'"/></div>`);
    const base = Object.create({
      get label() {
        return "getter";
      },
    });
    expect(context.renderToString("main", base)).toBe("<div>getter</div>");
    expect(context.renderToString("main", {})).toBe("<div>given</div>");
  });
});
