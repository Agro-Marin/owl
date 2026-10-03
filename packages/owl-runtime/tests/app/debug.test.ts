import {
  Component,
  mount,
  onError,
  onMounted,
  props,
  setDebug,
  setDebugSink,
  signal,
  xml,
  type DebugChannel,
} from "../../src";
import { makeTestFixture, nextTick } from "../helpers";

let fixture: HTMLElement;
let lines: string[] = [];

beforeEach(() => {
  fixture = makeTestFixture();
  lines = [];
  setDebugSink((channel: DebugChannel, message: string) =>
    lines.push(`${channel}: ${message.replace(/[\d.]+ ms/, "_ ms")}`)
  );
});

afterEach(() => {
  setDebug(false);
  setDebugSink(null);
});

test("lifecycle, fiber and scheduler channels trace a mount and an update", async () => {
  const value = signal(1);
  class Child extends Component {
    static template = xml`<b t-out="this.props.v"/>`;
    props = props();
  }
  class Parent extends Component {
    static template = xml`<div><Child v="this.value()"/><i t-out="1"/></div>`;
    static components = { Child };
    value = value;
    setup() {
      onMounted(() => {});
    }
  }
  setDebug(["lifecycle", "fiber", "scheduler"]);
  await mount(Parent, fixture);
  expect(lines).toEqual([
    "lifecycle: create root Parent",
    "lifecycle: setup Parent (root)",
    "scheduler: schedule Parent, 1 task(s)",
    "lifecycle: setup Child (child of Parent)",
    "fiber: render Child in _ ms, 1 left in Parent's pass",
    "fiber: render Parent in _ ms, 0 left in Parent's pass",
    "scheduler: frame, 1 task(s)",
    "fiber: mount Parent",
    // the root's own onMounted, and the one resolving mount()'s promise
    "lifecycle: mounted Parent: 2 hook(s)",
  ]);
  lines.length = 0;
  value.set(2);
  await nextTick();
  expect(lines).toEqual([
    "scheduler: schedule Parent, 1 task(s)",
    "fiber: update Child: props changed",
    "fiber: render Child in _ ms, 1 left in Parent's pass",
    "fiber: render Parent in _ ms, 0 left in Parent's pass",
    "scheduler: frame, 1 task(s)",
    "fiber: commit Parent: 0 willPatch, 0 mounted, 0 patched",
  ]);
  expect(fixture.innerHTML).toBe("<div><b>2</b><i>1</i></div>");
});

test("the error channel says who handled an error", async () => {
  class Boom extends Component {
    static template = xml`<b t-out="this.fail()"/>`;
    fail() {
      throw new Error("boom");
    }
  }
  class Parent extends Component {
    static template = xml`<div><Boom t-if="!this.failed()"/></div>`;
    static components = { Boom };
    failed = signal(false);
    setup() {
      onError(() => this.failed.set(true));
    }
  }
  setDebug("error");
  await mount(Parent, fixture);
  expect(lines).toEqual(["error: Boom: error handled by an ancestor's onError"]);
});

test("the event channel traces a handled event", async () => {
  class Clicker extends Component {
    static template = xml`<button t-on-click="this.click">x</button>`;
    click() {}
  }
  await mount(Clicker, fixture);
  setDebug("event");
  fixture.querySelector("button")!.click();
  expect(lines).toEqual(["event: click on BUTTON: handled by Clicker"]);
});

test("the template channel traces a compilation", async () => {
  class Tpl extends Component {
    static template = xml`<p>compiled</p>`;
  }
  setDebug("template");
  await mount(Tpl, fixture);
  expect(lines.length).toBe(1);
  expect(lines[0]).toMatch(/^template: __template__\d+: compiled in _ ms, \d+ chars$/);
});
