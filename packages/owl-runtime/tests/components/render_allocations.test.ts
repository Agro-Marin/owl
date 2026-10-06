import { compile } from "@odoo/owl-compiler";
import {
  Component,
  mount,
  onWillUpdateProps,
  props,
  setDebug,
  setDebugSink,
  signal,
  xml,
} from "../../src";
import { makeTestFixture, nextTick } from "../helpers";

let fixture: HTMLElement;

beforeEach(() => {
  fixture = makeTestFixture();
});

// the statements of the render functions of a compiled template: the lines
// of `function name(ctx, node, key = "") { ... }`, the template's own included
function renderFunctionLines(template: string): string[] {
  const code = compile(template).toString();
  const lines: string[] = [];
  let inside = false;
  for (const line of code.split("\n")) {
    if (/function \w+\(ctx, node, key = ""\) \{$/.test(line)) {
      inside = true;
    } else if (/^ {2}\}$/.test(line)) {
      inside = false;
    } else if (inside) {
      lines.push(line.trim());
    }
  }
  return lines;
}

describe("what a render allocates", () => {
  test("slots, slot defaults, t-call bodies and t-out bodies make no function per render", () => {
    const lines = renderFunctionLines(`
      <div>
        <Child>
          <t t-set-slot="header" t-slot-scope="s"><b t-out="s.x"/></t>
          <span>content</span>
        </Child>
        <t t-call-slot="footer">default footer</t>
        <t t-call="sub"><i>body</i></t>
        <t t-out="value">no value</t>
        <t t-out="0">no body</t>
      </div>`);
    expect(lines.length).toBeGreaterThan(0);
    const allocating = lines.filter((line) => /\.bind\(|=>/.test(line));
    expect(allocating).toEqual([]);
  });

  test("a slot called without attributes passes no scope object", () => {
    const lines = renderFunctionLines(`<div><t t-call-slot="default"/></div>`);
    const calls = lines.filter((line) => line.includes("callSlot("));
    expect(calls.length).toBe(1);
    expect(calls[0]).not.toContain("{}");
  });

  test("t-props and t-call attributes build their object without a literal to copy", () => {
    const lines = renderFunctionLines(`
      <div>
        <Child t-props="this.p" a="1"/>
        <t t-call="sub" a="1"/>
      </div>`);
    expect(lines.filter((line) => line.includes("Object.assign("))).toEqual([]);
  });

  test("a t-call with neither attributes nor body makes no context", () => {
    const lines = renderFunctionLines(
      `<ul><li t-foreach="this.items" t-as="item" t-key="item"><t t-call="sub"/></li></ul>`
    );
    expect(lines.filter((line) => line.includes("callTemplate(")).length).toBe(1);
    // the loop item's own context is `Object.create(ctx1)`
    expect(lines.filter((line) => line.includes("Object.create(ctx)"))).toEqual([]);
  });

  test("a slot's render function is the same on every render", async () => {
    const renders: any[] = [];
    class Child extends Component {
      static template = xml`<div><t t-call-slot="default"/></div>`;
      props = props();
      setup() {
        renders.push(this.props.slots.default.__render);
        onWillUpdateProps((next) => renders.push(next.slots.default.__render));
      }
    }
    class Parent extends Component {
      static template = xml`<Child n="this.n()"><t t-out="this.n()"/></Child>`;
      static components = { Child };
      n = signal(0);
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div>0</div>");
    parent.n.set(1);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>1</div>");
    expect(renders.length).toBe(2);
    expect(renders[0]).toBe(renders[1]);
  });
});

describe("what updating a child allocates", () => {
  test("comparing a t-props child's props makes no key array", async () => {
    class Child extends Component {
      static template = xml`<i t-out="this.props.a"/>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<Child t-props="this.p()" b="1"/>`;
      static components = { Child };
      p = signal({ a: 1 } as any);
    }
    const parent = await mount(Parent, fixture);
    const keys = vi.spyOn(Object, "keys");
    try {
      parent.p.set({ a: 1 });
      await nextTick();
      expect(keys).not.toHaveBeenCalled();
    } finally {
      keys.mockRestore();
    }
  });

  test("the fiber channel names the t-props key that came, went or changed", async () => {
    class Child extends Component {
      static template = xml`<i/>`;
    }
    class Parent extends Component {
      static template = xml`<Child t-props="this.p()"/>`;
      static components = { Child };
      p = signal({ a: 1 } as any);
    }
    const parent = await mount(Parent, fixture);
    const lines: string[] = [];
    setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
    setDebug(["fiber"]);
    try {
      for (const p of [{ a: 2 }, { a: 2, b: 1 }, { b: 1 }]) {
        parent.p.set(p);
        await nextTick();
      }
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(lines.filter((line) => line.includes("t-props"))).toEqual([
      'fiber: t-props: prop "a" changed or went',
      'fiber: t-props: prop "b" came',
      'fiber: t-props: prop "a" changed or went',
    ]);
  });

  test("a t-props child renders again when a key comes, goes or changes, not otherwise", async () => {
    let renders = 0;
    class Child extends Component {
      static template = xml`<i t-out="Object.keys(this.props).join()"/>`;
      props = props();
      setup() {
        onWillUpdateProps(() => {
          renders++;
        });
      }
    }
    class Parent extends Component {
      static template = xml`<Child t-props="this.p()" b="1"/>`;
      static components = { Child };
      p = signal({ a: 1 } as any);
    }
    const parent = await mount(Parent, fixture);
    const steps: [any, number][] = [
      [{ a: 1 }, 0],
      [{ a: 2 }, 1],
      [{ a: 2, c: 3 }, 1],
      [{ a: 2, c: 3 }, 0],
      [{ a: 2 }, 1],
      [{ a: 2, c: undefined }, 1],
      [{}, 1],
    ];
    for (const [p, expected] of steps) {
      renders = 0;
      parent.p.set(p);
      await nextTick();
      expect(renders).toBe(expected);
    }
    expect(fixture.innerHTML).toBe("<i>b</i>");
  });
});

describe("the owner of slots, slot defaults and t-call bodies", () => {
  test("each renders its components with the components of the template that wrote it", async () => {
    class Leaf extends Component {
      static template = xml`<i t-out="this.props.v"/>`;
      props = props();
    }
    class OtherLeaf extends Component {
      static template = xml`<u t-out="this.props.v"/>`;
      props = props();
    }
    const sub = xml`<p><t t-out="0"/></p>`;
    const subWithSlot = xml`<Child><t t-out="0"/></Child>`;
    class Child extends Component {
      // Leaf here is OtherLeaf: the default content renders Child's own
      static template = xml`<div><t t-call-slot="default"/><t t-call-slot="missing"><Leaf v="'child default'"/></t></div>`;
      static components = { Leaf: OtherLeaf };
    }
    class Parent extends Component {
      static template = xml`
        <Child><Leaf v="'slot'"/></Child>
        <t t-call="${sub}"><Leaf v="'call body'"/></t>
        <t t-call="${subWithSlot}"><Leaf v="'body in a slot'"/></t>
        <t t-foreach="['a', 'b']" t-as="x" t-key="x"><t t-call="${sub}"><Leaf v="x"/></t></t>`;
      static components = { Child, Leaf };
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<div><i>slot</i><u>child default</u></div>" +
        "<p><i>call body</i></p>" +
        "<div><i>body in a slot</i><u>child default</u></div>" +
        "<p><i>a</i></p><p><i>b</i></p>"
    );
  });

  test("a slot without a slot scope renders in the context it was written in", async () => {
    // a write into its context (t-model.proxy on a bare name) is seen by the
    // template that wrote the slot, as if the slot's content were inline there
    let child: any;
    class Child extends Component {
      static template = xml`<div><t t-call-slot="default"/></div>`;
      setup() {
        child = this;
      }
    }
    class Parent extends Component {
      static template = xml`<Child><input t-model.proxy="v"/><b t-out="v"/></Child><i t-out="v"/>`;
      static components = { Child };
    }
    const parent = await mount(Parent, fixture);
    const input = fixture.querySelector("input")!;
    input.value = "typed";
    input.dispatchEvent(new Event("input"));
    child.__owl__.render(false);
    await nextTick();
    expect(fixture.querySelector("b")!.textContent).toBe("typed");
    parent.__owl__.render(false);
    await nextTick();
    expect(fixture.querySelector("i")!.textContent).toBe("typed");
  });

  test("a t-call with neither attributes nor body renders in the caller's context", async () => {
    const sub = xml`<input t-model.proxy="v"/>`;
    class Parent extends Component {
      static template = xml`<t t-call="${sub}"/><b t-out="v"/>`;
    }
    const parent = await mount(Parent, fixture);
    const input = fixture.querySelector("input")!;
    input.value = "typed";
    input.dispatchEvent(new Event("input"));
    parent.__owl__.render(false);
    await nextTick();
    expect(fixture.querySelector("b")!.textContent).toBe("typed");
  });

  test("a t-call in a t-call body hides the body from the template it calls", async () => {
    const inner = xml`<p><t t-out="0">inner default</t></p>`;
    const outer = xml`<div><t t-out="0"/><t t-call="${inner}"/></div>`;
    class Parent extends Component {
      static template = xml`<t t-foreach="[1, 2]" t-as="i" t-key="i"><t t-call="${outer}"><b t-out="i"/></t></t>`;
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<div><b>1</b><p>inner default</p></div><div><b>2</b><p>inner default</p></div>"
    );
  });

  test("a slot scope is an object when the slot is called without attributes", async () => {
    class Child extends Component {
      static template = xml`<div><t t-call-slot="default"/></div>`;
    }
    class Parent extends Component {
      static template = xml`<Child t-slot-scope="s"><t t-out="typeof s"/>:<t t-out="Object.keys(s).length"/></Child>`;
      static components = { Child };
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div>object:0</div>");
  });
});
