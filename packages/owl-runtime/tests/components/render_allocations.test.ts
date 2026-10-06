import { compile } from "@odoo/owl-compiler";
import {
  Component,
  mount,
  onWillUpdateProps,
  props,
  proxy,
  toRaw,
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

  test("slots are given as they are, not marked raw on every render", () => {
    const lines = renderFunctionLines(`
      <div>
        <Child><span>default</span></Child>
        <Child t-props="this.p"><span>with t-props</span></Child>
        <Child slots="this.s"><t t-set-slot="a">with a slots prop</t></Child>
      </div>`);
    expect(lines.filter((line) => line.includes("slots")).length).toBeGreaterThanOrEqual(3);
    expect(lines.filter((line) => line.includes("markRaw("))).toEqual([]);
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

  test("a bound property makes no wrapper object", () => {
    const lines = renderFunctionLines(`
      <div>
        <input t-att-value="this.v" t-att-disabled="this.d" t-att-readonly="this.r"/>
        <input type="checkbox" t-att-checked="this.c" t-att-indeterminate="this.i"/>
        <select t-att-value="this.v"><option value="a" t-att-selected="this.s">a</option></select>
        <textarea t-attf-value="{{this.v}}!"/>
        <input type="radio" t-att-value="this.v" t-model="this.choice"/>
      </div>`);
    expect(lines.filter((line) => /new (String|Boolean)\(/.test(line))).toEqual([]);
  });

  test("an event handler makes no array: its code is static, its data the context", () => {
    const lines = renderFunctionLines(`
      <div>
        <button t-on-click="this.f"/>
        <button t-on-click.stop.prevent="() => this.g()"/>
        <button t-on-click.stop=""/>
        <input t-model="this.text"/>
        <Child t-on-click="this.f" t-on-keydown.stop="this.g"/>
        <t t-tag="this.tag" t-on-click="this.f"/>
        <ul><li t-foreach="this.items" t-as="item" t-key="item" t-on-click="() => this.f(item)"/></ul>
      </div>`);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.filter((line) => /\[\s*(hdlr_fn\d+|hdlr\d+|null)\b/.test(line))).toEqual([]);
  });

  test("making a template's functions makes no block type per block with handlers", () => {
    const code = compile(
      `<div><button t-on-click="this.f"/><p t-on-click="this.g"><i/></p></div>`
    ).toString();
    // the handlers of each block are listed once, the type is the string's,
    // and each call gives the handlers
    expect(code).toContain("const block1_handlers = [hdlr_fn1, hdlr_fn2];");
    expect(code).toMatch(/let block1 = createBlock\(`[^`]*`, block1_handlers\);/);
    expect(code).toContain("return block1([ctx, ctx], null, block1_handlers);");
  });

  test("a block with a dynamic tag and a handler makes its block type once per tag", async () => {
    const template = `<t t-tag="this.tag()" t-on-click="() => this.clicks++">x</t>`;
    expect(compile(template).toString()).toContain(
      "block1_types[tag] || (block1_types[tag] = createBlock("
    );
    let parent: any;
    class Parent extends Component {
      static template = xml`${template}`;
      tag = signal("b");
      clicks = 0;
      setup() {
        parent = this;
      }
    }
    await mount(Parent, fixture);
    for (const tag of ["i", "b", "i"]) {
      parent.tag.set(tag);
      await nextTick();
      fixture.firstElementChild!.dispatchEvent(new Event("click", { bubbles: true }));
    }
    expect(parent.clicks).toBe(3);
    expect(fixture.innerHTML).toBe("<i>x</i>");
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

describe("slots reached through a proxy", () => {
  // a component can hand the slots it received to a child through proxied
  // state (`t-props` of a proxy holding them, a copy of them in a store): the
  // slot still renders with the raw `this` and context of the template that
  // wrote it, whose class may have private members no proxy can reach
  class Inner extends Component {
    static template = xml`<div><t t-call-slot="default"/><t t-call-slot="named" v="'scoped'"/></div>`;
  }
  class Owner extends Component {
    static components: any;
    static template = xml`
      <Wrapper>
        <b t-out="this.secret"/><i t-out="this.isRaw()"/>
        <t t-set-slot="named" t-slot-scope="s"><u t-out="s.v + this.secret"/></t>
      </Wrapper>`;
    #secret = "s";
    get secret() {
      return this.#secret;
    }
    isRaw() {
      return toRaw(this) === this ? "raw" : "proxy";
    }
  }
  const expected = "<div><b>s</b><i>raw</i><u>scopeds</u></div>";

  test("slots held in proxied state and given with t-props", async () => {
    class Wrapper extends Component {
      static template = xml`<Inner t-props="this.state"/>`;
      static components = { Inner };
      props = props();
      state = proxy({ slots: this.props.slots });
    }
    Owner.components = { Wrapper };
    await mount(Owner, fixture);
    expect(fixture.innerHTML).toBe(expected);
  });

  test("a copy of the slots in proxied state, given as the slots prop", async () => {
    class Wrapper extends Component {
      static template = xml`<Inner slots="this.state.slots"/>`;
      static components = { Inner };
      props = props();
      state = proxy({ slots: { ...this.props.slots } });
    }
    Owner.components = { Wrapper };
    await mount(Owner, fixture);
    expect(fixture.innerHTML).toBe(expected);
  });

  test("the template channel says a slot rendered from the raw object of a proxy", async () => {
    class Wrapper extends Component {
      static template = xml`<Inner t-props="this.state"/>`;
      static components = { Inner };
      props = props();
      state = proxy({ slots: { ...this.props.slots } });
    }
    Owner.components = { Wrapper };
    const lines: string[] = [];
    setDebugSink((channel, message) => lines.push(`${channel}: ${message}`));
    setDebug(["template"]);
    try {
      await mount(Owner, fixture);
    } finally {
      setDebug(false);
      setDebugSink(null);
    }
    expect(fixture.innerHTML).toBe(expected);
    expect(lines.filter((line) => line.includes("slot"))).toEqual([
      'template: slot "default": its descriptor is a proxy, rendered from its raw object',
      'template: slot "named": its descriptor is a proxy, rendered from its raw object',
    ]);
  });

  test("a slot descriptor held in proxied state, given in a slots prop", async () => {
    class Wrapper extends Component {
      static template = xml`<Inner slots="{ default: this.props.slots.default, named: this.store.named }"/>`;
      static components = { Inner };
      props = props();
      store = proxy({ named: this.props.slots.named });
    }
    Owner.components = { Wrapper };
    await mount(Owner, fixture);
    expect(fixture.innerHTML).toBe(expected);
  });
});

describe("contexts made under a loop item", () => {
  test("a nested loop's items and a call context copy the loop item's names, made under its prototype", () => {
    const lines = renderFunctionLines(
      `<ul><li t-foreach="this.rows" t-as="r" t-key="r"><t t-call="sub" x="1"/><t t-foreach="this.cols" t-as="c" t-key="c"><i t-out="r + c"/></t></li></ul>`
    );
    const made = lines.flatMap((line) =>
      [...line.matchAll(/Object\.create\((ctx\d*)\)/g)].map((m) => m[1])
    );
    // the outer items are made under the template's context, and so is
    // everything made under them
    expect(made).toEqual(["ctx1", "ctx1", "ctx1"]);
    expect(lines.filter((line) => /\["r"\] = ctx\d*\["r"\]/.test(line)).length).toBe(2);
  });

  test("a loop item a t-set writes is inherited from: a later write is seen", async () => {
    const seen: any[] = [];
    class Parent extends Component {
      static template = xml`
        <t t-foreach="[1, 2]" t-as="a" t-key="a">
          <t t-set="n" t-value="0"/>
          <t t-foreach="[1, 2, 3]" t-as="b" t-key="b"><t t-set="n" t-value="n + b"/><i t-out="n"/></t>
          <t t-foreach="[1]" t-as="c" t-key="c"><button t-on-click="() => this.seen.push(late + n)"/></t>
          <t t-set="late" t-value="'L'"/>
          <b t-out="n"/>
        </t>`;
      seen = seen;
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe(
      "<i>1</i><i>3</i><i>6</i><button></button><b>6</b><i>1</i><i>3</i><i>6</i><button></button><b>6</b>"
    );
    fixture.querySelector("button")!.click();
    expect(seen).toEqual(["L6"]);
  });

  test("a template assigning a variable in an expression inherits from its loop items", async () => {
    const seen: any[] = [];
    class Parent extends Component {
      static template = xml`
        <t t-foreach="[1]" t-as="a" t-key="a">
          <button class="w" t-on-click="() => v = 'set'"/>
          <t t-foreach="[1]" t-as="b" t-key="b"><button class="r" t-on-click="() => this.seen.push(v)"/></t>
          <t t-call="${xml`<button class="c" t-on-click="() => this.seen.push(v + x)"/>`}" x="'!'"/>
        </t>`;
      seen = seen;
    }
    await mount(Parent, fixture);
    fixture.querySelector<HTMLElement>(".w")!.click();
    fixture.querySelector<HTMLElement>(".r")!.click();
    fixture.querySelector<HTMLElement>(".c")!.click();
    expect(seen).toEqual(["set", "set!"]);
  });

  test("a call context in nested loops sees every loop's names and its own attributes", async () => {
    const seen: any[] = [];
    const sub = xml`<button t-on-click="() => this.seen.push([a, a_index, b, b_index, x].join())"/>`;
    class Parent extends Component {
      static template = xml`
        <t t-foreach="['p', 'q']" t-as="a" t-key="a">
          <t t-foreach="['r', 's']" t-as="b" t-key="b"><t t-call="${sub}" x="a + b" b="b + '!'"/></t>
        </t>`;
      seen = seen;
    }
    await mount(Parent, fixture);
    for (const button of fixture.querySelectorAll("button")) {
      button.click();
    }
    expect(seen).toEqual(["p,0,r!,0,pr", "p,0,s!,1,ps", "q,1,r!,0,qr", "q,1,s!,1,qs"]);
  });
});
