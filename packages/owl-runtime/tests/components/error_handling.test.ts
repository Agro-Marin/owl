import {
  App,
  Component,
  mount,
  onWillDestroy,
  props,
  types,
  onError,
  onMounted,
  onPatched,
  onWillPatch,
  onWillStart,
  onWillUnmount,
  onWillUpdateProps,
  proxy,
  signal,
  useEffect,
  xml,
} from "../../src";
import { getCurrentComputation, useScope } from "@odoo/owl-core";
import {
  logStep,
  makeDeferred,
  makeTestFixture,
  nextAppError,
  nextMicroTick,
  nextTick,
  render,
  snapshotEverything,
  steps,
  useLogLifecycle,
  getConsoleOutput,
} from "../helpers";

let fixture: HTMLElement;

snapshotEverything();

beforeEach(() => {
  fixture = makeTestFixture();
});

describe("basics", () => {
  test("no component catching error lead to full app destruction", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>hey<t t-out="this.props.flag and this.state.this.will.crash"/></div>`;
      props = props();
    }

    class Parent extends Component {
      static template = xml`<div><ErrorComponent flag="this.state.flag"/></div>`;
      static components = { ErrorComponent };
      state = { flag: false };
    }
    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div><div>heyfalse</div></div>");
    parent.state.flag = true;

    render(parent);
    const error = await nextAppError(parent.__owl__.app);
    expect(error).toBeInstanceOf(TypeError);
    expect(fixture.innerHTML).toBe("");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("display a nice error if it cannot find component", async () => {
    class SomeComponent extends Component {}
    class Parent extends Component {
      static template = xml`<SomeMispelledComponent />`;
      static components = { SomeComponent };
    }
    const app = new App();
    let error: any;
    const mountProm = app
      .createRoot(Parent)
      .mount(fixture)
      .catch((e: Error) => (error = e));
    await mountProm;
    expect(error!).toBeDefined();
    expect(error!.message).toBe('Cannot find the definition of component "SomeMispelledComponent"');
    expect(getConsoleOutput()).toEqual([]);
  });

  test("display a nice error if it cannot find component (in dev mode)", async () => {
    class SomeComponent extends Component {}
    class Parent extends Component {
      static template = xml`<SomeMispelledComponent />`;
      static components = { SomeComponent };
    }
    let error: any;
    try {
      await mount(Parent, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error!.message).toBe('Cannot find the definition of component "SomeMispelledComponent"');
    expect(getConsoleOutput()).toEqual([]);
  });

  test("display a nice error if a component is not a component", async () => {
    function notAComponentConstructor() {}
    class Parent extends Component {
      static template = xml`<SomeComponent />`;
      static components = { SomeComponent: notAComponentConstructor };
    }
    let error: any;
    try {
      await mount(Parent as any, fixture);
    } catch (e) {
      error = e;
    }
    expect(error!.message).toBe(
      '"SomeComponent" is not a Component. It must inherit from the Component class'
    );
  });

  test("display a nice error if the components key is missing with subcomponents", async () => {
    class Parent extends Component {
      static template = xml`<div><MissingChild /></div>`;
    }
    let error: any;
    try {
      await mount(Parent as any, fixture);
    } catch (e) {
      error = e;
    }
    expect(error!.message).toBe(
      'Cannot find the definition of component "MissingChild", missing static components key in parent'
    );
  });

  test("a sync re-render error deep in the tree is only wrapped once", async () => {
    class Child extends Component {
      static template = xml`<div><t t-out="this.props.flag and this.state.this.will.crash"/></div>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<Child flag="this.props.flag"/>`;
      static components = { Child };
      props = props();
    }
    class GrandParent extends Component {
      static template = xml`<Parent flag="this.state.flag"/>`;
      static components = { Parent };
      state = { flag: false };
    }
    const gp = await mount(GrandParent, fixture);
    gp.state.flag = true;

    // Can't use nextAppError here: it monkey-patches _handleError which
    // breaks the throw-through cascade we're testing. Instead, let the sync
    // re-render error reject the render promise directly.
    let error: any;
    try {
      await render(gp);
    } catch (e) {
      error = e;
    }
    expect(error!.message).toMatch(/Cannot read propert/);
    // As the throw unwinds through Parent and GrandParent renders, their
    // handleError frames must not wrap the error that is already propagating.
    expect(error!.cause).toBeUndefined();
  });

  test("currentComputation does not leak when an uncaught render error propagates", async () => {
    class Child extends Component {
      static template = xml`<div><t t-out="this.props.flag and this.state.this.will.crash"/></div>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<Child flag="this.state.flag"/>`;
      static components = { Child };
      state = { flag: false };
    }

    const parent = await mount(Parent, fixture);
    expect(getCurrentComputation()).toBeUndefined();

    parent.state.flag = true;
    // The re-render of Child throws and, with no error boundary installed,
    // handleError → app._handleError re-throws. Fiber.render() must still
    // restore currentComputation; otherwise it stays pinned to Child's dead
    // signalComputation and every subsequent atom read attaches to it.
    let error: any;
    try {
      await render(parent);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(getCurrentComputation()).toBeUndefined();
  });

  test("currentComputation does not leak when a willStart promise rejects after await", async () => {
    // initiateRender captures the parent's signalComputation as `prev` before
    // running willStart. If the willStart promise rejects post-await, the
    // catch must NOT restore currentComputation to `prev` — by then we are in
    // a fresh microtask and `prev` is stale; pinning currentComputation to it
    // leaks the parent signalComputation forever.
    class Child extends Component {
      static template = xml`<div/>`;
      setup() {
        onWillStart(async () => {
          await Promise.resolve();
          throw new Error("boom");
        });
      }
    }
    class Parent extends Component {
      static template = xml`<Child/>`;
      static components = { Child };
    }

    let error: any;
    try {
      await mount(Parent, fixture);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(getCurrentComputation()).toBeUndefined();
  });

  test("a willUpdateProps hook throwing synchronously restores the parent's computation", async () => {
    const seen: any[] = [];
    class Child extends Component {
      static template = xml`<div t-out="this.props.n"/>`;
      props = props();
      setup() {
        onWillUpdateProps(() => {
          throw new Error("boom");
        });
      }
    }
    class Parent extends Component {
      static template = xml`<t t-if="!this.state.failed"><Child n="this.state.n"/></t>`;
      static components = { Child };
      state = proxy({ n: 1, failed: false });
      setup() {
        onError(() => {
          seen.push(getCurrentComputation() === this.__owl__.signalComputation);
          this.state.failed = true;
        });
      }
    }
    const parent = await mount(Parent, fixture);
    parent.state.n = 2;
    await nextTick();
    expect(seen).toEqual([true]);
    expect(fixture.innerHTML).toBe("");
  });

  test("display a nice error if the root component template fails to compile", async () => {
    // This is a special case: mount throws synchronously and we don't have any
    // node which can handle the error, hence the different structure of this test
    class Comp extends Component {
      static template = xml`<div t-att-class="a b">test</div>`;
    }
    let error: Error;
    try {
      await mount(Comp, fixture);
    } catch (e) {
      error = e as Error;
    }
    const expectedErrorMessage = `Failed to compile anonymous template: Unexpected identifier 'ctx'

generated code:
function(app, bdom, helpers) {
  let { text, createBlock, list, multi, html, toggler } = bdom;
  
  let block1 = createBlock(\`<div block-attribute-0="class">test</div>\`);
  
  return function template(ctx, node, key = "") {
    let attr1 = ctx['a']ctx['b'];
    return block1([attr1]);
  }
}`;
    expect(error!).toBeDefined();
    expect((error! as any).message).toBe(expectedErrorMessage);
  });

  test("display a nice error if a non-root component template fails to compile", async () => {
    class Child extends Component {
      static template = xml`<div t-att-class="a b">test</div>`;
    }
    class Parent extends Component {
      static components = { Child };
      static template = xml`<Child/>`;
    }
    const expectedErrorMessage = `Failed to compile anonymous template: Unexpected identifier 'ctx'

generated code:
function(app, bdom, helpers) {
  let { text, createBlock, list, multi, html, toggler } = bdom;
  
  let block1 = createBlock(\`<div block-attribute-0="class">test</div>\`);
  
  return function template(ctx, node, key = "") {
    let attr1 = ctx['a']ctx['b'];
    return block1([attr1]);
  }
}`;
    let error: any;
    try {
      await mount(Parent, fixture);
    } catch (e) {
      error = e as Error;
    }
    expect(error!).toBeDefined();
    expect(error!.message).toBe(expectedErrorMessage);
  });

  test("simple catchError", async () => {
    class Boom extends Component {
      static template = xml`<div t-out="a.b.c"/>`;
    }

    class Parent extends Component {
      static template = xml`
        <div>
          <t t-if="this.error">Error</t>
          <t t-else="">
            <Boom />
          </t>
        </div>`;
      static components = { Boom };

      error: any = false;

      setup() {
        onError((err) => {
          this.error = err;
          render(this);
        });
      }
    }
    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div>Error</div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("render from above on error -- handler is not a Root or MountFiber", async () => {
    class Boom extends Component {
      static template = xml`<div t-out="a.b.c"/>`;
      props = props({ onError: types.function() });
      setup() {
        onError((err) => {
          this.props.onError(err);
        });
      }
    }

    class Parent extends Component {
      static template = xml`
        <div>
          <t t-if="this.error">Error</t>
          <t t-else="">
            <Boom onError.bind="this.handleError"/>
          </t>
        </div>`;
      static components = { Boom };

      error: any = false;

      handleError(err: Error) {
        this.error = err;
        render(this);
      }
    }

    class GrandParent extends Component {
      static template: string = xml`<Parent />`;
      static components = { Parent };
    }
    await mount(GrandParent, fixture);
    expect(fixture.innerHTML).toBe("<div>Error</div>");
    expect(getConsoleOutput()).toEqual([]);
  });
});

describe("errors and promises", () => {
  test("the mount promise rejects with the error an onError handler rethrew", async () => {
    class Child extends Component {
      static template = xml`<div/>`;
      setup() {
        throw new Error("original");
      }
    }
    class Root extends Component {
      static components = { Child };
      static template = xml`<Child/>`;
      setup() {
        onError((e) => {
          throw new Error("wrapped: " + e.message);
        });
      }
    }

    await expect(mount(Root, fixture)).rejects.toThrow("wrapped: original");
  });

  test("a rendering error will reject the mount promise", async () => {
    // we do not catch error in willPatch anymore
    class Root extends Component {
      static template = xml`<div><t t-out="this.will.crash"/></div>`;
    }

    let error: any;
    try {
      await mount(Root, fixture);
    } catch (e) {
      error = e as Error;
    }

    expect(error!).toBeDefined();
    const regexp =
      /Cannot read properties of undefined \(reading 'crash'\)|Cannot read property 'crash' of undefined/g;
    expect(error!.message).toMatch(regexp);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("an error in mounted call will reject the mount promise", async () => {
    class Root extends Component {
      static template = xml`<div>abc</div>`;
      setup() {
        onMounted(() => {
          throw new Error("boom");
        });
      }
    }

    let error: any;
    try {
      await mount(Root, fixture);
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(error.message).toBe("boom");
    expect(fixture.innerHTML).toBe("");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("an error in onMounted callback will have the component's setup in its stack trace", async () => {
    class Root extends Component {
      static template = xml`<div>abc</div>`;
      setup() {
        onMounted(() => {
          throw new Error("boom");
        });
      }
    }

    let error: any;
    try {
      await mount(Root, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(error.stack).toContain("error_handling.test.ts");
    expect(fixture.innerHTML).toBe("");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("errors thrown from async hooks propagate through the mount rejection", async () => {
    class Root extends Component {
      static template = xml`<div>abc</div>`;
      setup() {
        onWillStart(async () => {
          await Promise.resolve();
          throw new Error("boom in onWillStart");
        });
      }
    }

    let error: any;
    try {
      await mount(Root, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeDefined();
    expect(error.message).toBe("boom in onWillStart");
  });

  test("an error in willPatch call will reject the render promise", async () => {
    class Root extends Component {
      static template = xml`<div><t t-out="this.val"/></div>`;
      val = 3;
      setup() {
        onWillPatch(() => {
          throw new Error("boom");
        });
        onError((e) => (error = e));
      }
    }

    const root = await mount(Root, fixture, { test: true });
    root.val = 4;
    let error: Error;
    render(root);
    await nextTick();
    expect(error!).toBeDefined();
    expect(error!.message).toBe(`boom`);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("an error in patched call will reject the render promise", async () => {
    class Root extends Component {
      static template = xml`<div><t t-out="this.val"/></div>`;
      val = 3;
      setup() {
        onPatched(() => {
          throw new Error("boom");
        });
        onError((e) => (error = e));
      }
    }

    const root = await mount(Root, fixture, { test: true });
    root.val = 4;
    let error: Error;
    render(root);
    await nextTick();
    expect(error!).toBeDefined();
    expect(error!.message).toBe(`boom`);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("a rendering error in a sub component will reject the mount promise", async () => {
    // we do not catch error in willPatch anymore
    class Child extends Component {
      static template = xml`<div><t t-out="this.will.crash"/></div>`;
    }
    class Parent extends Component {
      static template = xml`<div><Child/></div>`;
      static components = { Child };
    }

    let error: any;
    try {
      await mount(Parent, fixture);
    } catch (e) {
      error = e;
    }
    const regexp =
      /Cannot read properties of undefined \(reading 'crash'\)|Cannot read property 'crash' of undefined/g;
    expect(error!.message).toMatch(regexp);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("a rendering error will reject the render promise", async () => {
    class Root extends Component {
      static template = xml`<div><t t-if="this.flag" t-out="this.will.crash"/></div>`;
      flag = false;
      setup() {
        onError((cause) => (error = cause));
      }
    }

    const root = await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div></div>");
    root.flag = true;
    let error: Error;
    render(root);
    await nextTick();
    expect(error!).toBeDefined();
    const regexp =
      /Cannot read properties of undefined \(reading 'crash'\)|Cannot read property 'crash' of undefined/g;
    expect(error!.message).toMatch(regexp);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("a rendering error will reject the render promise (with sub components)", async () => {
    class Child extends Component {
      static template = xml`<span></span>`;
    }
    class Parent extends Component {
      static template = xml`<div><Child/><t t-out="x.y"/></div>`;
      static components = { Child };
    }

    let error: any;
    try {
      await mount(Parent, fixture);
    } catch (e) {
      error = e;
    }

    const regexp =
      /Cannot read properties of undefined \(reading 'y'\)|Cannot read property 'y' of undefined/g;
    expect(error!.message).toMatch(regexp);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("errors in mounted and in willUnmount", async () => {
    class Example extends Component {
      static template = xml`<div/>`;
      val: any;
      setup() {
        onMounted(() => {
          throw new Error("Error in mounted");
          this.val = { foo: "bar" };
        });

        onWillUnmount(() => {
          console.log(this.val.foo);
        });
      }
    }
    let error: any;
    try {
      await mount(Example, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error!.message).toBe(`Error in mounted`);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("errors in rerender", async () => {
    class Example extends Component {
      static template = xml`<div t-out="this.state.a.b"/>`;
      state: any = { a: { b: 1 } };
    }
    const root = await mount(Example, fixture);
    expect(fixture.innerHTML).toBe("<div>1</div>");

    root.state = "boom";
    render(root);
    const error: any = await nextAppError(root.__owl__.app)!;
    expect(error.message).toBe("Cannot read properties of undefined (reading 'b')");
    expect(fixture.innerHTML).toBe("");
    expect(getConsoleOutput()).toEqual([]);
  });
});

describe("can catch errors", () => {
  test("can catch an error in a component render function", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>hey<t t-out="this.props.flag and this.state.this.will.crash"/></div>`;
      props = props();
    }
    class ErrorBoundary extends Component {
      static template = xml`
          <div>
            <t t-if="this.state.error">Error handled</t>
            <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`
          <div>
            <ErrorBoundary><ErrorComponent flag="this.state.flag"/></ErrorBoundary>
          </div>`;
      state = proxy({ flag: false });
      static components = { ErrorBoundary, ErrorComponent };
    }
    const app = await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><div><div>heyfalse</div></div></div>");
    app.state.flag = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in onmounted", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>Error!!!</div>`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          throw new Error("error");
        });
      }
    }
    class PerfectComponent extends Component {
      static template = xml`<div>perfect</div>`;
      setup() {
        useLogLifecycle(this);
      }
    }
    class Main extends Component {
      static template = xml`Main<t t-if="this.state.ok" t-component="this.component"/>`;
      component: any;
      state: any;
      setup() {
        this.state = proxy({ ok: false });
        useLogLifecycle(this);
        this.component = ErrorComponent;
        onError(() => {
          this.component = PerfectComponent;
          render(this);
        });
      }
    }

    const app = await mount(Main, fixture);
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Main:setup",
        "Main:willStart",
        "Main:mounted",
      ]
    `);
    expect(fixture.innerHTML).toBe("Main");
    (app as any).state.ok = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("Main<div>Error!!!</div>");
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "ErrorComponent:setup",
        "ErrorComponent:willStart",
        "Main:willPatch",
        "ErrorComponent:mounted",
        "PerfectComponent:setup",
        "PerfectComponent:willStart",
      ]
    `);
    await nextTick();
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Main:willPatch",
        "ErrorComponent:willUnmount",
        "ErrorComponent:willDestroy",
        "PerfectComponent:mounted",
        "Main:patched",
      ]
    `);
    expect(fixture.innerHTML).toBe("Main<div>perfect</div>");
  });

  test("calling a hook outside setup should crash", async () => {
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onWillStart(() => {
          useScope();
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture, { test: true });
    } catch (e: any) {
      error = e;
    }
    expect(error!.message).toBe(`No active scope`);
  });

  test("Errors thrown from user hooks surface as-is (sync)", async () => {
    const err = new Error("test error");
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onMounted(() => {
          throw err;
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBe(err);
  });

  test("Errors thrown from user hooks surface as-is (async)", async () => {
    const err = new Error("test error");
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onWillStart(async () => {
          await nextMicroTick();
          throw err;
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBe(err);
  });

  test("Errors thrown outside dev mode also surface as-is (sync)", async () => {
    const err = new Error("test error");
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onMounted(() => {
          throw err;
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture);
    } catch (e) {
      error = e;
    }
    expect(error).toBe(err);
  });

  test("Errors thrown outside dev mode also surface as-is (async)", async () => {
    const err = new Error("test error");
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onWillStart(async () => {
          await nextMicroTick();
          throw err;
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture);
    } catch (e) {
      error = e;
    }
    expect(error).toBe(err);
  });

  test("Thrown non-error values surface as-is (dev mode)", async () => {
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onMounted(() => {
          throw "This is not an error";
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture, { test: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBe(`This is not an error`);
  });

  test("Thrown non-error values surface as-is (outside dev mode)", async () => {
    class Root extends Component {
      static template = xml`<t t-out="this.state.value"/>`;
      state = proxy({ value: 1 });

      setup() {
        onMounted(() => {
          throw "This is not an error";
        });
      }
    }
    let error: any;
    try {
      await mount(Root, fixture);
    } catch (e) {
      error = e;
    }
    expect(error).toBe(`This is not an error`);
  });

  test("can catch an error in the initial call of a component render function (parent mounted)", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>hey<t t-out="this.state.this.will.crash"/></div>`;
    }
    class ErrorBoundary extends Component {
      static template = xml`
          <div>
            <t t-if="this.state.error">Error handled</t>
            <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => {
          this.state.error = true;
        });
      }
    }
    class App extends Component {
      static template = xml`
          <div>
              <ErrorBoundary><ErrorComponent /></ErrorBoundary>
          </div>`;
      static components = { ErrorBoundary, ErrorComponent };
    }
    await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the initial call of a component render function (parent updated)", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>hey<t t-out="this.state.this.will.crash"/></div>`;
    }
    class ErrorBoundary extends Component {
      static template = xml`
          <div>
            <t t-if="this.state.error">Error handled</t>
            <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`
          <div>
              <ErrorBoundary t-if="this.state.flag"><ErrorComponent /></ErrorBoundary>
          </div>`;
      state = proxy({ flag: false });
      static components = { ErrorBoundary, ErrorComponent };
    }
    const app = await mount(App, fixture);
    app.state.flag = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the constructor call of a component render function", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        throw new Error("NOOOOO");
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`<div>
              <t t-if="this.state.error">Error handled</t>
              <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`<div>
              <ErrorBoundary><ErrorComponent /></ErrorBoundary>
          </div>`;
      static components = { ErrorBoundary, ErrorComponent };
    }
    await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the constructor call of a component render function 2", async () => {
    class ClassicCompoent extends Component {
      static template = xml`<div>classic</div>`;
    }

    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        throw new Error("NOOOOO");
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`<div>
              <t t-if="this.state.error">Error handled</t>
              <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`<div>
              <ErrorBoundary><ClassicCompoent/><ErrorComponent /></ErrorBoundary>
          </div>`;
      static components = { ErrorBoundary, ErrorComponent, ClassicCompoent };
    }
    await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the willStart call", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        onWillStart(async () => {
          // we wait a little bit to be in a different stack frame
          await nextTick();
          throw new Error("NOOOOO");
        });
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`
          <div>
            <t t-if="this.state.error">Error handled</t>
            <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`<div><ErrorBoundary><ErrorComponent /></ErrorBoundary></div>`;
      static components = { ErrorBoundary, ErrorComponent };
    }
    await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error origination from a child's willStart function", async () => {
    class ClassicCompoent extends Component {
      static template = xml`<div>classic</div>`;
    }

    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        onWillStart(() => {
          throw new Error("NOOOOO");
        });
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`<div>
              <t t-if="this.state.error">Error handled</t>
              <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`<div>
              <ErrorBoundary><ClassicCompoent/><ErrorComponent /></ErrorBoundary>
          </div>`;
      static components = { ErrorBoundary, ErrorComponent, ClassicCompoent };
    }
    await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the mounted call", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          logStep("boom");
          throw new Error("NOOOOO");
        });
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`<div>
       <t t-if="this.state.error">Error handled</t>
       <t t-else=""><t t-call-slot="default" /></t>
      </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        useLogLifecycle(this);
        onError(() => (this.state.error = true));
      }
    }
    class Root extends Component {
      static template = xml`<div>
        <ErrorBoundary><ErrorComponent /></ErrorBoundary>
      </div>`;
      static components = { ErrorBoundary, ErrorComponent };
      setup() {
        useLogLifecycle(this);
      }
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Root:setup",
        "Root:willStart",
        "ErrorBoundary:setup",
        "ErrorBoundary:willStart",
        "ErrorComponent:setup",
        "ErrorComponent:willStart",
        "ErrorComponent:mounted",
        "boom",
        "ErrorComponent:willUnmount",
        "ErrorComponent:willDestroy",
        "ErrorBoundary:mounted",
        "Root:mounted",
      ]
    `);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the mounted call (in root component)", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          logStep("boom");
          throw new Error("NOOOOO");
        });
      }
    }
    class Root extends Component {
      static template = xml`<div>
       <t t-if="this.state.error">Error handled</t>
       <t t-else=""><ErrorComponent /></t>
      </div>`;
      static components = { ErrorComponent };
      state = proxy({ error: false });

      setup() {
        useLogLifecycle(this);
        onError(() => (this.state.error = true));
      }
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div>Error handled</div>");
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Root:setup",
        "Root:willStart",
        "ErrorComponent:setup",
        "ErrorComponent:willStart",
        "ErrorComponent:mounted",
        "boom",
        "ErrorComponent:willUnmount",
        "ErrorComponent:willDestroy",
        "Root:mounted",
      ]
    `);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the mounted call (in child of child)", async () => {
    class Boom extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          logStep("boom");
          throw new Error("NOOOOO");
        });
      }
    }

    class C extends Component {
      static template = xml`<div>
       <t t-if="this.state.error">Error handled</t>
       <t t-else=""><Boom/></t>
      </div>`;
      static components = { Boom };
      state = proxy({ error: false });

      setup() {
        useLogLifecycle(this);
        onError(() => (this.state.error = true));
      }
    }

    class B extends Component {
      static template = xml`<div><C/></div>`;
      static components = { C };
      setup() {
        useLogLifecycle(this);
      }
    }
    class A extends Component {
      static template = xml`<B/>`;
      static components = { B };
      setup() {
        useLogLifecycle(this);
      }
    }
    await mount(A, fixture);
    expect(fixture.innerHTML).toBe("<div><div>Error handled</div></div>");
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "A:setup",
        "A:willStart",
        "B:setup",
        "B:willStart",
        "C:setup",
        "C:willStart",
        "Boom:setup",
        "Boom:willStart",
        "Boom:mounted",
        "boom",
        "Boom:willUnmount",
        "Boom:willDestroy",
        "C:mounted",
        "B:mounted",
        "A:mounted",
      ]
    `);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("error in mounted on a component with a sibling (properly mounted)", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div>Some text</div>`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          logStep("boom");
          throw new Error("NOOOOO");
        });
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`<div>
       <t t-if="this.state.error">Error handled</t>
       <t t-else=""><t t-call-slot="default" /></t>
      </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        useLogLifecycle(this);
        onError(() => (this.state.error = true));
      }
    }
    class OK extends Component {
      static template = xml`OK`;
      setup() {
        useLogLifecycle(this);
      }
    }

    class Root extends Component {
      static template = xml`<div>
        <OK/>
        <ErrorBoundary><ErrorComponent /></ErrorBoundary>
      </div>`;
      static components = { ErrorBoundary, ErrorComponent, OK };
      setup() {
        useLogLifecycle(this);
      }
    }
    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("<div>OK<div>Error handled</div></div>");
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Root:setup",
        "Root:willStart",
        "OK:setup",
        "OK:willStart",
        "ErrorBoundary:setup",
        "ErrorBoundary:willStart",
        "ErrorComponent:setup",
        "ErrorComponent:willStart",
        "ErrorComponent:mounted",
        "boom",
        "OK:mounted",
        "ErrorComponent:willUnmount",
        "ErrorComponent:willDestroy",
        "ErrorBoundary:mounted",
        "Root:mounted",
      ]
    `);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("can catch an error in the willPatch call", async () => {
    class ErrorComponent extends Component {
      static template = xml`<div><t t-out="this.props.message"/></div>`;
      props = props();
      setup() {
        onWillPatch(() => {
          throw new Error("NOOOOO");
        });
      }
    }
    class ErrorBoundary extends Component {
      static template = xml`
          <div>
            <t t-if="this.state.error">Error handled</t>
            <t t-else=""><t t-call-slot="default" /></t>
          </div>`;
      props = props();
      state = proxy({ error: false });

      setup() {
        onError(() => (this.state.error = true));
      }
    }
    class App extends Component {
      static template = xml`
          <div>
              <span><t t-out="this.state.message"/></span>
            <ErrorBoundary><ErrorComponent message="this.state.message" /></ErrorBoundary>
          </div>`;
      state = proxy({ message: "abc" });
      static components = { ErrorBoundary, ErrorComponent };
    }
    const app = await mount(App, fixture);
    expect(fixture.innerHTML).toBe("<div><span>abc</span><div><div>abc</div></div></div>");
    app.state.message = "def";
    await nextTick();
    await nextTick();
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><span>def</span><div>Error handled</div></div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("catchError in catchError", async () => {
    class Boom extends Component {
      static template = xml`<div t-out="a.b.c"/>`;
    }

    class Child extends Component {
      static template = xml`
        <div>
          <Boom />
        </div>`;
      static components = { Boom };

      setup() {
        onError((error) => {
          throw error;
        });
      }
    }

    class Parent extends Component {
      static template = xml`
        <div>
          <t t-if="this.error">Error</t>
          <t t-else="">
            <Child />
          </t>
        </div>`;
      static components = { Child };

      error: any = false;

      setup() {
        onError((error) => {
          this.error = error;
          render(this);
        });
      }
    }

    await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("<div>Error</div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("onError in class inheritance is not called if no rethrown", async () => {
    const steps: string[] = [];

    class Abstract extends Component {
      static template = xml`<div>
          <t t-if="!this.state.error">
            <t t-out="this.will.crash" />
          </t>
          <t t-else="">
            <t t-out="this.state.error"/>
          </t>
        </div>`;
      state: any;
      setup() {
        this.state = proxy({});
        onError(() => {
          steps.push("Abstract onError");
          this.state.error = "Abstract";
        });
      }
    }

    class Concrete extends Abstract {
      setup() {
        super.setup();
        onError(() => {
          steps.push("Concrete onError");
          this.state.error = "Concrete";
        });
      }
    }

    class Parent extends Component {
      static components = { Concrete };
      static template = xml`<Concrete />`;
    }

    await mount(Parent, fixture);

    expect(steps).toStrictEqual(["Concrete onError"]);
    expect(fixture.innerHTML).toBe("<div>Concrete</div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("onError in class inheritance is called if rethrown", async () => {
    const steps: string[] = [];

    class Abstract extends Component {
      static template = xml`<div>
          <t t-if="!this.state.error">
            <t t-out="this.will.crash" />
          </t>
          <t t-else="">
            <t t-out="this.state.error"/>
          </t>
        </div>`;
      state: any;
      setup() {
        this.state = proxy({});
        onError(() => {
          steps.push("Abstract onError");
          this.state.error = "Abstract";
        });
      }
    }

    class Concrete extends Abstract {
      setup() {
        super.setup();
        onError((error) => {
          steps.push("Concrete onError");
          this.state.error = "Concrete";
          throw error;
        });
      }
    }

    class Parent extends Component {
      static components = { Concrete };
      static template = xml`<Concrete />`;
    }

    await mount(Parent, fixture);

    expect(steps).toStrictEqual(["Concrete onError", "Abstract onError"]);
    expect(fixture.innerHTML).toBe("<div>Abstract</div>");
    expect(getConsoleOutput()).toEqual([]);
  });

  test("catching error, rethrow, render parent  -- a main component loop implementation", async () => {
    let parentState: any;

    class ErrorComponent extends Component {
      static template = xml`<div />`;
      setup() {
        throw new Error("My Error");
      }
    }

    class Child extends Component {
      static template = xml`<ErrorComponent />`;
      static components = { ErrorComponent };
      setup() {
        onError((error) => {
          throw error;
        });
      }
    }

    class Sibling extends Component {
      static template = xml`<div>Sibling</div>`;
    }

    class ErrorHandler extends Component {
      static template = xml`<t t-call-slot="default" />`;
      props = props();
      setup() {
        onError(() => {
          this.props.onError();
          Promise.resolve().then(() => {
            parentState.cps[2] = {
              id: 2,
              Comp: Sibling,
            };
          });
        });
      }
    }

    class Parent extends Component {
      static template = xml`
        <t t-foreach="Object.values(this.state.cps)" t-as="cp" t-key="cp.id">
          <ErrorHandler onError="() => this.cleanUp(cp.id)">
              <t t-component="cp.Comp" />
            </ErrorHandler>
        </t>`;

      static components = { ErrorHandler };
      state: any = proxy({
        cps: {},
      });

      setup() {
        parentState = this.state;
      }

      cleanUp(id: number) {
        delete this.state.cps[id];
      }
    }

    await mount(Parent, fixture);
    parentState.cps[1] = { id: 1, Comp: Child };
    await nextMicroTick();
    expect(fixture.innerHTML).toBe("");
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>Sibling</div>");
  });

  test("catching in child makes parent render", async () => {
    class Child extends Component {
      static template = xml`<div t-out="'Child ' + this.props.id" />`;
      props = props();
    }

    class ErrorComp extends Component {
      static template = xml`<div />`;
      setup() {
        throw new Error("Error Component");
      }
    }

    class Catch extends Component {
      static template = xml`<t t-call-slot="default" />`;
      props = props();
      setup() {
        onError((e) => {
          this.props.onError(e);
        });
      }
    }

    const steps: any[] = [];
    class Parent extends Component {
      static components = { Catch };
      static template = xml`
        <t t-foreach="Object.entries(this.elements)" t-as="elem" t-key="elem[0]">
          <Catch onError="(error) => this.onError(elem[0], error)">
            <t t-component="elem[1]" id="elem[0]" />
          </Catch>
        </t>
      `;

      elements: any = {};

      onError(id: any, error: Error) {
        steps.push(error.message);
        delete this.elements[id];
        this.elements[2] = Child;
        render(this);
      }
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("");

    parent.elements[1] = ErrorComp;
    render(parent);
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>Child 2</div>");
    expect(steps).toEqual(["Error Component"]);
  });

  test("an error in onWillUnmount still destroys the component", async () => {
    const s = signal(0);
    const log: string[] = [];
    class Child extends Component {
      static template = xml`<div t-out="this.s()"/>`;
      s = s;
      setup() {
        useEffect(() => {
          log.push(`effect ${s()}`);
          return () => log.push("effect cleanup");
        });
        onWillUnmount(() => {
          throw new Error("boom");
        });
      }
    }

    class Parent extends Component {
      static template = xml`
        <t t-out="this.state.value"/>
        <t t-if="this.state.hasChild"><Child/></t>`;
      static components = { Child };

      state = proxy({ value: 1, hasChild: true });
      setup() {
        onError((e) => {
          log.push(`caught ${e.message}`);
          this.state.value++;
        });
      }
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("1<div>0</div>");
    parent.state.hasChild = false;
    await nextTick();
    await nextTick();
    expect(fixture.innerHTML).toBe("2");
    s.set(1);
    await nextTick();
    expect(log).toEqual(["effect 0", "effect cleanup", "caught boom"]);
  });

  test("an error in onWillDestroy", async () => {
    class Child extends Component {
      static template = xml`<div>abc</div>`;
      setup() {
        onWillDestroy(() => {
          throw new Error("boom");
        });
        useLogLifecycle(this);
      }
    }

    class Parent extends Component {
      static template = xml`
        <t t-out="this.state.value"/>
        <t t-if="this.state.hasChild"><Child/></t>`;
      static components = { Child };

      state = proxy({ value: 1, hasChild: true });
      setup() {
        useLogLifecycle(this);
        onError(() => {
          this.state.value++;
        });
      }
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("1<div>abc</div>");
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Parent:setup",
        "Parent:willStart",
        "Child:setup",
        "Child:willStart",
        "Child:mounted",
        "Parent:mounted",
      ]
    `);
    parent.state.hasChild = false;
    await nextTick();
    await nextTick();
    await nextTick();
    await nextTick();
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Parent:willPatch",
        "Child:willUnmount",
        "Child:willDestroy",
        "Parent:patched",
        "Parent:willPatch",
        "Parent:patched",
      ]
    `);
    expect(fixture.innerHTML).toBe("2");
  });

  test("an error in onWillDestroy, variation", async () => {
    class Child extends Component {
      static template = xml`<div>abc</div>`;
      setup() {
        onWillDestroy(() => {
          throw new Error("boom");
        });
        useLogLifecycle(this);
      }
    }

    class Parent extends Component {
      static template = xml`
        <t t-out="this.state.value"/>
        <t t-if="this.state.hasChild"><Child/></t>`;
      static components = { Child };

      state = proxy({ value: 1, hasChild: false });
      setup() {
        useLogLifecycle(this);
        onError(() => {
          this.state.value++;
        });
      }
    }

    const parent = await mount(Parent, fixture);
    expect(fixture.innerHTML).toBe("1");

    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Parent:setup",
        "Parent:willStart",
        "Parent:mounted",
      ]
    `);

    parent.state.hasChild = true;
    await nextMicroTick();
    await nextMicroTick();
    await nextMicroTick();
    await nextMicroTick();
    await nextMicroTick();
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Child:setup",
        "Child:willStart",
      ]
    `);
    parent.state.hasChild = false;
    await nextTick();
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Child:willDestroy",
        "Parent:willPatch",
        "Parent:patched",
      ]
    `);
    expect(fixture.innerHTML).toBe("2");
  });

  test("error in onMounted, graceful recovery", async () => {
    class Child extends Component {
      static template = xml`abc`;
      setup() {
        useLogLifecycle(this);
      }
    }

    class OtherChild extends Component {
      static template = xml`def`;
      setup() {
        useLogLifecycle(this);
      }
    }

    class Boom extends Component {
      static template = xml`boom`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          throw new Error("boom");
        });
      }
    }

    class Parent extends Component {
      static template = xml`parent<Child/><Boom/>`;
      static components = { Child, Boom };
      setup() {
        useLogLifecycle(this);
      }
    }

    class Root extends Component {
      static template = xml`<t t-component="this.component"/>`;

      component: any = Parent;
      setup() {
        useLogLifecycle(this);
        onError(() => {
          logStep("error");
          this.component = OtherChild;
          render(this);
        });
      }
    }

    await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("def");

    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Root:setup",
        "Root:willStart",
        "Parent:setup",
        "Parent:willStart",
        "Child:setup",
        "Child:willStart",
        "Boom:setup",
        "Boom:willStart",
        "Boom:mounted",
        "error",
        "Child:mounted",
        "OtherChild:setup",
        "OtherChild:willStart",
        "Child:willUnmount",
        "Child:willDestroy",
        "Boom:willUnmount",
        "Boom:willDestroy",
        "Parent:willDestroy",
        "OtherChild:mounted",
        "Root:mounted",
      ]
    `);
  });

  test("error in onMounted, graceful recovery, variation", async () => {
    class Child extends Component {
      static template = xml`abc`;
      setup() {
        useLogLifecycle(this);
      }
    }

    class OtherChild extends Component {
      static template = xml`def`;
      setup() {
        useLogLifecycle(this);
      }
    }

    class Boom extends Component {
      static template = xml`boom`;
      setup() {
        useLogLifecycle(this);
        onMounted(() => {
          throw new Error("boom");
        });
      }
    }

    class Parent extends Component {
      static template = xml`parent<Child/><Boom/>`;
      static components = { Child, Boom };
      setup() {
        useLogLifecycle(this);
      }
    }

    class Root extends Component {
      static template = xml`R<t t-if="this.state.gogogo" t-component="this.component"/>`;

      component: any = Parent;
      state = proxy({ gogogo: false });

      setup() {
        useLogLifecycle(this);
        onError(() => {
          logStep("error");
          this.component = OtherChild;
          render(this);
        });
      }
    }

    const root = await mount(Root, fixture);
    expect(fixture.innerHTML).toBe("R");

    // standard mounting process
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Root:setup",
        "Root:willStart",
        "Root:mounted",
      ]
    `);

    root.state.gogogo = true;
    await nextTick();

    expect(fixture.innerHTML).toBe("Rparentabcboom");
    // rerender, root creates sub components, it crashes, tries to recover
    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Parent:setup",
        "Parent:willStart",
        "Child:setup",
        "Child:willStart",
        "Boom:setup",
        "Boom:willStart",
        "Root:willPatch",
        "Boom:mounted",
        "error",
        "Child:mounted",
        "OtherChild:setup",
        "OtherChild:willStart",
      ]
    `);

    await nextTick();
    expect(fixture.innerHTML).toBe("Rdef");

    expect(steps.splice(0)).toMatchInlineSnapshot(`
      [
        "Root:willPatch",
        "Child:willUnmount",
        "Child:willDestroy",
        "Boom:willUnmount",
        "Boom:willDestroy",
        "Parent:willDestroy",
        "OtherChild:mounted",
        "Root:patched",
      ]
    `);
  });
});

describe("errors in onWillUpdateProps", () => {
  test("sync error in onWillUpdateProps is caught by parent onError", async () => {
    let error: any;
    class Child extends Component {
      static template = xml`<div/>`;
      props = props();
      setup() {
        onWillUpdateProps(() => {
          throw new Error("sync boom");
        });
      }
    }
    class Parent extends Component {
      static template = xml`<Child val="this.state.val"/>`;
      static components = { Child };
      state = proxy({ val: 0 });
      setup() {
        onError((e) => (error = e));
      }
    }

    const parent = await mount(Parent, fixture, { test: true });
    parent.state.val = 1; // triggers child re-render → onWillUpdateProps throws
    render(parent);
    await nextTick();
    expect(error).toBeDefined();
    expect(error.message).toBe("sync boom");
  });

  test("async error in onWillUpdateProps is caught by parent onError", async () => {
    let error: any;
    class Child extends Component {
      static template = xml`<div/>`;
      props = props();
      setup() {
        onWillUpdateProps(async () => {
          await Promise.resolve();
          throw new Error("async boom");
        });
      }
    }
    class Parent extends Component {
      static template = xml`<Child val="this.state.val"/>`;
      static components = { Child };
      state = proxy({ val: 0 });
      setup() {
        onError((e) => (error = e));
      }
    }

    const parent = await mount(Parent, fixture, { test: true });
    parent.state.val = 1;
    render(parent);
    await nextTick();
    await nextTick();
    expect(error).toBeDefined();
    expect(error.message).toBe("async boom");
  });

  test("async error in onWillUpdateProps is caught by child's own onError", async () => {
    let error: any;
    class Child extends Component {
      static template = xml`<div/>`;
      props = props();
      setup() {
        onError((e) => (error = e));
        onWillUpdateProps(async () => {
          await Promise.resolve();
          throw new Error("async boom from child");
        });
      }
    }
    class Parent extends Component {
      static template = xml`<Child val="this.state.val"/>`;
      static components = { Child };
      state = proxy({ val: 0 });
    }

    const parent = await mount(Parent, fixture, { test: true });
    parent.state.val = 1;
    render(parent);
    await nextTick();
    await nextTick();
    expect(error).toBeDefined();
    expect(error.message).toBe("async boom from child");
  });
});

describe("errors in a pending render pass", () => {
  test("a component recovering from its own onWillUpdateProps rejection lets the pass commit", async () => {
    const load = makeDeferred();
    class Child extends Component {
      static template = xml`<span><t t-if="this.state.failed">failed</t><t t-else="" t-out="this.props.value"/></span>`;
      props = props();
      state = proxy({ failed: false });
      setup() {
        onWillUpdateProps(() => load);
        onError(() => {
          this.state.failed = true;
        });
      }
    }
    class Parent extends Component {
      static template = xml`<div><t t-out="this.state.value"/><Child value="this.state.value"/></div>`;
      static components = { Child };
      state = proxy({ value: 1 });
    }
    const parent = await mount(Parent, fixture);
    parent.state.value = 2;
    await nextTick();
    load.reject(new Error("load failed"));
    await nextTick();
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>2<span>failed</span></div>");
    expect(parent.__owl__.app.scheduler.tasks.size).toBe(0);
  });

  test("a pass with a failed render stays uncommitted when another of its components recovers", async () => {
    const errors: string[] = [];
    class A extends Component {
      static template = xml`<a><t t-if="this.state.failed">failed</t><t t-else="" t-out="this.props.value.toFixed()"/></a>`;
      props = props();
      state = proxy({ failed: false });
      setup() {
        onError(() => {
          this.state.failed = true;
        });
      }
    }
    class B extends Component {
      static template = xml`<b><t t-out="this.props.value.toFixed()"/></b>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<div><t t-out="this.state.count"/><A value="this.state.value"/><B value="this.state.value"/></div>`;
      static components = { A, B };
      state = proxy({ value: 1 as number | null, count: 1 });
      setup() {
        onError((e) => errors.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    parent.state.value = null;
    parent.state.count = 2;
    await nextTick();
    await nextTick();
    expect(errors).toEqual(["Cannot read properties of null (reading 'toFixed')"]);
    expect(fixture.innerHTML).toBe("<div>1<a>1</a><b>1</b></div>");

    parent.state.value = 3;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>2<a>failed</a><b>3</b></div>");
  });

  test("an error in a child's own pass leaves the parent's pending pass alone", async () => {
    const load = makeDeferred();
    const errors: string[] = [];
    class C extends Component {
      static template = xml`<c><t t-out="this.state.value"/></c>`;
      state = proxy({ value: 1 });
      setup() {
        onPatched(() => {
          throw new Error("patched");
        });
      }
    }
    class D extends Component {
      static template = xml`<d><t t-out="this.props.value"/></d>`;
      props = props();
      setup() {
        onWillUpdateProps(() => load);
      }
    }
    class Parent extends Component {
      static template = xml`<div><t t-out="this.state.value"/><C/><D value="this.state.value"/></div>`;
      static components = { C, D };
      state = proxy({ value: 1 });
      setup() {
        onError((e) => errors.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    const c = Object.values(parent.__owl__.children).find((n) => n.component instanceof C)!;
    (c.component as C).state.value = 2;
    await nextMicroTick();
    await nextMicroTick();
    await nextMicroTick();
    parent.state.value = 2;
    await nextTick();
    expect(errors).toEqual(["patched"]);
    expect(fixture.innerHTML).toBe("<div>1<c>2</c><d>1</d></div>");

    load.resolve();
    await nextTick();
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>2<c>2</c><d>2</d></div>");
  });

  test("a failed pass its handler does not re-render leaves the scheduler", async () => {
    const errors: string[] = [];
    class Child extends Component {
      static template = xml`<span><t t-out="this.props.value.toFixed()"/></span>`;
      props = props();
    }
    class Parent extends Component {
      static template = xml`<div><Child value="this.state.value"/></div>`;
      static components = { Child };
      state = proxy({ value: 1 as number | null });
      setup() {
        onError((e) => errors.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    parent.state.value = null;
    await nextTick();
    await nextTick();
    expect(errors).toEqual(["Cannot read properties of null (reading 'toFixed')"]);
    expect(parent.__owl__.app.scheduler.tasks.size).toBe(0);

    parent.state.value = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><span>2</span></div>");
    expect(parent.__owl__.app.scheduler.tasks.size).toBe(0);
  });

  test("a sibling's own render waiting on a pass that failed in onWillUpdateProps resumes", async () => {
    const load = makeDeferred();
    const errors: string[] = [];
    class A extends Component {
      static template = xml`<a><t t-out="this.props.value"/></a>`;
      props = props();
      setup() {
        onWillUpdateProps(() => load);
      }
    }
    class B extends Component {
      static template = xml`<b><t t-out="this.state.value"/></b>`;
      state = proxy({ value: 1 });
    }
    class Parent extends Component {
      static template = xml`<div><A value="this.state.value"/><B/></div>`;
      static components = { A, B };
      state = proxy({ value: 1 });
      setup() {
        onError((e) => errors.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    const b = Object.values(parent.__owl__.children).find((n) => n.component instanceof B)!;
    parent.state.value = 2;
    await nextTick();
    (b.component as B).state.value = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>1</a><b>1</b></div>");

    load.reject(new Error("load failed"));
    await nextTick();
    await nextTick();
    expect(errors).toEqual(["load failed"]);
    expect(fixture.innerHTML).toBe("<div><a>1</a><b>2</b></div>");

    (b.component as B).state.value = 3;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>1</a><b>3</b></div>");
    expect(parent.__owl__.app.scheduler.tasks.size).toBe(0);
  });

  test("a pass failing in onWillUpdateProps of a node of another app resumes the renders it delayed", async () => {
    const load = makeDeferred();
    const errors: string[] = [];
    class A extends Component {
      static template = xml`<a><t t-out="this.props.value"/></a>`;
      props = props();
      setup() {
        onWillUpdateProps(() => load);
      }
    }
    class B extends Component {
      static template = xml`<b><t t-out="this.state.value"/></b>`;
      state = proxy({ value: 1 });
    }
    class Parent extends Component {
      static template = xml`<div><A value="this.state.value"/><B/></div>`;
      static components = { A, B };
      state = proxy({ value: 1 });
      setup() {
        onError((e) => errors.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    const children = Object.values(parent.__owl__.children);
    const a = children.find((n) => n.component instanceof A)!;
    const b = children.find((n) => n.component instanceof B)!;
    // a component a slot of another app renders here
    a.app = new App();
    parent.state.value = 2;
    await nextTick();
    (b.component as B).state.value = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>1</a><b>1</b></div>");

    load.reject(new Error("load failed"));
    await nextTick();
    await nextTick();
    expect(errors).toEqual(["load failed"]);
    expect(fixture.innerHTML).toBe("<div><a>1</a><b>2</b></div>");

    (b.component as B).state.value = 3;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>1</a><b>3</b></div>");
  });

  test("a render the handler of a failed render re-renders around is not rendered before", async () => {
    const slow = makeDeferred();
    const late = makeDeferred();
    let bRenders = 0;
    class S extends Component {
      static template = xml`<s><t t-out="this.props.value"/></s>`;
      props = props();
      setup() {
        onWillUpdateProps(() => slow);
      }
    }
    class C extends Component {
      static template = xml`<c><t t-out="this.check()"/></c>`;
      props = props();
      setup() {
        onWillUpdateProps(() => late);
      }
      check() {
        if (this.props.value === 2) {
          throw new Error("C fails");
        }
        return this.props.value;
      }
    }
    class B extends Component {
      static template = xml`<b><t t-out="this.read()"/></b>`;
      props = props();
      state = proxy({ value: 1 });
      read() {
        bRenders++;
        return this.state.value;
      }
    }
    class Parent extends Component {
      static template = xml`
        <div>
          <S value="this.state.value"/>
          <C t-if="!this.state.failed" value="this.state.value"/>
          <B failed="this.state.failed"/>
        </div>`;
      static components = { S, C, B };
      state = proxy({ value: 1, failed: false });
      setup() {
        onError(() => (this.state.failed = true));
      }
    }
    const parent = await mount(Parent, fixture);
    const b = Object.values(parent.__owl__.children).find((n) => n.component instanceof B)!;
    bRenders = 0;
    parent.state.value = 2;
    await nextMicroTick();
    (b.component as B).state.value = 2;
    await nextMicroTick();
    late.resolve();
    await nextTick();
    slow.resolve();
    await nextTick();
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><s>2</s><b>2</b></div>");
    expect(bRenders).toBe(1);
  });
});

describe("errors of a destroyed component", () => {
  async function collectUnhandled(run: () => Promise<void>): Promise<string[]> {
    const errors: string[] = [];
    const onRejection = (e: unknown) => errors.push(String(e));
    process.on("unhandledRejection", onRejection);
    try {
      await run();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    return errors;
  }

  test("an onWillStart rejecting after its component was removed leaves the app and the ancestors alone", async () => {
    const load = makeDeferred();
    const caught: string[] = [];
    class Child extends Component {
      static template = xml`<span>child</span>`;
      setup() {
        onWillStart(() => load);
      }
    }
    class Parent extends Component {
      static template = xml`<div><t t-out="this.state.count"/><Child t-if="this.state.show"/></div>`;
      static components = { Child };
      state = proxy({ show: false, count: 1 });
      setup() {
        onError((e) => caught.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    parent.state.show = true;
    await nextTick();
    parent.state.show = false;
    await nextTick();
    const unhandled = await collectUnhandled(async () => {
      load.reject(new Error("load failed"));
      await nextTick();
    });
    expect(unhandled).toEqual(["Error: load failed"]);
    expect(caught).toEqual([]);
    expect(parent.__owl__.app.destroyed).toBe(false);

    parent.state.count = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>2</div>");
  });

  test("an onWillUpdateProps rejecting after its component was removed leaves the app and the ancestors alone", async () => {
    const load = makeDeferred();
    const caught: string[] = [];
    class Child extends Component {
      static template = xml`<span><t t-out="this.props.value"/></span>`;
      props = props();
      setup() {
        onWillUpdateProps(() => load);
      }
    }
    class Parent extends Component {
      static template = xml`<div><t t-out="this.state.value"/><Child t-if="this.state.show" value="this.state.value"/></div>`;
      static components = { Child };
      state = proxy({ show: true, value: 1 });
      setup() {
        onError((e) => caught.push(e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    parent.state.value = 2;
    await nextTick();
    parent.state.show = false;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div>2</div>");
    const unhandled = await collectUnhandled(async () => {
      load.reject(new Error("load failed"));
      await nextTick();
    });
    expect(unhandled).toEqual(["Error: load failed"]);
    expect(caught).toEqual([]);
    expect(parent.__owl__.app.destroyed).toBe(false);
  });
});

test("a component whose setup throws releases what the setup acquired", async () => {
  const value = signal(0);
  const steps: string[] = [];
  class Broken extends Component {
    static template = xml`<b/>`;
    setup() {
      useEffect(() => {
        steps.push(`effect ${value()}`);
      });
      onWillDestroy(() => steps.push("willDestroy"));
      throw new Error("setup failed");
    }
  }
  class Parent extends Component {
    static template = xml`<div><t t-if="this.state.error">error</t><Broken t-else=""/></div>`;
    static components = { Broken };
    state = proxy({ error: false });
    setup() {
      onError(() => {
        this.state.error = true;
      });
    }
  }
  await mount(Parent, fixture);
  expect(fixture.innerHTML).toBe("<div>error</div>");
  expect(steps).toEqual(["effect 0", "willDestroy"]);

  value.set(1);
  await nextTick();
  expect(steps).toEqual(["effect 0", "willDestroy"]);
});

describe("a handled lifecycle error does not starve the other components", () => {
  test("the onMounted of the components committed with a failing one still run", async () => {
    class A extends Component {
      static template = xml`<a>a</a>`;
      setup() {
        onMounted(() => logStep("A:mounted"));
        onWillUnmount(() => logStep("A:willUnmount"));
      }
    }
    class B extends Component {
      static template = xml`<b>b</b>`;
      setup() {
        onMounted(() => {
          logStep("B:mounted");
          throw new Error("boom");
        });
      }
    }
    class Parent extends Component {
      static components = { A, B };
      static template = xml`<div><t t-if="this.state.show"><A/><B/></t></div>`;
      state = proxy({ show: false });
      setup() {
        onMounted(() => logStep("Parent:mounted"));
        onError((e) => logStep("error:" + e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    steps.splice(0);
    parent.state.show = true;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>a</a><b>b</b></div>");
    expect(steps.splice(0)).toEqual(["B:mounted", "error:boom", "A:mounted"]);

    parent.state.show = false;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div></div>");
    expect(steps.splice(0)).toEqual(["A:willUnmount"]);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("the onPatched of the components patched with a failing one still run", async () => {
    class A extends Component {
      static template = xml`<a t-out="this.props.v"/>`;
      props = props();
      setup() {
        onPatched(() => logStep("A:patched"));
      }
    }
    class B extends Component {
      static template = xml`<b t-out="this.props.v"/>`;
      props = props();
      setup() {
        onPatched(() => {
          logStep("B:patched");
          throw new Error("boom");
        });
      }
    }
    class Parent extends Component {
      static components = { A, B };
      static template = xml`<div><A v="this.state.v"/><B v="this.state.v"/></div>`;
      state = proxy({ v: 1 });
      setup() {
        onError((e) => logStep("error:" + e.message));
      }
    }
    const parent = await mount(Parent, fixture);
    steps.splice(0);
    parent.state.v = 2;
    await nextTick();
    expect(fixture.innerHTML).toBe("<div><a>2</a><b>2</b></div>");
    expect(steps.splice(0)).toEqual(["B:patched", "error:boom", "A:patched"]);
    expect(getConsoleOutput()).toEqual([]);
  });

  test("an onMounted error nobody handles still destroys the app before the next hook", async () => {
    class A extends Component {
      static template = xml`<a>a</a>`;
      setup() {
        onMounted(() => logStep("A:mounted"));
        onWillUnmount(() => logStep("A:willUnmount"));
      }
    }
    class B extends Component {
      static template = xml`<b>b</b>`;
      setup() {
        onMounted(() => {
          throw new Error("boom");
        });
      }
    }
    class Parent extends Component {
      static components = { A, B };
      static template = xml`<div><t t-if="this.state.show"><A/><B/></t></div>`;
      state = proxy({ show: false });
    }
    const parent = await mount(Parent, fixture);
    const app = parent.__owl__.app;
    parent.state.show = true;
    const error = await nextAppError(app);
    expect(error.message).toBe("boom");
    expect(app.destroyed).toBe(true);
    expect(steps.splice(0)).toEqual([]);
    expect(getConsoleOutput()).toEqual([]);
  });
});
