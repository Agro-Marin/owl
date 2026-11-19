import ts from "typescript";
import { compileTypeShadow, TYPE_SHADOW_PRELUDE, type TypeShadowOptions } from "../src/type_shadow";

// Each case type-checks a template's shadow against a component class, as a
// consumer's tsc would, and reports each error with the template origin the
// shadow maps its line to.

const COMPONENT = `
interface Item { id: number; name: string }
class Counter {
  state = { count: 0, label: "" as string | null };
  items: Item[] = [];
  byId = new Map<number, Item>();
  anything: any = [];
  onClick(ev: MouseEvent) { void ev; }
  onImage(ev: PointerEvent & { target: HTMLImageElement }) { void ev.target.src; }
  onKey(ev: KeyboardEvent) { void ev.key; }
  onTyped(ev: Event & { target: HTMLInputElement }) { void ev.target.value; }
  increment() { this.state.count++; }
}
`;

function check(template: string, options: Partial<TypeShadowOptions> = {}): string[] {
  const shadow = compileTypeShadow(template, {
    componentType: "Counter",
    functionName: "shadow",
    ...options,
  });
  const before = TYPE_SHADOW_PRELUDE + COMPONENT;
  const source = before + shadow.code + "\n";
  const offset = before.split("\n").length - 1;
  const fileName = "/shadow.ts";
  const compilerOptions: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    types: [],
    target: ts.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
  };
  const host = ts.createCompilerHost(compilerOptions);
  const getSourceFile = host.getSourceFile;
  host.getSourceFile = (name, languageVersion, ...rest) =>
    name === fileName
      ? ts.createSourceFile(name, source, languageVersion)
      : getSourceFile.call(host, name, languageVersion, ...rest);
  const program = ts.createProgram([fileName], compilerOptions, host);
  return ts.getPreEmitDiagnostics(program).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    if (!diagnostic.file || diagnostic.file.fileName !== fileName) {
      return `(outside the shadow) ${message}`;
    }
    const { line } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start!);
    return `${shadow.origins[line - offset] ?? "?"}: ${message}`;
  });
}

test("a template reading only what its component has checks clean", () => {
  expect(
    check(`
      <div t-att-class="{ busy: this.state.count gt 2 }" t-on-click="this.onClick">
        <t t-set="total" t-value="this.items.length"/>
        <span t-out="this.state.count"/>
        <ul>
          <li t-foreach="this.items" t-as="item" t-key="item.id" t-attf-title="#{item.name} ({{ item_index + 1 }})">
            <t t-out="item.name.toUpperCase()"/>
            <button t-on-click="(ev) => ev.button and this.increment()">+</button>
          </li>
        </ul>
        <p t-if="this.state.label" t-out="this.state.label.trim()"/>
        <p t-else="">no label</p>
        <i t-out="total + 1"/>
      </div>`)
  ).toEqual([]);
});

test("a misspelled field is reported at the expression that reads it", () => {
  expect(check(`<span t-out="this.state.cuont"/>`)).toEqual([
    `t-out="this.state.cuont": Property 'cuont' does not exist on type '{ count: number; label: string | null; }'. Did you mean 'count'?`,
  ]);
});

test("a loop variable is typed as the collection's items", () => {
  expect(
    check(`<t t-foreach="this.items" t-as="item" t-key="item.id"><t t-out="item.nme"/></t>`)
  ).toEqual([
    `t-out="item.nme": Property 'nme' does not exist on type 'Item'. Did you mean 'name'?`,
  ]);
});

test("a loop over an untyped collection binds untyped items", () => {
  expect(
    check(`<t t-foreach="this.anything" t-as="row" t-key="row.id"><t t-out="row_value.name"/></t>`)
  ).toEqual([]);
});

test("a Map loop binds the key, and its value as _value", () => {
  expect(
    check(`
      <t t-foreach="this.byId" t-as="id" t-key="id">
        <t t-out="id.toFixed(0)"/>
        <t t-out="id_value.name"/>
        <t t-out="id_value.title"/>
      </t>`)
  ).toEqual([`t-out="id_value.title": Property 'title' does not exist on type 'Item'.`]);
});

test("a bare name reads a template variable only, and the app's globals are __globals__", () => {
  expect(check(`<span t-out="count"/>`)).toEqual([
    `t-out="count": Cannot find name 'count'. Did you mean 'Counter'?`,
  ]);
  const globalsType = "{ session: { uid: number } }";
  expect(check(`<span t-out="__globals__.session.uid"/>`, { globalsType })).toEqual([]);
  expect(check(`<span t-out="__globals__.session.name"/>`, { globalsType })).toEqual([
    `t-out="__globals__.session.name": Property 'name' does not exist on type '{ uid: number; }'.`,
  ]);
  expect(check(`<span t-out="session.uid"/>`, { globalsType })).toEqual([
    `t-out="session.uid": Cannot find name 'session'.`,
  ]);
  expect(check(`<span t-out="__globals__.session"/>`)).toEqual([
    `t-out="__globals__.session": Cannot find name '__globals__'.`,
  ]);
});

test("a custom directive is applied before the template is read, as the compiler applies it", () => {
  const customDirectives = {
    tap: (node: Element, value: string) => node.setAttribute("t-on-click", value),
  };
  expect(check(`<button t-custom-tap="this.onClick"/>`, { customDirectives })).toEqual([]);
  expect(check(`<button t-custom-tap="this.onClik"/>`, { customDirectives })).toEqual([
    `<button> t-on-click: Property 'onClik' does not exist on type 'Counter'. Did you mean 'onClick'?`,
  ]);
});

test("a handler receives the event its name dispatches", () => {
  expect(check(`<input t-on-keydown="(ev) => ev.key"/>`)).toEqual([]);
  expect(check(`<button t-on-click.stop="(ev) => ev.key"/>`)).toEqual([
    `<button> t-on-click.stop: Property 'key' does not exist on type 'PointerEvent & { currentTarget: HTMLButtonElement; target: EventTarget; }'.`,
  ]);
  expect(check(`<img t-on-pointerdown="this.onImage"/>`)).toEqual([]);
  expect(check(`<input t-on-input="this.onTyped"/>`)).toEqual([]);
  expect(check(`<button t-on-click="this.onKey"/>`)).toEqual([
    `<button> t-on-click: Argument of type '(ev: KeyboardEvent) => void' is not assignable to parameter of type '(this: Counter, ev: __OwlMethodEvent<"click">) => unknown'.   Types of parameters 'ev' and 'ev' are incompatible.     Type '__OwlMethodEvent<"click">' is missing the following properties from type 'KeyboardEvent': charCode, code, isComposing, key, and 8 more.`,
  ]);
  expect(check(`<button t-on-click="this.increment()"/>`)).toEqual([
    `<button> t-on-click: Argument of type 'void' is not assignable to parameter of type '(this: Counter, ev: __OwlMethodEvent<"click">) => unknown'.`,
  ]);
});

test("a handler's currentTarget is its element, and so is the target where nothing is inside it", () => {
  expect(
    check(`
      <div>
        <input t-on-input="(ev) => ev.target.value + ev.currentTarget.value"/>
        <select t-on-change="(ev) => ev.target.selectedIndex"/>
        <a t-on-click="(ev) => ev.currentTarget.href"/>
      </div>`)
  ).toEqual([]);
  expect(check(`<div t-on-click="(ev) => ev.target.value"/>`)).toEqual([
    `<div> t-on-click: Property 'value' does not exist on type 'EventTarget'.`,
  ]);
});

test("a t-set inside a t-if is read after it, as the runtime's ctx allows", () => {
  expect(
    check(`
      <div>
        <t t-if="this.state.count"><t t-set="seen" t-value="1"/></t>
        <t t-out="seen"/>
      </div>`)
  ).toEqual([]);
});

test("a t-set's text body is text, and its t-value is read", () => {
  expect(check(`<div><t t-set="label">Guest #</t><t t-out="label"/></div>`)).toEqual([]);
  expect(check(`<t t-set="label" t-value="this.missing">Fallback, it's text</t>`)).toEqual([
    `t-set="label": Property 'missing' does not exist on type 'Counter'.`,
  ]);
});

test("an object literal's shorthand this is read as processExpr expands it", () => {
  expect(check(`<t t-call="other" t-call-context="{ this, count: this.state.count }"/>`)).toEqual(
    []
  );
  expect(check(`<t t-call="other" t-call-context="{ this, count: this.state.cuont }"/>`)).toEqual([
    `t-call="other" t-call-context: Property 'cuont' does not exist on type '{ count: number; label: string | null; }'. Did you mean 'count'?`,
  ]);
});

test("a t-if narrows what its branch reads", () => {
  expect(check(`<p t-out="this.state.label.trim()"/>`)).toEqual([
    `t-out="this.state.label.trim()": Object is possibly 'null'.`,
  ]);
  expect(check(`<p t-if="this.state.label" t-out="this.state.label.trim()"/>`)).toEqual([]);
});

test("a prop is read as propEntry reads it: .translate is text, .bind a function", () => {
  const template = (bind: string) => `
    <div>
      <Child title.translate="Save the form" onSave.bind="${bind}" count="this.state.count"/>
      <t t-call-slot="default" label.translate="Default label"/>
    </div>`;
  expect(check(template("this.increment"))).toEqual([]);
  expect(check(template("this.state.count"))).toEqual([
    `<Child> onSave.bind: Property 'bind' does not exist on type 'number'.`,
  ]);
});

test("each line names the attribute it reads as the template writes it", () => {
  const shadow = compileTypeShadow(
    `<div t-att-class="this.state.label" t-on-click="this.onClick">
      <t t-foreach="this.items" t-as="item" t-key="item.id">
        <span t-if="item.name &amp;&amp; this.state.count" t-out="item.name"/>
      </t>
      <t t-set="total" t-value="this.items.length"/>
      <Child value.bind="this.increment"/>
    </div>`,
    { componentType: "Counter", functionName: "shadow" }
  );
  expect(shadow.sources).toHaveLength(shadow.code.split("\n").length);
  const sources = shadow.sources.filter((source) => source !== null);
  expect(sources).toEqual([
    { attribute: "t-set", value: "total" },
    { attribute: "t-att-class", value: "this.state.label" },
    { attribute: "t-on-click", value: "this.onClick" },
    { attribute: "t-foreach", value: "this.items" },
    { attribute: "t-foreach", value: "this.items" },
    { attribute: "t-key", value: "item.id" },
    { attribute: "t-if", value: "item.name && this.state.count" },
    { attribute: "t-out", value: "item.name" },
    { attribute: "t-value", value: "this.items.length" },
    { attribute: "value.bind", value: "this.increment" },
  ]);
});
